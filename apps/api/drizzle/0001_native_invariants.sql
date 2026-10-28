INSERT INTO native_import_control(id, active) VALUES ('import', 0);

CREATE TRIGGER native_catalog_review_window BEFORE INSERT ON shop_reviews
WHEN (SELECT active FROM native_import_control WHERE id = 'import') = 0
AND EXISTS (SELECT 1 FROM shop_reviews WHERE reviewer_id = NEW.reviewer_id AND shop_id = NEW.shop_id AND created_at > datetime(NEW.created_at, '-1 day'))
BEGIN SELECT RAISE(ABORT, 'CATALOG_ONE_REVIEW_PER_DAY'); END;

CREATE TRIGGER native_catalog_benefit_limit_insert BEFORE INSERT ON shop_benefit_categories
WHEN (SELECT active FROM native_import_control WHERE id = 'import') = 0 AND (SELECT count(*) FROM shop_benefit_categories) >= 6
BEGIN SELECT RAISE(ABORT, 'CATALOG_BENEFIT_LIMIT'); END;

CREATE TRIGGER native_catalog_benefit_limit_delete BEFORE DELETE ON shop_benefit_categories
WHEN (SELECT active FROM native_import_control WHERE id = 'import') = 0 AND (SELECT count(*) FROM shop_benefit_categories) <= 2
BEGIN SELECT RAISE(ABORT, 'CATALOG_BENEFIT_LIMIT'); END;

CREATE TRIGGER native_catalog_benefit_unique_insert BEFORE INSERT ON shop_benefit_categories
WHEN (SELECT active FROM native_import_control WHERE id = 'import') = 0 AND EXISTS (SELECT 1 FROM shop_benefit_categories WHERE title = NEW.title)
BEGIN SELECT RAISE(ABORT, 'CATALOG_BENEFIT_DUPLICATE'); END;

CREATE TRIGGER native_catalog_benefit_unique_update BEFORE UPDATE OF title ON shop_benefit_categories
WHEN (SELECT active FROM native_import_control WHERE id = 'import') = 0 AND EXISTS (SELECT 1 FROM shop_benefit_categories WHERE title = NEW.title AND id <> NEW.id)
BEGIN SELECT RAISE(ABORT, 'CATALOG_BENEFIT_DUPLICATE'); END;
