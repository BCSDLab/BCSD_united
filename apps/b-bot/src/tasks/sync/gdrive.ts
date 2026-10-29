// Google Drive Docs를 RAG 색인하는 스케줄 태스크. nitro.config.ts scheduledTasks에서 호출.
export default defineTask({
  meta: {
    name: 'sync:gdrive',
    description: '봇 Google 계정의 Google Docs를 RAG document_chunk에 색인',
  },
  async run() {
    const { ingestGdrive } = await import('~/services/rag/gdrive');
    const res = await ingestGdrive();
    console.warn(`[sync:gdrive] docs=${res.docs} changed=${res.changed} chunks=${res.chunks} removed=${res.removed}`);
    return { result: res };
  },
});
