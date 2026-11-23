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
MAX_RESPONSE_BYTES = 64 * 1024
STATUS_CACHE_SECONDS = 60.0
STATUS_MAX_AGE_SECONDS = 300.0
STATUS_FUTURE_SKEW_SECONDS = 5.0
INGEST_PATHS = frozenset(("/api/ingest", "/api/observe/ingest"))
LEGACY_STATUSES = frozenset(("observe", "pass", "duplicate", "command"))
LOG = logging.getLogger("tg_sample_collector")


class ConfigError(ValueError):
    pass


class UnauthorizedError(RuntimeError):
    pass


class TargetUnavailableError(RuntimeError):
    pass


class SpoolFull(RuntimeError):
    pass


class CollectorPaused(RuntimeError):
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
        self.pool_mode = False
        self.control_status_url = ""
        if require_ingest:
            try:
                u = parse.urlsplit(self.url)
                port = u.port  # Access validates malformed ports; preserve explicit valid ports.
            except ValueError:
                raise ConfigError("OBSERVE_INGEST_URL is invalid") from None
            if (u.scheme != "https" or not u.hostname or u.username or u.password
                    or u.query or u.fragment or u.path not in INGEST_PATHS):
                raise ConfigError("OBSERVE_INGEST_URL must be an HTTPS /api/ingest or /api/observe/ingest endpoint")
            if not self.token or any(c.isspace() for c in self.token):
                raise ConfigError("OBSERVE_INGEST_TOKEN is missing or invalid")
            self.pool_mode = u.path == "/api/ingest"
            if self.pool_mode:
                # Controller origin is bound to the ingest origin, never a separate arbitrary URL.
                self.control_status_url = parse.urlunsplit((u.scheme, u.netloc, "/api/collector/status", "", ""))
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


class InvalidResponse(ValueError):
    """A protocol error, deliberately without the upstream body or exception text."""


def finite_number(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def read_json_bounded(response: Any) -> dict[str, Any]:
    """Read at most 64 KiB + one sentinel byte; never log or return the raw body."""
    declared = response.headers.get("Content-Length") if response.headers else None
    if declared is not None:
        try:
            if int(declared) < 0 or int(declared) > MAX_RESPONSE_BYTES:
                raise InvalidResponse("response length invalid")
        except (TypeError, ValueError):
            raise InvalidResponse("response length invalid") from None
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = response.read(min(8192, MAX_RESPONSE_BYTES + 1 - size))
        if not chunk:
            break
        if not isinstance(chunk, bytes):
            raise InvalidResponse("response bytes invalid")
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise InvalidResponse("response too large")
        chunks.append(chunk)

    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise InvalidResponse("duplicate JSON key")
            result[key] = value
        return result

    def reject_constant(_value):
        raise InvalidResponse("non-finite JSON value")

    try:
        parsed = json.loads(b"".join(chunks).decode("utf-8"), object_pairs_hook=unique_keys,
                            parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise InvalidResponse("invalid JSON response") from None
    if not isinstance(parsed, dict):
        raise InvalidResponse("response object required")
    return parsed


def no_redirect_opener():
    class NoRedirect(request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    return request.build_opener(NoRedirect())


def receipt_accepted(url: str, body: dict[str, Any]) -> bool:
    if body.get("paused") is True:
        return False
    event_id = body.get("event_id")
    if (body.get("ok") is True and body.get("accepted") is True
            and isinstance(event_id, str) and bool(event_id.strip()) and len(event_id) <= 512):
        return True
    # Legacy acceptance is restricted to the exact old endpoint, never the pool path.
    return (parse.urlsplit(url).path == "/api/observe/ingest" and body.get("ok") is True
            and "accepted" not in body and isinstance(body.get("status"), str)
            and body["status"] in LEGACY_STATUSES)


def response_retry_after(body: dict[str, Any], header: str | None) -> str | None:
    value = body.get("retryAfter")
    if finite_number(value) and value >= 0:
        return str(value)
    return header


def http_failure(response: Any, status: int) -> tuple[bool, str, str | None]:
    retry_after = response.headers.get("Retry-After") if response.headers else None
    if status in (429, 503):
        try:
            body = read_json_bounded(response)
            if body.get("paused") is True:
                return False, "controller_paused", response_retry_after(body, retry_after)
        except (InvalidResponse, OSError, TimeoutError):
            pass
    if status in (401, 403):
        return False, "unauthorized", retry_after
    return False, "http_rate_limited" if status == 429 else "http_rejected", retry_after


def send_http(url: str, token: str, payload: str) -> tuple[bool, str, str | None]:
    """Delete queued data only after a bounded, valid, explicit JSON acceptance receipt."""
    req = request.Request(url, data=payload.encode("utf-8"), method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + token,
        "User-Agent": "tg-sample-collector/1.0", "Accept": "application/json",
    })
    try:
        with no_redirect_opener().open(req, timeout=20) as response:
            if response.status != 200:
                return http_failure(response, response.status)
            try:
                body = read_json_bounded(response)
            except InvalidResponse:
                return False, "invalid_receipt", None
            if receipt_accepted(url, body):
                return True, "accepted", None
            if body.get("paused") is True:
                return False, "controller_paused", response_retry_after(body, None)
            return False, "invalid_receipt", None
    except error.HTTPError as exc:
        try:
            return http_failure(exc, exc.code)
        finally:
            exc.close()
    except (error.URLError, TimeoutError, OSError, ValueError):
        return False, "transport_error", None


def fetch_control_status(url: str, token: str) -> dict[str, Any] | None:
    req = request.Request(url, method="GET", headers={
        "Authorization": "Bearer " + token, "User-Agent": "tg-sample-collector/1.0",
        "Accept": "application/json",
    })
    try:
        with no_redirect_opener().open(req, timeout=20) as response:
            if response.status != 200:
                return None
            return read_json_bounded(response)
    except error.HTTPError as exc:
        exc.close()
        return None
    except (error.URLError, TimeoutError, OSError, ValueError):
        return None


class PauseGate:
    """Shared fail-closed snapshot; Scanner/Dispatcher never fetch status themselves."""
    def __init__(self, config: Config, *, clock=time.time):
        self.required = config.pool_mode
        self.url, self.token = config.control_status_url, config.token
        self.clock = clock
        self.observe_allowed = not self.required
        self.received_at: float | None = None
        self.checked_at: float | None = None
        self.next_check = 0.0
        self.hold_until = 0.0
        self.retry_seconds = STATUS_CACHE_SECONDS
        self.reason = "unknown" if self.required else "legacy"
        self._refresh_lock = asyncio.Lock()
        self._changed = asyncio.Event()

    def allowed(self) -> bool:
        if not self.required:
            return True
        now = self.clock()
        return (self.observe_allowed and self.received_at is not None and self.checked_at is not None
                and 0 <= now - self.received_at < STATUS_CACHE_SECONDS
                and -STATUS_FUTURE_SKEW_SECONDS <= now - self.checked_at <= STATUS_MAX_AGE_SECONDS
                and now >= self.hold_until)

    def update(self, body: dict[str, Any] | None) -> None:
        if not self.required:
            return
        now = self.clock()
        self.observe_allowed = False
        self.received_at = now
        self.checked_at = None
        self.reason = "unknown"
        self.retry_seconds = STATUS_CACHE_SECONDS
        self.next_check = now + STATUS_CACHE_SECONDS
        if (not isinstance(body, dict) or body.get("ok") is not True
                or type(body.get("observe_allowed")) is not bool
                or not isinstance(body.get("reason"), str) or len(body["reason"]) > 256
                or not finite_number(body.get("checked_at"))
                or not finite_number(body.get("retry_after")) or body["retry_after"] < 0):
            return
        checked_at = body["checked_at"] / 1000.0
        age = now - checked_at
        if checked_at <= 0 or not -STATUS_FUTURE_SKEW_SECONDS <= age <= STATUS_MAX_AGE_SECONDS:
            self.reason = "stale"
            return
        self.checked_at = checked_at
        self.observe_allowed = body["observe_allowed"]
        # Never store/print the server's free-form reason; only local fixed categories.
        self.reason = "allowed" if self.observe_allowed else "paused"
        if not self.observe_allowed:
            self.retry_seconds = max(3.0, float(body["retry_after"]))
            self.next_check = now + min(STATUS_CACHE_SECONDS, self.retry_seconds)
        self._changed.set()

    def pause(self, seconds: float = STATUS_CACHE_SECONDS, *, category: str = "paused") -> None:
        if not self.required:
            return
        now = self.clock()
        seconds = max(3.0, seconds) if finite_number(seconds) else STATUS_CACHE_SECONDS
        self.observe_allowed = False
        self.reason = "unauthorized" if category == "unauthorized" else "paused"
        self.retry_seconds = seconds
        self.hold_until = max(self.hold_until, now + seconds)
        self.next_check = now + min(STATUS_CACHE_SECONDS, seconds)
        self._changed.set()

    def wait_seconds(self) -> float:
        if self.allowed():
            return 3.0
        return min(STATUS_CACHE_SECONDS, max(3.0, self.next_check - self.clock()))

    async def refresh(self, fetcher=fetch_control_status) -> float:
        if not self.required:
            return STATUS_CACHE_SECONDS
        async with self._refresh_lock:
            if self.clock() < self.next_check:
                return min(STATUS_CACHE_SECONDS, max(3.0, self.next_check - self.clock()))
            try:
                body = await asyncio.to_thread(fetcher, self.url, self.token)
            except Exception:
                body = None
            self.update(body)
            if self.clock() < self.hold_until:
                # A later allow snapshot cannot cancel an ingest-requested Retry-After hold.
                self.next_check = min(self.next_check, self.hold_until)
            return min(STATUS_CACHE_SECONDS, max(3.0, self.next_check - self.clock()))

    async def watch(self, stop: asyncio.Event, fetcher=fetch_control_status) -> None:
        # One loop performs all HTTP status reads; data paths only inspect this cache.
        while not stop.is_set():
            delay = await self.refresh(fetcher)
            self._changed.clear()
            changed = asyncio.create_task(self._changed.wait())
            stopped = asyncio.create_task(stop.wait())
            try:
                await asyncio.wait((changed, stopped), timeout=delay,
                                   return_when=asyncio.FIRST_COMPLETED)
            finally:
                changed.cancel()
                stopped.cancel()
                await asyncio.gather(changed, stopped, return_exceptions=True)


class Dispatcher:
    def __init__(self, config: Config, spool: Spool, *, transport=send_http, clock=time.time,
                 pause_gate: PauseGate | None = None):
        self.config = config
        self.spool = spool
        self.transport = transport
        self.clock = clock
        self.pause_gate = pause_gate if pause_gate is not None else PauseGate(config, clock=clock)
        self.next_send = 0.0
        self.busy = False

    async def step(self) -> float:
        if not self.pause_gate.allowed():
            return self.pause_gate.wait_seconds()
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
                delay = retry_delay(attempts, retry_after)
                self.spool.retry(chat_id, mid, self.clock() + delay)
                if category in ("controller_paused", "unauthorized"):
                    self.pause_gate.pause(delay if retry_after else STATUS_CACHE_SECONDS,
                                          category=category)
                # Fixed categories only: upstream bodies/errors/tokens never reach logs.
                if category not in ("controller_paused", "unauthorized", "http_rate_limited",
                                    "http_rejected", "invalid_receipt", "transport_error"):
                    category = "transport_error"
                LOG.warning("%s queued=%d", category, self.spool.count())
        except Exception:
            self.spool.retry(chat_id, mid, self.clock() + retry_delay(attempts))
            LOG.warning("transport_error queued=%d", self.spool.count())
        finally:
            self.busy = False
        return 1.0 if self.pause_gate.allowed() else self.pause_gate.wait_seconds()


async def authorize_check(client: Any, resolver=peer_id, *, pause_gate: PauseGate | None = None) -> Any:
    if not await client.is_user_authorized():
        raise UnauthorizedError("Telegram session unauthorized; run --login-qr or --login-phone explicitly")

    def require_allowed():
        if pause_gate is not None and not pause_gate.allowed():
            raise CollectorPaused("controller paused")

    try:
        require_allowed()
        # Resolving a numeric channel needs an access hash in dialogs/session, not just an ID.
        target = None
        async for dialog in client.iter_dialogs():
            require_allowed()
            if resolver(dialog.entity) == TARGET_CHAT_ID:
                target = dialog.entity
                break
        if target is None:
            require_allowed()
            target = await client.get_entity(TARGET_CHAT_ID)
        if resolver(target) != TARGET_CHAT_ID:
            raise TargetUnavailableError("target group identity mismatch")
        require_allowed()
        # A bounded read proves the target is readable, not merely cached in a session.
        await client.get_messages(target, limit=1)
        require_allowed()
        return target
    except (TargetUnavailableError, CollectorPaused):
        raise
    except Exception:
        raise TargetUnavailableError("Authorized account cannot read target group; collector will not join it") from None


def flood_wait_seconds(exc: BaseException) -> int | None:
    if type(exc).__name__ in ("FloodWaitError", "FloodWait"):
        return max(1, int(getattr(exc, "seconds", 60)))
    return None


class Scanner:
    """NewMessage events only wake a bounded scanner; never retain unbounded event tasks."""
    def __init__(self, config: Config, spool: Spool, client: Any, target: Any, *,
                 pause_gate: PauseGate | None = None):
        self.config, self.spool, self.client, self.target = config, spool, client, target
        self.pause_gate = pause_gate if pause_gate is not None else PauseGate(config)
        self.wake = asyncio.Event()
        self.blocked_until = 0.0
        self.full_logged = False

    async def scan(self) -> int:
        if not self.pause_gate.allowed():
            return 0
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
                if self.pause_gate.allowed():
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
                if not self.pause_gate.allowed():
                    return 0
                messages.append(message)
                if len(messages) >= MAX_HISTORY:
                    break
            messages.sort(key=lambda item: item.id)
            stored = 0
            unsupported = 0
            for message in messages:
                if not self.pause_gate.allowed():
                    break
                if self.spool.count() >= self.spool.maximum:
                    LOG.warning("spool_full paused_history queued=%d", self.spool.count())
                    self.full_logged = True
                    break
                sender = await message.get_sender()
                if not self.pause_gate.allowed():
                    break
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
            if not messages and cursor is None and self.pause_gate.allowed():
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
        if self.pause_gate.allowed() and getattr(event, "chat_id", None) == TARGET_CHAT_ID:
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


async def wait_or_stop(stop: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass


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
    control_task = None
    stop = asyncio.Event()
    try:
        await client.connect()  # Never .start(): it can implicitly initiate authorization.
        if mode == "login-qr":
            await login_qr(client, config.data_dir)
            return
        if mode == "login-phone":
            await login_phone(client)
            return
        if mode == "check":
            await authorize_check(client)
            LOG.info("authorized_target_readable")
            return
        if not await client.is_user_authorized():
            raise UnauthorizedError("Telegram session unauthorized; login must be explicit")
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        gate = PauseGate(config)
        if gate.required:
            control_task = asyncio.create_task(gate.watch(stop))
        # No target dialogs/history RPCs while global observation is paused or unknown.
        while not stop.is_set():
            if control_task is not None and control_task.done():
                control_task.result()
                raise RuntimeError("control loop ended unexpectedly")
            if not gate.allowed():
                await wait_or_stop(stop, gate.wait_seconds())
                continue
            try:
                target = await authorize_check(client, pause_gate=gate)
                break
            except CollectorPaused:
                await wait_or_stop(stop, gate.wait_seconds())
        else:
            return
        LOG.info("authorized_target_readable")
        spool = Spool(config.data_dir / "spool.sqlite3", config.max_spool)
        scanner = Scanner(config, spool, client, target, pause_gate=gate)
        dispatcher = Dispatcher(config, spool, pause_gate=gate)
        client.add_event_handler(scanner.on_new_message, events.NewMessage(chats=target))

        async def source_loop():
            while not stop.is_set():
                scanner.wake.clear()
                if not gate.allowed():
                    await wait_or_stop(stop, gate.wait_seconds())
                    continue
                await scanner.scan()
                if not gate.allowed():
                    await wait_or_stop(stop, gate.wait_seconds())
                    continue
                try:
                    await asyncio.wait_for(scanner.wake.wait(), timeout=config.poll_seconds)
                except asyncio.TimeoutError:
                    pass
                # Coalesce message bursts and keep source CPU/RPC load bounded.
                await wait_or_stop(stop, 1)

        async def send_loop():
            while not stop.is_set():
                await wait_or_stop(stop, await dispatcher.step())

        tasks = [asyncio.create_task(source_loop()), asyncio.create_task(send_loop())]
        if control_task is not None:
            tasks.append(control_task)
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
        stop.set()
        if control_task is not None:
            control_task.cancel()
            await asyncio.gather(control_task, return_exceptions=True)
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
