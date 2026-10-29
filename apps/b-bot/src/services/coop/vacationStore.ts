import type { RawRegularCoopTimetable, VacationSeason } from './types';
import type { KoinEnv } from '~/services/koin/target';

const EXPIRE_MS = 24 * 60 * 60 * 1000;
const key = (channel: string, threadTs: string) => `coop-vacation:${channel}:${threadTs}`;

export interface PendingCoopVacation {
  env: KoinEnv;
  year: number;
  season: VacationSeason;
  fileName: string;
  requesterId: string;
  raw: RawRegularCoopTimetable;
  createdAt: string;
}

export async function savePendingCoopVacation(
  channel: string,
  threadTs: string,
  pending: Omit<PendingCoopVacation, 'createdAt'>,
): Promise<void> {
  await useStorage('kvStorage').setItem(key(channel, threadTs), {
    ...pending,
    createdAt: new Date().toISOString(),
  } satisfies PendingCoopVacation);
}

export async function loadPendingCoopVacation(channel: string, threadTs: string): Promise<PendingCoopVacation | null> {
  const stored = await useStorage('kvStorage').getItem<PendingCoopVacation>(key(channel, threadTs));
  if (!stored) return null;
  const age = Date.now() - new Date(stored.createdAt).getTime();
  if (!Number.isFinite(age) || age > EXPIRE_MS) {
    await dropPendingCoopVacation(channel, threadTs);
    return null;
  }
  return stored;
}

export async function dropPendingCoopVacation(channel: string, threadTs: string): Promise<void> {
  await useStorage('kvStorage').removeItem(key(channel, threadTs));
}
