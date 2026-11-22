import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@bcsdlab/utils';

import type { LandList } from 'api/room/entity';
import filterRoomsByName from 'components/Room/utils/filterRoomsByName';
import SearchBar from 'components/ui/SearchBar';
import useBooleanState from 'utils/hooks/state/useBooleanState';
import { useEscapeKeyDown } from 'utils/hooks/ui/useEscapeKeyDown';
import { useOutsideClick } from 'utils/hooks/ui/useOutsideClick';

import styles from './RoomSearchField.module.scss';

interface RoomSearchFieldProps {
  keyword: string;
  rooms: LandList[] | undefined;
  onSearch: (keyword: string) => Promise<void>;
  className?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  searchIcon?: ReactNode;
}

export default function RoomSearchField({
  keyword,
  rooms,
  onSearch,
  className,
  inputRef,
  searchIcon,
}: RoomSearchFieldProps) {
  const [value, setValue] = useState(keyword);
  const [isOpen, openCandidates, closeCandidates] = useBooleanState(false);
  const internalInputRef = useRef<HTMLInputElement>(null);
  const fieldRef = inputRef ?? internalInputRef;
  const { containerRef } = useOutsideClick({ onOutsideClick: closeCandidates });
  useEscapeKeyDown({ onEscape: closeCandidates });
  const candidates = useMemo(() => filterRoomsByName(rooms, value), [rooms, value]);

  const confirmSearch = (name: string) => {
    setValue(name);
    closeCandidates();
    fieldRef.current?.blur();
    onSearch(name);
  };

  return (
    <div
      ref={containerRef}
      className={cn({ [styles.field]: true, [className ?? '']: !!className })}
      onFocusCapture={openCandidates}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closeCandidates();
      }}
    >
      <SearchBar
        value={value}
        onChange={(nextValue) => {
          setValue(nextValue);
          openCandidates();
        }}
        onSearch={() => confirmSearch(value)}
        onClear={async () => {
          await onSearch('');
          inputRef?.current?.focus();
        }}
        inputRef={fieldRef}
        className={styles.input}
        clearable
        label="건물명 검색"
        placeholder="건물 명을 입력해주세요."
        searchIcon={searchIcon}
      />
      {isOpen && value && !!candidates?.length && (
        <ul className={styles.candidates} aria-label="건물명 후보">
          {candidates.map((room) => {
            const matchIndex = room.name.indexOf(value);

            return (
              <li key={room.id}>
                <button type="button" className={styles.candidate} onClick={() => confirmSearch(room.name)}>
                  {room.name.slice(0, matchIndex)}
                  <span className={styles.match}>{value}</span>
                  {room.name.slice(matchIndex + value.length)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
