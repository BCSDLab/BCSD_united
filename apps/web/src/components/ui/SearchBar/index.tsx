import { useRef, type ReactNode, type RefObject } from 'react';
import { cn } from '@bcsdlab/utils';

import ClearIcon from 'assets/svg/close-icon-grey.svg';
import SearchIcon from 'assets/svg/common/purple-search.svg';

import styles from './SearchBar.module.scss';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSearch?: () => void;
  onClear?: () => void;
  label: string;
  placeholder?: string;
  size?: 'small' | 'medium';
  className?: string;
  clearable?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  searchIcon?: ReactNode;
}

export default function SearchBar({
  value,
  onChange,
  onSearch,
  onClear,
  label,
  placeholder = '검색어를 입력해주세요.',
  size = 'medium',
  className,
  clearable = false,
  inputRef,
  searchIcon,
}: SearchBarProps) {
  const internalInputRef = useRef<HTMLInputElement>(null);
  const fieldRef = inputRef ?? internalInputRef;
  const icon = searchIcon ?? <SearchIcon className={styles['search-bar__icon']} aria-hidden />;
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      onSearch?.();
    }
  };

  return (
    <div
      className={cn({
        [styles['search-bar']]: true,
        [styles['search-bar--small']]: size === 'small',
        [className ?? '']: !!className,
      })}
    >
      <input
        ref={fieldRef}
        className={styles['search-bar__input']}
        type="text"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />

      {clearable && value && (
        <button
          type="button"
          className={styles['search-bar__button']}
          aria-label="검색어 삭제"
          onClick={() => {
            onChange('');
            onClear?.();
            fieldRef.current?.focus();
          }}
        >
          <ClearIcon aria-hidden />
        </button>
      )}
      {onSearch ? (
        <button type="button" className={styles['search-bar__button']} aria-label="검색" onClick={onSearch}>
          {icon}
        </button>
      ) : (
        icon
      )}
    </div>
  );
}
