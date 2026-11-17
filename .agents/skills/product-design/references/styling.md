# 스타일 작성

웹 스타일은 SCSS 모듈이다. 아래는 린트 설정과 공용 SCSS에서 확인한 내용이며, 다르면 [Stylelint 설정](../../../../apps/web/.stylelint.json), [ESLint 설정](../../../../apps/web/eslint.config.mjs), `apps/web/src/utils/scss`의 파일이 맞다.

## 파일과 클래스

- 컴포넌트 폴더에 `index.tsx`와 `이름.module.scss`를 함께 둔다(예: `apps/web/src/components/ui/Button`). TSX는 `import styles from './Button.module.scss';`로 읽고, 스타일 import는 ESLint `import/order`에 따라 마지막 그룹에 둔다.
- 클래스 이름은 Stylelint `selector-class-pattern`이 검사한다. 위반하면 나오는 메시지는 `BEM kebab-case: block__element--modifier`다. TSX에서는 `styles['button--full-width']`처럼 읽는다.
- 이 규칙은 중첩한 `&__element`, `&--modifier` 부분을 검사하지 않는다(설정에 `resolveNestedSelectors`가 없다). 중첩 부분도 같은 패턴으로 직접 맞춘다.
- 조건부 클래스는 `import { cn } from '@bcsdlab/utils';`의 `cn`에 `{ [styles.block]: true, [styles['block--on']]: 조건 }` 객체를 넘긴다.
- CONTRIBUTING.md의 [코드 규칙](../../../../CONTRIBUTING.md#코드-규칙)에 따라 전역 reset과 초기값을 반복하지 않는다. 전역 초기값은 `apps/web/src/styles/global.scss`에 있다.

## `@use` 경로

- 공용 SCSS는 `src/`로 시작하는 경로와 모듈 이름 별칭으로 불러온다: `@use "src/utils/scss/media" as media;`, `@use "src/utils/scss/tokens" as tokens;`. 토큰 모듈과 `apps/web/src/utils/scss/order-palette.scss`의 머리 주석이 이 형태를 사용법으로 적는다.
- `apps/web/vite.config.ts`의 Sass `loadPaths`가 `apps/web`과 `apps/web/src`를 모두 포함하므로 `@use "utils/scss/media.scss" as media;` 형태도 컴파일되고 기존 파일 일부에 남아 있다. 새 파일에는 쓰지 않는다.

## 모바일 분기

- 분기점은 `apps/web/src/utils/scss/media.scss`의 `mobile` 하나이고 값은 576px이다. 기본 선언이 데스크톱이고, 모바일 선언은 `@include media.media-breakpoint(mobile) { ... }` 안에 둔다. 이 믹스인은 `@media screen and (max-width: 576px)`을 낸다.
- 데스크톱용과 모바일용 컴포넌트를 따로 둘 때는 둘 다 렌더하고 같은 파일의 `desktop-only`, `mobile-only` 믹스인으로 하나를 숨긴다. 이유는 그 파일의 주석에 있다.
- 다른 분기점 값을 더하는 것은 여러 화면이 쓰는 공통 변경이다. 운영 문서의 [어떤 변경이 결정을 기다리는가](../../../../docs/product-development/README.md#어떤-변경이-결정을-기다리는가) 표를 따른다.

## 값을 쓰는 순서

토큰 → 공용 컴포넌트 → 패턴 순서로 조합한다(운영 문서의 [규칙](../../../../docs/product-development/README.md#규칙)).

1. **토큰.** 색, 글자 크기, 글자 굵기, 모서리 반경, 그림자는 `apps/web/src/utils/scss/tokens.scss`의 이름으로 쓴다. 이름과 값은 그 파일을 열어 확인한다. 이 문서에는 옮겨 적지 않는다. 토큰 모듈은 `order-palette`를 `@forward`하므로 `order-palette`를 직접 `@use`한 기존 파일도 같은 값을 가리킨다.
2. **공용 컴포넌트.** 같은 모양이 [components.md](./components.md)에 있으면 새로 만들지 않고 그 컴포넌트를 쓴다.
3. **패턴.** 둘 다 없으면 같은 기능 영역의 화면이 쓰는 구성을 따른다. 기존 구현은 표준이 아니므로 근거로 삼은 파일을 보고에 적는다.

## 린트가 거부하는 것

- `apps/web/src/components/ui` 안의 SCSS에 hex 색을 직접 쓰면 Stylelint가 거부한다(`.stylelint.json`의 `overrides`, 규칙 `color-no-hex`). 메시지가 토큰 모듈을 쓰거나 같은 변경에서 토큰을 추가하라고 안내한다.
- 그 폴더 밖의 SCSS에는 hex 색을 막는 린트가 없다. 토큰이 있는 값은 토큰으로 쓴다.
- 글자 크기·굵기·모서리 값을 직접 쓰는 것을 막는 린트는 어느 폴더에도 없다.
- 실행: `pnpm --filter @koin/web lint:stylelint`. 폴더별 토큰 적용 현황은 저장소 루트에서 `node scripts/development/tokens.mjs report apps/web/src`로 본다.

## 맞는 토큰이 없을 때

| 경우                              | 처리                                                                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 여러 화면이 쓸 값                 | 같은 변경에서 `apps/web/src/utils/scss/tokens.scss`에 추가한다. 이름과 단계 번호는 그 파일 머리 주석의 규칙을 따르고 기존 이름·값은 바꾸지 않는다. 운영 문서의 결정 표에 따라 결정 기록을 함께 낸다 |
| 한 화면에서만 쓰는 값             | 그 화면의 SCSS에 둔다. 토큰 모듈에 올리지 않고 이유를 PR에 적는다                                                                                                                                   |
| 기존 토큰의 값을 바꿔야 맞는 경우 | 값을 바꾸지 않는다. 토큰 값 변경은 Figma를 함께 맞추는 디자인 시스템 변경이다(운영 문서의 [규칙](../../../../docs/product-development/README.md#규칙))                                              |

간격, 줄 높이, z-index, 전환 시간은 토큰이 없다([coverage-gaps.md](../coverage-gaps.md)).
