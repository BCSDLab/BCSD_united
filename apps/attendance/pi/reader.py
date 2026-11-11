#!/usr/bin/env python3
"""RFID 리더의 태그를 출근부 Worker로 전송한다.

리더 종류(READER):
  rc522  Raspberry Pi GPIO(SPI)에 직접 연결한 RC522(MFRC522) 모듈. 카드 UID를 16진수 대문자로 보낸다.
         태그 결과를 LED 두 개(초록·빨강)로 알린다. 배선은 ../README.md 의 "라즈베리파이" 절.
  hid    (기본값) 카드 UID를 숫자·영문 키 입력 후 Enter로 보내는 일반 USB 리더. 장치를 독점(grab)해
         UID가 콘솔 입력으로 새지 않게 한다.
네트워크가 끊기면 태그를 QUEUE_FILE에 쌓았다가 다음 태그·유휴 주기에 순서대로 재전송한다.

환경 변수:
  ATTENDANCE_URL    예: https://bcsd-attendance.<account>.workers.dev
  DEVICE_TOKEN      Worker의 DEVICE_TOKEN 시크릿과 같은 값
  READER            rc522 | hid (기본 hid)
  READER_DEVICE     (hid) USB HID 입력 장치 경로. 기본값은 /dev/input/by-id/ 의 첫 *-event-kbd
  QUEUE_FILE        기본값 /var/lib/attendance/queue.jsonl
"""

import glob
import json
import os
import select
import sys
import time
import urllib.error
import urllib.request

try:
    from evdev import InputDevice, ecodes
except ImportError:
    InputDevice = ecodes = None

FLUSH_INTERVAL_SECONDS = 30
REQUEST_TIMEOUT_SECONDS = 10
# 한 번 태그로 인정하는 UID 문자 범위. 서버의 UID_PATTERN과 같아야 한다.
MIN_UID_LENGTH = 4
MAX_UID_LENGTH = 32

# rc522 배선(BCM 번호). SPI0 CE0(GPIO8)·SCK(11)·MOSI(10)·MISO(9)는 spidev가 쓴다.
RC522_RST_PIN = 25
GREEN_LED_PIN = 23
RED_LED_PIN = 24
POLL_INTERVAL_SECONDS = 0.1
# 카드를 떼었다 다시 댄 같은 카드를 한 번으로 보는 시간. 서버도 10초 안의 중복 태그를 무시한다.
REPEAT_GUARD_SECONDS = 2.0


def build_keymap():
    keymap = {}
    for name, code in ecodes.ecodes.items():
        if not isinstance(name, str) or not name.startswith("KEY_"):
            continue
        suffix = name[4:]
        if len(suffix) == 1 and suffix.isalnum():
            keymap[code] = suffix
        elif suffix.startswith("KP") and len(suffix) == 3 and suffix[2].isdigit():
            keymap[code] = suffix[2]
    return keymap


def find_device_path():
    explicit = os.environ.get("READER_DEVICE")
    if explicit:
        return explicit
    candidates = sorted(glob.glob("/dev/input/by-id/*-event-kbd"))
    if not candidates:
        sys.exit("리더 장치를 찾지 못했습니다. READER_DEVICE로 경로를 지정하세요.")
    return candidates[0]


def read_queue(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]
    except FileNotFoundError:
        return []


def write_queue(path, entries):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        for entry in entries:
            handle.write(json.dumps(entry) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def send(url, token, entry):
    """서버 처리 결과(응답의 status, 영구 거절이면 "rejected")를 돌려준다. 나중에 재시도해야 하면 None."""
    request = urllib.request.Request(
        url.rstrip("/") + "/api/taps",
        data=json.dumps(entry).encode(),
        headers={"authorization": "Bearer " + token, "content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = response.read().decode()
            print(entry["uid"], response.status, body, flush=True)
            try:
                return json.loads(body).get("status") or "ok"
            except (ValueError, AttributeError):
                return "ok"
    except urllib.error.HTTPError as error:
        print(entry["uid"], error.code, error.read().decode(), flush=True)
        # 인증 오류·서버 오류·속도 제한은 설정/복구 후 다시 보내야 하므로 큐에 남긴다.
        if error.code in (401, 403, 408, 429) or error.code >= 500:
            return None
        return "rejected"
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        print("전송 실패, 큐에 보관:", error, flush=True)
        return None


def flush_queue(url, token, queue_file):
    """큐를 앞에서부터 보낸다. 큐를 모두 비웠으면 마지막 항목의 처리 결과, 아니면 None."""
    entries = read_queue(queue_file)
    if not entries:
        return None
    remaining = list(entries)
    outcome = None
    while remaining:
        outcome = send(url, token, remaining[0])
        if outcome is None:
            break
        remaining.pop(0)
    if len(remaining) != len(entries):
        write_queue(queue_file, remaining)
    return None if remaining else outcome


def record_tap(url, token, queue_file, uid):
    """태그를 큐에 넣고 바로 전송한다. 이 태그의 처리 결과, 전송하지 못했으면 "queued"."""
    if not MIN_UID_LENGTH <= len(uid) <= MAX_UID_LENGTH:
        print("무시한 입력 길이:", len(uid), flush=True)
        return "rejected"
    entries = read_queue(queue_file)
    entries.append({"uid": uid, "at": int(time.time() * 1000)})
    write_queue(queue_file, entries)
    return flush_queue(url, token, queue_file) or "queued"


def run_keyboard(url, token, queue_file):
    if InputDevice is None:
        sys.exit("python3-evdev가 필요합니다: sudo apt install python3-evdev")
    keymap = build_keymap()
    device = InputDevice(find_device_path())
    device.grab()
    print("리더 대기 중:", device.name, flush=True)

    buffer = ""
    last_flush = time.monotonic()
    while True:
        readable, _, _ = select.select([device.fd], [], [], FLUSH_INTERVAL_SECONDS)
        if not readable:
            flush_queue(url, token, queue_file)
            last_flush = time.monotonic()
            continue
        for event in device.read():
            if event.type != ecodes.EV_KEY or event.value != 1:  # 키 누름만 처리
                continue
            if event.code in (ecodes.KEY_ENTER, ecodes.KEY_KPENTER):
                uid, buffer = buffer, ""
                if uid:
                    record_tap(url, token, queue_file, uid)
                    last_flush = time.monotonic()
            elif event.code in keymap:
                buffer += keymap[event.code]
        if time.monotonic() - last_flush >= FLUSH_INTERVAL_SECONDS:
            flush_queue(url, token, queue_file)
            last_flush = time.monotonic()


class Mfrc522:
    """spidev로 MFRC522를 직접 다루는 최소 구현. ISO 14443A 카드 하나의 UID(4·7·10바이트)만 읽는다."""

    COMMAND, COM_IRQ, DIV_IRQ, ERROR, FIFO_DATA, FIFO_LEVEL, CONTROL, BIT_FRAMING, COLL = (
        0x01, 0x04, 0x05, 0x06, 0x09, 0x0A, 0x0C, 0x0D, 0x0E)
    MODE, TX_MODE, RX_MODE, TX_CONTROL, TX_ASK = 0x11, 0x12, 0x13, 0x14, 0x15
    CRC_RESULT_H, CRC_RESULT_L, MOD_WIDTH, RF_CFG = 0x21, 0x22, 0x24, 0x26
    T_MODE, T_PRESCALER, T_RELOAD_H, T_RELOAD_L, VERSION = 0x2A, 0x2B, 0x2C, 0x2D, 0x37
    IDLE, CALC_CRC, TRANSCEIVE = 0x00, 0x03, 0x0C
    # 카드 응답 대기 상한. 칩 타이머(25 ms)가 먼저 끝나는 것이 정상이다.
    WAIT_SECONDS = 0.05

    def __init__(self, spi, gpio, rst_pin):
        spi.open(0, 0)
        spi.max_speed_hz = 1_000_000
        spi.mode = 0
        self.spi = spi
        gpio.setup(rst_pin, gpio.OUT)
        gpio.output(rst_pin, gpio.LOW)
        time.sleep(0.01)
        gpio.output(rst_pin, gpio.HIGH)
        time.sleep(0.05)
        self.version = self._read(self.VERSION)
        if self.version in (0x00, 0xFF):
            raise RuntimeError("RC522 응답 없음(배선·SPI 활성화 확인)")
        self._write(self.TX_MODE, 0x00)
        self._write(self.RX_MODE, 0x00)
        self._write(self.MOD_WIDTH, 0x26)
        # 타이머: 전송이 끝나면 자동 시작, 약 25 ms 뒤 응답 없음으로 본다.
        self._write(self.T_MODE, 0x80)
        self._write(self.T_PRESCALER, 0xA9)
        self._write(self.T_RELOAD_H, 0x03)
        self._write(self.T_RELOAD_L, 0xE8)
        self._write(self.TX_ASK, 0x40)  # 100% ASK
        self._write(self.MODE, 0x3D)  # CRC 초기값 0x6363(ISO 14443A)
        self._write(self.RF_CFG, 0x70)  # 수신 이득 최대(48 dB): 케이스 벽 너머로도 읽히게
        self._set_bits(self.TX_CONTROL, 0x03)  # 안테나 켬

    def _write(self, reg, *values):
        self.spi.xfer2([(reg << 1) & 0x7E, *values])

    def _read(self, reg):
        return self.spi.xfer2([((reg << 1) & 0x7E) | 0x80, 0])[1]

    def _set_bits(self, reg, mask):
        self._write(reg, self._read(reg) | mask)

    def _clear_bits(self, reg, mask):
        self._write(reg, self._read(reg) & ~mask & 0xFF)

    def _transceive(self, data, tx_last_bits=0):
        """카드와 프레임을 주고받는다. 응답 바이트 목록, 응답이 없거나 오류(충돌 포함)면 None."""
        self._write(self.COMMAND, self.IDLE)
        self._write(self.COM_IRQ, 0x7F)
        self._write(self.FIFO_LEVEL, 0x80)
        self._write(self.FIFO_DATA, *data)
        self._write(self.BIT_FRAMING, tx_last_bits)
        self._write(self.COMMAND, self.TRANSCEIVE)
        self._set_bits(self.BIT_FRAMING, 0x80)  # StartSend
        deadline = time.monotonic() + self.WAIT_SECONDS
        try:
            while True:
                irq = self._read(self.COM_IRQ)
                if irq & 0x30:  # RxIRq | IdleIRq
                    break
                if irq & 0x01 or time.monotonic() > deadline:  # TimerIRq
                    return None
        finally:
            self._clear_bits(self.BIT_FRAMING, 0x80)
        if self._read(self.ERROR) & 0x1B:  # BufferOvfl | CollErr | ParityErr | ProtocolErr
            return None
        return [self._read(self.FIFO_DATA) for _ in range(self._read(self.FIFO_LEVEL))]

    def _crc(self, data):
        self._write(self.COMMAND, self.IDLE)
        self._write(self.DIV_IRQ, 0x04)
        self._write(self.FIFO_LEVEL, 0x80)
        self._write(self.FIFO_DATA, *data)
        self._write(self.COMMAND, self.CALC_CRC)
        deadline = time.monotonic() + self.WAIT_SECONDS
        while not self._read(self.DIV_IRQ) & 0x04:
            if time.monotonic() > deadline:
                raise RuntimeError("RC522 CRC 계산 시간 초과")
        self._write(self.COMMAND, self.IDLE)
        return [self._read(self.CRC_RESULT_L), self._read(self.CRC_RESULT_H)]

    def read_uid(self):
        """대기(IDLE) 상태 카드 하나의 UID를 16진수 대문자로 읽고 HALT시킨다. 없으면 None.

        HALT된 카드는 REQA에 답하지 않으므로, 카드를 떼었다 다시 대야 다시 읽힌다.
        """
        self._clear_bits(self.COLL, 0x80)
        atqa = self._transceive([0x26], tx_last_bits=7)  # REQA(7비트)
        if not atqa or len(atqa) != 2:
            return None
        uid = []
        for cascade in (0x93, 0x95, 0x97):
            part = self._transceive([cascade, 0x20])  # ANTICOLLISION: UID 4바이트 + BCC
            if not part or len(part) != 5 or part[0] ^ part[1] ^ part[2] ^ part[3] != part[4]:
                return None
            frame = [cascade, 0x70, *part]  # SELECT
            sak = self._transceive(frame + self._crc(frame))
            if not sak or len(sak) != 3:
                return None
            if sak[0] & 0x04:  # UID가 더 남음: 첫 바이트는 캐스케이드 태그(0x88)
                uid += part[1:4]
                continue
            uid += part[0:4]
            halt = [0x50, 0x00]
            self._transceive(halt + self._crc(halt))  # 응답이 없는 것이 정상
            return bytes(uid).hex().upper()
        return None


class Feedback:
    """태그 결과를 초록·빨강 LED로 알린다."""

    # 결과 → (LED 핀, 켜짐 초, 꺼짐 초, 횟수)
    PATTERNS = {
        "check-in": (GREEN_LED_PIN, 1.0, 0.0, 1),
        "check-out": (GREEN_LED_PIN, 0.25, 0.2, 2),
        "ignored": (GREEN_LED_PIN, 0.15, 0.0, 1),
        "unknown": (RED_LED_PIN, 1.0, 0.0, 1),
        "queued": (RED_LED_PIN, 0.25, 0.2, 2),
        "rejected": (RED_LED_PIN, 0.15, 0.15, 3),
    }

    def __init__(self, gpio):
        self.gpio = gpio
        for pin in (GREEN_LED_PIN, RED_LED_PIN):
            gpio.setup(pin, gpio.OUT, initial=gpio.LOW)

    def _pulse(self, pin, on, off=0.0, times=1):
        for i in range(times):
            self.gpio.output(pin, self.gpio.HIGH)
            time.sleep(on)
            self.gpio.output(pin, self.gpio.LOW)
            if i < times - 1:
                time.sleep(off)

    def startup(self):
        self._pulse(GREEN_LED_PIN, 0.3)
        self._pulse(RED_LED_PIN, 0.3)

    def result(self, outcome):
        self._pulse(*self.PATTERNS.get(outcome, self.PATTERNS["rejected"]))


def run_rc522(url, token, queue_file):
    try:
        import RPi.GPIO as GPIO
        import spidev
    except ImportError:
        sys.exit("python3-spidev와 python3-rpi.gpio(또는 python3-rpi-lgpio)가 필요합니다")
    GPIO.setwarnings(False)
    GPIO.setmode(GPIO.BCM)
    try:
        feedback = Feedback(GPIO)
        reader = Mfrc522(spidev.SpiDev(), GPIO, RC522_RST_PIN)
        print(f"RC522 대기 중: 버전 0x{reader.version:02X}", flush=True)
        feedback.startup()
        last_uid, last_at = None, 0.0
        last_flush = time.monotonic()
        while True:
            uid = reader.read_uid()
            now = time.monotonic()
            if uid and not (uid == last_uid and now - last_at < REPEAT_GUARD_SECONDS):
                last_uid, last_at = uid, now
                feedback.result(record_tap(url, token, queue_file, uid))
                last_flush = time.monotonic()
            elif now - last_flush >= FLUSH_INTERVAL_SECONDS:
                flush_queue(url, token, queue_file)
                last_flush = time.monotonic()
            time.sleep(POLL_INTERVAL_SECONDS)
    finally:
        GPIO.cleanup()


def main():
    url = os.environ["ATTENDANCE_URL"]
    token = os.environ["DEVICE_TOKEN"]
    queue_file = os.environ.get("QUEUE_FILE", "/var/lib/attendance/queue.jsonl")
    reader = os.environ.get("READER", "hid")
    if reader == "rc522":
        run_rc522(url, token, queue_file)
    elif reader == "hid":
        run_keyboard(url, token, queue_file)
    else:
        sys.exit(f"알 수 없는 READER: {reader} (rc522 | hid)")


if __name__ == "__main__":
    main()
