import type { BlockAction } from '@slack/bolt';
import type { KnownBlock, WebClient } from '@slack/web-api';
import { koreatechArticleUrl, type KoinArticle } from '~/services/koin/article';
import { acquireDetectLock, releaseDetectLock } from '~/services/koin/detectLock';
import { resolveTarget, type KoinTarget } from '~/services/koin/target';
import { MAX_CHOICES, notice, replaceOriginal, shorten } from '~/services/slack/blocks';
import { errorMessage } from '~/utils/errorMessage';

/**
 * 게시판 공지 감지 버튼의 공통 단계.
 *
 * 배치가 올린 감지 알림엔 "확인"/"넘어가기" 버튼과 `article_id` 하나만 있다.
 * 게시글 조회·첨부 선별·변환·오류 문구는 전부 삐봇이 한다. 버스·생협·강의가
 * 같은 단계를 밟고, 무엇을 첨부로 볼지와 변환 방법만 다르다.
 */

type Scope = 'bus' | 'coop' | 'lecture';

interface Press {
  client: WebClient;
  body: BlockAction;
  action: BlockAction['actions'][number];
}

interface DetectedStore<T> {
  load(token: string): Promise<T | null>;
  drop(token: string): Promise<void>;
}

export const parseValue = <T>(action: Press['action']) =>
  JSON.parse((action.type === 'button' ? action.value : undefined) ?? '{}') as Partial<T>;

/**
 * [넘어가기]. 여럿 중에 고르다가 누른 경우엔 값에 token이 실려 와서 락을 푼다.
 * 배치가 웹훅으로 올린 최초 메시지의 [넘어가기]엔 token이 없다 — 그땐 아직
 * 락을 잡기 전이라 풀 것도 없다.
 */
export async function ignoreDetected<T extends { articleId: number }>(
  scope: Scope,
  store: DetectedStore<T>,
  { body, action }: Press,
  { text, title }: { text: string; title: string },
): Promise<void> {
  if (action.type !== 'button' || !body.channel) return;
  const { token } = parseValue<{ token: string }>(action);
  if (token) {
    const detected = await store.load(token);
    await store.drop(token);
    if (detected) {
      await releaseDetectLock(scope, body.channel.id, detected.articleId);
    }
  }
  // 배치가 웹훅으로 올린 메시지일 수 있어 response_url로 바꾼다.
  await replaceOriginal(body.response_url, text, notice(`:no_entry_sign: *${title}*\n<@${body.user.id}>`));
}

/**
 * 여럿 중에 고른 파일을 꺼낸다. 이미 처리했거나 만료됐으면 알리고 null.
 * 꺼내면 바로 지운다 — 두 명이 눌러 두 번 변환하면 검토 링크가 둘이 된다.
 */
export async function takeChoice<T, F>(
  store: DetectedStore<T>,
  { client, body, action }: Press,
  pick: (detected: T, fileIndex: number) => F | undefined,
  expiredNotice: string,
): Promise<{ detected: T; file: F; ts: string | undefined } | null> {
  if (action.type !== 'button' || !body.channel) return null;
  const { token, fileIndex = 0 } = parseValue<{ token: string; fileIndex: number }>(action);
  if (!token) return null;

  const ts = body.message?.ts;
  const detected = await store.load(token);
  const file = detected ? pick(detected, fileIndex) : undefined;
  if (!detected || !file) {
    await client.chat.update({ channel: body.channel.id, ts, text: '만료됨', blocks: notice(expiredNotice) });
    return null;
  }
  await store.drop(token);
  return { detected, file, ts };
}

export interface Begun {
  target: KoinTarget;
  articleId: number;
  channel: string;
  actor: string;
  /** 봇이 새로 올린 진행 메시지. 이후 갱신과 스레드 연결은 여기서 한다. */
  ts: string;
  say(text: string, mrkdwn: string): Promise<unknown>;
  release(): Promise<void>;
}

/**
 * 최초 알림의 [확인]: 대상 채널 확인 → 락 → 원본 교체 → 진행 메시지.
 * 진행할 수 없으면 알리고 null.
 */
export async function beginDetected(
  scope: Scope,
  { client, body, action }: Press,
  texts: {
    /** `resolveTarget`에 넘기는 기능 이름(버스·생협·강의). */
    feature: string;
    notTarget: string;
    started: string;
    startedTitle: string;
    checking: string;
    checkingNotice: string;
  },
): Promise<Begun | null> {
  if (action.type !== 'button' || !body.channel) return null;
  const { article_id: articleId } = parseValue<{ article_id: number }>(action);
  if (!articleId) return null;
  const channel = body.channel.id;
  const actor = body.user.id;

  // 어느 코인에 반영할지는 채널로 정한다. 배치는 웹훅을 고르는 것으로 이미 답했다.
  const resolved = resolveTarget(channel, texts.feature);
  if (!resolved.target) {
    await replaceOriginal(
      body.response_url,
      texts.notTarget,
      notice(`:x: ${resolved.reason ?? '반영 대상을 찾지 못했습니다.'}`),
    );
    return null;
  }
  const target = resolved.target;

  // 버튼을 지우는 것만으로는 두 번 눌리는 걸 막지 못한다. 원본을 갈아끼우기 전에
  // 잠근다 — 변환이 두 번 돌면 검토 링크와 [반영] 버튼이 둘씩 생기고,
  // 그 둘은 토큰이 달라 반영 락에도 걸리지 않는다.
  const lock = await acquireDetectLock(scope, channel, articleId, actor);
  if (!lock.ok) {
    await client.chat.postEphemeral({
      channel,
      user: actor,
      text: lock.actor ? `<@${lock.actor}>님이 이미 이 공지를 진행 중입니다.` : '이미 진행 중인 공지입니다.',
    });
    return null;
  }
  const release = () => releaseDetectLock(scope, channel, articleId);

  // 배치 메시지는 여기서 역할이 끝난다. 이후 갱신은 봇이 올린 메시지에서 한다.
  await replaceOriginal(
    body.response_url,
    texts.started,
    notice(`:white_check_mark: *${texts.startedTitle}* · ${target.label}\n<@${actor}>`),
  );
  const posted = await client.chat.postMessage({
    channel,
    text: texts.checking,
    blocks: notice(texts.checkingNotice),
  });
  const ts = posted.ts;
  if (!ts) {
    // ts가 없으면 이후 갱신도, 스레드 연결도 할 수 없다. 빈 문자열로 이어가면
    // 다음 변환이 같은 스레드 키를 덮어써서 `!수정`이 엉뚱한 건에 붙는다.
    await release();
    throw new Error('메시지를 올리지 못해 진행할 수 없습니다.');
  }

  return {
    target,
    articleId,
    channel,
    actor,
    ts,
    say: (text, mrkdwn) => client.chat.update({ channel, ts, text, blocks: notice(mrkdwn) }),
    release,
  };
}

/** 게시글을 읽는다. 실패하면 락을 풀고 알린 뒤 null. */
export async function readArticle(
  begun: Begun,
  fetchArticle: (articleId: number) => Promise<KoinArticle>,
  failedText: string,
): Promise<(KoinArticle & { link: string; name: string }) | null> {
  try {
    const article = await fetchArticle(begun.articleId);
    return {
      ...article,
      link: article.url || koreatechArticleUrl(begun.articleId),
      name: article.title ?? `게시글 ${begun.articleId}`,
    };
  } catch (error) {
    await begun.release();
    await begun.say(failedText, `:x: *게시글을 읽지 못했습니다.*\n${errorMessage(error, '')}`);
    return null;
  }
}

/** 진행을 멈추고 이유를 알린다. 락을 풀어야 같은 공지의 새 알림을 받을 수 있다. */
export async function stopDetected(begun: Begun, text: string, lines: string[]): Promise<void> {
  await begun.release();
  await begun.say(text, lines.join('\n'));
}

/** 첨부가 여럿일 때 고르는 버튼. 버튼마다 action_id가 달라야 해서 접미사를 붙인다. */
export function chooseFileBlocks({
  heading,
  files,
  actionPrefix,
  token,
}: {
  /** 첫 두 줄(무엇을 · 어디에, 첨부가 몇 개인지). */
  heading: string[];
  files: Array<{ name: string }>;
  actionPrefix: string;
  token: string;
}): KnownBlock[] {
  const shown = files.slice(0, MAX_CHOICES);
  return [
    ...notice([...heading, '', ...shown.map((file, index) => `${index + 1}. ${file.name}`)].join('\n')),
    {
      type: 'actions',
      elements: [
        ...shown.map((file, index) => ({
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: shorten(file.name), emoji: true },
          style: index === 0 ? ('primary' as const) : undefined,
          action_id: `${actionPrefix}_start${index === 0 ? '' : `_${index}`}`,
          value: JSON.stringify({ token, fileIndex: index }),
        })),
        {
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: '아니요', emoji: true },
          action_id: `${actionPrefix}_ignore`,
          value: JSON.stringify({ token }),
        },
      ],
    },
  ];
}

/**
 * 변환을 돌리고 결과와 무관하게 락을 푼다.
 *
 * 이 게시글의 원본 버튼은 락을 잡은 직후 이미 갈아끼웠다(`beginDetected`). 그러니
 * 여기서부터는 성공하든 실패하든 다시 눌릴 방법이 없다 — 안 풀면 취소하거나 실패해도
 * 30분 동안 같은 게시글의 새 알림이 막힌다.
 */
export async function convertThenRelease(
  scope: Scope,
  channel: string,
  articleId: number,
  convert: () => Promise<void>,
): Promise<void> {
  try {
    await convert();
  } finally {
    await releaseDetectLock(scope, channel, articleId);
  }
}
