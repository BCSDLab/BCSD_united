// 서버(`GET /languages`)가 지원하는 언어 코드. 목록 화면은 API 응답을 그리고, 이 값은 쿠키·브라우저 언어 검증에 쓴다.
export const LANGUAGE_CODES = ['ko-KR', 'en-US', 'zh-Hans', 'mn-MN', 'uz-Latn', 'my-MM', 'ja-JP'] as const;

export type LanguageCode = (typeof LANGUAGE_CODES)[number];

export const DEFAULT_LANGUAGE: LanguageCode = 'ko-KR';

// 언어 목록을 받기 전이나 받지 못했을 때 보여줄 고유 표기 이름. API의 `name`과 같다.
export const LANGUAGE_NATIVE_NAMES: Record<LanguageCode, string> = {
  'ko-KR': '한국어',
  'en-US': 'English',
  'zh-Hans': '简体中文',
  'mn-MN': 'Монгол',
  'uz-Latn': 'O‘zbekcha',
  'my-MM': 'မြန်မာဘာသာ',
  'ja-JP': '日本語',
};
