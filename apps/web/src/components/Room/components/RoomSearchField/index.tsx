import { useMemo, useRef, useState, type ReactNode } from 'react';
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
  searchIcon?: ReactNode;
}

export default function RoomSearchField({ keyword, rooms, onSearch, className, searchIcon }: RoomSearchFieldProps) {
  const [value, setValue] = useState(keyword);
  const [isOpen, openCandidates, closeCandidates] = useBooleanState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { containerRef } = useOutsideClick({ onOutsideClick: closeCandidates });
  useEscapeKeyDown({
    onEscape: () => {
      if (isOpen && containerRef.current?.contains(document.activeElement)) inputRef.current?.focus();
      closeCandidates();
    },
  });
  const candidates = useMemo(() => filterRoomsByName(rooms, value), [rooms, value]);

  const confirmSearch = (name: string) => {
    setValue(name);
    closeCandidates();
    inputRef.current?.blur();
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
        inputRef={inputRef}
        className={styles.input}
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
                <button
                  type="button"
                  className={styles.candidate}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => confirmSearch(room.name)}
                >
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
