import type { BlockAction } from '@slack/bolt';
import type { KnownBlock, WebClient } from '@slack/web-api';
import { getKoinAdminAuth, type KoinAdminAuth } from '~/services/koin/adminAuth';
import type { ClaimResult } from '~/services/koin/jobLock';
import { labelOf, resolveTargetByEnv, type KoinEnv } from '~/services/koin/target';
import { notice } from '~/services/slack/blocks';
import { errorMessage } from '~/utils/errorMessage';
import { updateSlack } from '~/utils/slackFunction';

/** 반영 메시지에 쓰는 문구. 알림(text)과 본문이 도메인마다 다르다. */
export interface ApplyTexts {
  progress: string;
  done: string;
  failed: string;
  expired: string;
  expiredNotice: string;
  cancelled: string;
  /** `*…을 취소했습니다.*` 앞부분. */
  cancelledTitle: string;
}

/** 실패했을 때 사람에게 더 알릴 것. 작업 상태 기록은 `fail`이 직접 한다. */
export interface FailureNotice {
  /** 실패 문구 뒤에 붙는 설명(어디까지 반영됐는지 등). */
  detail?: string;
  /** 따로 강조할 경고. */
  warning?: string;
  /** 다시 시도 전에 한 번 더 묻는다. 반영이 일부 들어갔을 수 있을 때. */
  confirm?: { title: string; text: string; confirm: string; deny: string };
}

/**
 * 반영 작업 하나. 버튼을 누를 때마다 새로 만든다 — 어디까지 반영했는지 같은
 * 그 시도만의 상태를 클로저에 들고 있어야 해서다.
 */
export interface ApplyJob<T> {
  texts: ApplyTexts;
  retryActionId: string;
  claim(token: string, actor: string): Promise<ClaimResult>;
  cancel(token: string, actor: string): Promise<boolean>;
  load(token: string): Promise<T | null>;
  /** 검토 데이터가 사라졌을 때 작업을 실패로 남긴다. */
  expire(token: string): Promise<void>;
  /** 진행 메시지를 띄우기 전에 막아야 할 데이터 문제. throw로 알린다. */
  validate?(stored: T): void;
  env(stored: T): KoinEnv;
  fileName(stored: T): string;
  progress(stored: T, actor: string): string;
  /** 반영 본체. 완료 메시지 본문을 돌려준다. 성공 기록도 여기서 한다. */
  apply(stored: T, auth: KoinAdminAuth, token: string): Promise<string>;
  /** 작업을 실패로 기록하고, 사람에게 더 알릴 것을 돌려준다. */
  fail(token: string, message: string, error: unknown): Promise<FailureNotice>;
}

interface ButtonPress {
  client: WebClient;
  body: BlockAction;
  action: BlockAction['actions'][number];
}

/**
 * 반영·취소 버튼 처리. 세 도메인(버스·생협·강의)이 같은 순서를 밟는다:
 * 선점 → 검토 불러오기 → 진행 표시 → 대상·인증 → 반영 → 완료,
 * 실패하면 실패로 기록하고 다시 시도 버튼을 단다.
 *
 * 선점은 DB 락이라 재배포해도 풀리지 않는다. 두 번 반영하면 손으로 지워야 한다.
 */
export async function handleApplyButton<T>(
  job: ApplyJob<T>,
  mode: 'apply' | 'cancel',
  { client, body, action }: ButtonPress,
): Promise<void> {
  if (action.type !== 'button' || !body.channel) return;
  const { token } = JSON.parse(action.value ?? '{}') as { token?: string };
  if (!token) return;

  const channel = body.channel.id;
  const ts = body.message?.ts;
  const actor = body.user.id;
  const say = (text: string, blocks: KnownBlock[]) => updateSlack({ client, channel, ts, text, blocks });
  const tellActor = (text: string) => client.chat.postEphemeral({ channel, user: actor, text });

  if (mode === 'cancel') {
    // 이미 반영됐거나 진행 중인 걸 취소한 것처럼 보이게 두면 안 된다.
    if (!(await job.cancel(token, actor))) {
      await tellActor('이미 반영됐거나 진행 중이라 취소할 수 없습니다.');
      return;
    }
    await say(
      job.texts.cancelled,
      notice(`:no_entry_sign: *${job.texts.cancelledTitle}을 취소했습니다.*\n<@${actor}>`),
    );
    return;
  }

  const claim = await job.claim(token, actor);
  if (!claim.ok) {
    await tellActor(claim.reason ?? '지금은 반영할 수 없습니다.');
    return;
  }

  try {
    const stored = await job.load(token);
    if (!stored) {
      await job.expire(token);
      await say(job.texts.expired, notice(job.texts.expiredNotice));
      return;
    }

    job.validate?.(stored);
    await say(job.texts.progress, notice(job.progress(stored, actor)));

    // 변환할 때 정해진 환경으로 붙는다. 채널이 바뀌어도 대상은 바뀌지 않는다.
    const resolved = resolveTargetByEnv(job.env(stored));
    if (!resolved.target) {
      throw new Error(resolved.reason ?? '대상 환경을 찾지 못했습니다.');
    }
    const auth = await getKoinAdminAuth(resolved.target);
    const done = await job.apply(stored, auth, token);

    await say(job.texts.done, [
      ...notice(done),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `작업자: <@${actor}> · ${job.fileName(stored)}` }] },
    ]);
  } catch (error) {
    const message = errorMessage(error);
    // 실패로 되돌려 원인을 고친 뒤 다시 누를 수 있게 한다.
    const failure = await job.fail(token, message, error);
    await say(job.texts.failed, failureBlocks(job, token, actor, message, failure));
  }
}

function failureBlocks(
  job: ApplyJob<unknown>,
  token: string,
  actor: string,
  message: string,
  { detail = '', warning, confirm }: FailureNotice,
): KnownBlock[] {
  return [
    ...notice(`:x: *${job.texts.failed}*\n${message}${detail}`),
    ...(warning ? notice(warning) : []),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '다시 시도', emoji: true },
          action_id: job.retryActionId,
          value: JSON.stringify({ token }),
          ...(confirm
            ? {
                confirm: {
                  title: { type: 'plain_text', text: confirm.title },
                  text: { type: 'mrkdwn', text: confirm.text },
                  confirm: { type: 'plain_text', text: confirm.confirm },
                  deny: { type: 'plain_text', text: confirm.deny },
                },
              }
            : {}),
        },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `작업자: <@${actor}> · 원인을 해결한 뒤 눌러주세요.` }] },
  ];
}

/** 진행 메시지 둘째 줄. 어느 환경에 누가 반영하는지. */
export const progressLine = (env: KoinEnv, actor: string) => `${labelOf(env)} · 작업자: <@${actor}>`;
