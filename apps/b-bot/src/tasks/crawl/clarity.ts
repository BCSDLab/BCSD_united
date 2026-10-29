import { WebClient } from '@slack/web-api';
import CHANNEL_ID from '@/constant/CHANNEL_ID.json';
import { sendSlackBlock } from '~/utils/slackFunction';

const CLARITY_DATA_KEY = 'CLARITY_LIST';
const CLARITY_DATA_PREFIX = 'CLARITY_DATA_';

interface ClarityData {
  date: number;
  /**
   * @example { deadClickCount: { "/" : [ 1, 2 ] }
   * "/"에서 두 세션 중 한 번 "빠른 클릭"이 감지됨.
   */
  result: Record<string, [string, [number, number]][]>;
}

export default defineTask({
  meta: {
    name: 'crawl:clarity',
    description: 'Crawl Clarity Data',
  },
  async run() {
    console.warn('Crawl Clarity Data');
    const now = Date.now();
    // https://github.com/nitrojs/nitro/issues/1974
    // Task Hook is not implemented.
    const slackWebClient = new WebClient(process.env.SLACK_BOT_TOKEN);
    try {
      const storage = useStorage('kvStorage');
      const result = await $fetch<Metrics[]>('https://www.clarity.ms/export-data/api/v1/project-live-insights', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.CLARITY_TOKEN}`,
        },
        params: {
          numOfDays: 1,
          dimension1: 'URL',
        },
      });
      const normalizedResult = normalizeMetrics(result);
      const data = await storage.get<number[]>(CLARITY_DATA_KEY);
      await storage.set(CLARITY_DATA_KEY, [...(data ?? []), now]);
      await storage.set(`${CLARITY_DATA_PREFIX}${now}`, {
        date: now,
        result: normalizedResult,
      } satisfies ClarityData);
      // 첫 실행이면 비교할 이전 기록이 없다.
      const previousDate = data?.at(-1);
      const previousData =
        previousDate === undefined
          ? null
          : await storage.get<ClarityData | null>(`${CLARITY_DATA_PREFIX}${previousDate}`);
      if (!previousData) {
        return {
          result: 'success',
        };
      }
      const blocks = createScriptErrorMessageText(
        {
          date: now,
          result: normalizedResult,
        },
        previousData,
      );
      if (blocks.length === 0) {
        return {
          result: 'success',
        };
      }
      await sendSlackBlock({
        client: slackWebClient,
        channel: CHANNEL_ID.코인_오류_front_end,
        blocks,
        unfurlLinks: false,
      });
    } catch (e) {
      console.error(e);
      return {
        result: 'failed',
      };
    }

    return {
      result: 'success',
    };
  },
});

interface Information {
  sessionsCount: number;
  sessionsWithMetricPercentage: number;
  sessionWithoutMetricPercentage: number;
  pagesViews: number;
  subTotal: number;
  Url: string;
}
interface Metrics {
  metricName: string;
  information: Information[];
}

function normalizeMetrics(metrics: Metrics[]): ClarityData['result'] {
  const result: ClarityData['result'] = {};
  for (const metric of metrics) {
    if (metric.metricName === 'DeadClickCount') {
      result.deadClickCount = normalizeInformation(metric.information);
    }

    if (metric.metricName === 'QuickbackClick') {
      result.quickBackCount = normalizeInformation(metric.information);
    }

    if (metric.metricName === 'RageClickCount') {
      result.rageClickCount = normalizeInformation(metric.information);
    }

    if (metric.metricName === 'ScriptErrorCount') {
      result.scriptErrorCount = normalizeInformation(metric.information);
    }
  }
  return result;
}
function normalizeInformation(informations: Information[]) {
  const map = new Map<string, [number, number]>();
  for (const info of informations) {
    const urlInstance = new URL(info.Url);
    const pathname = urlInstance.pathname;
    const count = Number(info.pagesViews);
    const totalSessionCount = Number(info.sessionsCount);
    const previousCount = map.get(pathname) ?? [0, 0];
    map.set(pathname, [previousCount[0] + count, previousCount[1] + totalSessionCount]);
  }

  return Array.from(map.entries()).sort((a, b) => b[1][0] - a[1][0]);
}

function createScriptErrorMessageText(clarityInfo: ClarityData, previousClarityInfo: ClarityData) {
  const { result } = clarityInfo;
  const blocks = [];
  const scriptErrorResult = result.scriptErrorCount;
  for (const scriptErrorCountInfo of scriptErrorResult) {
    const errorCount = scriptErrorCountInfo[1][0];
    if (errorCount === 0) {
      continue;
    }
    const previousErrorCount =
      previousClarityInfo.result.scriptErrorCount.find((info) => info[0] === scriptErrorCountInfo[0])?.[1][0] ?? 0;
    const errorCountDiff = errorCount - previousErrorCount;
    if (errorCountDiff > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*\`${scriptErrorCountInfo[0]}\`*에서 ${errorCountDiff}번이 증가했습니다.\n`,
        },
      });
    }
  }
  if (blocks.length === 0) {
    return [];
  }
  blocks.unshift(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `코인에 새로운 에러가 발생했습니다! 만약 세션을 보고 싶으시다면 관리자를 불러주세요(현 관리자 이름: ${process.env.ADMIN_NAME}).`,
      },
    },
    {
      type: 'divider',
    },
  );
  return blocks;
}
