import { sql, type SQL } from 'drizzle-orm';
import { schema } from '@api/db/schema';
import type { Bindings } from '@api/runtime';
import { kstDate, sqlNow, utcMillis } from '@api/domains/clubs/behavior';

export interface EventReminderPlan {
  id: string;
  dueAt: number;
  statement: SQL;
}

export function planEventReminders(
  eventId: number | SQL,
  start: string,
  notified: boolean,
  time = Date.now(),
): EventReminderPlan[] {
  const begins = utcMillis(start);
  const plans: EventReminderPlan[] = [];
  const dayDue = Date.parse(`${kstDate(begins)}T12:30:00+09:00`) - 86_400_000;
  const candidates = [
    { kind: 'event-day', dueAt: dayDue, include: dayDue >= time },
    { kind: 'event-hour', dueAt: Math.max(time, begins - 3_600_000), include: !notified && begins >= time },
  ];
  for (const candidate of candidates) {
    if (!candidate.include) continue;
    const id = crypto.randomUUID();
    plans.push({
      id,
      dueAt: candidate.dueAt,
      statement: sql`INSERT INTO ${schema.native_club_outbox} (id,kind,payload,due_at) VALUES (${id},${candidate.kind},json_object('eventId',${eventId},'startDate',${start}),${sqlNow(candidate.dueAt)})`,
    });
  }
  return plans;
}

export async function signalEventReminders(
  env: Bindings,
  plans: readonly Pick<EventReminderPlan, 'id' | 'dueAt'>[],
): Promise<void> {
  for (let offset = 0; offset < plans.length; offset += 100) {
    await env.JOBS.sendBatch(
      plans.slice(offset, offset + 100).map((plan) => ({
        body: { kind: 'clubs.outbox', key: plan.id, payload: {} },
        delaySeconds: Math.min(43_200, Math.max(0, Math.ceil((plan.dueAt - Date.now()) / 1000))),
      })),
    );
  }
}
