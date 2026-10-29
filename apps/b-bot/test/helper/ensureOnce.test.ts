import { describe, expect, it, vi } from 'vitest';
import { ensureOnce } from '~/infra/postgres';

describe('스키마 준비 1회 실행', () => {
  it('성공하면 다시 돌리지 않는다', async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    const ensure = ensureOnce(setup);

    await Promise.all([ensure(), ensure()]);
    await ensure();

    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('실패하면 다음 호출이 다시 시도한다', async () => {
    const setup = vi.fn().mockRejectedValueOnce(new Error('일시적 오류')).mockResolvedValue(undefined);
    const ensure = ensureOnce(setup);

    await expect(ensure()).rejects.toThrow('일시적 오류');
    await expect(ensure()).resolves.toBeUndefined();
    expect(setup).toHaveBeenCalledTimes(2);
  });
});
