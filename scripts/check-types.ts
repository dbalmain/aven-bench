#!/usr/bin/env bun
/**
 * Validate hand-authored type annotations under annotations/types/ against the
 * corpus. Fast: no suite execution.
 *
 *   bun run check-types
 */

import { CORPUS_DIR, TYPE_ANNOTATIONS_DIR } from "../ingest/paths.ts";
import { checkAllTypeAnnotations } from "../ingest/type-annotations.ts";

const result = await checkAllTypeAnnotations(CORPUS_DIR, TYPE_ANNOTATIONS_DIR);

if (result.errors.length > 0) {
  for (const e of result.errors) console.error(e);
  console.error(
    `check-types: ${result.errors.length} error(s) in ${result.files} file(s)`,
  );
  process.exit(1);
}

console.log(
  `check-types: ok — ${result.files} file(s), ${result.positions} position(s)`,
);
