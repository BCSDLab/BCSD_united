---
name: product-design
description: >-
  `apps/web`에서 사용자가 보는 것을 바꾸는 작업의 진입점이다. 화면, 컴포넌트, 스타일(SCSS), 화면 문구,
  로딩·빈 상태·오류·로그인 필요·비활성·긴 문구 상태, 리디자인을 설계·구현·리뷰·보강할 때 불러온다.
  화면 결과가 바뀌지 않는 API 전용 작업, Worker(`apps/api`, `apps/error-automation`, `apps/b-bot`),
  `scripts/`, UI에 영향이 없는 테스트에는 쓰지 않는다.
---

# KOIN 웹 제품 디자인

이 스킬은 규칙을 옮겨 적지 않고 원본 위치로 안내한다. 이 문서와 원본이 다르면 원본이 맞고, 같은 변경에서 이 문서를 고친다. 플랫폼 공통 원칙·역할·흐름은 [제품 개발 운영](../../../docs/product-development/README.md)에 있다.

## 1. 요청 방식

요청의 동사와 받은 자료로 방식을 먼저 정한다. 모호하면 더 좁은 방식을 고른다. URL·캡처·파일 경로는 범위를 알려 줄 뿐 수정 요청이 아니다.

| 방식      | 요청 예                                         | 내놓는 것                                                                                       | 하지 않는 것                                         |
| --------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| shape     | "어떻게 만들까", 화면이 정해지지 않은 기능 요청 | 사용자 행동 단위의 흐름, 도달하는 상태 목록, 쓸 공용 컴포넌트, 결정이 필요한 항목과 결정자      | 파일을 고치지 않는다                                 |
| implement | "만들어", "고쳐", "리디자인해"                  | 작업 범위 안의 코드 변경, 실행한 검사와 결과, 미검증 항목                                       | 범위 밖 리뷰 지적·리팩터링을 같은 변경에 넣지 않는다 |
| review    | "봐줘", "뭐가 문제야", PR 리뷰                  | 지적 목록. 지적마다 파일·줄 또는 화면 위치, 근거 문서, 확인 방법(실행 화면인지 소스만 읽었는지) | 파일을 고치지 않는다                                 |
| harden    | "마무리해", "빠진 상태 채워"                    | 정해진 화면 구성을 유지한 채 빠진 상태, 모바일 폭, 긴 문구, 린트 위반을 고친 변경               | 흐름·정보 구조·컴포넌트 선택을 바꾸지 않는다         |

## 2. 결정 우선순위

근거가 충돌하면 위쪽이 이긴다.

1. 사용자의 명시적 요청과 작업 파일(목표, 인수 시나리오, `paths`).
2. 수락된 결정 기록: [docs/product-development/decisions](../../../docs/product-development/decisions)에서 `Status: accepted`인 파일.
3. 저장소 기준 문서와 린트: [CONTRIBUTING.md](../../../CONTRIBUTING.md), [제품 개발 운영](../../../docs/product-development/README.md), [Stylelint 설정](../../../apps/web/.stylelint.json), [ESLint 설정](../../../apps/web/eslint.config.mjs).
4. 공용 컴포넌트의 현재 props와 스타일: `apps/web/src/components/ui`.
5. 같은 기능 영역의 인접 화면 패턴.

기존 구현은 무엇이 있는지 보여 주는 증거이며 표준이 아니다(운영 문서 원칙 1). 위 어디에도 근거가 없으면 [coverage-gaps.md](./coverage-gaps.md)에 따라 기준 없음으로 보고한다.

## 3. 작업 순서

1. **작업 계약을 읽는다.** 작업 파일이 있으면 `pnpm development brief <작업 파일>`로 목표·시나리오·의존성을, `pnpm development next <작업 파일> <상태 파일>`로 다음 할 일과 마지막 실패를 확인한다. 작업 파일에 없는 요구를 임의로 확정하지 않는다.
2. **화면을 찾는다.** 라우트는 `apps/web/src/routes`, 화면 컴포넌트는 `apps/web/src/components` 아래 기능 폴더에 있다. 그 화면이 이미 쓰는 공용 컴포넌트와 `*.module.scss`를 읽는다.
3. **범위를 판정한다.** 변경이 디자인 시스템 범위 안인지, 결정을 기다리는지는 운영 문서의 [어떤 변경이 결정을 기다리는가](../../../docs/product-development/README.md#어떤-변경이-결정을-기다리는가) 표로 정한다. 결정이 필요하면 범위 안인 부분은 계속 구현하고, 미정 항목은 [결정 기록](../../../docs/product-development/README.md#결정-기록) 형식의 `proposed` 후보로 낸다. 수락은 표의 결정자가 한다.
4. **구현한다.** 토큰 → 공용 컴포넌트 → 인접 패턴 순서로 조합한다. 값과 SCSS는 [references/styling.md](./references/styling.md), 컴포넌트 선택과 props는 [references/components.md](./references/components.md)를 따른다.
5. **도달하는 상태를 채운다.** [references/states.md](./references/states.md)의 점검표에서 이 화면이 실제로 들어갈 수 있는 상태만 구현한다.
6. **검증한다.** `apps/web/package.json`에 있는 검사를 실행한다. 전체 목록은 CONTRIBUTING.md의 [검증과 커밋](../../../CONTRIBUTING.md#검증과-커밋)이다.

   ```sh
   pnpm --filter @koin/web lint:stylelint
   pnpm --filter @koin/web lint:eslint
   pnpm --filter @koin/web typecheck
   ```

   화면은 `pnpm dev:web`으로 띄워 데스크톱 폭과 모바일 폭에서 바뀐 상태를 직접 본다. 작업 파일에 시나리오가 있으면 운영 문서의 [실행 절차](../../../docs/product-development/README.md#실행-절차)대로 `pnpm development run`(상태를 바꾸지 않는다) 또는 `verify`를 실행한다.

7. **보고한다.** 실행한 명령과 결과, 실행하지 못한 검사·시나리오·상태(미검증), 새로 쓴 값과 화면 전용으로 둔 값의 이유, 결정을 기다리는 항목을 적는다. 소스만 읽은 것을 화면에서 확인했다고 쓰지 않는다. Figma 프레임·버전은 사람이 Figma 앱에서 만들므로 남은 일로 적는다.

## 4. 참조 문서

| 작업                                                       | 읽을 문서                                                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 공용 컴포넌트 선택, props, 화면에서 바꾸지 않는 것         | [references/components.md](./references/components.md)                                              |
| 색·글자 크기·모서리 값, SCSS 작성, 모바일 분기             | [references/styling.md](./references/styling.md). 토큰 이름은 `apps/web/src/utils/scss/tokens.scss` |
| 로딩·빈 상태·오류·로그인 필요·비활성·긴 문구               | [references/states.md](./references/states.md)                                                      |
| 화면 문구, 기준이 있는지 모르는 영역                       | [coverage-gaps.md](./coverage-gaps.md)                                                              |
| 범위 판정, 역할, 결정 기록 형식, 반복 지적의 반영          | [제품 개발 운영](../../../docs/product-development/README.md)                                       |
| 화면 이동(`ROUTES`), 오류 표시(`showToast`), 페이지 loader | CONTRIBUTING.md의 [코드 규칙](../../../CONTRIBUTING.md#코드-규칙)                                   |
| 작업 파일, 고정 커밋 실행, 증거, 검증·리뷰 상태            | 운영 문서의 [하니스](../../../docs/product-development/README.md#하니스)                            |

## 5. 스킬 유지

- 규칙은 현재 소스로 확인한 근거와 결정자의 수락이 있을 때만 더하거나 바꾼다. 수락 전에는 `proposed` 결정 기록으로만 둔다.
- 화면 하나, 캡처 한 장, 리뷰 지적 하나를 규칙으로 올리지 않는다(운영 문서의 [피드백 반영](../../../docs/product-development/README.md#피드백-반영)).
- 새로 알게 된 것은 가장 좁은 곳에 둔다: 기계적으로 판정되면 린트 설정, 판단이 필요하면 해당 `references` 문서, 기준이 없으면 [coverage-gaps.md](./coverage-gaps.md).
- `references`에는 소스에서 확인되는 사실만 적는다. 토큰 이름·값, 운영 문서의 표를 옮겨 적지 않는다.
- 규칙은 "깔끔하게" 같은 형용사가 아니라 관찰 가능한 문장으로 적는다.
- 컴포넌트 props나 경로가 바뀌면 같은 변경에서 이 스킬을 고치고, 저장소 루트에서 `node scripts/development/docs-check.mjs <스킬 파일>`로 경로를 확인한다.
