import type { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import { getBusRemainTime } from '@api/domains/transport/index';
import { kstDate, parse } from '@api/domains/misc/helpers';
import type { ApiEnv } from '@api/runtime';

const diningTypes: Record<string, { type: string; name: string }> = {
  BREAKFAST: { type: 'BREAKFAST', name: '아침' }, LUNCH: { type: 'LUNCH', name: '점심' }, DINNER: { type: 'DINNER', name: '저녁' },
  아침: { type: 'BREAKFAST', name: '아침' }, 점심: { type: 'LUNCH', name: '점심' }, 저녁: { type: 'DINNER', name: '저녁' },
};
export function kakaoText(text: string[]) {
  return { version: '2.0', template: { outputs: text.map((value) => ({ simpleText: { text: value } })), quickReplies: [] as { label: string; action: string; messageText: string }[] } };
}
export function formatBusRemain(label: string, seconds: number) {
  return `${label}, ${Math.trunc(seconds / 3600)}시간 ${Math.trunc(seconds % 3600 / 60)}분 ${seconds % 60}초 남음`;
}
export function registerKakao(app: Hono<ApiEnv>) {
  app.post('/koinbot/dinings', async (c) => {
    const input = parse(z.object({ action: z.object({ params: z.object({ dining_time: z.string() }) }) }), await c.req.json());
    const dining = diningTypes[input.action.params.dining_time.toUpperCase()];
    if (!dining) throw new ApiError(404, 'NOT_FOUND', '존재하지 않는 식사 타입입니다.');
    const rows = await c.get('db').select().from(schema.dining_menus).where(and(eq(schema.dining_menus.date, kstDate()), eq(schema.dining_menus.type, dining.type)));
    if (!rows.length) return c.body(`금일 ${dining.name}식사는 운영되지 않습니다.`, 200, { 'Content-Type': 'application/json' });
    const lines: string[] = [];
    for (const row of rows) {
      lines.push(`# ${row.place}`);
      if (!row.menu.trim()) throw new ApiError(400, 'ILLEGAL_STATE', '메뉴가 잘못된 형태로 저장되어있습니다.');
      for (const match of row.menu.matchAll(/"([^"]*)"/g)) lines.push(match[1]!);
      lines.push(`${row.kcal ?? 'null'}kcal`, `현금 ${row.price_cash ?? 'null'}원`, `페이코 ${row.price_card ?? 'null'}원`, '────────────');
    }
    return c.json(kakaoText([lines.join('\n')]));
  });
  app.post('/koinbot/buses', async (c) => {
    const input = parse(z.object({ action: z.object({ params: z.object({ depart: z.string(), arrival: z.string() }) }) }), await c.req.json());
    const stationNames: Record<string, string> = { 학교: 'koreatech', 한기대: 'koreatech', 코리아텍: 'koreatech', 대학: 'koreatech', 본교: 'koreatech', 천안역: 'station', '천안역(학화호두과자)': 'station', 터미널: 'terminal', '터미널(신세계 앞 횡단보도)': 'terminal', 야우리: 'terminal', '천안 터미널': 'terminal', koreatech: 'koreatech', station: 'station', terminal: 'terminal' };
    const depart = stationNames[input.action.params.depart.toLowerCase()];
    const arrival = stationNames[input.action.params.arrival.toLowerCase()];
    if (!depart || !arrival) throw new ApiError(404, 'NOT_FOUND', '존재하지 않는 버스 정류장입니다.');
    const current: string[] = [];
    const next: string[] = [];
    for (const [type, label] of [['city', '시내버스'], ['express', '대성고속'], ['shuttle', '셔틀버스'], ['commuting', '통학버스']] as const) {
      try {
        const buses = await getBusRemainTime(c.get('db'), c.env, type, depart, arrival);
        if (buses.now_bus) current.push(formatBusRemain(label, buses.now_bus.remain_time));
        if (buses.next_bus) next.push(formatBusRemain(label, buses.next_bus.remain_time));
      } catch (error) {
        console.warn('Kakao bus arrival unavailable', { type, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return c.json(kakaoText([`[바로 도착]\n${current.length ? current.join('\n') : '버스 운행정보없음\n'}`, `[다음 도착]\n${next.length ? next.join('\n') : '버스 운행정보없음\n'}`]));
  });
  app.post('/koinbot/buses/request', (c) => {
    const payload = kakaoText(['선택하세요!']);
    payload.template.quickReplies = ['한기대→터미널', '한기대→천안역', '터미널→한기대', '터미널→천안역', '천안역→한기대', '천안역→터미널'].map((label) => ({ label, action: 'message', messageText: label }));
    return c.json(payload);
  });
}
