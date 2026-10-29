import type { WebClient } from '@slack/web-api';
import { updateBusVersionViaAdminApi } from './adminApi';
import { findBusJobsWithPendingVersionSchedules, setBusVersionSchedules, type BusVersionSchedule } from './jobStore';
import { getKoinAdminAuth } from '~/services/koin/adminAuth';
import { resolveTargetByEnv, type KoinEnv } from '~/services/koin/target';
import type { BusConversion } from './types';

/**
 * 사이트에 노출되는 버전 문구는 적용 전날 00:05(KST)에 바뀌어야 한다. 시간표
 * Admin API PUT은 승인 즉시 나가지만, 이 문구가 미리 바뀌면 아직 오지 않은
 * 학기를 안내하게 되므로 하루 앞당겨 예약해둔다.
 */
/** `Date`는 2026-02-30 같은 값을 다음 달로 보정해버리므로, 구성 요소가 그대로 남는지 되짚어 본다. */
function assertRealCalendarDate(dateText: string, original: string) {
  const [year, month, day] = dateText.split('-').map(Number);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day) {
    throw new Error(`version_update.content에 존재하지 않는 날짜가 있습니다: ${original}`);
  }
}

const KST_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** "2026-02-28T15:05:00.000Z" → "2026-03-01 00:05 KST" 처럼 사람이 읽을 시각으로 바꾼다. */
export function formatBusVersionScheduleKst(iso: string): string {
  const parts = KST_FORMATTER.formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} KST`;
}

/** Slack 메시지에 "언제 바뀌는지"를 정확히 보여주기 위한 한 줄씩의 설명. */
export function describeBusVersionSchedules(schedules: BusVersionSchedule[]): string {
  return schedules
    .map((s) => `${s.version_update.title} 버전 문구 → ${formatBusVersionScheduleKst(s.scheduled_at)}`)
    .join('\n');
}

export function computeBusVersionSchedules(conversions: BusConversion[]): BusVersionSchedule[] {
  return conversions.map((conversion) => {
    const [start] = conversion.version_update.content.split('~');
    const trimmed = start.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      throw new Error(`version_update.content 형식이 올바르지 않습니다: ${conversion.version_update.content}`);
    }
    assertRealCalendarDate(trimmed, conversion.version_update.content);
    const scheduledAt = new Date(new Date(`${trimmed}T00:05:00+09:00`).getTime() - 86_400_000);
    return { version_update: conversion.version_update, scheduled_at: scheduledAt.toISOString() };
  });
}

/**
 * 예약 시각이 지난 버전 갱신을 실제로 반영한다. 5분 간격 크론(`bus:versionUpdate`)이
 * 이 함수를 부른다. 한 작업 안의 스케줄은 순서대로 처리하고, 하나가 실패하면
 * 그 뒤는 다음 주기로 미룬다 — 순서가 뒤바뀌어 반영되면 안 된다.
 *
 * `signal`은 다음 주기가 이전 실행을 대신하려 할 때 협조적으로 멈추는 용도다.
 * 이미 완료 처리한 스케줄은 그때마다 저장해뒀으니, 중간에 멈춰도 다음 실행이
 * 이어서 하면 된다 — 반씩 처리된 채로 남는 게 문제되지 않는다.
 */
export async function runDueBusVersionUpdates(client?: WebClient, signal?: AbortSignal): Promise<void> {
  for (const job of await findBusJobsWithPendingVersionSchedules()) {
    if (signal?.aborted) return;
    const schedules = job.version_schedules;
    let changed = false;

    for (const schedule of schedules) {
      if (signal?.aborted) break;
      if (schedule.completed_at) continue;
      // 아직 때가 안 된 일정을 만나면 멈춘다. 순서를 건너뛰면 뒤 학기가 먼저 노출될 수 있다.
      if (new Date(schedule.scheduled_at) > new Date()) break;

      const resolved = resolveTargetByEnv(job.target_env as KoinEnv);
      if (!resolved.target) break; // 설정이 없으면 다음 주기에 다시 시도한다.

      try {
        const auth = await getKoinAdminAuth(resolved.target);
        await updateBusVersionViaAdminApi(schedule.version_update, auth);
        schedule.completed_at = new Date().toISOString();
        changed = true;
      } catch {
        // 이번 주기는 여기서 멈추고 다음 주기에 재시도한다. 뒤 스케줄은 건드리지 않는다.
        break;
      }
    }

    const allDone = schedules.length > 0 && schedules.every((s) => s.completed_at);
    if (allDone) {
      // 완료 저장을 먼저 한다. Slack 전송이 실패해도 다음 주기가 같은 PUT을
      // 다시 하면 안 된다 — 알림은 놓쳐도 되지만 갱신은 두 번 하면 안 된다.
      await setBusVersionSchedules(job.token, []);
      if (client) {
        await client.chat.postMessage({
          channel: job.channel_id,
          thread_ts: job.thread_ts,
          text: `버스 시간표 버전 갱신 ${schedules.length}건이 모두 완료되었습니다.`,
        });
      }
    } else if (changed) {
      await setBusVersionSchedules(job.token, schedules);
    }
  }
}
