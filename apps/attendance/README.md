# 출근부 (attendance)

인터널 출입 카드를 리더로 태그하면 입실/퇴실을 기록하고, 대시보드에 현재 인원과 체류 시간을 보여 주는 Worker입니다. 저장소는 Workers KV입니다.

```text
RC522(SPI) 또는 USB HID 리더 ──▶ 라즈베리파이 3B(pi/reader.py) ──POST /api/taps──▶ Worker + KV ──▶ 대시보드(/)
```

## 동작 규칙

- 태그는 토글입니다. 열린 세션이 없으면 입실, 있으면 퇴실입니다.
- 같은 회원의 직전 이벤트 후 10초 안의 태그(카드 중복 인식)와, 직전 이벤트보다 이른 재전송은 무시합니다.
- 퇴근 태그가 없는 세션은 입실 후 6시간(`MAX_SESSION_MS`)이 지나면 입실 중으로 보지 않습니다. 같은 회원의 다음 태그가 6시간 시점에 그 세션을 자동 종료(`autoClosed`)하고 새 입실을 만듭니다. 이런 세션은 실제 체류 시간을 알 수 없으므로 오늘·이번 주 시간 합계에 넣지 않고, 대시보드에 "퇴근 미기록"으로 건수를 표시합니다.
- 오늘·이번 주(월요일 시작) 경계는 KST입니다. 자정을 걸친 세션은 날짜별로 나눠 합산합니다.
- 등록되지 않은 카드를 태그하면 `unknown:<uid>`에 쌓이고, 대시보드의 "미등록 카드"에서 이름을 입력해 등록합니다. 같은 카드로 다시 등록하면 이름만 바뀝니다. 등록하지 않은 카드는 7일 뒤 자동 삭제됩니다.

## 저장 구조 (KV)

데이터는 모두 키 메타데이터에 두어 대시보드가 `list` 호출만으로 읽습니다.

| 키                                      | 내용                                                    |
| --------------------------------------- | ------------------------------------------------------- |
| `member:<uid>`                          | 메타 `{ name }`                                         |
| `unknown:<uid>`                         | 메타 `{ firstSeen, lastSeen, count }`                   |
| `s:<KST 날짜>:<입실 시각 13자리>:<uid>` | 세션. 메타 `{ checkOut, autoClosed }`                   |
| `latest:<uid>`                          | 값 `{ checkIn, checkOut, autoClosed }` 최근 세션 포인터 |

KV에는 트랜잭션이 없고 다른 지역에서는 쓰기가 최대 약 60초 늦게 보입니다. 리더 한 곳에서 태그하는 용도라 태그 판정은 같은 지역의 읽기-쓰기에 의존하며, 대시보드 수치는 그만큼 지연될 수 있습니다. 같은 카드의 거의 동시 태그는 10초 디바운스가 막습니다.

## API

| 경로                | 인증                                                      | 용도                                                                                                     |
| ------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POST /api/taps`    | `Authorization: Bearer <DEVICE_TOKEN>`                    | `{ "uid": "04A1B2C3", "at": 1760000000000 }` (`at` 생략 시 서버 시각. 미래 60초·과거 7일을 벗어나면 400) |
| `GET /`             | Basic (비밀번호 = `DASHBOARD_PASSWORD`, 사용자 이름 무시) | 대시보드                                                                                                 |
| `GET /api/state`    | Basic                                                     | 현재 인원, 회원별 오늘·이번 주 시간, 최근 기록                                                           |
| `POST /api/members` | Basic, 같은 출처 JSON                                     | `{ "uid", "name" }` 회원 등록·이름 수정                                                                  |

## 배포

```sh
pnpm --filter @koin/attendance exec wrangler secret put DEVICE_TOKEN
pnpm --filter @koin/attendance exec wrangler secret put DASHBOARD_PASSWORD
pnpm deploy:attendance
```

KV 네임스페이스는 첫 배포 때 wrangler가 만들고 `id`를 기록합니다. 기록된 `wrangler.jsonc`를 커밋합니다. 토큰은 충분히 긴 무작위 값을 사용합니다(`openssl rand -hex 32`).

벽걸이 화면은 `https://:<DASHBOARD_PASSWORD>@<worker 주소>/` 로 열면 인증 창 없이 표시됩니다.

## 로컬 실행

```sh
printf 'DEVICE_TOKEN=dev-device-token\nDASHBOARD_PASSWORD=dev-password\n' > apps/attendance/.dev.vars
pnpm dev:attendance   # http://localhost:8787
curl -X POST localhost:8787/api/taps -H 'authorization: Bearer dev-device-token' \
  -H 'content-type: application/json' -d '{"uid":"04A1B2C3"}'
```

## 라즈베리파이

Raspberry Pi 3B 기준입니다. `READER`로 리더 종류를 고릅니다.

- `rc522`: GPIO(SPI)에 직접 연결한 RC522 모듈. 카드 UID를 16진수 대문자(예: `04A1B2C3`)로 보내고, 결과를 LED 두 개로 알립니다.
- `hid`(기본값): 카드 UID를 키 입력 + Enter로 보내는 USB HID 리더. 장치를 독점해 UID가 콘솔에 입력되지 않으며, 장치가 여러 개면 `READER_DEVICE`로 경로를 지정합니다.

같은 카드라도 리더 종류에 따라 UID 문자열이 다를 수 있으므로, 리더를 바꾸면 회원을 다시 등록합니다.

### RC522 배선

![Raspberry Pi 3B + RC522 + LED 배선](pi/wiring.png)

| 부품         | 연결                                | Pi 물리 핀(BCM) |
| ------------ | ----------------------------------- | --------------- |
| RC522 SDA    | SPI CE0                             | 24 (GPIO8)      |
| RC522 SCK    | SPI SCLK                            | 23 (GPIO11)     |
| RC522 MOSI   | SPI MOSI                            | 19 (GPIO10)     |
| RC522 MISO   | SPI MISO                            | 21 (GPIO9)      |
| RC522 IRQ    | 연결 안 함                          | -               |
| RC522 GND    | GND                                 | 25              |
| RC522 RST    | 리셋                                | 22 (GPIO25)     |
| RC522 3.3V   | 3.3V 전원(5V 연결 금지)             | 1               |
| 초록 LED     | GPIO → 330 Ω → 애노드, 캐소드 → GND | 16 (GPIO23)     |
| 빨강 LED     | GPIO → 330 Ω → 애노드, 캐소드 → GND | 18 (GPIO24)     |
| LED 공통 GND | GND                                 | 20              |

| 결과                        | LED           |
| --------------------------- | ------------- |
| 입실                        | 초록 1초      |
| 퇴실                        | 초록 2번 깜빡 |
| 10초 안 중복(무시)          | 초록 짧게 1번 |
| 미등록 카드                 | 빨강 1초      |
| 오프라인·서버 오류(큐 보관) | 빨강 2번 깜빡 |
| 거절(잘못된 UID 등)         | 빨강 3번 깜빡 |

시작할 때 초록·빨강이 차례로 한 번 켜집니다. 카드는 읽은 뒤 HALT시키므로 떼었다 다시 대야 다시 읽힙니다.

### 설치

```sh
sudo raspi-config nonint do_spi 0                       # rc522: SPI 활성화(/dev/spidev0.0)
sudo apt install python3-spidev python3-rpi.gpio         # rc522. hid는 python3-evdev
sudo install -D pi/reader.py /opt/attendance/reader.py
sudo install -m 600 /dev/null /etc/attendance-reader.env # ATTENDANCE_URL=…, DEVICE_TOKEN=…, READER=rc522
sudo install pi/attendance-reader.service /etc/systemd/system/
sudo systemctl enable --now attendance-reader
```

- 오프라인이면 태그를 `/var/lib/attendance/queue.jsonl`에 보관하고 30초마다 순서대로 재전송합니다. 태그 시각(`at`)은 파이 시계 기준이므로 NTP 동기화가 필요합니다.
- 인증 오류(401/403)·408·429·5xx는 큐에 남겨 재시도하고, 그 외 4xx(잘못된 UID 등)는 버립니다.
