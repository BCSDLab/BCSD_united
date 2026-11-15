import contextlib
import http.server
import io
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

import reader


class RedirectTests(unittest.TestCase):
    def test_redirect_does_not_forward_credentials_or_discard_queued_tap(self):
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/capture")
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = os.path.join(directory, "queue")
                tap = {"studentNumber": "2024123456", "at": 123}
                reader.write_queue(path, [tap])
                url = "http://127.0.0.1:%d" % server.server_port
                with patch.object(reader, "LAN_URL", url), contextlib.redirect_stdout(io.StringIO()):
                    result = reader.flush_queue(url, "synthetic-token", path)
                self.assertIsNone(result)
                self.assertEqual(reader.read_queue(path), [tap])
                self.assertEqual(requests, ["/api/taps"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class LocalDeliveryTests(unittest.TestCase):
    def test_public_or_alternate_endpoint_cannot_receive_a_tap(self):
        tap = {"studentNumber": "2024123456", "at": 123}
        for url in ("https://bcsd-attendance.bcsdlab.workers.dev",
                    "http://192.168.1.2:8080", "http://localhost:8080",
                    "http://127.0.0.1:8080/api"):
            with self.subTest(url=url), patch.object(reader.HTTP_OPENER, "open") as opener:
                with self.assertRaises(ValueError):
                    reader.send(url, "synthetic-token", tap)
                opener.assert_not_called()

    def test_tag_queues_only_real_student_number_and_timestamp(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "queue")
            with patch.object(reader, "flush_queue", return_value=None), patch.object(reader.time, "time", return_value=123):
                self.assertEqual(reader.record_tap(reader.LAN_URL, "synthetic-token", path, "2024123456"), "queued")
            self.assertEqual(reader.read_queue(path), [{"studentNumber": "2024123456", "at": 123000}])
            with patch.object(reader, "read_queue") as read_queue:
                self.assertEqual(reader.record_tap(reader.LAN_URL, "synthetic-token", path, "04AB12CD"), "rejected")
                read_queue.assert_not_called()

    def test_uid_queue_entries_are_never_forwarded_or_mapped(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "queue")
            reader.write_queue(path, [{"uid": "04AB12CD", "at": 123}])
            with patch.object(reader, "send") as send:
                self.assertEqual(reader.flush_queue(reader.LAN_URL, "synthetic-token", path), "rejected")
                send.assert_not_called()
            self.assertEqual(reader.read_queue(path), [])

    def test_malformed_success_response_keeps_tag_for_retry(self):
        tap = {"studentNumber": "2024123456", "at": 123}
        for body in (b"not-json", b"{}", b'{"status":"unexpected"}'):
            with self.subTest(body=body), patch.object(reader.HTTP_OPENER, "open") as opener:
                response = opener.return_value.__enter__.return_value
                response.read.return_value = body
                response.status = 200
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertIsNone(reader.send(reader.LAN_URL, "synthetic-token", tap))


class ResetRecoveryTests(unittest.TestCase):
    def device(self, version=0x82):
        device = reader.Mfrc522.__new__(reader.Mfrc522)
        registers = {device.VERSION: version, device.MODE: 0x3F,
                     device.TX_ASK: 0, device.TX_CONTROL: 0x80}
        device._read = lambda register: registers.get(register, 0)
        device._write = lambda register, value: registers.__setitem__(register, value)
        return device, registers

    def test_responsive_reset_chip_regains_field_and_student_card_rf_profile(self):
        device, registers = self.device()
        self.assertTrue(device.ensure_ready())
        self.assertEqual(registers[device.TX_CONTROL] & 0x03, 0x03)
        self.assertEqual(registers[device.TX_ASK] & 0x40, 0x40)
        self.assertEqual(registers[device.MODE], 0x3D)
        self.assertEqual(registers[device.RF_CFG] & 0x70, 0x40)
        self.assertFalse(device.ensure_ready())

    def test_unresponsive_chip_is_not_reported_as_recovered(self):
        device, registers = self.device(version=0x00)
        with self.assertRaises(RuntimeError):
            device.ensure_ready()
        self.assertEqual(registers[device.TX_CONTROL] & 0x03, 0)


class FreshPresentationTests(unittest.TestCase):
    def arm(self, gate, at=0):
        gate.observe(None, at)
        gate.observe(None, at + reader.REPEAT_GUARD_SECONDS)

    def test_card_held_at_start_cannot_create_an_attendance_event(self):
        gate = reader._TapGate()
        self.assertFalse(gate.observe("2024123456", 0))
        self.assertFalse(gate.observe("2024123456", 10))
        self.arm(gate, 11)
        self.assertTrue(gate.observe("2024123456", 20))
        self.assertFalse(gate.observe("2024123456", 21))

    def test_rf_recovery_requires_a_new_presentation_before_another_event(self):
        gate = reader._TapGate()
        self.arm(gate)
        self.assertTrue(gate.observe("2024123456", 10))
        gate.reset()
        self.assertFalse(gate.observe("2024123456", 11))
        self.arm(gate, 12)
        self.assertTrue(gate.observe("2024123456", 20))

    def test_radio_failure_is_not_a_confirmed_removal(self):
        gate = reader._TapGate()
        gate.observe(None, 0)
        gate.failed()
        gate.observe(None, 100)
        self.assertFalse(gate.observe("2024123456", 100.1))
        self.arm(gate, 101)
        self.assertTrue(gate.observe("2024123456", 110))


if __name__ == "__main__":
    unittest.main()
