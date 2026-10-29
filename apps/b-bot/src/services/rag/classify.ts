// 문서 타입 분류(휴리스틱, $0). 제목·소스로 doc_type 판정 → 검색 재랭킹에 사용.
// OKF의 `type` 아이디어 차용. 회의록·재무 등 노이즈를 down-rank, 온보딩·가이드·readme를 우선.
export type DocType =
  | 'readme'
  | 'guide' // 온보딩·커리큘럼·가이드·컨벤션·문서화
  | 'handover' // 인수인계
  | 'meeting' // 회의록·주간공유·월간공유·회고
  | 'finance' // 영수증·결제·회비·서버비·지원금
  | 'personal_work' // 역기획서·차시 보고서·개인 과제
  | 'doc'; // 기타 일반 문서

// 검색 점수 가중치(코사인 유사도에 가산). 온보딩 지식↑, 노이즈↓.
export const TYPE_WEIGHT: Record<DocType, number> = {
  readme: 0.1,
  guide: 0.1,
  handover: 0.08,
  doc: 0,
  meeting: -0.08,
  personal_work: -0.1,
  finance: -0.12,
};

// 날짜형 제목(2025.01.22 / 26-03-04 / 2025/2/4 등)
const DATE_RE = /(^|\s)\d{2,4}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}/;

export function classifyDocType(source: string, title: string): DocType {
  if (source === 'github') return 'readme';
  const t = (title || '').trim();
  if (/인수인계/.test(t)) return 'handover';
  if (/영수증|결제|서버비|사용비|지원|회비|거래내역|사업자|환급|정산|과금|비용|납부|결산/.test(t)) return 'finance';
  if (/역기획서|기획서|차시|주차|보고서|과제|제출|템플릿/.test(t)) return 'personal_work';
  if (
    /커리큘럼|온보딩|가이드|시작하기|문서화|컨벤션|규약|규칙|회칙|셋업|setup|환경\s*설정|아키텍처|명세|convention|guide|onboarding|architecture|getting\s*started/i.test(
      t,
    )
  )
    return 'guide';
  if (DATE_RE.test(t) || /회의|주간\s*공유|월간\s*공유|미팅|회고|standup|스크럼|monthly|weekly/i.test(t))
    return 'meeting';
  return 'doc';
}
