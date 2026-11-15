import os
from copy import deepcopy
import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import http.client
import hmac
from email.message import Message
import io
from pathlib import Path
import tempfile
import sqlite3
import ssl
import stat
import threading
import unittest
from unittest.mock import Mock, patch
import zlib

from server import (Attendance, AttendanceServer, DAY, ForwardedHTTPSConnection, Handler,
                    MAX_GUEST_TAPS, MAX_KOIN_BODY, MAX_MONITOR_BODY, MAX_SESSION,
                    KOIN_TIMEOUT, MAX_QR_PNG_BODY, MONITOR_PATH, WORKER_TIMEOUT, day_start)


class JamQrTests(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.directory = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        self.directory.chmod(0o700)
        self.path = self.directory / "jam.png"
        self.real_lstat = Path.lstat
        self.real_fstat = os.fstat
        # Emulate the operator's root-owned configuration on unprivileged test hosts.
        def root_lstat(path, *args, **kwargs):
            return self.root_metadata(self.real_lstat(path, *args, **kwargs))
        stack.enter_context(patch.object(Path, "lstat", root_lstat))
        stack.enter_context(patch("server.os.fstat", side_effect=lambda fd: self.root_metadata(self.real_fstat(fd))))
        self.network = stack.enter_context(patch("server.socket.create_connection",
                                                side_effect=AssertionError("Jam QR must remain local")))
        self.app = Attendance.__new__(Attendance)
        self.app.db_lock = self.app.events = None
        self.app.jam_qr = None

    @staticmethod
    def replace_metadata(metadata, **fields):
        values = list(metadata)
        for field, value in fields.items():
            values[{"st_mode": 0, "st_ino": 1, "st_nlink": 3, "st_uid": 4, "st_size": 6}[field]] = value
        return os.stat_result(values)

    def root_metadata(self, metadata):
        mode = metadata.st_mode & ~0o022 if os.name == "nt" else metadata.st_mode
        return self.replace_metadata(metadata, st_uid=0, st_mode=mode)

    @staticmethod
    def chunk(kind, data=b""):
        return len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")

    @classmethod
    def png(cls, width=128, height=128, pixels=None):
        header = width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes((1, 0, 0, 0, 0))
        rows = (b"\x00" + b"\xff" * ((width + 7) // 8)) * height if pixels is None else pixels
        return (b"\x89PNG\r\n\x1a\n" + cls.chunk(b"IHDR", header)
                + cls.chunk(b"IDAT", zlib.compress(rows)) + cls.chunk(b"IEND"))

    def publish(self, raw=None):
        self.path.write_bytes(self.png() if raw is None else raw)
        self.path.chmod(0o644)

    def request(self, path, peer="192.168.1.40", host="192.168.1.92:8080", origin=None):
        handler = Handler.__new__(Handler)
        handler.client_address = (peer, 12345)
        handler.path = path
        handler.headers = Message()
        handler.headers["Host"] = host
        if origin is not None:
            handler.headers["Origin"] = origin
        handler.server = Mock(app=self.app)
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = io.BytesIO()
        handler.do_GET()
        headers = dict(call.args for call in handler.send_header.call_args_list)
        body = handler.wfile.getvalue()
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(int(headers["Content-Length"]), len(body))
        return handler.send_response.call_args.args[0], headers, body

    def test_missing_configuration_is_unavailable_without_an_image_placeholder(self):
        self.assertIsNone(Attendance.read_qr_png(self.path))
        status, headers, body = self.request("/api/jam")
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("application/json"))
        self.assertEqual(json.loads(body), {"available": False})
        status, headers, body = self.request("/api/jam-qr")
        self.assertEqual(status, 404)
        self.assertTrue(headers["Content-Type"].startswith("application/json"))
        self.assertEqual(json.loads(body), {"error": "jam_qr_unavailable"})
        self.network.assert_not_called()

    def test_configured_png_is_served_unchanged_without_invite_or_account_metadata(self):
        self.publish()
        self.app.jam_qr = Attendance.read_qr_png(self.path)
        self.assertEqual(self.app.jam_qr, self.png())
        status, _headers, body = self.request("/api/jam", origin="http://192.168.1.92:8080")
        self.assertEqual((status, json.loads(body)), (200, {"available": True}))
        status, headers, body = self.request("/api/jam-qr")
        self.assertEqual((status, headers["Content-Type"], body), (200, "image/png", self.png()))
        self.network.assert_not_called()

    def test_png_validation_rejects_malformed_truncated_and_expanding_images(self):
        valid = self.png()
        header = (128).to_bytes(4, "big") * 2 + bytes((1, 0, 0, 0, 0))
        for raw in (
                b"", b"not PNG", b"\x89PNG\r\n\x1a\n", valid[:-1], valid + b"trailing",
                valid[:20] + bytes((valid[20] ^ 1,)) + valid[21:],
                b"\x89PNG\r\n\x1a\n" + self.chunk(b"IDAT", b"data") + self.chunk(b"IEND"),
                valid[:33] + self.chunk(b"IHDR", header) + valid[33:],
                valid[:33] + self.chunk(b"FAIL") + valid[33:],
                valid[:33] + self.chunk(b"IDAT", b"not zlib") + self.chunk(b"IEND"),
                self.png(width=2049), self.png(pixels=b"\x00" * 1_000_000),
                self.png(pixels=(b"\x05" + b"\xff" * 16) * 128),
                b"\x89PNG\r\n\x1a\n" + b"x" * MAX_QR_PNG_BODY):
            with self.subTest(length=len(raw), prefix=raw[:24]):
                self.publish(raw)
                self.assertIsNone(Attendance.read_qr_png(self.path))
        self.publish(valid)
        self.assertEqual(Attendance.read_qr_png(self.path), valid)

    def test_untrusted_file_metadata_is_not_served(self):
        self.publish()
        for fields in ({"st_uid": 12345}, {"st_mode": stat.S_IFREG | 0o666},
                       {"st_nlink": 2}, {"st_size": MAX_QR_PNG_BODY + 1},
                       {"st_ino": self.path.lstat().st_ino + 1},
                       {"st_mode": stat.S_IFIFO | 0o644}):
            with self.subTest(fields=fields), patch("server.os.fstat", side_effect=lambda fd:
                    self.replace_metadata(self.root_metadata(self.real_fstat(fd)), **fields)):
                self.assertIsNone(Attendance.read_qr_png(self.path))
        for fields in ({"st_uid": 12345}, {"st_mode": stat.S_IFDIR | 0o777},
                       {"st_mode": stat.S_IFLNK | 0o777}):
            def untrusted_parent(path, *args, **kwargs):
                metadata = self.root_metadata(self.real_lstat(path, *args, **kwargs))
                return self.replace_metadata(metadata, **fields) if path == self.directory else metadata
            with self.subTest(parent=fields), patch.object(Path, "lstat", untrusted_parent):
                self.assertIsNone(Attendance.read_qr_png(self.path))

    @unittest.skipIf(os.name == "nt", "POSIX symlink and FIFO semantics")
    def test_symlink_and_nonregular_sources_are_rejected(self):
        target = self.directory / "real.png"
        target.write_bytes(self.png())
        target.chmod(0o644)
        self.path.symlink_to(target)
        self.assertIsNone(Attendance.read_qr_png(self.path))
        self.path.unlink()
        os.mkfifo(self.path)
        self.assertIsNone(Attendance.read_qr_png(self.path))

    def test_lan_host_origin_guards_and_fixed_paths_apply_to_both_jam_routes(self):
        self.app.jam_qr = self.png()
        for path in ("/api/jam", "/api/jam-qr"):
            for peer, host, origin, expected in (
                    ("127.0.0.1", "127.0.0.1:8080", None, 200),
                    ("192.168.1.40", "192.168.1.92:8080", "http://192.168.1.92:8080", 200),
                    ("10.0.0.1", "192.168.1.92:8080", None, 403),
                    ("127.0.0.1", "attacker.example:8080", None, 403),
                    ("127.0.0.1", "127.0.0.1:8080", "https://attacker.example", 403)):
                with self.subTest(path=path, peer=peer, host=host, origin=origin):
                    self.assertEqual(self.request(path, peer, host, origin)[0], expected)
            for suffix in ("?url=https://attacker.example/invite", "?path=/etc/passwd", "/extra"):
                with self.subTest(path=path + suffix):
                    self.assertEqual(self.request(path + suffix)[0], 404)
        self.network.assert_not_called()

    def test_startup_loads_only_configured_local_png_and_restart_applies_changes(self):
        html = self.directory / "dashboard.html"
        html.write_text("<!doctype html><title>Test</title>", encoding="utf-8")
        environment = {
            "INTERNAL_LOOKUP_URL": "https://api.internal.bcsdlab.com/v1/service/attendance/member-lookup",
            "ATTENDANCE_HTML": str(html), "ATTENDANCE_DATA_DIR": str(self.directory / "data"),
            "JAM_QR_FILE": str(self.path),
        }
        with patch.dict(os.environ, environment, clear=True), patch.object(
                Attendance, "read_token", return_value="synthetic_test_token_" * 3):
            first = Attendance()
            self.addCleanup(first.close)
            self.assertIsNone(first.jam_qr)
            self.publish()
            self.assertIsNone(first.jam_qr)
            second = Attendance()
            self.addCleanup(second.close)
            self.app = second
            self.assertEqual(self.request("/api/jam")[2], b'{"available": true}')
            self.assertEqual(self.request("/api/jam-qr")[2], self.png())
        self.network.assert_not_called()


class SpotifyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.directory.chmod(0o700)
        self.app = Attendance.__new__(Attendance)
        self.app.spotify_path = self.directory / "now-playing.json"
        self.app.db_lock = None
        self.payload = {"state": "playing", "title": "노래", "artists": ["가수"], "updatedAt": 1234,
                        "coverUrl": "https://i.scdn.co/image/small"}

    def publish(self, payload=None):
        self.app.spotify_path.write_text(json.dumps(self.payload if payload is None else payload), encoding="utf-8")
        self.app.spotify_path.chmod(0o644)

    def test_missing_file_is_idle_and_valid_metadata_preserves_unicode(self):
        self.assertEqual(self.app.spotify(), {"state": "idle", "title": "", "artists": [], "updatedAt": None, "coverUrl": None})
        self.publish()
        self.assertEqual(self.app.spotify(), self.payload)
        for state in ("paused", "loading", "unknown"):
            self.payload["state"] = state
            self.publish()
            self.assertEqual(self.app.spotify(), self.payload)
        for state in ("idle", "error"):
            self.publish({**self.payload, "state": state, "title": "", "artists": [], "coverUrl": None})
            self.assertEqual(self.app.spotify()["state"], state)

    def test_cover_is_nullable_and_only_public_spotify_cdn_is_allowed(self):
        for cover in (None, "https://i.scdn.co/image/ab123", "https://i.scdn.co:443/image/ab123"):
            with self.subTest(cover=cover):
                self.publish({**self.payload, "coverUrl": cover})
                self.assertEqual(self.app.spotify()["coverUrl"], cover)
        for cover in [
                12, [], "http://i.scdn.co/image/a", "https://attacker.example/image/a",
                "https://i.scdn.co.attacker.example/image/a", "https://user:pass@i.scdn.co/image/a",
                "https://i.scdn.co:444/image/a", "https://i.scdn.co/image/a?private=1",
                "https://i.scdn.co/image/a#", "https://i.scdn.co/image/a?",
                "https://i.scdn.co/image/../a", "https://i.scdn.co/image/%61",
                "https://i.scdn.co/image/a/b", "https://i.scdn.co/image/a\n",
                "https://i.scdn.co/image/" + "x" * 513]:
            with self.subTest(cover=cover):
                self.publish({**self.payload, "coverUrl": cover})
                self.assertEqual(self.app.spotify(), {
                    "state": "unknown", "title": "", "artists": [], "updatedAt": None, "coverUrl": None})
        self.publish({**self.payload, "updatedAt": None})
        self.assertEqual(self.app.spotify()["updatedAt"], None)

    def test_bad_oversized_and_private_payloads_are_unknown(self):
        bad = [
            b"not json", b" " * 8193,
            json.dumps({**self.payload, "title": "x" * 257}).encode(),
            json.dumps({**self.payload, "artists": ["a"] * 9}).encode(),
            json.dumps({**self.payload, "title": "bad\u0000title"}).encode(),
            json.dumps({**self.payload, "title": "bad\u202etitle"}).encode(),
            json.dumps({**self.payload, "updatedAt": True}).encode(),
            json.dumps({**self.payload, "state": "playing", "title": ""}).encode(),
            json.dumps({**self.payload, "trackId": "private"}).encode(),
            json.dumps({key: value for key, value in self.payload.items() if key != "coverUrl"}).encode(),
            json.dumps({**self.payload, "state": "idle", "title": "", "artists": []}).encode(),
            json.dumps({**self.payload, "state": "error"}).encode(),
            json.dumps(self.payload).replace('"coverUrl":', '"coverUrl":null,"coverUrl":').encode(),
            b'{"state":"playing","state":"idle","title":"","artists":[],"updatedAt":1}',
        ]
        for raw in bad:
            with self.subTest(raw=raw[:60]):
                self.app.spotify_path.write_bytes(raw)
                self.app.spotify_path.chmod(0o644)
                self.assertEqual(self.app.spotify(), {"state": "unknown", "title": "", "artists": [], "updatedAt": None, "coverUrl": None})

    @unittest.skipIf(os.name == "nt", "POSIX ownership, links and mode checks")
    def test_symlink_world_writable_and_untrusted_parent_are_unknown(self):
        target = self.directory / "other.json"
        target.write_text(json.dumps(self.payload), encoding="utf-8")
        self.app.spotify_path.symlink_to(target)
        self.assertEqual(self.app.spotify()["state"], "unknown")
        self.app.spotify_path.unlink()
        self.publish()
        self.app.spotify_path.chmod(0o666)
        self.assertEqual(self.app.spotify()["state"], "unknown")
        self.app.spotify_path.chmod(0o644)
        self.directory.chmod(0o777)
        self.assertEqual(self.app.spotify()["state"], "unknown")
        self.directory.chmod(0o700)


class RequestBoundaryTests(unittest.TestCase):
    def request(self, peer, host, method='GET', origin=None, token='Bearer synthetic', path=None):
        handler = Handler.__new__(Handler)
        handler.client_address = (peer, 12345)
        handler.path = path or ('/api/taps' if method == 'POST' else '/health')
        handler.headers = Message()
        handler.headers['Host'] = host
        if origin is not None:
            handler.headers['Origin'] = origin
        handler.headers['Authorization'] = token
        handler.headers['Content-Type'] = 'application/json'
        handler.headers['Content-Length'] = '2'
        handler.rfile = io.BytesIO(b'{}')
        handler.server = Mock()
        handler.server.app.device_token = 'synthetic'
        handler.server.app.tap.return_value = (200, {'status': 'check-in'})
        handler.send = Mock()
        handler.server.app.monitor.return_value = {'observedAt': 1, 'nodes': []}
        getattr(handler, 'do_' + method)()
        return handler

    def test_loopback_and_lan_reads(self):
        for peer, host in [('127.0.0.1', '127.0.0.1:8080'),
                           ('192.168.1.40', '192.168.1.92:8080')]:
            with self.subTest(peer=peer):
                handler = self.request(peer, host, origin='http://' + host)
                self.assertEqual(handler.send.call_args.args[0], 200)

    def test_taps_require_loopback_and_device_bearer(self):
        handler = self.request('127.0.0.1', '127.0.0.1:8080', 'POST')
        self.assertEqual(handler.send.call_args.args[0], 200)
        handler.server.app.tap.assert_called_once_with({})
        for peer, token, status in [('192.168.1.40', 'Bearer synthetic', 403),
                                    ('127.0.0.1', '', 401),
                                    ('127.0.0.1', 'Bearer wrong', 401)]:
            with self.subTest(peer=peer, token=token):
                handler = self.request(peer, '127.0.0.1:8080', 'POST', token=token)
                self.assertEqual(handler.send.call_args.args[0], status)
                handler.server.app.tap.assert_not_called()

    def test_non_lan_and_host_origin_forgery_are_forbidden(self):
        cases = [
            ('192.168.2.4', '192.168.1.92:8080', None),
            ('::1', '127.0.0.1:8080', None),
            ('192.168.1.40', 'attacker.example:8080', None),
            ('192.168.1.40', 'attacker@192.168.1.92:8080', None),
            ('192.168.1.40', '192.168.1.92:8080/path', None),
            ('192.168.1.40', '192.168.1.92:80', None),
            ('192.168.1.40', '0.0.0.0:8080', None),
            ('192.168.1.40', '192.168.1.92:8080', 'http://attacker.example:8080'),
            ('192.168.1.40', '192.168.1.92:8080', 'http://192.168.1.92:8080/path'),
        ]
        for peer, host, origin in cases:
            with self.subTest(peer=peer, host=host, origin=origin):
                handler = self.request(peer, host, origin=origin)
                self.assertEqual(handler.send.call_args.args[0], 403)

    def test_monitor_inherits_read_boundary_and_never_uses_request_destination(self):
        for peer, host, origin, status in [
                ('127.0.0.1', '127.0.0.1:8080', None, 200),
                ('192.168.1.40', '192.168.1.92:8080', 'http://192.168.1.92:8080', 200),
                ('192.168.2.40', '192.168.1.92:8080', None, 403),
                ('192.168.1.40', 'attacker.example:8080', None, 403),
                ('192.168.1.40', '192.168.1.92:8080', 'http://attacker.example', 403)]:
            with self.subTest(peer=peer, host=host, origin=origin):
                handler = self.request(peer, host, origin=origin, path='/api/monitor')
                self.assertEqual(handler.send.call_args.args[0], status)
                if status == 200:
                    handler.server.app.monitor.assert_called_once_with()
                else:
                    handler.server.app.monitor.assert_not_called()
        handler = self.request('127.0.0.1', '127.0.0.1:8080',
                               path='/api/monitor?url=https://attacker.example')
        self.assertEqual(handler.send.call_args.args[0], 404)
        handler.server.app.monitor.assert_not_called()

    def test_spotify_uses_existing_lan_host_and_origin_boundary(self):
        for peer, host, origin, status in [
            ("127.0.0.1", "127.0.0.1:8080", None, 200),
            ("192.168.1.20", "192.168.1.92:8080", "http://192.168.1.92:8080", 200),
            ("10.0.0.1", "192.168.1.92:8080", None, 403),
            ("127.0.0.1", "attacker.example:8080", None, 403),
            ("192.168.1.20", "192.168.1.92:8080", "http://attacker.example", 403),
        ]:
            with self.subTest(peer=peer, host=host, origin=origin):
                handler = self.request(peer, host, origin=origin, path="/api/spotify")
                self.assertEqual(handler.send.call_args.args[0], status)
                if status == 200:
                    handler.server.app.spotify.assert_called_once_with()
                else:
                    handler.server.app.spotify.assert_not_called()
        handler = self.request("127.0.0.1", "127.0.0.1:8080", path="/api/spotify?path=/etc/passwd")
        self.assertEqual(handler.send.call_args.args[0], 404)
        handler.server.app.spotify.assert_not_called()

    def test_monitor_unavailable_returns_503_without_sample_nodes(self):
        handler = self.request('127.0.0.1', '127.0.0.1:8080')
        handler.path = '/api/monitor'
        handler.server.app.monitor.return_value = None
        handler.do_GET()
        handler.send.assert_called_with(503, {'error': 'monitor_unavailable'})


class KoinHealthTests(unittest.TestCase):

    class ResponseSocket:
        def __init__(self, raw):
            self.buffer = io.BytesIO(raw)
            self.sent = bytearray()
            self.closed = False

        def makefile(self, _mode):
            return self.buffer

        def sendall(self, data):
            self.sent.extend(data)

        def setsockopt(self, *_args):
            pass

        def close(self):
            self.closed = True

    def setUp(self):
        # Exercise the real HTTP request/parser and collector without disk or network.
        self.app = Attendance.__new__(Attendance)
        self.app.context = ssl.create_default_context()
        self.app.db_lock = None  # Any attempt to use SQLite's lock fails rather than hanging a test.
        self.responses = {}
        self.sockets = {}
        self.tls_failures = {}
        self.barrier = None
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch('server.now_ms', return_value=1_760_000_000_000))
        self.dial = self.stack.enter_context(patch('server.socket.create_connection', side_effect=self.connect))
        self.stack.enter_context(patch.object(self.app.context, 'wrap_socket', side_effect=self.wrap_tls))

    @staticmethod
    def response(status=200, body=b'{"status":"UP"}', mime='application/vnd.spring-boot.actuator.v3+json'):
        location = 'Location: https://127.0.0.1/private\r\n' if status == 302 else ''
        return (f'HTTP/1.1 {status} Synthetic\r\nContent-Type: {mime}\r\n'
                f'{location}Content-Length: {len(body)}\r\nConnection: close\r\n\r\n').encode('ascii') + body

    def connect(self, address, timeout, source_address=None):
        host, port = address
        self.assertEqual(port, 443)
        self.assertEqual(timeout, KOIN_TIMEOUT)
        self.assertIsNone(source_address)
        if self.barrier is not None:
            self.barrier.wait(1)
        raw = self.responses.get(host, self.response())
        if isinstance(raw, BaseException):
            raise raw
        sock = self.ResponseSocket(raw)
        self.sockets[host] = sock
        return sock

    def wrap_tls(self, sock, server_hostname):
        self.assertTrue(self.app.context.check_hostname)
        self.assertEqual(self.app.context.verify_mode, ssl.CERT_REQUIRED)
        if server_hostname in self.tls_failures:
            raise self.tls_failures[server_hostname]
        self.assertIs(sock, self.sockets[server_hostname])
        return sock

    def collect(self):
        payload = self.app.koin_health()
        self.assertEqual(set(payload), {'observedAt', 'services'})
        self.assertEqual([service['id'] for service in payload['services']], ['prod-api', 'stage-api'])
        for service in payload['services']:
            self.assertEqual(set(service), {'id', 'label', 'checkedAt', 'status', 'reason', 'httpStatus'})
        return payload['services']

    def test_up_and_not_ready_are_independent_parallel_and_outside_sqlite_lock(self):
        self.responses['api.stage.koreatech.in'] = self.response(body=b'{"status":"OUT_OF_SERVICE"}')
        self.barrier = threading.Barrier(2)
        prod, stage = self.collect()
        self.assertEqual((prod['status'], prod['reason'], prod['httpStatus']), ('up', 'ready', 200))
        self.assertEqual((stage['status'], stage['reason'], stage['httpStatus']), ('down', 'not-ready', 200))
        self.assertEqual(set(self.sockets), {'api.koreatech.in', 'api.stage.koreatech.in'})
        for sock in self.sockets.values():
            self.assertTrue(sock.closed)
            request = bytes(sock.sent)
            self.assertNotIn(b'Authorization:', request)

    def test_http_errors_redirects_and_invalid_payloads_never_become_ready(self):
        for status, body, mime, expected in [
                (503, b'<html>private failure</html>', 'text/html', ('down', 'http')),
                (302, b'{"status":"UP"}', 'application/json', ('unknown', 'http')),
                (401, b'{"status":"UP"}', 'application/json', ('unknown', 'http')),
                (200, b'<html>UP</html>', 'text/html', ('unknown', 'invalid-response')),
                (200, b'not json', 'application/json', ('unknown', 'invalid-response')),
                (200, b'null', 'application/json', ('unknown', 'invalid-response')),
                (200, b'{"status":"UNKNOWN"}', 'application/json', ('unknown', 'invalid-response')),
                (200, b'{"status":"UP","status":"DOWN"}', 'application/json', ('unknown', 'invalid-response')),
                (200, b'{"status":"DOWN"}', 'application/json', ('down', 'not-ready')),
                (200, b' ' * (MAX_KOIN_BODY + 1) + b'{"status":"UP"}', 'application/json',
                 ('unknown', 'invalid-response'))]:
            with self.subTest(status=status, body=body[:40]):
                self.responses['api.koreatech.in'] = self.response(status, body, mime)
                prod, stage = self.collect()
                self.assertEqual((prod['status'], prod['reason']), expected)
                self.assertEqual(prod['httpStatus'], status)
                self.assertEqual(stage['status'], 'up')
                self.assertNotIn('private failure', json.dumps([prod, stage]))

    def test_tls_timeout_and_network_failure_are_unknown_without_poisoning_peer(self):
        for error, reason in [(ssl.SSLCertVerificationError('synthetic TLS failure'), 'tls'),
                              (TimeoutError('synthetic timeout'), 'timeout'),
                              (OSError('synthetic network failure'), 'unavailable')]:
            with self.subTest(reason=reason):
                self.responses.clear()
                self.tls_failures.clear()
                if reason == 'tls':
                    self.tls_failures['api.stage.koreatech.in'] = error
                else:
                    self.responses['api.stage.koreatech.in'] = error
                prod, stage = self.collect()
                self.assertEqual(prod['status'], 'up')
                self.assertEqual((stage['status'], stage['reason'], stage['httpStatus']),
                                 ('unknown', reason, None))

    def test_endpoint_preserves_read_boundary_and_has_no_request_selected_destination(self):
        for peer, host, origin, path, expected in [
                ('127.0.0.1', '127.0.0.1:8080', None, '/api/koin-health', 200),
                ('192.168.1.40', '192.168.1.92:8080', 'http://192.168.1.92:8080', '/api/koin-health', 200),
                ('10.0.0.1', '192.168.1.92:8080', None, '/api/koin-health', 403),
                ('127.0.0.1', 'attacker.example:8080', None, '/api/koin-health', 403),
                ('127.0.0.1', '127.0.0.1:8080', 'https://attacker.example', '/api/koin-health', 403),
                ('127.0.0.1', '127.0.0.1:8080', None, '/api/koin-health?url=https://attacker.example', 404)]:
            with self.subTest(peer=peer, host=host, path=path):
                before = self.dial.call_count
                handler = Handler.__new__(Handler)
                handler.client_address = (peer, 12345)
                handler.path = path
                handler.headers = Message()
                handler.headers['Host'] = host
                if origin is not None:
                    handler.headers['Origin'] = origin
                handler.headers['Authorization'] = 'Bearer must-not-forward'
                handler.server = Mock(app=self.app)
                handler.send = Mock()
                handler.do_GET()
                self.assertEqual(handler.send.call_args.args[0], expected)
                self.assertEqual(self.dial.call_count - before, 2 if expected == 200 else 0)
                if expected == 200:
                    self.assertEqual(len(handler.send.call_args.args[1]['services']), 2)
                    self.assertEqual(set(self.sockets), {'api.koreatech.in', 'api.stage.koreatech.in'})
                    for sock in self.sockets.values():
                        self.assertNotIn(b'Authorization:', sock.sent)


class WorkerHealthTests(unittest.TestCase):
    class ResponseSocket(KoinHealthTests.ResponseSocket):
        def __init__(self, owner, host, raw):
            super().__init__(b"")
            self.owner = owner
            self.host = host
            self.raw = raw

        def makefile(self, _mode):
            if self.owner.request_gate is not None:
                self.owner.request_started.set()
                self.owner.assertTrue(self.owner.request_gate.wait(2))
            raw = self.raw
            self.buffer.close()
            if isinstance(raw, BaseException):
                # Fail during parsing, not HTTPResponse initialization/GC cleanup.
                class FailureStream(io.BytesIO):
                    def readline(self, _size=-1):
                        raise raw
                self.buffer = FailureStream()
            else:
                class HeadersOnlyStream(io.BytesIO):
                    def read(self, _size=-1):
                        raise AssertionError("Worker availability must not buffer response bodies")
                self.buffer = HeadersOnlyStream(raw)
            return self.buffer

    def setUp(self):
        self.app = self.new_app()
        self.responses = {
            'koreatech.in': KoinHealthTests.response(200, b'<!doctype html><title>KOIN</title>', 'text/html'),
        }
        self.request_gate = None
        self.request_started = threading.Event()
        self.sockets = []
        self.tls_failures = {}
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.clock = stack.enter_context(patch('server.time.monotonic', return_value=10))
        self.now = stack.enter_context(patch('server.now_ms', return_value=1_800_000_000_000))
        self.dial = stack.enter_context(patch('server.socket.create_connection', side_effect=self.connect))
        self.tls = stack.enter_context(patch.object(self.app.context, 'wrap_socket', side_effect=self.wrap_tls))

    @staticmethod
    def new_app():
        app = Attendance.__new__(Attendance)
        app.context = ssl.create_default_context()
        app.worker_lock = threading.Lock()
        app.worker_cached = None
        app.worker_expires = 0
        app.db_lock = app.events = None  # Any attendance lock access must fail.
        app.lookup_token = 'private-lookup-token'
        app.device_token = 'private-device-token'
        app.monitor_token = 'private-monitor-token'
        return app


    def connect(self, address, timeout, source_address=None):
        host, port = address
        self.assertIn(host, self.responses)
        self.assertEqual(port, 443)
        self.assertEqual(timeout, WORKER_TIMEOUT)
        self.assertEqual(timeout, 3)
        self.assertIsNone(source_address)
        sock = self.ResponseSocket(self, host, self.responses[host])
        self.sockets.append((host, sock))
        return sock

    def wrap_tls(self, sock, server_hostname):
        self.assertTrue(self.app.context.check_hostname)
        self.assertEqual(self.app.context.verify_mode, ssl.CERT_REQUIRED)
        self.assertIn((server_hostname, sock), self.sockets)
        if server_hostname in self.tls_failures:
            raise self.tls_failures[server_hostname]
        return sock

    def collect(self):
        payload = self.app.worker_health()
        self.assertEqual(set(payload), {'checkedAt', 'workers'})
        self.assertIs(type(payload['checkedAt']), int)
        self.assertEqual(payload['checkedAt'], self.now.return_value)
        self.assertEqual([worker['id'] for worker in payload['workers']], ['koin-web'])
        for worker in payload['workers']:
            self.assertEqual(set(worker), {'id', 'label', 'status', 'httpStatus', 'reason'})
        return payload

    def expire(self):
        self.clock.return_value += 60
        self.now.return_value += 60_000

    def test_web_worker_reads_only_headers(self):
        web, = self.collect()['workers']
        self.assertEqual((web['status'], web['reason'], web['httpStatus']), ('up', 'http', 200))
        self.assertEqual(self.dial.call_count, 1)
        self.assertTrue(all(sock.closed and sock.buffer.closed for _host, sock in self.sockets))

    def test_http_success_failure_auth_challenge_redirect_and_other_errors_are_classified(self):
        for status, mime, expected in [
                (200, 'text/html', ('up', 'http')),
                (204, 'text/plain', ('up', 'http')),
                (299, 'text/plain', ('up', 'http')),
                (500, 'application/json', ('down', 'http')),
                (503, 'application/json', ('down', 'http')),
                (599, 'text/plain', ('down', 'http')),
                (301, 'text/html', ('unknown', 'redirect')),
                (302, 'text/html', ('unknown', 'redirect')),
                (307, 'text/html', ('unknown', 'redirect')),
                (401, 'application/json', ('unknown', 'restricted')),
                (403, 'text/html', ('unknown', 'restricted')),
                (404, 'text/html', ('unknown', 'http')),
                (429, 'text/html', ('unknown', 'http'))]:
            with self.subTest(status=status):
                self.responses['koreatech.in'] = KoinHealthTests.response(
                    status, b'<html>private challenge or error</html>', mime)
                self.expire()
                before = self.dial.call_count
                payload = self.collect()
                web, = payload['workers']
                self.assertEqual((web['status'], web['reason']), expected)
                self.assertEqual(web['httpStatus'], status)
                self.assertEqual(self.dial.call_count - before, 1)  # No redirect destinations.
                self.assertNotIn('private', json.dumps(payload))

    def test_tls_timeout_network_and_malformed_response_are_unknown(self):
        for raw, reason in [
                (ssl.SSLCertVerificationError('private TLS failure'), 'tls'),
                (TimeoutError('private timeout'), 'timeout'),
                (OSError('private network failure'), 'unavailable'),
                (b'not an HTTP response\r\n\r\n', 'unavailable'),
                (KoinHealthTests.response(600), 'unavailable')]:
            with self.subTest(reason=reason, raw=str(raw)[:40]):
                self.tls_failures.clear()
                if reason == 'tls':
                    self.tls_failures['koreatech.in'] = raw
                else:
                    self.responses['koreatech.in'] = raw
                self.expire()
                payload = self.collect()
                web, = payload['workers']
                self.assertEqual((web['status'], web['reason'], web['httpStatus']),
                                 ('unknown', reason, None))
                self.assertNotIn('private', json.dumps(payload))
        self.assertTrue(all(sock.closed for _host, sock in self.sockets))

    def test_cache_single_flights_and_replaces_expired_success_with_failure(self):
        gate = threading.Barrier(2)
        self.request_gate = threading.Event()

        def collect(_index):
            gate.wait(1)
            return self.app.worker_health()

        with ThreadPoolExecutor(max_workers=2) as executor:
            first_future = executor.submit(collect, 0)
            second_future = executor.submit(collect, 1)
            try:
                self.assertTrue(self.request_started.wait(2))
                self.assertEqual(self.dial.call_count, 1)
            finally:
                self.request_gate.set()
            first, second = first_future.result(), second_future.result()
        self.assertEqual(first, second)
        self.assertEqual([worker['status'] for worker in first['workers']], ['up'])
        self.assertEqual(self.dial.call_count, 1)
        self.responses['koreatech.in'] = TimeoutError('private failure')
        self.clock.return_value = 69.999
        self.assertEqual(self.app.worker_health(), first)
        self.assertEqual(self.dial.call_count, 1)
        self.clock.return_value = 70
        self.now.return_value += 60_000
        failed = self.collect()
        self.assertEqual([worker['status'] for worker in failed['workers']], ['unknown'])
        self.assertEqual(failed['workers'][0]['reason'], 'timeout')
        self.assertGreater(failed['checkedAt'], first['checkedAt'])
        self.assertEqual(self.dial.call_count, 2)
        failed['workers'][0]['status'] = 'up'
        failed['workers'].append({'id': 'mutation'})
        self.assertEqual(self.collect()['workers'][0]['status'], 'unknown')
        self.assertEqual(len(self.collect()['workers']), 1)
        self.assertEqual(self.dial.call_count, 2)
        self.expire()
        self.responses['koreatech.in'] = KoinHealthTests.response(200, b'<html>KOIN</html>', 'text/html')
        self.assertEqual(self.collect()['workers'][0]['status'], 'up')
        self.assertEqual(self.dial.call_count, 3)

    def test_cache_is_shared_by_consumers_but_not_between_app_instances(self):
        first = self.collect()
        other = self.new_app()
        self.responses['koreatech.in'] = KoinHealthTests.response(403, b'challenge', 'text/html')
        with patch.object(other.context, 'wrap_socket', side_effect=self.wrap_tls):
            self.assertEqual(other.worker_health()['workers'][0]['status'], 'unknown')
        self.assertEqual(self.app.worker_health(), first)
        self.assertEqual(self.dial.call_count, 2)

    def test_route_enforces_lan_boundary_fixed_targets_and_never_forwards_credentials(self):
        for peer, host, origin, path, expected in [
                ('127.0.0.1', '127.0.0.1:8080', None, '/api/worker-health', 200),
                ('192.168.1.40', '192.168.1.92:8080', 'http://192.168.1.92:8080', '/api/worker-health', 200),
                ('10.0.0.1', '192.168.1.92:8080', None, '/api/worker-health', 403),
                ('127.0.0.1', 'attacker.example:8080', None, '/api/worker-health', 403),
                ('127.0.0.1', '127.0.0.1:8080', 'https://attacker.example', '/api/worker-health', 403),
                ('127.0.0.1', '127.0.0.1:8080', None, '/api/worker-health?url=https://attacker.example', 404)]:
            with self.subTest(peer=peer, host=host, path=path):
                before = self.dial.call_count
                handler = Handler.__new__(Handler)
                handler.client_address = (peer, 12345)
                handler.path = path
                handler.headers = Message()
                handler.headers['Host'] = host
                if origin is not None:
                    handler.headers['Origin'] = origin
                handler.headers['Authorization'] = 'Bearer private-request-token'
                handler.headers['Cookie'] = 'private-session=value'
                handler.server = Mock(app=self.app)
                handler.send = Mock()
                handler.do_GET()
                self.assertEqual(handler.send.call_args.args[0], expected)
                if expected == 200:
                    self.assertEqual(handler.send.call_args.args[1], self.collect())
                else:
                    self.assertEqual(self.dial.call_count, before)
        self.assertEqual(self.dial.call_count, 1)  # Both allowed consumers use one cache.
        self.assertEqual({call.kwargs['server_hostname'] for call in self.tls.call_args_list},
                         {'koreatech.in'})
        for host, sock in self.sockets:
            request = bytes(sock.sent)
            self.assertTrue(request.startswith(b'GET / HTTP/1.1\r\n'))
            self.assertIn(('Host: ' + host + '\r\n').encode('ascii'), request)
            self.assertNotIn(b'Authorization:', request)
            self.assertNotIn(b'Cookie:', request)
            self.assertNotIn(b'private-', request)
            self.assertTrue(sock.closed)





class CredentialPermissionsTests(unittest.TestCase):
    def check(self, mode, managed):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'lookup'
            value = 'synthetic_test_token_' * 3
            path.write_text(value)
            path.chmod(mode)
            environment = {'INTERNAL_LOOKUP_TOKEN_FILE': str(path)}
            if managed:
                environment['CREDENTIALS_DIRECTORY'] = directory
            with patch.dict(os.environ, environment, clear=True):
                return Attendance.read_token('INTERNAL_LOOKUP_TOKEN_FILE')

    def test_private_token_file_is_readable(self):
        self.assertEqual(self.check(0o600, False), 'synthetic_test_token_' * 3)

    def test_group_readable_file_outside_systemd_is_rejected(self):
        with self.assertRaises(ValueError):
            self.check(0o440, False)

    def test_world_readable_file_is_rejected_even_in_credential_directory(self):
        with self.assertRaises(ValueError):
            self.check(0o444, True)

    @unittest.skipUnless(hasattr(os, 'geteuid') and os.geteuid() == 0 and os.getegid() == 0,
                         'Systemd credential ownership requires Linux root')
    def test_root_owned_systemd_credential_mode_0440_is_supported(self):
        self.assertEqual(self.check(0o440, True), 'synthetic_test_token_' * 3)

    def test_monitor_managed_credential_requires_exact_name_owner_and_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            for filename, uid, mode, accepted in [
                    ('monitor', 0, 0o440, True), ('lookup', 0, 0o440, False),
                    ('device', 0, 0o440, False), ('other', 0, 0o440, False),
                    ('monitor', 1, 0o440, False), ('monitor', 0, 0o444, False)]:
                with self.subTest(filename=filename, uid=uid, mode=mode):
                    path = Path(directory) / filename
                    metadata = Mock(st_uid=uid, st_gid=0, st_mode=0o100000 | mode)
                    with patch.dict(os.environ, {'MONITOR_TOKEN_FILE': str(path),
                                                'CREDENTIALS_DIRECTORY': directory}, clear=True):
                        with patch.object(Path, 'stat', return_value=metadata), patch.object(
                                Path, 'read_text', return_value='synthetic_monitor_token_' * 3):
                            if accepted:
                                self.assertEqual(Attendance.read_token('MONITOR_TOKEN_FILE'),
                                                 'synthetic_monitor_token_' * 3)
                            else:
                                with self.assertRaises(ValueError):
                                    Attendance.read_token('MONITOR_TOKEN_FILE')


class RealtimeAttendanceTests(unittest.TestCase):
    def setUp(self):
        contexts = ExitStack()
        self.addCleanup(contexts.close)
        directory = Path(contexts.enter_context(tempfile.TemporaryDirectory()))
        html = directory / 'dashboard.html'
        html.write_text('<!doctype html><title>Synthetic test dashboard</title>')
        contexts.enter_context(patch.dict(os.environ, {
            'INTERNAL_LOOKUP_URL': 'https://api.internal.bcsdlab.com/v1/service/attendance/member-lookup',
            'ATTENDANCE_HTML': str(html),
            'ATTENDANCE_DATA_DIR': str(directory / 'data'),
        }, clear=True))
        contexts.enter_context(patch.object(Attendance, 'read_token', return_value='synthetic_test_token_' * 3))
        self.now = 1_800_000_000_000
        contexts.enter_context(patch('server.now_ms', return_value=self.now))
        self.app = Attendance()
        self.addCleanup(self.app.close)
        self.database_directory = directory / 'data'
        self.member = {'memberId': '1', 'name': 'Synthetic test member'}
        self.app.lookup = Mock(side_effect=lambda _number: dict(self.member))
        self.body = {'studentNumber': '1' * 8, 'at': self.now - 40_000}

    def test_last_checkout_tracks_latest_today_and_stays_null_for_open_visits(self):
        self.assertEqual(self.app.tap(self.body)[1]['status'], 'check-in')
        self.assertIsNone(self.app.state()['members'][0]['lastCheckOut'])

        first_out = self.now - 20_000
        self.assertEqual(self.app.tap({**self.body, 'at': first_out})[1]['status'], 'check-out')
        self.assertEqual(self.app.state()['members'][0]['lastCheckOut'], first_out)
        self.assertEqual(self.app.tap({**self.body, 'at': self.now - 10_000})[1]['status'], 'check-in')
        self.assertEqual(self.app.state()['members'][0]['lastCheckOut'], first_out)
        self.assertEqual(self.app.tap({**self.body, 'at': self.now})[1]['status'], 'check-out')
        self.assertEqual(self.app.state()['members'][0]['lastCheckOut'], self.now)

        tomorrow = day_start(self.now) + DAY + 60_000
        with patch('server.now_ms', return_value=tomorrow):
            self.assertEqual(self.app.tap({**self.body, 'at': tomorrow})[1]['status'], 'check-in')
            member = self.app.state()['members'][0]
            self.assertTrue(member['present'])
            self.assertIsNone(member['lastCheckOut'])

    def test_known_checkin_then_checkout_greets_from_committed_result_and_ignored_taps_do_not(self):
        self.assertEqual(self.app.tap(self.body)[1]['status'], 'check-in')
        self.assertEqual(self.app.greeting_snapshot()[1][2],
                         {'name': self.member['name'], 'action': 'check-in'})
        handler = Handler.__new__(Handler)
        handler.server = Mock(app=self.app)
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = io.BytesIO()
        calls = []
        departure = {**self.body, 'at': self.body['at'] + 20_000}

        def wait(_revision, _timeout, _greeting_revision, _attention_revision):
            calls.append(None)
            if len(calls) == 2:
                self.assertEqual(self.app.tap(departure)[1]['status'], 'check-out')
            return self.app.revision if len(calls) < 3 else None

        with patch.object(self.app, 'wait_for_change', side_effect=wait):
            handler.stream_events()
        greetings = [json.loads(frame.split(b'\ndata: ', 1)[1])
                     for frame in handler.wfile.getvalue().split(b'\n\n')
                     if frame.startswith(b'event: greeting\n')]
        self.assertEqual(greetings, [{'name': self.member['name'], 'action': 'check-out'}])
        self.assertFalse(self.app.state()['members'][0]['present'])
        with self.app.db_lock:
            self.assertEqual(self.app.db.execute('SELECT checkOut FROM sessions').fetchone()[0],
                             departure['at'])
        before = self.app.greeting_snapshot()
        self.assertEqual(self.app.tap(departure)[1]['status'], 'ignored')
        self.assertEqual(self.app.revision, 2)
        self.assertEqual(self.app.greeting_snapshot(), before)
        self.member['name'] = 'Renamed member'
        self.assertEqual(self.app.tap(departure)[1]['status'], 'ignored')
        self.assertEqual(self.app.revision, 3)
        self.assertEqual(self.app.state()['members'][0]['name'], 'Renamed member')
        self.assertEqual(self.app.greeting_snapshot(), before)

    def test_unknown_arrival_commits_and_errors_do_not_greet(self):
        self.app.lookup.side_effect = None
        self.app.lookup.return_value = 'not_found'
        self.assertEqual(self.app.tap(self.body),
                         (200, {'status': 'check-in', 'name': '방문자', 'at': self.body['at']}))
        self.assertEqual(self.app.greeting_snapshot()[1][2], {'name': None, 'action': 'check-in'})
        self.assertEqual(self.app.revision, 1)
        self.app.lookup.return_value = None
        self.assertEqual(self.app.tap(self.body)[0], 503)
        self.assertEqual(self.app.tap({})[0], 400)
        self.assertEqual(self.app.greeting_snapshot()[0], 1)

    def test_guest_database_and_immediate_events_contain_no_student_identifier(self):
        self.app.lookup.side_effect = None
        self.app.lookup.return_value = 'not_found'
        handler = Handler.__new__(Handler)
        handler.server = Mock(app=self.app)
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = io.BytesIO()
        calls = []
        responses = []
        secret = b'synthetic process-local HMAC key'
        digest = hmac.digest(secret, self.body['studentNumber'].encode('ascii'), 'sha256')

        def wait(revision, timeout, greeting_revision, attention_revision):
            calls.append(revision)
            if len(calls) == 2:
                responses.append(self.app.tap(self.body))
                # Publication must happen only after the session is queryable.
                self.assertEqual(len(self.app.state()['recent']), 1)
            return self.app.revision if len(calls) < 3 else None

        with patch('server._GUEST_HMAC_KEY', secret), patch('server.os.urandom', return_value=b'\xab' * 16):
            with patch.object(self.app, 'wait_for_change', side_effect=wait):
                handler.stream_events()
        self.assertEqual(responses, [
            (200, {'status': 'check-in', 'name': '방문자', 'at': self.body['at']})])
        self.assertEqual(handler.wfile.getvalue(),
                         b'retry: 1000\n\nid: 0\nevent: state\ndata: {}\n\n'
                         b'event: attention\ndata: {}\n\nid: 1\nevent: state\ndata: {}\n\n'
                         b'event: greeting\ndata: {"name": null, "action": "check-in"}\n\n')
        with self.app.db_lock:
            members = [tuple(row) for row in self.app.db.execute('SELECT * FROM members')]
            sessions = [tuple(row) for row in self.app.db.execute('SELECT * FROM sessions')]
            dump = '\n'.join(self.app.db.iterdump()).encode('utf-8')
        identity = 'guest-' + 'ab' * 16
        self.assertEqual(members, [(identity, '방문자')])
        self.assertEqual(sessions, [(identity, self.body['at'], None, 0)])
        self.assertEqual(self.app.state()['members'][0]['name'], '방문자')
        self.assertEqual(list(self.app.guest_taps), [digest])
        persisted = dump + b''.join(path.read_bytes() for path in self.database_directory.iterdir())
        for forbidden in (self.body['studentNumber'].encode('ascii'), digest, digest.hex().encode('ascii')):
            self.assertNotIn(forbidden, persisted)
            self.assertNotIn(forbidden, handler.wfile.getvalue())

    def test_unknown_debounce_and_transitions_reuse_only_volatile_identity(self):
        self.app.lookup.side_effect = None
        self.app.lookup.return_value = 'not_found'
        first = {**self.body, 'at': self.now - 2 * 3_600_000}
        departure = {**first, 'at': first['at'] + 3_600_000}
        with patch('server.time.monotonic', return_value=100) as clock, patch('server.threading.Timer'):
            self.assertEqual(self.app.tap(first)[1]['status'], 'check-in')
            first_greeting = self.app.greeting_snapshot()[0]
            duplicate = {**first, 'at': first['at'] + 9_999}
            self.assertEqual(self.app.tap(duplicate), (200, {'status': 'ignored', 'name': '방문자'}))
            self.assertEqual(self.app.greeting_snapshot()[0], first_greeting)
            distinct = {**first, 'studentNumber': '2' * 8}
            self.assertEqual(self.app.tap(distinct)[1]['status'], 'check-in')
            # 큐에 있던 입실·퇴실이 한꺼번에 도착해도 실제 한 시간의 차이를 보존한다.
            self.assertEqual(self.app.tap(departure),
                             (200, {'status': 'check-out', 'name': '방문자',
                                    'at': departure['at'], 'durationMs': 3_600_000}))
            self.assertEqual(self.app.greeting_snapshot()[1][2], {'name': None, 'action': 'check-out'})
            self.assertEqual(sum(member['present'] for member in self.app.state()['members']), 1)
            checkout_greeting = self.app.greeting_snapshot()[0]
            self.assertEqual(self.app.tap(departure), (200, {'status': 'ignored', 'name': '방문자'}))
            self.assertEqual(self.app.greeting_snapshot()[0], checkout_greeting)
            self.assertEqual(self.app.tap({**first, 'at': self.now})[1]['status'], 'check-in')
            self.assertEqual(len(self.app.state()['recent']), 3)
            self.assertEqual(len(self.app.state()['members']), 2)
            self.assertEqual(self.app.revision, 4)
            clock.return_value = 100 + MAX_SESSION / 1000
            self.app.expire_guest_taps()
            self.assertEqual(len(self.app.guest_taps), 0)
            self.assertIsNone(self.app.guest_timer)
            with self.app.db_lock:
                identities = [row[0] for row in self.app.db.execute('SELECT memberId FROM sessions')]
            self.assertEqual(len(set(identities)), 2)

    def test_guest_identity_cache_is_bounded_and_expires_while_idle(self):
        self.app.lookup.side_effect = None
        self.app.lookup.return_value = 'not_found'
        with patch('server.time.monotonic', return_value=100) as clock, patch('server.threading.Timer'):
            with self.app.db_lock:
                self.app.guest_taps.update(
                    (index.to_bytes(32, 'big'), (100 + MAX_SESSION / 1000, 'guest-seeded-' + str(index)))
                    for index in range(MAX_GUEST_TAPS))
            self.assertEqual(self.app.tap(self.body)[1]['status'], 'check-in')
            self.assertEqual(len(self.app.guest_taps), MAX_GUEST_TAPS)
            self.assertNotIn(bytes(32), self.app.guest_taps)
            clock.return_value = 100 + MAX_SESSION / 1000
            self.app.expire_guest_taps()
            self.assertEqual(len(self.app.guest_taps), 0)
            self.assertIsNone(self.app.guest_timer)

    def test_empty_process_cache_does_not_recover_guest_identity_from_database(self):
        self.app.lookup.side_effect = None
        self.app.lookup.return_value = 'not_found'
        self.assertEqual(self.app.tap(self.body)[1]['status'], 'check-in')
        # A new application has no correlation, even when its database survives.
        restarted = Attendance()
        self.addCleanup(restarted.close)
        restarted.lookup = Mock(return_value='not_found')
        with patch('server._GUEST_HMAC_KEY', b'new synthetic process key'):
            self.assertEqual(restarted.tap({**self.body, 'at': self.body['at'] + 20_000})[1]['status'],
                             'check-in')
        self.assertEqual(len(restarted.state()['members']), 2)
        with patch('server.now_ms', return_value=self.body['at'] + MAX_SESSION):
            members = restarted.state()['members']
            self.assertEqual(sum(member['present'] for member in members), 1)
            self.assertTrue(all(member['name'] == '방문자' for member in members))

    def test_concurrent_unknown_duplicates_insert_one_guest_session(self):
        self.app.lookup.side_effect = None
        self.app.lookup.return_value = 'not_found'
        barrier = threading.Barrier(8)

        def tap(_index):
            barrier.wait(5)
            return self.app.tap(self.body)[1]['status']

        with ThreadPoolExecutor(max_workers=8) as executor:
            statuses = list(executor.map(tap, range(8)))
        self.assertEqual(statuses.count('check-in'), 1)
        self.assertEqual(statuses.count('ignored'), 7)
        self.assertEqual(len(self.app.state()['members']), 1)
        self.assertEqual(len(self.app.state()['recent']), 1)
        self.assertEqual(self.app.revision, 1)

    def test_existing_internal_member_keeps_identity_and_session_behavior(self):
        with self.app.db_lock, self.app.db:
            self.app.db.execute('INSERT INTO members VALUES(?,?)', ('internal-1', 'Old member name'))
            self.app.db.execute('INSERT INTO sessions(memberId,checkIn) VALUES(?,?)',
                                ('internal-1', self.body['at'] - 20_000))
        self.assertEqual(self.app.tap(self.body),
                         (200, {'status': 'check-out', 'name': self.member['name'],
                                'at': self.body['at'], 'durationMs': 20_000}))
        with self.app.db_lock:
            members = [tuple(row) for row in self.app.db.execute('SELECT * FROM members')]
            sessions = [tuple(row) for row in self.app.db.execute('SELECT * FROM sessions')]
        self.assertEqual(members, [('internal-1', self.member['name'])])
        self.assertEqual(sessions, [('internal-1', self.body['at'] - 20_000, self.body['at'], 0)])
        self.assertEqual(self.app.greeting_snapshot()[1][2], {'name': self.member['name'], 'action': 'check-out'})
        self.assertEqual(len(self.app.guest_taps), 0)

    def test_guest_rollback_does_not_cache_or_publish_and_allows_retry(self):
        self.app.lookup.side_effect = None
        self.app.lookup.return_value = 'not_found'
        with self.app.db_lock, self.app.db:
            self.app.db.execute("""CREATE TRIGGER reject_guest_session BEFORE INSERT ON sessions
                BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            self.app.tap(self.body)
        self.assertEqual(self.app.revision, 0)
        self.assertEqual(self.app.greeting_snapshot(), (0, None))
        self.assertEqual(self.app.state()['members'], [])
        self.assertEqual(len(self.app.guest_taps), 0)
        self.assertIsNone(self.app.guest_timer)
        with self.app.db_lock, self.app.db:
            self.app.db.execute('DROP TRIGGER reject_guest_session')
        self.assertEqual(self.app.tap(self.body)[1]['status'], 'check-in')

    def test_greeting_wakes_all_waiters_including_publish_before_wait(self):
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = [executor.submit(self.app.wait_for_change, 0, 2, 0) for _ in range(3)]
            self.app.publish_greeting(None, 'check-in')
            self.assertEqual([future.result(2) for future in futures], [0, 0, 0])
        self.assertEqual(self.app.wait_for_change(0, 30, 0), 0)

    def test_stream_skips_stale_greeting_and_emits_new_greeting(self):
        self.app.publish_greeting('Old name', 'check-in')
        handler = Handler.__new__(Handler)
        handler.server = Mock(app=self.app)
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = io.BytesIO()
        calls = []

        def wait(revision, timeout, greeting_revision, attention_revision):
            calls.append(greeting_revision)
            if len(calls) == 2:
                self.app.publish_greeting(None, 'check-out')
            return 0 if len(calls) < 3 else None

        with patch.object(self.app, 'wait_for_change', side_effect=wait):
            handler.stream_events()
        self.assertEqual(calls, [1, 1, 2])
        self.assertEqual(handler.wfile.getvalue(),
                         b'retry: 1000\n\nid: 0\nevent: state\ndata: {}\n\n'
                         b'event: greeting\ndata: {"name": null, "action": "check-out"}\n\n')

    def test_greeting_expires_and_old_expiry_cannot_clear_latest(self):
        self.app.publish_greeting('Old name', 'check-in')
        self.app.publish_greeting('Latest name', 'check-out')
        self.app.expire_greeting(1)
        self.assertEqual(self.app.greeting_snapshot()[1][2], {'name': 'Latest name', 'action': 'check-out'})
        with patch('server.time.monotonic', return_value=float('inf')):
            self.assertIsNone(self.app.greeting_snapshot()[1])
        self.app.expire_greeting(2)
        self.assertIsNone(self.app.greeting)

    def test_time_driven_presence_and_kst_boundaries_schedule_refresh(self):
        midnight = day_start(self.now) + DAY
        self.assertEqual(self.app.next_state_change(), midnight)
        self.app.tap(self.body)
        expiry = self.body['at'] + MAX_SESSION
        self.assertEqual(self.app.next_state_change(), min(midnight, expiry, self.now + 10_000))
        with patch('server.now_ms', return_value=expiry - 1):
            self.assertEqual(self.app.next_state_change(), min(day_start(expiry - 1) + DAY, expiry))
        with patch('server.now_ms', return_value=expiry):
            self.assertEqual(self.app.next_state_change(), day_start(expiry) + DAY)
            self.assertFalse(self.app.state()['members'][0]['present'])

    def test_stream_invalidates_at_time_boundary_without_a_new_tap(self):
        handler = Handler.__new__(Handler)
        handler.server = Mock(app=self.app)
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = io.BytesIO()
        calls = []
        with patch('server.now_ms', return_value=self.now) as clock:
            def wait(revision, _timeout, _greeting_revision=None, _attention_revision=None):
                calls.append(revision)
                if len(calls) == 2:
                    clock.return_value = day_start(self.now) + DAY
                return 0 if len(calls) < 3 else None

            with patch.object(self.app, 'wait_for_change', side_effect=wait):
                handler.stream_events()
        self.assertEqual(handler.wfile.getvalue(),
                         b'retry: 1000\n\nid: 0\nevent: state\ndata: {}\n\n'
                         b'id: 0\nevent: state\ndata: {}\n\n')

    def test_committed_session_and_member_changes_notify_but_duplicates_do_not(self):
        self.assertEqual(self.app.wait_for_change(0, 0), 0)
        self.assertEqual(self.app.tap(self.body)[1]['status'], 'check-in')
        self.assertEqual(self.app.wait_for_change(0, 0), 1)
        self.assertTrue(self.app.state()['members'][0]['present'])
        self.assertEqual(self.app.tap(self.body)[1]['status'], 'ignored')
        self.assertEqual(self.app.wait_for_change(1, 0), 1)
        self.member['name'] = 'Renamed synthetic member'
        self.assertEqual(self.app.tap(self.body)[1]['status'], 'ignored')
        self.assertEqual(self.app.wait_for_change(1, 0), 2)
        self.assertEqual(self.app.state()['members'][0]['name'], self.member['name'])
        self.assertEqual(self.app.tap({**self.body, 'at': self.now - 20_000})[1]['status'], 'check-out')
        self.assertEqual(self.app.wait_for_change(2, 0), 3)
        self.assertFalse(self.app.state()['members'][0]['present'])

    def test_lookup_unavailable_does_not_publish_state_greeting_or_persist(self):
        self.app.lookup.return_value = None
        self.app.lookup.side_effect = None
        self.assertEqual(self.app.tap(self.body), (503, {'error': 'lookup_unavailable'}))
        self.assertEqual(self.app.wait_for_change(0, 0), 0)
        self.assertEqual(self.app.greeting_snapshot(), (0, None))
        self.assertEqual(self.app.state()['members'], [])
        self.assertEqual(len(self.app.guest_taps), 0)

    def test_rollback_does_not_publish_a_member_or_state_event(self):
        with self.app.db_lock, self.app.db:
            self.app.db.execute("""CREATE TRIGGER reject_test_session BEFORE INSERT ON sessions
                BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            self.app.tap(self.body)
        self.assertEqual(self.app.wait_for_change(0, 0), 0)
        self.assertEqual(self.app.greeting_snapshot(), (0, None))
        self.assertEqual(self.app.state()['members'], [])

    def test_slow_lookup_does_not_block_state_or_other_taps(self):
        entered, release = threading.Event(), threading.Event()

        def lookup(_number):
            entered.set()
            if not release.wait(5):
                raise AssertionError('Synthetic lookup was not released')
            return dict(self.member)

        self.app.lookup.side_effect = lookup
        with ThreadPoolExecutor(max_workers=3) as executor:
            slow = executor.submit(self.app.tap, self.body)
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(self.app.attention_revision, 1)
                self.assertEqual(self.app.greeting_snapshot(), (0, None))
                self.assertEqual(executor.submit(self.app.state).result(2)['members'], [])
                # A second lookup may complete while the first is still blocked.
                self.app.lookup.side_effect = lambda _number: dict(self.member)
                self.assertEqual(executor.submit(self.app.tap, self.body).result(2)[1]['status'], 'check-in')
            finally:
                release.set()
            self.assertEqual(slow.result(2)[1]['status'], 'ignored')

    def test_concurrent_duplicate_taps_are_one_committed_transition(self):
        barrier = threading.Barrier(8)

        def tap(_index):
            barrier.wait(5)
            result = self.app.tap(self.body)
            state = self.app.state()
            self.assertEqual(len(state['members']), 1)
            self.assertEqual(len(state['recent']), 1)
            return result[1]['status']

        with ThreadPoolExecutor(max_workers=8) as executor:
            statuses = list(executor.map(tap, range(8)))
        self.assertEqual(statuses.count('check-in'), 1)
        self.assertEqual(statuses.count('ignored'), 7)
        self.assertEqual(self.app.wait_for_change(0, 0), 1)

    def test_tap_after_max_session_closes_instead_of_starting_a_new_visit(self):
        # A visitor who forgets to tap out and returns 8 hours later must end the
        # stale session on that tap; otherwise the dashboard keeps showing 입실 중.
        self.assertEqual(self.app.tap(self.body)[1]['status'], 'check-in')
        later = self.now - 40_000 + 8 * 3_600_000
        with patch('server.now_ms', return_value=later + 1000):
            status, result = self.app.tap({**self.body, 'at': later})
        self.assertEqual(status, 200)
        self.assertEqual(result['status'], 'check-out')
        self.assertTrue(result['previousAutoClosed'])
        with self.app.db_lock:
            rows = [tuple(row) for row in self.app.db.execute(
                'SELECT checkIn, checkOut, autoClosed FROM sessions ORDER BY checkIn')]
        self.assertEqual(rows, [(self.body['at'], later, 1)])

    def test_shutdown_wakes_waiting_stream(self):
        entered = threading.Event()

        def wait():
            entered.set()
            return self.app.wait_for_change(0, 30)

        with ThreadPoolExecutor(max_workers=1) as executor:
            waiting = executor.submit(wait)
            self.assertTrue(entered.wait(2))
            self.app.stop_events()
            self.assertIsNone(waiting.result(2))

    def test_stream_payload_is_identity_free_and_disconnect_is_released(self):
        handler = Handler.__new__(Handler)
        handler.server = Mock(app=self.app)
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = io.BytesIO()
        with patch.object(self.app, 'wait_for_change', side_effect=[0, 0, 1, None]):
            handler.stream_events()
        self.assertEqual(handler.wfile.getvalue(),
                         b'retry: 1000\n\nid: 0\nevent: state\ndata: {}\n\n'
                         b'event: ping\ndata: {}\n\nid: 1\nevent: state\ndata: {}\n\n')
        handler.wfile = Mock()
        handler.wfile.write.side_effect = BrokenPipeError()
        handler.stream_events()  # A disconnected client must not escape to request logging.
        self.assertTrue(handler.close_connection)

    def test_open_stream_observes_attention_before_slow_lookup_and_then_commit(self):
        class LocalHandler(Handler):
            def permitted(self):
                return True  # Only this loopback test; production filters remain unchanged.

        server = AttendanceServer(('127.0.0.1', 0), LocalHandler)
        server.app = self.app
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        stream = http.client.HTTPConnection(*server.server_address, timeout=2)
        state = http.client.HTTPConnection(*server.server_address, timeout=2)
        response = None
        entered, release = threading.Event(), threading.Event()
        executor = ThreadPoolExecutor(max_workers=1)

        def lookup(_number):
            entered.set()
            if not release.wait(5):
                raise AssertionError('Synthetic lookup was not released')
            return dict(self.member)

        self.app.lookup.side_effect = lookup
        try:
            stream.request('GET', '/api/events')
            response = stream.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader('Content-Type'), 'text/event-stream; charset=utf-8')
            self.assertEqual([response.fp.readline() for _ in range(6)],
                             [b'retry: 1000\n', b'\n', b'id: 0\n', b'event: state\n', b'data: {}\n', b'\n'])
            state.request('GET', '/api/state')
            snapshot = state.getresponse()
            self.assertEqual(snapshot.status, 200)
            snapshot.read()
            tapping = executor.submit(self.app.tap, self.body)
            self.assertTrue(entered.wait(2))
            # The display receives the identity-free wakeup while lookup is blocked.
            self.assertEqual([response.fp.readline() for _ in range(3)],
                             [b'event: attention\n', b'data: {}\n', b'\n'])
            self.assertEqual(self.app.state()['members'], [])
            self.assertEqual(self.app.greeting_snapshot(), (0, None))
            release.set()
            self.assertEqual(tapping.result(2)[1]['status'], 'check-in')
            self.assertEqual([response.fp.readline() for _ in range(4)],
                             [b'id: 1\n', b'event: state\n', b'data: {}\n', b'\n'])
        finally:
            release.set()
            executor.shutdown(wait=True)
            if response is not None:
                response.close()
            stream.close()
            state.close()
            self.app.stop_events()
            server.shutdown()
            server.server_close()
            thread.join(2)
        self.assertFalse(thread.is_alive())

    def test_invalid_body_or_time_never_requests_attention_or_lookup(self):
        for body in ({}, [], {'studentNumber': 'bad'}, {**self.body, 'extra': True},
                     {**self.body, 'at': True}, {**self.body, 'at': self.now + 60_001},
                     {**self.body, 'at': self.now - 7 * DAY - 1}):
            with self.subTest(body=body):
                self.assertEqual(self.app.tap(body)[0], 400)
        self.app.lookup.assert_not_called()
        self.assertEqual(self.app.attention_revision, 0)
        self.assertEqual(self.app.greeting_snapshot(), (0, None))

    def test_attention_wakes_all_waiters_and_publish_before_wait_is_not_lost(self):
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = [executor.submit(self.app.wait_for_change, 0, 2, 0, 0) for _ in range(3)]
            self.app.publish_attention()
            self.assertEqual([future.result(2) for future in futures], [0, 0, 0])
        self.assertEqual(self.app.wait_for_change(0, 30, 0, 0), 0)
        self.assertEqual(self.app.revision, 0)
        self.assertEqual(self.app.greeting_snapshot(), (0, None))
        self.app.stop_events()
        self.app.publish_attention()
        self.assertEqual(self.app.attention_revision, 1)
        self.assertIsNone(self.app.wait_for_change(0, 30, 0, 1))

    def test_stream_skips_old_attention_and_failed_lookups_still_wake_without_greeting(self):
        self.app.publish_attention()
        self.app.lookup.side_effect = None
        self.app.lookup.return_value = None
        handler = Handler.__new__(Handler)
        handler.server = Mock(app=self.app)
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = io.BytesIO()
        seen = []

        def wait(revision, _timeout, _greeting_revision, attention_revision):
            seen.append(attention_revision)
            if len(seen) in (2, 3):
                self.assertEqual(self.app.tap(self.body), (503, {'error': 'lookup_unavailable'}))
            return self.app.revision if len(seen) < 4 else None

        with patch.object(self.app, 'wait_for_change', side_effect=wait):
            handler.stream_events()
        self.assertEqual(seen, [1, 1, 2, 3])
        self.assertEqual(handler.wfile.getvalue(),
                         b'retry: 1000\n\nid: 0\nevent: state\ndata: {}\n\n'
                         b'event: attention\ndata: {}\n\nevent: attention\ndata: {}\n\n')
        self.assertEqual(self.app.state()['members'], [])
        self.assertEqual(self.app.greeting_snapshot(), (0, None))

    def monitor_payload(self):
        return {'observedAt': self.now, 'nodes': [
            {'id': identity, 'label': identity.upper(), 'collectedAt': self.now,
             'cpuPercent': 12.5, 'memoryUsedBytes': 1024, 'memoryTotalBytes': 4096,
             'health': 'up'} for identity in ('prod', 'stage', 'db')]}

    def test_monitor_is_optional_and_requires_a_separate_credential(self):
        with patch('server.ForwardedHTTPSConnection') as transport:
            self.assertIsNone(self.app.monitor())
            transport.assert_not_called()
        with patch.dict(os.environ, {'MONITOR_TOKEN_FILE': 'synthetic-path'}):
            with self.assertRaises(ValueError):
                Attendance()  # The fixture's credential reader returns the lookup token.
            with patch.object(Attendance, 'read_token', side_effect=lambda key:
                              'synthetic_monitor_token_' * 3 if key == 'MONITOR_TOKEN_FILE'
                              else 'synthetic_test_token_' * 3) as reader:
                configured = Attendance()
                self.addCleanup(configured.close)
                self.assertEqual(configured.monitor_token, 'synthetic_monitor_token_' * 3)
                self.assertIn(('MONITOR_TOKEN_FILE',), [call.args for call in reader.call_args_list])

    def test_monitor_proxy_uses_fixed_tls_host_path_and_only_monitor_bearer(self):
        self.app.monitor_token = 'synthetic_monitor_token_' * 3
        payload = self.monitor_payload()
        with patch('server.ForwardedHTTPSConnection') as transport:
            connection = transport.return_value
            response = connection.getresponse.return_value
            response.status = 200
            response.getheader.return_value = 'application/json; charset=utf-8'
            response.read.return_value = json.dumps(payload).encode('utf-8')
            self.assertEqual(self.app.monitor(), payload)
            transport.assert_called_once_with('api.internal.bcsdlab.com', timeout=5, context=self.app.context)
            connection.request.assert_called_once_with('GET', MONITOR_PATH, headers={
                'Authorization': 'Bearer ' + self.app.monitor_token,
                'Accept': 'application/json', 'Cache-Control': 'no-store'})
            response.read.assert_called_once_with(MAX_MONITOR_BODY + 1)
            connection.close.assert_called_once_with()
        self.assertTrue(self.app.context.check_hostname)
        with patch('server.socket.create_connection') as connect:
            connection = ForwardedHTTPSConnection('api.internal.bcsdlab.com', timeout=5, context=self.app.context)
            tls = Mock()
            connection._context = tls
            connection.connect()
            connect.assert_called_once_with(('127.0.0.1', 18443), 5)
            tls.wrap_socket.assert_called_once_with(connect.return_value, server_hostname='api.internal.bcsdlab.com')
            connection.close()

    def test_monitor_proxy_rejects_redirects_errors_invalid_json_and_oversized_payloads(self):
        self.app.monitor_token = 'synthetic_monitor_token_' * 3
        for status, mime, raw in [
                (302, 'application/json', b'{}'), (401, 'application/json', b'{}'),
                (503, 'application/json', b'{}'), (200, 'text/html', b'{}'),
                (200, 'application/json', b'invalid'), (200, 'application/json', b'null'),
                (200, 'application/json', b'\xff'),
                (200, 'application/json', b'{"observedAt":1,"observedAt":2,"nodes":[]}'),
                (200, 'application/json', b' ' * (MAX_MONITOR_BODY + 1))]:
            with self.subTest(status=status, mime=mime, size=len(raw)):
                with patch('server.ForwardedHTTPSConnection') as transport:
                    connection = transport.return_value
                    response = connection.getresponse.return_value
                    response.status, response.getheader.return_value, response.read.return_value = status, mime, raw
                    self.assertIsNone(self.app.monitor())
                    connection.close.assert_called_once_with()
        with patch('server.ForwardedHTTPSConnection') as transport:
            transport.return_value.request.side_effect = OSError('synthetic transport failure')
            self.assertIsNone(self.app.monitor())
            transport.return_value.close.assert_called_once_with()

    def test_monitor_validates_exact_nodes_finite_values_and_fresh_timestamps(self):
        payload = self.monitor_payload()
        self.assertTrue(Attendance.validate_monitor(payload))
        for field, values in {
                'id': ['other', [], None],
                'label': ['', ' padded ', 'line\nbreak', 'x' * 101, '\ud800'],
                'health': ['healthy', [], None],
                'cpuPercent': [True, -1, 101, float('nan'), float('inf'), 10 ** 400, '2'],
                'memoryUsedBytes': [True, -1, 4097, 1.5, 2 ** 53],
                'memoryTotalBytes': [True, 0, -1, 1.5, 2 ** 53],
                'collectedAt': [True, 0, -1, self.now + 1, self.now - 60_001, None],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    invalid = deepcopy(payload)
                    invalid['nodes'][0][field] = value
                    self.assertFalse(Attendance.validate_monitor(invalid))
        for observed in (True, 0, self.now - 60_001, self.now + 60_001, float('inf')):
            invalid = deepcopy(payload)
            invalid['observedAt'] = observed
            self.assertFalse(Attendance.validate_monitor(invalid))
        for nodes in ([], payload['nodes'][:2], payload['nodes'] + payload['nodes'][:1],
                      [payload['nodes'][0]] * 3):
            self.assertFalse(Attendance.validate_monitor({**payload, 'nodes': nodes}))
        invalid = deepcopy(payload)
        invalid['nodes'][0]['extra'] = 'unexpected'
        self.assertFalse(Attendance.validate_monitor(invalid))
        self.assertFalse(Attendance.validate_monitor({**payload, 'extra': True}))
        for health in ('down', 'unknown'):
            unavailable = deepcopy(payload)
            unavailable['nodes'][0].update(health=health, collectedAt=None, cpuPercent=None,
                                           memoryUsedBytes=None, memoryTotalBytes=None)
            self.assertTrue(Attendance.validate_monitor(unavailable))
        first_sample = deepcopy(payload)
        first_sample['nodes'][0]['cpuPercent'] = None
        self.assertTrue(Attendance.validate_monitor(first_sample))


if __name__ == '__main__':
    unittest.main()
