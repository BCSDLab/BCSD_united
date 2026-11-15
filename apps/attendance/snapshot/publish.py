#!/usr/bin/env python3
"""허용된 LAN 조회 응답을 별도 Cloudflare KV에 게시하는 표준 라이브러리 CLI.

기본 실행은 I/O 없는 계획 출력이며 --once/--loop가 실제 게시를 시작한다.
--validate는 네트워크·파일 쓰기 없이 명시한 인증과 설정만 검사한다.
기기 토큰은 목적에 맞게 제한하고, 계정 전체에 적용되는 KV 쓰기 권한의
위험을 검토한다. 운영자 Wrangler 세션은 명시적인 PC 전용 모드로만 읽으며
Pi에 복사하지 않는다. 만료 시 인증된 `wrangler kv namespace list`로
정상 갱신한다. `whoami` 출력만으로 토큰이 갱신됐다고 간주하지 않는다.

checkpoint는 영구 private 디렉터리에 보관한다. 쓰기 전에 시도 예산을
원자적으로 예약하므로 모호한 실패도 일일 예산에 포함하고 성공 시각은
진행시키지 않는다. 이 예산은 공유 계정의 무료 한도나 과금을 보장하지 않는다.
"""

import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import signal
import ssl
import stat
import sys
import tempfile
import threading
import time
import tomllib
import zlib

ORIGIN_HOST = "192.168.1.112"
ORIGIN_PORT = 8080
JSON_PATHS = ("/api/state", "/api/monitor", "/api/koin-health", "/api/worker-health", "/api/spotify", "/api/jam")
WIFI_PATHS = ("/api/wifi-qr/2.4", "/api/wifi-qr/5")
ASSET_PATHS = (*WIFI_PATHS, "/api/jam-qr")
READ_PATHS = frozenset((*JSON_PATHS, *ASSET_PATHS))
SNAPSHOT_KEY = "clubroom:view:v1"
MAX_SNAPSHOT = 2 * 1024 * 1024
KV_LIMIT = 25 * 1024 * 1024
MAX_PNG = 65536
MAX_REPLY = 65536
MAX_SAFE = 9007199254740991
DAILY_BUDGET = 600
DEFAULT_INTERVAL = 180
ID_PATTERN = re.compile(r"[a-fA-F0-9]{32}\Z")
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9._~+/=-]{20,8192}\Z")


class PublisherError(Exception):
    """자격증명·원문이 없는 고정 오류 메시지만 CLI 경계를 통과한다."""


def now_ms():
    return time.time_ns() // 1_000_000


def pairs_unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def parse_json(raw):
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs_unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))
    except (ValueError, UnicodeError, RecursionError):
        raise PublisherError("invalid JSON response") from None


def encode_json(value):
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (ValueError, UnicodeError, RecursionError):
        raise PublisherError("invalid snapshot encoding") from None


def exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys.split())


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= MAX_SAFE


def timestamp(value):
    return value is None or integer(value)


def text(value, limit=256):
    return (isinstance(value, str) and len(value) <= limit
            and not any(ord(c) < 32 or 0x7f <= ord(c) < 0xa0 or 0xd800 <= ord(c) <= 0xdfff for c in value))


def valid_cover(value):
    if value is None:
        return True
    if not isinstance(value, str) or len(value) > 512:
        return False
    return re.fullmatch(r"https://i\.scdn\.co(?::443)?/image/[A-Za-z0-9]{1,128}", value) is not None


def valid_state(body):
    if not exact(body, "now members unknownCards recent") or not integer(body["now"], 1):
        return False
    if body["unknownCards"] != [] or not isinstance(body["members"], list) or not isinstance(body["recent"], list):
        return False
    for member in body["members"]:
        if (not exact(member, "name present since todayMs weekMs unrecordedWeek firstInToday lastCheckOut")
                or not text(member["name"], 100) or not member["name"] or type(member["present"]) is not bool
                or not all(timestamp(member[key]) for key in ("since", "firstInToday", "lastCheckOut"))
                or not all(integer(member[key]) for key in ("todayMs", "weekMs", "unrecordedWeek"))):
            return False
    for event in body["recent"]:
        if (not exact(event, "name checkIn checkOut unrecorded") or not text(event["name"], 100)
                or not integer(event["checkIn"], 1) or not timestamp(event["checkOut"])
                or type(event["unrecorded"]) is not bool):
            return False
    return True


def valid_optional(path, body):
    # 비밀 필드가 섞인 응답은 거부하고 허용된 응답·원본 시각은 그대로 유지한다.
    if path == "/api/jam":
        return exact(body, "available") and type(body["available"]) is bool
    if path == "/api/spotify":
        return (exact(body, "state title artists updatedAt coverUrl")
                and body["state"] in ("idle", "loading", "playing", "paused", "error", "unknown")
                and text(body["title"]) and isinstance(body["artists"], list) and len(body["artists"]) <= 8
                and all(text(artist, 128) for artist in body["artists"])
                and timestamp(body["updatedAt"]) and valid_cover(body["coverUrl"]))
    if path == "/api/monitor":
        if not exact(body, "observedAt nodes") or not integer(body["observedAt"], 1) or not isinstance(body["nodes"], list):
            return False
        seen = set()
        for node in body["nodes"]:
            if (not exact(node, "id label collectedAt cpuPercent memoryUsedBytes memoryTotalBytes health")
                    or node["id"] not in ("prod", "stage", "db") or node["id"] in seen
                    or not text(node["label"], 100) or node["health"] not in ("up", "down", "unknown")
                    or not timestamp(node["collectedAt"])
                    or not all(timestamp(node[key]) for key in ("memoryUsedBytes", "memoryTotalBytes"))):
                return False
            cpu = node["cpuPercent"]
            if cpu is not None and (type(cpu) not in (int, float) or not math.isfinite(cpu) or not 0 <= cpu <= 100):
                return False
            seen.add(node["id"])
        return seen == {"prod", "stage", "db"}
    if path == "/api/koin-health":
        if not exact(body, "observedAt services") or not integer(body["observedAt"], 1) or not isinstance(body["services"], list):
            return False
        rows, fields, identities = body["services"], "id label checkedAt status reason httpStatus", {"prod-api", "stage-api"}
    elif path == "/api/worker-health":
        if not exact(body, "checkedAt workers") or not integer(body["checkedAt"], 1) or not isinstance(body["workers"], list):
            return False
        rows, fields, identities = body["workers"], "id label status httpStatus reason", {"koin-web"}
    else:
        return False
    seen = set()
    for row in rows:
        if (not exact(row, fields) or row["id"] not in identities or row["id"] in seen
                or not text(row["label"], 100) or row["status"] not in ("up", "down", "unknown")
                or row["reason"] not in ("unavailable", "http", "invalid-response", "ready", "not-ready", "tls", "timeout", "redirect", "restricted")
                or (row["httpStatus"] is not None and (type(row["httpStatus"]) is not int or not 100 <= row["httpStatus"] <= 599))
                or ("checkedAt" in row and not integer(row["checkedAt"], 1))):
            return False
        seen.add(row["id"])
    return seen == identities


def valid_png(raw):
    """제한된 PNG 청크·CRC·비인터레이스 스캔라인을 검사한다."""
    if not 8 < len(raw) <= MAX_PNG or raw[:8] != b"\x89PNG\r\n\x1a\n":
        return False
    offset, header, palette, ended = 8, None, False, False
    image = bytearray()
    while offset + 12 <= len(raw):
        size = int.from_bytes(raw[offset:offset + 4], "big")
        kind = raw[offset + 4:offset + 8]
        end = offset + size + 12
        if (end > len(raw) or not all(65 <= c <= 90 or 97 <= c <= 122 for c in kind)
                or zlib.crc32(raw[offset + 4:end - 4]) != int.from_bytes(raw[end - 4:end], "big")):
            return False
        data = raw[offset + 8:end - 4]
        if header is None:
            if kind != b"IHDR" or size != 13:
                return False
            width, height = int.from_bytes(data[:4], "big"), int.from_bytes(data[4:8], "big")
            depth, color, compression, filtering, interlace = data[8:]
            if (not 1 <= width <= 2048 or not 1 <= height <= 2048
                    or depth not in {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}.get(color, ())
                    or compression or filtering or interlace):
                return False
            row_bytes = (width * {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color] * depth + 7) // 8
            expected = (row_bytes + 1) * height
            if expected > 16 * 1024 * 1024:
                return False
            header = (color, depth, row_bytes, expected)
        elif kind == b"IHDR":
            return False
        elif kind == b"PLTE":
            if palette or image or color in (0, 4) or not size or size % 3 or size > 768 or (color == 3 and size // 3 > 2 ** depth):
                return False
            palette = True
        elif kind == b"IDAT":
            if ended or (color == 3 and not palette):
                return False
            image.extend(data)
        elif kind == b"IEND":
            if size or end != len(raw) or not image:
                return False
            try:
                decoder = zlib.decompressobj()
                decoded = decoder.decompress(image, expected + 1)
                return (len(decoded) == expected and decoder.eof and not decoder.unused_data
                        and not decoder.unconsumed_tail
                        and all(decoded[index] <= 4 for index in range(0, expected, row_bytes + 1)))
            except zlib.error:
                return False
        elif not kind[0] & 0x20:
            return False
        if image and kind != b"IDAT":
            ended = True
        offset = end
    return False


def fetch_lan(path, *, ssh_forward=False):
    if path not in READ_PATHS:
        raise PublisherError("LAN target is not allowed")
    limit = MAX_SNAPSHOT if path == "/api/state" else MAX_PNG if path in ASSET_PATHS else MAX_REPLY
    # SSH 전용 관리자 경로에서는 명시한 loopback 전달을 사용하되 Host는 유지한다.
    connection = http.client.HTTPConnection("127.0.0.1" if ssh_forward else ORIGIN_HOST,
                                            ORIGIN_PORT, timeout=12)
    try:
        connection.request("GET", path, headers={"Host": f"{ORIGIN_HOST}:{ORIGIN_PORT}",
                           "Accept": "image/png" if path in ASSET_PATHS else "application/json", "Cache-Control": "no-store"})
        response = connection.getresponse()
        # 리디렉션이나 HTTP_PROXY 환경 변수로 목적지를 바꾸지 않는다.
        status, mime = response.status, response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
        if status != 200:
            return status, mime, b""  # 서버 오류 원문은 읽거나 전달하지 않는다.
        raw = response.read(limit + 1)
        if len(raw) > limit:
            raise PublisherError("LAN response exceeds size bound")
        return status, mime, raw
    except (OSError, http.client.HTTPException):
        raise PublisherError("LAN request unavailable") from None
    finally:
        connection.close()


def collect_snapshot(fetch=fetch_lan, clock=now_ms):
    payloads = {}
    for path in JSON_PATHS:
        try:
            status, mime, raw = fetch(path)
            if status != 200:
                if path == "/api/state":
                    raise PublisherError("attendance core unavailable")
                payloads[path] = {"status": status if type(status) is int and 400 <= status <= 599 else 502,
                                  "body": {"error": "source_unavailable"}}
                continue
            body = parse_json(raw) if mime == "application/json" else None
            valid = valid_state(body) if path == "/api/state" else valid_optional(path, body)
            if not valid:
                raise PublisherError("invalid source schema")
            payloads[path] = {"status": 200, "body": body}
        except (PublisherError, TypeError, KeyError, ValueError, RecursionError):
            if path == "/api/state":
                raise PublisherError("attendance core unavailable or invalid") from None
            payloads[path] = {"status": 502, "body": {"error": "source_unavailable"}}
    assets = {}
    jam = payloads["/api/jam"]
    paths = (*WIFI_PATHS, "/api/jam-qr") if jam["status"] == 200 and jam["body"]["available"] else WIFI_PATHS
    for path in paths:
        try:
            status, mime, raw = fetch(path)
            if status != 200 or mime != "image/png" or not valid_png(raw):
                raise PublisherError("required QR image unavailable or invalid")
        except PublisherError:
            if path in WIFI_PATHS:
                raise
            # 실제 QR이 없으면 Jam을 사용 가능으로 광고하지 않는다.
            payloads["/api/jam"] = {"status": 502, "body": {"error": "source_unavailable"}}
            continue
        assets[path] = base64.b64encode(raw).decode("ascii")
    observed = payloads["/api/state"]["body"]["now"]
    published = clock()
    if observed > published or published - observed > 60_000:
        raise PublisherError("attendance observation is stale or in the future")
    snapshot = {"version": 1, "observedAt": observed, "publishedAt": published, "payloads": payloads, "assets": assets}
    encoded = encode_json(snapshot)
    if len(encoded) > min(MAX_SNAPSHOT, KV_LIMIT):
        raise PublisherError("snapshot exceeds 2 MiB bound")
    return snapshot, encoded


def windows_security(path, apply=False):
    """Windows에서는 chmod 대신 실제 소유자·DACL을 검사한다."""
    import ctypes
    from ctypes import wintypes as w
    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    adv.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
    adv.GetTokenInformation.argtypes = [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD)]
    adv.ConvertSidToStringSidW.argtypes = [w.LPVOID, ctypes.POINTER(w.LPWSTR)]
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [w.LPCWSTR, w.DWORD, ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.DWORD)]
    adv.SetFileSecurityW.argtypes = [w.LPCWSTR, w.DWORD, w.LPVOID]
    adv.GetNamedSecurityInfoW.argtypes = [w.LPWSTR, ctypes.c_int, w.DWORD, ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.LPVOID)]
    adv.GetAce.argtypes = [w.LPVOID, w.DWORD, ctypes.POINTER(w.LPVOID)]
    kernel.GetCurrentProcess.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.LocalFree.argtypes = [w.LPVOID]
    def sid_string(sid):
        result = w.LPWSTR()
        if not adv.ConvertSidToStringSidW(sid, ctypes.byref(result)):
            raise PublisherError("cannot inspect Windows private ACL")
        try:
            return result.value
        finally:
            kernel.LocalFree(ctypes.cast(result, w.LPVOID))
    token, needed = w.HANDLE(), w.DWORD()
    if not adv.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        raise PublisherError("cannot inspect Windows identity")
    try:
        adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        buffer = ctypes.create_string_buffer(needed.value)
        if not adv.GetTokenInformation(token, 1, buffer, needed, ctypes.byref(needed)):
            raise PublisherError("cannot inspect Windows identity")
        current_sid = sid_string(ctypes.cast(buffer, ctypes.POINTER(w.LPVOID))[0])
    finally:
        kernel.CloseHandle(token)
    descriptor = w.LPVOID()
    if apply:
        # 하위 항목에만 상속하며 Users·Everyone 권한은 허용하지 않는다.
        sddl = f"D:P(A;OICI;FA;;;{current_sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
        if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise PublisherError("cannot create Windows private ACL")
        try:
            if not adv.SetFileSecurityW(str(path), 0x80000004, descriptor):
                raise PublisherError("cannot apply Windows private ACL")
        finally:
            kernel.LocalFree(descriptor)
    owner, acl, descriptor = w.LPVOID(), w.LPVOID(), w.LPVOID()
    if adv.GetNamedSecurityInfoW(str(path), 1, 5, ctypes.byref(owner), None, ctypes.byref(acl), None, ctypes.byref(descriptor)):
        raise PublisherError("cannot inspect Windows private ACL")
    try:
        allowed = {current_sid, "S-1-5-18", "S-1-5-32-544"}
        if not owner or sid_string(owner) not in allowed or not acl:
            raise PublisherError("Windows file must have a private owner and DACL")
        # ACL 헤더의 ACE 개수 필드를 읽는다.
        count = ctypes.c_ushort.from_address(acl.value + 4).value
        for index in range(count):
            ace = w.LPVOID()
            if not adv.GetAce(acl, index, ctypes.byref(ace)):
                raise PublisherError("cannot inspect Windows private ACL")
            kind = ctypes.c_ubyte.from_address(ace.value).value
            if kind == 1:  # A deny ACE cannot grant access.
                continue
            if kind != 0 or sid_string(ace.value + 8) not in allowed:
                raise PublisherError("Windows file grants access outside its private principals")
    finally:
        kernel.LocalFree(descriptor)


def private_path(path, directory=False):
    try:
        info = path.lstat()
        if (path.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400
                or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
                or (not directory and info.st_nlink != 1)):
            raise PublisherError("private path must be a regular non-linked file or directory")
        if os.name == "nt":
            windows_security(path)
        elif info.st_uid not in (0, os.geteuid()) or info.st_mode & 0o077:
            raise PublisherError("private path must be owner-only (0700 directory / 0600 file)")
    except OSError:
        raise PublisherError("private path is inaccessible") from None


def private_read(path, limit):
    private_path(path)
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        before = path.lstat()
        with os.fdopen(os.open(path, flags), "rb") as stream:
            actual = os.fstat(stream.fileno())
            if (before.st_dev, before.st_ino) != (actual.st_dev, actual.st_ino) or actual.st_size > limit:
                raise PublisherError("private file changed or exceeds size bound")
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise PublisherError("private file exceeds size bound")
        return raw
    except OSError:
        raise PublisherError("private file is inaccessible") from None


def read_credential(args, clock=now_ms):
    try:
        if args.operator_wrangler_auth_file:
            data = tomllib.loads(private_read(Path(args.operator_wrangler_auth_file), 65536).decode("utf-8"))
            value = data.get("oauth_token")
            expiry = data.get("expiration_time")
            expiry = datetime.fromisoformat(expiry.replace("Z", "+00:00")) if isinstance(expiry, str) else expiry
            if not isinstance(expiry, datetime) or expiry.tzinfo is None or expiry.timestamp() * 1000 <= clock() + 60_000:
                raise PublisherError("operator OAuth expired or missing expiry; run authenticated Wrangler kv namespace list on the authorized PC")
        elif args.token_file:
            value = private_read(Path(args.token_file), 8193).decode("ascii").strip()
        else:
            value = os.environ.get(args.token_env, "")
        if not isinstance(value, str) or not TOKEN_PATTERN.fullmatch(value):
            raise PublisherError("credential is missing or invalid")
        return value
    except (OSError, ValueError, UnicodeError, TypeError, OverflowError):
        raise PublisherError("credential file is missing or invalid") from None


def destination(account, namespace):
    if not isinstance(account, str) or not ID_PATTERN.fullmatch(account) or not isinstance(namespace, str) or not ID_PATTERN.fullmatch(namespace):
        raise PublisherError("explicit 32-hex account and existing dedicated namespace are required")
    return f"/client/v4/accounts/{account.lower()}/storage/kv/namespaces/{namespace.lower()}/values/{SNAPSHOT_KEY}"


def put_snapshot(account, namespace, credential, body):
    path = destination(account, namespace)
    if not isinstance(body, bytes) or not 0 < len(body) <= min(MAX_SNAPSHOT, KV_LIMIT):
        raise PublisherError("snapshot exceeds write bound")
    connection = http.client.HTTPSConnection("api.cloudflare.com", 443, timeout=20, context=ssl.create_default_context())
    try:
        connection.request("PUT", path, body=body, headers={"Authorization": "Bearer " + credential,
                           "Content-Type": "application/json", "Accept": "application/json"})
        response = connection.getresponse()
        if not 200 <= response.status <= 299:
            raise PublisherError("Cloudflare KV write rejected")
        raw = response.read(MAX_REPLY + 1)
        if len(raw) > MAX_REPLY:
            raise PublisherError("Cloudflare KV reply exceeds size bound")
        result = parse_json(raw)
        if not isinstance(result, dict) or result.get("success") is not True:
            raise PublisherError("Cloudflare KV write not confirmed")
    except (OSError, http.client.HTTPException):
        raise PublisherError("Cloudflare KV write unavailable or unconfirmed") from None
    finally:
        connection.close()


def ensure_directory(path):
    try:
        if not path.exists():
            # 안전하지 않은 부모 디렉터리를 새로 만들지 않는다.
            path.mkdir(mode=0o700)
            if os.name == "nt":
                windows_security(path, apply=True)
        private_path(path, directory=True)
    except OSError:
        raise PublisherError("checkpoint directory unavailable") from None


def create_private_file(path):
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        private_path(path)
        return os.open(path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
    try:
        if os.name == "nt":
            windows_security(path, apply=True)
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def destination_lock(directory, identity):
    path = directory / (identity + ".lock")
    fd = create_private_file(path)
    try:
        with os.fdopen(fd, "r+b", buffering=0) as stream:
            if os.name == "nt":
                import msvcrt
                if os.fstat(stream.fileno()).st_size == 0:
                    stream.write(b"\0")
                stream.seek(0)
                try:
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                except OSError:
                    raise PublisherError("another publisher holds the destination lock") from None
            else:
                import fcntl
                try:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    raise PublisherError("another publisher holds the destination lock") from None
            yield
    except OSError:
        raise PublisherError("checkpoint lock unavailable") from None


def atomic_checkpoint(path, value):
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=".snapshot-", dir=path.parent)
        with os.fdopen(fd, "wb") as stream:
            if os.name == "nt":
                windows_security(Path(temporary), apply=True)
            stream.write(encode_json(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
        if os.name != "nt":
            fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    except OSError:
        raise PublisherError("atomic checkpoint failed; publication stopped") from None
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def utc_day(at):
    return datetime.fromtimestamp(at / 1000, timezone.utc).date().isoformat()


def load_checkpoint(path, target, at):
    if not path.exists() and not path.is_symlink():
        return {"version": 1, "destination": target, "day": utc_day(at), "attempts": 0,
                "lastAttemptAt": None, "lastPublishedAt": None}
    value = parse_json(private_read(path, MAX_REPLY))
    if (not exact(value, "version destination day attempts lastAttemptAt lastPublishedAt")
            or value["version"] != 1 or value["destination"] != target
            or not isinstance(value["day"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value["day"])
            or type(value["attempts"]) is not int or not 0 <= value["attempts"] <= DAILY_BUDGET
            or not timestamp(value["lastAttemptAt"]) or not timestamp(value["lastPublishedAt"])):
        raise PublisherError("checkpoint malformed or destination mismatch")
    try:
        datetime.strptime(value["day"], "%Y-%m-%d")
        if (value["attempts"] > 0 and (value["lastAttemptAt"] is None
                or utc_day(value["lastAttemptAt"]) != value["day"])):
            raise ValueError("inconsistent reservation")
        if (value["lastPublishedAt"] is not None and (value["lastAttemptAt"] is None
                or value["lastPublishedAt"] > value["lastAttemptAt"])):
            raise ValueError("inconsistent publication")
    except (ValueError, OverflowError, OSError):
        raise PublisherError("checkpoint malformed or inconsistent") from None
    if value["day"] > utc_day(at) or (value["lastAttemptAt"] is not None and value["lastAttemptAt"] > at):
        raise PublisherError("UTC clock moved backwards; refusing budget reset")
    if value["day"] != utc_day(at):
        value = {**value, "day": utc_day(at), "attempts": 0}
    return value


def reserve_checkpoint(value, at, interval):
    if value["day"] != utc_day(at):
        if value["day"] > utc_day(at):
            raise PublisherError("UTC clock moved backwards")
        value = {**value, "day": utc_day(at), "attempts": 0}
    if value["attempts"] >= DAILY_BUDGET:
        raise PublisherError("600-attempt UTC daily publication budget exhausted")
    if value["lastAttemptAt"] is not None and at - value["lastAttemptAt"] < interval * 1000:
        raise PublisherError("publication cadence guard; wait for the configured interval")
    return {**value, "attempts": value["attempts"] + 1, "lastAttemptAt": at}


def publish_once(args, fetch=fetch_lan, put=put_snapshot, clock=now_ms):
    target = destination(args.account_id, args.namespace_id)
    credential = read_credential(args, clock)
    directory = Path(args.checkpoint_dir)
    ensure_directory(directory)
    identity = hashlib.sha256(target.encode("ascii")).hexdigest()
    checkpoint = directory / (identity + ".json")
    with destination_lock(directory, identity):
        value = load_checkpoint(checkpoint, target, clock())
        # LAN 접속 전 예산·간격을 확인하고 쓰기 예약 시 다시 대조한다.
        reserve_checkpoint(value, clock(), args.interval)
        snapshot, raw = collect_snapshot(fetch, clock)
        reserved = reserve_checkpoint(value, clock(), args.interval)
        atomic_checkpoint(checkpoint, reserved)
        put(args.account_id, args.namespace_id, credential, raw)
        confirmed = {**reserved, "lastPublishedAt": snapshot["publishedAt"]}
        atomic_checkpoint(checkpoint, confirmed)
    return {"published": True, "observedAt": snapshot["observedAt"], "publishedAt": snapshot["publishedAt"],
            "bytes": len(raw), "utcAttempts": confirmed["attempts"]}


def parser():
    result = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    modes = result.add_mutually_exclusive_group()
    modes.add_argument("--plan", action="store_true", help="default: report fixed plan without I/O")
    modes.add_argument("--validate", action="store_true", help="validate explicit destination and credential; no I/O to LAN/cloud")
    modes.add_argument("--once", action="store_true", help="publish one snapshot to the existing namespace")
    modes.add_argument("--loop", action="store_true", help="publish until SIGINT/SIGTERM; no service installation")
    result.add_argument("--account-id")
    result.add_argument("--namespace-id")
    auth = result.add_mutually_exclusive_group()
    auth.add_argument("--token-env", metavar="NAME", help="explicit environment variable containing machine KV token")
    auth.add_argument("--token-file", help="private plaintext machine KV token file")
    auth.add_argument("--operator-wrangler-auth-file", help="private existing Wrangler TOML session on operator PC only (broad OAuth)")
    result.add_argument("--checkpoint-dir", help="persistent private directory; parent must exist")
    result.add_argument("--interval", type=int, default=DEFAULT_INTERVAL, help="publication seconds, >=180; default 180 (~480/day)")
    result.add_argument("--ssh-forward", action="store_true", help="operator source through an existing 127.0.0.1:8080 SSH forward to Pi5 localhost:8080")
    return result


def validate_arguments(args):
    destination(args.account_id, args.namespace_id)
    if args.interval < DEFAULT_INTERVAL:
        raise PublisherError("publication interval must be at least 180 seconds")
    if not any((args.token_env, args.token_file, args.operator_wrangler_auth_file)):
        raise PublisherError("an explicit machine credential source or operator session is required")
    if args.token_env and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", args.token_env):
        raise PublisherError("invalid credential environment variable name")
    if not args.checkpoint_dir:
        raise PublisherError("explicit persistent checkpoint directory is required")


def main(argv=None):
    args = parser().parse_args(argv)
    if not (args.validate or args.once or args.loop):
        print(json.dumps({"mode": "plan", "origin": f"http://{ORIGIN_HOST}:{ORIGIN_PORT}", "paths": sorted(READ_PATHS),
                          "key": SNAPSHOT_KEY, "intervalSeconds": args.interval, "utcAttemptBudget": DAILY_BUDGET,
                          "maxSnapshotBytes": MAX_SNAPSHOT, "resourcesCreated": False,
                          "required": "explicit existing account/namespace, credential source, persistent private checkpoint directory",
                          "quota": "account free quota is shared; zero billing is not guaranteed"}))
        return 0
    try:
        validate_arguments(args)
        if args.validate:
            read_credential(args)
            directory = Path(args.checkpoint_dir)
            if directory.exists():
                private_path(directory, directory=True)
            else:
                raise PublisherError("validation requires an existing private checkpoint directory")
            print(json.dumps({"valid": True, "credentialMode": "operator-broad-oauth" if args.operator_wrangler_auth_file else "machine-kv-token", "networkContacted": False}))
            return 0
        stopped = threading.Event()
        def stop(_signum, _frame):
            stopped.set()
        if args.loop:
            signal.signal(signal.SIGINT, stop)
            signal.signal(signal.SIGTERM, stop)
        def fetch(path):
            return fetch_lan(path, ssh_forward=args.ssh_forward)
        while not stopped.is_set():
            try:
                print(json.dumps(publish_once(args, fetch=fetch)), flush=True)
            except PublisherError as error:
                print("snapshot publisher: " + str(error), file=sys.stderr, flush=True)
                if not args.loop:
                    return 1
            if not args.loop or stopped.wait(args.interval):
                break
        return 0
    except PublisherError as error:
        print("snapshot publisher: " + str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, RecursionError, OverflowError):
        # 예외 원문·자격증명·응답 본문·헤더를 로그에 남기지 않는다.
        print("snapshot publisher: local configuration or I/O failure", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
