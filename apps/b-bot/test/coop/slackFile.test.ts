import { describe, expect, it } from 'vitest';
import { findImageFile, slackImageMimeType } from '~/utils/slackFile';

const file = (name: string, filetype: string) => ({ id: 'F1', name, filetype, size: 100 });

describe('생협 이미지 첨부 파일', () => {
  it('지원하는 이미지를 고른다', () => {
    expect(findImageFile([file('안내.pdf', 'pdf'), file('시간표.png', 'png')])?.name).toBe('시간표.png');
  });

  it('Slack이 형식을 모르면 확장자로 판단한다', () => {
    expect(slackImageMimeType(file('시간표.JPEG', 'binary'))).toBe('image/jpeg');
    expect(slackImageMimeType(file('시간표.webp', 'binary'))).toBe('image/webp');
  });

  it('지원하지 않는 파일은 선택하지 않는다', () => {
    expect(findImageFile([file('시간표.pdf', 'pdf')])).toBeNull();
    expect(findImageFile(undefined)).toBeNull();
  });
});
