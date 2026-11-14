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

| 경로                  | 인증                                                      | 용도                                                                                                     |
| --------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POST /api/taps`      | `Authorization: Bearer <DEVICE_TOKEN>`                    | `{ "uid": "04A1B2C3", "at": 1760000000000 }` (`at` 생략 시 서버 시각. 미래 60초·과거 7일을 벗어나면 400) |
| `GET /`               | Basic (비밀번호 = `DASHBOARD_PASSWORD`, 사용자 이름 무시) | 대시보드                                                                                                 |
| `GET /api/state`      | Basic                                                     | 현재 인원, 회원별 오늘·이번 주 시간, 최근 기록                                                           |
| `POST /api/members`   | Basic, 같은 출처 JSON                                     | `{ "uid", "name" }` 회원 등록·이름 수정                                                                  |
| `GET /api/automation` | Basic                                                     | 독립적인 오류 수신 요약과 Rocky 읽기 전용 헬스. RFID Bearer로 접근 불가                                  |

## 대시보드

- 서버가 제공하는 단일 HTML 화면에 [Mobbin의 공개 업무용 대시보드 패턴](https://mobbin.com/explore/web/screens/analytics-dashboard)을 참고한 Material Design 3의 색상·서피스·타이포그래피를 적용합니다. 사이드바 없이 구성하며 외부 폰트나 UI 라이브러리를 불러오지 않습니다.
- 현재 인원과 입실 중인 회원의 체류 시간을 크게 표시하고, 전체 회원의 오늘·이번 주 체류 시간 합계와 퇴근 미기록 건수를 보여 줍니다. 회원별 표와 이번 주 최근 세션 최대 15건을 함께 제공합니다.
- 16:9 데스크톱 화면에서는 본문 스크롤 없이 주요 패널을 한 화면에 배치하고, 긴 목록은 각 패널의 이전·다음 버튼으로 넘깁니다. 화면 크기에 맞춰 표시 개수가 바뀌고 새로고침 후에도 선택한 페이지를 유지합니다.
- 테마 버튼은 자동(시스템 설정) → 라이트 → 다크 순서로 전환하며 선택을 브라우저에 저장합니다. 작은 화면에서는 카드가 재배치되고 표는 가로로 스크롤할 수 있습니다.
- 데이터는 10초마다 갱신하고 입실 중인 회원의 체류 시계는 매초 갱신합니다. 상태 조회·등록 요청은 응답 본문 수신까지 10초로 제한하며, 새로고침 버튼으로 즉시 갱신할 수 있습니다. 연결 실패 시 마지막 데이터임을 표시하고 체류 시계를 마지막 동기화 시각에 멈춥니다. 처음부터 불러오지 못한 경우 수치를 임의로 표시하지 않습니다.
- 미등록 카드는 화면에서 이름을 입력해 등록합니다. 주기적 갱신에도 입력과 포커스를 유지하며 등록 중·완료·오류 상태를 카드별로 표시합니다. 등록 전 태그는 입실 기록이 아니므로 등록 후 카드를 다시 태그해야 합니다.
- 회원 이름과 카드 정보는 `textContent`로만 출력합니다. 상태 조회와 등록은 같은 출처의 기존 인증을 사용하며 등록은 JSON 요청으로만 전송합니다.
- 배포는 BCSDLab 조직 Gateway를 요구하는 접근 정책을 전제로 합니다. 일반 소비자 WARP 접속만 허용하는 정책은 충분하지 않습니다. Worker의 모든 도메인·미리보기 우회 경로를 보호하기 전에는 공개 경로를 활성화하지 않습니다.

## 오류 수신·Rocky 읽기 전용 모니터

- 서버의 `ERROR_AUTOMATION` Worker service binding이 고정된 `bcsd-error-automation`의 `GET /healthz`와 `GET /healthz/rocky`를 병렬로 읽습니다. 브라우저·Pi에는 관리/모델/진단/호스트 모니터 토큰을 주지 않습니다.
- 두 Worker에 별도의 동일한 `ERROR_MONITOR_TOKEN`을 secret으로 설정해야 합니다(32자 이상 무작위 값). `DEVICE_TOKEN`, `DASHBOARD_PASSWORD`, 실행기·진단·모델 토큰을 재사용하지 않습니다. secret 설정은 배포 작업이므로 정상 운영 승인 절차를 따릅니다.
- 수신 요약은 Sentry/Cloudflare의 최근 24시간 **고유 오류 등록 건수**, 최근 신규 등록 시각과 최대 10개의 처리 상태입니다. 건수와 최근 시각은 목록 제한과 독립적으로 전체 기간에서 계산합니다. 중복 웹훅 전달 횟수나 마지막 재전송 시각이 아니며 GitHub PR 리뷰와 미사용 `koin-api` 기록은 제외합니다.
- Rocky는 기존 `OMP_GATEWAY` VPC와 `koin-omp-gateway-rocky` 터널을 통해 게이트웨이의 고정 `GET /healthz`만 조회합니다. `OMP_GATEWAY_MONITOR_TOKEN`은 error-automation과 호스트만 공유하는 별도 secret이며 모델·실행기·수신 요약 토큰과 같으면 거부합니다. 호스트 설정은 [게이트웨이 운영 계약](../../scripts/autofix/README.md#rocky-읽기-전용-헬스-활성화)을 따릅니다.
- CPU는 Linux `/proc/stat` 두 표본의 busy 비율, RAM 사용량은 `MemTotal − MemAvailable`입니다. 실행기·브로커는 고정 systemd 서비스의 설치/활성/프로세스 상태를 구분합니다. 서비스 활성이나 프로세스 실행은 브로커 HTTP 응답·모델 인증·작업 완료의 증거가 아니며 모델 상태는 미확인으로 표시합니다.
- 오류 전문·프롬프트·소스·로그·원본 provider ID·자격 증명을 반환하지 않습니다. 조회가 작업 claim, 모델 생성, GitHub 작업을 시작하지 않습니다.
- 출근부 조회와 별개로 60초마다 갱신합니다. 조회별 5초 본문 수신 기한·16 KiB JSON 한도·리다이렉트 거절을 적용하고 120초보다 오래된 스냅샷은 unknown으로 처리합니다.
- `/api/automation`의 최상위 `state`/`data`는 수신 요약이고 `rocky.state`/`rocky.data`는 호스트 관측입니다. 한쪽 실패가 다른 쪽의 관측을 지우지 않습니다. 미설정·연결 실패·응답 불일치는 해당 결과의 `state: unknown`, `data: null`이며 측정 실패 CPU/RAM도 null입니다. 실제 조회한 빈 저장소만 0건으로 표시하고 조용한 수신량을 장애로 판단하지 않습니다.
- 연결 실패·오프라인·숨긴 화면·확인 기한 초과 시 마지막 관측은 과거 기록임을 표시합니다. 조직 Gateway 보호와 기존 비공개 노출 경계는 유지하며 새 터널·공개 SSH·WARP/OpenBao 권한은 추가하지 않습니다.

## 배포

```sh
# 기존 DEVICE_TOKEN·DASHBOARD_PASSWORD는 유지합니다. 비밀값 설정·회전은 별도 운영 절차입니다.
pnpm deploy:attendance
```

`wrangler.jsonc`의 `ATTENDANCE`는 기존 운영 KV 네임스페이스를 고정합니다. 새 네임스페이스를 만들거나 id를 바꾸면 기존 데이터와 분리되므로 배포 중 치환하지 않습니다. 새 토큰이 필요할 때만 충분히 긴 무작위 값으로 별도 설정합니다(`openssl rand -hex 32`).

벽걸이 화면은 대시보드 경로(`/`)를 열고 Basic 인증 창에서 `DASHBOARD_PASSWORD`로 인증합니다. 비밀번호를 URL에 넣지 않습니다.

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
sudo raspi-config nonint do_spi 0                       # rc522: 부팅 시 SPI 활성화
sudo dtparam spi=on                                    # rc522: 재부팅 없이 현재 부팅에도 적용
sudo apt install python3-spidev python3-rpi-lgpio        # Raspberry Pi OS Trixie. hid는 python3-evdev
sudo install -D -o root -g root -m 755 pi/reader.py /opt/attendance/reader.py
sudo install -o root -g root -m 644 pi/attendance-reader.service /etc/systemd/system/
sudo systemctl daemon-reload
```

RC522는 `/dev/spidev0.0`과 위 배선을 사용합니다. SPI 장치 파일이 있다는 것만으로 모듈 연결이 확인되지는 않습니다. 시작 시 `RC522 응답 없음`이면 3.3V 전원·GND·CE0·SCLK·MOSI·MISO·RST 배선을 확인합니다. USB HID는 `/dev/input/by-id/*-event-kbd`에 실제 리더가 있어야 합니다.

실제 Worker 주소와 해당 Worker의 `DEVICE_TOKEN`을 받은 뒤에만 런타임 설정을 작성하고 서비스를 시작합니다. 진단 중이거나 모듈·카드 인식이 확인되지 않았다면 전송 루프를 켜지 않습니다. 네트워크 접근 정책이 있는 배포는 Pi에서도 허용된 경로로 Worker에 접근할 수 있어야 합니다.

```sh
sudo touch /etc/attendance-reader.env
sudo chown root:root /etc/attendance-reader.env
sudo chmod 600 /etc/attendance-reader.env
sudoedit /etc/attendance-reader.env
# ATTENDANCE_URL=<실제 Worker 기본 주소>
# DEVICE_TOKEN=<해당 Worker의 실제 토큰>
# READER=rc522  (USB HID는 hid; 필요하면 READER_DEVICE도 지정)
sudo systemctl enable --now attendance-reader.service
```

- 오프라인이면 태그를 `/var/lib/attendance/queue.jsonl`에 보관하고 30초마다 순서대로 재전송합니다. 태그 시각(`at`)은 파이 시계 기준이므로 NTP 동기화가 필요합니다.
- 인증 오류(401/403)·408·429·5xx는 큐에 남겨 재시도하고, 그 외 4xx(잘못된 UID 등)는 버립니다.
