# 출근부 (attendance)

인터널 출입 카드를 리더로 태그하면 입실/퇴실을 기록하고, 대시보드에 현재 인원과 체류 시간을 보여 주는 Worker입니다. 저장소는 Workers KV입니다.

```text
Arduino + RC522 ──USB 시리얼──▶ 라즈베리파이(pi/reader.py) ──POST /api/taps──▶ Worker + KV ──▶ 대시보드(/)
(또는 USB HID 리더 ───────────▶ 라즈베리파이)
```

## 동작 규칙

- 태그는 토글입니다. 열린 세션이 없으면 입실, 있으면 퇴실입니다.
- 같은 회원의 직전 이벤트 후 10초 안의 태그(카드 중복 인식)와, 직전 이벤트보다 이른 재전송은 무시합니다.
- 퇴근 태그가 없는 세션은 입실 후 6시간(`MAX_SESSION_MS`)이 지나면 입실 중으로 보지 않습니다. 같은 회원의 다음 태그가 6시간 시점에 그 세션을 자동 종료(`autoClosed`)하고 새 입실을 만듭니다. 이런 세션은 실제 체류 시간을 알 수 없으므로 오늘·이번 주 시간 합계에 넣지 않고, 대시보드에 "퇴근 미기록"으로 건수를 표시합니다.
- 오늘·이번 주(월요일 시작) 경계는 KST입니다. 자정을 걸친 세션은 날짜별로 나눠 합산합니다.
- 등록되지 않은 카드를 태그하면 `unknown:<uid>`에 쌓이고, 대시보드의 "미등록 카드"에서 이름을 입력해 등록합니다. 같은 카드로 다시 등록하면 이름만 바뀝니다.

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

## Arduino 리더

`arduino/reader/reader.ino`는 Arduino Uno/Nano + RC522(MFRC522) 모듈용입니다. 카드를 대면 UID를 16진수 대문자 한 줄로 USB 시리얼(9600 baud)에 보내고 부저(D7)를 울립니다. 같은 카드를 2초 안에 다시 읽으면 보내지 않습니다.

1. Arduino IDE 라이브러리 관리자에서 `MFRC522`를 설치합니다.
2. 스케치 상단 주석의 배선(SS=D10, RST=D9, SCK=D13, MOSI=D11, MISO=D12, RC522는 3.3V)대로 연결해 업로드합니다.
3. Arduino를 라즈베리파이 USB에 꽂고 아래 설정에서 `ARDUINO_SERIAL`을 지정합니다.

Arduino 자체는 인터넷에 연결하지 않으므로 Worker 전송·오프라인 큐는 라즈베리파이가 맡습니다.

## KOREATECH 앱(폰)

`arduino/pn532_reader/pn532_reader.ino`는 PN532 모듈용입니다. KOREATECH 앱이 켜진 폰과 일반 NFC 카드를 모두 읽어, 폰이면 학번을, 카드면 UID를 한 줄로 시리얼에 보냅니다. RC522는 폰(HCE)의 APDU 교환이 안정적이지 않아 이 용도에 쓰지 않습니다.

- 배선(Uno/Nano, PN532 스위치는 I2C): SDA→A4, SCL→A5, IRQ→D2, RESET→D3, 부저 D7. 라이브러리 `Adafruit PN532`.
- 폰과의 통신은 ISO-DEP APDU 두 개입니다. `00 A4 04 00 0B <AID> 00`(AID `D4 10 00 00 39 53 31 53 49 49 44`)로 선택한 뒤 `00 B2 01 0C 10`을 보내면 18바이트(학번 13자리 BCD + 패딩 8바이트 + `90 00`)가 돌아옵니다. 학번 = 앞 13자리에서 앞의 0을 뗀 값입니다.
- 폰은 화면이 켜져 있어야 응답합니다. 앱에 로그인하지 않은 폰은 학번이 전부 0이라 무시합니다.
- 이름은 카드에 없으므로 학번을 회원 키(`uid`)로 등록합니다. 처음 태그하면 "미등록 카드"에 뜨고, 이름을 넣으면 됩니다.
- 학번은 개인정보입니다. 등록하지 않은 학번은 7일 뒤 자동 삭제됩니다. 구성원 동의를 받은 용도로만 사용합니다.
- 앱의 응답은 서명 없는 평문이라 학번을 아는 사람이 같은 응답을 흉내 내 대리 출석할 수 있습니다. 이 출근부는 그 위험을 막지 않으므로 신뢰 가능한 구성원 간의 출석 확인에만 씁니다.

## 라즈베리파이

`ARDUINO_SERIAL`이 있으면 해당 시리얼 포트를, 없으면 카드 UID를 키 입력 + Enter로 보내는 USB HID 리더를 읽습니다.

```sh
sudo apt install python3-serial   # HID 리더는 python3-evdev
sudo install -D pi/reader.py /opt/attendance/reader.py
sudo install -m 600 /dev/null /etc/attendance-reader.env   # ATTENDANCE_URL=…, DEVICE_TOKEN=…, ARDUINO_SERIAL=/dev/ttyACM0
sudo install pi/attendance-reader.service /etc/systemd/system/
sudo systemctl enable --now attendance-reader
```

- 시리얼 포트가 끊겨도 5초마다 재연결합니다. HID 모드는 리더 장치를 독점해 UID가 콘솔에 입력되지 않으며, 장치가 여러 개면 `READER_DEVICE`로 경로를 지정합니다.
- 오프라인이면 태그를 `/var/lib/attendance/queue.jsonl`에 보관하고 30초마다 순서대로 재전송합니다. 태그 시각(`at`)은 파이 시계 기준이므로 NTP 동기화가 필요합니다.
- 인증 오류(401/403)·408·429·5xx는 큐에 남겨 재시도하고, 그 외 4xx(잘못된 UID 등)는 버립니다.
