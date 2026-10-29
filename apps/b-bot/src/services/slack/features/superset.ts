import type { KnownBlock } from '@slack/web-api';
import { answer, planDashboard, createDashboard, classifyRequest } from '~/services/superset';
import type { DashboardPlan } from '~/services/superset';
import type { DashboardConfirmation } from '~/services/superset/confirmation';
import {
  cancelDashboardConfirmation,
  claimDashboardConfirmation,
  expireDashboardConfirmation,
  finishDashboardConfirmation,
  loadDashboardConfirmation,
  recordDashboardAudit,
  saveDashboardConfirmation,
} from '~/services/superset/confirmation';
import type { BlockActionSetting, MessageSetting } from '~/services/slack/types';
import { updateSlack } from '~/utils/slackFunction';

const safeFailure = '요청을 처리하지 못했어요. 권한과 데이터 설정을 확인한 뒤 다시 시도해주세요.';
/** Keeps the operational cause visible instead of collapsing every failure into one line. */
const failureDetail = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]+|Bearer\s+\S+)\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
};
const tokenFrom = (value: string | undefined): string | null => {
  try {
    const token = JSON.parse(value ?? '')?.token;
    return typeof token === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)
      ? token
      : null;
  } catch {
    return null;
  }
};

function preview(plan: DashboardPlan, token: string): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'plain_text',
        text: `대시보드 미리보기: ${plan.title}\n요청자만 15분 이내에 확정하거나 취소할 수 있습니다.`,
      },
    },
    ...plan.charts.flatMap((chart) => {
      const text = `${chart.title} — ${chart.chartType}, 데이터셋 ${chart.datasetId}\n열: ${chart.columns.join(', ') || '없음'}\n지표: ${chart.metrics.join(', ') || '없음'}\n그룹: ${chart.groupby.join(', ') || '없음'}\n시간 열: ${chart.timeColumn || '없음'}\n시간 단위: ${chart.timeGrain || '자동'}\n정렬: ${(chart.orderBy ?? []).map(({ field, ascending }) => `${field} ${ascending ? '오름차순' : '내림차순'}`).join(', ') || '기본'}\n행 제한: ${chart.rowLimit ?? '기본'}\n기간: ${chart.timeRange || '전체'}\n필터: ${JSON.stringify(chart.filters ?? [])}`;
      return (text.match(/[\s\S]{1,2800}/g) ?? []).map((part: string): KnownBlock => ({
        type: 'section',
        text: { type: 'plain_text', text: part },
      }));
    }),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'superset:confirm',
          text: { type: 'plain_text', text: '생성' },
          style: 'primary',
          value: JSON.stringify({ token }),
        },
        {
          type: 'button',
          action_id: 'superset:cancel',
          text: { type: 'plain_text', text: '취소' },
          style: 'danger',
          value: JSON.stringify({ token }),
        },
      ],
    },
  ];
}

export const messages: MessageSetting[] = [
  {
    regex: /^!대시보드\s+/,
    async handler({ client, channel, ts, text, user }) {
      let request = text.replace(/^!대시보드\s+/, '').trim();
      if (!request) return;
      const pending = await client.chat.postMessage({ channel, thread_ts: ts, text: '요청을 확인하는 중이에요…' });
      let planning = false;
      try {
        const explicit = /^(질문|생성)\s+/.exec(request);
        if (explicit) request = request.slice(explicit[0].length).trim();
        const intent = explicit ? (explicit[1] === '질문' ? 'answer' : 'dashboard') : await classifyRequest(request);
        if (intent === 'answer') {
          const response = await answer(request);
          await client.chat.update({
            channel,
            ts: pending.ts as string,
            text: response.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
          });
          return;
        }
        planning = true;
        const plan = await planDashboard(request);
        const msgTs = pending.ts as string;
        const token = await saveDashboardConfirmation({ userId: user, channelId: channel, messageTs: msgTs, plan });
        await client.chat.update({
          channel,
          ts: msgTs,
          text: '대시보드 생성안을 확인해주세요.',
          blocks: preview(plan, token),
        });
      } catch (error) {
        console.error('superset command failed:', error);
        if (planning) await recordDashboardAudit(user, 'dashboard_plan', 'failed').catch(() => {});
        await client.chat.update({
          channel,
          ts: pending.ts as string,
          text: `${safeFailure}\n원인: ${failureDetail(error)}`,
          blocks: [],
        });
      }
    },
  },
];

export const blockActions: BlockActionSetting[] = [
  {
    actionId: 'superset:confirm',
    async handler({ client, body, action }) {
      if (action.type !== 'button' || !body.channel || !body.message) return;
      const { channel, message, user } = body;
      const token = tokenFrom(action.value);
      if (!token) return;
      const notify = (text: string) => client.chat.postEphemeral({ channel: channel.id, user: user.id, text });
      // A link that is already recorded is delivered without creating again; status is only settled.
      const deliverRecorded = async (stored: DashboardConfirmation): Promise<boolean> => {
        if (!stored.resultUrl || (stored.status !== 'claimed' && stored.status !== 'succeeded')) return false;
        if (stored.status === 'claimed')
          await finishDashboardConfirmation(token, user.id, true, stored.resultUrl).catch(() => {});
        await notify(`대시보드를 생성했습니다: ${stored.resultUrl}`);
        return true;
      };
      const expiryNotice =
        '대시보드 생성 시간이 만료되었습니다. Superset에 이미 생성된 대시보드가 있는지 확인한 뒤 다시 요청해주세요.';
      const unconfirmedNotice = '요청 상태를 확인하지 못했어요. 잠시 후 다시 시도해주세요.';
      // Anything already recorded about this request is delivered without creating again.
      const recover = async (stored: DashboardConfirmation | null): Promise<boolean> => {
        if (!stored) return false;
        if (await deliverRecorded(stored)) return true;
        if (stored.status !== 'claimed') return false;
        if (new Date(stored.expiresAt).getTime() > Date.now()) {
          await notify('대시보드를 생성하는 중이에요. 잠시 후 다시 확인해주세요.');
          return true;
        }
        // The claim outlived its execution deadline. Another attempt may have recorded a URL
        // concurrently, so only expire nothing-yet-recorded work and then re-read once.
        try {
          if (await expireDashboardConfirmation(token, user.id)) {
            await notify(expiryNotice);
            return true;
          }
        } catch {
          await notify(unconfirmedNotice);
          return true;
        }
        let latest: DashboardConfirmation | null;
        try {
          latest = await loadDashboardConfirmation(token, user.id, channel.id, message.ts);
        } catch {
          await notify(unconfirmedNotice);
          return true;
        }
        if (latest && (await deliverRecorded(latest))) return true;
        if (!latest || latest.status !== 'claimed') {
          // failed/cancelled/succeeded-without-link: the request is finished and cannot be retried here.
          await notify(expiryNotice);
          return true;
        }
        await notify('대시보드를 생성하는 중이에요. 잠시 후 다시 확인해주세요.');
        return true;
      };
      const stored = await loadDashboardConfirmation(token, user.id, channel.id, message.ts);
      if (!stored) {
        await notify('이미 처리했거나 만료된 요청입니다.');
        return;
      }
      if (stored.userId !== user.id || stored.channelId !== channel.id || stored.messageTs !== message.ts) return;
      if (await recover(stored)) return;
      const plan = await claimDashboardConfirmation(token, user.id, channel.id, message.ts);
      if (!plan) {
        const latest = await loadDashboardConfirmation(token, user.id, channel.id, message.ts);
        if (await recover(latest)) return;
        await notify('이미 처리했거나 만료된 요청입니다.');
        return;
      }
      let url: string;
      try {
        const progress = preview(plan, token);
        progress[0] = {
          type: 'section',
          text: { type: 'plain_text', text: '대시보드를 생성하는 중이에요. 생성이 완료되면 결과 링크를 안내합니다.' },
        };
        await updateSlack({
          client,
          channel: channel.id,
          ts: message.ts,
          text: '대시보드를 생성하는 중이에요…',
          blocks: progress,
        });
        url = await createDashboard(plan);
      } catch (error) {
        console.error('superset dashboard creation failed:', failureDetail(error));
        await finishDashboardConfirmation(token, user.id, false).catch(() => {});
        await updateSlack({
          client,
          channel: channel.id,
          ts: message.ts,
          text: `생성을 완료하지 못했습니다. Superset에 일부 항목이 남았을 수 있으니 확인 후 다시 요청해주세요.\n원인: ${failureDetail(error)}`,
          blocks: [],
        });
        return;
      }
      // The URL is stored durably inside finish before its status/audit transaction, so a
      // recording failure must not hide a dashboard that was really created.
      await finishDashboardConfirmation(token, user.id, true, url).catch(() => {});
      await updateSlack({
        client,
        channel: channel.id,
        ts: message.ts,
        text: `대시보드를 생성했습니다: ${url}`,
        blocks: [],
      });
    },
  },
  {
    actionId: 'superset:cancel',
    async handler({ client, body, action }) {
      if (action.type !== 'button' || !body.channel || !body.message) return;
      const { channel, message, user } = body;
      const token = tokenFrom(action.value);
      if (!token) return;
      const stored = await loadDashboardConfirmation(token);
      if (!stored || stored.userId !== user.id || stored.channelId !== channel.id || stored.messageTs !== message.ts)
        return;
      const cancelled = await cancelDashboardConfirmation(token, user.id, channel.id, message.ts);
      if (!cancelled) {
        await client.chat.postEphemeral({
          channel: channel.id,
          user: user.id,
          text: '이미 처리했거나 만료된 요청입니다.',
        });
        return;
      }
      await updateSlack({
        client,
        channel: channel.id,
        ts: message.ts,
        text: '대시보드 생성을 취소했습니다.',
        blocks: [],
      });
    },
  },
];
