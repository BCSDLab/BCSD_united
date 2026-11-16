/**
 * Workers Builds가 Preview 브랜치(stage.koreatech.in 배포)를 빌드하는지 판단한다.
 * 운영 브랜치와 로컬 빌드는 운영 기준으로 빌드한다.
 */
export function isStageBuild(env) {
  return env.WORKERS_CI === '1' && env.WORKERS_CI_BRANCH === (env.KOIN_PREVIEW_BRANCH || 'develop');
}

/**
 * 배포 빌드는 실제 공개 지도 ID가 필요하다. 로컬·격리 빌드는 ID 없이 검증할 수 있지만
 * 가짜 ID를 넣은 SDK 요청은 만들지 않는다.
 */
export function resolveNaverMapsClientId(env, required = false) {
  const clientId = env.NEXT_PUBLIC_NAVER_MAPS_CLIENT_ID?.trim();
  if (!clientId || clientId === 'undefined' || clientId === 'null') {
    if (required) {
      throw new Error(
        'NEXT_PUBLIC_NAVER_MAPS_CLIENT_ID must be set as a Workers Builds build variable for the web deployment.',
      );
    }

    return '';
  }

  return clientId;
}
