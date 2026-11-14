/**
 * Workers Builds가 Preview 브랜치(stage.koreatech.in 배포)를 빌드하는지 판단한다.
 * 운영 브랜치와 로컬 빌드는 운영 기준으로 빌드한다.
 */
export function isStageBuild(env) {
  return env.WORKERS_CI === '1' && env.WORKERS_CI_BRANCH === (env.KOIN_PREVIEW_BRANCH || 'develop');
}
