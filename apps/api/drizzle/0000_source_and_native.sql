PRAGMA defer_foreign_keys = ON;

CREATE TABLE "abtest" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "title" TEXT COLLATE NOCASE NOT NULL CHECK (length("title") <= 255),
  "display_title" TEXT COLLATE NOCASE NOT NULL CHECK (length("display_title") <= 255),
  "description" TEXT COLLATE NOCASE CHECK (length("description") <= 255),
  "creator" TEXT COLLATE NOCASE CHECK (length("creator") <= 50),
  "team" TEXT COLLATE NOCASE CHECK (length("team") <= 50),
  "winner_id" INTEGER CHECK ("winner_id" IS NULL OR typeof("winner_id") = 'integer') CHECK ("winner_id" >= 0 AND "winner_id" <= 4294967295),
  "status" TEXT COLLATE NOCASE NOT NULL DEFAULT ('IN_PROGRESS') CHECK (length("status") <= 50),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "FK_ABTEST_ON_WINNER_ID" FOREIGN KEY ("winner_id") REFERENCES "abtest_variable" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "abtest__FK_ABTEST_ON_WINNER_ID_idx" ON "abtest" ("winner_id");

CREATE UNIQUE INDEX "abtest__title_UNIQUE" ON "abtest" ("title");

CREATE TRIGGER "abtest__updated_at_on_update" AFTER UPDATE ON "abtest" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."title" IS NOT OLD."title" OR NEW."display_title" IS NOT OLD."display_title" OR NEW."description" IS NOT OLD."description" OR NEW."creator" IS NOT OLD."creator" OR NEW."team" IS NOT OLD."team" OR NEW."winner_id" IS NOT OLD."winner_id" OR NEW."status" IS NOT OLD."status" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "abtest" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "abtest_variable" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "abtest_id" INTEGER NOT NULL CHECK ("abtest_id" IS NULL OR typeof("abtest_id") = 'integer') CHECK ("abtest_id" >= 0 AND "abtest_id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "display_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("display_name") <= 255),
  "rate" INTEGER NOT NULL CHECK ("rate" IS NULL OR typeof("rate") = 'integer') CHECK ("rate" >= 0 AND "rate" <= 4294967295),
  "count" INTEGER NOT NULL DEFAULT ('0') CHECK ("count" IS NULL OR typeof("count") = 'integer') CHECK ("count" BETWEEN -2147483648 AND 2147483647),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "FK_ABTEST_VARIABLE_ON_ABTEST_ID" FOREIGN KEY ("abtest_id") REFERENCES "abtest" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "abtest_variable__FK_ABTEST_VARIABLE_ON_ABTEST_ID_idx" ON "abtest_variable" ("abtest_id");

CREATE TRIGGER "abtest_variable__updated_at_on_update" AFTER UPDATE ON "abtest_variable" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."abtest_id" IS NOT OLD."abtest_id" OR NEW."name" IS NOT OLD."name" OR NEW."display_name" IS NOT OLD."display_name" OR NEW."rate" IS NOT OLD."rate" OR NEW."count" IS NOT OLD."count" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "abtest_variable" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "academic_program_year" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "student_year" TEXT COLLATE NOCASE NOT NULL CHECK (length("student_year") <= 4),
  "department_id" INTEGER NOT NULL CHECK ("department_id" IS NULL OR typeof("department_id") = 'integer') CHECK ("department_id" >= 0 AND "department_id" <= 4294967295),
  "major_id" INTEGER CHECK ("major_id" IS NULL OR typeof("major_id") = 'integer') CHECK ("major_id" >= 0 AND "major_id" <= 4294967295),
  "major_key" INTEGER GENERATED ALWAYS AS (ifnull(`major_id`,0)) STORED CHECK ("major_key" IS NULL OR typeof("major_key") = 'integer') CHECK ("major_key" >= 0 AND "major_key" <= 4294967295),
  CONSTRAINT "fk_academic_program_year_department" FOREIGN KEY ("department_id") REFERENCES "department" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "fk_academic_program_year_major" FOREIGN KEY ("major_id") REFERENCES "major" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "academic_program_year__fk_academic_program_year_department" ON "academic_program_year" ("department_id");

CREATE INDEX "academic_program_year__idx_academic_program_year_major" ON "academic_program_year" ("major_id");

CREATE UNIQUE INDEX "academic_program_year__ux_academic_program_year" ON "academic_program_year" ("student_year", "department_id", "major_key");

CREATE TABLE "access_history" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "device_id" INTEGER CHECK ("device_id" IS NULL OR typeof("device_id") = 'integer') CHECK ("device_id" >= 0 AND "device_id" <= 4294967295),
  "last_accessed_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "FK_ACCESS_HISTORY_ON_DEVICE_ID" FOREIGN KEY ("device_id") REFERENCES "device" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE INDEX "access_history__FK_ACCESS_HISTORY_ON_DEVICE_ID_idx" ON "access_history" ("device_id");

CREATE TRIGGER "access_history__updated_at_on_update" AFTER UPDATE ON "access_history" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."device_id" IS NOT OLD."device_id" OR NEW."last_accessed_at" IS NOT OLD."last_accessed_at" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "access_history" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "access_history_abtest_variable" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "access_history_id" INTEGER NOT NULL CHECK ("access_history_id" IS NULL OR typeof("access_history_id") = 'integer') CHECK ("access_history_id" >= 0 AND "access_history_id" <= 4294967295),
  "variable_id" INTEGER NOT NULL CHECK ("variable_id" IS NULL OR typeof("variable_id") = 'integer') CHECK ("variable_id" >= 0 AND "variable_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "FK_ACCESS_HISTORY_ABTEST_VARIABLE_ON_ACCESS_HISTORY_ID" FOREIGN KEY ("access_history_id") REFERENCES "access_history" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "FK_ACCESS_HISTORY_ABTEST_VARIABLE_ON_ACCESS_VARIABLE_ID" FOREIGN KEY ("variable_id") REFERENCES "abtest_variable" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "access_history_abtest_variable__FK_ACCESS_HISTORY_ABTEST_VARIABLE_ON_ACCESS_HISTORY_ID_idx" ON "access_history_abtest_variable" ("access_history_id");

CREATE INDEX "access_history_abtest_variable__FK_ACCESS_HISTORY_ABTEST_VARIABLE_ON_ACCESS_VARIABLE_ID_idx" ON "access_history_abtest_variable" ("variable_id");

CREATE TRIGGER "access_history_abtest_variable__updated_at_on_update" AFTER UPDATE ON "access_history_abtest_variable" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."access_history_id" IS NOT OLD."access_history_id" OR NEW."variable_id" IS NOT OLD."variable_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "access_history_abtest_variable" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "activities" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "title" TEXT NOT NULL CHECK (length("title") <= 255),
  "description" TEXT,
  "image_urls" TEXT,
  "date" TEXT NOT NULL,
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "activities__updated_at_on_update" AFTER UPDATE ON "activities" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."title" IS NOT OLD."title" OR NEW."description" IS NOT OLD."description" OR NEW."image_urls" IS NOT OLD."image_urls" OR NEW."date" IS NOT OLD."date" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "activities" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "admins" (
  "user_id" INTEGER PRIMARY KEY NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "team_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("team_type") <= 255),
  "track_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("track_type") <= 255),
  "can_create_admin" INTEGER NOT NULL DEFAULT ('0') CHECK ("can_create_admin" IS NULL OR typeof("can_create_admin") = 'integer') CHECK ("can_create_admin" IN (0, 1)),
  "super_admin" INTEGER NOT NULL DEFAULT ('0') CHECK ("super_admin" IS NULL OR typeof("super_admin") = 'integer') CHECK ("super_admin" IN (0, 1)),
  "login_id" TEXT COLLATE NOCASE NOT NULL CHECK (length("login_id") <= 255),
  "email" TEXT COLLATE NOCASE NOT NULL CHECK (length("email") <= 255),
  CONSTRAINT "FK_ADMIN_ON_USER" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "admins__uq_admin_email" ON "admins" ("email");

CREATE UNIQUE INDEX "admins__uq_admin_login_id" ON "admins" ("login_id");

CREATE TABLE "admins_activity_history" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "domain_id" INTEGER CHECK ("domain_id" IS NULL OR typeof("domain_id") = 'integer') CHECK ("domain_id" >= 0 AND "domain_id" <= 4294967295),
  "admin_id" INTEGER NOT NULL CHECK ("admin_id" IS NULL OR typeof("admin_id") = 'integer') CHECK ("admin_id" >= 0 AND "admin_id" <= 4294967295),
  "request_method" TEXT COLLATE NOCASE NOT NULL CHECK (length("request_method") <= 10),
  "domain_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("domain_name") <= 20),
  "request_message" TEXT COLLATE NOCASE,
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "FK_HISTORY_ON_ADMIN" FOREIGN KEY ("admin_id") REFERENCES "admins" ("user_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "admins_activity_history__FK_HISTORY_ON_ADMIN" ON "admins_activity_history" ("admin_id");

CREATE TRIGGER "admins_activity_history__updated_at_on_update" AFTER UPDATE ON "admins_activity_history" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."domain_id" IS NOT OLD."domain_id" OR NEW."admin_id" IS NOT OLD."admin_id" OR NEW."request_method" IS NOT OLD."request_method" OR NEW."domain_name" IS NOT OLD."domain_name" OR NEW."request_message" IS NOT OLD."request_message" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "admins_activity_history" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "article_ai_summaries" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" >= 0 AND "article_id" <= 4294967295),
  "status" TEXT COLLATE NOCASE NOT NULL DEFAULT ('WAIT') CHECK (length("status") <= 20),
  "summary_content" TEXT COLLATE NOCASE,
  "summarized_at" TEXT,
  "source_fingerprint" TEXT COLLATE NOCASE CHECK (length("source_fingerprint") <= 64),
  "source_updated_at" TEXT,
  "model" TEXT COLLATE NOCASE CHECK (length("model") <= 100),
  "prompt_version" TEXT COLLATE NOCASE CHECK (length("prompt_version") <= 20),
  "retry_count" INTEGER NOT NULL DEFAULT ('0') CHECK ("retry_count" IS NULL OR typeof("retry_count") = 'integer') CHECK ("retry_count" >= 0 AND "retry_count" <= 4294967295),
  "next_attempt_at" TEXT,
  "locked_until" TEXT,
  "worker_id" TEXT COLLATE NOCASE CHECK (length("worker_id") <= 100),
  "failure_reason" TEXT COLLATE NOCASE CHECK (length("failure_reason") <= 500),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_article_ai_summaries_article_id" FOREIGN KEY ("article_id") REFERENCES "new_articles" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "article_ai_summaries__idx_article_ai_summaries_claim" ON "article_ai_summaries" ("status", "retry_count", "next_attempt_at", "locked_until", "updated_at");

CREATE INDEX "article_ai_summaries__idx_article_ai_summaries_summarized_at" ON "article_ai_summaries" ("summarized_at");

CREATE INDEX "article_ai_summaries__idx_article_ai_summaries_wait_claim" ON "article_ai_summaries" ("status", "next_attempt_at", "locked_until", "updated_at");

CREATE UNIQUE INDEX "article_ai_summaries__uk_article_ai_summaries_article_id" ON "article_ai_summaries" ("article_id");

CREATE TRIGGER "article_ai_summaries__updated_at_on_update" AFTER UPDATE ON "article_ai_summaries" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."article_id" IS NOT OLD."article_id" OR NEW."status" IS NOT OLD."status" OR NEW."summary_content" IS NOT OLD."summary_content" OR NEW."summarized_at" IS NOT OLD."summarized_at" OR NEW."source_fingerprint" IS NOT OLD."source_fingerprint" OR NEW."source_updated_at" IS NOT OLD."source_updated_at" OR NEW."model" IS NOT OLD."model" OR NEW."prompt_version" IS NOT OLD."prompt_version" OR NEW."retry_count" IS NOT OLD."retry_count" OR NEW."next_attempt_at" IS NOT OLD."next_attempt_at" OR NEW."locked_until" IS NOT OLD."locked_until" OR NEW."worker_id" IS NOT OLD."worker_id" OR NEW."failure_reason" IS NOT OLD."failure_reason" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "article_ai_summaries" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "article_ai_summary_logs" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "summary_id" INTEGER CHECK ("summary_id" IS NULL OR typeof("summary_id") = 'integer') CHECK ("summary_id" >= 0 AND "summary_id" <= 4294967295),
  "article_id" INTEGER CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" >= 0 AND "article_id" <= 4294967295),
  "board_id" INTEGER CHECK ("board_id" IS NULL OR typeof("board_id") = 'integer') CHECK ("board_id" >= 0 AND "board_id" <= 4294967295),
  "event_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("event_type") <= 30),
  "status" TEXT COLLATE NOCASE CHECK (length("status") <= 20),
  "failure_type" TEXT COLLATE NOCASE CHECK (length("failure_type") <= 50),
  "message" TEXT COLLATE NOCASE CHECK (length("message") <= 500),
  "retry_count" INTEGER CHECK ("retry_count" IS NULL OR typeof("retry_count") = 'integer') CHECK ("retry_count" >= 0 AND "retry_count" <= 4294967295),
  "next_attempt_at" TEXT,
  "worker_id" TEXT COLLATE NOCASE CHECK (length("worker_id") <= 100),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_article_ai_summary_logs_summary_id" FOREIGN KEY ("summary_id") REFERENCES "article_ai_summaries" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE INDEX "article_ai_summary_logs__idx_article_ai_summary_logs_article_created" ON "article_ai_summary_logs" ("article_id", "created_at");

CREATE INDEX "article_ai_summary_logs__idx_article_ai_summary_logs_created_at" ON "article_ai_summary_logs" ("created_at");

CREATE INDEX "article_ai_summary_logs__idx_article_ai_summary_logs_summary_created" ON "article_ai_summary_logs" ("summary_id", "created_at");

CREATE INDEX "article_ai_summary_logs__idx_article_ai_summary_logs_type_created" ON "article_ai_summary_logs" ("event_type", "failure_type", "created_at");

CREATE TRIGGER "article_ai_summary_logs__updated_at_on_update" AFTER UPDATE ON "article_ai_summary_logs" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."summary_id" IS NOT OLD."summary_id" OR NEW."article_id" IS NOT OLD."article_id" OR NEW."board_id" IS NOT OLD."board_id" OR NEW."event_type" IS NOT OLD."event_type" OR NEW."status" IS NOT OLD."status" OR NEW."failure_type" IS NOT OLD."failure_type" OR NEW."message" IS NOT OLD."message" OR NEW."retry_count" IS NOT OLD."retry_count" OR NEW."next_attempt_at" IS NOT OLD."next_attempt_at" OR NEW."worker_id" IS NOT OLD."worker_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "article_ai_summary_logs" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "article_attachments" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" >= 0 AND "article_id" <= 4294967295),
  "hash" BLOB NOT NULL CHECK ("hash" IS NULL OR (typeof("hash") = 'blob' AND length("hash") = 32)),
  "url" TEXT COLLATE NOCASE NOT NULL,
  "name" TEXT COLLATE NOCASE NOT NULL,
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "article_attachments__FK_ARTICLE_ATTACHMENTS_ON_ARTICLE_ID_idx" ON "article_attachments" ("article_id");

CREATE UNIQUE INDEX "article_attachments__ux_article_attachment" ON "article_attachments" ("article_id", "hash");

CREATE TRIGGER "article_attachments__updated_at_on_update" AFTER UPDATE ON "article_attachments" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."article_id" IS NOT OLD."article_id" OR NEW."hash" IS NOT OLD."hash" OR NEW."url" IS NOT OLD."url" OR NEW."name" IS NOT OLD."name" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "article_attachments" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "article_keyword_user_map" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "keyword_id" INTEGER NOT NULL CHECK ("keyword_id" IS NULL OR typeof("keyword_id") = 'integer') CHECK ("keyword_id" >= 0 AND "keyword_id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  CONSTRAINT "article_keyword_user_map_ibfk_1" FOREIGN KEY ("keyword_id") REFERENCES "article_keywords" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "article_keyword_user_map_ibfk_2" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "article_keyword_user_map__uk_keyword_user" ON "article_keyword_user_map" ("keyword_id", "user_id");

CREATE INDEX "article_keyword_user_map__user_id" ON "article_keyword_user_map" ("user_id");

CREATE TRIGGER "article_keyword_user_map__updated_at_on_update" AFTER UPDATE ON "article_keyword_user_map" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."keyword_id" IS NOT OLD."keyword_id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."is_deleted" IS NOT OLD."is_deleted") BEGIN UPDATE "article_keyword_user_map" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "article_keywords" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "keyword" TEXT COLLATE NOCASE NOT NULL CHECK (length("keyword") <= 50),
  "category" TEXT COLLATE NOCASE NOT NULL DEFAULT ('KOREATECH') CHECK (length("category") <= 20),
  "last_used_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "is_filtered" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_filtered" IS NULL OR typeof("is_filtered") = 'integer') CHECK ("is_filtered" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1))
);

CREATE UNIQUE INDEX "article_keywords__uk_article_keywords_keyword_category" ON "article_keywords" ("keyword", "category");

CREATE TRIGGER "article_keywords__updated_at_on_update" AFTER UPDATE ON "article_keywords" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."keyword" IS NOT OLD."keyword" OR NEW."category" IS NOT OLD."category" OR NEW."last_used_at" IS NOT OLD."last_used_at" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."is_filtered" IS NOT OLD."is_filtered" OR NEW."is_deleted" IS NOT OLD."is_deleted") BEGIN UPDATE "article_keywords" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "article_search_keyword_ip_map" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "keyword_id" INTEGER NOT NULL CHECK ("keyword_id" IS NULL OR typeof("keyword_id") = 'integer') CHECK ("keyword_id" >= 0 AND "keyword_id" <= 4294967295),
  "ip_address" TEXT COLLATE NOCASE NOT NULL CHECK (length("ip_address") <= 45),
  "search_count" INTEGER NOT NULL DEFAULT ('1') CHECK ("search_count" IS NULL OR typeof("search_count") = 'integer') CHECK ("search_count" >= 0 AND "search_count" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "article_search_keyword_ip_map_ibfk_1" FOREIGN KEY ("keyword_id") REFERENCES "article_search_keywords" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "fk_keyword_id" FOREIGN KEY ("keyword_id") REFERENCES "article_search_keywords" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "article_search_keyword_ip_map__idx_ip_address" ON "article_search_keyword_ip_map" ("ip_address");

CREATE UNIQUE INDEX "article_search_keyword_ip_map__unique_keyword_ip" ON "article_search_keyword_ip_map" ("keyword_id", "ip_address");

CREATE TRIGGER "article_search_keyword_ip_map__updated_at_on_update" AFTER UPDATE ON "article_search_keyword_ip_map" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."keyword_id" IS NOT OLD."keyword_id" OR NEW."ip_address" IS NOT OLD."ip_address" OR NEW."search_count" IS NOT OLD."search_count" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "article_search_keyword_ip_map" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "article_search_keywords" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "keyword" TEXT COLLATE NOCASE NOT NULL CHECK (length("keyword") <= 255),
  "weight" REAL NOT NULL DEFAULT ('1') CHECK ("weight" IS NULL OR typeof("weight") IN ('real','integer')),
  "last_searched_at" TEXT,
  "total_searches" INTEGER NOT NULL DEFAULT ('0') CHECK ("total_searches" IS NULL OR typeof("total_searches") = 'integer') CHECK ("total_searches" >= 0 AND "total_searches" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "article_search_keywords__idx_keyword" ON "article_search_keywords" ("keyword");

CREATE INDEX "article_search_keywords__idx_last_searched_at" ON "article_search_keywords" ("last_searched_at");

CREATE UNIQUE INDEX "article_search_keywords__keyword" ON "article_search_keywords" ("keyword");

CREATE TRIGGER "article_search_keywords__updated_at_on_update" AFTER UPDATE ON "article_search_keywords" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."keyword" IS NOT OLD."keyword" OR NEW."weight" IS NOT OLD."weight" OR NEW."last_searched_at" IS NOT OLD."last_searched_at" OR NEW."total_searches" IS NOT OLD."total_searches" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "article_search_keywords" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "article_view_logs" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" >= 0 AND "article_id" <= 4294967295),
  "user_id" INTEGER CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "expired_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "ip" TEXT COLLATE NOCASE NOT NULL CHECK (length("ip") <= 45)
);

CREATE UNIQUE INDEX "article_view_logs__article_view_logs_article_id_user_id_unique" ON "article_view_logs" ("article_id", "user_id");

CREATE TRIGGER "article_view_logs__expired_at_on_update" AFTER UPDATE ON "article_view_logs" WHEN NEW."expired_at" IS OLD."expired_at" AND (NEW."id" IS NOT OLD."id" OR NEW."article_id" IS NOT OLD."article_id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."ip" IS NOT OLD."ip") BEGIN UPDATE "article_view_logs" SET "expired_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "banner_categories" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "description" TEXT COLLATE NOCASE NOT NULL CHECK (length("description") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "banner_categories__updated_at_on_update" AFTER UPDATE ON "banner_categories" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."name" IS NOT OLD."name" OR NEW."description" IS NOT OLD."description" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "banner_categories" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "banners" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "title" TEXT COLLATE NOCASE NOT NULL CHECK (length("title") <= 255),
  "banner_category_id" INTEGER NOT NULL CHECK ("banner_category_id" IS NULL OR typeof("banner_category_id") = 'integer') CHECK ("banner_category_id" >= 0 AND "banner_category_id" <= 4294967295),
  "priority" INTEGER CHECK ("priority" IS NULL OR typeof("priority") = 'integer') CHECK ("priority" >= 0 AND "priority" <= 4294967295),
  "image_url" TEXT COLLATE NOCASE NOT NULL CHECK (length("image_url") <= 255),
  "web_redirect_link" TEXT COLLATE NOCASE CHECK (length("web_redirect_link") <= 255),
  "android_redirect_link" TEXT COLLATE NOCASE CHECK (length("android_redirect_link") <= 255),
  "android_minimum_version" TEXT COLLATE NOCASE CHECK (length("android_minimum_version") <= 50),
  "ios_redirect_link" TEXT COLLATE NOCASE CHECK (length("ios_redirect_link") <= 255),
  "ios_minimum_version" TEXT COLLATE NOCASE CHECK (length("ios_minimum_version") <= 50),
  "is_active" INTEGER NOT NULL CHECK ("is_active" IS NULL OR typeof("is_active") = 'integer') CHECK ("is_active" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "is_web_released" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_web_released" IS NULL OR typeof("is_web_released") = 'integer') CHECK ("is_web_released" IN (0, 1)),
  "is_android_released" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_android_released" IS NULL OR typeof("is_android_released") = 'integer') CHECK ("is_android_released" IN (0, 1)),
  "is_ios_released" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_ios_released" IS NULL OR typeof("is_ios_released") = 'integer') CHECK ("is_ios_released" IN (0, 1)),
  CONSTRAINT "banners_ibfk_1" FOREIGN KEY ("banner_category_id") REFERENCES "banner_categories" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "banners__banner_category_id" ON "banners" ("banner_category_id");

CREATE TRIGGER "banners__updated_at_on_update" AFTER UPDATE ON "banners" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."title" IS NOT OLD."title" OR NEW."banner_category_id" IS NOT OLD."banner_category_id" OR NEW."priority" IS NOT OLD."priority" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."web_redirect_link" IS NOT OLD."web_redirect_link" OR NEW."android_redirect_link" IS NOT OLD."android_redirect_link" OR NEW."android_minimum_version" IS NOT OLD."android_minimum_version" OR NEW."ios_redirect_link" IS NOT OLD."ios_redirect_link" OR NEW."ios_minimum_version" IS NOT OLD."ios_minimum_version" OR NEW."is_active" IS NOT OLD."is_active" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."is_web_released" IS NOT OLD."is_web_released" OR NEW."is_android_released" IS NOT OLD."is_android_released" OR NEW."is_ios_released" IS NOT OLD."is_ios_released") BEGIN UPDATE "banners" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "boards" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 50),
  "is_anonymous" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_anonymous" IS NULL OR typeof("is_anonymous") = 'integer') CHECK ("is_anonymous" IN (0, 1)),
  "article_count" INTEGER NOT NULL DEFAULT ('0') CHECK ("article_count" IS NULL OR typeof("article_count") = 'integer') CHECK ("article_count" >= 0 AND "article_count" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "is_notice" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_notice" IS NULL OR typeof("is_notice") = 'integer') CHECK ("is_notice" IN (0, 1)),
  "parent_id" INTEGER CHECK ("parent_id" IS NULL OR typeof("parent_id") = 'integer') CHECK ("parent_id" >= 0 AND "parent_id" <= 4294967295)
);

CREATE TRIGGER "boards__updated_at_on_update" AFTER UPDATE ON "boards" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."name" IS NOT OLD."name" OR NEW."is_anonymous" IS NOT OLD."is_anonymous" OR NEW."article_count" IS NOT OLD."article_count" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."is_notice" IS NOT OLD."is_notice" OR NEW."parent_id" IS NOT OLD."parent_id") BEGIN UPDATE "boards" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "callvan_chat_message" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -2147483648 AND 2147483647),
  "callvan_chat_room_id" INTEGER NOT NULL CHECK ("callvan_chat_room_id" IS NULL OR typeof("callvan_chat_room_id") = 'integer') CHECK ("callvan_chat_room_id" BETWEEN -2147483648 AND 2147483647),
  "sender_id" INTEGER NOT NULL CHECK ("sender_id" IS NULL OR typeof("sender_id") = 'integer') CHECK ("sender_id" BETWEEN -2147483648 AND 2147483647),
  "sender_nickname" TEXT COLLATE NOCASE NOT NULL CHECK (length("sender_nickname") <= 50),
  "message_type" TEXT COLLATE NOCASE NOT NULL DEFAULT ('TEXT') CHECK (length("message_type") <= 20),
  "content" TEXT COLLATE NOCASE,
  "is_image" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_image" IS NULL OR typeof("is_image") = 'integer') CHECK ("is_image" IN (0, 1)),
  "is_left_user" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_left_user" IS NULL OR typeof("is_left_user") = 'integer') CHECK ("is_left_user" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "callvan_chat_message__idx_chat_message_room_created" ON "callvan_chat_message" ("callvan_chat_room_id", "created_at");

CREATE TRIGGER "callvan_chat_message__updated_at_on_update" AFTER UPDATE ON "callvan_chat_message" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."callvan_chat_room_id" IS NOT OLD."callvan_chat_room_id" OR NEW."sender_id" IS NOT OLD."sender_id" OR NEW."sender_nickname" IS NOT OLD."sender_nickname" OR NEW."message_type" IS NOT OLD."message_type" OR NEW."content" IS NOT OLD."content" OR NEW."is_image" IS NOT OLD."is_image" OR NEW."is_left_user" IS NOT OLD."is_left_user" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "callvan_chat_message" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "callvan_chat_room" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -2147483648 AND 2147483647),
  "callvan_post_id" INTEGER NOT NULL CHECK ("callvan_post_id" IS NULL OR typeof("callvan_post_id") = 'integer') CHECK ("callvan_post_id" BETWEEN -2147483648 AND 2147483647),
  "room_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("room_name") <= 100),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX "callvan_chat_room__callvan_post_id" ON "callvan_chat_room" ("callvan_post_id");

CREATE TRIGGER "callvan_chat_room__updated_at_on_update" AFTER UPDATE ON "callvan_chat_room" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."callvan_post_id" IS NOT OLD."callvan_post_id" OR NEW."room_name" IS NOT OLD."room_name" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "callvan_chat_room" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "callvan_notification" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -2147483648 AND 2147483647),
  "recipient_id" INTEGER NOT NULL CHECK ("recipient_id" IS NULL OR typeof("recipient_id") = 'integer') CHECK ("recipient_id" BETWEEN -2147483648 AND 2147483647),
  "notification_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("notification_type") <= 30),
  "callvan_post_id" INTEGER CHECK ("callvan_post_id" IS NULL OR typeof("callvan_post_id") = 'integer') CHECK ("callvan_post_id" BETWEEN -2147483648 AND 2147483647),
  "departure_type" TEXT COLLATE NOCASE CHECK (length("departure_type") <= 20),
  "departure_custom_name" TEXT COLLATE NOCASE CHECK (length("departure_custom_name") <= 50),
  "arrival_type" TEXT COLLATE NOCASE CHECK (length("arrival_type") <= 20),
  "arrival_custom_name" TEXT COLLATE NOCASE CHECK (length("arrival_custom_name") <= 50),
  "departure_date" TEXT,
  "departure_time" TEXT,
  "current_participants" INTEGER CHECK ("current_participants" IS NULL OR typeof("current_participants") = 'integer') CHECK ("current_participants" BETWEEN -2147483648 AND 2147483647),
  "max_participants" INTEGER CHECK ("max_participants" IS NULL OR typeof("max_participants") = 'integer') CHECK ("max_participants" BETWEEN -2147483648 AND 2147483647),
  "sender_nickname" TEXT COLLATE NOCASE CHECK (length("sender_nickname") <= 50),
  "message_preview" TEXT COLLATE NOCASE CHECK (length("message_preview") <= 100),
  "callvan_chat_room_id" INTEGER CHECK ("callvan_chat_room_id" IS NULL OR typeof("callvan_chat_room_id") = 'integer') CHECK ("callvan_chat_room_id" BETWEEN -2147483648 AND 2147483647),
  "joined_member_nickname" TEXT COLLATE NOCASE CHECK (length("joined_member_nickname") <= 50),
  "is_read" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_read" IS NULL OR typeof("is_read") = 'integer') CHECK ("is_read" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "callvan_notification__idx_notification_recipient_read" ON "callvan_notification" ("recipient_id", "is_read");

CREATE TRIGGER "callvan_notification__updated_at_on_update" AFTER UPDATE ON "callvan_notification" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."recipient_id" IS NOT OLD."recipient_id" OR NEW."notification_type" IS NOT OLD."notification_type" OR NEW."callvan_post_id" IS NOT OLD."callvan_post_id" OR NEW."departure_type" IS NOT OLD."departure_type" OR NEW."departure_custom_name" IS NOT OLD."departure_custom_name" OR NEW."arrival_type" IS NOT OLD."arrival_type" OR NEW."arrival_custom_name" IS NOT OLD."arrival_custom_name" OR NEW."departure_date" IS NOT OLD."departure_date" OR NEW."departure_time" IS NOT OLD."departure_time" OR NEW."current_participants" IS NOT OLD."current_participants" OR NEW."max_participants" IS NOT OLD."max_participants" OR NEW."sender_nickname" IS NOT OLD."sender_nickname" OR NEW."message_preview" IS NOT OLD."message_preview" OR NEW."callvan_chat_room_id" IS NOT OLD."callvan_chat_room_id" OR NEW."joined_member_nickname" IS NOT OLD."joined_member_nickname" OR NEW."is_read" IS NOT OLD."is_read" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "callvan_notification" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "callvan_participant" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -2147483648 AND 2147483647),
  "post_id" INTEGER NOT NULL CHECK ("post_id" IS NULL OR typeof("post_id") = 'integer') CHECK ("post_id" BETWEEN -2147483648 AND 2147483647),
  "member_id" INTEGER NOT NULL CHECK ("member_id" IS NULL OR typeof("member_id") = 'integer') CHECK ("member_id" BETWEEN -2147483648 AND 2147483647),
  "role" TEXT COLLATE NOCASE NOT NULL DEFAULT ('PARTICIPANT') CHECK (length("role") <= 20),
  "joined_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "callvan_participant__idx_participant_member_id" ON "callvan_participant" ("member_id");

CREATE INDEX "callvan_participant__idx_participant_post_id" ON "callvan_participant" ("post_id");

CREATE UNIQUE INDEX "callvan_participant__uk_participant_post_member" ON "callvan_participant" ("post_id", "member_id");

CREATE TRIGGER "callvan_participant__updated_at_on_update" AFTER UPDATE ON "callvan_participant" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."post_id" IS NOT OLD."post_id" OR NEW."member_id" IS NOT OLD."member_id" OR NEW."role" IS NOT OLD."role" OR NEW."joined_at" IS NOT OLD."joined_at" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "callvan_participant" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "callvan_post" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -2147483648 AND 2147483647),
  "author_id" INTEGER NOT NULL CHECK ("author_id" IS NULL OR typeof("author_id") = 'integer') CHECK ("author_id" BETWEEN -2147483648 AND 2147483647),
  "title" TEXT COLLATE NOCASE NOT NULL CHECK (length("title") <= 100),
  "departure_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("departure_type") <= 20),
  "departure_custom_name" TEXT COLLATE NOCASE CHECK (length("departure_custom_name") <= 50),
  "arrival_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("arrival_type") <= 20),
  "arrival_custom_name" TEXT COLLATE NOCASE CHECK (length("arrival_custom_name") <= 50),
  "departure_date" TEXT NOT NULL,
  "departure_time" TEXT NOT NULL,
  "max_participants" INTEGER NOT NULL CHECK ("max_participants" IS NULL OR typeof("max_participants") = 'integer') CHECK ("max_participants" BETWEEN -2147483648 AND 2147483647),
  "current_participants" INTEGER NOT NULL DEFAULT ('1') CHECK ("current_participants" IS NULL OR typeof("current_participants") = 'integer') CHECK ("current_participants" BETWEEN -2147483648 AND 2147483647),
  "status" TEXT COLLATE NOCASE NOT NULL DEFAULT ('RECRUITING') CHECK (length("status") <= 20),
  "chat_room_id" INTEGER CHECK ("chat_room_id" IS NULL OR typeof("chat_room_id") = 'integer') CHECK ("chat_room_id" BETWEEN -2147483648 AND 2147483647),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "callvan_post__idx_callvan_post_arrival_type" ON "callvan_post" ("arrival_type");

CREATE INDEX "callvan_post__idx_callvan_post_author_id" ON "callvan_post" ("author_id");

CREATE INDEX "callvan_post__idx_callvan_post_departure_date_time" ON "callvan_post" ("departure_date", "departure_time");

CREATE INDEX "callvan_post__idx_callvan_post_departure_type" ON "callvan_post" ("departure_type");

CREATE INDEX "callvan_post__idx_callvan_post_filter_composite" ON "callvan_post" ("status", "departure_date", "departure_time");

CREATE INDEX "callvan_post__idx_callvan_post_location_composite" ON "callvan_post" ("departure_type", "arrival_type", "status");

CREATE INDEX "callvan_post__idx_callvan_post_status" ON "callvan_post" ("status");

CREATE TRIGGER "callvan_post__updated_at_on_update" AFTER UPDATE ON "callvan_post" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."author_id" IS NOT OLD."author_id" OR NEW."title" IS NOT OLD."title" OR NEW."departure_type" IS NOT OLD."departure_type" OR NEW."departure_custom_name" IS NOT OLD."departure_custom_name" OR NEW."arrival_type" IS NOT OLD."arrival_type" OR NEW."arrival_custom_name" IS NOT OLD."arrival_custom_name" OR NEW."departure_date" IS NOT OLD."departure_date" OR NEW."departure_time" IS NOT OLD."departure_time" OR NEW."max_participants" IS NOT OLD."max_participants" OR NEW."current_participants" IS NOT OLD."current_participants" OR NEW."status" IS NOT OLD."status" OR NEW."chat_room_id" IS NOT OLD."chat_room_id" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "callvan_post" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "callvan_report" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -2147483648 AND 2147483647),
  "callvan_post_id" INTEGER CHECK ("callvan_post_id" IS NULL OR typeof("callvan_post_id") = 'integer') CHECK ("callvan_post_id" BETWEEN -2147483648 AND 2147483647),
  "reporter_id" INTEGER NOT NULL CHECK ("reporter_id" IS NULL OR typeof("reporter_id") = 'integer') CHECK ("reporter_id" BETWEEN -2147483648 AND 2147483647),
  "reported_id" INTEGER NOT NULL CHECK ("reported_id" IS NULL OR typeof("reported_id") = 'integer') CHECK ("reported_id" BETWEEN -2147483648 AND 2147483647),
  "description" TEXT COLLATE NOCASE,
  "status" TEXT COLLATE NOCASE NOT NULL DEFAULT ('PENDING') CHECK (length("status") <= 20),
  "reviewer_id" INTEGER CHECK ("reviewer_id" IS NULL OR typeof("reviewer_id") = 'integer') CHECK ("reviewer_id" BETWEEN -2147483648 AND 2147483647),
  "review_note" TEXT COLLATE NOCASE CHECK (length("review_note") <= 500),
  "reviewed_at" TEXT,
  "confirmed_at" TEXT,
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "callvan_report__idx_callvan_report_post" ON "callvan_report" ("callvan_post_id");

CREATE INDEX "callvan_report__idx_callvan_report_reported_status" ON "callvan_report" ("reported_id", "status", "confirmed_at");

CREATE INDEX "callvan_report__idx_callvan_report_reporter_created" ON "callvan_report" ("reporter_id", "created_at");

CREATE INDEX "callvan_report__idx_callvan_report_status_created" ON "callvan_report" ("status", "created_at");

CREATE TRIGGER "callvan_report__updated_at_on_update" AFTER UPDATE ON "callvan_report" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."callvan_post_id" IS NOT OLD."callvan_post_id" OR NEW."reporter_id" IS NOT OLD."reporter_id" OR NEW."reported_id" IS NOT OLD."reported_id" OR NEW."description" IS NOT OLD."description" OR NEW."status" IS NOT OLD."status" OR NEW."reviewer_id" IS NOT OLD."reviewer_id" OR NEW."review_note" IS NOT OLD."review_note" OR NEW."reviewed_at" IS NOT OLD."reviewed_at" OR NEW."confirmed_at" IS NOT OLD."confirmed_at" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "callvan_report" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "callvan_report_attachment" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -2147483648 AND 2147483647),
  "report_id" INTEGER NOT NULL CHECK ("report_id" IS NULL OR typeof("report_id") = 'integer') CHECK ("report_id" BETWEEN -2147483648 AND 2147483647),
  "attachment_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("attachment_type") <= 30),
  "url" TEXT COLLATE NOCASE NOT NULL CHECK (length("url") <= 500),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "callvan_report_attachment__idx_report_attachment_report" ON "callvan_report_attachment" ("report_id", "is_deleted");

CREATE TRIGGER "callvan_report_attachment__updated_at_on_update" AFTER UPDATE ON "callvan_report_attachment" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."report_id" IS NOT OLD."report_id" OR NEW."attachment_type" IS NOT OLD."attachment_type" OR NEW."url" IS NOT OLD."url" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "callvan_report_attachment" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "callvan_report_process" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -2147483648 AND 2147483647),
  "report_id" INTEGER NOT NULL CHECK ("report_id" IS NULL OR typeof("report_id") = 'integer') CHECK ("report_id" BETWEEN -2147483648 AND 2147483647),
  "processor_id" INTEGER NOT NULL CHECK ("processor_id" IS NULL OR typeof("processor_id") = 'integer') CHECK ("processor_id" BETWEEN -2147483648 AND 2147483647),
  "process_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("process_type") <= 50),
  "restricted_until" TEXT,
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "callvan_report_process__idx_callvan_report_process_processor" ON "callvan_report_process" ("processor_id", "is_deleted");

CREATE INDEX "callvan_report_process__idx_callvan_report_process_report" ON "callvan_report_process" ("report_id", "is_deleted");

CREATE INDEX "callvan_report_process__idx_callvan_report_process_type_until" ON "callvan_report_process" ("process_type", "restricted_until", "is_deleted");

CREATE TRIGGER "callvan_report_process__updated_at_on_update" AFTER UPDATE ON "callvan_report_process" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."report_id" IS NOT OLD."report_id" OR NEW."processor_id" IS NOT OLD."processor_id" OR NEW."process_type" IS NOT OLD."process_type" OR NEW."restricted_until" IS NOT OLD."restricted_until" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "callvan_report_process" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "callvan_report_reason" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -2147483648 AND 2147483647),
  "report_id" INTEGER NOT NULL CHECK ("report_id" IS NULL OR typeof("report_id") = 'integer') CHECK ("report_id" BETWEEN -2147483648 AND 2147483647),
  "reason_code" TEXT COLLATE NOCASE NOT NULL CHECK (length("reason_code") <= 30),
  "custom_text" TEXT COLLATE NOCASE CHECK (length("custom_text") <= 200),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "callvan_report_reason__idx_report_reason_code" ON "callvan_report_reason" ("reason_code");

CREATE INDEX "callvan_report_reason__idx_report_reason_report" ON "callvan_report_reason" ("report_id");

CREATE TRIGGER "callvan_report_reason__updated_at_on_update" AFTER UPDATE ON "callvan_report_reason" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."report_id" IS NOT OLD."report_id" OR NEW."reason_code" IS NOT OLD."reason_code" OR NEW."custom_text" IS NOT OLD."custom_text" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "callvan_report_reason" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "campus_delivery_address" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "campus_address_type_id" INTEGER NOT NULL CHECK ("campus_address_type_id" IS NULL OR typeof("campus_address_type_id") = 'integer') CHECK ("campus_address_type_id" >= 0 AND "campus_address_type_id" <= 4294967295),
  "full_address" TEXT COLLATE NOCASE NOT NULL CHECK (length("full_address") <= 255),
  "short_address" TEXT COLLATE NOCASE NOT NULL CHECK (length("short_address") <= 50),
  "latitude" TEXT CHECK (ltrim("latitude", '-') GLOB '*[0-9]*' AND ltrim("latitude", '-') NOT GLOB '*[^0-9.]*' AND length("latitude") - length(replace("latitude", '-', '')) <= 1 AND length("latitude") - length(replace("latitude", '.', '')) <= 1 AND abs(CAST("latitude" AS REAL)) < 100 AND (instr("latitude", '.') = 0 OR length("latitude") - instr("latitude", '.') <= 8)),
  "longitude" TEXT CHECK (ltrim("longitude", '-') GLOB '*[0-9]*' AND ltrim("longitude", '-') NOT GLOB '*[^0-9.]*' AND length("longitude") - length(replace("longitude", '-', '')) <= 1 AND length("longitude") - length(replace("longitude", '.', '')) <= 1 AND abs(CAST("longitude" AS REAL)) < 1000 AND (instr("longitude", '.') = 0 OR length("longitude") - instr("longitude", '.') <= 8)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "address" TEXT COLLATE NOCASE
);

CREATE INDEX "campus_delivery_address__idx_campus_delivery_address" ON "campus_delivery_address" ("campus_address_type_id");

CREATE TRIGGER "campus_delivery_address__updated_at_on_update" AFTER UPDATE ON "campus_delivery_address" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."campus_address_type_id" IS NOT OLD."campus_address_type_id" OR NEW."full_address" IS NOT OLD."full_address" OR NEW."short_address" IS NOT OLD."short_address" OR NEW."latitude" IS NOT OLD."latitude" OR NEW."longitude" IS NOT OLD."longitude" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."address" IS NOT OLD."address") BEGIN UPDATE "campus_delivery_address" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "campus_delivery_address_type" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "campus_delivery_address_type__updated_at_on_update" AFTER UPDATE ON "campus_delivery_address_type" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."name" IS NOT OLD."name" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "campus_delivery_address_type" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "cart" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "orderable_shop_id" INTEGER NOT NULL CHECK ("orderable_shop_id" IS NULL OR typeof("orderable_shop_id") = 'integer') CHECK ("orderable_shop_id" >= 0 AND "orderable_shop_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "cart__idx_orderable_shop_id" ON "cart" ("orderable_shop_id");

CREATE INDEX "cart__idx_user_id_orderable_shop_id" ON "cart" ("user_id", "orderable_shop_id");

CREATE UNIQUE INDEX "cart__uk_user_orderable_shop" ON "cart" ("user_id", "orderable_shop_id");

CREATE TRIGGER "cart__updated_at_on_update" AFTER UPDATE ON "cart" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."orderable_shop_id" IS NOT OLD."orderable_shop_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "cart" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "cart_menu_item" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "cart_id" INTEGER NOT NULL CHECK ("cart_id" IS NULL OR typeof("cart_id") = 'integer') CHECK ("cart_id" >= 0 AND "cart_id" <= 4294967295),
  "orderable_shop_menu_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_id" IS NULL OR typeof("orderable_shop_menu_id") = 'integer') CHECK ("orderable_shop_menu_id" >= 0 AND "orderable_shop_menu_id" <= 4294967295),
  "orderable_shop_menu_price_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_price_id" IS NULL OR typeof("orderable_shop_menu_price_id") = 'integer') CHECK ("orderable_shop_menu_price_id" >= 0 AND "orderable_shop_menu_price_id" <= 4294967295),
  "quantity" INTEGER NOT NULL CHECK ("quantity" IS NULL OR typeof("quantity") = 'integer') CHECK ("quantity" >= 0 AND "quantity" <= 4294967295),
  "is_modified" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_modified" IS NULL OR typeof("is_modified") = 'integer') CHECK ("is_modified" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "cart_menu_item__idx_cart_id" ON "cart_menu_item" ("cart_id", "orderable_shop_menu_id", "orderable_shop_menu_price_id");

CREATE TRIGGER "cart_menu_item__updated_at_on_update" AFTER UPDATE ON "cart_menu_item" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."cart_id" IS NOT OLD."cart_id" OR NEW."orderable_shop_menu_id" IS NOT OLD."orderable_shop_menu_id" OR NEW."orderable_shop_menu_price_id" IS NOT OLD."orderable_shop_menu_price_id" OR NEW."quantity" IS NOT OLD."quantity" OR NEW."is_modified" IS NOT OLD."is_modified" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "cart_menu_item" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "cart_menu_item_option" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "cart_menu_item_id" INTEGER NOT NULL CHECK ("cart_menu_item_id" IS NULL OR typeof("cart_menu_item_id") = 'integer') CHECK ("cart_menu_item_id" >= 0 AND "cart_menu_item_id" <= 4294967295),
  "orderable_shop_menu_option_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_option_id" IS NULL OR typeof("orderable_shop_menu_option_id") = 'integer') CHECK ("orderable_shop_menu_option_id" >= 0 AND "orderable_shop_menu_option_id" <= 4294967295),
  "option_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("option_name") <= 255),
  "option_price" INTEGER NOT NULL CHECK ("option_price" IS NULL OR typeof("option_price") = 'integer') CHECK ("option_price" >= 0 AND "option_price" <= 4294967295),
  "quantity" INTEGER NOT NULL CHECK ("quantity" IS NULL OR typeof("quantity") = 'integer') CHECK ("quantity" >= 0 AND "quantity" <= 4294967295),
  "is_modified" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_modified" IS NULL OR typeof("is_modified") = 'integer') CHECK ("is_modified" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "cart_menu_item_option__idx_cart_menu_item_id" ON "cart_menu_item_option" ("cart_menu_item_id", "orderable_shop_menu_option_id");

CREATE TRIGGER "cart_menu_item_option__updated_at_on_update" AFTER UPDATE ON "cart_menu_item_option" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."cart_menu_item_id" IS NOT OLD."cart_menu_item_id" OR NEW."orderable_shop_menu_option_id" IS NOT OLD."orderable_shop_menu_option_id" OR NEW."option_name" IS NOT OLD."option_name" OR NEW."option_price" IS NOT OLD."option_price" OR NEW."quantity" IS NOT OLD."quantity" OR NEW."is_modified" IS NOT OLD."is_modified" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "cart_menu_item_option" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "catalog" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "code" TEXT COLLATE NOCASE NOT NULL CHECK (length("code") <= 20),
  "year" TEXT COLLATE NOCASE NOT NULL CHECK (length("year") <= 20),
  "lecture_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("lecture_name") <= 255),
  "department_id" INTEGER NOT NULL CHECK ("department_id" IS NULL OR typeof("department_id") = 'integer') CHECK ("department_id" >= 0 AND "department_id" <= 4294967295),
  "major_id" INTEGER CHECK ("major_id" IS NULL OR typeof("major_id") = 'integer') CHECK ("major_id" >= 0 AND "major_id" <= 4294967295),
  "general_education_area_id" INTEGER CHECK ("general_education_area_id" IS NULL OR typeof("general_education_area_id") = 'integer') CHECK ("general_education_area_id" >= 0 AND "general_education_area_id" <= 4294967295),
  "credit" INTEGER NOT NULL DEFAULT ('0') CHECK ("credit" IS NULL OR typeof("credit") = 'integer') CHECK ("credit" >= 0 AND "credit" <= 4294967295),
  "course_type_id" INTEGER NOT NULL CHECK ("course_type_id" IS NULL OR typeof("course_type_id") = 'integer') CHECK ("course_type_id" >= 0 AND "course_type_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "catalog_ibfk_1" FOREIGN KEY ("major_id") REFERENCES "major" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "catalog_ibfk_2" FOREIGN KEY ("course_type_id") REFERENCES "course_type" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "catalog_ibfk_3" FOREIGN KEY ("department_id") REFERENCES "department" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "catalog_ibfk_4" FOREIGN KEY ("general_education_area_id") REFERENCES "general_education_area" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "catalog__course_type_id" ON "catalog" ("course_type_id");

CREATE INDEX "catalog__department_id" ON "catalog" ("department_id");

CREATE INDEX "catalog__general_education_area_id" ON "catalog" ("general_education_area_id");

CREATE INDEX "catalog__idx_catalog_code_year" ON "catalog" ("code", "year");

CREATE INDEX "catalog__idx_catalog_lecture_name" ON "catalog" ("lecture_name", "year");

CREATE INDEX "catalog__major_id" ON "catalog" ("major_id");

CREATE TRIGGER "catalog__updated_at_on_update" AFTER UPDATE ON "catalog" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."code" IS NOT OLD."code" OR NEW."year" IS NOT OLD."year" OR NEW."lecture_name" IS NOT OLD."lecture_name" OR NEW."department_id" IS NOT OLD."department_id" OR NEW."major_id" IS NOT OLD."major_id" OR NEW."general_education_area_id" IS NOT OLD."general_education_area_id" OR NEW."credit" IS NOT OLD."credit" OR NEW."course_type_id" IS NOT OLD."course_type_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "catalog" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "club" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "club_category_id" INTEGER NOT NULL CHECK ("club_category_id" IS NULL OR typeof("club_category_id") = 'integer') CHECK ("club_category_id" >= 0 AND "club_category_id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 50),
  "hits" INTEGER NOT NULL DEFAULT ('0') CHECK ("hits" IS NULL OR typeof("hits") = 'integer') CHECK ("hits" >= 0 AND "hits" <= 4294967295),
  "description" TEXT COLLATE NOCASE NOT NULL CHECK (length("description") <= 100),
  "is_active" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_active" IS NULL OR typeof("is_active") = 'integer') CHECK ("is_active" IN (0, 1)),
  "image_url" TEXT COLLATE NOCASE NOT NULL CHECK (length("image_url") <= 255),
  "likes" INTEGER NOT NULL DEFAULT ('0') CHECK ("likes" IS NULL OR typeof("likes") = 'integer') CHECK ("likes" >= 0 AND "likes" <= 4294967295),
  "location" TEXT COLLATE NOCASE NOT NULL CHECK (length("location") <= 20),
  "last_week_hits" INTEGER NOT NULL DEFAULT ('0') CHECK ("last_week_hits" IS NULL OR typeof("last_week_hits") = 'integer') CHECK ("last_week_hits" >= 0 AND "last_week_hits" <= 4294967295),
  "introduction" TEXT COLLATE NOCASE NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "is_like_hidden" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_like_hidden" IS NULL OR typeof("is_like_hidden") = 'integer') CHECK ("is_like_hidden" IN (0, 1)),
  "normalized_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("normalized_name") <= 50),
  CONSTRAINT "club_ibfk_1" FOREIGN KEY ("club_category_id") REFERENCES "club_category" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "club__club_category_id" ON "club" ("club_category_id");

CREATE INDEX "club__idx_club_normalized_name" ON "club" ("normalized_name");

CREATE TRIGGER "club__updated_at_on_update" AFTER UPDATE ON "club" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."club_category_id" IS NOT OLD."club_category_id" OR NEW."name" IS NOT OLD."name" OR NEW."hits" IS NOT OLD."hits" OR NEW."description" IS NOT OLD."description" OR NEW."is_active" IS NOT OLD."is_active" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."likes" IS NOT OLD."likes" OR NEW."location" IS NOT OLD."location" OR NEW."last_week_hits" IS NOT OLD."last_week_hits" OR NEW."introduction" IS NOT OLD."introduction" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."is_like_hidden" IS NOT OLD."is_like_hidden" OR NEW."normalized_name" IS NOT OLD."normalized_name") BEGIN UPDATE "club" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "club_category" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255)
);

CREATE TABLE "club_event" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "club_id" INTEGER NOT NULL CHECK ("club_id" IS NULL OR typeof("club_id") = 'integer') CHECK ("club_id" >= 0 AND "club_id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 30),
  "start_date" TEXT NOT NULL,
  "end_date" TEXT NOT NULL,
  "introduce" TEXT COLLATE NOCASE NOT NULL CHECK (length("introduce") <= 70),
  "content" TEXT COLLATE NOCASE,
  "notified_before_one_hour" INTEGER NOT NULL CHECK ("notified_before_one_hour" IS NULL OR typeof("notified_before_one_hour") = 'integer') CHECK ("notified_before_one_hour" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_club_event_club" FOREIGN KEY ("club_id") REFERENCES "club" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "club_event__fk_club_event_club" ON "club_event" ("club_id");

CREATE INDEX "club_event__idx_notified_startdate" ON "club_event" ("notified_before_one_hour", "start_date");

CREATE TRIGGER "club_event__updated_at_on_update" AFTER UPDATE ON "club_event" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."club_id" IS NOT OLD."club_id" OR NEW."name" IS NOT OLD."name" OR NEW."start_date" IS NOT OLD."start_date" OR NEW."end_date" IS NOT OLD."end_date" OR NEW."introduce" IS NOT OLD."introduce" OR NEW."content" IS NOT OLD."content" OR NEW."notified_before_one_hour" IS NOT OLD."notified_before_one_hour" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "club_event" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "club_event_image" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "club_event_id" INTEGER NOT NULL CHECK ("club_event_id" IS NULL OR typeof("club_event_id") = 'integer') CHECK ("club_event_id" >= 0 AND "club_event_id" <= 4294967295),
  "image_url" TEXT COLLATE NOCASE NOT NULL CHECK (length("image_url") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "club_event_image_ibfk_1" FOREIGN KEY ("club_event_id") REFERENCES "club_event" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "club_event_image__club_event_id" ON "club_event_image" ("club_event_id");

CREATE TRIGGER "club_event_image__updated_at_on_update" AFTER UPDATE ON "club_event_image" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."club_event_id" IS NOT OLD."club_event_id" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "club_event_image" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "club_event_subscription" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "event_id" INTEGER NOT NULL CHECK ("event_id" IS NULL OR typeof("event_id") = 'integer') CHECK ("event_id" >= 0 AND "event_id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "club_event_subscription_ibfk_1" FOREIGN KEY ("event_id") REFERENCES "club_event" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "club_event_subscription_ibfk_2" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "club_event_subscription__uniq_event_user" ON "club_event_subscription" ("event_id", "user_id");

CREATE INDEX "club_event_subscription__user_id" ON "club_event_subscription" ("user_id");

CREATE TRIGGER "club_event_subscription__updated_at_on_update" AFTER UPDATE ON "club_event_subscription" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."event_id" IS NOT OLD."event_id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "club_event_subscription" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "club_hot" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "club_id" INTEGER NOT NULL CHECK ("club_id" IS NULL OR typeof("club_id") = 'integer') CHECK ("club_id" >= 0 AND "club_id" <= 4294967295),
  "ranking" INTEGER NOT NULL CHECK ("ranking" IS NULL OR typeof("ranking") = 'integer') CHECK ("ranking" >= 0 AND "ranking" <= 4294967295),
  "period_hits" INTEGER NOT NULL DEFAULT ('0') CHECK ("period_hits" IS NULL OR typeof("period_hits") = 'integer') CHECK ("period_hits" >= 0 AND "period_hits" <= 4294967295),
  "start_date" TEXT NOT NULL,
  "end_date" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "club_hot_ibfk_1" FOREIGN KEY ("club_id") REFERENCES "club" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "club_hot__club_id" ON "club_hot" ("club_id");

CREATE TRIGGER "club_hot__updated_at_on_update" AFTER UPDATE ON "club_hot" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."club_id" IS NOT OLD."club_id" OR NEW."ranking" IS NOT OLD."ranking" OR NEW."period_hits" IS NOT OLD."period_hits" OR NEW."start_date" IS NOT OLD."start_date" OR NEW."end_date" IS NOT OLD."end_date" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "club_hot" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "club_like" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "club_id" INTEGER NOT NULL CHECK ("club_id" IS NULL OR typeof("club_id") = 'integer') CHECK ("club_id" >= 0 AND "club_id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "club_like_ibfk_1" FOREIGN KEY ("club_id") REFERENCES "club" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "club_like_ibfk_2" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "club_like__club_id" ON "club_like" ("club_id");

CREATE INDEX "club_like__user_id" ON "club_like" ("user_id");

CREATE TRIGGER "club_like__updated_at_on_update" AFTER UPDATE ON "club_like" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."club_id" IS NOT OLD."club_id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "club_like" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "club_manager" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "club_id" INTEGER NOT NULL CHECK ("club_id" IS NULL OR typeof("club_id") = 'integer') CHECK ("club_id" >= 0 AND "club_id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  CONSTRAINT "club_manager_ibfk_1" FOREIGN KEY ("club_id") REFERENCES "club" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "club_manager_ibfk_2" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "club_manager__club_id" ON "club_manager" ("club_id");

CREATE INDEX "club_manager__user_id" ON "club_manager" ("user_id");

CREATE TABLE "club_qna" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "club_id" INTEGER NOT NULL CHECK ("club_id" IS NULL OR typeof("club_id") = 'integer') CHECK ("club_id" >= 0 AND "club_id" <= 4294967295),
  "author_id" INTEGER CHECK ("author_id" IS NULL OR typeof("author_id") = 'integer') CHECK ("author_id" >= 0 AND "author_id" <= 4294967295),
  "parent_id" INTEGER CHECK ("parent_id" IS NULL OR typeof("parent_id") = 'integer') CHECK ("parent_id" >= 0 AND "parent_id" <= 4294967295),
  "content" TEXT COLLATE NOCASE NOT NULL CHECK (length("content") <= 255),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "is_manager" INTEGER NOT NULL CHECK ("is_manager" IS NULL OR typeof("is_manager") = 'integer') CHECK ("is_manager" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "club_qna_ibfk_1" FOREIGN KEY ("club_id") REFERENCES "club" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "club_qna_ibfk_2" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "club_qna_ibfk_3" FOREIGN KEY ("parent_id") REFERENCES "club_qna" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "club_qna__author_id" ON "club_qna" ("author_id");

CREATE INDEX "club_qna__club_id" ON "club_qna" ("club_id");

CREATE INDEX "club_qna__parent_id" ON "club_qna" ("parent_id");

CREATE TRIGGER "club_qna__updated_at_on_update" AFTER UPDATE ON "club_qna" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."club_id" IS NOT OLD."club_id" OR NEW."author_id" IS NOT OLD."author_id" OR NEW."parent_id" IS NOT OLD."parent_id" OR NEW."content" IS NOT OLD."content" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."is_manager" IS NOT OLD."is_manager" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "club_qna" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "club_recruitment" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "club_id" INTEGER NOT NULL CHECK ("club_id" IS NULL OR typeof("club_id") = 'integer') CHECK ("club_id" >= 0 AND "club_id" <= 4294967295),
  "start_date" TEXT,
  "end_date" TEXT,
  "is_always_recruiting" INTEGER NOT NULL CHECK ("is_always_recruiting" IS NULL OR typeof("is_always_recruiting") = 'integer') CHECK ("is_always_recruiting" IN (0, 1)),
  "image_url" TEXT COLLATE NOCASE CHECK (length("image_url") <= 255),
  "content" TEXT COLLATE NOCASE,
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_club" FOREIGN KEY ("club_id") REFERENCES "club" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "club_recruitment__uk_club_recruitment_club_id" ON "club_recruitment" ("club_id");

CREATE TRIGGER "club_recruitment__updated_at_on_update" AFTER UPDATE ON "club_recruitment" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."club_id" IS NOT OLD."club_id" OR NEW."start_date" IS NOT OLD."start_date" OR NEW."end_date" IS NOT OLD."end_date" OR NEW."is_always_recruiting" IS NOT OLD."is_always_recruiting" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."content" IS NOT OLD."content" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "club_recruitment" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "club_recruitment_subscription" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "club_id" INTEGER NOT NULL CHECK ("club_id" IS NULL OR typeof("club_id") = 'integer') CHECK ("club_id" >= 0 AND "club_id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "club_recruitment_subscription_ibfk_1" FOREIGN KEY ("club_id") REFERENCES "club" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "club_recruitment_subscription_ibfk_2" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "club_recruitment_subscription__uniq_club_user" ON "club_recruitment_subscription" ("club_id", "user_id");

CREATE INDEX "club_recruitment_subscription__user_id" ON "club_recruitment_subscription" ("user_id");

CREATE TRIGGER "club_recruitment_subscription__updated_at_on_update" AFTER UPDATE ON "club_recruitment_subscription" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."club_id" IS NOT OLD."club_id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "club_recruitment_subscription" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "club_sns" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "club_id" INTEGER NOT NULL CHECK ("club_id" IS NULL OR typeof("club_id") = 'integer') CHECK ("club_id" >= 0 AND "club_id" <= 4294967295),
  "sns_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("sns_type") <= 50),
  "contact" TEXT COLLATE NOCASE NOT NULL CHECK (length("contact") <= 255),
  CONSTRAINT "club_sns_ibfk_1" FOREIGN KEY ("club_id") REFERENCES "club" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "club_sns__club_id" ON "club_sns" ("club_id");

CREATE TABLE "comments" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" >= 0 AND "article_id" <= 4294967295),
  "content" TEXT COLLATE NOCASE NOT NULL,
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "nickname" TEXT COLLATE NOCASE NOT NULL CHECK (length("nickname") <= 50),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "comments__updated_at_on_update" AFTER UPDATE ON "comments" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."article_id" IS NOT OLD."article_id" OR NEW."content" IS NOT OLD."content" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."nickname" IS NOT OLD."nickname" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "comments" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "coop" (
  "user_id" INTEGER PRIMARY KEY NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "coop_id" TEXT COLLATE NOCASE NOT NULL CHECK (length("coop_id") <= 255),
  CONSTRAINT "FK_COOP_ON_USER" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE TABLE "coop_names" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "icon_url" TEXT COLLATE NOCASE CHECK (length("icon_url") <= 500)
);

CREATE TABLE "coop_opens" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "coop_shop_id" INTEGER CHECK ("coop_shop_id" IS NULL OR typeof("coop_shop_id") = 'integer') CHECK ("coop_shop_id" >= 0 AND "coop_shop_id" <= 4294967295),
  "type" TEXT COLLATE NOCASE CHECK (length("type") <= 10),
  "day_of_week" TEXT COLLATE NOCASE NOT NULL CHECK (length("day_of_week") <= 10),
  "open_time" TEXT COLLATE NOCASE CHECK (length("open_time") <= 10),
  "close_time" TEXT COLLATE NOCASE CHECK (length("close_time") <= 10),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "FK_COOP_SHOP_ID" FOREIGN KEY ("coop_shop_id") REFERENCES "coop_shop" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "coop_opens__FK_COOP_ID" ON "coop_opens" ("coop_shop_id");

CREATE TABLE "coop_semester" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "semester" TEXT COLLATE NOCASE NOT NULL CHECK (length("semester") <= 200),
  "from_date" TEXT NOT NULL,
  "to_date" TEXT NOT NULL,
  "is_applied" INTEGER NOT NULL DEFAULT ('1') CHECK ("is_applied" IS NULL OR typeof("is_applied") = 'integer') CHECK ("is_applied" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX "coop_semester__semester" ON "coop_semester" ("semester");

CREATE TRIGGER "coop_semester__updated_at_on_update" AFTER UPDATE ON "coop_semester" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."semester" IS NOT OLD."semester" OR NEW."from_date" IS NOT OLD."from_date" OR NEW."to_date" IS NOT OLD."to_date" OR NEW."is_applied" IS NOT OLD."is_applied" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "coop_semester" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "coop_shop" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "phone" TEXT COLLATE NOCASE CHECK (length("phone") <= 50),
  "location" TEXT COLLATE NOCASE NOT NULL CHECK (length("location") <= 50),
  "remarks" TEXT COLLATE NOCASE,
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "semester_id" INTEGER CHECK ("semester_id" IS NULL OR typeof("semester_id") = 'integer') CHECK ("semester_id" >= 0 AND "semester_id" <= 4294967295),
  "coop_name_id" INTEGER CHECK ("coop_name_id" IS NULL OR typeof("coop_name_id") = 'integer') CHECK ("coop_name_id" >= 0 AND "coop_name_id" <= 4294967295),
  CONSTRAINT "coop_name_fk_id" FOREIGN KEY ("coop_name_id") REFERENCES "coop_names" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "coop_semester_fk_id" FOREIGN KEY ("semester_id") REFERENCES "coop_semester" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "coop_shop__coop_name_fk_id" ON "coop_shop" ("coop_name_id");

CREATE INDEX "coop_shop__coop_semester_fk_id" ON "coop_shop" ("semester_id");

CREATE TABLE "course_type" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "is_deleted" INTEGER DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" BETWEEN -128 AND 127),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "course_type__updated_at_on_update" AFTER UPDATE ON "course_type" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."name" IS NOT OLD."name" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "course_type" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "courses" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "region" TEXT NOT NULL CHECK (length("region") <= 10),
  "bus_type" TEXT NOT NULL CHECK (length("bus_type") <= 15),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1))
);

CREATE TABLE "department" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "curriculum_link" TEXT COLLATE NOCASE NOT NULL DEFAULT ('https://www.koreatech.ac.kr/menu.es?mid=a10201000000') CHECK (length("curriculum_link") <= 255),
  "dept_nums" TEXT NOT NULL DEFAULT ((json_array('N/A'))) CHECK ("dept_nums" IS NULL OR json_valid("dept_nums")),
  "is_selectable" INTEGER NOT NULL DEFAULT ('1') CHECK ("is_selectable" IS NULL OR typeof("is_selectable") = 'integer') CHECK ("is_selectable" IN (0, 1)),
  "display_order" INTEGER NOT NULL DEFAULT ('1000') CHECK ("display_order" IS NULL OR typeof("display_order") = 'integer') CHECK ("display_order" BETWEEN -2147483648 AND 2147483647)
);

CREATE TRIGGER "department__updated_at_on_update" AFTER UPDATE ON "department" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."name" IS NOT OLD."name" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."curriculum_link" IS NOT OLD."curriculum_link" OR NEW."dept_nums" IS NOT OLD."dept_nums" OR NEW."is_selectable" IS NOT OLD."is_selectable" OR NEW."display_order" IS NOT OLD."display_order") BEGIN UPDATE "department" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "department_contact_departments" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "category" TEXT COLLATE NOCASE NOT NULL CHECK (length("category") <= 30),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 100),
  "display_order" INTEGER NOT NULL CHECK ("display_order" IS NULL OR typeof("display_order") = 'integer') CHECK ("display_order" >= 0 AND "display_order" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "department_contact_departments__idx_department_contact_departments_category_order" ON "department_contact_departments" ("category", "display_order");

CREATE UNIQUE INDEX "department_contact_departments__uk_department_contact_departments_category_name" ON "department_contact_departments" ("category", "name");

CREATE TRIGGER "department_contact_departments__updated_at_on_update" AFTER UPDATE ON "department_contact_departments" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."category" IS NOT OLD."category" OR NEW."name" IS NOT OLD."name" OR NEW."display_order" IS NOT OLD."display_order" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "department_contact_departments" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "department_contacts" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "department_id" INTEGER NOT NULL CHECK ("department_id" IS NULL OR typeof("department_id") = 'integer') CHECK ("department_id" >= 0 AND "department_id" <= 4294967295),
  "task" TEXT COLLATE NOCASE NOT NULL DEFAULT ('') CHECK (length("task") <= 255),
  "phone_number" TEXT COLLATE NOCASE NOT NULL CHECK (length("phone_number") <= 20),
  "display_order" INTEGER NOT NULL CHECK ("display_order" IS NULL OR typeof("display_order") = 'integer') CHECK ("display_order" >= 0 AND "display_order" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_department_contacts_department_id" FOREIGN KEY ("department_id") REFERENCES "department_contact_departments" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "department_contacts__uk_department_contacts_department_order" ON "department_contacts" ("department_id", "display_order");

CREATE TRIGGER "department_contacts__updated_at_on_update" AFTER UPDATE ON "department_contacts" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."department_id" IS NOT OLD."department_id" OR NEW."task" IS NOT OLD."task" OR NEW."phone_number" IS NOT OLD."phone_number" OR NEW."display_order" IS NOT OLD."display_order" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "department_contacts" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "detect_graduation_calculation" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "user_id" INTEGER CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "is_changed" INTEGER DEFAULT ('0') CHECK ("is_changed" IS NULL OR typeof("is_changed") = 'integer') CHECK ("is_changed" IN (0, 1))
);

CREATE UNIQUE INDEX "detect_graduation_calculation__unique_user" ON "detect_graduation_calculation" ("user_id");

CREATE TABLE "device" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "model" TEXT COLLATE NOCASE CHECK (length("model") <= 100),
  "type" TEXT COLLATE NOCASE CHECK (length("type") <= 100),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "FK_DEVICE_ON_USER_ID" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "device__FK_DEVICE_ON_USER_ID_idx" ON "device" ("user_id");

CREATE TRIGGER "device__updated_at_on_update" AFTER UPDATE ON "device" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."model" IS NOT OLD."model" OR NEW."type" IS NOT OLD."type" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "device" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "dining_likes" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "dining_id" INTEGER NOT NULL CHECK ("dining_id" IS NULL OR typeof("dining_id") = 'integer') CHECK ("dining_id" BETWEEN -2147483648 AND 2147483647),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -2147483648 AND 2147483647)
);

CREATE TABLE "dining_menus" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "date" TEXT NOT NULL,
  "type" TEXT COLLATE NOCASE NOT NULL CHECK (length("type") <= 9),
  "place" TEXT COLLATE NOCASE NOT NULL CHECK (length("place") <= 9),
  "price_card" INTEGER CHECK ("price_card" IS NULL OR typeof("price_card") = 'integer') CHECK ("price_card" >= 0 AND "price_card" <= 4294967295),
  "price_cash" INTEGER CHECK ("price_cash" IS NULL OR typeof("price_cash") = 'integer') CHECK ("price_cash" >= 0 AND "price_cash" <= 4294967295),
  "kcal" INTEGER CHECK ("kcal" IS NULL OR typeof("kcal") = 'integer') CHECK ("kcal" >= 0 AND "kcal" <= 4294967295),
  "menu" TEXT COLLATE NOCASE NOT NULL,
  "image_url" TEXT COLLATE NOCASE CHECK (length("image_url") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "sold_out" TEXT,
  "is_changed" TEXT,
  "likes" INTEGER DEFAULT ('0') CHECK ("likes" IS NULL OR typeof("likes") = 'integer') CHECK ("likes" BETWEEN -2147483648 AND 2147483647),
  "price" INTEGER CHECK ("price" IS NULL OR typeof("price") = 'integer') CHECK ("price" >= 0 AND "price" <= 4294967295),
  "sold_out_source" TEXT COLLATE NOCASE CHECK (length("sold_out_source") <= 16),
  CONSTRAINT "chk_dining_sold_out_source" CHECK (((`sold_out_source` is null) or (`sold_out_source` in ('COOP','REPORT','UNKNOWN'))))
);

CREATE UNIQUE INDEX "dining_menus__ux_date_type_place" ON "dining_menus" ("date", "type", "place");

CREATE TRIGGER "dining_menus__updated_at_on_update" AFTER UPDATE ON "dining_menus" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."date" IS NOT OLD."date" OR NEW."type" IS NOT OLD."type" OR NEW."place" IS NOT OLD."place" OR NEW."price_card" IS NOT OLD."price_card" OR NEW."price_cash" IS NOT OLD."price_cash" OR NEW."kcal" IS NOT OLD."kcal" OR NEW."menu" IS NOT OLD."menu" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."sold_out" IS NOT OLD."sold_out" OR NEW."is_changed" IS NOT OLD."is_changed" OR NEW."likes" IS NOT OLD."likes" OR NEW."price" IS NOT OLD."price" OR NEW."sold_out_source" IS NOT OLD."sold_out_source") BEGIN UPDATE "dining_menus" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "dining_soldout_report" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "dining_id" INTEGER NOT NULL CHECK ("dining_id" IS NULL OR typeof("dining_id") = 'integer') CHECK ("dining_id" >= 0 AND "dining_id" <= 4294967295),
  "reporter_id" INTEGER CHECK ("reporter_id" IS NULL OR typeof("reporter_id") = 'integer') CHECK ("reporter_id" >= 0 AND "reporter_id" <= 4294967295),
  "image_url" TEXT COLLATE NOCASE NOT NULL CHECK (length("image_url") <= 2048),
  "status" TEXT COLLATE NOCASE NOT NULL DEFAULT ('PENDING') CHECK (length("status") <= 16),
  "processing_type" TEXT COLLATE NOCASE CHECK (length("processing_type") <= 32),
  "processing_id" TEXT CHECK (length("processing_id") = 36 AND substr("processing_id",9,1) = '-' AND substr("processing_id",14,1) = '-' AND substr("processing_id",19,1) = '-' AND substr("processing_id",24,1) = '-' AND length(replace("processing_id",'-','')) = 32 AND replace("processing_id",'-','') NOT GLOB '*[^0-9a-f]*'),
  "source_report_id" INTEGER CHECK ("source_report_id" IS NULL OR typeof("source_report_id") = 'integer') CHECK ("source_report_id" >= 0 AND "source_report_id" <= 4294967295),
  "processor_workspace_id" TEXT COLLATE NOCASE CHECK (length("processor_workspace_id") <= 64),
  "processor_user_id" TEXT COLLATE NOCASE CHECK (length("processor_user_id") <= 64),
  "processor_name" TEXT COLLATE NOCASE CHECK (length("processor_name") <= 80),
  "processed_at" TEXT,
  "request_key" TEXT CHECK (length("request_key") = 36 AND substr("request_key",9,1) = '-' AND substr("request_key",14,1) = '-' AND substr("request_key",19,1) = '-' AND substr("request_key",24,1) = '-' AND length(replace("request_key",'-','')) = 32 AND replace("request_key",'-','') NOT GLOB '*[^0-9a-f]*'),
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  CONSTRAINT "fk_dining_report_dining" FOREIGN KEY ("dining_id") REFERENCES "dining_menus" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "fk_dining_report_reporter" FOREIGN KEY ("reporter_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "fk_dining_report_source" FOREIGN KEY ("source_report_id") REFERENCES "dining_soldout_report" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "chk_dining_report_result" CHECK ((((`status` = 'PENDING') and (`processing_type` is null) and (`processing_id` is null) and (`processed_at` is null) and (`source_report_id` is null) and (`processor_workspace_id` is null) and (`processor_user_id` is null) and (`processor_name` is null)) or ((`status` in ('APPROVED','REJECTED')) and (`processing_type` = 'MANUAL') and (`processing_id` is not null) and (`processed_at` is not null) and (`source_report_id` is null) and (`processor_workspace_id` is not null) and (`processor_user_id` is not null) and (`processor_name` is not null)) or ((`status` = 'APPROVED') and (`processing_type` = 'SAME_DINING_APPROVED') and (`processing_id` is not null) and (`processed_at` is not null) and (`source_report_id` is not null) and (`processor_workspace_id` is null) and (`processor_user_id` is null) and (`processor_name` is null)) or ((`status` = 'REJECTED') and (`processing_type` = 'COOP_PREPROCESSED') and (`processing_id` is not null) and (`processed_at` is not null) and (`source_report_id` is null) and (`processor_workspace_id` is null) and (`processor_user_id` is null) and (`processor_name` is null)))),
  CONSTRAINT "chk_dining_report_status" CHECK ((`status` in ('PENDING','APPROVED','REJECTED'))),
  CONSTRAINT "chk_dining_report_terminal" CHECK (((`status` = 'PENDING') or ((`processing_type` is not null) and (`processing_id` is not null) and (`processed_at` is not null))))
);

CREATE INDEX "dining_soldout_report__fk_dining_report_source" ON "dining_soldout_report" ("source_report_id");

CREATE INDEX "dining_soldout_report__idx_dining_report_created" ON "dining_soldout_report" ("created_at", "id");

CREATE INDEX "dining_soldout_report__idx_dining_report_dining" ON "dining_soldout_report" ("dining_id", "status", "id");

CREATE INDEX "dining_soldout_report__idx_dining_report_pending" ON "dining_soldout_report" ("status", "created_at", "id");

CREATE INDEX "dining_soldout_report__idx_dining_report_processing" ON "dining_soldout_report" ("processing_id", "id");

CREATE UNIQUE INDEX "dining_soldout_report__uk_dining_report_request" ON "dining_soldout_report" ("reporter_id", "request_key");

CREATE UNIQUE INDEX "dining_soldout_report__uk_dining_report_student" ON "dining_soldout_report" ("reporter_id", "dining_id");

CREATE TABLE "dining_soldout_report_change" (
  "sequence" TEXT PRIMARY KEY NOT NULL CHECK ("sequence" IS NULL OR (typeof("sequence") = 'text' AND "sequence" = CAST(CAST("sequence" AS INTEGER) AS TEXT))),
  "report_id" INTEGER NOT NULL CHECK ("report_id" IS NULL OR typeof("report_id") = 'integer') CHECK ("report_id" >= 0 AND "report_id" <= 4294967295),
  "event_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("event_type") <= 16),
  "status" TEXT COLLATE NOCASE NOT NULL CHECK (length("status") <= 16),
  "processing_type" TEXT COLLATE NOCASE CHECK (length("processing_type") <= 32),
  "processing_id" TEXT CHECK (length("processing_id") = 36 AND substr("processing_id",9,1) = '-' AND substr("processing_id",14,1) = '-' AND substr("processing_id",19,1) = '-' AND substr("processing_id",24,1) = '-' AND length(replace("processing_id",'-','')) = 32 AND replace("processing_id",'-','') NOT GLOB '*[^0-9a-f]*'),
  "occurred_at" TEXT NOT NULL,
  "delivery_id" TEXT CHECK (length("delivery_id") = 36 AND substr("delivery_id",9,1) = '-' AND substr("delivery_id",14,1) = '-' AND substr("delivery_id",19,1) = '-' AND substr("delivery_id",24,1) = '-' AND length(replace("delivery_id",'-','')) = 32 AND replace("delivery_id",'-','') NOT GLOB '*[^0-9a-f]*'),
  "report_snapshot" TEXT COLLATE NOCASE,
  "delivery_state" TEXT COLLATE NOCASE NOT NULL DEFAULT ('QUEUED') CHECK (length("delivery_state") <= 16),
  "attempt_token" TEXT CHECK (length("attempt_token") = 36 AND substr("attempt_token",9,1) = '-' AND substr("attempt_token",14,1) = '-' AND substr("attempt_token",19,1) = '-' AND substr("attempt_token",24,1) = '-' AND length(replace("attempt_token",'-','')) = 32 AND replace("attempt_token",'-','') NOT GLOB '*[^0-9a-f]*'),
  "expires_at" TEXT,
  "next_attempt_at" TEXT,
  "accepted_outcome" TEXT COLLATE NOCASE CHECK (length("accepted_outcome") <= 16),
  CONSTRAINT "fk_dining_report_change_report" FOREIGN KEY ("report_id") REFERENCES "dining_soldout_report" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "chk_dining_report_change_event" CHECK ((`event_type` in ('CREATED','PROCESSED'))),
  CONSTRAINT "chk_dining_report_change_sequence" CHECK ((CAST(`sequence` AS INTEGER) > 0)),
  CONSTRAINT "chk_dining_report_change_status" CHECK ((`status` in ('PENDING','APPROVED','REJECTED'))),
  CONSTRAINT "chk_dining_report_change_snapshot" CHECK (((`report_snapshot` is null) or json_valid(`report_snapshot`))),
  CONSTRAINT "chk_dining_report_change_delivery_state" CHECK ((`delivery_state` in ('QUEUED','IN_PROGRESS','DELIVERED'))),
  CONSTRAINT "chk_dining_report_change_outcome" CHECK (((`accepted_outcome` is null) or (`accepted_outcome` in ('SUCCEEDED','FAILED')))),
  CONSTRAINT "chk_dining_report_change_lease" CHECK (((`delivery_state` <> 'IN_PROGRESS') or ((`delivery_id` is not null) and (`report_snapshot` is not null) and (`attempt_token` is not null) and (`expires_at` is not null) and (`next_attempt_at` is null) and (`accepted_outcome` is null))))
);

CREATE INDEX "dining_soldout_report_change__idx_dining_report_change_claim" ON "dining_soldout_report_change" ("delivery_state", "next_attempt_at", "sequence");

CREATE INDEX "dining_soldout_report_change__idx_dining_report_change_report" ON "dining_soldout_report_change" ("report_id", "sequence");

CREATE UNIQUE INDEX "dining_soldout_report_change__uk_dining_report_change_attempt" ON "dining_soldout_report_change" ("attempt_token");

CREATE UNIQUE INDEX "dining_soldout_report_change__uk_dining_report_change_delivery" ON "dining_soldout_report_change" ("delivery_id");

CREATE INDEX "dining_soldout_report_change__idx_dining_report_change_claim_numeric" ON "dining_soldout_report_change" ("delivery_state", "next_attempt_at", CAST("sequence" AS INTEGER));

CREATE INDEX "dining_soldout_report_change__idx_dining_report_change_report_numeric" ON "dining_soldout_report_change" ("report_id", CAST("sequence" AS INTEGER));

CREATE INDEX "dining_soldout_report_change__PRIMARY_numeric" ON "dining_soldout_report_change" (CAST("sequence" AS INTEGER));

CREATE TABLE "dining_soldout_report_delivery" (
  "id" TEXT PRIMARY KEY NOT NULL CHECK (length("id") = 36 AND substr("id",9,1) = '-' AND substr("id",14,1) = '-' AND substr("id",19,1) = '-' AND substr("id",24,1) = '-' AND length(replace("id",'-','')) = 32 AND replace("id",'-','') NOT GLOB '*[^0-9a-f]*'),
  "report_id" INTEGER NOT NULL CHECK ("report_id" IS NULL OR typeof("report_id") = 'integer') CHECK ("report_id" >= 0 AND "report_id" <= 4294967295),
  "source_sequence" TEXT NOT NULL CHECK ("source_sequence" IS NULL OR (typeof("source_sequence") = 'text' AND "source_sequence" = CAST(CAST("source_sequence" AS INTEGER) AS TEXT))),
  "report_snapshot" TEXT COLLATE NOCASE NOT NULL,
  "operation" TEXT COLLATE NOCASE NOT NULL CHECK (length("operation") <= 16),
  "workspace_id" TEXT COLLATE NOCASE NOT NULL,
  "channel_id" TEXT COLLATE NOCASE NOT NULL,
  "target_message_ts" TEXT COLLATE NOCASE,
  "status" TEXT COLLATE NOCASE NOT NULL CHECK (length("status") <= 16),
  "active_attempt_token" TEXT CHECK (length("active_attempt_token") = 36 AND substr("active_attempt_token",9,1) = '-' AND substr("active_attempt_token",14,1) = '-' AND substr("active_attempt_token",19,1) = '-' AND substr("active_attempt_token",24,1) = '-' AND length(replace("active_attempt_token",'-','')) = 32 AND replace("active_attempt_token",'-','') NOT GLOB '*[^0-9a-f]*'),
  "send_attempt_token" TEXT CHECK (length("send_attempt_token") = 36 AND substr("send_attempt_token",9,1) = '-' AND substr("send_attempt_token",14,1) = '-' AND substr("send_attempt_token",19,1) = '-' AND substr("send_attempt_token",24,1) = '-' AND length(replace("send_attempt_token",'-','')) = 32 AND replace("send_attempt_token",'-','') NOT GLOB '*[^0-9a-f]*'),
  "next_attempt_at" TEXT,
  "confirmed_message_ts" TEXT COLLATE NOCASE,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  CONSTRAINT "fk_dining_delivery_change" FOREIGN KEY ("source_sequence") REFERENCES "dining_soldout_report_change" ("sequence") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "fk_dining_delivery_target" FOREIGN KEY ("report_id") REFERENCES "dining_soldout_report_delivery_target" ("report_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "chk_dining_delivery_snapshot" CHECK (json_valid(`report_snapshot`)),
  CONSTRAINT "chk_dining_delivery_sequence" CHECK ((CAST(`source_sequence` AS INTEGER) > 0)),
  CONSTRAINT "chk_dining_delivery_operation" CHECK ((((`operation` = 'CREATE') and (`target_message_ts` is null)) or ((`operation` = 'UPDATE') and (`target_message_ts` is not null) and (length(`target_message_ts`) > 0)))),
  CONSTRAINT "chk_dining_delivery_routing" CHECK (((length(`workspace_id`) > 0) and (length(`channel_id`) > 0) and ((`confirmed_message_ts` is null) or (length(`confirmed_message_ts`) > 0)))),
  CONSTRAINT "chk_dining_delivery_status" CHECK ((`status` in ('QUEUED','IN_PROGRESS','UNCERTAIN','DELIVERED','NEEDS_ATTENTION'))),
  CONSTRAINT "chk_dining_delivery_active" CHECK ((((`status` = 'IN_PROGRESS') and (`active_attempt_token` is not null) and (`send_attempt_token` is not null) and (`next_attempt_at` is null)) or ((`status` <> 'IN_PROGRESS') and (`active_attempt_token` is null)))),
  CONSTRAINT "chk_dining_delivery_confirmed" CHECK (((`status` <> 'DELIVERED') or ((`confirmed_message_ts` is not null) and (`next_attempt_at` is null))))
);

CREATE INDEX "dining_soldout_report_delivery__fk_dining_delivery_change" ON "dining_soldout_report_delivery" ("source_sequence");

CREATE UNIQUE INDEX "dining_soldout_report_delivery__uk_dining_delivery_snapshot" ON "dining_soldout_report_delivery" ("report_id", "source_sequence");

CREATE INDEX "dining_soldout_report_delivery__fk_dining_delivery_change_numeric" ON "dining_soldout_report_delivery" (CAST("source_sequence" AS INTEGER));

CREATE INDEX "dining_soldout_report_delivery__uk_dining_delivery_snapshot_numeric" ON "dining_soldout_report_delivery" ("report_id", CAST("source_sequence" AS INTEGER));

CREATE TABLE "dining_soldout_report_delivery_attempt" (
  "token" TEXT PRIMARY KEY NOT NULL CHECK (length("token") = 36 AND substr("token",9,1) = '-' AND substr("token",14,1) = '-' AND substr("token",19,1) = '-' AND substr("token",24,1) = '-' AND length(replace("token",'-','')) = 32 AND replace("token",'-','') NOT GLOB '*[^0-9a-f]*'),
  "delivery_id" TEXT NOT NULL CHECK (length("delivery_id") = 36 AND substr("delivery_id",9,1) = '-' AND substr("delivery_id",14,1) = '-' AND substr("delivery_id",19,1) = '-' AND substr("delivery_id",24,1) = '-' AND length(replace("delivery_id",'-','')) = 32 AND replace("delivery_id",'-','') NOT GLOB '*[^0-9a-f]*'),
  "mode" TEXT COLLATE NOCASE NOT NULL CHECK (length("mode") <= 16),
  "send_attempt_token" TEXT NOT NULL CHECK (length("send_attempt_token") = 36 AND substr("send_attempt_token",9,1) = '-' AND substr("send_attempt_token",14,1) = '-' AND substr("send_attempt_token",19,1) = '-' AND substr("send_attempt_token",24,1) = '-' AND length(replace("send_attempt_token",'-','')) = 32 AND replace("send_attempt_token",'-','') NOT GLOB '*[^0-9a-f]*'),
  "issued_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL,
  "expired_at" TEXT,
  "invalidated_at" TEXT,
  "accepted_outcome" TEXT COLLATE NOCASE CHECK (length("accepted_outcome") <= 16),
  "accepted_result" TEXT COLLATE NOCASE,
  "original_result" TEXT COLLATE NOCASE,
  "evidence_history" TEXT COLLATE NOCASE NOT NULL,
  "result_at" TEXT,
  CONSTRAINT "fk_dining_delivery_attempt_delivery" FOREIGN KEY ("delivery_id") REFERENCES "dining_soldout_report_delivery" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "chk_dining_delivery_attempt_mode" CHECK ((`mode` in ('SEND','VERIFY'))),
  CONSTRAINT "chk_dining_delivery_attempt_origin" CHECK (((`mode` <> 'SEND') or (`send_attempt_token` = `token`))),
  CONSTRAINT "chk_dining_delivery_attempt_deadline" CHECK ((`expires_at` = ((strftime('%Y-%m-%d %H:%M:%S', `issued_at`, '+60 seconds') || substr(`issued_at`,20))))),
  CONSTRAINT "chk_dining_delivery_attempt_outcome" CHECK (((`accepted_outcome` is null) or (`accepted_outcome` in ('SUCCEEDED','NOT_APPLIED','UNCERTAIN')))),
  CONSTRAINT "chk_dining_delivery_attempt_verify" CHECK (((`mode` <> 'VERIFY') or (`accepted_outcome` <> 'NOT_APPLIED'))),
  CONSTRAINT "chk_dining_delivery_attempt_result" CHECK ((((`accepted_outcome` is null) and (`accepted_result` is null) and (`result_at` is null)) or ((`accepted_outcome` is not null) and (`accepted_result` is not null) and (`result_at` is not null)))),
  CONSTRAINT "chk_dining_delivery_attempt_evidence" CHECK ((json_valid(`evidence_history`) and ((`original_result` is null) or json_valid(`original_result`)) and ((`accepted_result` is null) or json_valid(`accepted_result`))))
);

CREATE INDEX "dining_soldout_report_delivery_attempt__idx_dining_delivery_attempt_origin" ON "dining_soldout_report_delivery_attempt" ("delivery_id", "send_attempt_token", "mode");

CREATE TABLE "dining_soldout_report_delivery_target" (
  "report_id" INTEGER PRIMARY KEY NOT NULL CHECK ("report_id" IS NULL OR typeof("report_id") = 'integer') CHECK ("report_id" >= 0 AND "report_id" <= 4294967295),
  "desired_sequence" TEXT NOT NULL CHECK ("desired_sequence" IS NULL OR (typeof("desired_sequence") = 'text' AND "desired_sequence" = CAST(CAST("desired_sequence" AS INTEGER) AS TEXT))),
  "desired_snapshot" TEXT COLLATE NOCASE NOT NULL,
  "confirmed_sequence" TEXT NOT NULL DEFAULT ('0') CHECK ("confirmed_sequence" IS NULL OR (typeof("confirmed_sequence") = 'text' AND "confirmed_sequence" = CAST(CAST("confirmed_sequence" AS INTEGER) AS TEXT))),
  "workspace_id" TEXT COLLATE NOCASE,
  "channel_id" TEXT COLLATE NOCASE,
  "message_ts" TEXT COLLATE NOCASE,
  "active_delivery_id" TEXT CHECK (length("active_delivery_id") = 36 AND substr("active_delivery_id",9,1) = '-' AND substr("active_delivery_id",14,1) = '-' AND substr("active_delivery_id",19,1) = '-' AND substr("active_delivery_id",24,1) = '-' AND length(replace("active_delivery_id",'-','')) = 32 AND replace("active_delivery_id",'-','') NOT GLOB '*[^0-9a-f]*'),
  "hold_reason" TEXT COLLATE NOCASE CHECK (length("hold_reason") <= 16),
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  CONSTRAINT "fk_dining_delivery_target_change" FOREIGN KEY ("desired_sequence") REFERENCES "dining_soldout_report_change" ("sequence") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "fk_dining_delivery_target_report" FOREIGN KEY ("report_id") REFERENCES "dining_soldout_report" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "chk_dining_delivery_target_sequence" CHECK (((CAST(`desired_sequence` AS INTEGER) > 0) and (CAST(`confirmed_sequence` AS INTEGER) >= 0) and (CAST(`confirmed_sequence` AS INTEGER) <= CAST(`desired_sequence` AS INTEGER)))),
  CONSTRAINT "chk_dining_delivery_target_snapshot" CHECK (json_valid(`desired_snapshot`)),
  CONSTRAINT "chk_dining_delivery_target_routing" CHECK ((((`workspace_id` is null) and (`channel_id` is null) and (`message_ts` is null)) or ((`workspace_id` is not null) and (length(`workspace_id`) > 0) and (`channel_id` is not null) and (length(`channel_id`) > 0) and ((`message_ts` is null) or (length(`message_ts`) > 0))))),
  CONSTRAINT "chk_dining_delivery_target_hold" CHECK (((`hold_reason` is null) or (`hold_reason` in ('LEGACY','REJECTED','CONFLICT'))))
);

CREATE INDEX "dining_soldout_report_delivery_target__fk_dining_delivery_target_change" ON "dining_soldout_report_delivery_target" ("desired_sequence");

CREATE INDEX "dining_soldout_report_delivery_target__idx_dining_delivery_target_work" ON "dining_soldout_report_delivery_target" ("hold_reason", "report_id");

CREATE INDEX "dining_soldout_report_delivery_target__fk_dining_delivery_target_change_numeric" ON "dining_soldout_report_delivery_target" (CAST("desired_sequence" AS INTEGER));

CREATE TABLE "dining_soldout_report_sequence" (
  "id" INTEGER PRIMARY KEY NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -128 AND 127),
  "last_sequence" TEXT NOT NULL DEFAULT ('0') CHECK ("last_sequence" IS NULL OR (typeof("last_sequence") = 'text' AND "last_sequence" = CAST(CAST("last_sequence" AS INTEGER) AS TEXT))),
  "delivery_cooldown_until" TEXT,
  CONSTRAINT "chk_dining_report_sequence_id" CHECK ((`id` = 1)),
  CONSTRAINT "chk_dining_report_sequence_value" CHECK ((CAST(`last_sequence` AS INTEGER) >= 0))
);

CREATE TABLE "event_article_thumbnail_images" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "event_id" INTEGER NOT NULL CHECK ("event_id" IS NULL OR typeof("event_id") = 'integer') CHECK ("event_id" >= 0 AND "event_id" <= 4294967295),
  "thumbnail_image" TEXT COLLATE NOCASE CHECK (length("thumbnail_image") <= 255),
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  CONSTRAINT "FK_EVENT_ARTICLE_THUMBNAIL_IMAGES_ON_EVENT_ARTICLES" FOREIGN KEY ("event_id") REFERENCES "event_articles" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "event_article_thumbnail_images__FK_EVENT_ARTICLE_THUMBNAIL_IMAGES_ON_EVENT_ARTICLES" ON "event_article_thumbnail_images" ("event_id");

CREATE TABLE "event_articles" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "title" TEXT NOT NULL CHECK (length("title") <= 255),
  "content" TEXT NOT NULL,
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -2147483648 AND 2147483647),
  "hit" INTEGER NOT NULL DEFAULT ('0') CHECK ("hit" IS NULL OR typeof("hit") = 'integer') CHECK ("hit" BETWEEN -2147483648 AND 2147483647),
  "ip" TEXT NOT NULL CHECK (length("ip") <= 45),
  "start_date" TEXT NOT NULL,
  "end_date" TEXT NOT NULL,
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "event_articles__idx_is_deleted" ON "event_articles" ("is_deleted");

CREATE INDEX "event_articles__idx_timestamp" ON "event_articles" ("created_at");

CREATE UNIQUE INDEX "event_articles__pk" ON "event_articles" ("id");

CREATE TRIGGER "event_articles__updated_at_on_update" AFTER UPDATE ON "event_articles" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."title" IS NOT OLD."title" OR NEW."content" IS NOT OLD."content" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."hit" IS NOT OLD."hit" OR NEW."ip" IS NOT OLD."ip" OR NEW."start_date" IS NOT OLD."start_date" OR NEW."end_date" IS NOT OLD."end_date" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "event_articles" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "event_articles_view_logs" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "event_articles_id" INTEGER NOT NULL CHECK ("event_articles_id" IS NULL OR typeof("event_articles_id") = 'integer') CHECK ("event_articles_id" >= 0 AND "event_articles_id" <= 4294967295),
  "user_id" INTEGER CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "expired_at" TEXT,
  "ip" TEXT NOT NULL CHECK (length("ip") <= 45)
);

CREATE UNIQUE INDEX "event_articles_view_logs__idx_unique" ON "event_articles_view_logs" ("event_articles_id", "user_id");

CREATE TABLE "general_education_area" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 20)
);

CREATE TABLE "koin_notice" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" >= 0 AND "article_id" <= 4294967295),
  "admin_id" INTEGER NOT NULL CHECK ("admin_id" IS NULL OR typeof("admin_id") = 'integer') CHECK ("admin_id" >= 0 AND "admin_id" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "koin_notice_ibfk_1" FOREIGN KEY ("article_id") REFERENCES "new_articles" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "koin_notice_ibfk_2" FOREIGN KEY ("admin_id") REFERENCES "admins" ("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "koin_notice__admin_id" ON "koin_notice" ("admin_id");

CREATE INDEX "koin_notice__article_id" ON "koin_notice" ("article_id");

CREATE TRIGGER "koin_notice__updated_at_on_update" AFTER UPDATE ON "koin_notice" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."article_id" IS NOT OLD."article_id" OR NEW."admin_id" IS NOT OLD."admin_id" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "koin_notice" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "lands" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "internal_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("internal_name") <= 50),
  "size" TEXT COLLATE NOCASE CHECK (length("size") <= 255),
  "room_type" TEXT COLLATE NOCASE CHECK (length("room_type") <= 255),
  "latitude" TEXT COLLATE NOCASE CHECK (length("latitude") <= 255),
  "longitude" TEXT COLLATE NOCASE CHECK (length("longitude") <= 255),
  "phone" TEXT COLLATE NOCASE CHECK (length("phone") <= 255),
  "image_urls" TEXT COLLATE NOCASE,
  "address" TEXT COLLATE NOCASE,
  "description" TEXT COLLATE NOCASE,
  "floor" INTEGER CHECK ("floor" IS NULL OR typeof("floor") = 'integer') CHECK ("floor" >= 0 AND "floor" <= 4294967295),
  "deposit" TEXT COLLATE NOCASE CHECK (length("deposit") <= 255),
  "monthly_fee" TEXT COLLATE NOCASE CHECK (length("monthly_fee") <= 255),
  "charter_fee" TEXT COLLATE NOCASE CHECK (length("charter_fee") <= 255),
  "management_fee" TEXT COLLATE NOCASE CHECK (length("management_fee") <= 255),
  "opt_refrigerator" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_refrigerator" IS NULL OR typeof("opt_refrigerator") = 'integer') CHECK ("opt_refrigerator" IN (0, 1)),
  "opt_closet" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_closet" IS NULL OR typeof("opt_closet") = 'integer') CHECK ("opt_closet" IN (0, 1)),
  "opt_tv" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_tv" IS NULL OR typeof("opt_tv") = 'integer') CHECK ("opt_tv" IN (0, 1)),
  "opt_microwave" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_microwave" IS NULL OR typeof("opt_microwave") = 'integer') CHECK ("opt_microwave" IN (0, 1)),
  "opt_gas_range" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_gas_range" IS NULL OR typeof("opt_gas_range") = 'integer') CHECK ("opt_gas_range" IN (0, 1)),
  "opt_induction" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_induction" IS NULL OR typeof("opt_induction") = 'integer') CHECK ("opt_induction" IN (0, 1)),
  "opt_water_purifier" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_water_purifier" IS NULL OR typeof("opt_water_purifier") = 'integer') CHECK ("opt_water_purifier" IN (0, 1)),
  "opt_air_conditioner" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_air_conditioner" IS NULL OR typeof("opt_air_conditioner") = 'integer') CHECK ("opt_air_conditioner" IN (0, 1)),
  "opt_washer" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_washer" IS NULL OR typeof("opt_washer") = 'integer') CHECK ("opt_washer" IN (0, 1)),
  "opt_bed" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_bed" IS NULL OR typeof("opt_bed") = 'integer') CHECK ("opt_bed" IN (0, 1)),
  "opt_desk" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_desk" IS NULL OR typeof("opt_desk") = 'integer') CHECK ("opt_desk" IN (0, 1)),
  "opt_shoe_closet" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_shoe_closet" IS NULL OR typeof("opt_shoe_closet") = 'integer') CHECK ("opt_shoe_closet" IN (0, 1)),
  "opt_electronic_door_locks" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_electronic_door_locks" IS NULL OR typeof("opt_electronic_door_locks") = 'integer') CHECK ("opt_electronic_door_locks" IN (0, 1)),
  "opt_bidet" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_bidet" IS NULL OR typeof("opt_bidet") = 'integer') CHECK ("opt_bidet" IN (0, 1)),
  "opt_veranda" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_veranda" IS NULL OR typeof("opt_veranda") = 'integer') CHECK ("opt_veranda" IN (0, 1)),
  "opt_elevator" INTEGER NOT NULL DEFAULT ('0') CHECK ("opt_elevator" IS NULL OR typeof("opt_elevator") = 'integer') CHECK ("opt_elevator" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "lands__ix_internalname" ON "lands" ("internal_name");

CREATE UNIQUE INDEX "lands__ux_name" ON "lands" ("name");

CREATE TRIGGER "lands__updated_at_on_update" AFTER UPDATE ON "lands" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."name" IS NOT OLD."name" OR NEW."internal_name" IS NOT OLD."internal_name" OR NEW."size" IS NOT OLD."size" OR NEW."room_type" IS NOT OLD."room_type" OR NEW."latitude" IS NOT OLD."latitude" OR NEW."longitude" IS NOT OLD."longitude" OR NEW."phone" IS NOT OLD."phone" OR NEW."image_urls" IS NOT OLD."image_urls" OR NEW."address" IS NOT OLD."address" OR NEW."description" IS NOT OLD."description" OR NEW."floor" IS NOT OLD."floor" OR NEW."deposit" IS NOT OLD."deposit" OR NEW."monthly_fee" IS NOT OLD."monthly_fee" OR NEW."charter_fee" IS NOT OLD."charter_fee" OR NEW."management_fee" IS NOT OLD."management_fee" OR NEW."opt_refrigerator" IS NOT OLD."opt_refrigerator" OR NEW."opt_closet" IS NOT OLD."opt_closet" OR NEW."opt_tv" IS NOT OLD."opt_tv" OR NEW."opt_microwave" IS NOT OLD."opt_microwave" OR NEW."opt_gas_range" IS NOT OLD."opt_gas_range" OR NEW."opt_induction" IS NOT OLD."opt_induction" OR NEW."opt_water_purifier" IS NOT OLD."opt_water_purifier" OR NEW."opt_air_conditioner" IS NOT OLD."opt_air_conditioner" OR NEW."opt_washer" IS NOT OLD."opt_washer" OR NEW."opt_bed" IS NOT OLD."opt_bed" OR NEW."opt_desk" IS NOT OLD."opt_desk" OR NEW."opt_shoe_closet" IS NOT OLD."opt_shoe_closet" OR NEW."opt_electronic_door_locks" IS NOT OLD."opt_electronic_door_locks" OR NEW."opt_bidet" IS NOT OLD."opt_bidet" OR NEW."opt_veranda" IS NOT OLD."opt_veranda" OR NEW."opt_elevator" IS NOT OLD."opt_elevator" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "lands" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "lectures" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "semester_date" TEXT COLLATE NOCASE NOT NULL CHECK (length("semester_date") <= 10),
  "code" TEXT COLLATE NOCASE NOT NULL CHECK (length("code") <= 10),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 50),
  "grades" TEXT COLLATE NOCASE NOT NULL CHECK (length("grades") <= 2),
  "class" TEXT COLLATE NOCASE NOT NULL CHECK (length("class") <= 3),
  "regular_number" TEXT COLLATE NOCASE NOT NULL CHECK (length("regular_number") <= 4),
  "department" TEXT COLLATE NOCASE NOT NULL CHECK (length("department") <= 30),
  "target" TEXT COLLATE NOCASE NOT NULL CHECK (length("target") <= 200),
  "professor" TEXT COLLATE NOCASE CHECK (length("professor") <= 30),
  "is_english" TEXT COLLATE NOCASE NOT NULL CHECK (length("is_english") <= 2),
  "design_score" TEXT COLLATE NOCASE NOT NULL CHECK (length("design_score") <= 2),
  "is_elearning" TEXT COLLATE NOCASE NOT NULL CHECK (length("is_elearning") <= 2),
  "class_time" TEXT COLLATE NOCASE NOT NULL CHECK (length("class_time") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "lectures__idx_lecture_semester_code" ON "lectures" ("semester_date", "code");

CREATE TRIGGER "lectures__updated_at_on_update" AFTER UPDATE ON "lectures" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."semester_date" IS NOT OLD."semester_date" OR NEW."code" IS NOT OLD."code" OR NEW."name" IS NOT OLD."name" OR NEW."grades" IS NOT OLD."grades" OR NEW."class" IS NOT OLD."class" OR NEW."regular_number" IS NOT OLD."regular_number" OR NEW."department" IS NOT OLD."department" OR NEW."target" IS NOT OLD."target" OR NEW."professor" IS NOT OLD."professor" OR NEW."is_english" IS NOT OLD."is_english" OR NEW."design_score" IS NOT OLD."design_score" OR NEW."is_elearning" IS NOT OLD."is_elearning" OR NEW."class_time" IS NOT OLD."class_time" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "lectures" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "lost_item_articles" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" >= 0 AND "article_id" <= 4294967295),
  "author_id" INTEGER CHECK ("author_id" IS NULL OR typeof("author_id") = 'integer') CHECK ("author_id" >= 0 AND "author_id" <= 4294967295),
  "category" TEXT COLLATE NOCASE NOT NULL CHECK (length("category") <= 255),
  "found_place" TEXT COLLATE NOCASE NOT NULL CHECK (length("found_place") <= 255),
  "found_date" TEXT NOT NULL,
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "is_found" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_found" IS NULL OR typeof("is_found") = 'integer') CHECK ("is_found" IN (0, 1)),
  "found_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "type" TEXT COLLATE NOCASE NOT NULL DEFAULT ('LOST') CHECK (length("type") <= 100),
  "is_council" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_council" IS NULL OR typeof("is_council") = 'integer') CHECK ("is_council" IN (0, 1)),
  CONSTRAINT "lost_item_article_author_fk_id" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "lost_item_article_fk_id" FOREIGN KEY ("article_id") REFERENCES "new_articles" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "lost_item_articles__lost_item_article_author_fk_id" ON "lost_item_articles" ("author_id");

CREATE INDEX "lost_item_articles__lost_item_article_fk_id" ON "lost_item_articles" ("article_id");

CREATE TRIGGER "lost_item_articles__updated_at_on_update" AFTER UPDATE ON "lost_item_articles" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."article_id" IS NOT OLD."article_id" OR NEW."author_id" IS NOT OLD."author_id" OR NEW."category" IS NOT OLD."category" OR NEW."found_place" IS NOT OLD."found_place" OR NEW."found_date" IS NOT OLD."found_date" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."is_found" IS NOT OLD."is_found" OR NEW."found_at" IS NOT OLD."found_at" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."type" IS NOT OLD."type" OR NEW."is_council" IS NOT OLD."is_council") BEGIN UPDATE "lost_item_articles" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "lost_item_images" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "lost_item_id" INTEGER NOT NULL CHECK ("lost_item_id" IS NULL OR typeof("lost_item_id") = 'integer') CHECK ("lost_item_id" >= 0 AND "lost_item_id" <= 4294967295),
  "image_url" TEXT COLLATE NOCASE NOT NULL CHECK (length("image_url") <= 255),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "lost_item_image_fk_id" FOREIGN KEY ("lost_item_id") REFERENCES "lost_item_articles" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "lost_item_images__lost_item_image_fk_id" ON "lost_item_images" ("lost_item_id");

CREATE TRIGGER "lost_item_images__updated_at_on_update" AFTER UPDATE ON "lost_item_images" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."lost_item_id" IS NOT OLD."lost_item_id" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "lost_item_images" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "lost_item_reports" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "lost_id" INTEGER NOT NULL CHECK ("lost_id" IS NULL OR typeof("lost_id") = 'integer') CHECK ("lost_id" >= 0 AND "lost_id" <= 4294967295),
  "title" TEXT COLLATE NOCASE NOT NULL CHECK (length("title") <= 50),
  "content" TEXT COLLATE NOCASE NOT NULL CHECK (length("content") <= 255),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "status" TEXT COLLATE NOCASE DEFAULT ('UNHANDLED') CHECK (length("status") <= 25),
  "created_at" TEXT DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "lost_item_reports_ibfk_1" FOREIGN KEY ("lost_id") REFERENCES "lost_item_articles" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "lost_item_reports_ibfk_2" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "lost_item_reports__lost_id" ON "lost_item_reports" ("lost_id");

CREATE INDEX "lost_item_reports__user_id" ON "lost_item_reports" ("user_id");

CREATE TRIGGER "lost_item_reports__updated_at_on_update" AFTER UPDATE ON "lost_item_reports" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."lost_id" IS NOT OLD."lost_id" OR NEW."title" IS NOT OLD."title" OR NEW."content" IS NOT OLD."content" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."status" IS NOT OLD."status" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "lost_item_reports" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "major" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT COLLATE NOCASE CHECK (length("name") <= 255),
  "department_id" INTEGER NOT NULL CHECK ("department_id" IS NULL OR typeof("department_id") = 'integer') CHECK ("department_id" >= 0 AND "department_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "major_ibfk_1" FOREIGN KEY ("department_id") REFERENCES "department" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "major__department_id" ON "major" ("department_id");

CREATE UNIQUE INDEX "major__unique_name_department" ON "major" ("name", "department_id");

CREATE TRIGGER "major__updated_at_on_update" AFTER UPDATE ON "major" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."name" IS NOT OLD."name" OR NEW."department_id" IS NOT OLD."department_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "major" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "members" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -2147483648 AND 2147483647),
  "name" TEXT NOT NULL CHECK (length("name") <= 50),
  "student_number" TEXT CHECK (length("student_number") <= 255),
  "track_id" INTEGER NOT NULL CHECK ("track_id" IS NULL OR typeof("track_id") = 'integer') CHECK ("track_id" >= 0 AND "track_id" <= 4294967295),
  "position" TEXT NOT NULL CHECK (length("position") <= 255),
  "email" TEXT CHECK (length("email") <= 100),
  "image_url" TEXT,
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "members__updated_at_on_update" AFTER UPDATE ON "members" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."name" IS NOT OLD."name" OR NEW."student_number" IS NOT OLD."student_number" OR NEW."track_id" IS NOT OLD."track_id" OR NEW."position" IS NOT OLD."position" OR NEW."email" IS NOT OLD."email" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "members" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "migrations" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "migration" TEXT COLLATE NOCASE NOT NULL CHECK (length("migration") <= 255),
  "batch" INTEGER NOT NULL CHECK ("batch" IS NULL OR typeof("batch") = 'integer') CHECK ("batch" BETWEEN -2147483648 AND 2147483647)
);

CREATE TABLE "new_articles" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "board_id" INTEGER NOT NULL CHECK ("board_id" IS NULL OR typeof("board_id") = 'integer') CHECK ("board_id" >= 0 AND "board_id" <= 4294967295),
  "title" TEXT COLLATE NOCASE NOT NULL CHECK (length("title") <= 255),
  "content" TEXT COLLATE NOCASE,
  "hit" INTEGER NOT NULL DEFAULT ('0') CHECK ("hit" IS NULL OR typeof("hit") = 'integer') CHECK ("hit" >= 0 AND "hit" <= 4294967295),
  "is_notice" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_notice" IS NULL OR typeof("is_notice") = 'integer') CHECK ("is_notice" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "FK_ARTICLES_ON_BOARD_ID" FOREIGN KEY ("board_id") REFERENCES "boards" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "new_articles__FK_ARTICLES_ON_BOARD_ID_idx" ON "new_articles" ("board_id");

CREATE INDEX "new_articles__idx_articles_deleted_notice" ON "new_articles" ("is_deleted", "is_notice");

CREATE TRIGGER "new_articles__updated_at_on_update" AFTER UPDATE ON "new_articles" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."board_id" IS NOT OLD."board_id" OR NEW."title" IS NOT OLD."title" OR NEW."content" IS NOT OLD."content" OR NEW."hit" IS NOT OLD."hit" OR NEW."is_notice" IS NOT OLD."is_notice" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "new_articles" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "new_koin_articles" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -2147483648 AND 2147483647),
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" >= 0 AND "article_id" <= 4294967295),
  "user_id" INTEGER CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "FK_KOIN_ARTICLES_ON_ARTICLE_ID" FOREIGN KEY ("article_id") REFERENCES "new_articles" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "new_koin_articles__article_id_UNIQUE" ON "new_koin_articles" ("article_id");

CREATE INDEX "new_koin_articles__FK_KOIN_ARTICLES_ON_ARTICLE_ID_idx" ON "new_koin_articles" ("article_id");

CREATE TRIGGER "new_koin_articles__updated_at_on_update" AFTER UPDATE ON "new_koin_articles" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."article_id" IS NOT OLD."article_id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "new_koin_articles" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "new_koreatech_articles" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" >= 0 AND "article_id" <= 4294967295),
  "author" TEXT COLLATE NOCASE NOT NULL CHECK (length("author") <= 50),
  "portal_num" INTEGER NOT NULL CHECK ("portal_num" IS NULL OR typeof("portal_num") = 'integer') CHECK ("portal_num" >= 0 AND "portal_num" <= 4294967295),
  "portal_hit" INTEGER NOT NULL DEFAULT ('0') CHECK ("portal_hit" IS NULL OR typeof("portal_hit") = 'integer') CHECK ("portal_hit" >= 0 AND "portal_hit" <= 4294967295),
  "url" TEXT COLLATE NOCASE NOT NULL CHECK (length("url") <= 255),
  "registered_at" TEXT,
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "FK_KOREATECH_ARTICLES_ON_ARTICLE_ID" FOREIGN KEY ("article_id") REFERENCES "new_articles" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "new_koreatech_articles__article_id_UNIQUE" ON "new_koreatech_articles" ("article_id");

CREATE INDEX "new_koreatech_articles__FK_KOREATECH_ARTICLES_ON_ARTICLE_ID_idx" ON "new_koreatech_articles" ("article_id");

CREATE TRIGGER "new_koreatech_articles__updated_at_on_update" AFTER UPDATE ON "new_koreatech_articles" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."article_id" IS NOT OLD."article_id" OR NEW."author" IS NOT OLD."author" OR NEW."portal_num" IS NOT OLD."portal_num" OR NEW."portal_hit" IS NOT OLD."portal_hit" OR NEW."url" IS NOT OLD."url" OR NEW."registered_at" IS NOT OLD."registered_at" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "new_koreatech_articles" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "notification" (
  "id" TEXT PRIMARY KEY NOT NULL CHECK ("id" IS NULL OR (typeof("id") = 'text' AND "id" = CAST(CAST("id" AS INTEGER) AS TEXT))),
  "app_path" TEXT COLLATE NOCASE CHECK (length("app_path") <= 255),
  "title" TEXT COLLATE NOCASE CHECK (length("title") <= 255),
  "message" TEXT COLLATE NOCASE CHECK (length("message") <= 255),
  "image_url" TEXT COLLATE NOCASE CHECK (length("image_url") <= 255),
  "type" TEXT COLLATE NOCASE CHECK (length("type") <= 255),
  "users_id" INTEGER NOT NULL CHECK ("users_id" IS NULL OR typeof("users_id") = 'integer') CHECK ("users_id" >= 0 AND "users_id" <= 4294967295),
  "is_read" INTEGER NOT NULL CHECK ("is_read" IS NULL OR typeof("is_read") = 'integer') CHECK ("is_read" IN (0, 1)),
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "scheme_uri" TEXT COLLATE NOCASE CHECK (length("scheme_uri") <= 255),
  "is_push_success" INTEGER CHECK ("is_push_success" IS NULL OR typeof("is_push_success") = 'integer') CHECK ("is_push_success" IN (0, 1)),
  "fcm_error_code" TEXT COLLATE NOCASE CHECK (length("fcm_error_code") <= 100),
  "fcm_messaging_error_code" TEXT COLLATE NOCASE CHECK (length("fcm_messaging_error_code") <= 100),
  CONSTRAINT "FK_NOTIFICATION_ON_USER FOREIGN KEY" FOREIGN KEY ("users_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "notification__FK_NOTIFICATION_ON_USER FOREIGN KEY" ON "notification" ("users_id");

CREATE INDEX "notification__PRIMARY_numeric" ON "notification" (CAST("id" AS INTEGER));

CREATE TABLE "notification_subscribe" (
  "id" TEXT PRIMARY KEY NOT NULL CHECK ("id" IS NULL OR (typeof("id") = 'text' AND "id" = CAST(CAST("id" AS INTEGER) AS TEXT))),
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "subscribe_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("subscribe_type") <= 255),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "detail_type" TEXT COLLATE NOCASE CHECK (length("detail_type") <= 255),
  CONSTRAINT "FK_NOTIFICATION_SUBSCRIBE_ON_USER" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "notification_subscribe__unique_user_id_subscribe_type_detail_type" ON "notification_subscribe" ("user_id", "subscribe_type", "detail_type");

CREATE INDEX "notification_subscribe__PRIMARY_numeric" ON "notification_subscribe" (CAST("id" AS INTEGER));

CREATE TABLE "order" (
  "id" TEXT COLLATE NOCASE PRIMARY KEY NOT NULL CHECK (length("id") <= 64),
  "order_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("order_type") <= 10),
  "phone_number" TEXT COLLATE NOCASE NOT NULL CHECK (length("phone_number") <= 20),
  "total_product_price" INTEGER CHECK ("total_product_price" IS NULL OR typeof("total_product_price") = 'integer') CHECK ("total_product_price" >= 0 AND "total_product_price" <= 4294967295),
  "total_price" INTEGER CHECK ("total_price" IS NULL OR typeof("total_price") = 'integer') CHECK ("total_price" >= 0 AND "total_price" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "orderable_shop_id" INTEGER CHECK ("orderable_shop_id" IS NULL OR typeof("orderable_shop_id") = 'integer') CHECK ("orderable_shop_id" >= 0 AND "orderable_shop_id" <= 4294967295),
  "user_id" INTEGER CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_order_shop" FOREIGN KEY ("orderable_shop_id") REFERENCES "orderable_shop" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "fk_order_user_withdrawal" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE INDEX "order__idx_orderable_shop_id" ON "order" ("orderable_shop_id");

CREATE INDEX "order__idx_user_id" ON "order" ("user_id");

CREATE TRIGGER "order__updated_at_on_update" AFTER UPDATE ON "order" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."order_type" IS NOT OLD."order_type" OR NEW."phone_number" IS NOT OLD."phone_number" OR NEW."total_product_price" IS NOT OLD."total_product_price" OR NEW."total_price" IS NOT OLD."total_price" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."orderable_shop_id" IS NOT OLD."orderable_shop_id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "order" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "order_delivery" (
  "order_id" TEXT COLLATE NOCASE PRIMARY KEY NOT NULL CHECK (length("order_id") <= 64),
  "address" TEXT COLLATE NOCASE NOT NULL CHECK (length("address") <= 100),
  "to_owner" TEXT COLLATE NOCASE CHECK (length("to_owner") <= 50),
  "to_rider" TEXT COLLATE NOCASE CHECK (length("to_rider") <= 50),
  "delivery_tip" INTEGER NOT NULL CHECK ("delivery_tip" IS NULL OR typeof("delivery_tip") = 'integer') CHECK ("delivery_tip" >= 0 AND "delivery_tip" <= 4294967295),
  "provide_cutlery" INTEGER NOT NULL DEFAULT ('0') CHECK ("provide_cutlery" IS NULL OR typeof("provide_cutlery") = 'integer') CHECK ("provide_cutlery" IN (0, 1)),
  CONSTRAINT "fk_order_delivery_order" FOREIGN KEY ("order_id") REFERENCES "order" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE TABLE "order_delivery_v2" (
  "order_id" INTEGER PRIMARY KEY NOT NULL CHECK ("order_id" IS NULL OR typeof("order_id") = 'integer') CHECK ("order_id" >= 0 AND "order_id" <= 4294967295),
  "address" TEXT COLLATE NOCASE NOT NULL,
  "address_detail" TEXT COLLATE NOCASE,
  "latitude" TEXT CHECK (ltrim("latitude", '-') GLOB '*[0-9]*' AND ltrim("latitude", '-') NOT GLOB '*[^0-9.]*' AND length("latitude") - length(replace("latitude", '-', '')) <= 1 AND length("latitude") - length(replace("latitude", '.', '')) <= 1 AND abs(CAST("latitude" AS REAL)) < 100 AND (instr("latitude", '.') = 0 OR length("latitude") - instr("latitude", '.') <= 8)),
  "longitude" TEXT CHECK (ltrim("longitude", '-') GLOB '*[0-9]*' AND ltrim("longitude", '-') NOT GLOB '*[^0-9.]*' AND length("longitude") - length(replace("longitude", '-', '')) <= 1 AND length("longitude") - length(replace("longitude", '.', '')) <= 1 AND abs(CAST("longitude" AS REAL)) < 1000 AND (instr("longitude", '.') = 0 OR length("longitude") - instr("longitude", '.') <= 8)),
  "to_owner" TEXT COLLATE NOCASE NOT NULL CHECK (length("to_owner") <= 50),
  "to_rider" TEXT COLLATE NOCASE NOT NULL CHECK (length("to_rider") <= 50),
  "delivery_tip" INTEGER NOT NULL CHECK ("delivery_tip" IS NULL OR typeof("delivery_tip") = 'integer') CHECK ("delivery_tip" >= 0 AND "delivery_tip" <= 4294967295),
  "provide_cutlery" INTEGER NOT NULL DEFAULT ('0') CHECK ("provide_cutlery" IS NULL OR typeof("provide_cutlery") = 'integer') CHECK ("provide_cutlery" IN (0, 1)),
  "dispatched_at" TEXT,
  "completed_at" TEXT,
  "estimated_arrival_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_order_delivery_order_v2" FOREIGN KEY ("order_id") REFERENCES "order_v2" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE TRIGGER "order_delivery_v2__updated_at_on_update" AFTER UPDATE ON "order_delivery_v2" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."order_id" IS NOT OLD."order_id" OR NEW."address" IS NOT OLD."address" OR NEW."address_detail" IS NOT OLD."address_detail" OR NEW."latitude" IS NOT OLD."latitude" OR NEW."longitude" IS NOT OLD."longitude" OR NEW."to_owner" IS NOT OLD."to_owner" OR NEW."to_rider" IS NOT OLD."to_rider" OR NEW."delivery_tip" IS NOT OLD."delivery_tip" OR NEW."provide_cutlery" IS NOT OLD."provide_cutlery" OR NEW."dispatched_at" IS NOT OLD."dispatched_at" OR NEW."completed_at" IS NOT OLD."completed_at" OR NEW."estimated_arrival_at" IS NOT OLD."estimated_arrival_at" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "order_delivery_v2" SET "updated_at" = CURRENT_TIMESTAMP WHERE "order_id" = NEW."order_id"; END;

CREATE TABLE "order_menu" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "menu_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("menu_name") <= 255),
  "menu_option_name" TEXT COLLATE NOCASE CHECK (length("menu_option_name") <= 255),
  "menu_price" INTEGER NOT NULL CHECK ("menu_price" IS NULL OR typeof("menu_price") = 'integer') CHECK ("menu_price" >= 0 AND "menu_price" <= 4294967295),
  "quantity" INTEGER NOT NULL CHECK ("quantity" IS NULL OR typeof("quantity") = 'integer') CHECK ("quantity" >= 0 AND "quantity" <= 4294967295),
  "order_id" TEXT COLLATE NOCASE NOT NULL CHECK (length("order_id") <= 64),
  "menu_price_name" TEXT COLLATE NOCASE CHECK (length("menu_price_name") <= 255),
  CONSTRAINT "fk_order_menu_order" FOREIGN KEY ("order_id") REFERENCES "order" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "order_menu__fk_order_menu_order" ON "order_menu" ("order_id");

CREATE TABLE "order_menu_option" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "option_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("option_name") <= 255),
  "option_price" INTEGER NOT NULL CHECK ("option_price" IS NULL OR typeof("option_price") = 'integer') CHECK ("option_price" >= 0 AND "option_price" <= 4294967295),
  "quantity" INTEGER NOT NULL CHECK ("quantity" IS NULL OR typeof("quantity") = 'integer') CHECK ("quantity" >= 0 AND "quantity" <= 4294967295),
  "order_menu_id" INTEGER NOT NULL CHECK ("order_menu_id" IS NULL OR typeof("order_menu_id") = 'integer') CHECK ("order_menu_id" >= 0 AND "order_menu_id" <= 4294967295),
  "option_group_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("option_group_name") <= 255),
  CONSTRAINT "fk_order_menu_option_menu" FOREIGN KEY ("order_menu_id") REFERENCES "order_menu" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "order_menu_option__fk_order_menu_option_menu" ON "order_menu_option" ("order_menu_id");

CREATE TABLE "order_menu_option_v2" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "order_menu_id" INTEGER NOT NULL CHECK ("order_menu_id" IS NULL OR typeof("order_menu_id") = 'integer') CHECK ("order_menu_id" >= 0 AND "order_menu_id" <= 4294967295),
  "orderable_shop_menu_option_group_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_option_group_id" IS NULL OR typeof("orderable_shop_menu_option_group_id") = 'integer') CHECK ("orderable_shop_menu_option_group_id" >= 0 AND "orderable_shop_menu_option_group_id" <= 4294967295),
  "orderable_shop_menu_option_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_option_id" IS NULL OR typeof("orderable_shop_menu_option_id") = 'integer') CHECK ("orderable_shop_menu_option_id" >= 0 AND "orderable_shop_menu_option_id" <= 4294967295),
  "group_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("group_name") <= 255),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "price" INTEGER NOT NULL CHECK ("price" IS NULL OR typeof("price") = 'integer') CHECK ("price" >= 0 AND "price" <= 4294967295),
  "quantity" INTEGER NOT NULL CHECK ("quantity" IS NULL OR typeof("quantity") = 'integer') CHECK ("quantity" >= 0 AND "quantity" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_order_menu_option_menu_v2" FOREIGN KEY ("order_menu_id") REFERENCES "order_menu_v2" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "order_menu_option_v2__fk_order_menu_option_menu_v2" ON "order_menu_option_v2" ("order_menu_id");

CREATE TRIGGER "order_menu_option_v2__updated_at_on_update" AFTER UPDATE ON "order_menu_option_v2" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."order_menu_id" IS NOT OLD."order_menu_id" OR NEW."orderable_shop_menu_option_group_id" IS NOT OLD."orderable_shop_menu_option_group_id" OR NEW."orderable_shop_menu_option_id" IS NOT OLD."orderable_shop_menu_option_id" OR NEW."group_name" IS NOT OLD."group_name" OR NEW."name" IS NOT OLD."name" OR NEW."price" IS NOT OLD."price" OR NEW."quantity" IS NOT OLD."quantity" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "order_menu_option_v2" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "order_menu_v2" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "order_id" INTEGER NOT NULL CHECK ("order_id" IS NULL OR typeof("order_id") = 'integer') CHECK ("order_id" >= 0 AND "order_id" <= 4294967295),
  "orderable_shop_menu_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_id" IS NULL OR typeof("orderable_shop_menu_id") = 'integer') CHECK ("orderable_shop_menu_id" >= 0 AND "orderable_shop_menu_id" <= 4294967295),
  "orderable_shop_menu_price_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_price_id" IS NULL OR typeof("orderable_shop_menu_price_id") = 'integer') CHECK ("orderable_shop_menu_price_id" >= 0 AND "orderable_shop_menu_price_id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "price_name" TEXT COLLATE NOCASE CHECK (length("price_name") <= 255),
  "price" INTEGER NOT NULL CHECK ("price" IS NULL OR typeof("price") = 'integer') CHECK ("price" >= 0 AND "price" <= 4294967295),
  "quantity" INTEGER NOT NULL CHECK ("quantity" IS NULL OR typeof("quantity") = 'integer') CHECK ("quantity" >= 0 AND "quantity" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_order_menu_order_v2" FOREIGN KEY ("order_id") REFERENCES "order_v2" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "order_menu_v2__fk_order_menu_order_v2" ON "order_menu_v2" ("order_id");

CREATE TRIGGER "order_menu_v2__updated_at_on_update" AFTER UPDATE ON "order_menu_v2" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."order_id" IS NOT OLD."order_id" OR NEW."orderable_shop_menu_id" IS NOT OLD."orderable_shop_menu_id" OR NEW."orderable_shop_menu_price_id" IS NOT OLD."orderable_shop_menu_price_id" OR NEW."name" IS NOT OLD."name" OR NEW."price_name" IS NOT OLD."price_name" OR NEW."price" IS NOT OLD."price" OR NEW."quantity" IS NOT OLD."quantity" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "order_menu_v2" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "order_takeout" (
  "order_id" TEXT COLLATE NOCASE PRIMARY KEY NOT NULL CHECK (length("order_id") <= 64),
  "to_owner" TEXT COLLATE NOCASE CHECK (length("to_owner") <= 50),
  "provide_cutlery" INTEGER NOT NULL DEFAULT ('0') CHECK ("provide_cutlery" IS NULL OR typeof("provide_cutlery") = 'integer') CHECK ("provide_cutlery" IN (0, 1)),
  CONSTRAINT "fk_order_pack_order" FOREIGN KEY ("order_id") REFERENCES "order" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE TABLE "order_takeout_v2" (
  "order_id" INTEGER PRIMARY KEY NOT NULL CHECK ("order_id" IS NULL OR typeof("order_id") = 'integer') CHECK ("order_id" >= 0 AND "order_id" <= 4294967295),
  "to_owner" TEXT COLLATE NOCASE NOT NULL CHECK (length("to_owner") <= 50),
  "provide_cutlery" INTEGER NOT NULL DEFAULT ('0') CHECK ("provide_cutlery" IS NULL OR typeof("provide_cutlery") = 'integer') CHECK ("provide_cutlery" IN (0, 1)),
  "packaged_at" TEXT,
  "estimated_packaged_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_order_takeout_order_v2" FOREIGN KEY ("order_id") REFERENCES "order_v2" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE TRIGGER "order_takeout_v2__updated_at_on_update" AFTER UPDATE ON "order_takeout_v2" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."order_id" IS NOT OLD."order_id" OR NEW."to_owner" IS NOT OLD."to_owner" OR NEW."provide_cutlery" IS NOT OLD."provide_cutlery" OR NEW."packaged_at" IS NOT OLD."packaged_at" OR NEW."estimated_packaged_at" IS NOT OLD."estimated_packaged_at" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "order_takeout_v2" SET "updated_at" = CURRENT_TIMESTAMP WHERE "order_id" = NEW."order_id"; END;

CREATE TABLE "order_v2" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "pg_order_id" TEXT COLLATE NOCASE NOT NULL CHECK (length("pg_order_id") <= 64),
  "order_number" TEXT COLLATE NOCASE NOT NULL CHECK (length("order_number") <= 10),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "phone_number" TEXT COLLATE NOCASE NOT NULL CHECK (length("phone_number") <= 20),
  "orderable_shop_id" INTEGER NOT NULL CHECK ("orderable_shop_id" IS NULL OR typeof("orderable_shop_id") = 'integer') CHECK ("orderable_shop_id" >= 0 AND "orderable_shop_id" <= 4294967295),
  "orderable_shop_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("orderable_shop_name") <= 255),
  "orderable_shop_address" TEXT COLLATE NOCASE NOT NULL,
  "orderable_shop_address_detail" TEXT COLLATE NOCASE,
  "total_product_price" INTEGER NOT NULL CHECK ("total_product_price" IS NULL OR typeof("total_product_price") = 'integer') CHECK ("total_product_price" >= 0 AND "total_product_price" <= 4294967295),
  "discount_amount" INTEGER NOT NULL DEFAULT ('0') CHECK ("discount_amount" IS NULL OR typeof("discount_amount") = 'integer') CHECK ("discount_amount" >= 0 AND "discount_amount" <= 4294967295),
  "total_price" INTEGER NOT NULL CHECK ("total_price" IS NULL OR typeof("total_price") = 'integer') CHECK ("total_price" >= 0 AND "total_price" <= 4294967295),
  "order_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("order_type") <= 10),
  "status" TEXT COLLATE NOCASE NOT NULL CHECK (length("status") <= 10),
  "canceled_at" TEXT,
  "canceled_reason" TEXT COLLATE NOCASE CHECK (length("canceled_reason") <= 200),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX "order_v2__uk_order_v2_order_number" ON "order_v2" ("order_number");

CREATE TRIGGER "order_v2__updated_at_on_update" AFTER UPDATE ON "order_v2" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."pg_order_id" IS NOT OLD."pg_order_id" OR NEW."order_number" IS NOT OLD."order_number" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."phone_number" IS NOT OLD."phone_number" OR NEW."orderable_shop_id" IS NOT OLD."orderable_shop_id" OR NEW."orderable_shop_name" IS NOT OLD."orderable_shop_name" OR NEW."orderable_shop_address" IS NOT OLD."orderable_shop_address" OR NEW."orderable_shop_address_detail" IS NOT OLD."orderable_shop_address_detail" OR NEW."total_product_price" IS NOT OLD."total_product_price" OR NEW."discount_amount" IS NOT OLD."discount_amount" OR NEW."total_price" IS NOT OLD."total_price" OR NEW."order_type" IS NOT OLD."order_type" OR NEW."status" IS NOT OLD."status" OR NEW."canceled_at" IS NOT OLD."canceled_at" OR NEW."canceled_reason" IS NOT OLD."canceled_reason" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "order_v2" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "orderable_shop" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "delivery" INTEGER NOT NULL DEFAULT ('1') CHECK ("delivery" IS NULL OR typeof("delivery") = 'integer') CHECK ("delivery" IN (0, 1)),
  "takeout" INTEGER NOT NULL DEFAULT ('1') CHECK ("takeout" IS NULL OR typeof("takeout") = 'integer') CHECK ("takeout" IN (0, 1)),
  "service_event" INTEGER NOT NULL DEFAULT ('0') CHECK ("service_event" IS NULL OR typeof("service_event") = 'integer') CHECK ("service_event" IN (0, 1)),
  "minimum_order_amount" INTEGER NOT NULL CHECK ("minimum_order_amount" IS NULL OR typeof("minimum_order_amount") = 'integer') CHECK ("minimum_order_amount" >= 0 AND "minimum_order_amount" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "orderable_shop__idx_orderable_shop_filter_01" ON "orderable_shop" ("delivery", "takeout", "shop_id");

CREATE INDEX "orderable_shop__idx_orderable_shop_filter_02" ON "orderable_shop" ("minimum_order_amount", "delivery", "takeout", "shop_id");

CREATE INDEX "orderable_shop__idx_orderable_shop_minimum_order_amount" ON "orderable_shop" ("minimum_order_amount", "shop_id");

CREATE INDEX "orderable_shop__idx_orderable_shop_shop_id" ON "orderable_shop" ("shop_id");

CREATE UNIQUE INDEX "orderable_shop__shop_id" ON "orderable_shop" ("shop_id");

CREATE TRIGGER "orderable_shop__updated_at_on_update" AFTER UPDATE ON "orderable_shop" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."delivery" IS NOT OLD."delivery" OR NEW."takeout" IS NOT OLD."takeout" OR NEW."service_event" IS NOT OLD."service_event" OR NEW."minimum_order_amount" IS NOT OLD."minimum_order_amount" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "orderable_shop" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "orderable_shop_delivery_option" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "orderable_shop_id" INTEGER NOT NULL CHECK ("orderable_shop_id" IS NULL OR typeof("orderable_shop_id") = 'integer') CHECK ("orderable_shop_id" >= 0 AND "orderable_shop_id" <= 4294967295),
  "campus_delivery" INTEGER NOT NULL DEFAULT ('1') CHECK ("campus_delivery" IS NULL OR typeof("campus_delivery") = 'integer') CHECK ("campus_delivery" IN (0, 1)),
  "off_campus_delivery" INTEGER NOT NULL DEFAULT ('1') CHECK ("off_campus_delivery" IS NULL OR typeof("off_campus_delivery") = 'integer') CHECK ("off_campus_delivery" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "orderable_shop_delivery_option__updated_at_on_update" AFTER UPDATE ON "orderable_shop_delivery_option" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."orderable_shop_id" IS NOT OLD."orderable_shop_id" OR NEW."campus_delivery" IS NOT OLD."campus_delivery" OR NEW."off_campus_delivery" IS NOT OLD."off_campus_delivery" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "orderable_shop_delivery_option" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "orderable_shop_image" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "orderable_shop_id" INTEGER NOT NULL CHECK ("orderable_shop_id" IS NULL OR typeof("orderable_shop_id") = 'integer') CHECK ("orderable_shop_id" >= 0 AND "orderable_shop_id" <= 4294967295),
  "image_url" TEXT COLLATE NOCASE NOT NULL CHECK (length("image_url") <= 255),
  "is_thumbnail" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_thumbnail" IS NULL OR typeof("is_thumbnail") = 'integer') CHECK ("is_thumbnail" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "orderable_shop_image__idx_images_on_orderable_shop_id" ON "orderable_shop_image" ("orderable_shop_id");

CREATE INDEX "orderable_shop_image__idx_thumbnail_images" ON "orderable_shop_image" ("orderable_shop_id", "is_thumbnail");

CREATE TRIGGER "orderable_shop_image__updated_at_on_update" AFTER UPDATE ON "orderable_shop_image" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."orderable_shop_id" IS NOT OLD."orderable_shop_id" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."is_thumbnail" IS NOT OLD."is_thumbnail" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "orderable_shop_image" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "orderable_shop_menu" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "orderable_shop_id" INTEGER NOT NULL CHECK ("orderable_shop_id" IS NULL OR typeof("orderable_shop_id") = 'integer') CHECK ("orderable_shop_id" >= 0 AND "orderable_shop_id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "description" TEXT COLLATE NOCASE,
  "is_sold_out" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_sold_out" IS NULL OR typeof("is_sold_out") = 'integer') CHECK ("is_sold_out" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "orderable_shop_menu__idx_orderable_shop_menu_orderable_shop_id" ON "orderable_shop_menu" ("orderable_shop_id");

CREATE TRIGGER "orderable_shop_menu__updated_at_on_update" AFTER UPDATE ON "orderable_shop_menu" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."orderable_shop_id" IS NOT OLD."orderable_shop_id" OR NEW."name" IS NOT OLD."name" OR NEW."description" IS NOT OLD."description" OR NEW."is_sold_out" IS NOT OLD."is_sold_out" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "orderable_shop_menu" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "orderable_shop_menu_group" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "orderable_shop_id" INTEGER NOT NULL CHECK ("orderable_shop_id" IS NULL OR typeof("orderable_shop_id") = 'integer') CHECK ("orderable_shop_id" >= 0 AND "orderable_shop_id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "orderable_shop_menu_group__idx_orderable_shop_id" ON "orderable_shop_menu_group" ("orderable_shop_id");

CREATE TRIGGER "orderable_shop_menu_group__updated_at_on_update" AFTER UPDATE ON "orderable_shop_menu_group" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."orderable_shop_id" IS NOT OLD."orderable_shop_id" OR NEW."name" IS NOT OLD."name" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "orderable_shop_menu_group" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "orderable_shop_menu_group_map" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "orderable_shop_menu_group_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_group_id" IS NULL OR typeof("orderable_shop_menu_group_id") = 'integer') CHECK ("orderable_shop_menu_group_id" >= 0 AND "orderable_shop_menu_group_id" <= 4294967295),
  "orderable_shop_menu_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_id" IS NULL OR typeof("orderable_shop_menu_id") = 'integer') CHECK ("orderable_shop_menu_id" >= 0 AND "orderable_shop_menu_id" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "orderable_shop_menu_group_map__idx_map_on_menu_group_id" ON "orderable_shop_menu_group_map" ("orderable_shop_menu_group_id");

CREATE INDEX "orderable_shop_menu_group_map__idx_map_on_menu_id" ON "orderable_shop_menu_group_map" ("orderable_shop_menu_id");

CREATE TRIGGER "orderable_shop_menu_group_map__updated_at_on_update" AFTER UPDATE ON "orderable_shop_menu_group_map" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."orderable_shop_menu_group_id" IS NOT OLD."orderable_shop_menu_group_id" OR NEW."orderable_shop_menu_id" IS NOT OLD."orderable_shop_menu_id" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "orderable_shop_menu_group_map" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "orderable_shop_menu_images" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "orderable_shop_menu_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_id" IS NULL OR typeof("orderable_shop_menu_id") = 'integer') CHECK ("orderable_shop_menu_id" >= 0 AND "orderable_shop_menu_id" <= 4294967295),
  "image_url" TEXT COLLATE NOCASE NOT NULL CHECK (length("image_url") <= 255),
  "is_thumbnail" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_thumbnail" IS NULL OR typeof("is_thumbnail") = 'integer') CHECK ("is_thumbnail" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "orderable_shop_menu_images__idx_images_on_menu_id" ON "orderable_shop_menu_images" ("orderable_shop_menu_id");

CREATE TRIGGER "orderable_shop_menu_images__updated_at_on_update" AFTER UPDATE ON "orderable_shop_menu_images" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."orderable_shop_menu_id" IS NOT OLD."orderable_shop_menu_id" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."is_thumbnail" IS NOT OLD."is_thumbnail" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "orderable_shop_menu_images" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "orderable_shop_menu_option" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "orderable_shop_menu_option_group_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_option_group_id" IS NULL OR typeof("orderable_shop_menu_option_group_id") = 'integer') CHECK ("orderable_shop_menu_option_group_id" >= 0 AND "orderable_shop_menu_option_group_id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "price" INTEGER NOT NULL CHECK ("price" IS NULL OR typeof("price") = 'integer') CHECK ("price" >= 0 AND "price" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "orderable_shop_menu_option__idx_option_on_option_group_id" ON "orderable_shop_menu_option" ("orderable_shop_menu_option_group_id");

CREATE TRIGGER "orderable_shop_menu_option__updated_at_on_update" AFTER UPDATE ON "orderable_shop_menu_option" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."orderable_shop_menu_option_group_id" IS NOT OLD."orderable_shop_menu_option_group_id" OR NEW."name" IS NOT OLD."name" OR NEW."price" IS NOT OLD."price" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "orderable_shop_menu_option" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "orderable_shop_menu_option_group" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "orderable_shop_id" INTEGER NOT NULL CHECK ("orderable_shop_id" IS NULL OR typeof("orderable_shop_id") = 'integer') CHECK ("orderable_shop_id" >= 0 AND "orderable_shop_id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "description" TEXT COLLATE NOCASE,
  "is_required" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_required" IS NULL OR typeof("is_required") = 'integer') CHECK ("is_required" IN (0, 1)),
  "min_select" INTEGER NOT NULL DEFAULT ('0') CHECK ("min_select" IS NULL OR typeof("min_select") = 'integer') CHECK ("min_select" >= 0 AND "min_select" <= 4294967295),
  "max_select" INTEGER CHECK ("max_select" IS NULL OR typeof("max_select") = 'integer') CHECK ("max_select" >= 0 AND "max_select" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "orderable_shop_menu_option_group__idx_orderable_shop_id" ON "orderable_shop_menu_option_group" ("orderable_shop_id");

CREATE TRIGGER "orderable_shop_menu_option_group__updated_at_on_update" AFTER UPDATE ON "orderable_shop_menu_option_group" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."orderable_shop_id" IS NOT OLD."orderable_shop_id" OR NEW."name" IS NOT OLD."name" OR NEW."description" IS NOT OLD."description" OR NEW."is_required" IS NOT OLD."is_required" OR NEW."min_select" IS NOT OLD."min_select" OR NEW."max_select" IS NOT OLD."max_select" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "orderable_shop_menu_option_group" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "orderable_shop_menu_option_group_map" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "orderable_shop_menu_option_group_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_option_group_id" IS NULL OR typeof("orderable_shop_menu_option_group_id") = 'integer') CHECK ("orderable_shop_menu_option_group_id" >= 0 AND "orderable_shop_menu_option_group_id" <= 4294967295),
  "orderable_shop_menu_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_id" IS NULL OR typeof("orderable_shop_menu_id") = 'integer') CHECK ("orderable_shop_menu_id" >= 0 AND "orderable_shop_menu_id" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "orderable_shop_menu_option_group_map__idx_map_on_menu_id" ON "orderable_shop_menu_option_group_map" ("orderable_shop_menu_id");

CREATE INDEX "orderable_shop_menu_option_group_map__idx_map_on_option_group_id" ON "orderable_shop_menu_option_group_map" ("orderable_shop_menu_option_group_id");

CREATE TRIGGER "orderable_shop_menu_option_group_map__updated_at_on_update" AFTER UPDATE ON "orderable_shop_menu_option_group_map" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."orderable_shop_menu_option_group_id" IS NOT OLD."orderable_shop_menu_option_group_id" OR NEW."orderable_shop_menu_id" IS NOT OLD."orderable_shop_menu_id" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "orderable_shop_menu_option_group_map" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "orderable_shop_menu_price" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "orderable_shop_menu_id" INTEGER NOT NULL CHECK ("orderable_shop_menu_id" IS NULL OR typeof("orderable_shop_menu_id") = 'integer') CHECK ("orderable_shop_menu_id" >= 0 AND "orderable_shop_menu_id" <= 4294967295),
  "name" TEXT COLLATE NOCASE CHECK (length("name") <= 255),
  "price" INTEGER NOT NULL CHECK ("price" IS NULL OR typeof("price") = 'integer') CHECK ("price" >= 0 AND "price" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "orderable_shop_menu_price__idx_price_on_menu_id" ON "orderable_shop_menu_price" ("orderable_shop_menu_id");

CREATE TRIGGER "orderable_shop_menu_price__updated_at_on_update" AFTER UPDATE ON "orderable_shop_menu_price" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."orderable_shop_menu_id" IS NOT OLD."orderable_shop_menu_id" OR NEW."name" IS NOT OLD."name" OR NEW."price" IS NOT OLD."price" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "orderable_shop_menu_price" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "organizations" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -2147483648 AND 2147483647),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -2147483648 AND 2147483647),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 100),
  "location" TEXT COLLATE NOCASE NOT NULL CHECK (length("location") <= 255),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX "organizations__uk_organizations_user_id" ON "organizations" ("user_id");

CREATE TRIGGER "organizations__updated_at_on_update" AFTER UPDATE ON "organizations" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."name" IS NOT OLD."name" OR NEW."location" IS NOT OLD."location" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "organizations" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "owner_attachments" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "owner_id" INTEGER NOT NULL CHECK ("owner_id" IS NULL OR typeof("owner_id") = 'integer') CHECK ("owner_id" >= 0 AND "owner_id" <= 4294967295),
  "url" TEXT NOT NULL,
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "owner_shop_attachment_fk_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "owner_attachments__owner_shop_attachment_fk_owner_id" ON "owner_attachments" ("owner_id");

CREATE TRIGGER "owner_attachments__updated_at_on_update" AFTER UPDATE ON "owner_attachments" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."owner_id" IS NOT OLD."owner_id" OR NEW."url" IS NOT OLD."url" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "owner_attachments" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "owners" (
  "user_id" INTEGER PRIMARY KEY NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -2147483648 AND 2147483647),
  "company_registration_number" TEXT COLLATE NOCASE NOT NULL CHECK (length("company_registration_number") <= 12),
  "grant_shop" INTEGER DEFAULT ('0') CHECK ("grant_shop" IS NULL OR typeof("grant_shop") = 'integer') CHECK ("grant_shop" BETWEEN -128 AND 127),
  "grant_event" INTEGER DEFAULT ('0') CHECK ("grant_event" IS NULL OR typeof("grant_event") = 'integer') CHECK ("grant_event" BETWEEN -128 AND 127),
  "account" TEXT NOT NULL CHECK (length("account") <= 11)
);

CREATE UNIQUE INDEX "owners__account_UNIQUE" ON "owners" ("account");

CREATE UNIQUE INDEX "owners__company_registration_number_UNIQUE" ON "owners" ("company_registration_number");

CREATE TABLE "password_resets" (
  "email" TEXT COLLATE NOCASE NOT NULL CHECK (length("email") <= 255),
  "token" TEXT COLLATE NOCASE NOT NULL CHECK (length("token") <= 255),
  "created_at" TEXT
);

CREATE INDEX "password_resets__password_resets_email_index" ON "password_resets" ("email");

CREATE TABLE "payment" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "payment_key" TEXT COLLATE NOCASE NOT NULL CHECK (length("payment_key") <= 200),
  "amount" INTEGER NOT NULL CHECK ("amount" IS NULL OR typeof("amount") = 'integer') CHECK ("amount" >= 0 AND "amount" <= 4294967295),
  "status" TEXT COLLATE NOCASE NOT NULL CHECK (length("status") <= 30),
  "method" TEXT COLLATE NOCASE NOT NULL CHECK (length("method") <= 30),
  "requested_at" TEXT NOT NULL,
  "approved_at" TEXT NOT NULL,
  "order_id" TEXT COLLATE NOCASE NOT NULL CHECK (length("order_id") <= 64),
  CONSTRAINT "fk_payment_order" FOREIGN KEY ("order_id") REFERENCES "order" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "payment__fk_payment_order" ON "payment" ("order_id");

CREATE UNIQUE INDEX "payment__uq_payment_key" ON "payment" ("id");

CREATE TABLE "payment_cancel" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "transaction_key" TEXT COLLATE NOCASE NOT NULL CHECK (length("transaction_key") <= 64),
  "cancel_reason" TEXT COLLATE NOCASE NOT NULL CHECK (length("cancel_reason") <= 200),
  "cancel_amount" INTEGER NOT NULL CHECK ("cancel_amount" IS NULL OR typeof("cancel_amount") = 'integer') CHECK ("cancel_amount" >= 0 AND "cancel_amount" <= 4294967295),
  "canceled_at" TEXT NOT NULL,
  "payment_id" INTEGER NOT NULL CHECK ("payment_id" IS NULL OR typeof("payment_id") = 'integer') CHECK ("payment_id" >= 0 AND "payment_id" <= 4294967295),
  CONSTRAINT "fk_payment_cancel_payment" FOREIGN KEY ("payment_id") REFERENCES "payment" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "payment_cancel__fk_payment_cancel_payment" ON "payment_cancel" ("payment_id");

CREATE TABLE "payment_cancel_v2" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "payment_id" INTEGER NOT NULL CHECK ("payment_id" IS NULL OR typeof("payment_id") = 'integer') CHECK ("payment_id" >= 0 AND "payment_id" <= 4294967295),
  "transaction_key" TEXT COLLATE NOCASE NOT NULL CHECK (length("transaction_key") <= 64),
  "reason" TEXT COLLATE NOCASE NOT NULL CHECK (length("reason") <= 200),
  "amount" INTEGER NOT NULL CHECK ("amount" IS NULL OR typeof("amount") = 'integer') CHECK ("amount" >= 0 AND "amount" <= 4294967295),
  "canceled_at" TEXT NOT NULL,
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_payment_cancel_payment_v2" FOREIGN KEY ("payment_id") REFERENCES "payment_v2" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "payment_cancel_v2__fk_payment_cancel_payment_v2" ON "payment_cancel_v2" ("payment_id");

CREATE TRIGGER "payment_cancel_v2__updated_at_on_update" AFTER UPDATE ON "payment_cancel_v2" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."payment_id" IS NOT OLD."payment_id" OR NEW."transaction_key" IS NOT OLD."transaction_key" OR NEW."reason" IS NOT OLD."reason" OR NEW."amount" IS NOT OLD."amount" OR NEW."canceled_at" IS NOT OLD."canceled_at" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "payment_cancel_v2" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "payment_idempotency_key" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "idempotency_key" TEXT COLLATE NOCASE NOT NULL CHECK (length("idempotency_key") <= 300),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_payment_idempotency_key_user" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "payment_idempotency_key__uk_idempotency_key_user_id" ON "payment_idempotency_key" ("user_id");

CREATE TRIGGER "payment_idempotency_key__updated_at_on_update" AFTER UPDATE ON "payment_idempotency_key" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."idempotency_key" IS NOT OLD."idempotency_key" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "payment_idempotency_key" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "payment_v2" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "order_id" INTEGER NOT NULL CHECK ("order_id" IS NULL OR typeof("order_id") = 'integer') CHECK ("order_id" >= 0 AND "order_id" <= 4294967295),
  "payment_key" TEXT COLLATE NOCASE NOT NULL CHECK (length("payment_key") <= 200),
  "amount" INTEGER NOT NULL CHECK ("amount" IS NULL OR typeof("amount") = 'integer') CHECK ("amount" >= 0 AND "amount" <= 4294967295),
  "status" TEXT COLLATE NOCASE NOT NULL CHECK (length("status") <= 30),
  "method" TEXT COLLATE NOCASE NOT NULL CHECK (length("method") <= 30),
  "description" TEXT COLLATE NOCASE NOT NULL CHECK (length("description") <= 255),
  "easy_pay_company" TEXT COLLATE NOCASE CHECK (length("easy_pay_company") <= 255),
  "requested_at" TEXT NOT NULL,
  "approved_at" TEXT NOT NULL,
  "receipt" TEXT COLLATE NOCASE NOT NULL,
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_payment_order_v2" FOREIGN KEY ("order_id") REFERENCES "order_v2" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "payment_v2__fk_payment_order_v2" ON "payment_v2" ("order_id");

CREATE UNIQUE INDEX "payment_v2__uq_payment_key" ON "payment_v2" ("id");

CREATE TRIGGER "payment_v2__updated_at_on_update" AFTER UPDATE ON "payment_v2" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."order_id" IS NOT OLD."order_id" OR NEW."payment_key" IS NOT OLD."payment_key" OR NEW."amount" IS NOT OLD."amount" OR NEW."status" IS NOT OLD."status" OR NEW."method" IS NOT OLD."method" OR NEW."description" IS NOT OLD."description" OR NEW."easy_pay_company" IS NOT OLD."easy_pay_company" OR NEW."requested_at" IS NOT OLD."requested_at" OR NEW."approved_at" IS NOT OLD."approved_at" OR NEW."receipt" IS NOT OLD."receipt" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "payment_v2" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "rider_message" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "content" TEXT COLLATE NOCASE NOT NULL CHECK (length("content") <= 100),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "rider_message__updated_at_on_update" AFTER UPDATE ON "rider_message" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."content" IS NOT OLD."content" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "rider_message" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "search_articles" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "table_id" INTEGER NOT NULL CHECK ("table_id" IS NULL OR typeof("table_id") = 'integer') CHECK ("table_id" >= 0 AND "table_id" <= 4294967295),
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" >= 0 AND "article_id" <= 4294967295),
  "title" TEXT NOT NULL CHECK (length("title") <= 255),
  "content" TEXT,
  "user_id" INTEGER CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "nickname" TEXT NOT NULL CHECK (length("nickname") <= 50),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "search_articles__idx_is_deleted" ON "search_articles" ("is_deleted");

CREATE INDEX "search_articles__idx_nickname" ON "search_articles" ("nickname", "is_deleted", "created_at");

CREATE INDEX "search_articles__idx_timestamp" ON "search_articles" ("created_at");

CREATE UNIQUE INDEX "search_articles__idx_unique" ON "search_articles" ("table_id", "article_id");

CREATE UNIQUE INDEX "search_articles__pk" ON "search_articles" ("id");

CREATE TRIGGER "search_articles__updated_at_on_update" AFTER UPDATE ON "search_articles" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."table_id" IS NOT OLD."table_id" OR NEW."article_id" IS NOT OLD."article_id" OR NEW."title" IS NOT OLD."title" OR NEW."content" IS NOT OLD."content" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."nickname" IS NOT OLD."nickname" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "search_articles" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "semester" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "semester" TEXT NOT NULL CHECK (length("semester") <= 10),
  "year" INTEGER NOT NULL CHECK ("year" IS NULL OR typeof("year") = 'integer') CHECK ("year" >= 0 AND "year" <= 4294967295),
  "term" TEXT NOT NULL CHECK (length("term") <= 20)
);

CREATE UNIQUE INDEX "semester__semester_UNIQUE" ON "semester" ("semester");

CREATE TABLE "shop_base_delivery_tip" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "order_amount" INTEGER NOT NULL CHECK ("order_amount" IS NULL OR typeof("order_amount") = 'integer') CHECK ("order_amount" BETWEEN -2147483648 AND 2147483647),
  "fee" INTEGER NOT NULL CHECK ("fee" IS NULL OR typeof("fee") = 'integer') CHECK ("fee" BETWEEN -2147483648 AND 2147483647),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "shop_base_delivery_tip__idx_shop_base_delivery_tip_01" ON "shop_base_delivery_tip" ("shop_id", "order_amount", "fee");

CREATE INDEX "shop_base_delivery_tip__idx_shop_base_delivery_tip_02" ON "shop_base_delivery_tip" ("shop_id", "is_deleted", "fee");

CREATE INDEX "shop_base_delivery_tip__idx_shop_base_delivery_tip_shop_id" ON "shop_base_delivery_tip" ("shop_id");

CREATE TRIGGER "shop_base_delivery_tip__updated_at_on_update" AFTER UPDATE ON "shop_base_delivery_tip" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."order_amount" IS NOT OLD."order_amount" OR NEW."fee" IS NOT OLD."fee" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_base_delivery_tip" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_benefit_categories" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "title" TEXT COLLATE NOCASE NOT NULL CHECK (length("title") <= 60),
  "detail" TEXT COLLATE NOCASE CHECK (length("detail") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "on_image_url" TEXT COLLATE NOCASE NOT NULL CHECK (length("on_image_url") <= 255),
  "off_image_url" TEXT COLLATE NOCASE NOT NULL CHECK (length("off_image_url") <= 255)
);

CREATE TRIGGER "shop_benefit_categories__updated_at_on_update" AFTER UPDATE ON "shop_benefit_categories" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."title" IS NOT OLD."title" OR NEW."detail" IS NOT OLD."detail" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."on_image_url" IS NOT OLD."on_image_url" OR NEW."off_image_url" IS NOT OLD."off_image_url") BEGIN UPDATE "shop_benefit_categories" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_benefit_category_map" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "benefit_id" INTEGER NOT NULL CHECK ("benefit_id" IS NULL OR typeof("benefit_id") = 'integer') CHECK ("benefit_id" >= 0 AND "benefit_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "detail" TEXT COLLATE NOCASE CHECK (length("detail") <= 20),
  CONSTRAINT "shop_benefit_category_map_ibfk_1" FOREIGN KEY ("shop_id") REFERENCES "shops" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "shop_benefit_category_map_ibfk_2" FOREIGN KEY ("benefit_id") REFERENCES "shop_benefit_categories" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "shop_benefit_category_map__benefit_id" ON "shop_benefit_category_map" ("benefit_id");

CREATE INDEX "shop_benefit_category_map__shop_id" ON "shop_benefit_category_map" ("shop_id");

CREATE TRIGGER "shop_benefit_category_map__updated_at_on_update" AFTER UPDATE ON "shop_benefit_category_map" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."benefit_id" IS NOT OLD."benefit_id" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."detail" IS NOT OLD."detail") BEGIN UPDATE "shop_benefit_category_map" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_categories" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT NOT NULL CHECK (length("name") <= 255),
  "image_url" TEXT CHECK (length("image_url") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "parent_category_id" INTEGER CHECK ("parent_category_id" IS NULL OR typeof("parent_category_id") = 'integer') CHECK ("parent_category_id" >= 0 AND "parent_category_id" <= 4294967295),
  "event_banner_image_url" TEXT CHECK (length("event_banner_image_url") <= 255),
  "order_index" INTEGER NOT NULL CHECK ("order_index" IS NULL OR typeof("order_index") = 'integer') CHECK ("order_index" BETWEEN -2147483648 AND 2147483647),
  CONSTRAINT "FK_SHOP_CATEGORIES_ON_SHOP_PARENT_CATEGORIES" FOREIGN KEY ("parent_category_id") REFERENCES "shop_parent_categories" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "shop_categories__FK_SHOP_CATEGORIES_ON_SHOP_PARENT_CATEGORIES" ON "shop_categories" ("parent_category_id");

CREATE TRIGGER "shop_categories__updated_at_on_update" AFTER UPDATE ON "shop_categories" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."name" IS NOT OLD."name" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."parent_category_id" IS NOT OLD."parent_category_id" OR NEW."event_banner_image_url" IS NOT OLD."event_banner_image_url" OR NEW."order_index" IS NOT OLD."order_index") BEGIN UPDATE "shop_categories" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_category_map" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "shop_category_id" INTEGER NOT NULL CHECK ("shop_category_id" IS NULL OR typeof("shop_category_id") = 'integer') CHECK ("shop_category_id" >= 0 AND "shop_category_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX "shop_category_map__SHOP_ID_AND_SHOP_CATEGORY_ID" ON "shop_category_map" ("shop_id", "shop_category_id");

CREATE TRIGGER "shop_category_map__updated_at_on_update" AFTER UPDATE ON "shop_category_map" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."shop_category_id" IS NOT OLD."shop_category_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_category_map" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_images" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "image_url" TEXT CHECK (length("image_url") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX "shop_images__SHOP_ID_AND_IMAGE_URL" ON "shop_images" ("shop_id", "image_url");

CREATE TRIGGER "shop_images__updated_at_on_update" AFTER UPDATE ON "shop_images" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_images" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_menu_categories" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "name" TEXT NOT NULL CHECK (length("name") <= 255),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "shop_menu_categories__updated_at_on_update" AFTER UPDATE ON "shop_menu_categories" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."name" IS NOT OLD."name" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_menu_categories" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_menu_category_map" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_menu_id" INTEGER NOT NULL CHECK ("shop_menu_id" IS NULL OR typeof("shop_menu_id") = 'integer') CHECK ("shop_menu_id" >= 0 AND "shop_menu_id" <= 4294967295),
  "shop_menu_category_id" INTEGER NOT NULL CHECK ("shop_menu_category_id" IS NULL OR typeof("shop_menu_category_id") = 'integer') CHECK ("shop_menu_category_id" >= 0 AND "shop_menu_category_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX "shop_menu_category_map__SHOP_MENU_ID_AND_SHOP_MENU_CATEGORY_ID" ON "shop_menu_category_map" ("shop_menu_id", "shop_menu_category_id");

CREATE TRIGGER "shop_menu_category_map__updated_at_on_update" AFTER UPDATE ON "shop_menu_category_map" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_menu_id" IS NOT OLD."shop_menu_id" OR NEW."shop_menu_category_id" IS NOT OLD."shop_menu_category_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_menu_category_map" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_menu_details" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_menu_id" INTEGER NOT NULL CHECK ("shop_menu_id" IS NULL OR typeof("shop_menu_id") = 'integer') CHECK ("shop_menu_id" >= 0 AND "shop_menu_id" <= 4294967295),
  "option" TEXT CHECK (length("option") <= 255),
  "price" INTEGER NOT NULL CHECK ("price" IS NULL OR typeof("price") = 'integer') CHECK ("price" >= 0 AND "price" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX "shop_menu_details__SHOP_MENU_ID_AND_OPTION_AND_PRICE" ON "shop_menu_details" ("shop_menu_id", "option", "price");

CREATE TRIGGER "shop_menu_details__updated_at_on_update" AFTER UPDATE ON "shop_menu_details" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_menu_id" IS NOT OLD."shop_menu_id" OR NEW."option" IS NOT OLD."option" OR NEW."price" IS NOT OLD."price" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_menu_details" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_menu_images" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_menu_id" INTEGER NOT NULL CHECK ("shop_menu_id" IS NULL OR typeof("shop_menu_id") = 'integer') CHECK ("shop_menu_id" >= 0 AND "shop_menu_id" <= 4294967295),
  "image_url" TEXT NOT NULL CHECK (length("image_url") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX "shop_menu_images__SHOP_MENU_ID_AND_IMAGE_URL" ON "shop_menu_images" ("shop_menu_id", "image_url");

CREATE TRIGGER "shop_menu_images__updated_at_on_update" AFTER UPDATE ON "shop_menu_images" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_menu_id" IS NOT OLD."shop_menu_id" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_menu_images" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_menu_origin" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "ingredient" TEXT COLLATE NOCASE CHECK (length("ingredient") <= 50),
  "origin" TEXT COLLATE NOCASE CHECK (length("origin") <= 50),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "shop_menu_origin__idx_shop_menu_origin_shop_id" ON "shop_menu_origin" ("shop_id");

CREATE TRIGGER "shop_menu_origin__updated_at_on_update" AFTER UPDATE ON "shop_menu_origin" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."ingredient" IS NOT OLD."ingredient" OR NEW."origin" IS NOT OLD."origin" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_menu_origin" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_menu_search_keywords" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "keyword" TEXT COLLATE NOCASE NOT NULL CHECK (length("keyword") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "shop_menu_search_keywords__updated_at_on_update" AFTER UPDATE ON "shop_menu_search_keywords" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."keyword" IS NOT OLD."keyword" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_menu_search_keywords" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_menus" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "description" TEXT COLLATE NOCASE CHECK (length("description") <= 255),
  "is_hidden" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_hidden" IS NULL OR typeof("is_hidden") = 'integer') CHECK ("is_hidden" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "shop_menus__updated_at_on_update" AFTER UPDATE ON "shop_menus" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."name" IS NOT OLD."name" OR NEW."description" IS NOT OLD."description" OR NEW."is_hidden" IS NOT OLD."is_hidden" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_menus" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_notification_messages" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "title" TEXT COLLATE NOCASE NOT NULL CHECK (length("title") <= 255),
  "content" TEXT COLLATE NOCASE NOT NULL CHECK (length("content") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "shop_notification_messages__updated_at_on_update" AFTER UPDATE ON "shop_notification_messages" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."title" IS NOT OLD."title" OR NEW."content" IS NOT OLD."content" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_notification_messages" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_opens" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "day_of_week" TEXT NOT NULL CHECK (length("day_of_week") <= 10),
  "closed" INTEGER NOT NULL CHECK ("closed" IS NULL OR typeof("closed") = 'integer') CHECK ("closed" IN (0, 1)),
  "open_time" TEXT CHECK (length("open_time") <= 10),
  "close_time" TEXT CHECK (length("close_time") <= 10),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "shop_opens__shop_opens_filter" ON "shop_opens" ("day_of_week", "shop_id", "open_time", "close_time");

CREATE INDEX "shop_opens__shop_opens_shop_id" ON "shop_opens" ("shop_id");

CREATE TRIGGER "shop_opens__updated_at_on_update" AFTER UPDATE ON "shop_opens" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."day_of_week" IS NOT OLD."day_of_week" OR NEW."closed" IS NOT OLD."closed" OR NEW."open_time" IS NOT OLD."open_time" OR NEW."close_time" IS NOT OLD."close_time" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_opens" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_operation" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "is_open" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_open" IS NULL OR typeof("is_open") = 'integer') CHECK ("is_open" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "shop_operation__idx_shop_operation_shop_id" ON "shop_operation" ("shop_id");

CREATE INDEX "shop_operation__idx_shop_operation_shop_id_is_open" ON "shop_operation" ("shop_id", "is_open");

CREATE INDEX "shop_operation__idx_shop_operation_shop_id_open_deleted" ON "shop_operation" ("shop_id", "is_open", "is_deleted");

CREATE UNIQUE INDEX "shop_operation__shop_id" ON "shop_operation" ("shop_id");

CREATE TRIGGER "shop_operation__updated_at_on_update" AFTER UPDATE ON "shop_operation" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."is_open" IS NOT OLD."is_open" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_operation" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_order_service_requests" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "minimum_order_amount" INTEGER NOT NULL CHECK ("minimum_order_amount" IS NULL OR typeof("minimum_order_amount") = 'integer') CHECK ("minimum_order_amount" >= 0 AND "minimum_order_amount" <= 4294967295),
  "is_takeout" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_takeout" IS NULL OR typeof("is_takeout") = 'integer') CHECK ("is_takeout" IN (0, 1)),
  "delivery_option" TEXT COLLATE NOCASE NOT NULL CHECK (length("delivery_option") <= 50),
  "campus_delivery_tip" INTEGER NOT NULL DEFAULT ('0') CHECK ("campus_delivery_tip" IS NULL OR typeof("campus_delivery_tip") = 'integer') CHECK ("campus_delivery_tip" >= 0 AND "campus_delivery_tip" <= 4294967295),
  "off_campus_delivery_tip" INTEGER NOT NULL DEFAULT ('0') CHECK ("off_campus_delivery_tip" IS NULL OR typeof("off_campus_delivery_tip") = 'integer') CHECK ("off_campus_delivery_tip" >= 0 AND "off_campus_delivery_tip" <= 4294967295),
  "business_license_url" TEXT COLLATE NOCASE NOT NULL CHECK (length("business_license_url") <= 255),
  "business_certificate_url" TEXT COLLATE NOCASE NOT NULL CHECK (length("business_certificate_url") <= 255),
  "bank_copy_url" TEXT COLLATE NOCASE NOT NULL CHECK (length("bank_copy_url") <= 255),
  "bank" TEXT COLLATE NOCASE NOT NULL CHECK (length("bank") <= 10),
  "account_number" TEXT COLLATE NOCASE NOT NULL CHECK (length("account_number") <= 20),
  "request_status" TEXT COLLATE NOCASE NOT NULL DEFAULT ('PENDING') CHECK (length("request_status") <= 50),
  "approved_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_shop_order_service_requests_shop_id" FOREIGN KEY ("shop_id") REFERENCES "shops" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "shop_order_service_requests__fk_shop_order_service_requests_shop_id" ON "shop_order_service_requests" ("shop_id");

CREATE TRIGGER "shop_order_service_requests__updated_at_on_update" AFTER UPDATE ON "shop_order_service_requests" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."minimum_order_amount" IS NOT OLD."minimum_order_amount" OR NEW."is_takeout" IS NOT OLD."is_takeout" OR NEW."delivery_option" IS NOT OLD."delivery_option" OR NEW."campus_delivery_tip" IS NOT OLD."campus_delivery_tip" OR NEW."off_campus_delivery_tip" IS NOT OLD."off_campus_delivery_tip" OR NEW."business_license_url" IS NOT OLD."business_license_url" OR NEW."business_certificate_url" IS NOT OLD."business_certificate_url" OR NEW."bank_copy_url" IS NOT OLD."bank_copy_url" OR NEW."bank" IS NOT OLD."bank" OR NEW."account_number" IS NOT OLD."account_number" OR NEW."request_status" IS NOT OLD."request_status" OR NEW."approved_at" IS NOT OLD."approved_at" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_order_service_requests" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_parent_categories" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "notification_message_id" INTEGER NOT NULL CHECK ("notification_message_id" IS NULL OR typeof("notification_message_id") = 'integer') CHECK ("notification_message_id" >= 0 AND "notification_message_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "FK_MAIN_CATEGORIES_ON_SHOP_NOTIFICATION_MESSAGES" FOREIGN KEY ("notification_message_id") REFERENCES "shop_notification_messages" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "shop_parent_categories__FK_MAIN_CATEGORIES_ON_SHOP_NOTIFICATION_MESSAGES" ON "shop_parent_categories" ("notification_message_id");

CREATE TRIGGER "shop_parent_categories__updated_at_on_update" AFTER UPDATE ON "shop_parent_categories" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."name" IS NOT OLD."name" OR NEW."notification_message_id" IS NOT OLD."notification_message_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_parent_categories" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_review_images" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "review_id" INTEGER NOT NULL CHECK ("review_id" IS NULL OR typeof("review_id") = 'integer') CHECK ("review_id" >= 0 AND "review_id" <= 4294967295),
  "image_urls" TEXT COLLATE NOCASE NOT NULL,
  "created_at" TEXT DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "shop_review_images_ibfk_1" FOREIGN KEY ("review_id") REFERENCES "shop_reviews" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "shop_review_images__shop_review_images_ibfk_1" ON "shop_review_images" ("review_id");

CREATE TRIGGER "shop_review_images__updated_at_on_update" AFTER UPDATE ON "shop_review_images" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."review_id" IS NOT OLD."review_id" OR NEW."image_urls" IS NOT OLD."image_urls" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_review_images" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_review_menus" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "review_id" INTEGER NOT NULL CHECK ("review_id" IS NULL OR typeof("review_id") = 'integer') CHECK ("review_id" >= 0 AND "review_id" <= 4294967295),
  "menu_name" TEXT COLLATE NOCASE NOT NULL,
  "created_at" TEXT DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "shop_review_menus_ibfk_1" FOREIGN KEY ("review_id") REFERENCES "shop_reviews" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "shop_review_menus__shop_review_menus_ibfk_1" ON "shop_review_menus" ("review_id");

CREATE TRIGGER "shop_review_menus__updated_at_on_update" AFTER UPDATE ON "shop_review_menus" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."review_id" IS NOT OLD."review_id" OR NEW."menu_name" IS NOT OLD."menu_name" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_review_menus" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_review_reports" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "review_id" INTEGER NOT NULL CHECK ("review_id" IS NULL OR typeof("review_id") = 'integer') CHECK ("review_id" >= 0 AND "review_id" <= 4294967295),
  "title" TEXT COLLATE NOCASE NOT NULL CHECK (length("title") <= 50),
  "content" TEXT COLLATE NOCASE,
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "created_at" TEXT DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT DEFAULT (CURRENT_TIMESTAMP),
  "status" TEXT COLLATE NOCASE DEFAULT ('UNHANDLED') CHECK (length("status") <= 25),
  CONSTRAINT "shop_review_reports_ibfk_1" FOREIGN KEY ("review_id") REFERENCES "shop_reviews" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "shop_review_reports_ibfk_2" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "shop_review_reports__shop_review_reports_ibfk_1" ON "shop_review_reports" ("review_id");

CREATE INDEX "shop_review_reports__shop_review_reports_ibfk_2" ON "shop_review_reports" ("user_id");

CREATE TRIGGER "shop_review_reports__updated_at_on_update" AFTER UPDATE ON "shop_review_reports" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."review_id" IS NOT OLD."review_id" OR NEW."title" IS NOT OLD."title" OR NEW."content" IS NOT OLD."content" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."status" IS NOT OLD."status") BEGIN UPDATE "shop_review_reports" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_review_reports_categories" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 50),
  "detail" TEXT COLLATE NOCASE NOT NULL CHECK (length("detail") <= 255),
  "created_at" TEXT DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "shop_review_reports_categories__updated_at_on_update" AFTER UPDATE ON "shop_review_reports_categories" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."name" IS NOT OLD."name" OR NEW."detail" IS NOT OLD."detail" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "shop_review_reports_categories" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shop_reviews" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "shop_id" INTEGER NOT NULL CHECK ("shop_id" IS NULL OR typeof("shop_id") = 'integer') CHECK ("shop_id" >= 0 AND "shop_id" <= 4294967295),
  "content" TEXT COLLATE NOCASE NOT NULL,
  "rating" INTEGER NOT NULL CHECK ("rating" IS NULL OR typeof("rating") = 'integer') CHECK ("rating" BETWEEN -2147483648 AND 2147483647),
  "reviewer_id" INTEGER NOT NULL CHECK ("reviewer_id" IS NULL OR typeof("reviewer_id") = 'integer') CHECK ("reviewer_id" >= 0 AND "reviewer_id" <= 4294967295),
  "created_at" TEXT DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT DEFAULT (CURRENT_TIMESTAMP),
  "is_deleted" INTEGER DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  CONSTRAINT "shop_reviews_ibfk_1" FOREIGN KEY ("reviewer_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "shop_reviews_ibfk_2" FOREIGN KEY ("shop_id") REFERENCES "shops" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "shop_reviews_chk_1" CHECK ((`rating` between 0 and 5))
);

CREATE INDEX "shop_reviews__idx_shop_reviews_covering" ON "shop_reviews" ("shop_id", "is_deleted", "rating");

CREATE INDEX "shop_reviews__shop_reviews_ibfk_1" ON "shop_reviews" ("reviewer_id");

CREATE INDEX "shop_reviews__shop_reviews_ibfk_2" ON "shop_reviews" ("shop_id");

CREATE INDEX "shop_reviews__shop_reviews_rating" ON "shop_reviews" ("shop_id", "rating");

CREATE TRIGGER "shop_reviews__updated_at_on_update" AFTER UPDATE ON "shop_reviews" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."shop_id" IS NOT OLD."shop_id" OR NEW."content" IS NOT OLD."content" OR NEW."rating" IS NOT OLD."rating" OR NEW."reviewer_id" IS NOT OLD."reviewer_id" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."is_deleted" IS NOT OLD."is_deleted") BEGIN UPDATE "shop_reviews" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "shops" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "owner_id" INTEGER CHECK ("owner_id" IS NULL OR typeof("owner_id") = 'integer') CHECK ("owner_id" BETWEEN -2147483648 AND 2147483647),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 50),
  "internal_name" TEXT COLLATE NOCASE NOT NULL CHECK (length("internal_name") <= 50),
  "chosung" TEXT COLLATE NOCASE CHECK (length("chosung") <= 3),
  "phone" TEXT COLLATE NOCASE CHECK (length("phone") <= 50),
  "address" TEXT COLLATE NOCASE,
  "address_detail" TEXT COLLATE NOCASE,
  "description" TEXT COLLATE NOCASE,
  "introduction" TEXT COLLATE NOCASE,
  "notice" TEXT COLLATE NOCASE,
  "delivery" INTEGER NOT NULL DEFAULT ('0') CHECK ("delivery" IS NULL OR typeof("delivery") = 'integer') CHECK ("delivery" IN (0, 1)),
  "delivery_price" INTEGER NOT NULL DEFAULT ('0') CHECK ("delivery_price" IS NULL OR typeof("delivery_price") = 'integer') CHECK ("delivery_price" >= 0 AND "delivery_price" <= 4294967295),
  "pay_card" INTEGER NOT NULL DEFAULT ('0') CHECK ("pay_card" IS NULL OR typeof("pay_card") = 'integer') CHECK ("pay_card" IN (0, 1)),
  "pay_bank" INTEGER NOT NULL DEFAULT ('0') CHECK ("pay_bank" IS NULL OR typeof("pay_bank") = 'integer') CHECK ("pay_bank" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "is_event" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_event" IS NULL OR typeof("is_event") = 'integer') CHECK ("is_event" IN (0, 1)),
  "remarks" TEXT COLLATE NOCASE,
  "hit" INTEGER NOT NULL DEFAULT ('0') CHECK ("hit" IS NULL OR typeof("hit") = 'integer') CHECK ("hit" >= 0 AND "hit" <= 4294967295),
  "bank" TEXT COLLATE NOCASE CHECK (length("bank") <= 10),
  "account_number" TEXT COLLATE NOCASE CHECK (length("account_number") <= 20),
  "main_category_id" INTEGER CHECK ("main_category_id" IS NULL OR typeof("main_category_id") = 'integer') CHECK ("main_category_id" >= 0 AND "main_category_id" <= 4294967295),
  CONSTRAINT "FK_SHOPS_ON_SHOP_CATEGORIES" FOREIGN KEY ("main_category_id") REFERENCES "shop_categories" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "shops__FK_SHOPS_ON_SHOP_CATEGORIES" ON "shops" ("main_category_id");

CREATE INDEX "shops__ix_internalname" ON "shops" ("internal_name");

CREATE TRIGGER "shops__updated_at_on_update" AFTER UPDATE ON "shops" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."owner_id" IS NOT OLD."owner_id" OR NEW."name" IS NOT OLD."name" OR NEW."internal_name" IS NOT OLD."internal_name" OR NEW."chosung" IS NOT OLD."chosung" OR NEW."phone" IS NOT OLD."phone" OR NEW."address" IS NOT OLD."address" OR NEW."address_detail" IS NOT OLD."address_detail" OR NEW."description" IS NOT OLD."description" OR NEW."introduction" IS NOT OLD."introduction" OR NEW."notice" IS NOT OLD."notice" OR NEW."delivery" IS NOT OLD."delivery" OR NEW."delivery_price" IS NOT OLD."delivery_price" OR NEW."pay_card" IS NOT OLD."pay_card" OR NEW."pay_bank" IS NOT OLD."pay_bank" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."is_event" IS NOT OLD."is_event" OR NEW."remarks" IS NOT OLD."remarks" OR NEW."hit" IS NOT OLD."hit" OR NEW."bank" IS NOT OLD."bank" OR NEW."account_number" IS NOT OLD."account_number" OR NEW."main_category_id" IS NOT OLD."main_category_id") BEGIN UPDATE "shops" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "standard_graduation_requirements" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "year" TEXT COLLATE NOCASE NOT NULL CHECK (length("year") <= 20),
  "major_id" INTEGER NOT NULL CHECK ("major_id" IS NULL OR typeof("major_id") = 'integer') CHECK ("major_id" >= 0 AND "major_id" <= 4294967295),
  "course_type_id" INTEGER CHECK ("course_type_id" IS NULL OR typeof("course_type_id") = 'integer') CHECK ("course_type_id" >= 0 AND "course_type_id" <= 4294967295),
  "required_grades" INTEGER NOT NULL CHECK ("required_grades" IS NULL OR typeof("required_grades") = 'integer') CHECK ("required_grades" BETWEEN -2147483648 AND 2147483647),
  "is_deleted" INTEGER DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" BETWEEN -128 AND 127),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "standard_graduation_requirements_ibfk_1" FOREIGN KEY ("course_type_id") REFERENCES "course_type" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "standard_graduation_requirements_ibfk_2" FOREIGN KEY ("major_id") REFERENCES "major" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "standard_graduation_requirements__course_type_id" ON "standard_graduation_requirements" ("course_type_id");

CREATE INDEX "standard_graduation_requirements__major_id" ON "standard_graduation_requirements" ("major_id");

CREATE TRIGGER "standard_graduation_requirements__updated_at_on_update" AFTER UPDATE ON "standard_graduation_requirements" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."year" IS NOT OLD."year" OR NEW."major_id" IS NOT OLD."major_id" OR NEW."course_type_id" IS NOT OLD."course_type_id" OR NEW."required_grades" IS NOT OLD."required_grades" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "standard_graduation_requirements" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "student_course_calculation" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "standard_graduation_requirements_id" INTEGER CHECK ("standard_graduation_requirements_id" IS NULL OR typeof("standard_graduation_requirements_id") = 'integer') CHECK ("standard_graduation_requirements_id" >= 0 AND "standard_graduation_requirements_id" <= 4294967295),
  "completed_grades" INTEGER NOT NULL DEFAULT ('0') CHECK ("completed_grades" IS NULL OR typeof("completed_grades") = 'integer') CHECK ("completed_grades" BETWEEN -2147483648 AND 2147483647),
  "is_deleted" INTEGER DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" BETWEEN -128 AND 127),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "student_course_calculation_ibfk_1" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "student_course_calculation_ibfk_2" FOREIGN KEY ("standard_graduation_requirements_id") REFERENCES "standard_graduation_requirements" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "student_course_calculation__standard_graduation_requirements_id" ON "student_course_calculation" ("standard_graduation_requirements_id");

CREATE UNIQUE INDEX "student_course_calculation__unique_user_standard_graduation_requirements" ON "student_course_calculation" ("user_id", "standard_graduation_requirements_id");

CREATE TRIGGER "student_course_calculation__updated_at_on_update" AFTER UPDATE ON "student_course_calculation" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."standard_graduation_requirements_id" IS NOT OLD."standard_graduation_requirements_id" OR NEW."completed_grades" IS NOT OLD."completed_grades" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "student_course_calculation" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "students" (
  "user_id" INTEGER PRIMARY KEY NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -2147483648 AND 2147483647),
  "anonymous_nickname" TEXT CHECK (length("anonymous_nickname") <= 255),
  "student_number" TEXT CHECK (length("student_number") <= 255),
  "identity" INTEGER CHECK ("identity" IS NULL OR typeof("identity") = 'integer') CHECK ("identity" BETWEEN -32768 AND 32767),
  "is_graduated" INTEGER CHECK ("is_graduated" IS NULL OR typeof("is_graduated") = 'integer') CHECK ("is_graduated" IN (0, 1)),
  "department_id" INTEGER CHECK ("department_id" IS NULL OR typeof("department_id") = 'integer') CHECK ("department_id" >= 0 AND "department_id" <= 4294967295),
  "major_id" INTEGER CHECK ("major_id" IS NULL OR typeof("major_id") = 'integer') CHECK ("major_id" >= 0 AND "major_id" <= 4294967295),
  CONSTRAINT "fk_student_department" FOREIGN KEY ("department_id") REFERENCES "department" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "fk_student_major" FOREIGN KEY ("major_id") REFERENCES "major" ("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "students__anonymous_nickname_UNIQUE" ON "students" ("anonymous_nickname");

CREATE INDEX "students__fk_student_department" ON "students" ("department_id");

CREATE INDEX "students__fk_student_major" ON "students" ("major_id");

CREATE TABLE "team_recruitment" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "author_id" INTEGER CHECK ("author_id" IS NULL OR typeof("author_id") = 'integer') CHECK ("author_id" >= 0 AND "author_id" <= 4294967295),
  "category" TEXT COLLATE NOCASE NOT NULL CHECK (length("category") <= 32),
  "title" TEXT COLLATE NOCASE NOT NULL CHECK (length("title") <= 50),
  "meeting_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("meeting_type") <= 16),
  "activity_start_date" TEXT NOT NULL,
  "activity_end_date" TEXT NOT NULL,
  "deadline_date" TEXT NOT NULL,
  "recruitment_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("recruitment_type") <= 16),
  "max_participants" INTEGER NOT NULL CHECK ("max_participants" IS NULL OR typeof("max_participants") = 'integer') CHECK ("max_participants" >= 0 AND "max_participants" <= 4294967295),
  "current_participants" INTEGER NOT NULL DEFAULT ('0') CHECK ("current_participants" IS NULL OR typeof("current_participants") = 'integer') CHECK ("current_participants" >= 0 AND "current_participants" <= 4294967295),
  "description" TEXT COLLATE NOCASE NOT NULL CHECK (length("description") <= 1000),
  "related_url" TEXT COLLATE NOCASE CHECK (length("related_url") <= 2048),
  "qualification" TEXT COLLATE NOCASE CHECK (length("qualification") <= 500),
  "status" TEXT COLLATE NOCASE NOT NULL DEFAULT ('RECRUITING') CHECK (length("status") <= 16),
  "deleted_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_team_recruitment_author_id_withdrawal" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "chk_team_recruitment_category" CHECK ((`category` in ('CONTEST','EXTERNAL_ACTIVITY','STUDY','PROJECT','OTHER'))),
  CONSTRAINT "chk_team_recruitment_current_participants" CHECK ((`current_participants` <= `max_participants`)),
  CONSTRAINT "chk_team_recruitment_dates" CHECK ((`activity_start_date` <= `activity_end_date`)),
  CONSTRAINT "chk_team_recruitment_deleted_at" CHECK ((((`status` = 'DELETED') and (`deleted_at` is not null)) or ((`status` <> 'DELETED') and (`deleted_at` is null)))),
  CONSTRAINT "chk_team_recruitment_max_participants" CHECK ((`max_participants` between 1 and 10)),
  CONSTRAINT "chk_team_recruitment_meeting_type" CHECK ((`meeting_type` in ('ONLINE','OFFLINE','MIXED'))),
  CONSTRAINT "chk_team_recruitment_status" CHECK ((`status` in ('RECRUITING','CLOSED','DELETED'))),
  CONSTRAINT "chk_team_recruitment_type" CHECK ((`recruitment_type` in ('ROLE_BASED','GENERAL')))
);

CREATE INDEX "team_recruitment__idx_team_recruitment_author_status_created" ON "team_recruitment" ("author_id", "status", "created_at", "id");

CREATE INDEX "team_recruitment__idx_team_recruitment_status_deadline" ON "team_recruitment" ("status", "deadline_date", "created_at", "id");

CREATE TRIGGER "team_recruitment__updated_at_on_update" AFTER UPDATE ON "team_recruitment" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."author_id" IS NOT OLD."author_id" OR NEW."category" IS NOT OLD."category" OR NEW."title" IS NOT OLD."title" OR NEW."meeting_type" IS NOT OLD."meeting_type" OR NEW."activity_start_date" IS NOT OLD."activity_start_date" OR NEW."activity_end_date" IS NOT OLD."activity_end_date" OR NEW."deadline_date" IS NOT OLD."deadline_date" OR NEW."recruitment_type" IS NOT OLD."recruitment_type" OR NEW."max_participants" IS NOT OLD."max_participants" OR NEW."current_participants" IS NOT OLD."current_participants" OR NEW."description" IS NOT OLD."description" OR NEW."related_url" IS NOT OLD."related_url" OR NEW."qualification" IS NOT OLD."qualification" OR NEW."status" IS NOT OLD."status" OR NEW."deleted_at" IS NOT OLD."deleted_at" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "team_recruitment" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "team_recruitment_application" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "recruitment_id" INTEGER NOT NULL CHECK ("recruitment_id" IS NULL OR typeof("recruitment_id") = 'integer') CHECK ("recruitment_id" >= 0 AND "recruitment_id" <= 4294967295),
  "applicant_id" INTEGER CHECK ("applicant_id" IS NULL OR typeof("applicant_id") = 'integer') CHECK ("applicant_id" >= 0 AND "applicant_id" <= 4294967295),
  "role_id" INTEGER CHECK ("role_id" IS NULL OR typeof("role_id") = 'integer') CHECK ("role_id" >= 0 AND "role_id" <= 4294967295),
  "motivation" TEXT COLLATE NOCASE NOT NULL CHECK (length("motivation") <= 1000),
  "availability" TEXT COLLATE NOCASE NOT NULL CHECK (length("availability") <= 100),
  "status" TEXT COLLATE NOCASE NOT NULL DEFAULT ('PENDING') CHECK (length("status") <= 16),
  "profile_snapshot" TEXT NOT NULL CHECK ("profile_snapshot" IS NULL OR json_valid("profile_snapshot")),
  "snapshot_version" INTEGER NOT NULL DEFAULT ('1') CHECK ("snapshot_version" IS NULL OR typeof("snapshot_version") = 'integer') CHECK ("snapshot_version" >= 0 AND "snapshot_version" <= 4294967295),
  "decision_reason" TEXT COLLATE NOCASE CHECK (length("decision_reason") <= 32),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_team_recruitment_application_applicant_id_withdrawal" FOREIGN KEY ("applicant_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "fk_team_recruitment_application_recruitment_id" FOREIGN KEY ("recruitment_id") REFERENCES "team_recruitment" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "fk_team_recruitment_application_role_recruitment" FOREIGN KEY ("role_id", "recruitment_id") REFERENCES "team_recruitment_role" ("id", "recruitment_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "chk_team_recruitment_application_snapshot_version" CHECK ((`snapshot_version` >= 1)),
  CONSTRAINT "chk_team_recruitment_application_status_withdrawal" CHECK ((`status` in ('PENDING','ACCEPTED','REJECTED','CANCELLED')))
);

CREATE INDEX "team_recruitment_application__fk_team_recruitment_application_role_recruitment" ON "team_recruitment_application" ("role_id", "recruitment_id");

CREATE INDEX "team_recruitment_application__idx_team_recruitment_application_applicant_created" ON "team_recruitment_application" ("applicant_id", "created_at", "id");

CREATE INDEX "team_recruitment_application__idx_team_recruitment_application_recruitment_status" ON "team_recruitment_application" ("recruitment_id", "status", "created_at", "id");

CREATE INDEX "team_recruitment_application__idx_team_recruitment_application_role_status" ON "team_recruitment_application" ("role_id", "status");

CREATE UNIQUE INDEX "team_recruitment_application__uk_team_recruitment_application_id_recruitment" ON "team_recruitment_application" ("id", "recruitment_id");

CREATE UNIQUE INDEX "team_recruitment_application__uk_team_recruitment_application_recruitment_applicant" ON "team_recruitment_application" ("recruitment_id", "applicant_id");

CREATE TRIGGER "team_recruitment_application__updated_at_on_update" AFTER UPDATE ON "team_recruitment_application" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."recruitment_id" IS NOT OLD."recruitment_id" OR NEW."applicant_id" IS NOT OLD."applicant_id" OR NEW."role_id" IS NOT OLD."role_id" OR NEW."motivation" IS NOT OLD."motivation" OR NEW."availability" IS NOT OLD."availability" OR NEW."status" IS NOT OLD."status" OR NEW."profile_snapshot" IS NOT OLD."profile_snapshot" OR NEW."snapshot_version" IS NOT OLD."snapshot_version" OR NEW."decision_reason" IS NOT OLD."decision_reason" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "team_recruitment_application" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "team_recruitment_chat_member" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "chat_room_id" INTEGER NOT NULL CHECK ("chat_room_id" IS NULL OR typeof("chat_room_id") = 'integer') CHECK ("chat_room_id" >= 0 AND "chat_room_id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "last_read_message_id" INTEGER CHECK ("last_read_message_id" IS NULL OR typeof("last_read_message_id") = 'integer') CHECK ("last_read_message_id" >= 0 AND "last_read_message_id" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_team_recruitment_chat_member_last_read_message" FOREIGN KEY ("last_read_message_id", "chat_room_id") REFERENCES "team_recruitment_chat_message" ("id", "chat_room_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "fk_team_recruitment_chat_member_room_id" FOREIGN KEY ("chat_room_id") REFERENCES "team_recruitment_chat_room" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "fk_team_recruitment_chat_member_user_id_withdrawal" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "team_recruitment_chat_member__fk_team_recruitment_chat_member_last_read_message" ON "team_recruitment_chat_member" ("last_read_message_id", "chat_room_id");

CREATE INDEX "team_recruitment_chat_member__idx_team_recruitment_chat_member_user_room" ON "team_recruitment_chat_member" ("user_id", "chat_room_id");

CREATE UNIQUE INDEX "team_recruitment_chat_member__uk_team_recruitment_chat_member_room_user" ON "team_recruitment_chat_member" ("chat_room_id", "user_id");

CREATE TRIGGER "team_recruitment_chat_member__updated_at_on_update" AFTER UPDATE ON "team_recruitment_chat_member" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."chat_room_id" IS NOT OLD."chat_room_id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."last_read_message_id" IS NOT OLD."last_read_message_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "team_recruitment_chat_member" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "team_recruitment_chat_message" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "chat_room_id" INTEGER NOT NULL CHECK ("chat_room_id" IS NULL OR typeof("chat_room_id") = 'integer') CHECK ("chat_room_id" >= 0 AND "chat_room_id" <= 4294967295),
  "sender_id" INTEGER CHECK ("sender_id" IS NULL OR typeof("sender_id") = 'integer') CHECK ("sender_id" >= 0 AND "sender_id" <= 4294967295),
  "sender_nickname" TEXT COLLATE NOCASE NOT NULL CHECK (length("sender_nickname") <= 50),
  "content" TEXT COLLATE NOCASE NOT NULL,
  "is_image" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_image" IS NULL OR typeof("is_image") = 'integer') CHECK ("is_image" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_team_recruitment_chat_message_chat_room_id" FOREIGN KEY ("chat_room_id") REFERENCES "team_recruitment_chat_room" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "fk_team_recruitment_chat_message_sender_id_withdrawal" FOREIGN KEY ("sender_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "chk_team_recruitment_chat_message_content" CHECK ((length(trim(`content`)) > 0)),
  CONSTRAINT "chk_team_recruitment_chat_message_is_image" CHECK ((`is_image` in (0,1)))
);

CREATE INDEX "team_recruitment_chat_message__fk_team_recruitment_chat_message_sender_id_withdrawal" ON "team_recruitment_chat_message" ("sender_id");

CREATE INDEX "team_recruitment_chat_message__idx_team_recruitment_chat_message_room_id_id" ON "team_recruitment_chat_message" ("chat_room_id", "id");

CREATE UNIQUE INDEX "team_recruitment_chat_message__uk_team_recruitment_chat_message_id_room" ON "team_recruitment_chat_message" ("id", "chat_room_id");

CREATE TRIGGER "team_recruitment_chat_message__updated_at_on_update" AFTER UPDATE ON "team_recruitment_chat_message" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."chat_room_id" IS NOT OLD."chat_room_id" OR NEW."sender_id" IS NOT OLD."sender_id" OR NEW."sender_nickname" IS NOT OLD."sender_nickname" OR NEW."content" IS NOT OLD."content" OR NEW."is_image" IS NOT OLD."is_image" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "team_recruitment_chat_message" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "team_recruitment_chat_room" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "recruitment_id" INTEGER NOT NULL CHECK ("recruitment_id" IS NULL OR typeof("recruitment_id") = 'integer') CHECK ("recruitment_id" >= 0 AND "recruitment_id" <= 4294967295),
  "room_scope_key" TEXT COLLATE NOCASE NOT NULL CHECK (length("room_scope_key") <= 64),
  "room_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("room_type") <= 16),
  "application_id" INTEGER CHECK ("application_id" IS NULL OR typeof("application_id") = 'integer') CHECK ("application_id" >= 0 AND "application_id" <= 4294967295),
  "status" TEXT COLLATE NOCASE NOT NULL DEFAULT ('ACTIVE') CHECK (length("status") <= 16),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_team_recruitment_chat_room_application_recruitment" FOREIGN KEY ("application_id", "recruitment_id") REFERENCES "team_recruitment_application" ("id", "recruitment_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "fk_team_recruitment_chat_room_recruitment_id" FOREIGN KEY ("recruitment_id") REFERENCES "team_recruitment" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "chk_team_recruitment_chat_room_type" CHECK ((`room_type` in ('TEAM','DIRECT'))),
  CONSTRAINT "chk_team_recruitment_chat_room_status" CHECK ((`status` in ('ACTIVE','READ_ONLY'))),
  CONSTRAINT "chk_team_recruitment_chat_room_application_scope" CHECK ((((`room_type` = 'TEAM') and (`application_id` is null) and (`room_scope_key` = 'TEAM')) or ((`room_type` = 'DIRECT') and (`application_id` is not null) and (`room_scope_key` <> 'TEAM'))))
);

CREATE INDEX "team_recruitment_chat_room__fk_team_recruitment_chat_room_application_recruitment" ON "team_recruitment_chat_room" ("application_id", "recruitment_id");

CREATE INDEX "team_recruitment_chat_room__idx_team_recruitment_chat_room_recruitment_status" ON "team_recruitment_chat_room" ("recruitment_id", "status");

CREATE UNIQUE INDEX "team_recruitment_chat_room__uk_team_recruitment_chat_room_id_recruitment" ON "team_recruitment_chat_room" ("id", "recruitment_id");

CREATE UNIQUE INDEX "team_recruitment_chat_room__uk_team_recruitment_chat_room_recruitment_application_type" ON "team_recruitment_chat_room" ("recruitment_id", "application_id", "room_type");

CREATE UNIQUE INDEX "team_recruitment_chat_room__uk_team_recruitment_chat_room_recruitment_scope" ON "team_recruitment_chat_room" ("recruitment_id", "room_scope_key");

CREATE TRIGGER "team_recruitment_chat_room__updated_at_on_update" AFTER UPDATE ON "team_recruitment_chat_room" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."recruitment_id" IS NOT OLD."recruitment_id" OR NEW."room_scope_key" IS NOT OLD."room_scope_key" OR NEW."room_type" IS NOT OLD."room_type" OR NEW."application_id" IS NOT OLD."application_id" OR NEW."status" IS NOT OLD."status" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "team_recruitment_chat_room" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "team_recruitment_notification" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "recipient_id" INTEGER NOT NULL CHECK ("recipient_id" IS NULL OR typeof("recipient_id") = 'integer') CHECK ("recipient_id" >= 0 AND "recipient_id" <= 4294967295),
  "type" TEXT COLLATE NOCASE NOT NULL CHECK (length("type") <= 32),
  "target_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("target_type") <= 32),
  "message_preview" TEXT COLLATE NOCASE NOT NULL CHECK (length("message_preview") <= 255),
  "sender_nickname" TEXT COLLATE NOCASE CHECK (length("sender_nickname") <= 50),
  "recruitment_id" INTEGER NOT NULL CHECK ("recruitment_id" IS NULL OR typeof("recruitment_id") = 'integer') CHECK ("recruitment_id" >= 0 AND "recruitment_id" <= 4294967295),
  "application_id" INTEGER CHECK ("application_id" IS NULL OR typeof("application_id") = 'integer') CHECK ("application_id" >= 0 AND "application_id" <= 4294967295),
  "chat_room_id" INTEGER CHECK ("chat_room_id" IS NULL OR typeof("chat_room_id") = 'integer') CHECK ("chat_room_id" >= 0 AND "chat_room_id" <= 4294967295),
  "read_at" TEXT,
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "native_event_key" TEXT,
  CONSTRAINT "fk_team_recruitment_notification_application_recruitment" FOREIGN KEY ("application_id", "recruitment_id") REFERENCES "team_recruitment_application" ("id", "recruitment_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "fk_team_recruitment_notification_chat_room_recruitment" FOREIGN KEY ("chat_room_id", "recruitment_id") REFERENCES "team_recruitment_chat_room" ("id", "recruitment_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "fk_team_recruitment_notification_recipient_id_withdrawal" FOREIGN KEY ("recipient_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "fk_team_recruitment_notification_recruitment_id" FOREIGN KEY ("recruitment_id") REFERENCES "team_recruitment" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "chk_team_recruitment_notification_is_deleted" CHECK ((`is_deleted` in (0,1))),
  CONSTRAINT "chk_team_recruitment_notification_sender" CHECK ((((`type` = 'NEW_CHAT_MESSAGE') and (`sender_nickname` is not null)) or ((`type` <> 'NEW_CHAT_MESSAGE') and (`sender_nickname` is null)))),
  CONSTRAINT "chk_team_recruitment_notification_target_type" CHECK ((`target_type` in ('APPLICANT_MANAGEMENT','CHAT_ROOM','MY_APPLICATIONS','NONE'))),
  CONSTRAINT "chk_team_recruitment_notification_type" CHECK ((`type` in ('NEW_APPLICATION','APPLICATION_ACCEPTED','APPLICATION_REJECTED','RECRUITMENT_CLOSED','RECRUITMENT_DELETED','NEW_CHAT_MESSAGE')))
);

CREATE INDEX "team_recruitment_notification__fk_team_recruitment_notification_application_recruitment" ON "team_recruitment_notification" ("application_id", "recruitment_id");

CREATE INDEX "team_recruitment_notification__fk_team_recruitment_notification_chat_room_recruitment" ON "team_recruitment_notification" ("chat_room_id", "recruitment_id");

CREATE INDEX "team_recruitment_notification__fk_team_recruitment_notification_recruitment_id" ON "team_recruitment_notification" ("recruitment_id");

CREATE INDEX "team_recruitment_notification__idx_team_recruitment_notification_recipient_deleted_id" ON "team_recruitment_notification" ("recipient_id", "is_deleted", "id");

CREATE INDEX "team_recruitment_notification__idx_team_recruitment_notification_recipient_deleted_read_id" ON "team_recruitment_notification" ("recipient_id", "is_deleted", "read_at", "id");

CREATE UNIQUE INDEX "team_recruitment_notification__native_event_key_unique" ON "team_recruitment_notification" ("native_event_key");

CREATE TRIGGER "team_recruitment_notification__updated_at_on_update" AFTER UPDATE ON "team_recruitment_notification" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."recipient_id" IS NOT OLD."recipient_id" OR NEW."type" IS NOT OLD."type" OR NEW."target_type" IS NOT OLD."target_type" OR NEW."message_preview" IS NOT OLD."message_preview" OR NEW."sender_nickname" IS NOT OLD."sender_nickname" OR NEW."recruitment_id" IS NOT OLD."recruitment_id" OR NEW."application_id" IS NOT OLD."application_id" OR NEW."chat_room_id" IS NOT OLD."chat_room_id" OR NEW."read_at" IS NOT OLD."read_at" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."native_event_key" IS NOT OLD."native_event_key") BEGIN UPDATE "team_recruitment_notification" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "team_recruitment_outbox_event" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "event_key" TEXT COLLATE NOCASE NOT NULL CHECK (length("event_key") <= 255),
  "event_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("event_type") <= 64),
  "aggregate_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("aggregate_type") <= 64),
  "aggregate_id" INTEGER NOT NULL CHECK ("aggregate_id" IS NULL OR typeof("aggregate_id") = 'integer') CHECK ("aggregate_id" >= 0 AND "aggregate_id" <= 4294967295),
  "payload" TEXT NOT NULL CHECK ("payload" IS NULL OR json_valid("payload")),
  "status" TEXT COLLATE NOCASE NOT NULL DEFAULT ('PENDING') CHECK (length("status") <= 16),
  "attempt_count" INTEGER NOT NULL DEFAULT ('0') CHECK ("attempt_count" IS NULL OR typeof("attempt_count") = 'integer') CHECK ("attempt_count" >= 0 AND "attempt_count" <= 4294967295),
  "next_attempt_at" TEXT,
  "locked_until" TEXT,
  "worker_id" TEXT COLLATE NOCASE CHECK (length("worker_id") <= 100),
  "published_at" TEXT,
  "last_error" TEXT COLLATE NOCASE CHECK (length("last_error") <= 500),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "chk_team_recruitment_outbox_status" CHECK ((`status` in ('PENDING','PROCESSING','PUBLISHED','FAILED')))
);

CREATE INDEX "team_recruitment_outbox_event__idx_team_recruitment_outbox_claim" ON "team_recruitment_outbox_event" ("status", "next_attempt_at", "locked_until", "attempt_count", "id");

CREATE INDEX "team_recruitment_outbox_event__idx_team_recruitment_outbox_status_next_attempt" ON "team_recruitment_outbox_event" ("status", "next_attempt_at", "id");

CREATE UNIQUE INDEX "team_recruitment_outbox_event__uk_team_recruitment_outbox_event_key" ON "team_recruitment_outbox_event" ("event_key");

CREATE TRIGGER "team_recruitment_outbox_event__updated_at_on_update" AFTER UPDATE ON "team_recruitment_outbox_event" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."event_key" IS NOT OLD."event_key" OR NEW."event_type" IS NOT OLD."event_type" OR NEW."aggregate_type" IS NOT OLD."aggregate_type" OR NEW."aggregate_id" IS NOT OLD."aggregate_id" OR NEW."payload" IS NOT OLD."payload" OR NEW."status" IS NOT OLD."status" OR NEW."attempt_count" IS NOT OLD."attempt_count" OR NEW."next_attempt_at" IS NOT OLD."next_attempt_at" OR NEW."locked_until" IS NOT OLD."locked_until" OR NEW."worker_id" IS NOT OLD."worker_id" OR NEW."published_at" IS NOT OLD."published_at" OR NEW."last_error" IS NOT OLD."last_error" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "team_recruitment_outbox_event" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "team_recruitment_profile" (
  "user_id" INTEGER PRIMARY KEY NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "profile_nickname" TEXT COLLATE NOCASE NOT NULL CHECK (length("profile_nickname") <= 20),
  "preferred_role" TEXT COLLATE NOCASE NOT NULL CHECK (length("preferred_role") <= 20),
  "self_introduction" TEXT COLLATE NOCASE NOT NULL CHECK (length("self_introduction") <= 1000),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_team_recruitment_profile_user_id" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TRIGGER "team_recruitment_profile__updated_at_on_update" AFTER UPDATE ON "team_recruitment_profile" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."user_id" IS NOT OLD."user_id" OR NEW."profile_nickname" IS NOT OLD."profile_nickname" OR NEW."preferred_role" IS NOT OLD."preferred_role" OR NEW."self_introduction" IS NOT OLD."self_introduction" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "team_recruitment_profile" SET "updated_at" = CURRENT_TIMESTAMP WHERE "user_id" = NEW."user_id"; END;

CREATE TABLE "team_recruitment_profile_activity" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "profile_user_id" INTEGER NOT NULL CHECK ("profile_user_id" IS NULL OR typeof("profile_user_id") = 'integer') CHECK ("profile_user_id" >= 0 AND "profile_user_id" <= 4294967295),
  "title" TEXT COLLATE NOCASE NOT NULL CHECK (length("title") <= 50),
  "started_at" TEXT NOT NULL,
  "ended_at" TEXT,
  "is_ongoing" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_ongoing" IS NULL OR typeof("is_ongoing") = 'integer') CHECK ("is_ongoing" IN (0, 1)),
  "description" TEXT COLLATE NOCASE NOT NULL CHECK (length("description") <= 1000),
  "display_order" INTEGER NOT NULL CHECK ("display_order" IS NULL OR typeof("display_order") = 'integer') CHECK ("display_order" >= 0 AND "display_order" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_team_recruitment_profile_activity_profile_user_id" FOREIGN KEY ("profile_user_id") REFERENCES "team_recruitment_profile" ("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "chk_team_recruitment_profile_activity_display_order" CHECK ((`display_order` >= 1)),
  CONSTRAINT "chk_team_recruitment_profile_activity_ongoing" CHECK ((((`is_ongoing` = 1) and (`ended_at` is null)) or ((`is_ongoing` = 0) and (`ended_at` is not null) and (`started_at` <= `ended_at`))))
);

CREATE UNIQUE INDEX "team_recruitment_profile_activity__uk_team_recruitment_profile_activity_user_order" ON "team_recruitment_profile_activity" ("profile_user_id", "display_order");

CREATE TRIGGER "team_recruitment_profile_activity__updated_at_on_update" AFTER UPDATE ON "team_recruitment_profile_activity" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."profile_user_id" IS NOT OLD."profile_user_id" OR NEW."title" IS NOT OLD."title" OR NEW."started_at" IS NOT OLD."started_at" OR NEW."ended_at" IS NOT OLD."ended_at" OR NEW."is_ongoing" IS NOT OLD."is_ongoing" OR NEW."description" IS NOT OLD."description" OR NEW."display_order" IS NOT OLD."display_order" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "team_recruitment_profile_activity" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "team_recruitment_profile_skill" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "profile_user_id" INTEGER NOT NULL CHECK ("profile_user_id" IS NULL OR typeof("profile_user_id") = 'integer') CHECK ("profile_user_id" >= 0 AND "profile_user_id" <= 4294967295),
  "skill" TEXT COLLATE NOCASE NOT NULL CHECK (length("skill") <= 20),
  "display_order" INTEGER NOT NULL CHECK ("display_order" IS NULL OR typeof("display_order") = 'integer') CHECK ("display_order" >= 0 AND "display_order" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_team_recruitment_profile_skill_profile_user_id" FOREIGN KEY ("profile_user_id") REFERENCES "team_recruitment_profile" ("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "chk_team_recruitment_profile_skill_display_order" CHECK ((`display_order` >= 1))
);

CREATE UNIQUE INDEX "team_recruitment_profile_skill__uk_team_recruitment_profile_skill_user_order" ON "team_recruitment_profile_skill" ("profile_user_id", "display_order");

CREATE TRIGGER "team_recruitment_profile_skill__updated_at_on_update" AFTER UPDATE ON "team_recruitment_profile_skill" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."profile_user_id" IS NOT OLD."profile_user_id" OR NEW."skill" IS NOT OLD."skill" OR NEW."display_order" IS NOT OLD."display_order" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "team_recruitment_profile_skill" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "team_recruitment_role" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "recruitment_id" INTEGER NOT NULL CHECK ("recruitment_id" IS NULL OR typeof("recruitment_id") = 'integer') CHECK ("recruitment_id" >= 0 AND "recruitment_id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 10),
  "max_participants" INTEGER NOT NULL CHECK ("max_participants" IS NULL OR typeof("max_participants") = 'integer') CHECK ("max_participants" >= 0 AND "max_participants" <= 4294967295),
  "current_participants" INTEGER NOT NULL DEFAULT ('0') CHECK ("current_participants" IS NULL OR typeof("current_participants") = 'integer') CHECK ("current_participants" >= 0 AND "current_participants" <= 4294967295),
  "display_order" INTEGER NOT NULL CHECK ("display_order" IS NULL OR typeof("display_order") = 'integer') CHECK ("display_order" >= 0 AND "display_order" <= 4294967295),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "fk_team_recruitment_role_recruitment_id" FOREIGN KEY ("recruitment_id") REFERENCES "team_recruitment" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "chk_team_recruitment_role_max_participants" CHECK ((`max_participants` between 1 and 10)),
  CONSTRAINT "chk_team_recruitment_role_current_participants" CHECK ((`current_participants` <= `max_participants`)),
  CONSTRAINT "chk_team_recruitment_role_display_order" CHECK ((`display_order` between 1 and 5))
);

CREATE UNIQUE INDEX "team_recruitment_role__uk_team_recruitment_role_id_recruitment" ON "team_recruitment_role" ("id", "recruitment_id");

CREATE UNIQUE INDEX "team_recruitment_role__uk_team_recruitment_role_recruitment_name" ON "team_recruitment_role" ("recruitment_id", "name");

CREATE UNIQUE INDEX "team_recruitment_role__uk_team_recruitment_role_recruitment_order" ON "team_recruitment_role" ("recruitment_id", "display_order");

CREATE TRIGGER "team_recruitment_role__updated_at_on_update" AFTER UPDATE ON "team_recruitment_role" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."recruitment_id" IS NOT OLD."recruitment_id" OR NEW."name" IS NOT OLD."name" OR NEW."max_participants" IS NOT OLD."max_participants" OR NEW."current_participants" IS NOT OLD."current_participants" OR NEW."display_order" IS NOT OLD."display_order" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "team_recruitment_role" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "team_recruitment_user_lock" (
  "user_id" INTEGER PRIMARY KEY NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295)
);

CREATE TABLE "tech_stacks" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "image_url" TEXT,
  "name" TEXT NOT NULL CHECK (length("name") <= 50),
  "description" TEXT CHECK (length("description") <= 100),
  "track_id" INTEGER NOT NULL CHECK ("track_id" IS NULL OR typeof("track_id") = 'integer') CHECK ("track_id" >= 0 AND "track_id" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "tech_stacks__updated_at_on_update" AFTER UPDATE ON "tech_stacks" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."image_url" IS NOT OLD."image_url" OR NEW."name" IS NOT OLD."name" OR NEW."description" IS NOT OLD."description" OR NEW."track_id" IS NOT OLD."track_id" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "tech_stacks" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "timetable_frame" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "semester_id" INTEGER NOT NULL CHECK ("semester_id" IS NULL OR typeof("semester_id") = 'integer') CHECK ("semester_id" >= 0 AND "semester_id" <= 4294967295),
  "name" TEXT COLLATE NOCASE NOT NULL CHECK (length("name") <= 255),
  "is_main" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_main" IS NULL OR typeof("is_main") = 'integer') CHECK ("is_main" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "timetable_frame__timetable_frame_INDEX" ON "timetable_frame" ("user_id", "semester_id");

CREATE TRIGGER "timetable_frame__updated_at_on_update" AFTER UPDATE ON "timetable_frame" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."semester_id" IS NOT OLD."semester_id" OR NEW."name" IS NOT OLD."name" OR NEW."is_main" IS NOT OLD."is_main" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "timetable_frame" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "timetable_lecture" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "class_title" TEXT COLLATE NOCASE CHECK (length("class_title") <= 255),
  "class_time" TEXT COLLATE NOCASE,
  "class_place" TEXT COLLATE NOCASE,
  "professor" TEXT COLLATE NOCASE CHECK (length("professor") <= 255),
  "grades" TEXT COLLATE NOCASE NOT NULL DEFAULT ('0') CHECK (length("grades") <= 2),
  "memo" TEXT COLLATE NOCASE CHECK (length("memo") <= 255),
  "is_deleted" INTEGER DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "lectures_id" INTEGER CHECK ("lectures_id" IS NULL OR typeof("lectures_id") = 'integer') CHECK ("lectures_id" >= 0 AND "lectures_id" <= 4294967295),
  "frame_id" INTEGER CHECK ("frame_id" IS NULL OR typeof("frame_id") = 'integer') CHECK ("frame_id" >= 0 AND "frame_id" <= 4294967295),
  "course_type_id" INTEGER CHECK ("course_type_id" IS NULL OR typeof("course_type_id") = 'integer') CHECK ("course_type_id" >= 0 AND "course_type_id" <= 4294967295),
  "general_education_area_id" INTEGER CHECK ("general_education_area_id" IS NULL OR typeof("general_education_area_id") = 'integer') CHECK ("general_education_area_id" >= 0 AND "general_education_area_id" <= 4294967295),
  CONSTRAINT "FK_COURSE_TYPE_ON_TIMETABLE_LECTURE" FOREIGN KEY ("course_type_id") REFERENCES "course_type" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "FK_GENERAL_EDUCATION_AREA_ON_TIMETABLE_LECTURE" FOREIGN KEY ("general_education_area_id") REFERENCES "general_education_area" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "FK_TIMETABLE_FRAME_ON_TIMETABLE_LECTURE" FOREIGN KEY ("frame_id") REFERENCES "timetable_frame" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "timetable_lecture__FK_COURSE_TYPE_ON_TIMETABLE_LECTURE" ON "timetable_lecture" ("course_type_id");

CREATE INDEX "timetable_lecture__FK_GENERAL_EDUCATION_AREA_ON_TIMETABLE_LECTURE" ON "timetable_lecture" ("general_education_area_id");

CREATE INDEX "timetable_lecture__FK_TIMETABLE_FRAME_ON_TIMETABLE_LECTURE" ON "timetable_lecture" ("frame_id");

CREATE TRIGGER "timetable_lecture__updated_at_on_update" AFTER UPDATE ON "timetable_lecture" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."class_title" IS NOT OLD."class_title" OR NEW."class_time" IS NOT OLD."class_time" OR NEW."class_place" IS NOT OLD."class_place" OR NEW."professor" IS NOT OLD."professor" OR NEW."grades" IS NOT OLD."grades" OR NEW."memo" IS NOT OLD."memo" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."lectures_id" IS NOT OLD."lectures_id" OR NEW."frame_id" IS NOT OLD."frame_id" OR NEW."course_type_id" IS NOT OLD."course_type_id" OR NEW."general_education_area_id" IS NOT OLD."general_education_area_id") BEGIN UPDATE "timetable_lecture" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "tracks" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "name" TEXT NOT NULL CHECK (length("name") <= 50),
  "headcount" INTEGER NOT NULL DEFAULT ('0') CHECK ("headcount" IS NULL OR typeof("headcount") = 'integer') CHECK ("headcount" >= 0 AND "headcount" <= 4294967295),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TRIGGER "tracks__updated_at_on_update" AFTER UPDATE ON "tracks" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."name" IS NOT OLD."name" OR NEW."headcount" IS NOT OLD."headcount" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "tracks" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "user_delivery_address" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "address_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("address_type") <= 20),
  "campus_delivery_address_id" INTEGER CHECK ("campus_delivery_address_id" IS NULL OR typeof("campus_delivery_address_id") = 'integer') CHECK ("campus_delivery_address_id" >= 0 AND "campus_delivery_address_id" <= 4294967295),
  "zip_number" TEXT COLLATE NOCASE CHECK (length("zip_number") <= 10),
  "si_do" TEXT COLLATE NOCASE CHECK (length("si_do") <= 50),
  "si_gun_gu" TEXT COLLATE NOCASE CHECK (length("si_gun_gu") <= 50),
  "eup_myeon_dong" TEXT COLLATE NOCASE CHECK (length("eup_myeon_dong") <= 50),
  "road" TEXT COLLATE NOCASE CHECK (length("road") <= 50),
  "building" TEXT COLLATE NOCASE CHECK (length("building") <= 50),
  "address" TEXT COLLATE NOCASE,
  "detail_address" TEXT COLLATE NOCASE CHECK (length("detail_address") <= 100),
  "full_address" TEXT COLLATE NOCASE CHECK (length("full_address") <= 255),
  "last_used_at" TEXT,
  "usage_count" INTEGER DEFAULT ('0') CHECK ("usage_count" IS NULL OR typeof("usage_count") = 'integer') CHECK ("usage_count" >= 0 AND "usage_count" <= 4294967295),
  "is_default" INTEGER DEFAULT ('0') CHECK ("is_default" IS NULL OR typeof("is_default") = 'integer') CHECK ("is_default" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX "user_delivery_address__idx_user_address" ON "user_delivery_address" ("user_id");

CREATE TRIGGER "user_delivery_address__updated_at_on_update" AFTER UPDATE ON "user_delivery_address" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."address_type" IS NOT OLD."address_type" OR NEW."campus_delivery_address_id" IS NOT OLD."campus_delivery_address_id" OR NEW."zip_number" IS NOT OLD."zip_number" OR NEW."si_do" IS NOT OLD."si_do" OR NEW."si_gun_gu" IS NOT OLD."si_gun_gu" OR NEW."eup_myeon_dong" IS NOT OLD."eup_myeon_dong" OR NEW."road" IS NOT OLD."road" OR NEW."building" IS NOT OLD."building" OR NEW."address" IS NOT OLD."address" OR NEW."detail_address" IS NOT OLD."detail_address" OR NEW."full_address" IS NOT OLD."full_address" OR NEW."last_used_at" IS NOT OLD."last_used_at" OR NEW."usage_count" IS NOT OLD."usage_count" OR NEW."is_default" IS NOT OLD."is_default" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "user_delivery_address" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "user_notification_status" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" >= 0 AND "user_id" <= 4294967295),
  "last_notified_article_id" INTEGER NOT NULL CHECK ("last_notified_article_id" IS NULL OR typeof("last_notified_article_id") = 'integer') CHECK ("last_notified_article_id" BETWEEN -2147483648 AND 2147483647),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "user_notification_status_ibfk_1" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "user_notification_status__uk_user_id" ON "user_notification_status" ("user_id");

CREATE TRIGGER "user_notification_status__updated_at_on_update" AFTER UPDATE ON "user_notification_status" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."user_id" IS NOT OLD."user_id" OR NEW."last_notified_article_id" IS NOT OLD."last_notified_article_id" OR NEW."created_at" IS NOT OLD."created_at") BEGIN UPDATE "user_notification_status" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "users" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "password" TEXT COLLATE NOCASE NOT NULL,
  "nickname" TEXT COLLATE NOCASE CHECK (length("nickname") <= 50),
  "name" TEXT COLLATE NOCASE CHECK (length("name") <= 50),
  "phone_number" TEXT COLLATE NOCASE CHECK (length("phone_number") <= 255),
  "user_type" TEXT COLLATE NOCASE NOT NULL CHECK (length("user_type") <= 255),
  "email" TEXT COLLATE NOCASE CHECK (length("email") <= 100),
  "gender" INTEGER CHECK ("gender" IS NULL OR typeof("gender") = 'integer') CHECK ("gender" >= 0 AND "gender" <= 4294967295),
  "is_authed" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_authed" IS NULL OR typeof("is_authed") = 'integer') CHECK ("is_authed" IN (0, 1)),
  "last_logged_at" TEXT,
  "profile_image_url" TEXT COLLATE NOCASE CHECK (length("profile_image_url") <= 255),
  "is_deleted" INTEGER NOT NULL DEFAULT ('0') CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "anonymous_nickname" TEXT COLLATE NOCASE NOT NULL CHECK (length("anonymous_nickname") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "device_token" TEXT COLLATE NOCASE CHECK (length("device_token") <= 255),
  "user_id" TEXT COLLATE NOCASE CHECK (length("user_id") <= 255)
);

CREATE UNIQUE INDEX "users__anonymous_nickname" ON "users" ("anonymous_nickname");

CREATE UNIQUE INDEX "users__anonymous_nickname_2" ON "users" ("anonymous_nickname");

CREATE UNIQUE INDEX "users__nickname_UNIQUE" ON "users" ("nickname");

CREATE UNIQUE INDEX "users__uq_users_email" ON "users" ("email");

CREATE UNIQUE INDEX "users__uq_users_login_id" ON "users" ("user_id");

CREATE UNIQUE INDEX "users__uq_users_nickname" ON "users" ("nickname");

CREATE UNIQUE INDEX "users__uq_users_phone_number" ON "users" ("phone_number");

CREATE TRIGGER "users__updated_at_on_update" AFTER UPDATE ON "users" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."password" IS NOT OLD."password" OR NEW."nickname" IS NOT OLD."nickname" OR NEW."name" IS NOT OLD."name" OR NEW."phone_number" IS NOT OLD."phone_number" OR NEW."user_type" IS NOT OLD."user_type" OR NEW."email" IS NOT OLD."email" OR NEW."gender" IS NOT OLD."gender" OR NEW."is_authed" IS NOT OLD."is_authed" OR NEW."last_logged_at" IS NOT OLD."last_logged_at" OR NEW."profile_image_url" IS NOT OLD."profile_image_url" OR NEW."is_deleted" IS NOT OLD."is_deleted" OR NEW."anonymous_nickname" IS NOT OLD."anonymous_nickname" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."device_token" IS NOT OLD."device_token" OR NEW."user_id" IS NOT OLD."user_id") BEGIN UPDATE "users" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "versions" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" >= 0 AND "id" <= 4294967295),
  "version" TEXT COLLATE NOCASE NOT NULL CHECK (length("version") <= 255),
  "type" TEXT COLLATE NOCASE CHECK (length("type") <= 255),
  "created_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "title" TEXT COLLATE NOCASE CHECK (length("title") <= 255),
  "is_previous" INTEGER CHECK ("is_previous" IS NULL OR typeof("is_previous") = 'integer') CHECK ("is_previous" IN (0, 1)),
  "content" TEXT COLLATE NOCASE
);

CREATE INDEX "versions__idx_versions_type_previous" ON "versions" ("type", "is_previous");

CREATE TRIGGER "versions__updated_at_on_update" AFTER UPDATE ON "versions" WHEN NEW."updated_at" IS OLD."updated_at" AND (NEW."id" IS NOT OLD."id" OR NEW."version" IS NOT OLD."version" OR NEW."type" IS NOT OLD."type" OR NEW."created_at" IS NOT OLD."created_at" OR NEW."title" IS NOT OLD."title" OR NEW."is_previous" IS NOT OLD."is_previous" OR NEW."content" IS NOT OLD."content") BEGIN UPDATE "versions" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."id"; END;

CREATE TABLE "native_sequence" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "value" TEXT NOT NULL DEFAULT ('0') CHECK ("value" IS NULL OR (typeof("value") = 'text' AND "value" = CAST(CAST("value" AS INTEGER) AS TEXT))),
  CONSTRAINT "native_sequence_check_0" CHECK (CAST(value AS INTEGER) >= 0)
);

CREATE TABLE "native_collation_key" (
  "scope" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "normalized" TEXT NOT NULL,
  PRIMARY KEY ("scope", "owner")
);

CREATE UNIQUE INDEX "native_collation_key__index_0" ON "native_collation_key" ("scope", "normalized");

CREATE TABLE "native_import_checkpoint" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "sha256" TEXT NOT NULL,
  "row_count" INTEGER NOT NULL CHECK ("row_count" IS NULL OR typeof("row_count") = 'integer') CHECK ("row_count" BETWEEN -9007199254740991 AND 9007199254740991),
  "completed_at" TEXT NOT NULL
);

CREATE TABLE "native_import_control" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "active" INTEGER NOT NULL DEFAULT (0) CHECK ("active" IS NULL OR typeof("active") = 'integer') CHECK ("active" IN (0, 1))
);

CREATE TABLE "native_article_summary_execution" (
  "id" INTEGER PRIMARY KEY NOT NULL CHECK ("id" IS NULL OR typeof("id") = 'integer') CHECK ("id" BETWEEN -9007199254740991 AND 9007199254740991),
  "worker_id" TEXT NOT NULL,
  "locked_until" TEXT NOT NULL
);

CREATE TABLE "native_catalog_request_guard" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "expires_at" INTEGER NOT NULL CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT "native_catalog_request_guard_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "native_catalog_request_guard__index_0" ON "native_catalog_request_guard" ("expires_at");

CREATE TABLE "native_legacy_redis" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "type" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "expires_at" INTEGER CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "disposition" TEXT NOT NULL
);

CREATE TABLE "native_legacy_mongo" (
  "collection" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  PRIMARY KEY ("collection", "source_id")
);

CREATE TABLE "identity_web_sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "refresh_token_hash" TEXT NOT NULL,
  "csrf_token" TEXT NOT NULL,
  "credential_hash" TEXT NOT NULL,
  "expires_at" INTEGER NOT NULL CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "auto_login" INTEGER NOT NULL DEFAULT (0) CHECK ("auto_login" IS NULL OR typeof("auto_login") = 'integer') CHECK ("auto_login" IN (0, 1)),
  CONSTRAINT "identity_web_sessions_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "identity_web_sessions__index_0" ON "identity_web_sessions" ("user_id");

CREATE INDEX "identity_web_sessions__index_1" ON "identity_web_sessions" ("expires_at");

CREATE TABLE "identity_native_sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "platform" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "expires_at" INTEGER NOT NULL CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT "identity_native_sessions_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "identity_native_sessions__index_0" ON "identity_native_sessions" ("user_id");

CREATE INDEX "identity_native_sessions__index_1" ON "identity_native_sessions" ("expires_at");

CREATE TABLE "identity_verifications" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "target" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "verified" INTEGER NOT NULL DEFAULT (0) CHECK ("verified" IS NULL OR typeof("verified") = 'integer') CHECK ("verified" IN (0, 1)),
  "trial_count" INTEGER NOT NULL DEFAULT (0) CHECK ("trial_count" IS NULL OR typeof("trial_count") = 'integer') CHECK ("trial_count" BETWEEN -9007199254740991 AND 9007199254740991),
  "expires_at" INTEGER NOT NULL CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE TABLE "identity_verification_limits" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "send_count" INTEGER NOT NULL DEFAULT (0) CHECK ("send_count" IS NULL OR typeof("send_count") = 'integer') CHECK ("send_count" BETWEEN -9007199254740991 AND 9007199254740991),
  "verify_count" INTEGER NOT NULL DEFAULT (0) CHECK ("verify_count" IS NULL OR typeof("verify_count") = 'integer') CHECK ("verify_count" BETWEEN -9007199254740991 AND 9007199254740991),
  "expires_at" INTEGER NOT NULL CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE TABLE "identity_tokens" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "kind" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "user_id" INTEGER CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "payload" TEXT,
  "expires_at" INTEGER NOT NULL CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT "identity_tokens_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "identity_tokens__index_0" ON "identity_tokens" ("expires_at");

CREATE TABLE "identity_atomic_guards" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "allowed" INTEGER NOT NULL CHECK ("allowed" IS NULL OR typeof("allowed") = 'integer') CHECK ("allowed" BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT "identity_atomic_guards_check_0" CHECK (allowed = 1)
);

CREATE TABLE "identity_outbox" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL CHECK ("created_at" IS NULL OR typeof("created_at") = 'integer') CHECK ("created_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "delivered_at" INTEGER CHECK ("delivered_at" IS NULL OR typeof("delivered_at") = 'integer') CHECK ("delivered_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "attempts" INTEGER NOT NULL DEFAULT (0) CHECK ("attempts" IS NULL OR typeof("attempts") = 'integer') CHECK ("attempts" BETWEEN -9007199254740991 AND 9007199254740991),
  "next_attempt_at" INTEGER NOT NULL DEFAULT (0) CHECK ("next_attempt_at" IS NULL OR typeof("next_attempt_at") = 'integer') CHECK ("next_attempt_at" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE INDEX "identity_outbox__index_0" ON "identity_outbox" ("delivered_at", "next_attempt_at");

CREATE TABLE "native_integration_rate_limit" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "next_at" INTEGER NOT NULL CHECK ("next_at" IS NULL OR typeof("next_at") = 'integer') CHECK ("next_at" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE TABLE "native_dining_guard" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "version" INTEGER NOT NULL DEFAULT (0) CHECK ("version" IS NULL OR typeof("version") = 'integer') CHECK ("version" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE TABLE "native_dining_assert" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "valid" INTEGER NOT NULL CHECK ("valid" IS NULL OR typeof("valid") = 'integer') CHECK ("valid" BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT "native_dining_assert_check_0" CHECK (valid = 1)
);

CREATE TABLE "native_article_keyword_suggestion" (
  "keyword_id" INTEGER PRIMARY KEY NOT NULL CHECK ("keyword_id" IS NULL OR typeof("keyword_id") = 'integer') CHECK ("keyword_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "keyword" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "count" INTEGER NOT NULL CHECK ("count" IS NULL OR typeof("count") = 'integer') CHECK ("count" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE TABLE "native_community_outbox" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL CHECK ("created_at" IS NULL OR typeof("created_at") = 'integer') CHECK ("created_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "delivered_at" INTEGER CHECK ("delivered_at" IS NULL OR typeof("delivered_at") = 'integer') CHECK ("delivered_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "lease_until" INTEGER CHECK ("lease_until" IS NULL OR typeof("lease_until") = 'integer') CHECK ("lease_until" BETWEEN -9007199254740991 AND 9007199254740991),
  "attempts" INTEGER NOT NULL DEFAULT (0) CHECK ("attempts" IS NULL OR typeof("attempts") = 'integer') CHECK ("attempts" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE INDEX "native_community_outbox__index_0" ON "native_community_outbox" ("delivered_at", "lease_until");

CREATE TABLE "native_team_request_guard" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "expires_at" TEXT NOT NULL,
  "recruitment_id" INTEGER CHECK ("recruitment_id" IS NULL OR typeof("recruitment_id") = 'integer') CHECK ("recruitment_id" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE INDEX "native_team_request_guard__index_0" ON "native_team_request_guard" ("expires_at");

CREATE TABLE "native_dining_rate_limit" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "expires_at" TEXT NOT NULL
);

CREATE TABLE "native_dining_outbox" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "due_at" TEXT NOT NULL,
  "lease_token" TEXT,
  "lease_expires_at" TEXT,
  "delivered_at" TEXT
);

CREATE INDEX "native_dining_outbox__index_0" ON "native_dining_outbox" ("due_at", "delivered_at");

CREATE TABLE "native_article_hit_user" (
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "public_ip" TEXT NOT NULL,
  "expires_at" INTEGER NOT NULL CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY ("article_id", "public_ip")
);

CREATE TABLE "native_article_hit_snapshot" (
  "article_id" INTEGER PRIMARY KEY NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "hit" INTEGER NOT NULL CHECK ("hit" IS NULL OR typeof("hit") = 'integer') CHECK ("hit" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE TABLE "native_hot_article" (
  "article_id" INTEGER PRIMARY KEY NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "score" INTEGER NOT NULL CHECK ("score" IS NULL OR typeof("score") = 'integer') CHECK ("score" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE TABLE "native_article_search_count" (
  "public_ip" TEXT NOT NULL,
  "keyword" TEXT NOT NULL,
  "count" INTEGER NOT NULL CHECK ("count" IS NULL OR typeof("count") = 'integer') CHECK ("count" BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY ("public_ip", "keyword")
);

CREATE TABLE "native_popular_keyword" (
  "keyword" TEXT PRIMARY KEY NOT NULL,
  "weight" REAL NOT NULL CHECK ("weight" IS NULL OR typeof("weight") IN ('real','integer'))
);

CREATE TABLE "native_article_ngram" (
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "position" INTEGER NOT NULL CHECK ("position" IS NULL OR typeof("position") = 'integer') CHECK ("position" BETWEEN -9007199254740991 AND 9007199254740991),
  "token" TEXT NOT NULL,
  PRIMARY KEY ("article_id", "position")
);

CREATE INDEX "native_article_ngram__index_0" ON "native_article_ngram" ("token", "article_id");

CREATE TABLE "native_community_schedule" (
  "name" TEXT PRIMARY KEY NOT NULL,
  "scheduled_at" INTEGER NOT NULL CHECK ("scheduled_at" IS NULL OR typeof("scheduled_at") = 'integer') CHECK ("scheduled_at" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE TABLE "lost_item_chat_room" (
  "_id" TEXT PRIMARY KEY NOT NULL,
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "chatroom_id" INTEGER NOT NULL CHECK ("chatroom_id" IS NULL OR typeof("chatroom_id") = 'integer') CHECK ("chatroom_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "article_author_id" INTEGER NOT NULL CHECK ("article_author_id" IS NULL OR typeof("article_author_id") = 'integer') CHECK ("article_author_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "item_owner_id" INTEGER NOT NULL CHECK ("item_owner_id" IS NULL OR typeof("item_owner_id") = 'integer') CHECK ("item_owner_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "created_at" TEXT NOT NULL,
  "messages" TEXT NOT NULL DEFAULT ('[]')
);

CREATE UNIQUE INDEX "lost_item_chat_room__index_0" ON "lost_item_chat_room" ("article_id", "chatroom_id");

CREATE UNIQUE INDEX "lost_item_chat_room__index_1" ON "lost_item_chat_room" ("article_id", "item_owner_id");

CREATE TABLE "lost_item_chat_user_block" (
  "_id" TEXT PRIMARY KEY NOT NULL,
  "blocker_user_id" INTEGER NOT NULL CHECK ("blocker_user_id" IS NULL OR typeof("blocker_user_id") = 'integer') CHECK ("blocker_user_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "blocked_user_id" INTEGER NOT NULL CHECK ("blocked_user_id" IS NULL OR typeof("blocked_user_id") = 'integer') CHECK ("blocked_user_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "is_active" INTEGER NOT NULL DEFAULT (1) CHECK ("is_active" IS NULL OR typeof("is_active") = 'integer') CHECK ("is_active" IN (0, 1)),
  "created_at" TEXT NOT NULL
);

CREATE UNIQUE INDEX "lost_item_chat_user_block__index_0" ON "lost_item_chat_user_block" ("blocker_user_id", "blocked_user_id");

CREATE TABLE "native_chat_message" (
  "id" TEXT PRIMARY KEY NOT NULL CHECK ("id" IS NULL OR (typeof("id") = 'text' AND "id" = CAST(CAST("id" AS INTEGER) AS TEXT))),
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "chatroom_id" INTEGER NOT NULL CHECK ("chatroom_id" IS NULL OR typeof("chatroom_id") = 'integer') CHECK ("chatroom_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "is_read" INTEGER NOT NULL DEFAULT (0) CHECK ("is_read" IS NULL OR typeof("is_read") = 'integer') CHECK ("is_read" IN (0, 1)),
  "is_deleted" INTEGER NOT NULL DEFAULT (0) CHECK ("is_deleted" IS NULL OR typeof("is_deleted") = 'integer') CHECK ("is_deleted" IN (0, 1)),
  "is_image" INTEGER CHECK ("is_image" IS NULL OR typeof("is_image") = 'integer') CHECK ("is_image" IN (0, 1)),
  "nick_name" TEXT,
  "contents" TEXT,
  "created_at" TEXT NOT NULL
);

CREATE INDEX "native_chat_message__index_0" ON "native_chat_message" ("article_id", "chatroom_id", "id");

CREATE INDEX "native_chat_message__PRIMARY_numeric" ON "native_chat_message" (CAST("id" AS INTEGER));

CREATE INDEX "native_chat_message__index_0_numeric" ON "native_chat_message" ("article_id", "chatroom_id", CAST("id" AS INTEGER));

CREATE TABLE "native_chat_polling_session" (
  "article_id" INTEGER NOT NULL CHECK ("article_id" IS NULL OR typeof("article_id") = 'integer') CHECK ("article_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "chatroom_id" INTEGER NOT NULL CHECK ("chatroom_id" IS NULL OR typeof("chatroom_id") = 'integer') CHECK ("chatroom_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "expires_at" INTEGER NOT NULL CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY ("article_id", "chatroom_id", "user_id")
);

CREATE TABLE "native_chat_outbox" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "message_id" TEXT NOT NULL,
  "receiver_id" INTEGER NOT NULL CHECK ("receiver_id" IS NULL OR typeof("receiver_id") = 'integer') CHECK ("receiver_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "payload" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL CHECK ("created_at" IS NULL OR typeof("created_at") = 'integer') CHECK ("created_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "delivered_at" INTEGER CHECK ("delivered_at" IS NULL OR typeof("delivered_at") = 'integer') CHECK ("delivered_at" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE INDEX "native_chat_outbox__index_0" ON "native_chat_outbox" ("delivered_at");

CREATE TABLE "native_club_requests" (
  "name" TEXT PRIMARY KEY NOT NULL,
  "payload" TEXT NOT NULL,
  "requester_id" INTEGER NOT NULL CHECK ("requester_id" IS NULL OR typeof("requester_id") = 'integer') CHECK ("requester_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "created_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL
);

CREATE TABLE "native_club_hits" (
  "club_id" INTEGER PRIMARY KEY NOT NULL CHECK ("club_id" IS NULL OR typeof("club_id") = 'integer') CHECK ("club_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "hits" INTEGER NOT NULL DEFAULT (0) CHECK ("hits" IS NULL OR typeof("hits") = 'integer') CHECK ("hits" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE TABLE "native_club_outbox" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "due_at" TEXT NOT NULL,
  "delivered_at" TEXT,
  "lease_until" TEXT
);

CREATE INDEX "native_club_outbox__index_0" ON "native_club_outbox" ("due_at", "delivered_at");

CREATE TABLE "native_club_cron" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "completed_at" TEXT NOT NULL
);

CREATE TABLE "native_club_hot" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "payload" TEXT NOT NULL
);

CREATE TABLE "native_callvan_guard" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "entity_id" INTEGER CHECK ("entity_id" IS NULL OR typeof("entity_id") = 'integer') CHECK ("entity_id" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE TABLE "native_callvan_event" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "post_id" INTEGER NOT NULL CHECK ("post_id" IS NULL OR typeof("post_id") = 'integer') CHECK ("post_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "type" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "available_at" TEXT NOT NULL,
  "completed_at" TEXT,
  "created_at" TEXT NOT NULL
);

CREATE INDEX "native_callvan_event__index_0" ON "native_callvan_event" ("completed_at", "available_at");

CREATE TABLE "native_callvan_delivery" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "notification_id" INTEGER NOT NULL CHECK ("notification_id" IS NULL OR typeof("notification_id") = 'integer') CHECK ("notification_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "delivered_at" TEXT,
  "lease_until" TEXT,
  "lease_token" TEXT,
  "created_at" TEXT NOT NULL,
  "next_attempt_at" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT (0) CHECK ("attempts" IS NULL OR typeof("attempts") = 'integer') CHECK ("attempts" BETWEEN -9007199254740991 AND 9007199254740991),
  "last_error" TEXT
);

CREATE UNIQUE INDEX "native_callvan_delivery__index_0" ON "native_callvan_delivery" ("notification_id");

CREATE INDEX "native_callvan_delivery__index_1" ON "native_callvan_delivery" ("delivered_at", "lease_until");

CREATE INDEX "native_callvan_delivery__index_2" ON "native_callvan_delivery" ("delivered_at", "next_attempt_at");

CREATE TABLE "native_commerce_revision" (
  "user_id" INTEGER PRIMARY KEY NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "revision" INTEGER NOT NULL DEFAULT (0) CHECK ("revision" IS NULL OR typeof("revision") = 'integer') CHECK ("revision" BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT "native_commerce_revision_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE "native_commerce_guard" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "valid" INTEGER NOT NULL CHECK ("valid" IS NULL OR typeof("valid") = 'integer') CHECK ("valid" BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT "native_commerce_guard_check_0" CHECK (valid = 1)
);

CREATE TABLE "temporary_payment" (
  "pg_order_id" TEXT PRIMARY KEY NOT NULL,
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "orderable_shop_id" INTEGER NOT NULL CHECK ("orderable_shop_id" IS NULL OR typeof("orderable_shop_id") = 'integer') CHECK ("orderable_shop_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "order_type" TEXT NOT NULL,
  "snapshot_json" TEXT NOT NULL,
  "total_price" INTEGER NOT NULL CHECK ("total_price" IS NULL OR typeof("total_price") = 'integer') CHECK ("total_price" BETWEEN -9007199254740991 AND 9007199254740991),
  "status" TEXT NOT NULL DEFAULT ('PREPARED'),
  "payment_key" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "expires_at" INTEGER NOT NULL CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "claimed_until" INTEGER CHECK ("claimed_until" IS NULL OR typeof("claimed_until") = 'integer') CHECK ("claimed_until" BETWEEN -9007199254740991 AND 9007199254740991),
  "next_attempt_at" INTEGER CHECK ("next_attempt_at" IS NULL OR typeof("next_attempt_at") = 'integer') CHECK ("next_attempt_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "attempts" INTEGER NOT NULL DEFAULT (0) CHECK ("attempts" IS NULL OR typeof("attempts") = 'integer') CHECK ("attempts" BETWEEN -9007199254740991 AND 9007199254740991),
  "gateway_json" TEXT,
  "last_error" TEXT,
  "completed_order_id" INTEGER CHECK ("completed_order_id" IS NULL OR typeof("completed_order_id") = 'integer') CHECK ("completed_order_id" BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT "temporary_payment_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "temporary_payment__index_0" ON "temporary_payment" ("payment_key");

CREATE UNIQUE INDEX "temporary_payment__index_1" ON "temporary_payment" ("idempotency_key");

CREATE INDEX "temporary_payment__index_2" ON "temporary_payment" ("status", "next_attempt_at");

CREATE INDEX "temporary_payment__index_3" ON "temporary_payment" ("user_id", "status");

CREATE TABLE "native_payment_cancel_attempt" (
  "payment_id" INTEGER PRIMARY KEY NOT NULL CHECK ("payment_id" IS NULL OR typeof("payment_id") = 'integer') CHECK ("payment_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "idempotency_key" TEXT NOT NULL,
  "cancel_reason" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "claimed_until" INTEGER CHECK ("claimed_until" IS NULL OR typeof("claimed_until") = 'integer') CHECK ("claimed_until" BETWEEN -9007199254740991 AND 9007199254740991),
  "next_attempt_at" INTEGER CHECK ("next_attempt_at" IS NULL OR typeof("next_attempt_at") = 'integer') CHECK ("next_attempt_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "attempts" INTEGER NOT NULL DEFAULT (0) CHECK ("attempts" IS NULL OR typeof("attempts") = 'integer') CHECK ("attempts" BETWEEN -9007199254740991 AND 9007199254740991),
  "gateway_json" TEXT,
  "last_error" TEXT,
  "created_at" TEXT NOT NULL,
  CONSTRAINT "native_payment_cancel_attempt_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "native_payment_cancel_attempt__index_0" ON "native_payment_cancel_attempt" ("idempotency_key");

CREATE INDEX "native_payment_cancel_attempt__index_1" ON "native_payment_cancel_attempt" ("status", "next_attempt_at");

CREATE TABLE "native_commerce_outbox" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "kind" TEXT NOT NULL,
  "aggregate_id" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "available_at" INTEGER NOT NULL CHECK ("available_at" IS NULL OR typeof("available_at") = 'integer') CHECK ("available_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "delivered_at" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT (0) CHECK ("attempts" IS NULL OR typeof("attempts") = 'integer') CHECK ("attempts" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE INDEX "native_commerce_outbox__index_0" ON "native_commerce_outbox" ("delivered_at", "available_at");

CREATE TABLE "native_cart_duplicate" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "user_id" INTEGER NOT NULL CHECK ("user_id" IS NULL OR typeof("user_id") = 'integer') CHECK ("user_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "expires_at" INTEGER NOT NULL CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT "native_cart_duplicate_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "native_cart_duplicate__index_0" ON "native_cart_duplicate" ("expires_at");

CREATE TABLE "native_catalog_outbox" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "due_at" INTEGER NOT NULL CHECK ("due_at" IS NULL OR typeof("due_at") = 'integer') CHECK ("due_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "delivered_at" INTEGER CHECK ("delivered_at" IS NULL OR typeof("delivered_at") = 'integer') CHECK ("delivered_at" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE INDEX "native_catalog_outbox__index_0" ON "native_catalog_outbox" ("due_at", "delivered_at");

CREATE TABLE "address_byeongcheon" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "road_address" TEXT,
  "jibun_address" TEXT,
  "eng_address" TEXT,
  "zip_no" TEXT,
  "bd_nm" TEXT,
  "si_nm" TEXT,
  "sgg_nm" TEXT,
  "emd_nm" TEXT,
  "li_nm" TEXT,
  "rn" TEXT
);

CREATE TABLE "abtest_variable_count" (
  "variable_id" INTEGER PRIMARY KEY NOT NULL CHECK ("variable_id" IS NULL OR typeof("variable_id") = 'integer') CHECK ("variable_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "count" INTEGER NOT NULL DEFAULT (0) CHECK ("count" IS NULL OR typeof("count") = 'integer') CHECK ("count" BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT "abtest_variable_count_variable_id_fk" FOREIGN KEY ("variable_id") REFERENCES "abtest_variable" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE "abtest_variable_assign" (
  "variable_id" INTEGER NOT NULL CHECK ("variable_id" IS NULL OR typeof("variable_id") = 'integer') CHECK ("variable_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "access_history_id" INTEGER NOT NULL CHECK ("access_history_id" IS NULL OR typeof("access_history_id") = 'integer') CHECK ("access_history_id" BETWEEN -9007199254740991 AND 9007199254740991),
  "expires_at" INTEGER NOT NULL CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY ("variable_id", "access_history_id"),
  CONSTRAINT "abtest_variable_assign_variable_id_fk" FOREIGN KEY ("variable_id") REFERENCES "abtest_variable" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "abtest_variable_assign_access_history_id_fk" FOREIGN KEY ("access_history_id") REFERENCES "access_history" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "abtest_variable_assign__index_0" ON "abtest_variable_assign" ("expires_at");

CREATE TABLE "shuttlebus_timetables" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "semester_type" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "route_type" TEXT NOT NULL,
  "route_name" TEXT NOT NULL,
  "sub_name" TEXT,
  "node_info" TEXT NOT NULL CHECK ("node_info" IS NULL OR json_valid("node_info")),
  "route_info" TEXT NOT NULL CHECK ("route_info" IS NULL OR json_valid("route_info"))
);

CREATE INDEX "shuttlebus_timetables__index_0" ON "shuttlebus_timetables" ("semester_type", "route_type");

CREATE UNIQUE INDEX "shuttlebus_timetables__index_1" ON "shuttlebus_timetables" ("semester_type", "region", "route_type", "route_name", "sub_name");

CREATE TABLE "citybus_timetables" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "bus_info" TEXT NOT NULL CHECK ("bus_info" IS NULL OR json_valid("bus_info")),
  "bus_timetables" TEXT NOT NULL CHECK ("bus_timetables" IS NULL OR json_valid("bus_timetables")),
  "updated_at" TEXT NOT NULL
);

CREATE TABLE "native_transport_cache" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "payload" TEXT NOT NULL,
  "expires_at" INTEGER CHECK ("expires_at" IS NULL OR typeof("expires_at") = 'integer') CHECK ("expires_at" BETWEEN -9007199254740991 AND 9007199254740991),
  "updated_at" INTEGER NOT NULL CHECK ("updated_at" IS NULL OR typeof("updated_at") = 'integer') CHECK ("updated_at" BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE TABLE "native_notification_outbox" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "payload" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT ('PENDING'),
  "attempts" INTEGER NOT NULL DEFAULT (0) CHECK ("attempts" IS NULL OR typeof("attempts") = 'integer') CHECK ("attempts" BETWEEN -9007199254740991 AND 9007199254740991),
  "available_at" TEXT NOT NULL,
  "locked_until" TEXT,
  "worker_id" TEXT,
  "created_at" TEXT NOT NULL,
  "completed_at" TEXT
);

CREATE INDEX "native_notification_outbox__index_0" ON "native_notification_outbox" ("status", "available_at");

INSERT INTO native_sequence(id, value) VALUES ('notification','0'), ('notification_subscribe','0');

INSERT INTO native_dining_guard(id, version) VALUES ('global',0);

INSERT INTO dining_soldout_report_sequence(id, last_sequence) VALUES (1,'0');

CREATE UNIQUE INDEX shuttlebus_identity_null ON shuttlebus_timetables(semester_type, region, route_type, route_name) WHERE sub_name IS NULL;
