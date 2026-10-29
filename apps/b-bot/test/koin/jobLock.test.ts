import { describe, expect, it } from 'vitest';
import { assertPatchable } from '~/services/koin/jobLock';

describe('반영 작업 수정 가능 여부', () => {
  it('반영 전이거나 실패한 작업은 고칠 수 있다', () => {
    expect(() => assertPatchable(null)).not.toThrow();
    expect(() => assertPatchable({ status: 'PENDING' })).not.toThrow();
    expect(() => assertPatchable({ status: 'FAILED' })).not.toThrow();
  });

  it('반영 중이거나 끝난 작업은 고치지 않는다', () => {
    for (const status of ['APPLYING', 'APPLIED', 'CANCELLED'] as const) {
      expect(() => assertPatchable({ status })).toThrow(/수정을 적용할 수 없습니다/);
    }
  });
});
