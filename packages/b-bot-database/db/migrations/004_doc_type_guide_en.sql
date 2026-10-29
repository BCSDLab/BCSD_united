-- 004_doc_type_guide_en.sql
-- C-5 튜닝: guide 분류에 영어 키워드 + 규약 추가(classify.ts와 일치).
-- 데이터 기반 근거: diag로 "코드 컨벤션" 질의 시 'CODING CONVENTION'(영문) 페이지가
-- doc(가중치 0)으로 묻혀 회의 노이즈에 밀림 → guide로 재분류해 상위로.
-- (사람이름 'doc' 노이즈는 실제 top-k를 오염시키지 않아 down-rank 안 함 — 데이터로 확인.)
-- 제목 기반 백필(재임베딩 없음). 기존 'doc' 중 새 guide 규칙에 걸리는 것만.

UPDATE document_chunk
SET doc_type = 'guide'
WHERE doc_type = 'doc'
  AND title ~* '규약|convention|guide|onboarding|architecture|getting\s*started';
