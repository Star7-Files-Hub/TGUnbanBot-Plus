#!/usr/bin/env python3
"""Read-only Telegram sample transport. Never decides whether a message is an ad."""
from __future__ import annotations

import argparse
import asyncio
import fcntl
import getpass
import json
import logging
import math
import os
from pathlib import Path
import signal
import sqlite3
import stat
import sys
import time
from typing import Any
from urllib import error, parse, request

TARGET_CHAT_ID = -1001971423490
MAX_SPOOL = 1000
MAX_HISTORY = 100
MAX_TEXT = 4000
LOG = logging.getLogger("tg_sample_collector")


class ConfigError(ValueError):
    pass


class UnauthorizedError(RuntimeError):
    pass


class TargetUnavailableError(RuntimeError):
    pass


class SpoolFull(RuntimeError):
    pass


def number(value: str, default: int, minimum: int, maximum: int, label: str) -> int:
    try:
        result = int(value or default)
    except (TypeError, ValueError):
        raise ConfigError(label + " must be an integer") from None
    if not minimum <= result <= maximum:
        raise ConfigError(label + " is outside the allowed range")
    return result


class Config:
    def __init__(self, env: dict[str, str], *, require_ingest: bool = True):
        self.api_id = number(env.get("TG_API_ID", ""), 0, 1, 2**31 - 1, "TG_API_ID")
        self.api_hash = env.get("TG_API_HASH", "").strip()
        if len(self.api_hash) != 32 or any(c not in "0123456789abcdefABCDEF" for c in self.api_hash):
            raise ConfigError("TG_API_HASH must be a 32-character hexadecimal application hash")
        self.data_dir = Path(env.get("COLLECTOR_DATA_DIR", "/var/lib/tg-sample-collector"))
        if not self.data_dir.is_absolute():
            raise ConfigError("COLLECTOR_DATA_DIR must be absolute")
        self.url = env.get("OBSERVE_INGEST_URL", "").strip()
        self.token = env.get("OBSERVE_INGEST_TOKEN", "").strip()
        if require_ingest:
            u = parse.urlsplit(self.url)
            if (u.scheme != "https" or not u.hostname or u.username or u.password
                    or u.query or u.fragment or u.path != "/api/observe/ingest"):
                raise ConfigError("OBSERVE_INGEST_URL must be an HTTPS /api/observe/ingest endpoint")
            if not self.token or any(c.isspace() for c in self.token):
                raise ConfigError("OBSERVE_INGEST_TOKEN is missing or invalid")
        self.rate = number(env.get("COLLECTOR_PER_MINUTE", ""), 20, 1, 20, "COLLECTOR_PER_MINUTE")
        self.history = number(env.get("COLLECTOR_HISTORY_LIMIT", ""), 100, 0, MAX_HISTORY, "COLLECTOR_HISTORY_LIMIT")
        self.max_spool = number(env.get("COLLECTOR_MAX_SPOOL", ""), MAX_SPOOL, 1, MAX_SPOOL, "COLLECTOR_MAX_SPOOL")
        self.poll_seconds = number(env.get("COLLECTOR_POLL_SECONDS", ""), 30, 10, 300, "COLLECTOR_POLL_SECONDS")
        self.session_path = self.data_dir / "telegram.session"


def private_dir(path: Path) -> None:
    if path.is_symlink():
        raise ConfigError("private data directory cannot be a symlink")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not path.is_dir():
        raise ConfigError("private data directory is not a directory")
    os.chmod(path, 0o700)


def private_file(path: Path) -> None:
    if path.is_symlink() or (path.exists() and not stat.S_ISREG(path.stat().st_mode)):
        raise ConfigError("private data file must be a regular non-symlink file")
    if path.exists():
        os.chmod(path, 0o600)


def bounded(value: Any, limit: int) -> str:
    return str(value or "")[:limit]


def peer_id(entity: Any) -> int:
    """Entity ID conversion, without requiring Telethon in pure-unit tests."""
    from telethon import utils
    return int(utils.get_peer_id(entity))


def message_payload(message: Any, sender: Any, chat_title: str, actual_chat_id: int) -> dict[str, Any] | None:
    if actual_chat_id != TARGET_CHAT_ID or getattr(message, "out", False):
        return None
    mid = getattr(message, "id", None)
    uid = getattr(sender, "id", None)
    if not isinstance(mid, int) or isinstance(mid, bool) or mid <= 0:
        return None
    # Receiver accepts real Telegram users only; never invent a User ID for a
    # group/channel/anonymous sender. Future sender_chat needs a separate protocol.
    if (not isinstance(uid, int) or isinstance(uid, bool) or uid <= 0
            or len(str(uid)) > 16 or not hasattr(sender, "first_name")):
        return None
    user_id = str(uid)
    text = bounded(getattr(message, "message", ""), MAX_TEXT)
    reply = getattr(message, "reply_to", None)
    quote = bounded(getattr(reply, "quote_text", ""), MAX_TEXT)
    media = getattr(message, "media", None)
    # MessageMediaContact has first_name/last_name; do not infer OCR or a biography.
    contact = ""
    if media is not None and hasattr(media, "phone_number") and hasattr(media, "first_name"):
        contact = bounded(" ".join(str(v) for v in (
            getattr(media, "first_name", ""), getattr(media, "last_name", "")) if v), 256)
    if not text.strip() and not quote.strip() and not contact.strip():
        return None
    payload = {
        "chat_id": str(TARGET_CHAT_ID), "chat_title": bounded(chat_title, 256),
        "message_id": mid, "user_id": user_id,
        "first_name": bounded(getattr(sender, "first_name", None) or getattr(sender, "title", ""), 256),
        "last_name": bounded(getattr(sender, "last_name", ""), 256),
        "username": bounded(getattr(sender, "username", ""), 64),
        "is_bot": bool(getattr(sender, "bot", False)), "text": text,
    }
    if quote:
        payload["quote"] = quote
    if contact:
        payload["contact_name"] = contact
    return payload


class Spool:
    """Bounded, durable outbox. History cursor and queue insertion commit together."""
    def __init__(self, path: Path, maximum: int = MAX_SPOOL):
        if not 1 <= maximum <= MAX_SPOOL:
            raise ConfigError("spool maximum is outside the allowed range")
        private_dir(path.parent)
        private_file(path)
        self.maximum = maximum
        self.db = sqlite3.connect(path)
        os.chmod(path, 0o600)
        self.db.execute("PRAGMA journal_mode=DELETE")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS spool (
                chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, payload TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
                PRIMARY KEY(chat_id,message_id));
            CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        """)
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    def cursor(self) -> int | None:
        row = self.db.execute("SELECT value FROM state WHERE key='history_cursor'").fetchone()
        return int(row[0]) if row else None

    def count(self) -> int:
        return int(self.db.execute("SELECT count(*) FROM spool").fetchone()[0])

    def record(self, payload: dict[str, Any] | None, message_id: int) -> bool:
        """Advance only for an item durably enqueued or intentionally non-collectable."""
        if message_id <= 0:
            raise ValueError("invalid message ID")
        if payload is not None and (payload.get("chat_id") != str(TARGET_CHAT_ID)
                                    or payload.get("message_id") != message_id):
            raise ValueError("payload target mismatch")
        inserted = False
        with self.db:
            cursor = self.cursor()
            if cursor is not None and message_id <= cursor:
                return False
            if payload is not None:
                duplicate = self.db.execute("SELECT 1 FROM spool WHERE chat_id=? AND message_id=?",
                                            (str(TARGET_CHAT_ID), message_id)).fetchone()
                if not duplicate:
                    if self.count() >= self.maximum:
                        raise SpoolFull("spool capacity reached")
                    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                    self.db.execute("INSERT INTO spool(chat_id,message_id,payload) VALUES(?,?,?)",
                                    (str(TARGET_CHAT_ID), message_id, encoded))
                    inserted = True
            self.db.execute("INSERT INTO state(key,value) VALUES('history_cursor',?) "
                            "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(message_id),))
        return inserted

    def bootstrap_empty(self, message_id: int = 0) -> None:
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO state(key,value) VALUES('history_cursor',?)", (str(message_id),))

    def next_item(self) -> tuple | None:
        # Strict FIFO: a failed head blocks subsequent delivery rather than losing ordering.
        return self.db.execute("SELECT chat_id,message_id,payload,attempts,next_attempt "
                               "FROM spool ORDER BY message_id LIMIT 1").fetchone()

    def complete(self, chat_id: str, message_id: int) -> None:
        with self.db:
            self.db.execute("DELETE FROM spool WHERE chat_id=? AND message_id=?", (chat_id, message_id))

    def retry(self, chat_id: str, message_id: int, when: float) -> None:
        with self.db:
            self.db.execute("UPDATE spool SET attempts=attempts+1,next_attempt=? "
                            "WHERE chat_id=? AND message_id=?", (when, chat_id, message_id))


def retry_delay(attempts: int, retry_after: str | None = None) -> float:
    if retry_after:
        try:
            delay = float(retry_after)
            if not math.isfinite(delay):
                raise ValueError("invalid retry delay")
            return max(3.0, delay)
        except ValueError:
            from email.utils import parsedate_to_datetime
            try:
                date = parsedate_to_datetime(retry_after)
                return max(3.0, date.timestamp() - time.time())
            except (ValueError, TypeError, OverflowError):
                pass
    return float(min(900, 5 * 2 ** min(attempts, 8)))


def send_http(url: str, token: str, payload: str) -> tuple[bool, str, str | None]:
    """At-least-once transport: receiver must deduplicate (chat_id,message_id)."""
    class NoRedirect(request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = request.build_opener(NoRedirect())
    req = request.Request(url, data=payload.encode("utf-8"), method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + token,
    })
    try:
        with opener.open(req, timeout=20) as response:
            status = response.status
            # Response body is neither needed nor logged; close without parsing private text.
            if status == 200:
                return True, "accepted", None
            return False, "http_rejected", response.headers.get("Retry-After")
    except error.HTTPError as exc:
        retry_after = exc.headers.get("Retry-After") if exc.headers else None
        category = "http_rate_limited" if exc.code == 429 else "http_rejected"
        exc.close()
        return False, category, retry_after
    except (error.URLError, TimeoutError, OSError, ValueError):
        return False, "transport_error", None


class Dispatcher:
    def __init__(self, config: Config, spool: Spool, *, transport=send_http, clock=time.time):
        self.config = config
        self.spool = spool
        self.transport = transport
        self.clock = clock
        self.next_send = 0.0
        self.busy = False

    async def step(self) -> float:
        if self.busy:
            return 1.0
        row = self.spool.next_item()
        if row is None:
            return 1.0
        chat_id, mid, payload, attempts, next_attempt = row
        delay = max(self.next_send, next_attempt) - self.clock()
        if delay > 0:
            return min(delay, 30.0)
        self.busy = True
        self.next_send = self.clock() + 60 / self.config.rate
        try:
            ok, category, retry_after = await asyncio.to_thread(
                self.transport, self.config.url, self.config.token, payload)
            if ok:
                self.spool.complete(chat_id, mid)
                LOG.info("ingest_accepted queued=%d", self.spool.count())
            else:
                self.spool.retry(chat_id, mid, self.clock() + retry_delay(attempts, retry_after))
                LOG.warning("%s queued=%d", category, self.spool.count())
        except Exception:
            self.spool.retry(chat_id, mid, self.clock() + retry_delay(attempts))
            LOG.warning("transport_error queued=%d", self.spool.count())
        finally:
            self.busy = False
        return 1.0


async def authorize_check(client: Any, resolver=peer_id) -> Any:
    if not await client.is_user_authorized():
        raise UnauthorizedError("Telegram session unauthorized; run --login-qr or --login-phone explicitly")
    try:
        # Resolving a numeric channel needs an access hash in dialogs/session, not just an ID.
        target = None
        async for dialog in client.iter_dialogs():
            if resolver(dialog.entity) == TARGET_CHAT_ID:
                target = dialog.entity
                break
        if target is None:
            target = await client.get_entity(TARGET_CHAT_ID)
        if resolver(target) != TARGET_CHAT_ID:
            raise TargetUnavailableError("target group identity mismatch")
        # A bounded read proves the target is readable, not merely cached in a session.
        await client.get_messages(target, limit=1)
        return target
    except TargetUnavailableError:
        raise
    except Exception:
        raise TargetUnavailableError("Authorized account cannot read target group; collector will not join it") from None


def flood_wait_seconds(exc: BaseException) -> int | None:
    if type(exc).__name__ in ("FloodWaitError", "FloodWait"):
        return max(1, int(getattr(exc, "seconds", 60)))
    return None


class Scanner:
    """NewMessage events only wake a bounded scanner; never retain unbounded event tasks."""
    def __init__(self, config: Config, spool: Spool, client: Any, target: Any):
        self.config, self.spool, self.client, self.target = config, spool, client, target
        self.wake = asyncio.Event()
        self.blocked_until = 0.0
        self.full_logged = False

    async def scan(self) -> int:
        if time.monotonic() < self.blocked_until:
            return 0
        if self.spool.count() >= self.spool.maximum:
            if not self.full_logged:
                LOG.warning("spool_full paused_history queued=%d", self.spool.count())
                self.full_logged = True
            return 0
        self.full_logged = False
        cursor = self.spool.cursor()
        # Initial bootstrap: latest <=100, store in ascending order. Afterwards resume
        # from the committed cursor in ascending batches; never skip rejected/full items.
        if cursor is None and self.config.history == 0:
            # Explicitly choose a live-only baseline via one read, not all historical messages.
            try:
                messages = await self.client.get_messages(self.target, limit=1)
                self.spool.bootstrap_empty(messages[0].id if messages else 0)
            except Exception as exc:
                seconds = flood_wait_seconds(exc)
                self.blocked_until = time.monotonic() + (seconds if seconds else 30)
                LOG.warning("telegram_flood_wait" if seconds else "telegram_read_error")
            return 0
        kwargs = {"limit": self.config.history} if cursor is None else {
            "min_id": cursor, "reverse": True, "limit": MAX_HISTORY,
        }
        messages = []
        try:
            async for message in self.client.iter_messages(self.target, **kwargs):
                messages.append(message)
                if len(messages) >= MAX_HISTORY:
                    break
            messages.sort(key=lambda item: item.id)
            stored = 0
            unsupported = 0
            for message in messages:
                if self.spool.count() >= self.spool.maximum:
                    LOG.warning("spool_full paused_history queued=%d", self.spool.count())
                    self.full_logged = True
                    break
                sender = await message.get_sender()
                payload = message_payload(message, sender, getattr(self.target, "title", ""), TARGET_CHAT_ID)
                if payload is None:
                    unsupported += 1
                # Reply-form /spam lacks a source-user target in today's ingress
                # protocol. ID-form commands remain supported; do not invent targets.
                if (payload is not None and (payload["text"].strip().lower().split() or [""])[0].split("@")[0] == "/spam"
                        and len(payload["text"].strip().split(maxsplit=1)) == 1):
                    payload = None
                    unsupported += 1
                try:
                    stored += int(self.spool.record(payload, message.id))
                except SpoolFull:
                    LOG.warning("spool_full paused_history queued=%d", self.spool.count())
                    self.full_logged = True
                    break
            if not messages and cursor is None:
                self.spool.bootstrap_empty()
            if stored:
                LOG.info("source_spooled count=%d queued=%d", stored, self.spool.count())
            if unsupported:
                LOG.info("unsupported_skip count=%d", unsupported)
            return stored
        except Exception as exc:
            seconds = flood_wait_seconds(exc)
            self.blocked_until = time.monotonic() + (seconds if seconds else 30)
            LOG.warning("telegram_flood_wait" if seconds else "telegram_read_error")
            return 0

    async def on_new_message(self, event: Any) -> None:
        if getattr(event, "chat_id", None) == TARGET_CHAT_ID:
            self.wake.set()


async def login_phone(client: Any) -> None:
    # Non-interactive mode reads secrets from env; never from CLI arguments.
    phone = os.environ.get("TG_LOGIN_PHONE", "").strip()
    code = os.environ.get("TG_LOGIN_CODE", "").strip()
    password = os.environ.get("TG_2FA_PASSWORD", "").strip()
    if not phone or not code:
        if not sys.stdin.isatty():
            raise ConfigError("--login-phone requires TG_LOGIN_PHONE and TG_LOGIN_CODE, or an interactive terminal")
        phone = getpass.getpass("Telegram phone (hidden): ")
        sent = await client.send_code_request(phone)
        code = getpass.getpass("Telegram login code (hidden): ")
    else:
        sent = await client.send_code_request(phone)
    try:
        await client.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash)
    except Exception as exc:
        if type(exc).__name__ != "SessionPasswordNeededError":
            raise
        if not password:
            if not sys.stdin.isatty():
                raise ConfigError("TG_2FA_PASSWORD is required for two-factor accounts in non-interactive mode") from None
            password = getpass.getpass("Telegram 2FA password (hidden): ")
        await client.sign_in(password=password)
    LOG.info("AUTHORIZED")


async def login_qr(client: Any, directory: Path) -> None:
    # QR URL is an authentication credential. Never print it or send it off-device.
    try:
        import qrcode
        from qrcode.image.pure import PyPNGImage
    except ImportError:
        raise ConfigError("--login-qr requires the pinned qrcode package") from None
    for attempt in range(2):
        qr = await client.qr_login()
        filename = directory / "login-qr.png"
        private_file(filename)
        fd = os.open(filename, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            qrcode.make(qr.url, image_factory=PyPNGImage).save(stream)
        # 终端直接可扫的文本二维码：黑块为暗模块，空格为亮模块。
        if sys.stdout.isatty():
            matrix = qrcode.QRCode(border=2, error_correction=qrcode.constants.ERROR_CORRECT_L)
            matrix.add_data(qr.url); matrix.make()
            for row in matrix.get_matrix():
                print("".join("\u2588\u2588" if cell else "  " for cell in row), flush=True)
        # 只输出受保护文件路径，不回显 tg:// 令牌。
        print("Protected login QR file: " + str(filename), flush=True)
        try:
            # 令牌本身只有十几秒有效期；wait() 默认等至令牌过期，未扫到会抛超时后重建。
            await qr.wait()
            LOG.info("AUTHORIZED")
            return
        except asyncio.TimeoutError:
            LOG.info("telegram_qr_expired")
        except Exception as exc:
            if type(exc).__name__ != "SessionPasswordNeededError":
                raise
            password = os.environ.get("TG_2FA_PASSWORD", "").strip()
            if not password:
                if not sys.stdin.isatty():
                    raise ConfigError("TG_2FA_PASSWORD is required for two-factor accounts in non-interactive mode") from None
                password = getpass.getpass("Telegram 2FA password (hidden): ")
            await client.sign_in(password=password)
            LOG.info("AUTHORIZED")
            return
    raise UnauthorizedError("QR authorization timed out; rerun --login-qr explicitly")


async def run(config: Config, mode: str = "run") -> None:
    try:
        from telethon import TelegramClient, events
    except ImportError:
        raise ConfigError("Telethon unavailable; install collector/requirements.txt") from None
    private_dir(config.data_dir)
    private_file(config.session_path)
    lock_stream = None
    if mode == "run":
        lock_path = config.data_dir / "collector.lock"
        private_file(lock_path)
        lock_stream = lock_path.open("a")
        os.chmod(lock_path, 0o600)
        try:
            fcntl.flock(lock_stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock_stream.close()
            raise ConfigError("collector already running; only one sender process is allowed") from None
    client = TelegramClient(str(config.session_path), config.api_id, config.api_hash,
                            flood_sleep_threshold=0, request_retries=0, connection_retries=3,
                            auto_reconnect=True, entity_cache_limit=200)
    spool = None
    try:
        await client.connect()  # Never .start(): it can implicitly initiate authorization.
        if mode == "login-qr":
            await login_qr(client, config.data_dir)
            return
        if mode == "login-phone":
            await login_phone(client)
            return
        target = await authorize_check(client)
        LOG.info("authorized_target_readable")
        if mode == "check":
            return
        spool = Spool(config.data_dir / "spool.sqlite3", config.max_spool)
        scanner = Scanner(config, spool, client, target)
        dispatcher = Dispatcher(config, spool)
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        client.add_event_handler(scanner.on_new_message, events.NewMessage(chats=target))

        async def source_loop():
            while not stop.is_set():
                scanner.wake.clear()
                await scanner.scan()
                try:
                    await asyncio.wait_for(scanner.wake.wait(), timeout=config.poll_seconds)
                except asyncio.TimeoutError:
                    pass
                # Coalesce message bursts and keep source CPU/RPC load bounded.
                await asyncio.sleep(1)

        async def send_loop():
            while not stop.is_set():
                await asyncio.sleep(await dispatcher.step())

        tasks = [asyncio.create_task(source_loop()), asyncio.create_task(send_loop())]
        stop_task = asyncio.create_task(stop.wait())
        try:
            done, _ = await asyncio.wait([*tasks, stop_task], return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if task is not stop_task:
                    task.result()
                    raise RuntimeError("collector task ended unexpectedly")
        finally:
            for task in [*tasks, stop_task]:
                task.cancel()
            await asyncio.gather(*tasks, stop_task, return_exceptions=True)
    finally:
        await client.disconnect()
        private_file(config.session_path)
        if spool:
            spool.close()
        if lock_stream:
            lock_stream.close()


def main() -> int:
    os.umask(0o077)
    logging.getLogger().handlers[:] = [logging.NullHandler()]
    LOG.handlers[:] = [logging.StreamHandler()]
    LOG.setLevel(logging.INFO)
    LOG.propagate = False
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="check authorization and read access, no ingest")
    mode.add_argument("--login-qr", action="store_true", help="explicit login into a protected local QR PNG")
    mode.add_argument("--login-phone", action="store_true", help="explicit terminal login via hidden prompts")
    args = parser.parse_args()
    selected = "check" if args.check else "login-qr" if args.login_qr else "login-phone" if args.login_phone else "run"
    try:
        config = Config(dict(os.environ), require_ingest=selected == "run")
        asyncio.run(run(config, selected))
        return 0
    except UnauthorizedError:
        print("Session unauthorized: run --login-qr or --login-phone explicitly; no login code was requested.", file=sys.stderr)
        return 3
    except TargetUnavailableError:
        print("Authorized account cannot read target group. Join/access must be arranged manually; no join was attempted.", file=sys.stderr)
        return 4
    except ConfigError as exc:
        print("Configuration error: " + str(exc), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 0
    except Exception:
        # No traceback: upstream exception messages may embed phone/session/API endpoints.
        print("Collector failed (details suppressed to protect credentials).", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
