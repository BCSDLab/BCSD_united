import unittest
from types import SimpleNamespace
from unittest.mock import patch

import hce


def mobile_response(number):
    packed = bytes.fromhex(number.zfill(13) + "0" + "00")
    return packed + bytes(8) + b"\x90\x00"


class StudentNumberTests(unittest.TestCase):
    def test_valid_packed_student_number(self):
        self.assertEqual(hce._student_number(mobile_response("2024123456")), "2024123456")

    def test_rejects_invalid_status_or_nondigit_nibble(self):
        response = mobile_response("2024123456")
        for invalid in (response[:-1] + b"\x01", b"\xfa" + response[1:]):
            with self.subTest(invalid=invalid), self.assertRaises(hce.HceError):
                hce._student_number(invalid)


class FreshCardSelectionTests(unittest.TestCase):
    def test_deselected_card_is_not_read_again_until_represented(self):
        class Radio:
            def __init__(self):
                self.reader = SimpleNamespace(COLL=0, _clear_bits=lambda *args: None)
                self.halted = False

            def exchange(self, data, timeout, last_bits=0, no_card=False):
                if data == b"\x52":
                    self.halted = False
                    return b"\x04\x00"
                if data == b"\x26":
                    if self.halted:
                        raise hce._NoCard()
                    return b"\x04\x00"
                if data == b"\x93\x20":
                    return b"\x01\x02\x03\x04\x04"
                raise AssertionError("Unexpected activation command")

            def frame(self, data, timeout):
                if data.startswith(b"\x93\x70"):
                    return b"\x20"
                if data == b"\xe0\x50":
                    return b"\x02\x02"
                if data == b"\xc2":
                    self.halted = True
                    return b"\xc2"
                if data[0] in (0x02, 0x03):
                    payload = b"\x90\x00" if data[1:] == hce._SELECT else mobile_response("2024123456")
                    return data[:1] + payload
                raise AssertionError("Unexpected ISO-DEP command")

        radio = Radio()
        with patch.object(hce, "_Radio", return_value=radio):
            self.assertEqual(hce.read_student_number(None), "2024123456")
            self.assertIsNone(hce.read_student_number(None))
            radio.halted = False  # Field removal and a new physical presentation.
            self.assertEqual(hce.read_student_number(None), "2024123456")


class RadioReader:
    (RF_CFG, T_MODE, T_PRESCALER, T_RELOAD_H, T_RELOAD_L, COMMAND,
     COM_IRQ, FIFO_LEVEL, FIFO_DATA, BIT_FRAMING, ERROR, CONTROL,
     IDLE, TRANSCEIVE, COLL) = range(15)

    def __init__(self, irq, frame=b"", error=0, last_bits=0):
        self.registers = {self.COM_IRQ: irq, self.FIFO_LEVEL: len(frame),
                          self.ERROR: error, self.CONTROL: last_bits}
        self.bytes = iter(frame)

    def _read(self, register):
        return next(self.bytes) if register == self.FIFO_DATA else self.registers.get(register, 0)

    def _write(self, register, *values):
        pass

    def _set_bits(self, register, mask):
        pass

    def _clear_bits(self, register, mask):
        pass


class RadioTests(unittest.TestCase):
    def test_empty_receive_irq_is_absence_not_a_latched_reader_error(self):
        # Actual affected RC522: Rx/Tx/Err IRQ 0x64, zero FIFO, ErrorReg 0.
        self.assertIsNone(hce.read_student_number(RadioReader(0x64)))

    def test_timer_and_idle_irq_still_report_absence(self):
        self.assertIsNone(hce.read_student_number(RadioReader(0x11)))

    def test_complete_receive_wins_over_simultaneous_timer(self):
        radio = hce._Radio(RadioReader(0x21, b"\x04\x00"))
        self.assertEqual(radio.exchange(b"\x52", 0.05, 7, no_card=True), b"\x04\x00")

    def test_partial_or_receive_error_does_not_clear_presence(self):
        for reader in (RadioReader(0x64, error=0x01), RadioReader(0x64, last_bits=1)):
            with self.subTest(reader=reader), self.assertRaises(hce.HceError):
                hce.read_student_number(reader)

    def test_empty_active_exchange_is_not_treated_as_card_absence(self):
        with self.assertRaisesRegex(hce.HceError, "empty frame"):
            hce._Radio(RadioReader(0x64)).exchange(b"\x02", 0.05)

    def test_mobile_card_gain_preserves_other_rf_config_bits(self):
        class Reader:
            RF_CFG = 0x26

            def __init__(self):
                self.writes = []

            def _read(self, reg):
                self.reg = reg
                return 0xf5

            def _write(self, reg, value):
                self.writes.append((reg, value))

        reader = Reader()
        hce._Radio(reader)
        self.assertEqual(reader.reg, reader.RF_CFG)
        self.assertEqual(reader.writes, [(reader.RF_CFG, 0xc5)])


class IsoDepTests(unittest.TestCase):
    def test_wait_extension_is_answered_before_response(self):
        class Radio:
            def __init__(self):
                self.calls = []
                self.responses = iter((b"\xf2\x02", b"\x02\x90\x00"))

            def frame(self, data, timeout):
                self.calls.append((data, timeout))
                return next(self.responses)

        radio = Radio()
        session = hce._IsoDep(radio)
        self.assertEqual(session.apdu(b"\x00\xa4"), b"\x90\x00")
        self.assertEqual([data for data, _ in radio.calls], [b"\x02\x00\xa4", b"\xf2\x02"])
        self.assertGreater(radio.calls[1][1], radio.calls[0][1])

    def test_response_with_wrong_block_number_is_rejected(self):
        class Radio:
            def frame(self, data, timeout):
                return b"\x03\x90\x00"

        with self.assertRaises(hce.HceError):
            hce._IsoDep(Radio()).apdu(b"\x00\xa4")


if __name__ == "__main__":
    unittest.main()
