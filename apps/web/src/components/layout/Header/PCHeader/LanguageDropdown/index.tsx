import { useRef, useState, type ComponentType, type SVGProps } from 'react';
import { cn } from '@bcsdlab/utils';
import { useMutation } from '@tanstack/react-query';

import ArrowDownIcon from 'assets/svg/language/arrow-down.svg';
import CheckIcon from 'assets/svg/language/check.svg';
import FlagEnUS from 'assets/svg/language/flag-en-US.svg';
import FlagJaJP from 'assets/svg/language/flag-ja-JP.svg';
import FlagKoKR from 'assets/svg/language/flag-ko-KR.svg';
import FlagMnMN from 'assets/svg/language/flag-mn-MN.svg';
import FlagMyMM from 'assets/svg/language/flag-my-MM.svg';
import FlagUzLatn from 'assets/svg/language/flag-uz-Latn.svg';
import FlagZhHans from 'assets/svg/language/flag-zh-Hans.svg';
import { LANGUAGE_CODES, LANGUAGE_NATIVE_NAMES, type LanguageCode } from 'static/language';
import { useEscapeKeyDown } from 'utils/hooks/ui/useEscapeKeyDown';
import { useOutsideClick } from 'utils/hooks/ui/useOutsideClick';
import { useLanguage } from 'utils/language/useLanguage';
import showToast from 'utils/ts/showToast';

import styles from './LanguageDropdown.module.scss';

const FLAG_ICONS: Record<LanguageCode, ComponentType<SVGProps<SVGSVGElement>>> = {
  'ko-KR': FlagKoKR,
  'en-US': FlagEnUS,
  'zh-Hans': FlagZhHans,
  'mn-MN': FlagMnMN,
  'uz-Latn': FlagUzLatn,
  'my-MM': FlagMyMM,
  'ja-JP': FlagJaJP,
};

export default function LanguageDropdown() {
  const { language, changeLanguage } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);
  // 고른 언어를 새로고침될 때까지 유지한다. 저장이 끝난 뒤 실제로 새로고침되기까지 틈이 있다.
  const [pendingLanguage, setPendingLanguage] = useState<LanguageCode | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { containerRef } = useOutsideClick({ onOutsideClick: () => setIsOpen(false) });
  useEscapeKeyDown({
    onEscape: () => {
      if (!isOpen) return;
      setIsOpen(false);
      triggerRef.current?.focus();
    },
  });

  const { mutate } = useMutation({
    mutationFn: changeLanguage,
    onError: () => {
      setPendingLanguage(null);
      showToast('error', '언어를 변경하지 못했어요. 잠시 후 다시 시도해주세요.');
    },
  });

  const selectedLanguage = pendingLanguage ?? language;
  const SelectedFlag = FLAG_ICONS[selectedLanguage];

  const handleSelect = (code: LanguageCode) => {
    setIsOpen(false);
    if (code === language) return;
    setPendingLanguage(code);
    mutate(code);
  };

  return (
    <div ref={containerRef} className={styles.dropdown}>
      <button
        ref={triggerRef}
        type="button"
        className={cn({ [styles.trigger]: true, [styles['trigger--open']]: isOpen })}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <SelectedFlag className={styles.trigger__flag} aria-hidden />
        <span lang={selectedLanguage}>{LANGUAGE_NATIVE_NAMES[selectedLanguage]}</span>
        <ArrowDownIcon className={styles.trigger__arrow} aria-hidden />
      </button>
      {isOpen && (
        <ul className={styles.menu} role="menu" aria-label="언어 선택">
          {LANGUAGE_CODES.map((code) => {
            const Flag = FLAG_ICONS[code];
            const isSelected = code === selectedLanguage;

            return (
              <li key={code} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  className={cn({ [styles.option]: true, [styles['option--selected']]: isSelected })}
                  disabled={pendingLanguage !== null}
                  onClick={() => handleSelect(code)}
                >
                  <Flag className={styles.option__flag} aria-hidden />
                  <span className={styles.option__name} lang={code}>
                    {LANGUAGE_NATIVE_NAMES[code]}
                  </span>
                  {isSelected && <CheckIcon className={styles.option__check} aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
