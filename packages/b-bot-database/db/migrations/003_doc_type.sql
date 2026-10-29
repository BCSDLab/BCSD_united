-- 003_doc_type.sql
-- C-5: 지식 타입 메타데이터(OKF 차용). 문서 종류로 검색 재랭킹 → 회의록·재무 노이즈 down-rank.

ALTER TABLE document_chunk
  ADD COLUMN IF NOT EXISTS doc_type   varchar(24),   -- readme|guide|handover|meeting|finance|personal_work|doc
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;   -- 원본 문서 수정일(있으면). 최신성 신호.

CREATE INDEX IF NOT EXISTS idx_document_chunk_doc_type ON document_chunk(doc_type);
