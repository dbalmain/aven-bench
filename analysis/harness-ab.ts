/**
 * Harness A/B — `analysis/prereg-harness-01.md`.
 *
 * Written before the arms finished, deliberately: an analysis written after
 * seeing results is an analysis shaped by them.
 *
 * The difference from `model-ab.ts` that justifies a separate file: there,
 * arm A is a fixed reused DeepSeek run baked into the module. Here **both arms
 * are fresh**, neither is DeepSeek, and the two arms carry *different*
 * `modelId` strings for the same model — codex names it `gpt-5.6-luna`,
 * opencode requires the `opencode-go/` prefix. Each arm is therefore selected
 * by its own (run-id, modelId) pair and the two are never matched on model.
 *
 * The statistical core, the per-task aggregation and the pre-registered verdict
 * rule are imported rather than reimplemented, so the two rounds cannot drift
 * apart in how they decide anything.
 *
 * **No cost DV.** codex bills against a subscription and reports no cost at
 * all; its rows carry `costUsd: null`. Tokens carry the efficiency signal
 * instead, as `tokens per green solution`, and are descriptive only.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MIN_SAMPLES,
  dedupeRows,
  excludeRows,
  parseJsonl,
  twoProportionZTest,
  wilcoxonSignedRank,
  type ExclusionCounts,
  type WilcoxonResult,
} from "./diagfmt-ab.ts";
import {
  GREEN_EFFECT_BAR,
  ROUNDS_EFFECT_BAR,
  aggregateByTask,
  pairTasks,
  verdictFor,
  type Verdict,
} from "./model-ab.ts";

const RUNS_DIR = new URL("../data/runs", import.meta.url).pathname;

export const DEFAULT_ARM_A = { run: "phase6-harness-codex-01", model: "gpt-5.6-luna" };
export const DEFAULT_ARM_B = { run: "phase6-harness-opencode-01", model: "opencode-go/gpt-5.6-luna" };

/** Token totals and wall time for one arm. Descriptive; never inferential. */
export type ArmEffort = {
  rows: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  wallHours: number;
  /** Null on a subscription-billed harness that reports no cost. Never 0. */
  costUsd: number | null;
};

/**
 * Read token/wall totals straight from the raw rows.
 *
 * `costUsd` stays null unless at least one row reported a real charge. A
 * subscription harness reports nothing, and summing that to `0` would claim the
 * arm was free — the bug that made the free tier's rows useless.
 */
export function armEffort(rawLines: readonly string[], modelId: string): ArmEffort {
  const out: ArmEffort = {
    rows: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    wallHours: 0,
    costUsd: null,
  };
  let wallMs = 0;
  for (const line of rawLines) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    if (r["modelId"] !== modelId) continue;
    out.rows += 1;
    const p = typeof r["promptTokens"] === "number" ? r["promptTokens"] : 0;
    const c = typeof r["completionTokens"] === "number" ? r["completionTokens"] : 0;
    const re = typeof r["reasoningTokens"] === "number" ? r["reasoningTokens"] : 0;
    out.promptTokens += p;
    out.completionTokens += c;
    out.reasoningTokens += re;
    out.totalTokens += p + c + re;
    if (typeof r["wallMs"] === "number") wallMs += r["wallMs"];
    if (typeof r["costUsd"] === "number") out.costUsd = (out.costUsd ?? 0) + r["costUsd"];
  }
  out.wallHours = wallMs / 3_600_000;
  return out;
}

export type HarnessAbReport = {
  armA: { run: string; model: string; harness: string | null };
  armB: { run: string; model: string; harness: string | null };
  /** Recorded so a mismatch is visible in the report, not buried in the rows. */
  variants: { a: string | null; b: string | null };
  minSamples: number;
  nPaired: number;
  droppedTasks: string[];
  exclusions: { a: ExclusionCounts; b: ExclusionCounts };
  effort: { a: ArmEffort; b: ArmEffort };
  greens: { a: number; b: number };
  greenRate: { a: number; b: number; diff: number; test: WilcoxonResult; verdict: Verdict };
  censoredRounds: { a: number; b: number; diff: number; test: WilcoxonResult; verdict: Verdict };
  firstShot: { a: number; b: number; test: ReturnType<typeof twoProportionZTest> };
};

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** First non-null value of `field` across an arm's raw rows. */
function firstField(rawLines: readonly string[], modelId: string, field: string): string | null {
  for (const line of rawLines) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    if (r["modelId"] !== modelId) continue;
    const v = r[field];
    if (typeof v === "string") return v;
  }
  return null;
}

export function analyzeHarnessAb(
  armAText: string,
  armBText: string,
  armA: { run: string; model: string },
  armB: { run: string; model: string },
  minSamples: number = MIN_SAMPLES,
): HarnessAbReport {
  const aLines = armAText.split("\n");
  const bLines = armBText.split("\n");

  const aRaw = parseJsonl(armAText).filter((r) => r.modelId === armA.model && r.language === "aven");
  const bRaw = parseJsonl(armBText).filter((r) => r.modelId === armB.model && r.language === "aven");

  const a = excludeRows(dedupeRows(aRaw));
  const b = excludeRows(dedupeRows(bRaw));

  const aByTask = aggregateByTask(a.usable);
  const bByTask = aggregateByTask(b.usable);
  const { paired, dropped } = pairTasks(aByTask, bByTask, minSamples);

  const greenTest = wilcoxonSignedRank(paired.map((p) => p.b.greenRate - p.a.greenRate));
  const roundsTest = wilcoxonSignedRank(paired.map((p) => p.b.meanRounds - p.a.meanRounds));

  const aFirst = paired.reduce((acc, p) => acc + p.a.firstShot, 0);
  const aFirstN = paired.reduce((acc, p) => acc + p.a.nSamples, 0);
  const bFirst = paired.reduce((acc, p) => acc + p.b.firstShot, 0);
  const bFirstN = paired.reduce((acc, p) => acc + p.b.nSamples, 0);

  const greenA = mean(paired.map((p) => p.a.greenRate));
  const greenB = mean(paired.map((p) => p.b.greenRate));
  const roundsA = mean(paired.map((p) => p.a.meanRounds));
  const roundsB = mean(paired.map((p) => p.b.meanRounds));

  return {
    armA: { ...armA, harness: firstField(aLines, armA.model, "agentHarness") },
    armB: { ...armB, harness: firstField(bLines, armB.model, "agentHarness") },
    variants: {
      a: firstField(aLines, armA.model, "agentVariant"),
      b: firstField(bLines, armB.model, "agentVariant"),
    },
    minSamples,
    nPaired: paired.length,
    droppedTasks: dropped,
    exclusions: { a: a.excluded, b: b.excluded },
    effort: { a: armEffort(aLines, armA.model), b: armEffort(bLines, armB.model) },
    greens: {
      a: a.usable.filter((r) => r.outcome === "pass").length,
      b: b.usable.filter((r) => r.outcome === "pass").length,
    },
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
      a: aFirstN === 0 ? 0 : aFirst / aFirstN,
      b: bFirstN === 0 ? 0 : bFirst / bFirstN,
      test: twoProportionZTest(aFirst, aFirstN, bFirst, bFirstN),
    },
  };
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const num = (x: number, d: number): string => (Number.isNaN(x) ? "n/a" : x.toFixed(d));
const money = (x: number | null): string => (x === null ? "n/a (subscription)" : `$${x.toFixed(2)}`);

export function formatHarnessReport(r: HarnessAbReport): string {
  const lines: string[] = [];
  lines.push(`# Harness A/B — ${r.armB.harness ?? r.armB.run} vs ${r.armA.harness ?? r.armA.run}`);
  lines.push("");
  lines.push("Pre-registration: analysis/prereg-harness-01.md");
  lines.push(`Arm A: ${r.armA.run} (${r.armA.model})`);
  lines.push(`Arm B: ${r.armB.run} (${r.armB.model})`);
  lines.push(`Paired tasks: ${r.nPaired}`);
  if (r.droppedTasks.length > 0) {
    lines.push(`Dropped (<${r.minSamples} usable samples in an arm): ${r.droppedTasks.join(", ")}`);
  }

  // The whole design rests on the arms being matched here, so it is checked
  // from the rows rather than asserted by the pre-registration.
  lines.push(`Reasoning effort: arm A ${r.variants.a ?? "default"}, arm B ${r.variants.b ?? "default"}`);
  if (r.variants.a !== r.variants.b) {
    lines.push("  !! EFFORT MISMATCH — the arms are not comparable; see prereg 'How effort is pinned'");
  }

  lines.push("");
  lines.push("## Primary — green rate");
  lines.push(`  arm A ${pct(r.greenRate.a)}   arm B ${pct(r.greenRate.b)}   diff ${pct(r.greenRate.diff)}`);
  lines.push(`  ${r.greenRate.test.method}`);
  lines.push(
    `  n=${r.greenRate.test.n} (ties dropped ${r.greenRate.test.nDroppedZero})  z=${num(r.greenRate.test.z, 3)}  p=${num(r.greenRate.test.pValue, 4)}`,
  );
  lines.push(`  effect bar ${pct(GREEN_EFFECT_BAR)} -> ${r.greenRate.verdict}`);

  lines.push("");
  lines.push("## Secondary — censored repair rounds (lower is better)");
  lines.push(`  arm A ${num(r.censoredRounds.a, 3)}   arm B ${num(r.censoredRounds.b, 3)}   diff ${num(r.censoredRounds.diff, 3)}`);
  lines.push(
    `  n=${r.censoredRounds.test.n} (ties dropped ${r.censoredRounds.test.nDroppedZero})  z=${num(r.censoredRounds.test.z, 3)}  p=${num(r.censoredRounds.test.pValue, 4)}`,
  );
  lines.push(`  effect bar ${ROUNDS_EFFECT_BAR} rounds -> ${r.censoredRounds.verdict}`);

  lines.push("");
  lines.push("## first-shot pass (descriptive)");
  lines.push(`  arm A ${pct(r.firstShot.a)}   arm B ${pct(r.firstShot.b)}   p=${num(r.firstShot.test.pValue, 4)}`);

  lines.push("");
  lines.push("## Exclusions");
  lines.push(`  arm A: harness_error ${r.exclusions.a.harnessError}, contaminated ${r.exclusions.a.contaminated}`);
  lines.push(`  arm B: harness_error ${r.exclusions.b.harnessError}, contaminated ${r.exclusions.b.contaminated}`);

  lines.push("");
  lines.push("## Effort (descriptive — no cost DV in this round)");
  for (const [label, e, greens] of [
    ["arm A", r.effort.a, r.greens.a],
    ["arm B", r.effort.b, r.greens.b],
  ] as const) {
    const perGreen = greens === 0 ? "n/a" : Math.round(e.totalTokens / greens).toLocaleString();
    lines.push(
      `  ${label}: ${e.rows} rows, ${e.totalTokens.toLocaleString()} tokens, ${perGreen} tokens/green, ${e.wallHours.toFixed(1)}h, cost ${money(e.costUsd)}`,
    );
  }

  lines.push("");
  lines.push("Both arms were run CONCURRENTLY: provider load and time-of-day fall on");
  lines.push("both alike. This is the campaign's first comparison without that confound.");
  return lines.join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string, dflt: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 || !argv[i + 1] ? dflt : (argv[i + 1] as string);
  };

  const armA = { run: flag("arm-a", DEFAULT_ARM_A.run), model: flag("arm-a-model", DEFAULT_ARM_A.model) };
  const armB = { run: flag("arm-b", DEFAULT_ARM_B.run), model: flag("arm-b-model", DEFAULT_ARM_B.model) };

  const paths = [join(RUNS_DIR, `${armA.run}.jsonl`), join(RUNS_DIR, `${armB.run}.jsonl`)];
  for (const p of paths) {
    if (!existsSync(p)) {
      console.error(`missing run log: ${p}`);
      process.exit(2);
    }
  }

  const report = analyzeHarnessAb(
    readFileSync(paths[0] as string, "utf8"),
    readFileSync(paths[1] as string, "utf8"),
    armA,
    armB,
  );

  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatHarnessReport(report));
}

if (import.meta.main) main();
