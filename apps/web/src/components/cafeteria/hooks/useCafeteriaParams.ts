import { useRouter, useLocation, useSearch } from '@tanstack/react-router';

import type { DiningType } from 'api/dinings/entity';
import { useCafeteriaLiveNow } from 'components/cafeteria/hooks/useCafeteriaLiveNow';
import { DiningTime } from 'components/cafeteria/utils/time';
import { DINING_TYPES } from 'static/cafeteria';
import { kstDateKey } from 'utils/ts/calendar';

const DATE_KEY = 'date';
const TYPE_KEY = 'type';

export const useCafeteriaParams = () => {
  const router = useRouter();
  const routeLocation = useLocation();
  const query = useSearch({ strict: false });

  const renderToday = useCafeteriaLiveNow();
  const renderTomorrow = new Date(renderToday.getTime() + 24 * 60 * 60 * 1000);

  const dateParam = (): Date | null => {
    const value = query[DATE_KEY];
    const rawDate = Array.isArray(value) ? value[0] : value;
    if (typeof rawDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return null;

    const [year, month, day] = rawDate.split('-').map(Number);
    const parsed = new Date(0);
    parsed.setUTCFullYear(year, month - 1, day);
    parsed.setUTCHours(0, 0, 0, 0);

    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
      ? parsed
      : null;
  };

  const shiftDate = (days: number) => {
    const base = dateParam() ?? new Date(`${kstDateKey(renderToday)}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + days);
    updateDateQuery(kstDateKey(base));
  };

  const date = {
    current: (): Date => dateParam() ?? renderToday,
    /** date 파라미터가 없을 때 매 렌더 새 Date를 반환하므로, 그대로 key로 쓰면 서브트리가 매번 재생성된다. */
    key: (Array.isArray(query[DATE_KEY]) ? query[DATE_KEY][0] : query[DATE_KEY]) ?? 'today',
    checkToday: (d: Date) => kstDateKey(renderToday) === kstDateKey(d),
    checkTomorrow: (d: Date) => kstDateKey(renderTomorrow) === kstDateKey(d),
    checkPast: (d: Date) => kstDateKey(renderToday) > kstDateKey(d),
    setPrev: () => shiftDate(-1),
    setNext: () => shiftDate(1),
    setPrevWeek: () => shiftDate(-7),
    setNextWeek: () => shiftDate(7),
    set: (d: Date) => updateDateQuery(kstDateKey(d)),
    setToday: () => updateDateQuery(kstDateKey(renderToday)),
  };

  const diningType = DINING_TYPES.find((t) => t === query[TYPE_KEY]) ?? new DiningTime(renderToday).getType();

  const setDiningType = (type: DiningType) => {
    router.navigate({ to: routeLocation.pathname, search: { ...query, [TYPE_KEY]: type }, replace: true });
  };

  function updateDateQuery(value: string) {
    router.navigate({ to: routeLocation.pathname, search: { ...query, [DATE_KEY]: value }, replace: true });
  }

  return { date, diningType, setDiningType };
};
