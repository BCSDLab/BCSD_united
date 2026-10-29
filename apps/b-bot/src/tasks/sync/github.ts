// GitHub README를 RAG 색인하는 스케줄 태스크. nitro.config.ts scheduledTasks에서 호출.
export default defineTask({
  meta: {
    name: 'sync:github',
    description: 'GitHub 공개 레포 README를 RAG document_chunk에 색인',
  },
  async run() {
    const { ingestGithub } = await import('~/services/rag/ingest');
    const res = await ingestGithub();
    console.warn(
      `[sync:github] repos=${res.repos} chunks=${res.chunks}` +
        (res.skipped.length ? ` skipped=${res.skipped.join(',')}` : ''),
    );
    return { result: res };
  },
});
