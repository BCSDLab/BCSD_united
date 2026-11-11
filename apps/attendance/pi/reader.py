#!/usr/bin/env python3
"""USB HID(키보드 에뮬레이션) RFID 리더의 태그를 출근부 Worker로 전송한다.

리더는 카드 UID를 숫자·영문 키 입력 후 Enter로 보내는 일반 USB 리더를 가정한다.
리더 장치를 독점(grab)해 UID가 콘솔 입력으로 새지 않게 한다.
네트워크가 끊기면 태그를 QUEUE_FILE에 쌓았다가 다음 태그·유휴 주기에 순서대로 재전송한다.

환경 변수:
  ATTENDANCE_URL    예: https://bcsd-attendance.<account>.workers.dev
  DEVICE_TOKEN      Worker의 DEVICE_TOKEN 시크릿과 같은 값
  READER_DEVICE     USB HID 입력 장치 경로. 기본값은 /dev/input/by-id/ 의 첫 *-event-kbd
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
    """True: 서버가 처리했거나 영구 거절(재전송해도 소용없음). False: 나중에 재시도."""
    request = urllib.request.Request(
        url.rstrip("/") + "/api/taps",
        data=json.dumps(entry).encode(),
        headers={"authorization": "Bearer " + token, "content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            print(entry["uid"], response.status, response.read().decode(), flush=True)
            return True
    except urllib.error.HTTPError as error:
        print(entry["uid"], error.code, error.read().decode(), flush=True)
        # 인증 오류·서버 오류·속도 제한은 설정/복구 후 다시 보내야 하므로 큐에 남긴다.
        return error.code not in (401, 403, 408, 429) and error.code < 500
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        print("전송 실패, 큐에 보관:", error, flush=True)
        return False


def flush_queue(url, token, queue_file):
    entries = read_queue(queue_file)
    if not entries:
        return
    remaining = list(entries)
    while remaining and send(url, token, remaining[0]):
        remaining.pop(0)
    if len(remaining) != len(entries):
        write_queue(queue_file, remaining)


def record_tap(url, token, queue_file, uid):
    if not MIN_UID_LENGTH <= len(uid) <= MAX_UID_LENGTH:
        print("무시한 입력 길이:", len(uid), flush=True)
        return
    entries = read_queue(queue_file)
    entries.append({"uid": uid, "at": int(time.time() * 1000)})
    write_queue(queue_file, entries)
    flush_queue(url, token, queue_file)


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


def main():
    url = os.environ["ATTENDANCE_URL"]
    token = os.environ["DEVICE_TOKEN"]
    queue_file = os.environ.get("QUEUE_FILE", "/var/lib/attendance/queue.jsonl")
    run_keyboard(url, token, queue_file)


if __name__ == "__main__":
    main()
