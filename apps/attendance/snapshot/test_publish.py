"""Offline stdlib tests. Run explicitly with unittest; never contacts LAN/cloud."""
import argparse
import base64
from copy import deepcopy
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zlib

spec = importlib.util.spec_from_file_location("attendance_snapshot_publish", Path(__file__).with_name("publish.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)

ACCOUNT = "a" * 32
NAMESPACE = "b" * 32
TOKEN = "machine-secret-do-not-disclose-1234567890"
AT = 1_800_000_000_000


def png(width=1, height=1):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress((b"\0" + b"\xff" * width) * height)) + chunk(b"IEND", b""))


def source_bodies():
    return {
        "/api/state": {"now": AT, "members": [{"name": "실제 회원", "present": True, "since": AT - 600_000,
                         "todayMs": 600_000, "weekMs": 1_200_000, "unrecordedWeek": 2,
                         "firstInToday": AT - 600_000, "lastCheckOut": None}], "unknownCards": [],
                       "recent": [{"name": "실제 회원", "checkIn": AT - 600_000, "checkOut": None, "unrecorded": False}]},
        "/api/monitor": {"observedAt": AT - 10_000, "nodes": [{"id": identity, "label": identity,
                         "collectedAt": AT - 12_000, "cpuPercent": 23.75, "memoryUsedBytes": 123456,
                         "memoryTotalBytes": 654321, "health": "up"} for identity in ("prod", "stage", "db")]},
        "/api/koin-health": {"observedAt": AT - 2000, "services": [{"id": identity, "label": identity,
                            "checkedAt": AT - 2500, "status": "up", "reason": "ready", "httpStatus": 200}
                            for identity in ("prod-api", "stage-api")]},
        "/api/worker-health": {"checkedAt": AT - 5000, "workers": [{"id": "koin-web", "label": "WEB",
                              "status": "unknown", "httpStatus": 403, "reason": "restricted"}]},
        "/api/spotify": {"state": "playing", "title": "Real track", "artists": ["Real artist"],
                         "updatedAt": AT - 7000, "coverUrl": "https://i.scdn.co/image/0123abc"},
        "/api/jam": {"available": False},
    }


class FakeLAN:
    def __init__(self):
        self.bodies = source_bodies()
        self.overrides = {}
        self.calls = []

    def __call__(self, path):
        self.calls.append(path)
        if path in self.overrides:
            override = self.overrides[path]
            if isinstance(override, Exception):
                raise override
            return override
        if path in self.bodies:
            return 200, "application/json", publisher.encode_json(self.bodies[path])
        if path in publisher.ASSET_PATHS:
            return 200, "image/png", png()
        raise AssertionError("unexpected LAN endpoint")


def arguments(directory):
    return argparse.Namespace(account_id=ACCOUNT, namespace_id=NAMESPACE, token_env="SNAPSHOT_TEST_TOKEN",
                              token_file=None, operator_wrangler_auth_file=None,
                              checkpoint_dir=str(directory), interval=180)


def make_private(path, directory=False):
    if os.name == "nt":
        publisher.windows_security(path, apply=True)
    else:
        path.chmod(0o700 if directory else 0o600)


class SnapshotTests(unittest.TestCase):
    def test_actual_data_and_timestamps_are_not_mutated(self):
        lan = FakeLAN()
        original = deepcopy(lan.bodies)
        snapshot, raw = publisher.collect_snapshot(lan, lambda: AT + 8000)
        self.assertEqual(lan.bodies, original)
        self.assertEqual(snapshot["observedAt"], AT)
        self.assertEqual(snapshot["publishedAt"], AT + 8000)
        for path in publisher.JSON_PATHS:
            self.assertEqual(snapshot["payloads"][path], {"status": 200, "body": original[path]})
        self.assertEqual(json.loads(raw), snapshot)
        self.assertEqual(base64.b64decode(snapshot["assets"]["/api/wifi-qr/5"]), png())
        self.assertNotIn("/api/jam-qr", snapshot["assets"])
        self.assertNotIn("/api/jam-qr", lan.calls)
        self.assertEqual(set(lan.calls), set(publisher.JSON_PATHS + publisher.WIFI_PATHS))

    def test_core_invalid_or_unavailable_aborts(self):
        cases = [(503, "text/html", b"secret"), (200, "text/html", b"secret"),
                 (200, "application/json", b'{"now":1,"now":2}'),
                 (200, "application/json", b'{"now":NaN}'),
                 (200, "application/json", b"[]"), (200, "application/json", b"\xff")]
        for response in cases:
            with self.subTest(response=response[:2]):
                lan = FakeLAN()
                lan.overrides["/api/state"] = response
                with self.assertRaises(publisher.PublisherError):
                    publisher.collect_snapshot(lan, lambda: AT)
        for field in ("studentNumber", "queue", "deviceToken", "greeting"):
            lan = FakeLAN()
            lan.bodies["/api/state"][field] = "do-not-publish"
            with self.assertRaises(publisher.PublisherError):
                publisher.collect_snapshot(lan, lambda: AT)

    def test_optional_error_status_preserved_but_secret_body_discarded(self):
        lan = FakeLAN()
        lan.overrides["/api/monitor"] = (401, "application/json", b'{"token":"do-not-publish"}')
        lan.overrides["/api/koin-health"] = (503, "text/html", b"private diagnostics")
        lan.overrides["/api/spotify"] = (302, "text/plain", b"https://secret.example")
        lan.bodies["/api/worker-health"]["credentials"] = TOKEN
        snapshot, raw = publisher.collect_snapshot(lan, lambda: AT)
        self.assertEqual(snapshot["payloads"]["/api/monitor"]["status"], 401)
        self.assertEqual(snapshot["payloads"]["/api/koin-health"]["status"], 503)
        self.assertEqual(snapshot["payloads"]["/api/spotify"]["status"], 502)
        self.assertEqual(snapshot["payloads"]["/api/worker-health"]["status"], 502)
        for secret in ("do-not-publish", "private diagnostics", "secret.example", TOKEN):
            self.assertNotIn(secret.encode(), raw)

    def test_optional_malformed_json_or_untrusted_cover_is_unavailable(self):
        for body in (b"{", b'{"state":"playing","state":"idle"}', b'{"state":Infinity}'):
            lan = FakeLAN()
            lan.overrides["/api/spotify"] = (200, "application/json", body)
            snapshot, _ = publisher.collect_snapshot(lan, lambda: AT)
            self.assertEqual(snapshot["payloads"]["/api/spotify"]["status"], 502)
        for cover in ("http://i.scdn.co/image/abc", "https://i.scdn.co.evil/image/a", "https://user:password@i.scdn.co/image/a",
                      "https://i.scdn.co/image/a?token=secret", "https://192.168.1.112/camera"):
            lan = FakeLAN()
            lan.bodies["/api/spotify"]["coverUrl"] = cover
            snapshot, raw = publisher.collect_snapshot(lan, lambda: AT)
            self.assertEqual(snapshot["payloads"]["/api/spotify"]["status"], 502)
            self.assertNotIn(cover.encode(), raw)

    def test_wifi_absence_aborts_and_jam_is_never_invented(self):
        for response in ((503, "application/json", b"{}"), (200, "image/png", b"fake PNG")):
            lan = FakeLAN()
            lan.overrides["/api/wifi-qr/2.4"] = response
            with self.assertRaises(publisher.PublisherError):
                publisher.collect_snapshot(lan, lambda: AT)
        lan = FakeLAN()
        lan.bodies["/api/jam"]["available"] = True
        snapshot, _ = publisher.collect_snapshot(lan, lambda: AT)
        self.assertIn("/api/jam-qr", snapshot["assets"])
        lan.overrides["/api/jam-qr"] = (404, "application/json", b"{}")
        snapshot, _ = publisher.collect_snapshot(lan, lambda: AT)
        self.assertNotIn("/api/jam-qr", snapshot["assets"])
        self.assertEqual(snapshot["payloads"]["/api/jam"]["status"], 502)

    def test_png_bounds_crc_dimensions_and_stream(self):
        self.assertTrue(publisher.valid_png(png()))
        corrupt = bytearray(png())
        corrupt[-1] ^= 1
        for value in (b"", b"\x89PNG\r\n\x1a\n", png() + b"trailing", bytes(corrupt),
                      png(width=2049), png() + b"x" * publisher.MAX_PNG):
            with self.subTest(length=len(value)):
                self.assertFalse(publisher.valid_png(value))
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        header = png()[:33]
        for decompressed in (b"\x05\0", b"\0" * 1_000_000):
            value = header + chunk(b"IDAT", zlib.compress(decompressed)) + chunk(b"IEND", b"")
            self.assertFalse(publisher.valid_png(value))

    def test_snapshot_size_and_observation_guards(self):
        lan = FakeLAN()
        lan.bodies["/api/state"]["members"] *= 20_000
        with self.assertRaisesRegex(publisher.PublisherError, "2 MiB"):
            publisher.collect_snapshot(lan, lambda: AT)
        for current in (AT - 1, AT + 60_001):
            with self.assertRaises(publisher.PublisherError):
                publisher.collect_snapshot(FakeLAN(), lambda: current)


class HTTPTests(unittest.TestCase):
    def test_fixed_targets_and_no_arbitrary_url_arguments(self):
        for path in ("/api/camera", "/api/state?url=https://evil.example", "http://evil.example/", "//evil.example", "/api/queue"):
            with patch.object(publisher.http.client, "HTTPConnection") as connection:
                with self.assertRaises(publisher.PublisherError):
                    publisher.fetch_lan(path)
                connection.assert_not_called()
        for account, namespace in (("../evil", NAMESPACE), (ACCOUNT, "x" * 32), ("https://evil.example", NAMESPACE)):
            with patch.object(publisher.http.client, "HTTPSConnection") as connection:
                with self.assertRaises(publisher.PublisherError):
                    publisher.put_snapshot(account, namespace, TOKEN, b"{}")
                connection.assert_not_called()

    def test_lan_never_reads_errors_or_follows_redirects_or_sends_credentials(self):
        with patch.object(publisher.http.client, "HTTPConnection") as connection:
            response = connection.return_value.getresponse.return_value
            response.status = 302
            response.getheader.return_value = "text/html"
            result = publisher.fetch_lan("/api/state")
            self.assertEqual(result, (302, "text/html", b""))
            response.read.assert_not_called()
            connection.assert_called_once_with("192.168.1.112", 8080, timeout=12)
            request = connection.return_value.request.call_args
            self.assertEqual(request.args, ("GET", "/api/state"))
            self.assertNotIn("Authorization", request.kwargs["headers"])
            self.assertNotIn("Cookie", request.kwargs["headers"])

    def test_https_put_is_single_fixed_nonexpiring_value(self):
        with patch.object(publisher.http.client, "HTTPSConnection") as connection:
            response = connection.return_value.getresponse.return_value
            response.status = 200
            response.read.return_value = b'{"success":true}'
            publisher.put_snapshot(ACCOUNT, NAMESPACE, TOKEN, b"{}")
            self.assertEqual(connection.call_args.args, ("api.cloudflare.com", 443))
            request = connection.return_value.request.call_args
            self.assertEqual(request.args, ("PUT", f"/client/v4/accounts/{ACCOUNT}/storage/kv/namespaces/{NAMESPACE}/values/clubroom:view:v1"))
            self.assertEqual(request.kwargs["body"], b"{}")
            self.assertEqual(request.kwargs["headers"]["Authorization"], "Bearer " + TOKEN)
            self.assertNotIn("?", request.args[1])
            self.assertEqual(connection.return_value.request.call_count, 1)

    def test_cloud_error_body_never_read_or_leaked(self):
        for status in (301, 302, 401, 429, 500):
            with patch.object(publisher.http.client, "HTTPSConnection") as connection:
                response = connection.return_value.getresponse.return_value
                response.status = status
                response.read.side_effect = AssertionError("error body must not be read")
                with self.assertRaises(publisher.PublisherError) as error:
                    publisher.put_snapshot(ACCOUNT, NAMESPACE, TOKEN, b"{}")
                self.assertNotIn(TOKEN, str(error.exception))
                self.assertEqual(connection.return_value.request.call_count, 1)
        for body in (b'{"success":false,"errors":["secret"]}', b"not-json", b"x" * (publisher.MAX_REPLY + 1)):
            with patch.object(publisher.http.client, "HTTPSConnection") as connection:
                response = connection.return_value.getresponse.return_value
                response.status, response.read.return_value = 200, body
                with self.assertRaises(publisher.PublisherError) as error:
                    publisher.put_snapshot(ACCOUNT, NAMESPACE, TOKEN, b"{}")
                self.assertNotIn("secret", str(error.exception))


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        make_private(self.directory, directory=True)
        self.args = arguments(self.directory)

    def tearDown(self):
        self.temporary.cleanup()

    def credential_file(self, content):
        path = self.directory / "credential"
        path.write_text(content, encoding="utf-8")
        make_private(path)
        return path

    def test_machine_environment_is_explicit_and_private_file_supported(self):
        with patch.dict(os.environ, {"SNAPSHOT_TEST_TOKEN": TOKEN}, clear=True):
            self.assertEqual(publisher.read_credential(self.args), TOKEN)
        self.args.token_env = None
        self.args.token_file = str(self.credential_file(TOKEN + "\n"))
        self.assertEqual(publisher.read_credential(self.args), TOKEN)

    def test_missing_invalid_or_public_credentials_fail_closed_without_leak(self):
        for value in ("", "short", TOKEN + "\r\nInjected: header", "Bearer " + TOKEN):
            with patch.dict(os.environ, {"SNAPSHOT_TEST_TOKEN": value}, clear=True):
                with self.assertRaises(publisher.PublisherError) as error:
                    publisher.read_credential(self.args)
                self.assertNotIn(TOKEN, str(error.exception))
        if os.name != "nt":
            path = self.credential_file(TOKEN)
            path.chmod(0o644)
            self.args.token_env, self.args.token_file = None, str(path)
            with self.assertRaises(publisher.PublisherError):
                publisher.read_credential(self.args)

    def test_operator_oauth_is_explicit_private_expiry_checked_mode(self):
        self.args.token_env = None
        future = datetime.fromtimestamp((AT + 120_000) / 1000, timezone.utc).isoformat()
        path = self.credential_file(f'oauth_token = "{TOKEN}"\nexpiration_time = "{future}"\n')
        self.args.operator_wrangler_auth_file = str(path)
        self.assertEqual(publisher.read_credential(self.args, lambda: AT), TOKEN)
        with self.assertRaises(publisher.PublisherError):
            publisher.read_credential(self.args, lambda: AT + 120_000)
        path.write_text(f'oauth_token = "{TOKEN}"\nexpiration_time = "bad-expiry"\n', encoding="utf-8")
        with self.assertRaises(publisher.PublisherError) as error:
            publisher.read_credential(self.args, lambda: AT)
        self.assertNotIn(TOKEN, str(error.exception))

    def test_default_plan_performs_no_network_credential_or_checkpoint_io(self):
        output = io.StringIO()
        with patch.object(publisher, "read_credential", side_effect=AssertionError("credential I/O")), \
                patch.object(publisher, "publish_once", side_effect=AssertionError("publish I/O")), \
                redirect_stdout(output):
            self.assertEqual(publisher.main([]), 0)
        self.assertEqual(json.loads(output.getvalue())["mode"], "plan")

    def test_cli_error_does_not_print_secret_or_raw_exception(self):
        args = ["--once", "--account-id", ACCOUNT, "--namespace-id", NAMESPACE, "--token-env", "SNAPSHOT_TEST_TOKEN",
                "--checkpoint-dir", str(self.directory)]
        stderr, stdout = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {"SNAPSHOT_TEST_TOKEN": TOKEN + "\nleak"}, clear=True), \
                redirect_stderr(stderr), redirect_stdout(stdout), \
                patch.object(publisher, "fetch_lan", side_effect=AssertionError("network must not be contacted")):
            self.assertEqual(publisher.main(args), 1)
        self.assertNotIn(TOKEN, stderr.getvalue() + stdout.getvalue())
        with patch.object(publisher, "publish_once", side_effect=OSError(TOKEN)), \
                redirect_stderr(stderr), redirect_stdout(stdout):
            self.assertEqual(publisher.main(args), 1)
        self.assertNotIn(TOKEN, stderr.getvalue() + stdout.getvalue())


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        make_private(self.directory, directory=True)
        self.args = arguments(self.directory)
        self.target = publisher.destination(ACCOUNT, NAMESPACE)
        self.identity = hashlib.sha256(self.target.encode("ascii")).hexdigest()
        self.checkpoint = self.directory / (self.identity + ".json")
        self.environment = patch.dict(os.environ, {"SNAPSHOT_TEST_TOKEN": TOKEN})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def load(self, at=AT):
        return publisher.load_checkpoint(self.checkpoint, self.target, at)

    def test_restart_keeps_counts_and_cadence_per_destination(self):
        uploads = []
        publisher.publish_once(self.args, FakeLAN(), lambda *args: uploads.append(args), lambda: AT)
        self.assertEqual(self.load()["attempts"], 1)
        self.assertEqual(self.load()["lastPublishedAt"], AT)
        with self.assertRaisesRegex(publisher.PublisherError, "cadence"):
            publisher.publish_once(self.args, FakeLAN(), lambda *args: uploads.append(args), lambda: AT + 1000)
        self.assertEqual(len(uploads), 1)
        lan = FakeLAN()
        lan.bodies["/api/state"]["now"] = AT + 180_000
        publisher.publish_once(self.args, lan, lambda *args: uploads.append(args), lambda: AT + 180_000)
        self.assertEqual(self.load(AT + 180_000)["attempts"], 2)
        other = deepcopy(self.args)
        other.namespace_id = "c" * 32
        publisher.publish_once(other, FakeLAN(), lambda *args: None, lambda: AT)
        self.assertEqual(self.load(AT + 180_000)["attempts"], 2)
        self.assertEqual(len(list(self.directory.glob("*.json"))), 2)

    def test_utc_day_budget_guard_and_clock_rollback(self):
        midnight = int(datetime(2026, 11, 13, tzinfo=timezone.utc).timestamp() * 1000)
        value = publisher.load_checkpoint(self.checkpoint, self.target, midnight - 180_000)
        value.update(attempts=600, lastAttemptAt=midnight - 180_000)
        publisher.atomic_checkpoint(self.checkpoint, value)
        with self.assertRaisesRegex(publisher.PublisherError, "budget"):
            publisher.reserve_checkpoint(self.load(midnight - 1), midnight - 1, 180)
        reset = self.load(midnight)
        self.assertEqual(reset["attempts"], 0)
        reserved = publisher.reserve_checkpoint(reset, midnight, 180)
        self.assertEqual(reserved["attempts"], 1)
        publisher.atomic_checkpoint(self.checkpoint, reserved)
        with self.assertRaisesRegex(publisher.PublisherError, "backwards"):
            self.load(midnight - 1)

    def test_failed_cloud_write_preserves_success_checkpoint_but_consumes_attempt(self):
        publisher.publish_once(self.args, FakeLAN(), lambda *args: None, lambda: AT)
        later = AT + 180_000
        lan = FakeLAN()
        lan.bodies["/api/state"]["now"] = later
        def fail(*args):
            raise publisher.PublisherError("Cloudflare KV write unavailable or unconfirmed")
        with self.assertRaises(publisher.PublisherError):
            publisher.publish_once(self.args, lan, fail, lambda: later)
        checkpoint = self.load(later)
        self.assertEqual(checkpoint["attempts"], 2)
        self.assertEqual(checkpoint["lastAttemptAt"], later)
        self.assertEqual(checkpoint["lastPublishedAt"], AT)

    def test_failed_reservation_stops_before_cloud_write(self):
        put = unittest.mock.Mock()
        with patch.object(publisher, "atomic_checkpoint", side_effect=publisher.PublisherError("atomic checkpoint failed")):
            with self.assertRaises(publisher.PublisherError):
                publisher.publish_once(self.args, FakeLAN(), put, lambda: AT)
        put.assert_not_called()
        self.assertFalse(self.checkpoint.exists())

    def test_corrupt_or_cross_destination_checkpoint_never_resets_budget(self):
        for raw in (b"{}", b"not-json", b'{"version":1,"version":1}', b'{"attempts":NaN}'):
            self.checkpoint.write_bytes(raw)
            make_private(self.checkpoint)
            with self.assertRaises(publisher.PublisherError):
                self.load()
        value = {"version": 1, "destination": self.target + "evil", "day": publisher.utc_day(AT), "attempts": 10,
                 "lastAttemptAt": AT, "lastPublishedAt": AT}
        publisher.atomic_checkpoint(self.checkpoint, value)
        with self.assertRaises(publisher.PublisherError):
            self.load()

    def test_invalid_checkpoint_dates_and_reservations_fail_closed(self):
        valid = {"version": 1, "destination": self.target, "day": publisher.utc_day(AT), "attempts": 1,
                 "lastAttemptAt": AT, "lastPublishedAt": AT}
        for change in ({"day": "2026-99-99"}, {"lastAttemptAt": None}, {"lastPublishedAt": AT + 1},
                       {"day": "2020-01-01"}, {"attempts": True}):
            publisher.atomic_checkpoint(self.checkpoint, {**valid, **change})
            with self.assertRaises(publisher.PublisherError):
                self.load()

    def test_atomic_replace_failure_keeps_existing_checkpoint_and_removes_temporary(self):
        value = publisher.load_checkpoint(self.checkpoint, self.target, AT)
        publisher.atomic_checkpoint(self.checkpoint, value)
        before = self.checkpoint.read_bytes()
        with patch.object(publisher.os, "replace", side_effect=OSError("sensitive local detail")):
            with self.assertRaisesRegex(publisher.PublisherError, "checkpoint failed"):
                publisher.atomic_checkpoint(self.checkpoint, {**value, "attempts": 1})
        self.assertEqual(self.checkpoint.read_bytes(), before)
        self.assertEqual(list(self.directory.glob(".snapshot-*")), [])

    def test_invalid_attendance_does_not_reserve_or_write(self):
        lan = FakeLAN()
        lan.overrides["/api/state"] = (503, "application/json", b"{}")
        put = unittest.mock.Mock()
        with self.assertRaises(publisher.PublisherError):
            publisher.publish_once(self.args, lan, put, lambda: AT)
        put.assert_not_called()
        self.assertFalse(self.checkpoint.exists())

    def test_lock_excludes_second_publisher(self):
        with publisher.destination_lock(self.directory, self.identity):
            with self.assertRaises(publisher.PublisherError):
                with publisher.destination_lock(self.directory, self.identity):
                    self.fail("second publisher acquired lock")


if __name__ == "__main__":
    unittest.main()
