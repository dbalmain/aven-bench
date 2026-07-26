/**
 * Extract data files a task's tests read from disk, out of its prompt.
 *
 * Exercism describes such files inside the instructions, as an ASCII table:
 *
 *     iliad.txt
 *       ---------------------------------------------
 *       |Achilles sing, O Goddess! Peleus' son;     |
 *       ---------------------------------------------
 *
 * with the note that "the language track implementing this exercise should
 * ensure that when the tests run, three files are created". We are that track,
 * and we were not creating them — so `grep`'s suite called
 * `grep("Agamemnon", [], ["iliad.txt"])` against a file that did not exist. The
 * task was passable only by transcribing the table out of the prompt by hand,
 * which measures transcription rather than `grep`, and equally on every arm.
 *
 * A scan of all 142 tasks found `grep` is the only one affected, so this is
 * deliberately a small committed generator rather than a change to the task
 * schema and a corpus re-ingest. Output lands in `corpus/<task>/fixtures/`,
 * which `runner/attempt.ts` copies into the work directory.
 *
 *   bun run ingest/extract-fixtures.ts            # report
 *   bun run ingest/extract-fixtures.ts --write    # write the files
 *
 * The padding inside the table is alignment, not content: each line is the text
 * between the outer pipes with trailing spaces removed. The expected values in
 * the canonical data confirm it — `"Of Atreus, Agamemnon, King of men."` carries
 * no trailing whitespace.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_DIR } from "./paths.ts";

export type Fixture = { name: string; contents: string };

/** Fixture files described by an ASCII table in `prompt`, in document order. */
export function extractFixtures(prompt: string): Fixture[] {
  const lines = prompt.split("\n");
  const out: Fixture[] = [];
  let pending: string | null = null;
  let body: string[] | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    // A bare `name.ext` line announces the file whose table follows.
    const heading = /^-?\s*([A-Za-z0-9._-]+\.(?:txt|csv|json|dat))$/.exec(trimmed);
    if (heading && body === null) {
      pending = heading[1]!;
      continue;
    }

    // A rule opens the table, then closes it.
    if (/^-?\s*-{5,}$/.test(trimmed)) {
      if (pending !== null && body === null) {
        body = [];
      } else if (body !== null) {
        if (pending !== null && body.length > 0) out.push({ name: pending, contents: `${body.join("\n")}\n` });
        pending = null;
        body = null;
      }
      continue;
    }

    if (body !== null) {
      const row = /^-?\s*\|(.*)\|\s*$/.exec(line);
      // A non-row inside a table means the shape is not what we assumed. Bail
      // rather than emit a half-file: a silently truncated fixture would make
      // the suite fail for a reason no one would look for here.
      if (!row) {
        pending = null;
        body = null;
        continue;
      }
      body.push(row[1]!.trimEnd());
    }
  }
  return out;
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const { readdirSync, statSync } = await import("node:fs");
  let total = 0;

  for (const id of readdirSync(CORPUS_DIR).filter((d) => statSync(join(CORPUS_DIR, d)).isDirectory())) {
    const promptPath = join(CORPUS_DIR, id, "prompt.md");
    if (!existsSync(promptPath)) continue;
    const task = JSON.parse(readFileSync(join(CORPUS_DIR, id, "task.json"), "utf8")) as { cases: unknown };

    // Only tasks whose cases actually name a file on disk. Plenty of prompts
    // contain tables that are illustrations, not fixtures.
    const referenced = new Set(
      (JSON.stringify(task.cases).match(/"[A-Za-z0-9._-]+\.(?:txt|csv|json|dat)"/g) ?? []).map((s) => s.slice(1, -1)),
    );
    if (referenced.size === 0) continue;

    const found = extractFixtures(readFileSync(promptPath, "utf8")).filter((f) => referenced.has(f.name));
    const missing = [...referenced].filter((name) => !found.some((f) => f.name === name));

    console.log(`${id}: needs ${referenced.size}, extracted ${found.length}${missing.length ? ` — MISSING ${missing.join(", ")}` : ""}`);
    for (const f of found) console.log(`    ${f.name}  ${f.contents.split("\n").length - 1} lines`);

    if (write && found.length > 0) {
      const dir = join(CORPUS_DIR, id, "fixtures");
      mkdirSync(dir, { recursive: true });
      for (const f of found) writeFileSync(join(dir, f.name), f.contents);
      console.log(`    -> wrote ${found.length} file(s) to ${dir}`);
    }
    total += found.length;
  }

  if (!write) console.log(`\n${total} fixture(s) would be written. Re-run with --write.`);
}
