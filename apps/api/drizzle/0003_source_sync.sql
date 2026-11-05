CREATE TABLE native_source_sync_state (
  dataset TEXT PRIMARY KEY CHECK(dataset IN ('dining','articles','lectures','semesters','versions','citybus','weather')),
  checkpoint TEXT NOT NULL DEFAULT '0',
  stage_checkpoint TEXT,
  next_page INTEGER NOT NULL DEFAULT 0,
  staged_rows INTEGER NOT NULL DEFAULT 0,
  stage_final INTEGER NOT NULL DEFAULT 0,
  total_rows INTEGER,
  applied_rows INTEGER NOT NULL DEFAULT 0,
  completed_page INTEGER NOT NULL DEFAULT -1,
  old_max_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE native_source_sync_page (
  dataset TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  page INTEGER NOT NULL,
  body_sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  PRIMARY KEY(dataset,checkpoint,page)
);
CREATE TABLE native_source_sync_row (
  dataset TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(dataset,checkpoint,ordinal)
);
CREATE INDEX native_source_sync_lecture_key ON native_source_sync_row(
  dataset,checkpoint,
  json_extract(payload,'$.semester_date'),
  json_extract(payload,'$.code'),
  json_extract(payload,'$.class')
) WHERE dataset='lectures';
CREATE TABLE native_source_sync_article_gram (
  checkpoint TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  grams TEXT NOT NULL CHECK(json_valid(grams)),
  PRIMARY KEY(checkpoint,ordinal)
);
CREATE TABLE native_source_sync_lecture_match (
  checkpoint TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  lecture_id INTEGER NOT NULL UNIQUE,
  PRIMARY KEY(checkpoint,ordinal)
);
CREATE TABLE native_source_sync_article_match (
  checkpoint TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  article_id INTEGER NOT NULL UNIQUE,
  PRIMARY KEY(checkpoint,ordinal)
);
CREATE TABLE native_source_sync_article_new (
  checkpoint TEXT NOT NULL,
  article_id INTEGER NOT NULL,
  PRIMARY KEY(checkpoint,article_id)
);
CREATE TABLE native_source_article_identity (
  board_id INTEGER NOT NULL,
  portal_num INTEGER NOT NULL,
  article_id INTEGER NOT NULL UNIQUE REFERENCES new_articles(id),
  PRIMARY KEY(board_id,portal_num)
);
INSERT INTO native_source_article_identity(board_id,portal_num,article_id)
SELECT a.board_id,k.portal_num,a.id FROM new_articles a JOIN new_koreatech_articles k ON k.article_id=a.id;
CREATE TABLE native_source_sync_guard (
  valid INTEGER NOT NULL CONSTRAINT native_source_sync_guard CHECK(valid=1)
);
