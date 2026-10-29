import { describe, expect, it } from 'vitest';
import { resolvePackageName } from '~/services/package/packageName';

describe('배포 알림 패키지 이름', () => {
  it('모노레포가 보낸 패키지 이름을 그대로 쓴다', () => {
    expect(resolvePackageName({ packageName: '@bcsdlab/eslint-config' })).toBe('@bcsdlab/eslint-config');
  });

  it('패키지 이름이 있으면 저장소 이름보다 우선한다', () => {
    expect(resolvePackageName({ packageName: '@bcsdlab/koin', repositoryName: 'FRONT_UTILS_LIBRARY' })).toBe(
      '@bcsdlab/koin',
    );
  });

  it('우리 스코프가 아닌 패키지 이름은 받지 않는다', () => {
    expect(resolvePackageName({ packageName: 'react' })).toBeNull();
    expect(resolvePackageName({ packageName: '@other/utils' })).toBeNull();
    expect(resolvePackageName({ packageName: '@bcsdlab/<!channel>' })).toBeNull();
  });

  it('예전 워크플로의 저장소 이름으로도 찾는다', () => {
    expect(resolvePackageName({ repositoryName: 'FRONT_UTILS_LIBRARY' })).toBe('@bcsdlab/utils');
    expect(resolvePackageName({ repositoryName: 'FRONT_KOIN_LIBRARY' })).toBe('@bcsdlab/koin');
  });

  it('알 수 없는 저장소나 빈 요청은 찾지 못한다', () => {
    expect(resolvePackageName({ repositoryName: 'UNKNOWN' })).toBeNull();
    expect(resolvePackageName({})).toBeNull();
  });
});
