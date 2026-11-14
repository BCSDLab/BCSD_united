# 비공개 출근부 스냅샷·자동화 모니터

`bcsd-attendance`는 Pi가 게시한 출입 현황의 관측 시점 스냅샷을 읽는 Worker입니다. 출입 원장을 저장하거나 회원·태그를 수정하지 않습니다. 오류 수신 요약과 Rocky 헬스는 별도 Worker service binding으로 조회합니다.

## 인증과 읽기 전용 경계

- 플랫폼이 검증한 `ctx.access.aud`가 운영 `CF_ACCESS_AUD`와 같아야 화면·데이터에 접근할 수 있습니다. 클라이언트가 보낸 JWT 헤더·쿠키·Basic·기기 Bearer를 인증 근거로 해석하지 않습니다.
- `CF_ACCESS_AUD` 미설정은 503, 플랫폼 Access 컨텍스트 누락·다른 audience는 403입니다. `keep_vars: true`로 운영에서 관리하는 audience를 보존합니다.
- 허용 목록의 GET과 `/`의 HEAD만 받습니다. 쿼리·해시·관리자·카메라·로그인·쓰기 경로를 중계하지 않습니다. `/api/taps`와 `/api/members`는 제공하지 않습니다.
- 기존 `DEVICE_TOKEN`·`DASHBOARD_PASSWORD`를 자동 회전·삭제하지 않지만 원격 뷰어의 인증 우회 경로로 사용하지 않습니다. 신규 공개 경로나 Access 권한을 만들지 않습니다.

## Pi 관측 스냅샷

`VIEW_STATE`는 기존 조회 전용 KV `b519a98db46d4b088baee97a256bf0f0`의 `clubroom:view:v1`을 읽습니다. 원본 출입 원장 KV를 읽거나 쓰거나 치환하지 않습니다. 게시 작업은 별도 Pi 수집·게시 프로세스의 책임입니다.

스냅샷은 `{version:1, observedAt, publishedAt, payloads, assets}`이며 최대 2 MiB입니다. 관측 시각보다 게시 시각이 빠르거나 미래인 자료, 5분 초과 자료, 누락·잘못된 자료는 503입니다. 실제 LAN origin으로 우회하거나 빈 값으로 바꾸지 않습니다.

| 경로                                                     | 응답                                         |
| -------------------------------------------------------- | -------------------------------------------- |
| `/`                                                      | 단일 읽기 전용 화면, HEAD 지원               |
| `/api/state`                                             | 관측 시점의 출입 현황                        |
| `/api/monitor`, `/api/koin-health`, `/api/worker-health` | Pi가 게시한 관측 시점 상태                   |
| `/api/spotify`, `/api/jam`                               | 관측 시점 재생·참여 정보                     |
| `/api/wifi-qr/2.4`, `/api/wifi-qr/5`, `/api/jam-qr`      | 허용된 PNG, 개별 최대 256 KiB                |
| `/api/view-status`                                       | 스냅샷 가용성·관측/게시 시각·나이            |
| `/health`                                                | 스냅샷 모드·관측/게시 시각·나이              |
| `/api/events`                                            | 최대 60초 SSE, 10초마다 스냅샷 상태 확인     |
| `/api/automation`                                        | 독립적인 오류 수신 요약·Rocky 읽기 전용 헬스 |

스냅샷 응답은 게시된 상태 코드를 보존하며 `X-BCSD-Snapshot-*` 헤더로 관측 시각을 구분합니다. 모든 응답은 private/no-store, CSP, nosniff, 프레임 차단을 적용합니다.

## 오류 수신·Rocky 읽기 전용 모니터

- `ERROR_AUTOMATION` service binding으로 고정된 `bcsd-error-automation`의 `/healthz`와 `/healthz/rocky`를 병렬 조회합니다. Pi 스냅샷이 없어도 이 조회는 독립적으로 동작합니다.
- `ERROR_MONITOR_TOKEN`은 두 Worker만 공유하는 신규 전용 secret입니다. 브라우저·Pi에는 전달하지 않으며 기기·대시보드·실행기·진단·모델 토큰과 재사용하지 않습니다.
- 수신 요약은 Sentry/Cloudflare 최근 24시간의 고유 오류 등록 건수·최근 신규 등록 시각·최대 10개 처리 상태입니다. 건수는 목록 제한과 독립적으로 계산하며 중복 전달량이 아닙니다. PR 리뷰 작업과 미사용 `koin-api` 기록은 제외합니다.
- Rocky는 error-automation이 기존 `OMP_GATEWAY` VPC와 `koin-omp-gateway-rocky` 터널의 고정 healthz를 별도 `OMP_GATEWAY_MONITOR_TOKEN`으로 읽습니다. 이 호스트 토큰은 출근부가 받지 않습니다.
- CPU는 Linux `/proc/stat` 두 표본의 busy 비율, RAM은 `MemTotal − MemAvailable`입니다. 실행기·브로커의 서비스·프로세스 상태와 브로커 HTTP 응답·모델 정상 여부를 구분합니다. 모델 생성·작업 claim·GitHub 작업은 수행하지 않습니다.
- 최상위 `state`/`data`는 수신 요약이고 `rocky.state`/`rocky.data`는 호스트 관측입니다. 실패는 해당 결과의 unknown/null이며 실제 빈 저장소만 0건입니다. 측정 실패 CPU/RAM도 null입니다.
- 60초마다 조회하며 서버 조회별 5초·16 KiB·리다이렉트 거절·UTF-8·120초 신선도 검사를 적용합니다. `servedAt`과 단조 시계로 화면의 확인 기한을 계산하므로 키오스크 벽시계에 의존하지 않습니다.
- 연결 실패·오프라인·숨김·기한 초과는 미확인으로 표시하고 마지막 관측은 과거 기록으로 구분합니다. Pi 스냅샷 표시가 중단돼도 독립 모니터는 표시합니다.
- 오류 전문·프롬프트·소스·로그·원본 provider ID·lease·자격 증명은 반환하지 않습니다. 상세 호스트 설정은 [게이트웨이 운영 계약](../../scripts/autofix/README.md#rocky-읽기-전용-헬스-활성화)을 따릅니다.

## 화면과 배포

Pi 조회 화면·관측 시각·Wi-Fi/Spotify/모니터 화면을 유지하며 외부 UI 라이브러리나 Static Assets를 사용하지 않습니다. `src/dashboard.html`은 Worker Text 모듈입니다. 벽걸이 화면은 패널별 페이지를 사용하고 작은 화면에서는 재배치합니다. 회원 이름 등 데이터는 textContent로만 표시합니다.

웹·오류 자동화의 정상 main 승격 후 이 Worker를 별도 배포합니다. `VIEW_STATE` ID와 외부 관리 Access audience, 기존 secret을 유지합니다. secret 설정도 배포 작업입니다. 운영 승인 없이 원장 KV·도메인·Access 정책을 바꾸거나 별도 공개 테스트 Worker를 만들지 않습니다.

```sh
pnpm --dir apps/attendance exec wrangler types --include-runtime false
pnpm --dir apps/attendance typecheck
pnpm --dir apps/attendance test
pnpm --dir apps/attendance exec wrangler deploy --dry-run
```

로컬에서도 플랫폼 Access 컨텍스트가 없으면 403입니다. 클라이언트 헤더를 인증 우회로 추가하지 않습니다. API 회귀는 격리된 플랫폼 컨텍스트·KV fixture로 검증합니다.

## LAN 리더 배선·설치

Raspberry Pi 3B 기준입니다. `READER`로 리더 종류를 고릅니다.
리더의 `ATTENDANCE_URL`은 승인된 LAN 수집 API 주소입니다. 이 읽기 전용 원격 Worker 주소로 태그를 전송하지 않습니다.

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

실제 LAN 수집 API 주소와 전용 기기 토큰을 받은 뒤에만 런타임 설정을 작성하고 서비스를 시작합니다. 진단 중이거나 모듈·카드 인식이 확인되지 않았다면 전송 루프를 켜지 않습니다.

```sh
sudo touch /etc/attendance-reader.env
sudo chown root:root /etc/attendance-reader.env
sudo chmod 600 /etc/attendance-reader.env
sudoedit /etc/attendance-reader.env
# ATTENDANCE_URL=<실제 LAN 수집 API 주소>
# DEVICE_TOKEN=<LAN 수집 API의 전용 기기 토큰>
# READER=rc522  (USB HID는 hid; 필요하면 READER_DEVICE도 지정)
sudo systemctl enable --now attendance-reader.service
```

- 오프라인이면 태그를 `/var/lib/attendance/queue.jsonl`에 보관하고 30초마다 순서대로 재전송합니다. 태그 시각(`at`)은 파이 시계 기준이므로 NTP 동기화가 필요합니다.
- 인증 오류(401/403)·408·429·5xx는 큐에 남겨 재시도하고, 그 외 4xx(잘못된 UID 등)는 버립니다.
