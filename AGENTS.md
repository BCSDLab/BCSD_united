# 에이전트 작업 지침

코드 규칙·검증·커밋·운영 안전은 [CONTRIBUTING.md](./CONTRIBUTING.md)를 따른다.

## 문서에 작업 내역을 남기지 않는다

- README와 앱·스크립트 문서(`README.md`, `EXTENDING.md` 등)는 **현재** 동작·계약·설정·운영 절차만 설명한다.
- 작업 내역·변경 이력·날짜별 검증/배포/측정 기록·"~를 확인했다/통과했다/제거했다" 같은 경과 보고를 README에 쓰지 않는다. 운영 증거 상태나 세션 요약도 넣지 않는다.
- 그런 내용은 커밋 메시지와 PR 본문(수행한 검증, 남은 운영 전제조건)에 남긴다.
- 기능을 바꾸면 README의 해당 설명을 현재 상태로 고쳐 쓴다. 이전 동작을 덧붙이거나 "이전에는 ~였다"를 남기지 않는다.
- 수치·근거가 계약을 정하는 데 필요하면 날짜나 작업 경위 없이 현재 사실로만 적는다.

## 문서는 짧고 구체적으로 쓴다

- 구호·꾸밈말·추상적인 표현을 빼고 누가 무엇을 하는지 적는다.
- 쉬운 한국어로 쓸 수 있으면 불필요한 외래어·약어를 쓰지 않는다. 필요한 용어는 처음에만 설명한다.
- 같은 내용은 한 번만 쓴다. 표·목록·그림으로 반복하지 않는다. 외부 사례는 출처와 적용한 규칙만 남긴다.
- README는 개요·구조·실행 방법·필수 조건 중심으로 줄인다. 하니스는 구성 요소와 실제 연결을 구조도로 보여 준다.
- 명령·경로·옵션·스키마 키는 정확히 유지한다. 짧게 쓰려고 권한·비밀 관리·실패 조건·미구현·미검증 범위를 지우지 않는다.

## 문서 지도

이 파일은 목차다. 규칙과 절차는 아래 문서에 두고 여기에 옮겨 적지 않는다.

| 작업                                                      | 먼저 읽을 문서                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 코드 규칙·검증·커밋·운영 안전                             | [CONTRIBUTING.md](./CONTRIBUTING.md)                                                                   |
| 신기능·리디자인·에러 대응의 역할과 흐름, UI를 바꾸는 작업 | [docs/product-development](docs/product-development/README.md)                                         |
| 수락된 디자인 결정                                        | [docs/product-development/decisions](docs/product-development/decisions)                               |
| 작업 계약, 고정 커밋 실행, 검증·리뷰 상태                 | [docs/product-development의 하니스 절](docs/product-development/README.md#하니스)                      |
| 오류 자동 수정 Worker와 실행기                            | [apps/error-automation](apps/error-automation/README.md), [scripts/autofix](scripts/autofix/README.md) |
| 삐봇                                                      | [apps/b-bot](apps/b-bot/README.md)                                                                     |

작업 파일이 있는 작업은 `pnpm development next <작업 파일> <상태 파일>`로 다음 할 일을 확인하고 시작한다. 문서가 가리키는 경로를 옮기거나 지웠으면 `pnpm development:docs`로 확인한다.

`apps/web`의 화면·컴포넌트·스타일·문구·UI 상태를 바꾸거나 리뷰할 때는 [.agents/skills/product-design/SKILL.md](.agents/skills/product-design/SKILL.md)를 먼저 읽는다. API·Worker·스크립트만 바꾸는 작업에는 로드하지 않는다.
