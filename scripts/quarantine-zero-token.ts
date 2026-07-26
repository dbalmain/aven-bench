/**
 * Move zero-token attempts out of the run logs.
 *
 * An attempt that billed nothing across every token category never reached the
 * model: the provider returned nothing. Since schema 5 the runner records these as
 * `harness_error` (see `agentMeasuredNothing` in `runner/attempt.ts`), but logs
 * written before that fix recorded them as `outcome: "timeout"` — a *model*
 * verdict. Left in place they read as a model failing tasks slowly, which corrupts
 * exactly the pass-rate deltas the benchmark exists to produce.
 *
 * Worse, they are sticky: resume treats any row as done, and
 * `--retry-harness-errors` only retries rows whose outcome is literally
 * `harness_error`, so a poisoned `timeout` row blocks its (task, language, model)
 * key forever. Moving it out is what lets the next sweep redo the attempt.
 *
 * Rows are moved, never deleted. They are the evidence for the defect and are
 * worth keeping as a fixture.
 *
 *   bun run scripts/quarantine-zero-token.ts             # dry run, prints what would move
 *   bun run scripts/quarantine-zero-token.ts --apply     # rewrite the logs
 *
 * Dry run is the default because this rewrites the dataset in place.
 */

import { readdirSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUNS = "data/runs";
const QUARANTINE = join(RUNS, "quarantine");

/**
 * A log touched this recently is assumed to be a sweep's open output.
 *
 * This script rewrites logs in place, and the runner appends to them, so doing both
 * at once loses rows. There is no lock to take — the log *is* the interface — so
 * recent mtime stands in for "in use". Skipping is always safe: the rows are still
 * poisoned afterwards and the next run of this script still finds them.
 */
const ACTIVE_LOG_MS = 5 * 60 * 1000;

type Row = Record<string, unknown>;

/**
 * Did this attempt measure nothing at all?
 *
 * Deliberately the same narrow reading as the runner's `agentMeasuredNothing`:
 * every token category must be zero. A refusal bills tokens for the prose it
 * refuses in, and a refusal is a real measured outcome — sweeping refusals in here
 * would inflate every pass rate by shrinking the denominator.
 *
 * `reasonAbsent` counts too: a row from before the field existed reads as
 * undefined, which `n()` maps to 0, and that is the correct reading for a log
 * whose harness never reported the category.
 */
function measuredNothing(r: Row): boolean {
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
  return (
    n("promptTokens") === 0 &&
    n("completionTokens") === 0 &&
    n("cachedPromptTokens") === 0 &&
    n("cachedWriteTokens") === 0 &&
    n("reasoningTokens") === 0
  );
}

/** A row worth moving: measured nothing, and is not already labelled as such. */
function isPoisoned(r: Row): boolean {
  if (!measuredNothing(r)) return false;
  // Schema-5 rows already say `harness_error`, so analysis excludes them and
  // `--retry-harness-errors` already redoes them. Nothing to fix.
  return r["outcome"] !== "harness_error";
}

const apply = process.argv.includes("--apply");
const logs = readdirSync(RUNS).filter((f) => f.endsWith(".jsonl"));

let movedTotal = 0;
for (const file of logs.sort()) {
  const path = join(RUNS, file);
  const text = readFileSync(path, "utf8").trim();
  if (text === "") continue;
  const rows = text.split("\n").map((l) => JSON.parse(l) as Row);
  const bad = rows.filter(isPoisoned);
  if (bad.length === 0) continue;

  movedTotal += bad.length;
  const tasks = bad.map((r) => `${r["taskId"]}/${r["language"]}`).join(" ");
  console.log(`${file}: ${bad.length} of ${rows.length} poisoned`);
  console.log(`  ${tasks}`);

  if (!apply) continue;

  const ageMs = Date.now() - statSync(path).mtimeMs;
  if (ageMs < ACTIVE_LOG_MS) {
    console.log(
      `  -> SKIPPED: written ${Math.round(ageMs / 1000)}s ago, so a sweep is probably ` +
        `appending to it. Re-run once it finishes.`,
    );
    continue;
  }

  mkdirSync(QUARANTINE, { recursive: true });
  const keep = rows.filter((r) => !isPoisoned(r));
  const dest = join(QUARANTINE, file.replace(/\.jsonl$/, ".zero-token.jsonl"));
  // Append: a later sweep can poison the same log again, and an earlier
  // quarantine is still evidence.
  const existing = (() => {
    try {
      return readFileSync(dest, "utf8").trim();
    } catch {
      return "";
    }
  })();
  const merged = [existing, ...bad.map((r) => JSON.stringify(r))].filter((s) => s !== "");
  writeFileSync(dest, `${merged.join("\n")}\n`);
  writeFileSync(path, keep.length > 0 ? `${keep.map((r) => JSON.stringify(r)).join("\n")}\n` : "");
  console.log(`  -> moved to ${dest}`);
}

if (movedTotal === 0) {
  console.log("no zero-token rows found; logs are clean");
} else if (!apply) {
  console.log(`\n${movedTotal} row(s) would move. Re-run with --apply.`);
} else {
  console.log(`\nmoved ${movedTotal} row(s). Those attempts will be re-run by the next sweep.`);
}
