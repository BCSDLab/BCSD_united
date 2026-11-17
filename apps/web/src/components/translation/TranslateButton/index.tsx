import { cn } from '@bcsdlab/utils';

import LoaderIcon from 'assets/svg/translation/loader.svg';
import OriginalIcon from 'assets/svg/translation/original.svg';
import TranslateIcon from 'assets/svg/translation/translate.svg';
import type { LanguageCode } from 'static/language';
import { useLanguage } from 'utils/language/useLanguage';

import styles from './TranslateButton.module.scss';

export type TranslateButtonState = 'original' | 'translating' | 'translated';

// Figma 「번역」「번역 중」「원문 보기」 버튼의 언어별 문구
const LABELS: Record<TranslateButtonState, Record<LanguageCode, string>> = {
  original: {
    'ko-KR': '번역',
    'en-US': 'Translate',
    'zh-Hans': '翻译',
    'mn-MN': 'Орчуулах',
    'uz-Latn': 'Tarjima qilish',
    'my-MM': 'ဘာသာပြန်ရန်',
    'ja-JP': '翻訳',
  },
  translating: {
    'ko-KR': '번역 중...',
    'en-US': 'Translating...',
    'zh-Hans': '翻译中…',
    'mn-MN': 'Орчуулж байна…',
    'uz-Latn': 'Tarjima qilinmoqda…',
    'my-MM': 'ဘာသာပြန်နေသည်…',
    'ja-JP': '翻訳中…',
  },
  translated: {
    'ko-KR': '원문 보기',
    'en-US': 'Show original',
    'zh-Hans': '查看原文',
    'mn-MN': 'Эх хувийг харах',
    'uz-Latn': 'Asl nusxani ko’rish',
    'my-MM': 'မူရင်းကြည့်ရန်',
    'ja-JP': '原文を表示',
  },
};

const ICONS = {
  original: TranslateIcon,
  translating: LoaderIcon,
  translated: OriginalIcon,
} as const;

interface TranslateButtonProps {
  state: TranslateButtonState;
  onClick: () => void;
  /** `content`는 글 상세, `message`는 쪽지에 쓴다. 모바일에서는 같은 종류의 앱 디자인으로 바뀐다. */
  variant?: 'content' | 'message';
  className?: string;
}

export default function TranslateButton({ state, onClick, variant = 'content', className }: TranslateButtonProps) {
  const { language } = useLanguage();
  const Icon = ICONS[state];

  return (
    <button
      type="button"
      className={cn({
        [styles.button]: true,
        [styles[`button--${variant}`]]: true,
        [styles['button--translated']]: state === 'translated',
        [className ?? '']: !!className,
      })}
      onClick={onClick}
      disabled={state === 'translating'}
      aria-busy={state === 'translating'}
    >
      <Icon
        className={cn({ [styles.button__icon]: true, [styles['button__icon--spin']]: state === 'translating' })}
        aria-hidden
      />
      <span lang={language}>{LABELS[state][language]}</span>
    </button>
  );
}
