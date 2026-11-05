-- V1 staging was never a source of truth. Keep source article identities, but retire
-- full-snapshot staging and start a separate v2 checkpoint/receipt sequence.
DROP TABLE native_source_sync_article_gram;
DROP TABLE native_source_sync_lecture_match;
DROP TABLE native_source_sync_article_match;
DROP TABLE native_source_sync_article_new;
DROP TABLE native_source_sync_row;
DROP TABLE native_source_sync_page;
DROP TABLE native_source_sync_state;
DROP TABLE native_source_sync_guard;

CREATE TABLE native_source_sync_v2_state (
  dataset TEXT PRIMARY KEY CHECK(dataset IN ('dining','articles','lectures','semesters','versions','citybus','weather')),
  checkpoint TEXT NOT NULL,
  next_page INTEGER NOT NULL,
  completed INTEGER NOT NULL CHECK(completed IN (0,1))
);
CREATE TABLE native_source_sync_v2_receipt (
  dataset TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  page INTEGER NOT NULL,
  body_sha256 TEXT NOT NULL,
  applied_rows INTEGER NOT NULL,
  PRIMARY KEY(dataset,checkpoint,page)
);
CREATE TABLE native_source_sync_v2_guard (valid INTEGER NOT NULL CHECK(valid=1));
CREATE TABLE native_source_sync_tombstone (
  board_id INTEGER NOT NULL,
  portal_num INTEGER NOT NULL,
  PRIMARY KEY(board_id,portal_num),
  FOREIGN KEY(board_id,portal_num) REFERENCES native_source_article_identity(board_id,portal_num)
);
CREATE INDEX native_source_sync_portal_key ON new_koreatech_articles(portal_num,article_id);
CREATE INDEX native_source_sync_lecture_reference ON timetable_lecture(lectures_id);
