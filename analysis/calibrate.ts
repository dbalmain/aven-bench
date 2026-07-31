/**
 * Phase 2 calibration report — §5 of `PLAN-aven-bench.md`.
 *
 * Phase 2 exists to "establish the denominator and pick the instruments": before
 * Aven is measured at all, find out what these models score on a control language,
 * how long they take and how much they cost. An Aven pass rate means nothing
 * without a same-model, same-harness baseline.
 *
 * This is a bun script rather than the DuckDB queries in `queries.sql` because
 * duckdb was not installed when calibration needed to run, and calibration should
 * not wait on a dependency. It reads the same JSONL and keeps the repo's
 * zero-runtime-dependency rule. duckdb has since been installed, so the two
 * overlap: `queries.sql` owns the ranked worklists over the holdout split, and this
 * owns the Phase 2 model-selection report over the tune split.
 *
 *   bun run analysis/calibrate.ts [filter]
 *
 * `filter` is a substring matched against either the run log's file name or the
 * row's `runId`, because `--out` names a sweep while `runId` defaults to a
 * timestamp; matching only one of them makes selecting "that sweep" awkward.
 *
 * Run it **after** a sweep finishes. The coverage check compares each model
 * against the task set actually present in the log, so mid-sweep every model that
 * has not been reached yet reads as a partial arm. That is a true statement about
 * the data and a useless one about the model.
 *
 * The model band is the load-bearing output. §2 is blunt about why: "a model
 * failing 80% of Python tasks teaches nothing about Aven" — its failures are about
 * the model, and the Aven-minus-baseline delta they produce is noise. Equally, a
 * model at the ceiling cannot show a *gap*, because it has no room to fall. Only
 * the middle band can carry the signal, so the thresholds are stated here rather
 * than left to a reader's judgement.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RUNS_DIR = new URL("../data/runs", import.meta.url).pathname;

/**
 * Band edges, as eventual-green rate on the control arm.
 *
 * Below `WEAK_FLOOR` the model is failing so much of the control that Aven
 * failures cannot be attributed to Aven. At or above `CEILING` it has no headroom:
 * a language gap cannot show up as a drop that is already impossible.
 */
const WEAK_FLOOR = 0.5;
const CEILING = 0.9;

type Row = {
  schemaVersion: number;
  runId: string;
  language: string;
  taskId: string;
  modelId: string;
  outcome: string;
  firstShotPass: boolean;
  roundsToGreen: number | null;
  roundsUsed: number;
  casesPassed: number;
  casesTotal: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  wallMs: number;
  agentWallMs: number;
  shellCommands: number;
  outsideWorkdirTouches: number;
  timedOut: boolean;
  surveyed?: boolean;
  surveyResponse?: string | null;
  mypyOk?: boolean | null;
  /** Schema 5+. Absent on older rows, which is what `poisonedLegacy` is for. */
  harnessErrorKind?: string | null;
  cachedPromptTokens?: number;
  cachedWriteTokens?: number;
  reasoningTokens?: number;
  /** Schema 6+. Absent means the name-and-arity-only contract, i.e. `names-v0`. */
  contractGeneration?: string;
};

/**
 * Which generation of the generated task contract a row was produced under.
 *
 * Schema 6 began stating observed argument and return shapes in the round-0
 * prompt, which measurably changes what a model is being asked to do — the whole
 * point of the change was that models were burning rounds guessing return types.
 * Rows either side of it are answers to different questions, so pooling them
 * would silently average two experiments. Absent means the older contract.
 */
function contractGeneration(r: Row): string {
  return r.contractGeneration ?? "names-v0";
}

/**
 * A row where the harness billed nothing at all: the provider never answered, so
 * the attempt says nothing about the model.
 *
 * Schema 5 records these as `outcome: "harness_error"` with
 * `harnessErrorKind: "agent-no-tokens"`, and every rate below already excludes
 * harness errors. Older logs recorded them as `outcome: "timeout"` — a *model*
 * verdict — and are indistinguishable from a genuinely slow model by outcome
 * alone, so they have to be matched on the token columns instead.
 */
function measuredNothing(r: Row): boolean {
  return (
    r.promptTokens === 0 &&
    r.completionTokens === 0 &&
    (r.cachedPromptTokens ?? 0) === 0 &&
    (r.cachedWriteTokens ?? 0) === 0 &&
    (r.reasoningTokens ?? 0) === 0
  );
}

/** Pre-schema-5 rows still masquerading as a model timeout. */
function poisonedLegacy(r: Row): boolean {
  return r.outcome === "timeout" && measuredNothing(r);
}

function load(filter: string | null): Row[] {
  const rows: Row[] = [];
  for (const f of readdirSync(RUNS_DIR).filter((f) => f.endsWith(".jsonl")).sort()) {
    const fileMatches = filter === null || f.includes(filter);
    const text = readFileSync(join(RUNS_DIR, f), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let r: Row;
      try {
        r = JSON.parse(line) as Row;
      } catch {
        continue;
      }
      if (!fileMatches && !r.runId.includes(filter!)) continue;
      rows.push(r);
    }
  }
  return rows;
}

function pct(n: number, d: number): string {
  return d === 0 ? "   -" : `${((100 * n) / d).toFixed(0).padStart(3)}%`;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const prefix = process.argv[2] ?? null;
const all = load(prefix);
const rows = all.filter((r) => r.language === "python");

if (rows.length === 0) {
  console.log(`no python rows${prefix ? ` for run prefix '${prefix}'` : ""} in ${RUNS_DIR}`);
  process.exit(0);
}

const schemas = [...new Set(all.map((r) => r.schemaVersion))].sort();
console.log(`# Phase 2 calibration — control arm (python)\n`);
console.log(`rows      ${rows.length} python of ${all.length} total   schema version(s) ${schemas.join(", ")}`);
console.log(`runs      ${[...new Set(rows.map((r) => r.runId))].join(", ")}`);
console.log(`tasks     ${new Set(rows.map((r) => r.taskId)).size} distinct\n`);

// --- preconditions ---------------------------------------------------------
//
// Printed before anything else, because every rate below is conditioned on them
// and all of them look perfectly plausible when they are wrong. A model that
// attempted a third of the task set still gets a green rate, and that rate still
// lands in a band.

const allTasks = new Set(rows.map((r) => r.taskId));
const legacy = rows.filter(poisonedLegacy);
const warnings: string[] = [];

const generations = new Map<string, number>();
for (const r of rows) generations.set(contractGeneration(r), (generations.get(contractGeneration(r)) ?? 0) + 1);
if (generations.size > 1) {
  warnings.push(
    `rows span ${generations.size} contract generations ` +
      `(${[...generations].map(([g, n]) => `${g}: ${n}`).join(", ")}).\n` +
      `    The round-0 prompt differs between them, so these are answers to different\n` +
      `    questions and the rates below pool two experiments. Filter to one generation.`,
  );
}

if (legacy.length > 0) {
  const byRun = new Map<string, number>();
  for (const r of legacy) byRun.set(r.runId, (byRun.get(r.runId) ?? 0) + 1);
  warnings.push(
    `${legacy.length} zero-token row(s) recorded as 'timeout' by a pre-schema-5 runner ` +
      `(${[...byRun].map(([k, v]) => `${k}: ${v}`).join(", ")}).\n` +
      `    These are a dead provider, not a slow model, and they are counted as ` +
      `failures below.\n    Fix: bun run quarantine --apply`,
  );
}

for (const [modelId, rs] of new Map(
  [...new Set(rows.map((r) => r.modelId))].map((m) => [m, rows.filter((r) => r.modelId === m)]),
)) {
  const attempted = new Set(rs.map((r) => r.taskId)).size;
  if (attempted < allTasks.size * 0.9) {
    warnings.push(
      `${modelId} attempted ${attempted} of ${allTasks.size} tasks (${pct(attempted, allTasks.size).trim()}).\n` +
        `    Preflight or the circuit breaker probably dropped it. Its rates below are ` +
        `over a partial\n    task set and are not comparable with a complete arm.`,
    );
  }
}

if (warnings.length > 0) {
  console.log("## ⚠ Read before trusting anything below\n");
  for (const w of warnings) console.log(`  - ${w}\n`);
} else {
  console.log(
    `preconditions  ok — no partial arms, no legacy zero-token rows, ` +
      `contract ${[...generations.keys()].join("/")}\n`,
  );
}

// --- per-model profile -----------------------------------------------------

type Profile = {
  modelId: string;
  n: number;
  green: number;
  firstShot: number;
  scored: number;
  harnessErrors: number;
  timeouts: number;
  refusals: number;
  medianWallMs: number;
  meanRounds: number;
  tokens: number;
  costUsd: number;
  shellViolations: number;
  escapes: number;
  caseRate: number;
  /** Attempts where the provider returned nothing — an incomplete arm, not a weak model. */
  noTokens: number;
  /** Distinct tasks reached, against the run's full task set. */
  tasksAttempted: number;
};

const byModel = new Map<string, Row[]>();
for (const r of rows) {
  const list = byModel.get(r.modelId) ?? [];
  list.push(r);
  byModel.set(r.modelId, list);
}

const profiles: Profile[] = [];
for (const [modelId, rs] of byModel) {
  // A harness error is not a model failure (§3c), so it is excluded from the
  // denominator of a *capability* rate and reported separately.
  const harnessErrors = rs.filter((r) => r.outcome === "harness_error").length;
  const scored = rs.filter((r) => r.outcome !== "harness_error");
  const greenRows = scored.filter((r) => r.roundsToGreen !== null);
  const casesTotal = scored.reduce((n, r) => n + r.casesTotal, 0);
  const casesPassed = scored.reduce((n, r) => n + r.casesPassed, 0);
  profiles.push({
    modelId,
    n: rs.length,
    scored: scored.length,
    green: greenRows.length,
    firstShot: scored.filter((r) => r.firstShotPass).length,
    harnessErrors,
    timeouts: rs.filter((r) => r.outcome === "timeout").length,
    refusals: rs.filter((r) => r.outcome === "refusal").length,
    medianWallMs: median(scored.map((r) => r.wallMs)),
    meanRounds: greenRows.length ? greenRows.reduce((n, r) => n + (r.roundsToGreen ?? 0), 0) / greenRows.length : NaN,
    tokens: rs.reduce((n, r) => n + r.promptTokens + r.completionTokens, 0),
    costUsd: rs.reduce((n, r) => n + (r.costUsd ?? 0), 0),
    shellViolations: rs.filter((r) => r.shellCommands > 0).length,
    escapes: rs.filter((r) => r.outsideWorkdirTouches > 0).length,
    caseRate: casesTotal ? casesPassed / casesTotal : 0,
    // Counts both spellings: schema 5 labels these, older logs only reveal them
    // through the token columns.
    noTokens: rs.filter(
      (r) =>
        r.harnessErrorKind === "agent-no-tokens" ||
        r.harnessErrorKind === "agent-timeout" ||
        poisonedLegacy(r),
    ).length,
    tasksAttempted: new Set(rs.map((r) => r.taskId)).size,
  });
}
profiles.sort((a, b) => b.green / (b.scored || 1) - a.green / (a.scored || 1));

console.log("## Per-model profile\n");
console.log("model                             n  scored  green  1shot  cases  med-wall  rounds   tokens     cost");
console.log("-".repeat(103));
for (const p of profiles) {
  console.log(
    p.modelId.replace("opencode/", "").padEnd(30) +
      String(p.n).padStart(4) +
      String(p.scored).padStart(8) +
      pct(p.green, p.scored).padStart(7) +
      pct(p.firstShot, p.scored).padStart(7) +
      pct(Math.round(p.caseRate * 1000), 1000).padStart(7) +
      `${(p.medianWallMs / 1000).toFixed(0)}s`.padStart(10) +
      (Number.isNaN(p.meanRounds) ? "    -" : p.meanRounds.toFixed(2).padStart(8)) +
      String(p.tokens).padStart(9) +
      `$${p.costUsd.toFixed(4)}`.padStart(9),
  );
}

console.log("\n## Reliability (not model capability)\n");
console.log("model                          coverage  harness-err  no-tokens  timeout  refusal  shell>0  escaped");
console.log("-".repeat(100));
for (const p of profiles) {
  console.log(
    p.modelId.replace("opencode/", "").padEnd(30) +
      `${p.tasksAttempted}/${allTasks.size}`.padStart(8) +
      String(p.harnessErrors).padStart(13) +
      String(p.noTokens).padStart(11) +
      String(p.timeouts).padStart(9) +
      String(p.refusals).padStart(9) +
      String(p.shellViolations).padStart(9) +
      String(p.escapes).padStart(9),
  );
}
console.log(
  "\n  no-tokens counts attempts where the provider returned nothing. A nonzero value\n" +
    "  means that arm is short of attempts rather than that the model failed them, and\n" +
    "  a model whose coverage is below its peers needs re-running before its rate means\n" +
    "  anything. Both are recoverable — but only if noticed.",
);

// --- the band --------------------------------------------------------------

console.log(`\n## Weak-model band  (in-band: ${WEAK_FLOOR * 100}% <= green < ${CEILING * 100}%)\n`);
const classify = (p: Profile): string => {
  if (p.scored === 0) return "no data";
  const rate = p.green / p.scored;
  if (rate >= CEILING) return "at ceiling — cannot show a gap";
  if (rate < WEAK_FLOOR) return "too weak — failures are about the model";
  return "IN BAND";
};
for (const p of profiles) {
  console.log(`  ${p.modelId.replace("opencode/", "").padEnd(30)} ${pct(p.green, p.scored)}  ${classify(p)}`);
}
const inBand = profiles.filter((p) => classify(p) === "IN BAND");
console.log(`\n  ${inBand.length} of ${profiles.length} model(s) in band.`);

// --- task difficulty -------------------------------------------------------

console.log("\n## Tasks no model solved (candidate control-arm defects)\n");
const byTask = new Map<string, Row[]>();
for (const r of rows) {
  const list = byTask.get(r.taskId) ?? [];
  list.push(r);
  byTask.set(r.taskId, list);
}
const unsolved = [...byTask.entries()]
  .filter(([, rs]) => {
    const scored = rs.filter((r) => r.outcome !== "harness_error");
    return scored.length >= 2 && scored.every((r) => r.roundsToGreen === null);
  })
  .sort();
if (unsolved.length === 0) {
  console.log("  (none)");
} else {
  console.log("  A task every model fails on the *control* arm is usually a generated-suite");
  console.log("  problem, not a hard task. `accumulate` was exactly this.\n");
  for (const [task, rs] of unsolved) {
    const outcomes = [...new Set(rs.map((r) => r.outcome))].join(",");
    console.log(`  ${task.padEnd(30)} ${String(rs.length).padStart(2)} attempt(s)  ${outcomes}`);
  }
}

// --- survey baseline -------------------------------------------------------

const surveyed = rows.filter((r) => r.surveyed && r.surveyResponse);
if (surveyed.length > 0) {
  const nothing = surveyed.filter((r) => /^\s*nothing\b/i.test(r.surveyResponse!)).length;
  console.log(`\n## Survey baseline (control arm)\n`);
  console.log(`  ${surveyed.length} answered; ${nothing} (${((100 * nothing) / surveyed.length).toFixed(0)}%) opened with "nothing".`);
  console.log("  This is the complaint noise floor. An Aven complaint rate only means");
  console.log("  something measured against how often the same model complains about Python.");
}
