/**
 * Pre-registered A/B analysis for the model axis (`model-01`).
 *
 * Spec: `analysis/prereg-model-01.md`. Written before any arm-B row was
 * analysed so the code cannot be tuned to the result.
 *
 * Arm A is always `phase4-diagfmt-text-01` restricted to
 * `opencode-go/deepseek-v4-flash`. Arm B is named on the command line, so the
 * later hy3 / qwen3.7-plus rounds reuse this script against the same arm A
 * rather than growing a second copy of it.
 *
 *   bun run analysis/model-ab.ts --arm-b phase5-model-mimo-01 [--json]
 *
 * The statistics are imported from `diagfmt-ab.ts`, which has its own tests
 * (`diagfmt-ab.test.ts`, including a hand-worked tied-|d| Wilcoxon case).
 * Do not reimplement them here.
 *
 * Forbidden by the pre-registration, same as diagfmt-01: any filter on "tasks
 * that failed at least once" or "needed a repair round". Those condition on a
 * post-exposure result. Unlike diagfmt-01 there is no legitimate round-0
 * stratification available either, because the model differs from round 0 —
 * round 0 is not pre-exposure in this design.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ALPHA,
  MIN_SAMPLES,
  censoredDv,
  dedupeRows,
  excludeRows,
  parseJsonl,
  twoProportionZTest,
  wilcoxonSignedRank,
  type AbRow,
  type ExclusionCounts,
  type WilcoxonResult,
} from "./diagfmt-ab.ts";

const RUNS_DIR = new URL("../data/runs", import.meta.url).pathname;

/** Arm A is fixed for the whole model axis. */
export const ARM_A_FILE = "phase4-diagfmt-text-01.jsonl";
export const ARM_A_MODEL = "opencode-go/deepseek-v4-flash";

/**
 * Smallest green-rate difference worth acting on, in proportion units.
 * Pre-registered at 10 percentage points.
 */
export const GREEN_EFFECT_BAR = 0.1;

/**
 * Secondary DV bar, carried over from diagfmt-01 so the two rounds are
 * commensurable.
 */
export const ROUNDS_EFFECT_BAR = 0.3;

// ---------------------------------------------------------------------------
// Per-task aggregation
// ---------------------------------------------------------------------------

/** Green rate and mean censored rounds for one task in one arm. */
export type TaskArm = {
  nSamples: number;
  greenRate: number;
  meanRounds: number;
  firstShot: number;
};

/**
 * Aggregate an arm's usable rows by task.
 *
 * `greenRate` is the fraction of samples whose outcome is `pass` — the
 * pre-registered primary DV. `meanRounds` is the censored-rounds secondary.
 */
export function aggregateByTask(rows: readonly AbRow[]): Map<string, TaskArm> {
  const byTask = new Map<string, AbRow[]>();
  for (const r of rows) {
    const list = byTask.get(r.taskId);
    if (list) list.push(r);
    else byTask.set(r.taskId, [r]);
  }
  const out = new Map<string, TaskArm>();
  for (const [taskId, list] of byTask) {
    const green = list.filter((r) => r.outcome === "pass").length;
    const firstShot = list.filter((r) => r.firstShotPass).length;
    const rounds = list.reduce((acc, r) => acc + censoredDv(r), 0);
    out.set(taskId, {
      nSamples: list.length,
      greenRate: green / list.length,
      meanRounds: rounds / list.length,
      firstShot,
    });
  }
  return out;
}

export type TaskPairing = {
  taskId: string;
  a: TaskArm;
  b: TaskArm;
};

/**
 * Tasks usable in the paired analysis, plus the ones dropped and why.
 *
 * A task needs `minSamples` usable samples in *both* arms; the
 * pre-registration requires the dropped ones be named in the report.
 *
 * `minSamples` defaults to `MIN_SAMPLES` (2), which is what every arm run at
 * 2 or 3 samples uses. It is a parameter only because `prereg-model-03`
 * deliberately runs a 1-sample arm, where a threshold of 2 would drop every
 * task. Lowering it is a pre-registered design choice, never a response to
 * seeing tasks get dropped.
 */
export function pairTasks(
  a: Map<string, TaskArm>,
  b: Map<string, TaskArm>,
  minSamples: number = MIN_SAMPLES,
): { paired: TaskPairing[]; dropped: string[] } {
  const paired: TaskPairing[] = [];
  const dropped: string[] = [];
  for (const taskId of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const ta = a.get(taskId);
    const tb = b.get(taskId);
    if (!ta || !tb || ta.nSamples < minSamples || tb.nSamples < minSamples) {
      dropped.push(taskId);
      continue;
    }
    paired.push({ taskId, a: ta, b: tb });
  }
  return { paired, dropped };
}

// ---------------------------------------------------------------------------
// Cost / wall descriptives, read straight from the raw rows
// ---------------------------------------------------------------------------

export type ArmSpend = {
  costUsd: number;
  wallHours: number;
  rows: number;
};

/** Actual spend for an arm. Descriptive only — never an inferential quantity. */
export function armSpend(rawLines: readonly string[], modelId: string): ArmSpend {
  let costUsd = 0;
  let wallMs = 0;
  let rows = 0;
  for (const line of rawLines) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    if (r["modelId"] !== modelId) continue;
    rows += 1;
    costUsd += typeof r["costUsd"] === "number" ? r["costUsd"] : 0;
    wallMs += typeof r["wallMs"] === "number" ? r["wallMs"] : 0;
  }
  return { costUsd, wallHours: wallMs / 3_600_000, rows };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type Verdict = "arm-b-better" | "arm-a-better" | "no-difference" | "below-effect-bar";

export type ModelAbReport = {
  armAModel: string;
  armBModel: string;
  armBFile: string;
  /** Usable-sample threshold this report was built with. Recorded so a
   *  1-sample arm's report cannot be mistaken for a 2-sample one. */
  minSamples: number;
  nPaired: number;
  droppedTasks: string[];
  exclusions: { a: ExclusionCounts; b: ExclusionCounts };
  spend: { a: ArmSpend; b: ArmSpend };
  greenRate: {
    a: number;
    b: number;
    diff: number;
    test: WilcoxonResult;
    verdict: Verdict;
  };
  censoredRounds: {
    a: number;
    b: number;
    diff: number;
    test: WilcoxonResult;
    verdict: Verdict;
  };
  firstShot: {
    a: number;
    b: number;
    test: ReturnType<typeof twoProportionZTest>;
  };
};

/**
 * `wilcoxonSignedRank` reports `pValue: NaN` when every pair ties, i.e. when
 * there is no evidence at all. `NaN >= ALPHA` is false, so that case must be
 * caught before the significance test or identical arms get read as a
 * below-the-bar *difference* rather than as no difference.
 */
export function verdictFor(
  diff: number,
  p: number,
  bar: number,
  higherIsBetter: boolean,
): Verdict {
  if (Number.isNaN(p)) return "no-difference";
  if (p >= ALPHA) return "no-difference";
  if (Math.abs(diff) < bar) return "below-effect-bar";
  const bWins = higherIsBetter ? diff > 0 : diff < 0;
  return bWins ? "arm-b-better" : "arm-a-better";
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function analyzeModelAb(
  armAText: string,
  armBText: string,
  armBModel: string,
  armBFile: string,
  minSamples: number = MIN_SAMPLES,
): ModelAbReport {
  const aLines = armAText.split("\n");
  const bLines = armBText.split("\n");

  const aRowsAll = parseJsonl(armAText).filter(
    (r) => r.modelId === ARM_A_MODEL && r.language === "aven" && r.diagnosticFormat === "text",
  );
  const bRowsAll = parseJsonl(armBText).filter(
    (r) => r.modelId === armBModel && r.language === "aven",
  );

  const a = excludeRows(dedupeRows(aRowsAll));
  const b = excludeRows(dedupeRows(bRowsAll));

  const aByTask = aggregateByTask(a.usable);
  const bByTask = aggregateByTask(b.usable);
  const { paired, dropped } = pairTasks(aByTask, bByTask, minSamples);

  const greenDiffs = paired.map((p) => p.b.greenRate - p.a.greenRate);
  const roundsDiffs = paired.map((p) => p.b.meanRounds - p.a.meanRounds);
  const greenTest = wilcoxonSignedRank(greenDiffs);
  const roundsTest = wilcoxonSignedRank(roundsDiffs);

  const aFirstShot = paired.reduce((acc, p) => acc + p.a.firstShot, 0);
  const aFirstShotN = paired.reduce((acc, p) => acc + p.a.nSamples, 0);
  const bFirstShot = paired.reduce((acc, p) => acc + p.b.firstShot, 0);
  const bFirstShotN = paired.reduce((acc, p) => acc + p.b.nSamples, 0);

  const greenA = mean(paired.map((p) => p.a.greenRate));
  const greenB = mean(paired.map((p) => p.b.greenRate));
  const roundsA = mean(paired.map((p) => p.a.meanRounds));
  const roundsB = mean(paired.map((p) => p.b.meanRounds));

  return {
    armAModel: ARM_A_MODEL,
    armBModel,
    armBFile,
    minSamples,
    nPaired: paired.length,
    droppedTasks: dropped,
    exclusions: { a: a.excluded, b: b.excluded },
    spend: { a: armSpend(aLines, ARM_A_MODEL), b: armSpend(bLines, armBModel) },
    greenRate: {
      a: greenA,
      b: greenB,
      diff: greenB - greenA,
      test: greenTest,
      verdict: verdictFor(greenB - greenA, greenTest.pValue, GREEN_EFFECT_BAR, true),
    },
    censoredRounds: {
      a: roundsA,
      b: roundsB,
      diff: roundsB - roundsA,
      test: roundsTest,
      verdict: verdictFor(roundsB - roundsA, roundsTest.pValue, ROUNDS_EFFECT_BAR, false),
    },
    firstShot: {
      a: aFirstShotN === 0 ? 0 : aFirstShot / aFirstShotN,
      b: bFirstShotN === 0 ? 0 : bFirstShot / bFirstShotN,
      test: twoProportionZTest(aFirstShot, aFirstShotN, bFirstShot, bFirstShotN),
    },
  };
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

/** NaN means "not computable" (all pairs tied), not a number worth printing. */
const num = (x: number, digits: number): string => (Number.isNaN(x) ? "n/a" : x.toFixed(digits));

export function formatModelReport(r: ModelAbReport): string {
  const lines: string[] = [];
  lines.push(`# Model A/B — ${r.armBModel} vs ${r.armAModel}`);
  lines.push("");
  lines.push(`Pre-registration: analysis/prereg-model-01.md`);
  lines.push(`Arm A: ${ARM_A_FILE} (reused)   Arm B: ${r.armBFile}.jsonl`);
  lines.push(`Paired tasks: ${r.nPaired}`);
  if (r.droppedTasks.length > 0) {
    lines.push(`Dropped (<${r.minSamples} usable samples in an arm): ${r.droppedTasks.join(", ")}`);
  }
  lines.push("");
  lines.push("## Primary — green rate");
  lines.push(`  arm A ${pct(r.greenRate.a)}   arm B ${pct(r.greenRate.b)}   diff ${pct(r.greenRate.diff)}`);
  lines.push(`  ${r.greenRate.test.method}`);
  lines.push(`  n=${r.greenRate.test.n} (ties dropped ${r.greenRate.test.nDroppedZero})  z=${num(r.greenRate.test.z, 3)}  p=${num(r.greenRate.test.pValue, 4)}`);
  lines.push(`  effect bar ${pct(GREEN_EFFECT_BAR)} -> ${r.greenRate.verdict}`);
  lines.push("");
  lines.push("## Secondary — censored repair rounds (lower is better)");
  lines.push(`  arm A ${r.censoredRounds.a.toFixed(3)}   arm B ${r.censoredRounds.b.toFixed(3)}   diff ${r.censoredRounds.diff.toFixed(3)}`);
  lines.push(`  n=${r.censoredRounds.test.n} (ties dropped ${r.censoredRounds.test.nDroppedZero})  z=${num(r.censoredRounds.test.z, 3)}  p=${num(r.censoredRounds.test.pValue, 4)}`);
  lines.push(`  effect bar ${ROUNDS_EFFECT_BAR} rounds -> ${r.censoredRounds.verdict}`);
  lines.push("");
  lines.push("## first-shot pass (descriptive — NOT a negative control in this design)");
  lines.push(`  arm A ${pct(r.firstShot.a)}   arm B ${pct(r.firstShot.b)}   p=${num(r.firstShot.test.pValue, 4)}`);
  lines.push("  The model differs from round 0, so a difference here is a real effect, not a leak.");
  lines.push("");
  lines.push("## Exclusions");
  lines.push(`  arm A: harness_error ${r.exclusions.a.harnessError}, contaminated ${r.exclusions.a.contaminated}`);
  lines.push(`  arm B: harness_error ${r.exclusions.b.harnessError}, contaminated ${r.exclusions.b.contaminated}`);
  lines.push("");
  lines.push("## Spend (descriptive)");
  lines.push(`  arm A $${r.spend.a.costUsd.toFixed(2)} over ${r.spend.a.rows} rows, ${r.spend.a.wallHours.toFixed(1)}h agent time`);
  lines.push(`  arm B $${r.spend.b.costUsd.toFixed(2)} over ${r.spend.b.rows} rows, ${r.spend.b.wallHours.toFixed(1)}h agent time`);
  lines.push("");
  lines.push("Arms were NOT run concurrently (see prereg, Threats to validity #1):");
  lines.push("provider load and time-of-day are confounded with the arm.");
  return lines.join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const armBIdx = argv.indexOf("--arm-b");
  if (armBIdx === -1 || !argv[armBIdx + 1]) {
    console.error(
      "usage: bun run analysis/model-ab.ts --arm-b <run-id> [--model <id>] [--min-samples <n>] [--json]",
    );
    process.exit(2);
  }
  const armBFile = argv[armBIdx + 1] as string;
  const modelIdx = argv.indexOf("--model");
  const armBModel = modelIdx === -1 ? "opencode-go/mimo-v2.5" : (argv[modelIdx + 1] as string);

  // Only `prereg-model-03` (the 1-sample Qwen arm) passes this. Every other
  // round uses the default of 2.
  const minIdx = argv.indexOf("--min-samples");
  const minSamples = minIdx === -1 ? MIN_SAMPLES : Number(argv[minIdx + 1]);
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    console.error(`--min-samples must be a positive integer, got ${argv[minIdx + 1]}`);
    process.exit(2);
  }

  const aPath = join(RUNS_DIR, ARM_A_FILE);
  const bPath = join(RUNS_DIR, `${armBFile}.jsonl`);
  for (const p of [aPath, bPath]) {
    if (!existsSync(p)) {
      console.error(`missing run log: ${p}`);
      process.exit(2);
    }
  }

  const report = analyzeModelAb(
    readFileSync(aPath, "utf8"),
    readFileSync(bPath, "utf8"),
    armBModel,
    armBFile,
    minSamples,
  );

  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatModelReport(report));
}

if (import.meta.main) main();
