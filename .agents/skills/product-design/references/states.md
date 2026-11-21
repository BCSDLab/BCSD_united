# 상태 점검표

화면은 실제로 도달하는 상태를 모두 구현한다(운영 문서의 [규칙](../../../../docs/product-development/README.md#규칙)). 도달할 수 없는 상태는 만들지 않는다. 아래에서 이 화면이 들어갈 수 있는 상태를 고르고, 각 상태를 실행 화면에서 직접 만들어 확인한다. 만들지 못한 상태는 미검증으로 보고한다.

구현 예는 지금 그 상태를 구현한 파일 하나다. 무엇이 있는지 보여 주는 증거이며 표준이 아니다. 로딩·빈 상태·오류를 그리는 공용 컴포넌트는 `apps/web/src/components/ui`에 없다([coverage-gaps.md](../coverage-gaps.md)).

| 상태                    | 확인할 것                                                                                                                        | 구현 예                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 로딩                    | 응답을 기다리는 동안 화면에 무엇이 보이는가. 이전 조건의 데이터를 남길지 지울지 정했는가. 보조 기술에 기다리는 중임이 전달되는가 | `apps/web/src/components/Store/mobile/StoreListPage/index.tsx`: 목록 조회가 `isPending`인 동안 `ShopListSkeleton`을 그리고, `role="status"` 문구와 목록의 `aria-busy`로 알린다   |
| 빈 상태                 | 결과가 0건일 때 빈 영역만 남지 않는가. 왜 비었는지와 다음에 할 일이 문구로 보이는가                                              | `apps/web/src/components/Store/mobile/StoreListPage/index.tsx`: 걸러 낸 상점이 0건이면 아이콘, "이용 가능한 가게가 없어요", "조건을 변경하고 다시 검색해주세요"를 그린다         |
| 오류                    | 조회가 실패하면 무엇이 보이는가. 없는 대상(404)과 그 밖의 실패를 구분하는가. 사용자가 빠져나갈 경로가 있는가                     | `apps/web/src/components/boundary/StoreErrorBoundary/index.tsx`: 404면 "존재하지 않는 상점입니다."와 상점 목록 버튼을, 그 밖에는 오류 문구와 참조 코드를 `role="alert"`로 그린다 |
| 권한 없음 · 로그인 필요 | 로그인하지 않았거나 권한이 없는 사용자가 그 동작을 누르면 무엇이 일어나는가. 로그인 뒤 원래 화면으로 돌아오는가                  | `apps/web/src/routes/cafeteria.index.tsx`: 품절 제보를 열 때 로그인 상태가 아니면 `useRequireLogin()`이 돌려준 함수로 로그인 유도 모달을 연다                                    |
| 비활성                  | 조건이 채워지지 않은 동작이 눌리지 않는가. 비활성 모양이 공용 컴포넌트의 것인가                                                  | `apps/web/src/components/Order/OrderCheckoutPage/index.tsx`: 결제 조건(`canPay`)이 거짓이면 결제 버튼에 `state="disabled"`를 넘긴다                                              |
| 긴 문구 (다국어)        | 가장 긴 값을 넣었을 때 줄바꿈·말줄임·넘침 중 무엇이 일어나는가. 모바일 최소 폭에서 옆 요소를 밀어내거나 겹치지 않는가            | `apps/web/src/components/ui/PageHeader/PageHeader.module.scss`: 제목(`header__title`)을 한 줄로 두고 넘치면 말줄임으로 자른다                                                    |

## 상태별로 저장소가 정한 것

- **변경 요청(mutation) 오류**는 CONTRIBUTING.md의 [코드 규칙](../../../../CONTRIBUTING.md#코드-규칙)대로 `isKoinError()`로 좁힌 뒤 `showToast()`로 표시한다. `react-toastify`의 `toast`를 직접 import하면 ESLint가 거부한다.
- **비활성**을 공용 Button에 줄 때는 `state="disabled"`를 쓴다([components.md](./components.md)).
- **다국어 값**은 번역되는 조회가 원문 필드를 그대로 두고 `display_*` 필드를 더해 내려준다(`apps/web/src/utils/language/requestLanguage.ts`). 예를 들어 `apps/web/src/components/Store/mobile/common/ShopCard/index.tsx`는 `displayName`이 있으면 그 값을, 없으면 `name`을 그린다. 긴 문구는 이 필드를 그리는 요소에서 확인한다. 지원 언어는 `apps/web/src/static/language.ts`에 있다.
- **확인 폭**은 `apps/web/src/styles/global.scss`가 정한 `#root` 최소 폭(데스크톱 1148px, 모바일 360px)과 모바일 분기점([styling.md](./styling.md))이다.
- 로그인 필요, 로딩, 빈 상태, 조회 오류의 화면 표현은 기준이 없다. 같은 기능 영역의 구현을 따르고 [coverage-gaps.md](../coverage-gaps.md)에 따라 보고한다.
