import type { Context } from 'hono';
import { markAdminActivityDelegated } from '@api/domains/experiments/audit';
import type { ApiEnv } from '@api/runtime';

/** 같은 자원의 짧은 변경 요청만 직렬화한다. D1 원자 배치는 호출 도메인이 별도로 보장한다. */
export async function coordinateRequest(c: Context<ApiEnv>, key: string): Promise<Response | null> {
  if (c.env.SERIALIZED === true) return null;
  const coordinator = c.env.COORDINATOR.get(c.env.COORDINATOR.idFromName(key));
  markAdminActivityDelegated(c);

  return coordinator.fetch(c.req.raw.clone());
}
