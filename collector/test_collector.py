"""Pure stdlib tests with synthetic Telegram and HTTP clients; never contact a service."""
import asyncio
import contextlib
from io import BytesIO, StringIO
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
from urllib import error

from collector import (
    Config, ConfigError, Dispatcher, MAX_SPOOL, MAX_RESPONSE_BYTES, Scanner, Spool, SpoolFull,
    TARGET_CHAT_ID, TargetUnavailableError, UnauthorizedError, CollectorPaused,
    PauseGate, fetch_control_status, read_json_bounded, InvalidResponse,
    authorize_check, message_payload, retry_delay, send_http, run,
)


def environment(directory):
    return {"TG_API_ID": "12345", "TG_API_HASH": "a" * 32,
            "COLLECTOR_DATA_DIR": str(directory),
            "OBSERVE_INGEST_URL": "https://receiver.invalid/api/observe/ingest",
            "OBSERVE_INGEST_TOKEN": "SYNTHETIC-NOT-REAL"}


def payload(mid=1):
    return {"chat_id": str(TARGET_CHAT_ID), "message_id": mid,
            "user_id": "123", "text": "synthetic ordinary discussion"}


def message(mid=1, text="ordinary discussion", **kwargs):
    data = dict(id=mid, message=text, out=False, reply_to=None, media=None)
    data.update(kwargs)
    result = types.SimpleNamespace(**data)
    async def sender():
        return types.SimpleNamespace(id=123, first_name="User", last_name="", username="person", bot=False)
    result.get_sender = sender
    return result


class ConfigTests(unittest.TestCase):
    def test_default_limits(self):
        c = Config(environment(Path("/tmp/private-collector")))
        self.assertEqual(c.rate, 20)
        self.assertEqual(c.history, 100)
        self.assertEqual(c.max_spool, 1000)
        self.assertEqual(c.session_path.name, "telegram.session")

    def test_authorization_modes_do_not_need_ingest_secret(self):
        c = Config({"TG_API_ID": "123", "TG_API_HASH": "b" * 32}, require_ingest=False)
        self.assertEqual(str(c.data_dir), "/var/lib/tg-sample-collector")

    def test_pool_config_derives_same_origin_status_without_new_login(self):
        env = environment(Path("/tmp/private-collector"))
        env["OBSERVE_INGEST_URL"] = "https://controller.invalid:8443/api/ingest"
        c = Config(env)
        self.assertTrue(c.pool_mode)
        self.assertEqual(c.control_status_url, "https://controller.invalid:8443/api/collector/status")
        self.assertEqual(c.session_path.name, "telegram.session")
        self.assertEqual(c.token, env["OBSERVE_INGEST_TOKEN"])
        # An arbitrary status origin in the environment cannot send the collector token elsewhere.
        env["CONTROL_STATUS_URL"] = "https://untrusted.invalid/status"
        self.assertEqual(Config(env).control_status_url, c.control_status_url)
        old = Config(environment(Path("/tmp/private-collector")))
        self.assertFalse(old.pool_mode)
        self.assertEqual(old.control_status_url, "")

    def test_missing_bad_or_excessive_config_is_rejected_without_leaks(self):
        for key, value in [("TG_API_ID", ""), ("TG_API_HASH", "bad"),
                           ("COLLECTOR_PER_MINUTE", "21"), ("COLLECTOR_MAX_SPOOL", "1001"),
                           ("COLLECTOR_HISTORY_LIMIT", "101"), ("OBSERVE_INGEST_TOKEN", "")]:
            env = environment(Path("/tmp/private-collector"))
            env[key] = value
            with self.subTest(key=key), self.assertRaises(ConfigError):
                Config(env)

    def test_endpoint_no_cleartext_embedded_credentials_redirect_target_or_query(self):
        for url in ["http://receiver.invalid/api/observe/ingest", "http://receiver.invalid/api/ingest",
                    "https://x:password@receiver.invalid/api/observe/ingest",
                    "https://receiver.invalid/other", "https://receiver.invalid/api/observe/ingest?key=bad",
                    "https://receiver.invalid/api/ingest?token=bad", "https://receiver.invalid/api/ingest/",
                    "https://receiver.invalid/api/ingest#fragment", "https://receiver.invalid:bad/api/ingest"]:
            env = environment(Path("/tmp/private-collector"))
            env["OBSERVE_INGEST_URL"] = url
            with self.subTest(url=url), self.assertRaises(ConfigError):
                Config(env)


class PayloadTests(unittest.TestCase):
    def setUp(self):
        self.sender = types.SimpleNamespace(id=123, first_name="First", last_name="Last", username="person", bot=False)

    def test_target_only_no_ad_verdict(self):
        p = message_payload(message(), self.sender, "Group", TARGET_CHAT_ID)
        self.assertEqual(p["text"], "ordinary discussion")
        self.assertEqual(p["chat_id"], str(TARGET_CHAT_ID))
        self.assertNotIn("is_ad", p)
        self.assertNotIn("phone", p)
        self.assertIsNone(message_payload(message(), self.sender, "Group", -100999))

    def test_quote_card_and_bounds(self):
        msg = message(text="x" * 9000,
                      reply_to=types.SimpleNamespace(quote_text="q" * 9000),
                      media=types.SimpleNamespace(first_name="card", last_name="name", phone_number="do-not-send"))
        self.sender.first_name = "f" * 1000
        p = message_payload(msg, self.sender, "g" * 1000, TARGET_CHAT_ID)
        self.assertEqual(len(p["text"]), 4000)
        self.assertEqual(len(p["quote"]), 4000)
        self.assertEqual(len(p["first_name"]), 256)
        self.assertEqual(len(p["chat_title"]), 256)
        self.assertEqual(p["contact_name"], "card name")
        self.assertNotIn("do-not-send", json.dumps(p))

    def test_no_guessing_user_or_picture_ocr(self):
        channel = types.SimpleNamespace(id=123, title="channel")
        self.assertIsNone(message_payload(message(), channel, "Group", TARGET_CHAT_ID))
        self.assertIsNone(message_payload(message(out=True), self.sender, "Group", TARGET_CHAT_ID))
        self.assertIsNone(message_payload(message(text=""), self.sender, "Group", TARGET_CHAT_ID))
        self.assertIsNone(message_payload(message(mid=0), self.sender, "Group", TARGET_CHAT_ID))


class SpoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "private" / "spool.sqlite3"
        self.spool = Spool(self.path, maximum=2)

    def tearDown(self):
        self.spool.close()
        self.temp.cleanup()

    def test_insert_dedupe_cursor_and_private_permissions(self):
        self.assertTrue(self.spool.record(payload(1), 1))
        self.assertFalse(self.spool.record(payload(1), 1))
        self.assertEqual(self.spool.count(), 1)
        self.assertEqual(self.spool.cursor(), 1)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o700)

    def test_full_outbox_never_moves_cursor_past_unsaved_item(self):
        self.spool.record(payload(1), 1)
        self.spool.record(payload(2), 2)
        with self.assertRaises(SpoolFull):
            self.spool.record(payload(3), 3)
        self.assertEqual(self.spool.cursor(), 2)
        self.assertEqual(self.spool.count(), 2)
        self.spool.complete(str(TARGET_CHAT_ID), 1)
        self.assertTrue(self.spool.record(payload(3), 3))
        self.assertEqual(self.spool.cursor(), 3)

    def test_reopen_keeps_payloads_and_cursor(self):
        self.spool.record(payload(1), 1)
        self.spool.close()
        self.spool = Spool(self.path)
        self.assertEqual(self.spool.cursor(), 1)
        self.assertEqual(json.loads(self.spool.next_item()[2]), payload())

    def test_failing_transaction_does_not_move_cursor(self):
        self.spool.db.execute("CREATE TRIGGER block_insert BEFORE INSERT ON spool BEGIN SELECT RAISE(ABORT,'blocked'); END")
        with self.assertRaises(Exception):
            self.spool.record(payload(), 1)
        self.assertIsNone(self.spool.cursor())
        self.assertEqual(self.spool.count(), 0)

    def test_only_target_allowed(self):
        with self.assertRaises(ValueError):
            self.spool.record({**payload(), "chat_id": "-100999"}, 1)
        self.assertIsNone(self.spool.cursor())

    def test_service_message_is_intentionally_skipped_without_payload(self):
        self.spool.record(None, 5)
        self.assertEqual(self.spool.cursor(), 5)
        self.assertEqual(self.spool.count(), 0)


class DispatcherTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = Config(environment(Path(self.temp.name) / "private"))
        self.spool = Spool(self.config.data_dir / "spool.sqlite3")
        self.now = 1000.0
        self.clock = lambda: self.now

    async def asyncTearDown(self):
        self.spool.close()
        self.temp.cleanup()

    async def test_accepted_deletes_only_after_response_and_obeys_rate(self):
        self.spool.record(payload(1), 1)
        self.spool.record(payload(2), 2)
        delivered = []
        def http(url, token, body):
            delivered.append(json.loads(body)["message_id"])
            return True, "accepted", None
        d = Dispatcher(self.config, self.spool, transport=http, clock=self.clock)
        await d.step()
        self.assertEqual(delivered, [1])
        self.assertEqual(self.spool.count(), 1)
        await d.step()
        self.assertEqual(delivered, [1])
        self.now += 3
        await d.step()
        self.assertEqual(delivered, [1, 2])
        self.assertEqual(self.spool.count(), 0)

    async def test_failure_and_429_preserve_queue_and_backoff(self):
        self.spool.record(payload(), 1)
        calls = []
        def http(*_):
            calls.append(1)
            return False, "http_rate_limited", "120"
        d = Dispatcher(self.config, self.spool, transport=http, clock=self.clock)
        await d.step()
        self.assertEqual(self.spool.count(), 1)
        self.assertEqual(self.spool.next_item()[4], 1120)
        self.now += 119
        await d.step()
        self.assertEqual(len(calls), 1)
        self.now += 1
        await d.step()
        self.assertEqual(len(calls), 2)

    async def test_unique_dispatcher_does_not_send_concurrently(self):
        self.spool.record(payload(), 1)
        import threading
        release = threading.Event()
        started = threading.Event()
        calls = []
        def http(*_):
            calls.append(1)
            started.set()
            release.wait(2)
            return True, "accepted", None
        d = Dispatcher(self.config, self.spool, transport=http, clock=self.clock)
        task = asyncio.create_task(d.step())
        await asyncio.to_thread(started.wait, 1)
        await d.step()
        release.set()
        await task
        self.assertEqual(len(calls), 1)


class FakeClient:
    def __init__(self, messages=None, authorized=True, readable=True):
        self.authorized = authorized
        self.readable = readable
        self.messages = messages or []
        self.kwargs = []
        self.target = types.SimpleNamespace(id=TARGET_CHAT_ID, title="Target")

    async def is_user_authorized(self):
        return self.authorized

    async def iter_dialogs(self):
        yield types.SimpleNamespace(entity=self.target)

    async def get_entity(self, *_):
        raise AssertionError("already resolved via dialogs")

    async def get_messages(self, *_args, **_kwargs):
        if not self.readable:
            raise RuntimeError("private Telegram data")
        return self.messages[-1:]

    async def iter_messages(self, target, **kwargs):
        self.kwargs.append(kwargs)
        if "min_id" in kwargs:
            results = [m for m in self.messages if m.id > kwargs["min_id"]]
        else:
            results = list(reversed(self.messages))
        for m in results[:kwargs["limit"]]:
            yield m


class SourceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = Config(environment(Path(self.temp.name) / "private"))
        self.spool = Spool(self.config.data_dir / "spool.sqlite3", maximum=2)

    async def asyncTearDown(self):
        self.spool.close()
        self.temp.cleanup()

    async def test_unauthorized_never_requests_code_or_starts_client(self):
        c = FakeClient(authorized=False)
        with self.assertRaises(UnauthorizedError):
            await authorize_check(c, resolver=lambda e: e.id)

    async def test_check_is_readonly_and_demonstrates_access(self):
        c = FakeClient()
        target = await authorize_check(c, resolver=lambda e: e.id)
        self.assertEqual(target.id, TARGET_CHAT_ID)
        with self.assertRaises(TargetUnavailableError):
            await authorize_check(FakeClient(readable=False), resolver=lambda e: e.id)

    async def test_bootstrap_cap_ascending_and_full_resumption(self):
        c = FakeClient([message(i) for i in range(1, 151)])
        s = Scanner(self.config, self.spool, c, c.target)
        await s.scan()
        self.assertEqual(c.kwargs[0], {"limit": 100})
        self.assertEqual(self.spool.cursor(), 52)
        self.assertEqual(self.spool.next_item()[1], 51)
        self.spool.complete(str(TARGET_CHAT_ID), 51)
        self.spool.complete(str(TARGET_CHAT_ID), 52)
        await s.scan()
        self.assertEqual(c.kwargs[1], {"min_id": 52, "reverse": True, "limit": 100})
        self.assertEqual(self.spool.cursor(), 54)
        self.assertEqual(self.spool.next_item()[1], 53)

    async def test_runtime_unauthorized_disconnects_without_start_or_requesting_codes(self):
        class Client:
            async def connect(self): pass
            async def disconnect(self): self.disconnected = True
            async def is_user_authorized(self): return False
            async def start(self): raise AssertionError("implicit login prohibited")
            async def send_code_request(self, *_): raise AssertionError("no code request authorized")
        client = Client()
        fake = types.ModuleType("telethon")
        fake.TelegramClient = lambda *_args, **_kwargs: client
        fake.events = types.SimpleNamespace()
        with patch.dict("sys.modules", {"telethon": fake}):
            with self.assertRaises(UnauthorizedError):
                await run(self.config, "check")
        self.assertTrue(client.disconnected)

    async def test_live_only_baseline_and_reply_spam_are_not_misclassified(self):
        c = FakeClient([message(1, "/spam"), message(2, "/spam 12345")])
        s = Scanner(self.config, self.spool, c, c.target)
        await s.scan()
        self.assertEqual(self.spool.count(), 1)
        self.assertEqual(self.spool.next_item()[1], 2)
        self.assertEqual(self.spool.cursor(), 2)

    async def test_live_wakeup_only_selected_group_never_retains_events(self):
        c = FakeClient()
        s = Scanner(self.config, self.spool, c, c.target)
        await s.on_new_message(types.SimpleNamespace(chat_id=-100999))
        self.assertFalse(s.wake.is_set())
        await s.on_new_message(types.SimpleNamespace(chat_id=TARGET_CHAT_ID))
        self.assertTrue(s.wake.is_set())
        self.assertEqual(self.spool.count(), 0)

    async def test_flood_wait_pauses_instead_of_skipping_cursor(self):
        class FloodWaitError(Exception):
            seconds = 60
        class FloodClient(FakeClient):
            async def iter_messages(self, *args, **kwargs):
                raise FloodWaitError("do not log private text")
                yield
        c = FloodClient()
        s = Scanner(self.config, self.spool, c, c.target)
        await s.scan()
        self.assertIsNone(self.spool.cursor())
        self.assertGreater(s.blocked_until, 0)
        self.assertEqual(self.spool.count(), 0)


class FakePauseGate:
    def __init__(self, allowed=False):
        self.is_allowed = allowed
        self.pauses = []
    def allowed(self): return self.is_allowed
    def wait_seconds(self): return 60.0
    def pause(self, seconds=60, *, category="paused"):
        self.pauses.append((seconds, category))
        self.is_allowed = False


def pool_config(directory):
    env = environment(directory)
    env["OBSERVE_INGEST_URL"] = "https://controller.invalid/api/ingest"
    return Config(env)


class PauseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = pool_config(Path(self.temp.name) / "private")
        self.spool = Spool(self.config.data_dir / "spool.sqlite3")
        self.now = 1000.0
        self.gate = PauseGate(self.config, clock=lambda: self.now)

    async def asyncTearDown(self):
        self.spool.close()
        self.temp.cleanup()

    def status(self, **changes):
        return {"ok": True, "observe_allowed": True, "reason": "quota_available",
                "checked_at": self.now * 1000, "retry_after": 60, **changes}

    async def test_pool_unknown_or_stale_snapshot_fails_closed(self):
        self.assertFalse(self.gate.allowed())
        self.gate.update(self.status())
        self.assertTrue(self.gate.allowed())
        self.now += 60
        self.assertFalse(self.gate.allowed(), "cached allow must expire at 60 seconds")
        for status in [self.status(checked_at=(self.now - 301) * 1000),
                       self.status(checked_at=(self.now + 6) * 1000),
                       self.status(checked_at=0), self.status(checked_at="1000000"),
                       self.status(observe_allowed="true"), self.status(ok=1),
                       self.status(retry_after=float("nan")), self.status(retry_after=-1),
                       self.status(reason=None), {}, None]:
            with self.subTest(status=status):
                self.gate.update(status)
                self.assertFalse(self.gate.allowed())

    async def test_paused_sender_and_scanner_make_no_request_and_keep_cursor_queue(self):
        self.spool.record(payload(1), 1)
        before = self.spool.next_item()
        gate = FakePauseGate(False)
        called = []
        def http(*_): called.append("ingest"); return True, "accepted", None
        client = FakeClient([message(2)])
        scanner = Scanner(self.config, self.spool, client, client.target, pause_gate=gate)
        sender = Dispatcher(self.config, self.spool, transport=http, pause_gate=gate)
        self.assertEqual(await scanner.scan(), 0)
        self.assertEqual(await sender.step(), 60)
        await scanner.on_new_message(types.SimpleNamespace(chat_id=TARGET_CHAT_ID))
        self.assertFalse(scanner.wake.is_set())
        self.assertEqual(called, [])
        self.assertEqual(client.kwargs, [])
        self.assertEqual(self.spool.cursor(), 1)
        self.assertEqual(self.spool.next_item(), before)
        # Resume from the very same cursor and spool; no session replacement is needed.
        gate.is_allowed = True
        self.assertEqual(await scanner.scan(), 1)
        await sender.step()
        self.assertEqual(called, ["ingest"])
        self.assertEqual(self.spool.cursor(), 2)
        self.assertEqual(self.spool.next_item()[1], 2)

    async def test_live_only_baseline_does_not_advance_while_paused(self):
        gate = FakePauseGate(False)
        self.config.history = 0
        class Client(FakeClient):
            async def get_messages(self, *args, **kwargs):
                raise AssertionError("paused baseline must not read Telegram")
        client = Client([message(20)])
        scanner = Scanner(self.config, self.spool, client, client.target, pause_gate=gate)
        await scanner.scan()
        self.assertIsNone(self.spool.cursor())
        self.assertEqual(self.spool.count(), 0)

    async def test_pause_mid_sender_lookup_never_advances_cursor(self):
        gate = FakePauseGate(True)
        msg = message(1)
        async def sender():
            gate.is_allowed = False
            return types.SimpleNamespace(id=123, first_name="User")
        msg.get_sender = sender
        client = FakeClient([msg])
        scanner = Scanner(self.config, self.spool, client, client.target, pause_gate=gate)
        await scanner.scan()
        self.assertIsNone(self.spool.cursor())
        self.assertEqual(self.spool.count(), 0)

    async def test_global_pause_from_ingest_stops_both_paths_and_keeps_head(self):
        self.gate.update(self.status())
        self.spool.record(payload(1), 1)
        calls = []
        def http(*_): calls.append("ingest"); return False, "controller_paused", "60"
        sender = Dispatcher(self.config, self.spool, transport=http, clock=lambda: self.now,
                            pause_gate=self.gate)
        client = FakeClient([message(2)])
        scanner = Scanner(self.config, self.spool, client, client.target, pause_gate=self.gate)
        self.assertEqual(await sender.step(), 60)
        self.assertFalse(self.gate.allowed())
        await scanner.scan()
        await sender.step()
        self.assertEqual(calls, ["ingest"])
        self.assertEqual(client.kwargs, [])
        self.assertEqual(self.spool.cursor(), 1)
        self.assertEqual(self.spool.count(), 1)
        self.assertEqual(self.spool.next_item()[4], self.now + 60)

    async def test_untrusted_fetch_failure_and_denied_status_keep_unknown_paused(self):
        calls = []
        def fetcher(*_): calls.append(1); return None
        self.assertEqual(await self.gate.refresh(fetcher), 60)
        self.assertFalse(self.gate.allowed())
        for _ in range(3):
            await self.gate.refresh(fetcher)
        self.assertEqual(len(calls), 1, "unknown status must not busy-loop")
        self.now += 60
        await self.gate.refresh(lambda *_: self.status(observe_allowed=False, reason="all_accounts_paused"))
        self.assertFalse(self.gate.allowed())
        self.assertEqual(self.gate.reason, "paused")
        self.assertEqual(self.gate.wait_seconds(), 60)

    async def test_status_refresh_concurrency_fetches_once_for_scanner_and_sender(self):
        calls = []
        def fetcher(*_): calls.append(1); return self.status()
        await asyncio.gather(self.gate.refresh(fetcher), self.gate.refresh(fetcher))
        self.assertEqual(calls, [1])
        self.assertTrue(self.gate.allowed())
        self.assertEqual(await self.gate.refresh(fetcher), 60)
        self.assertEqual(calls, [1])
        self.now += 59
        await self.gate.refresh(fetcher)
        self.assertEqual(calls, [1])
        self.now += 1
        await self.gate.refresh(fetcher)
        self.assertEqual(calls, [1, 1])

    async def test_control_watch_has_one_fetch_loop_and_stops_cleanly(self):
        calls = []
        def fetcher(*_): calls.append(1); return self.status(observe_allowed=False)
        stop = asyncio.Event()
        task = asyncio.create_task(self.gate.watch(stop, fetcher))
        for _ in range(20):
            if calls: break
            await asyncio.sleep(0)
        stop.set()
        await asyncio.wait_for(task, 1)
        self.assertEqual(calls, [1])
        self.assertFalse(self.gate.allowed())

    async def test_unknown_and_paused_default_pool_paths_have_no_implicit_status_fetch(self):
        client = FakeClient([message(2)])
        self.spool.record(payload(1), 1)
        scanner = Scanner(self.config, self.spool, client, client.target)
        sender = Dispatcher(self.config, self.spool, transport=lambda *_: self.fail("no ingestion"))
        with patch("collector.fetch_control_status", side_effect=AssertionError("data paths must not fetch status")):
            await scanner.scan()
            self.assertGreaterEqual(await sender.step(), 3)
        self.assertEqual(client.kwargs, [])
        self.assertEqual(self.spool.cursor(), 1)

    async def test_initial_target_lookup_is_blocked_while_control_is_paused(self):
        client = FakeClient()
        with self.assertRaises(CollectorPaused):
            await authorize_check(client, resolver=lambda e: e.id, pause_gate=self.gate)
        self.assertEqual(client.kwargs, [])

    async def test_paused_runtime_stays_alive_without_target_scan_and_exits_on_stop(self):
        class Client:
            disconnected = False
            async def connect(self): pass
            async def disconnect(self): self.disconnected = True
            async def is_user_authorized(self): return True
            async def iter_dialogs(self):
                raise AssertionError("paused runtime must not fetch Telegram dialogs")
                yield
            async def get_messages(self, *_args, **_kwargs):
                raise AssertionError("paused runtime must not fetch Telegram history")
            def add_event_handler(self, *_args):
                raise AssertionError("no target setup while paused")
        client = Client()
        fake = types.ModuleType("telethon")
        fake.TelegramClient = lambda *_args, **_kwargs: client
        fake.events = types.SimpleNamespace()
        ready = asyncio.Event()
        holder = {}
        async def watcher(gate, stop, fetcher=None):
            gate.update({"ok": True, "observe_allowed": False, "reason": "all_accounts_paused",
                         "checked_at": gate.clock() * 1000, "retry_after": 60})
            holder["stop"] = stop
            ready.set()
            await stop.wait()
        with patch.dict("sys.modules", {"telethon": fake}), patch.object(PauseGate, "watch", watcher):
            task = asyncio.create_task(run(self.config))
            await asyncio.wait_for(ready.wait(), 1)
            self.assertFalse(task.done(), "paused runtime should stay alive")
            holder["stop"].set()
            await asyncio.wait_for(task, 1)
        self.assertTrue(client.disconnected)

    async def test_html200_never_removes_a_pending_spool_item(self):
        self.gate.update(self.status())
        self.spool.record(payload(1), 1)
        response = FakeResponse(b"<html>not a controller receipt</html>")
        class Opener:
            def open(self, *_args, **_kwargs): return response
        sender = Dispatcher(self.config, self.spool, clock=lambda: self.now, pause_gate=self.gate)
        with patch("collector.request.build_opener", return_value=Opener()):
            await sender.step()
        self.assertEqual(self.spool.count(), 1)
        self.assertEqual(self.spool.cursor(), 1)
        self.assertEqual(self.spool.next_item()[3], 1)
        self.assertEqual(self.spool.next_item()[4], self.now + 5)

    async def test_ingest_pause_hold_cannot_be_cancelled_by_a_later_allowed_status(self):
        self.gate.update(self.status())
        self.gate.pause(120)
        self.now += 60
        await self.gate.refresh(lambda *_: self.status())
        self.assertFalse(self.gate.allowed())
        self.now += 60
        await self.gate.refresh(lambda *_: self.status())
        self.assertTrue(self.gate.allowed())


class FakeResponse:
    def __init__(self, body, status=200, headers=None):
        self.status = status
        self.headers = headers or {}
        self.stream = BytesIO(body if isinstance(body, bytes) else json.dumps(body).encode())
        self.read_sizes = []
        self.closed = False
    def __enter__(self): return self
    def __exit__(self, *_): self.close()
    def read(self, size):
        if size < 0:
            raise AssertionError("unbounded body read prohibited")
        self.read_sizes.append(size)
        return self.stream.read(size)
    def close(self): self.closed = True


class HttpTests(unittest.TestCase):
    def send_fake(self, body, *, path="/api/ingest", status=200, headers=None, as_error=False):
        response = FakeResponse(body, status, headers)
        class Opener:
            def open(self, req, timeout):
                self.req, self.timeout = req, timeout
                if as_error:
                    raise error.HTTPError(req.full_url, status, "private reply", response.headers, response)
                return response
        opener = Opener()
        with patch("collector.request.build_opener", return_value=opener):
            result = send_http("https://receiver.invalid" + path, "test-token", "{}")
        return result, response, opener

    def test_post_bearer_timeout20_and_reads_only_bounded_receipt(self):
        result, response, opener = self.send_fake({"ok": True, "accepted": True, "event_id": "evt-123"})
        self.assertEqual(result, (True, "accepted", None))
        self.assertTrue(response.read_sizes)
        self.assertTrue(all(0 < n <= 8192 for n in response.read_sizes))
        self.assertTrue(response.closed)
        self.assertEqual(opener.timeout, 20)
        self.assertEqual(opener.req.method, "POST")
        self.assertEqual(opener.req.get_header("Authorization"), "Bearer test-token")
        self.assertEqual(opener.req.get_header("User-agent"), "tg-sample-collector/1.0")
        self.assertEqual(opener.req.get_header("Content-type"), "application/json")
        self.assertEqual(opener.req.get_header("Accept"), "application/json")

    def test_pool_acceptance_is_strict_and_html200_is_not_accepted(self):
        bodies = [b"<html>private gateway page</html>", b"", [], {},
                  {"ok": True}, {"ok": True, "status": "observe"},
                  {"ok": True, "accepted": False, "event_id": "evt"},
                  {"ok": 1, "accepted": True, "event_id": "evt"},
                  {"ok": True, "accepted": 1, "event_id": "evt"},
                  {"ok": True, "accepted": True, "event_id": ""},
                  {"ok": True, "accepted": True, "event_id": "   "},
                  {"ok": True, "accepted": True, "event_id": 123},
                  {"ok": True, "accepted": True, "event_id": "x" * 513},
                  b'{"ok":true,"ok":false,"accepted":true,"event_id":"evt"}',
                  b'{"ok":true,"accepted":true,"event_id":"evt","n":NaN}']
        for body in bodies:
            with self.subTest(body=body):
                result, _, _ = self.send_fake(body)
                self.assertFalse(result[0])
                self.assertEqual(result[1], "invalid_receipt")

    def test_legacy_receipts_only_work_on_exact_legacy_path(self):
        for status in ("observe", "pass", "duplicate", "command"):
            with self.subTest(status=status):
                body = {"ok": True, "status": status}
                self.assertTrue(self.send_fake(body, path="/api/observe/ingest")[0][0])
                self.assertFalse(self.send_fake(body, path="/api/ingest")[0][0])
        for body in ({"ok": True, "status": "other"}, {"ok": 1, "status": "pass"},
                     {"ok": True, "status": "pass", "accepted": False}):
            self.assertFalse(self.send_fake(body, path="/api/observe/ingest")[0][0])

    def test_receipt_size_limit_and_declared_oversize_prevent_unbounded_read(self):
        large = {"ok": True, "accepted": True, "event_id": "evt", "padding": "x" * MAX_RESPONSE_BYTES}
        result, response, _ = self.send_fake(large)
        self.assertEqual(result[1], "invalid_receipt")
        self.assertEqual(sum(response.read_sizes), MAX_RESPONSE_BYTES + 1)
        result, response, _ = self.send_fake({"ok": True}, headers={"Content-Length": str(MAX_RESPONSE_BYTES + 1)})
        self.assertEqual(result[1], "invalid_receipt")
        self.assertEqual(response.read_sizes, [])
        # The boundary itself is allowed when it contains a complete object and padding whitespace.
        raw = b'{"ok":true,"accepted":true,"event_id":"evt"}'
        self.assertTrue(self.send_fake(raw + b" " * (MAX_RESPONSE_BYTES - len(raw)))[0][0])

    def test_429_and_503_paused_json_keep_retry_after_and_never_accept(self):
        for status in (429, 503):
            for as_error in (False, True):
                with self.subTest(status=status, as_error=as_error):
                    result, response, _ = self.send_fake({"ok": False, "paused": True, "retryAfter": 120},
                        status=status, headers={"Retry-After": "30"}, as_error=as_error)
                    self.assertEqual(result, (False, "controller_paused", "120"))
                    self.assertTrue(response.closed)
        result, _, _ = self.send_fake({"paused": True, "retryAfter": "unknown"}, status=503,
                                      headers={"Retry-After": "45"})
        self.assertEqual(result, (False, "controller_paused", "45"))
        contradictory = {"ok": True, "accepted": True, "event_id": "evt", "paused": True, "retryAfter": 60}
        self.assertEqual(self.send_fake(contradictory)[0], (False, "controller_paused", "60"))

    def test_http_error_does_not_leak_body_url_or_original_exception(self):
        for status in (301, 401, 403, 429, 503):
            with self.subTest(status=status):
                capture = StringIO()
                with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
                    result, _, _ = self.send_fake(b"PRIVATE-RESPONSE", status=status,
                                                  headers={"Retry-After": "30"}, as_error=True)
                self.assertFalse(result[0])
                self.assertEqual(result[2], "30")
                self.assertEqual(capture.getvalue(), "")

    def test_redirect_handler_refuses_following(self):
        class Opener:
            def open(self, *_args, **_kwargs):
                raise error.HTTPError("https://receiver.invalid/api/ingest", 302, "private", {}, None)
        with patch("collector.request.build_opener", return_value=Opener()) as build:
            self.assertFalse(send_http("https://receiver.invalid/api/ingest", "token", "{}")[0])
        handler = build.call_args.args[0]
        self.assertIsNone(handler.redirect_request(None, None, 302, "", {}, "https://other.invalid"))

    def test_transport_failure_returns_only_fixed_category(self):
        class Opener:
            def open(self, *_args, **_kwargs):
                raise error.URLError("SECRET-TOKEN-OR-MESSAGE")
        with patch("collector.request.build_opener", return_value=Opener()):
            self.assertEqual(send_http("https://receiver.invalid/api/ingest", "secret", "private"),
                             (False, "transport_error", None))

    def test_control_status_request_is_get_bearer_bounded_and_same_protocol(self):
        body = {"ok": True, "observe_allowed": False, "reason": "all_accounts_paused",
                "checked_at": 1000000, "retry_after": 60}
        response = FakeResponse(body)
        class Opener:
            def open(self, req, timeout):
                self.req, self.timeout = req, timeout
                return response
        opener = Opener()
        with patch("collector.request.build_opener", return_value=opener):
            result = fetch_control_status("https://controller.invalid/api/collector/status", "collector-token")
        self.assertEqual(result, body)
        self.assertEqual(opener.req.method, "GET")
        self.assertEqual(opener.req.get_header("Authorization"), "Bearer collector-token")
        self.assertEqual(opener.timeout, 20)
        self.assertTrue(response.closed)
        self.assertTrue(response.read_sizes)

    def test_control_status_bad_html_unauthorized_and_oversized_are_unknown(self):
        for status, body in [(200, b"<html>SECRET</html>"), (401, b"SECRET"), (403, b"SECRET"),
                             (503, b"SECRET"), (200, b"x" * (MAX_RESPONSE_BYTES + 1))]:
            response = FakeResponse(body, status)
            class Opener:
                def open(self, *_args, **_kwargs):
                    if status != 200:
                        raise error.HTTPError("https://private.invalid", status, "PRIVATE", {}, response)
                    return response
            with self.subTest(status=status), patch("collector.request.build_opener", return_value=Opener()):
                self.assertIsNone(fetch_control_status("https://controller.invalid/api/collector/status", "secret"))
                self.assertTrue(response.closed)

    def test_backoff_is_bounded_without_retry_header(self):
        self.assertEqual(retry_delay(0), 5)
        self.assertEqual(retry_delay(100), 900)
        self.assertEqual(retry_delay(3, "1200"), 1200)
        self.assertEqual(retry_delay(3, "bad"), 40)


if __name__ == "__main__":
    unittest.main()
