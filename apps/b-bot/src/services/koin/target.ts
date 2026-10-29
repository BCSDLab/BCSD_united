import CHANNEL_ID from '@/constant/CHANNEL_ID.json';

/**
 * 어느 코인에 반영할지는 **명령어를 실행한 채널**로 정한다.
 *
 * 사람이 매번 적게 하면 언젠가 빠뜨리고, 빠뜨렸을 때 기본값이 무엇이든 절반은 틀린다.
 * 채널은 이미 나뉘어 있으니 그걸 쓴다.
 *
 * 등록되지 않은 채널에서는 아무것도 하지 않는다. **기본값을 두지 않는 게 핵심이다** —
 * 어느 쪽인지 모르면 진행하지 않는다. 프로덕션은 되돌릴 API가 없다.
 *
 * 강의·버스·생협이 같은 규칙을 쓴다. 도메인마다 복사해 두면 프로덕션 오반영을 막는
 * 규칙이 세 곳에 흩어지고, 한 곳만 고쳤을 때 나머지는 옛날 규칙으로 남는다.
 */
export type KoinEnv = 'stage' | 'prod';

export interface KoinTarget {
  env: KoinEnv;
  /** 사람에게 보여줄 이름. 메시지·검토 페이지에 그대로 쓴다. */
  label: string;
  baseUrl: string;
  email: string;
  password: string;
}

const CHANNEL_ENV: Record<string, KoinEnv> = {
  [CHANNEL_ID.코인_이벤트알림_stage]: 'stage',
  [CHANNEL_ID.코인_이벤트알림]: 'prod',
  // 개발 중 확인용. 스테이지로만 간다. 자동화가 자리잡으면 뺀다.
  [CHANNEL_ID.sprint_ai_코인_업무자동화]: 'stage',
};

const LABEL: Record<KoinEnv, string> = { stage: '스테이지', prod: '프로덕션' };

/**
 * 어드민 계정은 스테이지·프로덕션이 같아서 하나만 둔다. **주소만 나눈다.**
 *
 * 환경별 주소에 폴백을 두지 않는 게 핵심이다. 공용 주소 하나로 떨어지게 하면
 * 프로덕션 채널에서 누른 반영이 조용히 스테이지로 가고, 틀렸다는 걸 아무도 모른다.
 *
 * 빈 문자열은 없는 것으로 본다. 배포에서 값 없는 Secret이 `KEY=`로 들어가는데,
 * 그대로 두면 "설정은 있는데 비어 있는" 상태로 진행된다.
 */
function credentials(env: KoinEnv) {
  const env_ = process.env;
  // 끝 슬래시는 여기서 떼어낸다. 붙이는 쪽마다 신경 쓰게 두면 언젠가 한 곳이 빠진다.
  const read = (key: string) => {
    const value = env_[key]?.trim().replace(/\/+$/, '');
    return value === '' ? undefined : value;
  };

  return {
    baseUrl: read(env === 'prod' ? 'KOIN_PROD_API_BASE_URL' : 'KOIN_STAGE_API_BASE_URL'),
    email: read('KOIN_ADMIN_EMAIL'),
    password: read('KOIN_ADMIN_PASSWORD'),
  };
}

export interface ResolveResult {
  ok: boolean;
  target?: KoinTarget;
  /** 거절 사유. 사람에게 그대로 보여준다. */
  reason?: string;
}

/** `domain`은 거절 문구에만 쓴다 — `이 채널은 강의 반영 대상이 아닙니다`. */
export function resolveTarget(channelId: string, domain: string): ResolveResult {
  const env = CHANNEL_ENV[channelId];
  if (!env) {
    return {
      ok: false,
      reason: [
        `이 채널은 ${domain} 반영 대상이 아닙니다.`,
        `<#${CHANNEL_ID.코인_이벤트알림_stage}> 또는 <#${CHANNEL_ID.코인_이벤트알림}>에서 실행해주세요.`,
      ].join(' '),
    };
  }

  // 설정이 없는 환경을 반쯤 열어두면 엉뚱한 곳에 붙는다.
  return resolveTargetByEnv(env);
}

/** 이미 정해진 환경으로 붙을 때. 변환 시점의 대상이 반영 시점에도 그대로여야 한다. */
export function resolveTargetByEnv(env: KoinEnv): ResolveResult {
  const { baseUrl, email, password } = credentials(env);
  if (!baseUrl || !email || !password) {
    return { ok: false, reason: `${LABEL[env]} 어드민 설정이 서버에 없습니다.` };
  }
  return { ok: true, target: { env, label: LABEL[env], baseUrl, email, password } };
}

export const isProduction = (env: KoinEnv) => env === 'prod';
export const labelOf = (env: KoinEnv) => LABEL[env];
