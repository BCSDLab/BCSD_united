#!/usr/bin/env python3
"""Internal 회원 조회와 private SQLite를 사용하는 LAN 출근부 서버.

출입 원장은 SQLite이며 Worker에는 허용된 조회 응답의 스냅샷만 게시한다.
HTTPS 조회는 원래 Internal 호스트의 SNI·인증서를 검증하는 loopback SSH
전달을 사용한다. 학번은 원장에 저장하지 않는다. 익명 방문자 연관 정보는
6시간의 제한된 프로세스 메모리에만 두며 재시작·캐시 퇴출 시 유지하지 않는다.

Jam은 운영자가 실제 초대 링크로 생성한 root 소유 PNG만 사용한다.
JAM_QR_FILE 기본값은 /opt/attendance/lan/spotify-jam.png이며 시작할 때 읽는다.
디렉터리·파일은 group/world 쓰기가 금지되어야 하며 서비스가 읽을 수 있어야 한다.
미설정·손상된 이미지는 숨긴다. PNG는 64 KiB·한 변 2048픽셀 이내의
비인터레이스 이미지만 허용하고 URL·계정 비밀값은 받지 않는다.
"""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hmac
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import socket
import sqlite3
import ssl
import stat
import threading
import time
import unicodedata
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

DAY = 86_400_000
OFFSET = 9 * 3_600_000
MAX_SESSION = 6 * 3_600_000
MAX_BODY = 4096
MAX_GUEST_TAPS = 1024
MAX_MONITOR_BODY = 8192
MONITOR_PATH = "/v1/service/attendance/monitor"
MONITOR_MAX_AGE = 60_000
MAX_KOIN_BODY = 4096
KOIN_TIMEOUT = 3
KOIN_READINESS_PATH = "/actuator/health/readiness"
KOIN_SERVICES = (
    ("prod-api", "KOIN API 운영", "api.koreatech.in"),
    ("stage-api", "KOIN API 개발", "api.stage.koreatech.in"),
)
WORKER_TIMEOUT = 3
WORKER_CACHE_SECONDS = 60
WORKER_ENDPOINTS = (
    ("koin-web", "WEB", "koreatech.in", "/"),
)
MAX_SAFE_INTEGER = 9_007_199_254_740_991
SPOTIFY_PATH = Path("/run/raspotify/now-playing.json")
MAX_SPOTIFY_BODY = 8192
MAX_QR_PNG_BODY = 65536
_GUEST_HMAC_KEY = os.urandom(32)
HOST = "0.0.0.0"
PORT = 8080
HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
}


def now_ms():
    return time.time_ns() // 1_000_000


def day_start(at):
    return ((at + OFFSET) // DAY) * DAY - OFFSET


def week_start(at):
    start = day_start(at)
    return start - (((start + OFFSET) // DAY + 3) % 7) * DAY


def unrecorded(row, now):
    return bool(row["autoClosed"]) or (row["checkOut"] is None and now - row["checkIn"] >= MAX_SESSION)


class ForwardedHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        # Hostname verification and SNI use the actual Internal hostname, not localhost.
        raw = socket.create_connection(("127.0.0.1", 18443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


class Attendance:
    def __init__(self):
        url = urlsplit(os.environ["INTERNAL_LOOKUP_URL"])
        if (url.scheme != "https" or url.hostname != "api.internal.bcsdlab.com"
                or url.port not in (None, 443) or url.username or url.password
                or url.path != "/v1/service/attendance/member-lookup" or url.query or url.fragment):
            raise ValueError("Invalid fixed Internal lookup destination")
        self.lookup_path = url.path
        self.lookup_host = url.hostname
        self.lookup_token = self.read_token("INTERNAL_LOOKUP_TOKEN_FILE")
        self.device_token = self.read_token("DEVICE_TOKEN_FILE")
        self.monitor_token = self.read_token("MONITOR_TOKEN_FILE") if os.environ.get("MONITOR_TOKEN_FILE") else None
        if self.monitor_token is not None and self.monitor_token in (self.lookup_token, self.device_token):
            raise ValueError("Monitoring requires a separate dedicated token")
        self.context = ssl.create_default_context()
        self.worker_lock = threading.Lock()
        self.worker_cached = None
        self.worker_expires = 0
        self.spotify_path = SPOTIFY_PATH
        self.jam_qr = self.read_qr_png(Path(os.environ.get("JAM_QR_FILE", "/opt/attendance/lan/spotify-jam.png")))
        self.html = Path(os.environ.get("ATTENDANCE_HTML", "/opt/attendance/lan/dashboard.html")).read_bytes()
        directory = Path(os.environ.get("ATTENDANCE_DATA_DIR", "/var/lib/attendance-lan"))
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.chmod(0o700)
        database = directory / "attendance.sqlite3"
        self.db_lock = threading.Lock()
        self.events = threading.Condition()
        self.revision = 0
        self.greeting_revision = 0
        self.attention_revision = 0
        self.greeting = None
        self.greeting_timer = None
        self.stopping = False
        self.guest_taps = OrderedDict()
        self.guest_timer = None
        self.db = sqlite3.connect(database, check_same_thread=False)
        database.chmod(0o600)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions(
                memberId TEXT NOT NULL REFERENCES members(id),
                checkIn INTEGER NOT NULL,
                checkOut INTEGER,
                autoClosed INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(memberId, checkIn)
            );
            CREATE INDEX IF NOT EXISTS sessions_by_time ON sessions(checkIn);
        """)
        self.qr = {}
        for band, key in (("2.4", "WIFI_QR_24_FILE"), ("5", "WIFI_QR_5_FILE")):
            if os.environ.get(key):
                value = Path(os.environ[key]).read_bytes()
                if not value.startswith(b"\x89PNG\r\n\x1a\n") or len(value) > 65536:
                    raise ValueError("Invalid configured Wi-Fi PNG")
                self.qr[band] = value

    @staticmethod
    def read_qr_png(path):
        """Load an optional operator-provisioned PNG, never a URL or account secret."""
        try:
            parent = path.parent.lstat()
            if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0
                    or parent.st_mode & 0o022):
                return None
            before = path.lstat()
            if not stat.S_ISREG(before.st_mode):
                return None
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            with os.fdopen(os.open(path, flags), "rb") as stream:
                metadata = os.fstat(stream.fileno())
                if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                        or metadata.st_mode & 0o022 or metadata.st_nlink != 1
                        or (before.st_dev, before.st_ino) != (metadata.st_dev, metadata.st_ino)
                        or not 0 < metadata.st_size <= MAX_QR_PNG_BODY):
                    return None
                raw = stream.read(MAX_QR_PNG_BODY + 1)
            return raw if Attendance.valid_qr_png(raw) else None
        except (OSError, ValueError):
            return None

    @staticmethod
    def valid_qr_png(raw):
        """Bound PNG parsing and decompression without an image-library dependency."""
        if not 8 < len(raw) <= MAX_QR_PNG_BODY or raw[:8] != b"\x89PNG\r\n\x1a\n":
            return False
        offset = 8
        header = None
        palette = False
        image = bytearray()
        image_ended = False
        while offset + 12 <= len(raw):
            size = int.from_bytes(raw[offset:offset + 4], "big")
            kind = raw[offset + 4:offset + 8]
            end = offset + 12 + size
            if (end > len(raw) or not all(65 <= byte <= 90 or 97 <= byte <= 122 for byte in kind)
                    or zlib.crc32(raw[offset + 4:end - 4]) != int.from_bytes(raw[end - 4:end], "big")):
                return False
            data = raw[offset + 8:end - 4]
            if header is None:
                if kind != b"IHDR" or size != 13:
                    return False
                width, height = int.from_bytes(data[:4], "big"), int.from_bytes(data[4:8], "big")
                depth, color, compression, filtering, interlace = data[8:]
                depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
                if (not 1 <= width <= 2048 or not 1 <= height <= 2048
                        or depth not in depths.get(color, ()) or compression or filtering or interlace):
                    return False
                channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
                row_bytes = (width * channels * depth + 7) // 8
                expected = (row_bytes + 1) * height
                if expected > 16 * 1024 * 1024:
                    return False
                header = (color, depth, row_bytes, expected)
            elif kind == b"IHDR":
                return False
            elif kind == b"PLTE":
                if palette or image or color in (0, 4) or not size or size % 3 or size > 768:
                    return False
                if color == 3 and size // 3 > 2 ** depth:
                    return False
                palette = True
            elif kind == b"IDAT":
                if image_ended or (color == 3 and not palette):
                    return False
                image.extend(data)
            elif kind == b"IEND":
                if size or end != len(raw) or not image:
                    return False
                try:
                    decoder = zlib.decompressobj()
                    pixels = decoder.decompress(image, expected + 1)
                    return (len(pixels) == expected and decoder.eof
                            and not decoder.unused_data and not decoder.unconsumed_tail
                            and all(pixels[start] <= 4 for start in range(0, expected, row_bytes + 1)))
                except zlib.error:
                    return False
            elif not kind[0] & 0x20:
                return False
            if image and kind != b"IDAT":
                image_ended = True
            offset = end
        return False

    def spotify(self):
        """Read only public receiver metadata; never take the attendance DB lock."""
        empty = {"state": "unknown", "title": "", "artists": [], "updatedAt": None, "coverUrl": None}
        path = self.spotify_path
        try:
            parent = path.parent.lstat()
            trusted = (0, getattr(os, "geteuid", lambda: 0)())
            if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid not in trusted
                    or parent.st_mode & 0o022):
                return empty
            before = path.lstat()
            if not stat.S_ISREG(before.st_mode):
                return empty
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            with os.fdopen(os.open(path, flags), "rb") as stream:
                metadata = os.fstat(stream.fileno())
                if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in trusted
                        or metadata.st_mode & 0o022 or metadata.st_nlink != 1
                        or (before.st_dev, before.st_ino) != (metadata.st_dev, metadata.st_ino)
                        or metadata.st_size > MAX_SPOTIFY_BODY):
                    return empty
                raw = stream.read(MAX_SPOTIFY_BODY + 1)
            if len(raw) > MAX_SPOTIFY_BODY:
                return empty
            body = json.loads(raw.decode("utf-8"), object_pairs_hook=self.monitor_object)
            if not isinstance(body, dict) or set(body) != {"state", "title", "artists", "updatedAt", "coverUrl"}:
                return empty
            def valid_text(value, limit):
                return (isinstance(value, str) and len(value) <= limit
                        and value == " ".join(value.split())
                        and not any(unicodedata.category(char).startswith("C") for char in value))
            def valid_cover(value):
                if (not isinstance(value, str) or not value.startswith("https://")
                        or len(value) > 512 or any(char.isspace() for char in value)
                        or any(char in value for char in "\\?#")):
                    return False
                try:
                    parsed = urlsplit(value)
                    image = parsed.path.removeprefix("/image/")
                    return (parsed.hostname == "i.scdn.co" and parsed.port in (None, 443)
                            and parsed.username is None and parsed.password is None
                            and parsed.path.startswith("/image/") and 1 <= len(image) <= 128
                            and image.isascii() and image.isalnum())
                except ValueError:
                    return False
            if (body["state"] not in ("idle", "loading", "playing", "paused", "error", "unknown")
                    or not valid_text(body["title"], 256)
                    or not isinstance(body["artists"], list) or len(body["artists"]) > 8
                    or not all(valid_text(artist, 128) and artist for artist in body["artists"])
                    or (body["updatedAt"] is not None and
                        (type(body["updatedAt"]) is not int or not 0 <= body["updatedAt"] <= MAX_SAFE_INTEGER))
                    or (body["state"] in ("playing", "paused") and not body["title"])
                    or (body["coverUrl"] is not None and not valid_cover(body["coverUrl"]))
                    or (body["state"] in ("idle", "error") and
                        (body["title"] or body["artists"] or body["coverUrl"] is not None))):
                return empty
            return body
        except FileNotFoundError:
            return {**empty, "state": "idle"}
        except (OSError, ValueError, UnicodeError, RecursionError, TypeError):
            return empty

    @staticmethod
    def read_token(key):
        path = Path(os.environ[key])
        metadata = path.stat()
        credentials = os.environ.get("CREDENTIALS_DIRECTORY")
        managed = (credentials is not None and path.parent == Path(credentials)
                   and path.name == {"INTERNAL_LOOKUP_TOKEN_FILE": "lookup",
                                     "DEVICE_TOKEN_FILE": "device",
                                     "MONITOR_TOKEN_FILE": "monitor"}.get(key)
                   and metadata.st_uid == 0 and metadata.st_gid == 0
                   and stat.S_ISREG(metadata.st_mode)
                   and stat.S_IMODE(metadata.st_mode) == 0o440)
        if metadata.st_mode & 0o077 and not managed:
            raise ValueError("Token files must be private or systemd-managed credentials")
        value = path.read_text(encoding="ascii").strip()
        if len(value) < 32 or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise ValueError("Invalid dedicated token file")
        return value

    def lookup(self, number):
        connection = ForwardedHTTPSConnection(self.lookup_host, timeout=5, context=self.context)
        try:
            connection.request("POST", self.lookup_path,
                body=json.dumps({"studentNumber": number}).encode("ascii"),
                headers={"Authorization": "Bearer " + self.lookup_token,
                         "Content-Type": "application/json", "Cache-Control": "no-store"})
            response = connection.getresponse()
            if response.status == 404:
                return "not_found"
            if response.status != 200 or response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                return None
            raw = response.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                return None
            member = json.loads(raw)
            if (not isinstance(member, dict) or not isinstance(member.get("memberId"), str)
                    or not re.fullmatch(r"[0-9]{1,20}", member["memberId"])
                    or not isinstance(member.get("name"), str)
                    or not 1 <= len(member["name"]) <= 100
                    or member["name"] != member["name"].strip()
                    or re.search(r"[\x00-\x1f\x7f]", member["name"])):
                return None
            return member
        except (OSError, http.client.HTTPException, ValueError, UnicodeError):
            return None
        finally:
            connection.close()

    @staticmethod
    def monitor_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("Duplicate monitoring field")
            value[key] = item
        return value

    @staticmethod
    def validate_monitor(payload):
        now = now_ms()
        if (not isinstance(payload, dict) or set(payload) != {"observedAt", "nodes"}
                or type(payload["observedAt"]) is not int
                or not now - MONITOR_MAX_AGE <= payload["observedAt"] <= now + 60_000
                or not isinstance(payload["nodes"], list) or len(payload["nodes"]) != 3):
            return False
        seen = set()
        fields = {"id", "label", "collectedAt", "cpuPercent", "memoryUsedBytes", "memoryTotalBytes", "health"}
        for node in payload["nodes"]:
            if not isinstance(node, dict) or set(node) != fields:
                return False
            identity, label, health = node["id"], node["label"], node["health"]
            if (not isinstance(identity, str) or identity not in ("prod", "stage", "db") or identity in seen
                    or not isinstance(label, str) or not 1 <= len(label) <= 100
                    or label != label.strip() or re.search(r"[\x00-\x1f\x7f\ud800-\udfff]", label)
                    or not isinstance(health, str) or health not in ("up", "down", "unknown")):
                return False
            seen.add(identity)
            collected = node["collectedAt"]
            if collected is not None and (type(collected) is not int
                    or not 0 < collected <= payload["observedAt"]):
                return False
            cpu = node["cpuPercent"]
            if cpu is not None and (type(cpu) not in (int, float) or not 0 <= cpu <= 100 or not math.isfinite(cpu)):
                return False
            used, total = node["memoryUsedBytes"], node["memoryTotalBytes"]
            if any(value is not None and (type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER)
                   for value in (used, total)):
                return False
            if total == 0 or (used is not None and total is not None and used > total):
                return False
            if health == "up" and (collected is None or collected < now - MONITOR_MAX_AGE):
                return False
            if collected is None and any(value is not None for value in (cpu, used, total)):
                return False
        return True

    def monitor(self):
        if self.monitor_token is None:
            return None
        connection = ForwardedHTTPSConnection(self.lookup_host, timeout=5, context=self.context)
        try:
            connection.request("GET", MONITOR_PATH,
                headers={"Authorization": "Bearer " + self.monitor_token,
                         "Accept": "application/json", "Cache-Control": "no-store"})
            response = connection.getresponse()
            if (response.status != 200
                    or response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json"):
                return None
            raw = response.read(MAX_MONITOR_BODY + 1)
            if len(raw) > MAX_MONITOR_BODY:
                return None
            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=self.monitor_object)
            return payload if self.validate_monitor(payload) else None
        except (OSError, http.client.HTTPException, ValueError, UnicodeError, RecursionError):
            return None
        finally:
            connection.close()

    def _probe_koin_service(self, service):
        identity, label, host = service
        result = {"id": identity, "label": label, "checkedAt": now_ms(),
                  "status": "unknown", "reason": "unavailable", "httpStatus": None}
        connection = http.client.HTTPSConnection(host, timeout=KOIN_TIMEOUT, context=self.context)
        try:
            # Public readiness only: no internal token, forwarded transport or redirects.
            connection.request("GET", KOIN_READINESS_PATH,
                               headers={"Accept": "application/json", "Cache-Control": "no-store"})
            response = connection.getresponse()
            if not 100 <= response.status <= 599:
                result["reason"] = "invalid-response"
                return result
            result["httpStatus"] = response.status
            if 500 <= response.status <= 599:
                result.update(status="down", reason="http")
                return result
            if response.status != 200:
                result["reason"] = "http"
                return result
            mime = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
            if mime != "application/json" and not (mime.startswith("application/") and mime.endswith("+json")):
                result["reason"] = "invalid-response"
                return result
            raw = response.read(MAX_KOIN_BODY + 1)
            if len(raw) > MAX_KOIN_BODY:
                result["reason"] = "invalid-response"
                return result
            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=self.monitor_object)
            status = payload.get("status") if isinstance(payload, dict) else None
            if status == "UP":
                result.update(status="up", reason="ready")
            elif status in ("DOWN", "OUT_OF_SERVICE"):
                result.update(status="down", reason="not-ready")
            else:
                result["reason"] = "invalid-response"
        except ssl.SSLError:
            result["reason"] = "tls"
        except TimeoutError:
            result["reason"] = "timeout"
        except (http.client.HTTPException, ValueError, UnicodeError, RecursionError):
            result["reason"] = "invalid-response"
        except OSError:
            result["reason"] = "unavailable"
        finally:
            connection.close()
            result["checkedAt"] = now_ms()
        return result

    def koin_health(self):
        # Neither probe nor its wait touches SQLite or the attendance/event locks.
        with ThreadPoolExecutor(max_workers=2) as executor:
            services = list(executor.map(self._probe_koin_service, KOIN_SERVICES))
        return {"observedAt": now_ms(), "services": services}

    def _probe_worker(self, endpoint):
        identity, label, host, path = endpoint
        result = {"id": identity, "label": label, "status": "unknown",
                  "httpStatus": None, "reason": "unavailable"}
        connection = http.client.HTTPSConnection(host, timeout=WORKER_TIMEOUT, context=self.context)
        try:
            # Fixed public Worker paths only: no credentials, redirects or body buffering.
            connection.request("GET", path,
                               headers={"Accept": "*/*", "Cache-Control": "no-store"})
            with connection.getresponse() as response:
                if not 100 <= response.status <= 599:
                    return result
                result["httpStatus"] = response.status
                if 200 <= response.status <= 299:
                    result.update(status="up", reason="http")
                elif 500 <= response.status <= 599:
                    result.update(status="down", reason="http")
                elif 300 <= response.status <= 399:
                    result["reason"] = "redirect"
                elif response.status in (401, 403):
                    result["reason"] = "restricted"
                else:
                    result["reason"] = "http"
        except ssl.SSLError:
            result["reason"] = "tls"
        except TimeoutError:
            result["reason"] = "timeout"
        except (OSError, http.client.HTTPException, ValueError):
            result["reason"] = "unavailable"
        finally:
            connection.close()
        return result


    def worker_health(self):
        # Single-flight this public cache only; never hold SQLite/event locks.
        with self.worker_lock:
            if self.worker_cached is None or time.monotonic() >= self.worker_expires:
                workers = [self._probe_worker(endpoint) for endpoint in WORKER_ENDPOINTS]
                self.worker_cached = {"checkedAt": now_ms(), "workers": workers}
                self.worker_expires = time.monotonic() + WORKER_CACHE_SECONDS
            return deepcopy(self.worker_cached)

    def tap(self, body):
        now = now_ms()
        if (not isinstance(body, dict) or set(body) - {"studentNumber", "at"}
                or not isinstance(body.get("studentNumber"), str)
                or not re.fullmatch(r"[0-9]{8,10}", body["studentNumber"])):
            return 400, {"error": "invalid_body"}
        at = body.get("at", now)
        if type(at) is not int or at > now + 60_000 or at < now - 7 * DAY:
            return 400, {"error": "invalid_time"}
        # Authenticated local requests reach tap only after the HTTP boundary.
        # Wake the display before any potentially slow/unavailable network lookup.
        self.publish_attention()
        member = self.lookup(body["studentNumber"])
        if member == "not_found":
            return self.tap_guest(body["studentNumber"], at)
        if member is None:
            return 503, {"error": "lookup_unavailable"}
        identity = "internal-" + member["memberId"]
        # The network lookup above must never hold the shared SQLite lock.
        with self.db_lock:
            result, changed = self.record_tap(identity, member["name"], at)
            # Publish the committed transition, never infer direction in the UI.
            self.publish_greeting(member["name"], result["status"], changed)
        return 200, result

    def record_tap(self, identity, name, at):
        # db_lock is held by both callers; publish only after this commit.
        with self.db:
            previous = self.db.execute("SELECT name FROM members WHERE id=?", (identity,)).fetchone()
            changed = previous is None or previous["name"] != name
            self.db.execute("INSERT INTO members VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                            (identity, name))
            latest = self.db.execute("SELECT * FROM sessions WHERE memberId=? ORDER BY checkIn DESC LIMIT 1", (identity,)).fetchone()
            last = latest["checkOut"] if latest and latest["checkOut"] is not None else latest["checkIn"] if latest else None
            if last is not None and at - last < 10_000:
                result = {"status": "ignored", "name": name}
            elif latest and latest["checkOut"] is None:
                # An over-length open session still closes on this tap. Treating it
                # as a fresh check-in silently hides the tap the user meant as OUT.
                expired = at - latest["checkIn"] >= MAX_SESSION
                self.db.execute(
                    "UPDATE sessions SET checkOut=?,autoClosed=? WHERE memberId=? AND checkIn=?",
                    (at, 1 if expired else 0, identity, latest["checkIn"]))
                changed = True
                result = {"status": "check-out", "name": name, "at": at, "durationMs": at - latest["checkIn"]}
                if expired:
                    result["previousAutoClosed"] = True
            else:
                self.db.execute("INSERT INTO sessions(memberId,checkIn) VALUES(?,?)", (identity, at))
                changed = True
                result = {"status": "check-in", "name": name, "at": at}
        return result, changed

    def prune_guest_taps(self, now):
        # 프로세스 메모리에는 만료 시각과 무작위 식별자만 유지한다.
        while self.guest_taps and next(iter(self.guest_taps.values()))[0] <= now:
            self.guest_taps.popitem(last=False)

    def expire_guest_taps(self):
        with self.db_lock:
            self.guest_timer = None
            self.prune_guest_taps(time.monotonic())
            self.schedule_guest_expiry()

    def schedule_guest_expiry(self):
        # Called with db_lock held. An idle reader must also discard old digests.
        if self.guest_taps and self.guest_timer is None and not self.stopping:
            delay = max(0, next(iter(self.guest_taps.values()))[0] - time.monotonic())
            self.guest_timer = threading.Timer(delay, self.expire_guest_taps)
            self.guest_timer.daemon = True
            self.guest_timer.start()

    def tap_guest(self, number, at):
        digest = hmac.digest(_GUEST_HMAC_KEY, number.encode("ascii"), "sha256")
        with self.db_lock:
            now = time.monotonic()
            self.prune_guest_taps(now)
            previous = self.guest_taps.get(digest)
            identity = previous[1] if previous is not None else "guest-" + os.urandom(16).hex()
            result, changed = self.record_tap(identity, "방문자", at)
            if previous is None and len(self.guest_taps) >= MAX_GUEST_TAPS:
                self.guest_taps.popitem(last=False)
            # 중복·순서 판정은 원래 태그 시각을 사용하는 record_tap에 맡긴다.
            self.guest_taps[digest] = (now + MAX_SESSION / 1000, identity)
            self.guest_taps.move_to_end(digest)
            self.schedule_guest_expiry()
            # Ignored taps may invalidate renamed members, but never greet.
            self.publish_greeting(None, result["status"], changed)
        return 200, result

    def next_state_change(self):
        # Preserve live duration totals, presence expiry and KST rollover without
        # browser polling. Only occupied sessions need timed duration updates.
        now = now_ms()
        with self.db_lock:
            active = self.db.execute(
                "SELECT MIN(checkIn) FROM sessions WHERE checkOut IS NULL AND checkIn>?",
                (now - MAX_SESSION,)).fetchone()[0]
        return min(day_start(now) + DAY, active + MAX_SESSION, now + 10_000) if active is not None else day_start(now) + DAY

    def publish_attention(self):
        with self.events:
            if not self.stopping:
                self.attention_revision += 1
                self.events.notify_all()

    def publish_greeting(self, name, action, changed=False):
        with self.events:
            if self.stopping:
                return
            if changed:
                self.revision += 1
            if action not in ("check-in", "check-out"):
                if changed:
                    self.events.notify_all()
                return
            self.greeting_revision += 1
            sequence = self.greeting_revision
            self.greeting = (sequence, time.monotonic() + 5, {"name": name, "action": action})
            if self.greeting_timer is not None:
                self.greeting_timer.cancel()
            self.greeting_timer = threading.Timer(5, self.expire_greeting, (sequence,))
            self.greeting_timer.daemon = True
            self.greeting_timer.start()
            self.events.notify_all()

    def expire_greeting(self, sequence):
        with self.events:
            if self.greeting_revision == sequence:
                self.greeting = None
                self.greeting_timer = None

    def event_snapshot(self):
        with self.events:
            greeting = self.greeting
            if greeting is not None and time.monotonic() >= greeting[1]:
                greeting = None
            return self.greeting_revision, greeting, self.attention_revision

    def greeting_snapshot(self):
        revision, greeting, _ = self.event_snapshot()
        return revision, greeting

    def wait_for_change(self, revision, timeout, greeting_revision=None, attention_revision=None):
        with self.events:
            self.events.wait_for(
                lambda: self.stopping or self.revision != revision
                or (greeting_revision is not None and self.greeting_revision != greeting_revision)
                or (attention_revision is not None and self.attention_revision != attention_revision),
                timeout)
            return None if self.stopping else self.revision

    def stop_events(self):
        with self.events:
            self.stopping = True
            if self.greeting_timer is not None:
                self.greeting_timer.cancel()
                self.greeting_timer = None
            self.greeting = None
            self.events.notify_all()

    def close(self):
        self.stop_events()
        with self.db_lock:
            if self.guest_timer is not None:
                self.guest_timer.cancel()
                self.guest_timer = None
            self.guest_taps.clear()
            self.db.close()

    def state(self):
        now = now_ms()
        start, week = day_start(now), week_start(now)
        with self.db_lock:
            rows = self.db.execute("SELECT * FROM sessions WHERE checkIn>=? AND checkIn<? ORDER BY checkIn",
                                   (week - DAY, start + DAY)).fetchall()
            member_rows = self.db.execute("SELECT * FROM members").fetchall()
        grouped = {}
        for row in rows:
            grouped.setdefault(row["memberId"], []).append(row)
        members = []
        for member in member_rows:
            today_ms = week_ms = unrecorded_week = 0
            since = first = last_out = None
            for row in grouped.get(member["id"], []):
                if not unrecorded(row, now):
                    end = row["checkOut"] if row["checkOut"] is not None else now
                    today_ms += max(0, min(end, start + DAY) - max(row["checkIn"], start))
                    week_ms += max(0, min(end, week + 7 * DAY) - max(row["checkIn"], week))
                if row["checkIn"] >= week and unrecorded(row, now):
                    unrecorded_week += 1
                if row["checkOut"] is None and now - row["checkIn"] < MAX_SESSION:
                    since = row["checkIn"]
                if row["checkIn"] >= start and (first is None or row["checkIn"] < first):
                    first = row["checkIn"]
                if row["checkOut"] is not None and row["checkOut"] >= start and (last_out is None or row["checkOut"] > last_out):
                    last_out = row["checkOut"]
            members.append({"name": member["name"], "present": since is not None, "since": since,
                            "todayMs": today_ms, "weekMs": week_ms, "unrecordedWeek": unrecorded_week,
                            "firstInToday": first, "lastCheckOut": last_out})
        members.sort(key=lambda member: (not member["present"], member["since"] if member["present"] else -member["weekMs"], member["name"]))
        names = {row["id"]: row["name"] for row in member_rows}
        recent = [{"name": names[row["memberId"]], "checkIn": row["checkIn"], "checkOut": row["checkOut"],
                   "unrecorded": unrecorded(row, now)} for row in sorted(rows, key=lambda row: row["checkIn"], reverse=True)[:15]]
        return {"now": now, "members": members, "unknownCards": [], "recent": recent}


class AttendanceServer(ThreadingHTTPServer):
    # Join finite requests on shutdown; stop_events wakes every stream first.
    daemon_threads = False

    def handle_error(self, _request, _client_address):
        # Never print exception values or request data from a worker thread.
        print("Attendance LAN request failed.", flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "AttendanceLAN"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_args):
        # No request URLs, credentials, student numbers, member names or response bodies in logs.
        pass

    def send(self, status, body, content_type="application/json; charset=utf-8"):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8") if isinstance(body, dict) else body
        self.send_response(status)
        for key, value in HEADERS.items():
            self.send_header(key, value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' https://i.scdn.co; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(raw)

    @staticmethod
    def allowed_address(value):
        try:
            address = ipaddress.IPv4Address(value)
        except ipaddress.AddressValueError:
            return False
        return address.is_loopback or address in ipaddress.IPv4Network("192.168.1.0/24")

    def permitted(self):
        if not self.allowed_address(self.client_address[0]):
            return False
        hosts = self.headers.get_all("Host", [])
        origins = self.headers.get_all("Origin", [])
        if len(hosts) != 1 or len(origins) > 1:
            return False
        host = hosts[0]
        # Literal IPv4 only: no DNS rebinding, userinfo, paths or alternate ports.
        address, separator, port = host.rpartition(":")
        if separator != ":" or port != str(PORT) or not self.allowed_address(address):
            return False
        origin = "http://" + host
        return ((not origins or origins[0] == origin)
                and self.headers.get("Sec-Fetch-Site", "none") in ("none", "same-origin"))

    def stream_events(self):
        app = self.server.app
        greeting_revision, _, attention_revision = app.event_snapshot()
        self.close_connection = True
        try:
            self.send_response(200)
            for key, value in HEADERS.items():
                self.send_header(key, value)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b"retry: 1000\n\n")
            self.wfile.flush()
            revision = -1  # Always resynchronize a new/reconnected browser.
            transition = app.next_state_change()
            while True:
                current = app.wait_for_change(revision, min(5, max(0, (transition - now_ms()) / 1000)),
                                              greeting_revision, attention_revision)
                if current is None:
                    return
                if current != revision or now_ms() >= transition:
                    # Only an opaque process-local revision; no identity or tap body.
                    frame = ("id: %d\nevent: state\ndata: {}\n\n" % current).encode("ascii")
                    revision = current
                    transition = app.next_state_change()
                else:
                    frame = b""
                sequence, greeting, attention = app.event_snapshot()
                if attention != attention_revision:
                    attention_revision = attention
                    frame = b"event: attention\ndata: {}\n\n" + frame
                if sequence != greeting_revision:
                    greeting_revision = sequence
                    if greeting is not None:
                        frame += ("event: greeting\ndata: " + json.dumps(greeting[2], ensure_ascii=False) + "\n\n").encode("utf-8")
                if not frame:
                    frame = b"event: ping\ndata: {}\n\n"
                self.wfile.write(frame)
                self.wfile.flush()
        except OSError:
            # A disconnected/slow client releases its handler without retaining
            # a subscriber queue; heartbeat + socket timeout bound detection.
            return

    def do_GET(self):
        if not self.permitted():
            return self.send(403, {"error": "forbidden"})
        app = self.server.app
        if self.path == "/":
            return self.send(200, app.html, "text/html; charset=utf-8")
        if self.path == "/api/events":
            return self.stream_events()
        if self.path == "/api/state":
            try:
                return self.send(200, app.state())
            except sqlite3.Error:
                return self.send(503, {"error": "storage_unavailable"})
        if self.path == "/api/monitor":
            payload = app.monitor()
            return self.send(200, payload) if payload is not None else self.send(503, {"error": "monitor_unavailable"})
        if self.path == "/api/koin-health":
            return self.send(200, app.koin_health())
        if self.path == "/api/worker-health":
            return self.send(200, app.worker_health())
        if self.path == "/api/spotify":
            return self.send(200, app.spotify())
        if self.path == "/api/jam":
            return self.send(200, {"available": app.jam_qr is not None})
        if self.path == "/api/jam-qr":
            return (self.send(200, app.jam_qr, "image/png") if app.jam_qr is not None
                    else self.send(404, {"error": "jam_qr_unavailable"}))
        if self.path in ("/api/wifi-qr/2.4", "/api/wifi-qr/5"):
            image = app.qr.get(self.path.rsplit("/", 1)[1])
            return self.send(200, image, "image/png") if image else self.send(503, {"error": "wifi_qr_unavailable"})
        if self.path == "/health":
            return self.send(200, {"status": "ok", "mode": "temporary-lan"})
        return self.send(404, {"error": "not_found"})

    def do_POST(self):
        if not self.permitted() or not ipaddress.IPv4Address(self.client_address[0]).is_loopback:
            return self.send(403, {"error": "forbidden"})
        if self.path != "/api/taps":
            return self.send(404, {"error": "not_found"})
        token = self.headers.get("Authorization", "")
        expected = "Bearer " + self.server.app.device_token
        if not hmac.compare_digest(token.encode("utf-8"), expected.encode("ascii")):
            return self.send(401, {"error": "unauthorized"})
        length = self.headers.get("Content-Length", "")
        if (not re.fullmatch(r"[0-9]{1,4}", length) or not 0 < int(length) <= MAX_BODY
                or self.headers.get("Transfer-Encoding")
                or self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json"):
            return self.send(400, {"error": "invalid_body"})
        try:
            body = json.loads(self.rfile.read(int(length)))
        except (ValueError, UnicodeError):
            return self.send(400, {"error": "invalid_body"})
        try:
            status, body = self.server.app.tap(body)
        except sqlite3.Error:
            return self.send(503, {"error": "storage_unavailable"})
        return self.send(status, body)


def main():
    os.umask(0o077)
    app = Attendance()
    server = AttendanceServer((HOST, PORT), Handler)
    server.app = app
    print("Temporary LAN attendance active; dashboard is unauthenticated; lookup remains protected.", flush=True)
    try:
        server.serve_forever()
    finally:
        app.stop_events()
        server.server_close()
        app.close()


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, sqlite3.Error):
        raise SystemExit("Attendance LAN startup failed; check private configuration and prerequisites.") from None
