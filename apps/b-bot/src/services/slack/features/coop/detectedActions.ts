import type { BlockAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import {
  collectCoopImages,
  downloadCoopNoticeImage,
  dropDetectedCoop,
  fetchCoopArticle,
  guessCoopSemester,
  loadDetectedCoop,
  saveDetectedCoop,
  type DetectedCoopTermName,
  type CoopNoticeImage,
} from '~/services/coop/detected';
import { convertRegularRawCoopToReview, extractCoopImage } from '~/services/coop/pipeline';
import { buildRegularCoopResultBlocks } from '~/services/slack/features/coop/blocks';
import { linkCoopThread } from '~/services/coop/reviewStore';
import { createCoopJob } from '~/services/coop/jobStore';
import { labelOf, type KoinEnv } from '~/services/koin/target';
import { savePendingCoopVacation } from '~/services/coop/vacationStore';
import { resolveExtractedCoopSemester } from '~/services/coop/vision';
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

const store = { load: loadDetectedCoop, drop: dropDetectedCoop };

async function runCoopConversion({
  client,
  channel,
  ts,
  actor,
  image,
  hint,
  env,
  articleId,
}: {
  client: WebClient;
  channel: string;
  ts: string | undefined;
  actor: string;
  image: CoopNoticeImage;
  hint?: { year: number; termName: DetectedCoopTermName };
  env: KoinEnv;
  articleId: number;
}) {
  await client.chat.update({
    channel,
    ts,
    text: '생협 운영시간 변환 중',
    blocks: notice(
      `:hourglass_flowing_sand: *생협 운영시간* 이미지 분석 중…\n${labelOf(env)} · ${image.name}\n작업자: <@${actor}>`,
    ),
  });

  await convertThenRelease('coop', channel, articleId, async () => {
    try {
      const buffer = await downloadCoopNoticeImage(image);
      const raw = await extractCoopImage({
        image: buffer,
        mimeType: image.mimeType,
        fileName: image.name,
      });
      const semester = resolveExtractedCoopSemester(raw);
      if (!semester) {
        throw new Error(
          [
            '이미지에서 학기를 읽지 못했습니다.',
            `읽은 학기: ${raw.semesterLabel || '(없음)'}`,
            `읽은 제목: ${raw.title || '(없음)'}`,
          ].join('\n'),
        );
      }
      if (hint && (hint.year !== semester.year || hint.termName !== semester.termName)) {
        throw new Error(
          `공지 제목은 ${hint.year} ${hint.termName}인데 이미지에서는 ${semester.year} ${semester.termName}(으)로 읽었습니다.`,
        );
      }
      if (semester.kind === 'vacation') {
        await savePendingCoopVacation(channel, ts ?? '', {
          env,
          year: semester.year,
          season: semester.season,
          fileName: image.name,
          requesterId: actor,
          raw,
        });
        await client.chat.update({
          channel,
          ts,
          text: '방학 시작일 입력 대기',
          blocks: notice(
            [
              `:calendar: *${semester.year} ${semester.season} 운영시간을 읽었습니다.*`,
              `전체 기간: ${raw.fromDate} - ${raw.toDate}`,
              '',
              '이 메시지의 스레드에 방학 시작일을 입력해주세요.',
              '예) `!학기구분 2026-07-18`',
            ].join('\n'),
          ),
        });
        return;
      }
      const normalizedRaw = { ...raw, semesterLabel: semester.normalizedLabel };
      const target = {
        env,
        year: semester.year,
        termName: semester.termName,
        fileName: image.name,
      };
      const outcome = await convertRegularRawCoopToReview(normalizedRaw, target);
      await linkCoopThread(channel, ts ?? '', outcome.token);
      await createCoopJob({
        token: outcome.token,
        channelId: channel,
        threadTs: ts ?? '',
        year: semester.year,
        term: semester.termName,
        sourceFile: image.name,
        shopCount: outcome.shopCount,
        targetEnv: env,
      });
      await client.chat.update({
        channel,
        ts,
        text: `${semester.year} ${semester.termName} 생협 운영시간 변환 완료 · ${outcome.shopCount}개`,
        blocks: buildRegularCoopResultBlocks(outcome, target, actor),
      });
    } catch (error) {
      await client.chat.update({
        channel,
        ts,
        text: '생협 운영시간 변환 실패',
        blocks: [
          ...notice(`:x: *변환 실패*\n${errorMessage(error)}`),
          { type: 'context', elements: [{ type: 'mrkdwn', text: `${image.name} · 작업자: <@${actor}>` }] },
        ],
      });
    }
  });
}

export const COOP_DETECTED_ACTION_IDS = [
  'coop:detected',
  'coop:detected_ignore',
  'coop:detected_start',
  'coop:detected_start_1',
  'coop:detected_start_2',
  'coop:detected_start_3',
] as const;

export async function handleCoopDetectedAction(
  client: WebClient,
  body: BlockAction,
  action: BlockAction['actions'][number],
) {
  const press = { client, body, action };

  if (action.action_id === 'coop:detected_ignore') {
    await ignoreDetected('coop', store, press, {
      text: '생협 공지를 넘어갑니다.',
      title: '이 생협 공지는 넘어갑니다.',
    });
    return;
  }

  if (action.action_id.startsWith('coop:detected_start')) {
    const choice = await takeChoice(
      store,
      press,
      (detected, index) => detected.images[index],
      ':x: 이미 처리했거나 만료된 생협 알림입니다.',
    );
    if (!choice) return;
    const { detected } = choice;
    await runCoopConversion({
      client,
      channel: body.channel!.id,
      ts: choice.ts,
      actor: body.user.id,
      image: choice.file,
      hint: detected.year && detected.termName ? { year: detected.year, termName: detected.termName } : undefined,
      env: detected.env,
      articleId: detected.articleId,
    });
    return;
  }

  const begun = await beginDetected('coop', press, {
    feature: '생협',
    notTarget: '생협 반영 대상 채널이 아닙니다.',
    started: '생협 업데이트를 진행합니다.',
    startedTitle: '생협 업데이트를 진행합니다.',
    checking: '생협 게시글 확인 중',
    checkingNotice: ':hourglass_flowing_sand: 생협 게시글을 확인하고 있습니다…',
  });
  if (!begun) return;
  const { target, articleId, channel, actor, ts } = begun;
  const env = target.env;

  const article = await readArticle(begun, fetchCoopArticle, '생협 게시글 조회 실패');
  if (!article) return;

  const images = collectCoopImages(article.attachments);
  if (images.length === 0) {
    await stopDetected(begun, '생협 이미지 첨부 없음', [
      ':grey_question: *지원하는 이미지 첨부를 찾지 못했습니다.*',
      `<${article.link}|${article.name}>`,
      '공지에 PNG, JPEG, WebP 또는 GIF 이미지를 첨부한 뒤 다시 시도해주세요.',
    ]);
    return;
  }

  const semesterHint = guessCoopSemester(article.title ?? '');

  if (images.length > 1) {
    const token = await saveDetectedCoop({
      env,
      articleId,
      articleTitle: article.name,
      articleUrl: article.link,
      images,
      ...semesterHint,
    });
    await client.chat.update({
      channel,
      ts,
      text: '변환할 생협 이미지를 골라주세요',
      blocks: chooseFileBlocks({
        heading: [
          semesterHint
            ? `:frame_with_picture: *${semesterHint.year} ${semesterHint.termName} 생협 운영시간*`
            : ':frame_with_picture: *생협 운영시간 이미지*',
          `이미지 첨부가 *${images.length}개*입니다. 변환할 파일을 골라주세요.`,
        ],
        files: images,
        actionPrefix: 'coop:detected',
        token,
      }),
    });
    return;
  }

  await runCoopConversion({
    client,
    channel,
    ts,
    actor,
    image: images[0],
    env,
    hint: semesterHint ?? undefined,
    articleId,
  });
}

/** 생협 공지 감지. 등록표는 `blockAction.ts`가 모으기만 한다. */
export const coopDetectedActions: BlockActionSetting[] = COOP_DETECTED_ACTION_IDS.map((actionId) => ({
  actionId,
  async handler({ client, body, action }) {
    await handleCoopDetectedAction(client, body, action);
  },
}));
