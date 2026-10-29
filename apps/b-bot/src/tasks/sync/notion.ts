// Notion 공유 페이지를 RAG 색인하는 스케줄 태스크. nitro.config.ts scheduledTasks에서 호출.
export default defineTask({
  meta: {
    name: 'sync:notion',
    description: 'Notion 통합에 공유된 페이지를 RAG document_chunk에 색인',
  },
  async run(ctx) {
    const { ingestNotion } = await import('~/services/rag/notion');
    // payload.full 지정 시 우선(운영 수동 트리거). 없으면 매주 증분, 매월 첫 월요일(날짜<=7)만 full.
    const payloadFull = (ctx as { payload?: { full?: boolean } })?.payload?.full;
    const full = payloadFull ?? new Date().getDate() <= 7;
    const res = await ingestNotion({ full });
    console.warn(
      `[sync:notion] mode=${res.mode} scanned=${res.scanned} docs=${res.docs} chunks=${res.chunks} removed=${res.removed} errors=${res.errors}`,
    );
    return { result: res };
  },
});
