/**
 * 배포 워크플로가 보낸 값에서 알릴 패키지 이름을 정한다.
 *
 * 모노레포는 저장소 하나에서 패키지 여러 개를 배포하므로 `packageName`을 직접 받는다.
 * `repositoryName`은 저장소별로 패키지가 하나이던 예전 워크플로를 위한 호환 경로다.
 */
const 저장소별_패키지명: Record<string, string> = {
  FRONT_KOIN_LIBRARY: '@bcsdlab/koin',
  FRONT_UTILS_LIBRARY: '@bcsdlab/utils',
};

// Slack 메시지에 그대로 들어가므로 우리 스코프의 npm 패키지 이름만 받는다.
const PACKAGE_NAME_PATTERN = /^@bcsdlab\/[a-z0-9][a-z0-9._-]*$/;

export const resolvePackageName = ({
  packageName,
  repositoryName,
}: {
  packageName?: string;
  repositoryName?: string;
}): string | null => {
  if (packageName !== undefined) {
    return PACKAGE_NAME_PATTERN.test(packageName) ? packageName : null;
  }
  if (repositoryName !== undefined) {
    return 저장소별_패키지명[repositoryName] ?? null;
  }
  return null;
};
