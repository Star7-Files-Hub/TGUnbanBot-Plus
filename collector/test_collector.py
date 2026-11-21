"""Pure stdlib tests with synthetic Telegram and HTTP clients; never contact a service."""
import asyncio
import contextlib
from io import StringIO
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
from urllib import error

from collector import (
    Config, ConfigError, Dispatcher, MAX_SPOOL, Scanner, Spool, SpoolFull,
    TARGET_CHAT_ID, TargetUnavailableError, UnauthorizedError,
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

    def test_missing_bad_or_excessive_config_is_rejected_without_leaks(self):
        for key, value in [("TG_API_ID", ""), ("TG_API_HASH", "bad"),
                           ("COLLECTOR_PER_MINUTE", "21"), ("COLLECTOR_MAX_SPOOL", "1001"),
                           ("COLLECTOR_HISTORY_LIMIT", "101"), ("OBSERVE_INGEST_TOKEN", "")]:
            env = environment(Path("/tmp/private-collector"))
            env[key] = value
            with self.subTest(key=key), self.assertRaises(ConfigError):
                Config(env)

    def test_endpoint_no_cleartext_embedded_credentials_redirect_target_or_query(self):
        for url in ["http://receiver.invalid/api/observe/ingest",
                    "https://x:password@receiver.invalid/api/observe/ingest",
                    "https://receiver.invalid/other", "https://receiver.invalid/api/observe/ingest?key=bad"]:
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


class HttpTests(unittest.TestCase):
    def test_post_bearer_timeout20_and_does_not_read_response(self):
        class Response:
            status = 200
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self): raise AssertionError("response not needed")
        class Opener:
            def open(self, req, timeout):
                self.req, self.timeout = req, timeout
                return Response()
        opener = Opener()
        with patch("collector.request.build_opener", return_value=opener):
            self.assertEqual(send_http("https://receiver.invalid/api/observe/ingest", "test-token", "{}"),
                             (True, "accepted", None))
        self.assertEqual(opener.timeout, 20)
        self.assertEqual(opener.req.method, "POST")
        self.assertEqual(opener.req.get_header("Authorization"), "Bearer test-token")

    def test_http_error_does_not_leak_body_or_url(self):
        class Opener:
            def open(self, *_args, **_kwargs):
                raise error.HTTPError("https://secret.invalid/token", 429, "private reply", {"Retry-After": "30"}, None)
        with patch("collector.request.build_opener", return_value=Opener()):
            self.assertEqual(send_http("https://receiver.invalid/api/observe/ingest", "secret", "private text"),
                             (False, "http_rate_limited", "30"))

    def test_backoff_is_bounded_without_retry_header(self):
        self.assertEqual(retry_delay(0), 5)
        self.assertEqual(retry_delay(100), 900)
        self.assertEqual(retry_delay(3, "1200"), 1200)
        self.assertEqual(retry_delay(3, "bad"), 40)


if __name__ == "__main__":
    unittest.main()
