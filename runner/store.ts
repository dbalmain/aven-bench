/**
 * The data layer: append-only JSONL runs, content-addressed artifacts.
 *
 * Two rules, from §2 of the plan:
 *
 *  - **A record is never rewritten.** There is no update path in this module,
 *    only `appendRecord`. A run that dies mid-flight leaves a short file, which
 *    is a complete file of a shorter run.
 *  - **Artifacts are content-addressed**, so two identical solutions from two
 *    models are one blob and a record can be re-read years later without the
 *    work directory surviving.
 *
 * Resume reads every `data/runs/*.jsonl` and keys on `attemptKey()`. Records
 * with `outcome: "harness_error"` are *also* counted as present — a harness
 * error is data, and silently re-running it is exactly the retry-into-the-data
 * failure §3c forbids. Pass `retryHarnessErrors` to override, which is an
 * explicit act and appends a second row rather than replacing the first.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { DATA_DIR, REPO_ROOT } from "../ingest/paths.ts";
import { attemptKey, type AttemptRecord } from "./schema.ts";

export const RUNS_DIR = `${DATA_DIR}/runs`;
export const ARTIFACTS_DIR = `${DATA_DIR}/artifacts`;

export function sha256(text: string | Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(text);
  return h.digest("hex");
}

/**
 * What a record's `workDir` carries: repo-relative when inside the repo,
 * absolute otherwise. Work directories default to a location *outside* the repo
 * (see `runner/run.ts`), so the absolute case is the normal one.
 */
export function repoRelative(path: string): string {
  const rel = relative(REPO_ROOT, path);
  return rel.startsWith("..") ? path : rel;
}

/**
 * Write `text` into the artifact store, return its hash.
 *
 * `ext` is cosmetic — it keeps the store browsable — but it is part of the file
 * name, so the same bytes stored under two extensions are two files. Callers
 * should pass a stable extension per kind of artifact.
 */
export function putArtifact(text: string, ext: string): string {
  const hash = sha256(text);
  const dir = `${ARTIFACTS_DIR}/${hash.slice(0, 2)}`;
  const path = `${dir}/${hash}${ext.startsWith(".") || ext === "" ? ext : `.${ext}`}`;
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    // Write once. Content addressing means a second write would be identical,
    // so skipping it is not a correctness shortcut, just a cheap one.
    writeFileSync(path, text);
  }
  return hash;
}

export function artifactPath(hash: string, ext: string): string {
  const suffix = ext === "" || ext.startsWith(".") ? ext : `.${ext}`;
  return `${ARTIFACTS_DIR}/${hash.slice(0, 2)}/${hash}${suffix}`;
}

/** Append one record as one line. The only write path for run data. */
export function appendRecord(logPath: string, record: AttemptRecord): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

export type ResumeIndex = {
  /** Natural keys already present, and the outcome recorded for them. */
  keys: Map<string, string[]>;
  files: number;
  records: number;
  malformedLines: number;
};

/** Read every run log under `dir` and index it by natural key. */
export function loadResumeIndex(dir = RUNS_DIR): ResumeIndex {
  const index: ResumeIndex = { keys: new Map(), files: 0, records: 0, malformedLines: 0 };
  if (!existsSync(dir)) return index;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    index.files++;
    const text = readFileSync(`${dir}/${name}`, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let rec: AttemptRecord;
      try {
        rec = JSON.parse(line) as AttemptRecord;
      } catch {
        // A truncated final line is what a killed run looks like. Count it and
        // move on: refusing to resume because of one bad line would be worse.
        index.malformedLines++;
        continue;
      }
      index.records++;
      const key = attemptKey(rec);
      const outcomes = index.keys.get(key);
      if (outcomes) outcomes.push(rec.outcome);
      else index.keys.set(key, [rec.outcome]);
    }
  }
  return index;
}

/** Is this attempt already done, given the resume policy? */
export function isDone(
  index: ResumeIndex,
  key: string,
  retryHarnessErrors: boolean,
): { done: boolean; outcomes: string[] } {
  const outcomes = index.keys.get(key);
  if (!outcomes) return { done: false, outcomes: [] };
  if (!retryHarnessErrors) return { done: true, outcomes };
  // Retrying: only a non-harness outcome counts as done.
  return { done: outcomes.some((o) => o !== "harness_error"), outcomes };
}
