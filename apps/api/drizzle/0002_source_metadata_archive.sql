CREATE TABLE "native_source_metadata_file" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "source" TEXT NOT NULL,
  "row_count" INTEGER NOT NULL CHECK(typeof("row_count") = 'integer' AND "row_count" BETWEEN 0 AND 9007199254740991),
  "byte_count" INTEGER NOT NULL CHECK(typeof("byte_count") = 'integer' AND "byte_count" BETWEEN 0 AND 9007199254740991),
  "sha256" TEXT NOT NULL CHECK(length("sha256") = 64),
  "chunk_count" INTEGER NOT NULL CHECK(typeof("chunk_count") = 'integer' AND "chunk_count" BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE "native_source_metadata_chunk" (
  "file_id" TEXT NOT NULL REFERENCES "native_source_metadata_file"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "position" INTEGER NOT NULL CHECK(typeof("position") = 'integer' AND "position" BETWEEN 0 AND 9007199254740991),
  "payload" TEXT NOT NULL,
  PRIMARY KEY ("file_id", "position")
);
