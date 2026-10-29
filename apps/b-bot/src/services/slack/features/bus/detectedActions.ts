import type { BlockAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import {
  collectBusSpreadsheets,
  downloadBusNoticeFile,
  dropBusDetected,
  fetchBusArticle,
  loadBusDetected,
  saveBusDetected,
} from '~/services/bus/detected';
import type { BusNoticeFile } from '~/services/bus/detected';
import { createBusJob } from '~/services/bus/jobStore';
import { convertBusToReview } from '~/services/bus/pipeline';
import { buildReviewApprovalBlocks } from '~/services/slack/features/bus/blocks';
import { linkBusThread } from '~/services/bus/reviewStore';
import { labelOf, type KoinEnv } from '~/services/koin/target';
import { notice } from '~/services/slack/blocks';
import {
  beginDetected,
  chooseFileBlocks,
  convertThenRelease,
  ignoreDetected,
  readArticle,
  stopDetected,
  takeChoice,
} from '~/services/slack/detectedFlow';
import type { BlockActionSetting } from '~/services/slack/types';
import { errorMessage } from '~/utils/errorMessage';

const store = { load: loadBusDetected, drop: dropBusDetected };

/**
 * 고른 파일을 내려받아 변환하고 검토 링크까지 올린다.
 * 첨부가 하나일 때와 골랐을 때가 여기서 만난다.
 */
async function runConversion({
  client,
  channel,
  ts,
  actor,
  env,
  label,
  file,
  articleId,
}: {
  client: WebClient;
  channel: string;
  ts: string;
  actor: string;
  env: KoinEnv;
  label: string;
  file: BusNoticeFile;
  articleId: number;
}) {
  const conversionTarget = { env, fileName: file.name };

  await client.chat.update({
    channel,
    ts,
    text: '버스 시간표 변환 중',
    blocks: notice(`:hourglass_flowing_sand: *버스 시간표* 변환 중…\n${label} · ${file.name}`),
  });

  await convertThenRelease('bus', channel, articleId, async () => {
    try {
      const bytes = await downloadBusNoticeFile(file);
      const extension = `.${file.name.split('.').pop()?.toLowerCase()}`;
      const outcome = await convertBusToReview(bytes, extension, conversionTarget);

      // 반영 권한을 한 명만 갖게 하려면 상태가 DB에 있어야 한다. job 행이 없는데
      // 스레드부터 묶으면, 여기서 실패했을 때 스레드가 막다른 곳이 된다.
      await createBusJob({
        token: outcome.token,
        channelId: channel,
        threadTs: ts,
        sourceFile: file.name,
        routeCount: outcome.routeCount,
        semesterTypes: outcome.semesterTypes,
        targetEnv: env,
      });
      await linkBusThread(channel, ts, outcome.token);

      await client.chat.update({
        channel,
        ts,
        text: `버스 시간표 변환 완료 · ${outcome.routeCount}개`,
        blocks: buildReviewApprovalBlocks(outcome, conversionTarget, actor),
      });
    } catch (error) {
      await client.chat.update({
        channel,
        ts,
        text: '버스 시간표 변환 실패',
        blocks: notice(`:x: *변환 실패*\n${errorMessage(error)}\n${file.name} · 요청: <@${actor}>`),
      });
    }
  });
}

export const BUS_DETECTED_ACTION_IDS = [
  'bus:detected',
  'bus:detected_ignore',
  'bus:detected_start',
  'bus:detected_start_1',
  'bus:detected_start_2',
  'bus:detected_start_3',
] as const;

/**
 * 배치가 올린 감지 알림의 "확인"/"넘어가기".
 *
 * 배치가 아는 건 이 action_id와 `article_id` 하나뿐이다(coop:detected/lecture:detected와
 * 동일한 계약). 첨부 조회·변환·오류 문구는 전부 여기서 만든다.
 */
export async function handleBusDetectedAction(
  client: WebClient,
  body: BlockAction,
  action: BlockAction['actions'][number],
) {
  const press = { client, body, action };

  if (action.action_id === 'bus:detected_ignore') {
    await ignoreDetected('bus', store, press, {
      text: '버스 공지를 넘어갑니다.',
      title: '이 버스 공지는 넘어갑니다.',
    });
    return;
  }

  // 파일이 여럿이라 고른 경우. 버튼마다 action_id가 달라야 해서 접미사로 나눈다.
  if (action.action_id.startsWith('bus:detected_start')) {
    if (!body.message?.ts) return;
    const choice = await takeChoice(
      store,
      press,
      (detected, index) => detected.files[index],
      ':x: 이미 처리했거나 만료된 알림입니다.',
    );
    if (!choice) return;
    await runConversion({
      client,
      channel: body.channel!.id,
      ts: body.message.ts,
      actor: body.user.id,
      env: choice.detected.target,
      label: labelOf(choice.detected.target),
      file: choice.file,
      articleId: choice.detected.articleId,
    });
    return;
  }

  const begun = await beginDetected('bus', press, {
    feature: '버스',
    notTarget: '버스 반영 대상 채널이 아닙니다.',
    started: '버스 시간표 업데이트를 진행합니다.',
    startedTitle: '버스 시간표 업데이트를 진행합니다.',
    checking: '버스 게시글 확인 중',
    checkingNotice: ':hourglass_flowing_sand: 버스 게시글을 확인하고 있습니다…',
  });
  if (!begun) return;
  const { target, articleId, channel, actor, ts } = begun;

  const article = await readArticle(begun, fetchBusArticle, '버스 게시글 조회 실패');
  if (!article) return;

  const files = collectBusSpreadsheets(article.attachments);
  if (files.length === 0) {
    await stopDetected(begun, '버스 시간표 첨부 없음', [
      ':grey_question: *지원하는 시간표 파일 첨부를 찾지 못했습니다.*',
      `<${article.link}|${article.name}>`,
      '파일을 직접 올리고 `!버스반영`으로 실행해주세요.',
    ]);
    return;
  }

  // 시간표 파일이 여럿이면 사람이 고른다. 정규학기·계절학기가 따로 붙는 공지가 있다.
  if (files.length > 1) {
    const token = await saveBusDetected({
      target: target.env,
      articleId,
      articleTitle: article.name,
      articleUrl: article.link,
      files,
    });
    await client.chat.update({
      channel,
      ts,
      text: '변환할 파일을 골라주세요',
      blocks: chooseFileBlocks({
        heading: [
          `:page_facing_up: *버스 시간표* · ${target.label}`,
          `시간표 첨부가 *${files.length}개* 입니다. 변환할 파일을 골라주세요.`,
        ],
        files,
        actionPrefix: 'bus:detected',
        token,
      }),
    });
    return;
  }

  await runConversion({
    client,
    channel,
    ts,
    actor,
    env: target.env,
    label: target.label,
    file: files[0],
    articleId,
  });
}

/** 버스 공지 감지. 등록표는 `blockAction.ts`가 모으기만 한다. */
export const busDetectedActions: BlockActionSetting[] = BUS_DETECTED_ACTION_IDS.map((actionId) => ({
  actionId,
  async handler({ client, body, action }) {
    await handleBusDetectedAction(client, body, action);
  },
}));
