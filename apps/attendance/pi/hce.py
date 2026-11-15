"""Bounded ISO-DEP exchange for the mobile-card HCE application.

The number is unverified, replayable application data, not proof of issuance or
identity. No UID is returned or used as a fallback.
"""

import math
import time


class HceError(Exception):
    """A non-identifying HCE stage and reason."""


_AID = bytes.fromhex("D410000039533153494944")
_SELECT = b"\x00\xa4\x04\x00" + bytes((len(_AID),)) + _AID + b"\x00"
_READ = bytes.fromhex("00B2010C10")
_MAX_WAIT = 5.0
_MAX_INF = 4096
_MAX_BLOCKS = 128
_MAX_WTX = 12


class _NoCard(Exception):
    pass


def _crc_a(data):
    crc = 0x6363
    for value in data:
        value ^= crc & 0xff
        value ^= (value << 4) & 0xff
        crc = ((crc >> 8) ^ (value << 8) ^ (value << 3) ^ (value >> 4)) & 0xffff
    return bytes((crc & 0xff, crc >> 8))


class _Radio:
    def __init__(self, reader):
        self.reader = reader
        # Maximum gain produces false receive frames with the mobile card at
        # this reader; use 33 dB while preserving the other RF configuration bits.
        gain = reader._read(reader.RF_CFG)
        reader._write(reader.RF_CFG, (gain & ~0x70) | 0x40)

    def exchange(self, data, timeout, last_bits=0, no_card=False):
        r = self.reader
        if not 0 < timeout <= _MAX_WAIT or not 0 < len(data) <= 64:
            raise HceError("radio: limit")
        ticks = max(1, math.ceil(timeout * 13_560_000 / 8191))
        if ticks > 65535:
            raise HceError("radio: timer limit")
        r._write(r.T_MODE, 0x8f)
        r._write(r.T_PRESCALER, 0xff)
        r._write(r.T_RELOAD_H, ticks >> 8)
        r._write(r.T_RELOAD_L, ticks & 0xff)
        r._write(r.COMMAND, r.IDLE)
        r._write(r.COM_IRQ, 0x7f)
        r._write(r.FIFO_LEVEL, 0x80)
        r._write(r.FIFO_DATA, *data)
        r._write(r.BIT_FRAMING, last_bits)
        r._write(r.COMMAND, r.TRANSCEIVE)
        r._set_bits(r.BIT_FRAMING, 0x80)
        deadline = time.monotonic() + timeout + 0.1
        try:
            while True:
                irq = r._read(r.COM_IRQ)
                if irq & 0x20:
                    break
                if irq & 0x01:
                    if r._read(r.ERROR) & 0x1b:
                        raise HceError("radio: receive error")
                    if no_card and r._read(r.FIFO_LEVEL) == 0:
                        raise _NoCard()
                    raise HceError("radio: timeout")
                if irq & 0x10:
                    break
                if time.monotonic() >= deadline:
                    raise HceError("radio: timer did not expire")
                if no_card:
                    time.sleep(0.001)
            if r._read(r.ERROR) & 0x1b:
                raise HceError("radio: receive error")
            if r._read(r.CONTROL) & 0x07:
                raise HceError("radio: partial frame")
            count = r._read(r.FIFO_LEVEL)
            if count == 0:
                if no_card:
                    raise _NoCard()
                raise HceError("radio: empty frame")
            if count > 64:
                raise HceError("radio: frame limit")
            return bytes(r._read(r.FIFO_DATA) for _ in range(count))
        finally:
            r._clear_bits(r.BIT_FRAMING, 0x80)
            r._write(r.COMMAND, r.IDLE)

    def frame(self, data, timeout):
        raw = self.exchange(data + _crc_a(data), timeout)
        if len(raw) < 3 or _crc_a(raw[:-2]) != raw[-2:]:
            raise HceError("radio: invalid CRC or frame length")
        return raw[:-2]


def _activate(radio):
    radio.reader._clear_bits(radio.reader.COLL, 0x80)
    atqa = radio.exchange(b"\x26", 0.05, 7, no_card=True)
    if len(atqa) != 2:
        raise HceError("activation: invalid ATQA")
    for index, cascade in enumerate((0x93, 0x95, 0x97)):
        part = radio.exchange(bytes((cascade, 0x20)), 0.05)
        if len(part) != 5 or part[0] ^ part[1] ^ part[2] ^ part[3] != part[4]:
            raise HceError("activation: anticollision failed")
        sak = radio.frame(bytes((cascade, 0x70)) + part, 0.05)
        if len(sak) != 1:
            raise HceError("activation: invalid SAK")
        cascades = bool(sak[0] & 0x04)
        if cascades != (part[0] == 0x88) or (cascades and index == 2):
            raise HceError("activation: invalid cascade")
        if not cascades:
            if not sak[0] & 0x20:
                raise HceError("activation: not ISO-DEP")
            return
    raise HceError("activation: cascade limit")


class _IsoDep:
    def __init__(self, radio):
        self.radio = radio
        self.active = False
        self.bn = 0
        self.fwt = 4096 / 13_560_000 * 16
        self.fsc = 16

    def start(self):
        # FSDI=5: maximum received frame is the MFRC522's 64-byte FIFO.
        self.active = True
        ats = self.radio.frame(b"\xe0\x50", 0.05)
        if not ats or ats[0] != len(ats):
            raise HceError("ATS: invalid length")
        fsci, fwi, sfgi, pos = 2, 4, 0, 1
        if len(ats) > 1:
            t0 = ats[1]
            fsci, pos = t0 & 15, 2
            if fsci > 8 or t0 & 0x80:
                raise HceError("ATS: invalid format")
            if t0 & 0x10:
                pos += 1
            if t0 & 0x20:
                if pos >= len(ats):
                    raise HceError("ATS: missing timing")
                fwi, sfgi = ats[pos] >> 4, ats[pos] & 15
                pos += 1
            if t0 & 0x40:
                pos += 1
        if pos > len(ats) or fwi == 15 or sfgi == 15:
            raise HceError("ATS: invalid interface bytes")
        self.fsc = min((16, 24, 32, 40, 48, 64, 96, 128, 256)[fsci], 64)
        self.fwt = 4096 / 13_560_000 * (1 << fwi)
        if self.fwt + 0.02 > _MAX_WAIT:
            raise HceError("ATS: wait limit")
        if sfgi:
            time.sleep(4096 / 13_560_000 * (1 << sfgi))

    def send(self, data):
        timeout = self.fwt + 0.02
        for _ in range(_MAX_WTX + 1):
            response = self.radio.frame(data, timeout)
            if response == b"\xc2":
                try:
                    self.radio.frame(b"\xc2", 0.05)
                except HceError:
                    pass
                self.active = False
                raise HceError("ISO-DEP: card deselected")
            if response[:1] != b"\xf2":
                return response
            if len(response) != 2 or not 1 <= response[1] <= 59:
                raise HceError("ISO-DEP: invalid WTX")
            timeout = self.fwt * response[1] + 0.02
            if timeout > _MAX_WAIT:
                raise HceError("ISO-DEP: WTX wait limit")
            data = response
        raise HceError("ISO-DEP: WTX count limit")

    def apdu(self, apdu):
        if not apdu or len(apdu) > _MAX_INF:
            raise HceError("ISO-DEP: command limit")
        capacity = self.fsc - 3  # PCB and CRC, no CID or NAD.
        response = b""
        for offset in range(0, len(apdu), capacity):
            chunk = apdu[offset:offset + capacity]
            more = offset + len(chunk) < len(apdu)
            frame = bytes((0x02 | self.bn | (0x10 if more else 0),)) + chunk
            for _ in range(3):
                response = self.send(frame)
                if response == bytes((0xb2 | self.bn,)):
                    continue
                if not more:
                    break
                if response == bytes((0xa2 | (self.bn ^ 1),)):
                    self.bn ^= 1
                    break
                raise HceError("ISO-DEP: invalid command acknowledgement")
            else:
                raise HceError("ISO-DEP: retry limit")
        result = bytearray()
        for _ in range(_MAX_BLOCKS):
            if not response or response[0] & 0xee != 0x02:
                raise HceError("ISO-DEP: invalid response block")
            if response[0] & 1 != self.bn:
                raise HceError("ISO-DEP: response block number")
            result.extend(response[1:])
            if len(result) > _MAX_INF:
                raise HceError("ISO-DEP: response limit")
            self.bn ^= 1
            if not response[0] & 0x10:
                return bytes(result)
            response = self.send(bytes((0xa2 | self.bn,)))
        raise HceError("ISO-DEP: block limit")

    def close(self):
        if self.active:
            self.active = False
            try:
                self.radio.frame(b"\xc2", 0.05)
            except Exception:
                # Cleanup must not mask the original result or leak device errors.
                pass


def _student_number(response):
    # APK makeArrary: 13 left-zero-padded digits, a zero padding nibble,
    # one degree byte, eight zero bytes, then the APDU status.
    if (len(response) != 18 or response[-2:] != b"\x90\x00"
            or response[6] & 0x0f or response[8:16] != b"\x00" * 8):
        raise HceError("read: invalid response")
    digits = []
    for byte in response[:6]:
        digits.extend((byte >> 4, byte & 15))
    digits.append(response[6] >> 4)
    if any(digit > 9 for digit in digits):
        raise HceError("read: invalid number encoding")
    number = "".join(str(digit) for digit in digits).lstrip("0")
    if not 8 <= len(number) <= 10:
        raise HceError("read: invalid number length")
    return number


def read_student_number(reader):
    """Return an unverified 8–10 digit number, or None for no selectable new card.

    Other failures raise HceError with a non-identifying reason. Calls require
    exclusive reader access. A deselected held card stays halted until re-presented.
    """
    session = None
    try:
        radio = _Radio(reader)
        try:
            _activate(radio)
        except _NoCard:
            return None
        session = _IsoDep(radio)
        session.start()
        selected = session.apdu(_SELECT)
        if len(selected) < 2 or selected[-2:] != b"\x90\x00":
            raise HceError("select: application rejected")
        return _student_number(session.apdu(_READ))
    except HceError:
        raise
    except Exception:
        raise HceError("reader: local failure") from None
    finally:
        if session is not None:
            session.close()
