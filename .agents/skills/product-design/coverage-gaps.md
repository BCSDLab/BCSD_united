# 기준이 없는 영역

수락된 결정 기록, 린트, 공용 컴포넌트 중 어느 것도 답을 주지 않는 영역이다. 플랫폼 전체 목록은 운영 문서의 [아직 없는 것](../../../docs/product-development/README.md#아직-없는-것)에 있고, 여기에는 웹 화면 작업에서 마주치는 것만 적는다.

작업이 이 영역에 걸리면 다음과 같이 한다.

1. 규칙을 새로 만들지 않는다. 같은 기능 영역의 구현을 따르고, 근거로 삼은 파일을 보고에 적는다.
2. 보고와 PR에 "기준 없음"으로 표시하고 고른 값·구성을 적는다.
3. 같은 질문이 반복되면 운영 문서의 [피드백 반영](../../../docs/product-development/README.md#피드백-반영)대로 `proposed` 결정 기록 후보를 낸다. 수락은 결정자가 한다.

결정 기록이 수락되거나 린트·컴포넌트가 생기면 같은 변경에서 해당 항목을 여기서 지운다.

## 운영 문서의 목록 중 웹 화면 작업에 걸리는 것

- **카탈로그.** 공용 컴포넌트와 그 상태를 한곳에서 보는 카탈로그 화면이 없다. `apps/web/package.json`에 카탈로그 도구가 없고 `apps/web/src/routes`에 카탈로그 라우트가 없다.
- **시각 회귀.** 캡처를 기준 이미지와 비교하는 단계(`scripts/development/visual-diff.mjs`)는 있지만 기준 이미지는 저장소에 없다. 회귀 대상은 운영 문서의 [회귀 실행 준비](../../../docs/product-development/README.md#회귀-실행-준비)에서 정해지지 않았다.
- **디자인 규칙 린트.** 있는 것은 클래스 이름 패턴과 `apps/web/src/components/ui` 안의 hex 색 금지 두 가지다([references/styling.md](./references/styling.md)). `className`으로 공용 컴포넌트의 시각 속성을 덮어쓰는지, 그 폴더 밖에서 값을 직접 쓰는지는 린트가 잡지 않는다.
- **결정자.** `apps/web/src/components/ui`와 `apps/web/src/utils/scss`는 [CODEOWNERS](../../../.github/CODEOWNERS)에 없다. 새 공통 컴포넌트·토큰은 작업에 지정된 플랫폼 리뷰어가 결정한다.
- **Figma.** 프레임을 둘 파일·페이지가 정해지지 않았고, 코드 토큰을 Figma로 내보내는 도구와 프레임을 자동으로 만드는 연결이 없다. 에이전트는 Figma 프레임·버전을 만들 수 없다.
- **문구.** 화면 문구의 용어·어조 기준 문서가 없다. 웹은 `KOIN_STRINGS`를 참조하지 않으며, 문구를 바꿀 때 그쪽에 반영할지와 결정자가 정해지지 않았다.

## 저장소에서 확인한 것

### 토큰

- 토큰 모듈(`apps/web/src/utils/scss/tokens.scss`)이 다루는 종류는 색, 글자 크기, 글자 굵기, 모서리 반경, 그림자다. 간격, 줄 높이, z-index, 전환 시간 토큰은 없다.
- 토큰을 쓰는 SCSS는 `apps/web/src/components/ui` 안의 파일뿐이다. 그 밖의 화면 SCSS는 값을 직접 적고 있다. 현황은 저장소 루트에서 `node scripts/development/tokens.mjs report apps/web/src`로 본다.
- 글자 크기·굵기·줄 높이를 묶은 타이포그래피 믹스인이 없다. `apps/web/src/utils/scss`의 믹스인은 모바일 분기(`media`), 폼 라벨(`field-label`), 이전한 상점·주문 화면의 초기화와 글꼴(`order-preflight`)이다.
- 웹 전역 토큰의 이름과 값은 `docs/product-development/decisions/0001-code-is-the-design-system-source.md`의 `Open decisions`에 남아 있다.

### 컴포넌트

- `apps/web/src/components/ui`의 컴포넌트를 수락한 결정 기록이 없다. 운영 문서의 [범위](../../../docs/product-development/README.md#범위)에 따른 임시 범위다.
- 그 폴더에 없는 종류: 텍스트 입력·체크박스·라디오·토글 같은 폼 입력, 탭, 기능에 묶이지 않은 가운데 모달, 토스트, 로딩(스피너·스켈레톤), 빈 상태, 오류 표시. 일부는 폴더 밖에 구현이 있다: `apps/web/src/components/feedback/LoadingSpinner/index.tsx`, `apps/web/src/utils/ts/showToast.ts`, `apps/web/src/components/Store/mobile/common/CenterModal/index.tsx`.
- 같은 역할의 구현이 여러 개이고 어느 것이 기준인지 정해지지 않았다.
  - 바텀 시트: `apps/web/src/components/ui/BottomModal/index.tsx`, `apps/web/src/components/Store/mobile/common/BottomModal/index.tsx`
  - 로그인 필요 모달: `apps/web/src/components/ui/InducingLoginModal/index.tsx`, `apps/web/src/components/modal/LoginRequiredModal/index.tsx`, `apps/web/src/components/Store/mobile/common/LoginRequiredModal/index.tsx`
  - 안내 모달: `apps/web/src/components/modal/Modal/AlertModal/index.tsx`, `apps/web/src/components/Store/mobile/common/AlertModal/index.tsx`
  - 달력: `apps/web/src/components/ui/DatePicker/index.tsx`, `apps/web/src/components/ui/DatePickerModal/index.tsx`
  - 검색 입력: `apps/web/src/components/ui/SearchBar/index.tsx`, `apps/web/src/components/Store/mobile/StoreListPage/components/SearchBar/index.tsx`
- 공용 Button과 Badge는 소스 주석이 모바일 상점·주문 화면용이라고 적고, import하는 곳도 `apps/web/src/components/Order`와 `apps/web/src/components/Store`뿐이다. 그 밖의 화면에서 쓸 버튼의 기준은 없다.
- "배치용 클래스"에 들어가는 속성의 목록이 없다. 운영 문서가 덮어쓰기 금지로 든 것은 색·모서리·그림자다.
- 기존 화면 중에는 `className`으로 공용 컴포넌트의 테두리·그림자·색을 덮어쓰는 곳이 있다(`apps/web/src/components/Store/mobile/common/ConfirmModal/ConfirmModal.module.scss`, `apps/web/src/components/Store/mobile/StoreListPage/StoreListPage.module.scss`). 운영 문서의 규칙과 다르므로 새 코드의 근거로 쓰지 않는다.

### 상태

- 로그인 필요, 로딩, 빈 상태, 조회 오류를 어떤 모양과 문구로 보여 줄지의 기준이 없다. 구현 예는 [references/states.md](./references/states.md)에 있다.
- 화면에 직접 적힌 고정 문구를 다국어로 내는 수단이 없다. `apps/web/package.json`에 번역 라이브러리가 없고, 번역되는 값은 조회 API가 내려주는 `display_*` 필드다(`apps/web/src/utils/language/requestLanguage.ts`).

### 검증

- `apps/web/test`에는 화면을 렌더하는 테스트가 없다. 화면 변경은 린트·타입 검사와 실행 화면으로 확인한다.
- 하니스가 자동으로 여는 화면과 시나리오는 `scripts/development/web-scenario.mjs`에 있는 것이 전부다. 거기에 없는 화면·상태는 직접 띄워 확인하고, 확인하지 못한 것은 미검증으로 보고한다.
