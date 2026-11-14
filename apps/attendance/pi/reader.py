#!/usr/bin/env python3
"""RC522에서 Android 모바일 학생증 HCE 학번을 읽어 같은 Pi의 LAN 서버로 전송한다.

ATTENDANCE_URL은 http://127.0.0.1:8080, DEVICE_TOKEN은 LAN 서버의 장치 토큰이다.
QUEUE_FILE은 선택 사항이며 장애 시 태그를 비공개 큐에 저장하고 순서대로 재전송한다.
UID나 일반 USB 키보드 리더 입력을 학번으로 추정하지 않는다.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

from hce import HceError, read_student_number

FLUSH_INTERVAL_SECONDS = 30
REQUEST_TIMEOUT_SECONDS = 10
LAN_URL = "http://127.0.0.1:8080"

# rc522 배선(BCM 번호). SPI0 CE0(GPIO8)·SCK(11)·MOSI(10)·MISO(9)는 spidev가 쓴다.
RC522_RST_PIN = 25
GREEN_LED_PIN = 23
RED_LED_PIN = 24
POLL_INTERVAL_SECONDS = 0.1
# 시작·RF 복구 후에도 카드가 없는 상태가 이 시간만큼 확인돼야 다시 태그를 받는다.
REPEAT_GUARD_SECONDS = 2.0


def read_queue(path):
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            return [json.loads(line) for line in handle if line.strip()]
    except FileNotFoundError:
        return []


def write_queue(path, entries):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    temporary = path + ".tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        os.fchmod(handle.fileno(), 0o600)
        for entry in entries:
            handle.write(json.dumps(entry) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# The local device token must not traverse an environment-configured HTTP proxy.
HTTP_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def send(url, token, entry):
    """서버 처리 결과, 영구 거절이면 rejected, 재시도해야 하면 None."""
    if url.rstrip("/") != LAN_URL:
        raise ValueError("ATTENDANCE_URL must be " + LAN_URL)
    request = urllib.request.Request(
        LAN_URL + "/api/taps",
        data=json.dumps(entry).encode(),
        headers={"authorization": "Bearer " + token, "content-type": "application/json"},
        method="POST",
    )
    try:
        with HTTP_OPENER.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = response.read().decode()
            print("태그 전송:", response.status, flush=True)
            try:
                outcome = json.loads(body).get("status")
                return outcome if outcome in ("check-in", "check-out", "ignored") else None
            except (ValueError, AttributeError):
                return None
    except urllib.error.HTTPError as error:
        print("태그 전송 실패:", error.code, flush=True)
        # 리디렉션·인증 오류·서버 오류·속도 제한은 복구 후 다시 보내도록 보관한다.
        if 300 <= error.code < 400 or error.code in (401, 403, 408, 429) or error.code >= 500:
            return None
        return "rejected"
    except (urllib.error.URLError, TimeoutError, OSError):
        print("전송 실패, 큐에 보관", flush=True)
        return None


def valid_entry(entry):
    return (isinstance(entry, dict)
            and set(entry) == {"studentNumber", "at"}
            and valid_student_number(entry["studentNumber"])
            and type(entry["at"]) is int)


def valid_student_number(number):
    return (isinstance(number, str) and 8 <= len(number) <= 10
            and number.isascii() and number.isdigit())


def flush_queue(url, token, queue_file):
    """큐를 앞에서부터 보낸다. 큐를 모두 비웠으면 마지막 항목의 처리 결과, 아니면 None."""
    entries = read_queue(queue_file)
    if not entries:
        return None
    remaining = list(entries)
    outcome = None
    while remaining:
        outcome = send(url, token, remaining[0]) if valid_entry(remaining[0]) else "rejected"
        if outcome is None:
            break
        remaining.pop(0)
    if len(remaining) != len(entries):
        write_queue(queue_file, remaining)
    return None if remaining else outcome


def record_tap(url, token, queue_file, student_number):
    """유효한 학번만 큐에 넣고 바로 전송한다."""
    if not valid_student_number(student_number):
        return "rejected"
    entries = read_queue(queue_file)
    entries.append({"studentNumber": student_number, "at": int(time.time() * 1000)})
    write_queue(queue_file, entries)
    return flush_queue(url, token, queue_file) or "queued"


class Mfrc522:
    """spidev로 MFRC522를 직접 다루며 HCE 교환은 hce 모듈에 맡긴다."""

    COMMAND, COM_IRQ, ERROR, FIFO_DATA, FIFO_LEVEL, CONTROL, BIT_FRAMING, COLL = (
        0x01, 0x04, 0x06, 0x09, 0x0A, 0x0C, 0x0D, 0x0E)
    MODE, TX_MODE, RX_MODE, TX_CONTROL, TX_ASK = 0x11, 0x12, 0x13, 0x14, 0x15
    MOD_WIDTH, RF_CFG = 0x24, 0x26
    T_MODE, T_PRESCALER, T_RELOAD_H, T_RELOAD_L, VERSION = 0x2A, 0x2B, 0x2C, 0x2D, 0x37
    IDLE, TRANSCEIVE = 0x00, 0x0C

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
        self._configure()

    def _configure(self):
        self._write(self.COMMAND, self.IDLE)
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
        self._write(self.RF_CFG, (self._read(self.RF_CFG) & ~0x70) | 0x40)  # HCE: 33 dB
        self._set_bits(self.TX_CONTROL, 0x03)  # 안테나 켬
        time.sleep(0.005)

    def ensure_ready(self):
        # A chip reset leaves SPI responsive but RF off; the host process survives.
        if (self._read(self.MODE) == 0x3D
                and self._read(self.TX_ASK) & 0x40
                and self._read(self.TX_CONTROL) & 0x03 == 0x03):
            return False
        if self._read(self.VERSION) in (0x00, 0xFF):
            raise RuntimeError("RC522 응답 없음(배선·전원 확인)")
        self._configure()
        return True

    def _write(self, reg, *values):
        self.spi.xfer2([(reg << 1) & 0x7E, *values])

    def _read(self, reg):
        return self.spi.xfer2([((reg << 1) & 0x7E) | 0x80, 0])[1]

    def _set_bits(self, reg, mask):
        self._write(reg, self._read(reg) | mask)

    def _clear_bits(self, reg, mask):
        self._write(reg, self._read(reg) & ~mask & 0xFF)



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


class _TapGate:
    """Only fresh presentations count; startup/RF resets never toggle a held card."""
    def __init__(self):
        self.reset()

    def reset(self):
        self.armed = False
        self.last_number = None
        self.absent_since = None

    def failed(self):
        self.absent_since = None

    def observe(self, number, now):
        if number is None:
            if self.absent_since is None:
                self.absent_since = now
            if now - self.absent_since >= REPEAT_GUARD_SECONDS:
                self.armed, self.last_number = True, None
            return False
        self.absent_since = None
        if not self.armed or number == self.last_number:
            return False
        self.last_number = number
        return True


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
        gate = _TapGate()
        last_flush = time.monotonic()
        while True:
            try:
                if reader.ensure_ready():
                    print("RC522 RF 설정 초기화 감지: 설정 복원", flush=True)
                    gate.reset()
                student_number = read_student_number(reader)
            except Exception as error:
                reason = str(error) if isinstance(error, HceError) else "reader: local failure"
                print("학생증 인식 실패:", reason, flush=True)
                gate.failed()
            else:
                now = time.monotonic()
                if student_number is None:
                    gate.observe(None, now)
                elif not valid_student_number(student_number):
                    feedback.result("rejected")
                elif gate.observe(student_number, now):
                    feedback.result(record_tap(url, token, queue_file, student_number))
                    last_flush = time.monotonic()
            now = time.monotonic()
            if now - last_flush >= FLUSH_INTERVAL_SECONDS:
                flush_queue(url, token, queue_file)
                last_flush = time.monotonic()
            time.sleep(POLL_INTERVAL_SECONDS)
    finally:
        GPIO.cleanup()


def main():
    url = os.environ["ATTENDANCE_URL"]
    if url.rstrip("/") != LAN_URL:
        raise ValueError("ATTENDANCE_URL must be " + LAN_URL)
    token = os.environ["DEVICE_TOKEN"]
    queue_file = os.environ.get("QUEUE_FILE", "/var/lib/attendance/queue.jsonl")
    os.makedirs(os.path.dirname(queue_file), mode=0o700, exist_ok=True)
    os.chmod(os.path.dirname(queue_file), 0o700)
    run_rc522(url, token, queue_file)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("리더 오류로 종료", flush=True)
        sys.exit(1)
