import { answerStream, logQuery } from '~/services/rag';
import type { MessageSetting } from '~/services/slack/types';
import { errorMessage } from '~/utils/errorMessage';

/** `!질문` — 색인한 문서로 답한다(RAG). */
export const messages: MessageSetting[] = [
  {
    regex: /^!질문\s+/,
    async handler({ client, channel, ts, text, user }) {
      const question = text.replace(/^!질문\s+/, '').trim();
      if (!question) return;
      const placeholder = await client.chat.postMessage({
        channel,
        thread_ts: ts,
        text: '🔍 문서를 찾아보는 중이에요…',
      });
      const msgTs = placeholder.ts as string;
      let lastUpdate = 0;
      let partialUpdate = Promise.resolve();
      const startedAt = Date.now();
      try {
        const { text: body, sources } = await answerStream(question, (partial) => {
          const now = Date.now();
          if (!partial || now - lastUpdate < 1500) return; // 슬랙 rate limit 고려(~1.5s)
          lastUpdate = now;
          partialUpdate = partialUpdate
            .then(async () => {
              await client.chat.update({ channel, ts: msgTs, text: partial + ' ▍' });
            })
            .catch(console.error);
        }).finally(() => partialUpdate);
        const sourceText = sources.length
          ? '\n\n📎 출처:\n' +
            sources
              .map((s) => `• ${s.source_url.startsWith('http') ? `<${s.source_url}|${s.title}>` : s.title}`)
              .join('\n')
          : '';
        await client.chat.update({ channel, ts: msgTs, text: `${body}${sourceText}` });
        await logQuery({
          channel,
          msgTs,
          user,
          question,
          answer: body,
          found: sources.length > 0,
          sourceUrls: sources.map((s) => s.source_url),
          latencyMs: Date.now() - startedAt,
        });
        // 한 번 탭으로 피드백하도록 봇이 👍👎 선제공(reaction_added로 만족도 집계)
        await client.reactions.add({ channel, timestamp: msgTs, name: '+1' }).catch(() => {});
        await client.reactions.add({ channel, timestamp: msgTs, name: '-1' }).catch(() => {});
      } catch (error) {
        await client.chat.update({
          channel,
          ts: msgTs,
          text: `검색 중 오류가 발생했어요: ${errorMessage(error, '알 수 없는 오류')}`,
        });
        await logQuery({
          channel,
          msgTs,
          user,
          question,
          answer: '',
          found: false,
          sourceUrls: [],
          latencyMs: Date.now() - startedAt,
        });
      }
    },
  },
];
