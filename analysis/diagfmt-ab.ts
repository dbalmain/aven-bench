/**
 * Pre-registered A/B analysis for diagnostic format (`diagfmt-01`).
 *
 * Spec: `analysis/prereg-diagfmt-01.md`. Written before the sweep finishes so
 * the code cannot be tuned to the result. Do not add a filter on "tasks that
 * failed at least once" or "needed a repair round" — that collider is forbidden
 * by the pre-registration.
 *
 *   bun run analysis/diagfmt-ab.ts [--json]
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RUNS_DIR = new URL("../data/runs", import.meta.url).pathname;
const TEXT_FILE = "phase4-diagfmt-text-01.jsonl";
const AGENT_FILE = "phase4-diagfmt-agent-01.jsonl";

/** Smallest mean-DV difference (rounds) worth shipping. Pre-registered. */
export const EFFECT_BAR = 0.3;
/** Two-sided α for the primary and negative-control tests. */
export const ALPHA = 0.05;
/** Paired analysis needs at least this many usable samples per arm. */
export const MIN_SAMPLES = 2;

// ---------------------------------------------------------------------------
// Row slice — only what the pre-registration needs
// ---------------------------------------------------------------------------

export type ProbeSlice = {
  name: string;
  ok: boolean | null;
};

export type RoundSlice = {
  round: number;
  probes: ProbeSlice[];
};

/** Fields the A/B reads from an attempt record. */
export type AbRow = {
  taskId: string;
  language: string;
  modelId: string;
  sampleIndex: number;
  diagnosticFormat: string;
  finishedAt: string;
  outcome: string;
  contaminated: boolean;
  roundsToGreen: number | null;
  maxRounds: number;
  firstShotPass: boolean;
  repairRounds: RoundSlice[];
};

export type Arm = "text" | "agent";

// ---------------------------------------------------------------------------
// DV, JSONL, dedup, exclusions
// ---------------------------------------------------------------------------

/**
 * Censored repair rounds (pre-registration DV).
 *
 * Green attempts use `roundsToGreen`; never-green uses the row's own
 * `maxRounds + 1` so a later sweep at a different `--rounds` stays correct.
 */
export function censoredDv(row: Pick<AbRow, "roundsToGreen" | "maxRounds">): number {
  if (row.roundsToGreen != null) return row.roundsToGreen;
  return row.maxRounds + 1;
}

/** True when round-0 `check` probe failed (`ok !== true`). Pre-treatment stratum. */
export function round0CheckFailed(row: Pick<AbRow, "repairRounds">): boolean {
  const rounds = row.repairRounds;
  if (rounds.length === 0) return false;
  const r0 = rounds.find((r) => r.round === 0) ?? rounds[0]!;
  const check = r0.probes.find((p) => p.name === "check");
  if (check == null) return false;
  return check.ok !== true;
}

/**
 * Parse JSONL, skipping blank lines and any line that is not valid JSON.
 *
 * Append-only writers can leave a truncated final line mid-write; that line is
 * skipped rather than throwing so a live sweep remains readable.
 */
export function parseJsonl(text: string): AbRow[] {
  const rows: AbRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const row = rowFromUnknown(raw);
    if (row != null) rows.push(row);
  }
  return rows;
}

export function rowFromUnknown(raw: unknown): AbRow | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["taskId"] !== "string") return null;
  if (typeof o["language"] !== "string") return null;
  if (typeof o["modelId"] !== "string") return null;
  if (typeof o["finishedAt"] !== "string") return null;
  if (typeof o["outcome"] !== "string") return null;
  if (typeof o["maxRounds"] !== "number") return null;
  const sampleIndex = typeof o["sampleIndex"] === "number" ? o["sampleIndex"] : 0;
  const diagnosticFormat =
    typeof o["diagnosticFormat"] === "string" ? o["diagnosticFormat"] : "text";
  const roundsToGreen =
    typeof o["roundsToGreen"] === "number" ? o["roundsToGreen"] : null;
  const repairRounds = parseRepairRounds(o["repairRounds"]);
  return {
    taskId: o["taskId"],
    language: o["language"],
    modelId: o["modelId"],
    sampleIndex,
    diagnosticFormat,
    finishedAt: o["finishedAt"],
    outcome: o["outcome"],
    contaminated: o["contaminated"] === true,
    roundsToGreen,
    maxRounds: o["maxRounds"],
    firstShotPass: o["firstShotPass"] === true,
    repairRounds,
  };
}

function parseRepairRounds(raw: unknown): RoundSlice[] {
  if (!Array.isArray(raw)) return [];
  const out: RoundSlice[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const round = typeof r["round"] === "number" ? r["round"] : out.length;
    const probes: ProbeSlice[] = [];
    if (Array.isArray(r["probes"])) {
      for (const p of r["probes"]) {
        if (p == null || typeof p !== "object") continue;
        const pr = p as Record<string, unknown>;
        if (typeof pr["name"] !== "string") continue;
        const ok =
          pr["ok"] === true ? true : pr["ok"] === false ? false : pr["ok"] === null ? null : null;
        probes.push({ name: pr["name"], ok });
      }
    }
    out.push({ round, probes });
  }
  return out;
}

export function dedupeKey(
  r: Pick<AbRow, "taskId" | "language" | "modelId" | "sampleIndex" | "diagnosticFormat">,
): string {
  return `${r.taskId}\0${r.language}\0${r.modelId}\0${r.sampleIndex}\0${r.diagnosticFormat}`;
}

/**
 * One row per (taskId, language, modelId, sampleIndex, diagnosticFormat);
 * latest `finishedAt` wins (pre-registration).
 */
export function dedupeRows(rows: AbRow[]): AbRow[] {
  const best = new Map<string, AbRow>();
  for (const r of rows) {
    const k = dedupeKey(r);
    const prev = best.get(k);
    if (!prev || r.finishedAt >= prev.finishedAt) best.set(k, r);
  }
  return [...best.values()];
}

export type ExclusionCounts = {
  harnessError: number;
  contaminated: number;
};

/**
 * Exclude `harness_error` and `contaminated` after dedup; count both per arm.
 * Order matches the pre-registration: harness errors, then contamination.
 */
export function excludeRows(rows: AbRow[]): { usable: AbRow[]; excluded: ExclusionCounts } {
  let harnessError = 0;
  let contaminated = 0;
  const usable: AbRow[] = [];
  for (const r of rows) {
    if (r.outcome === "harness_error") {
      harnessError += 1;
      continue;
    }
    if (r.contaminated) {
      contaminated += 1;
      continue;
    }
    usable.push(r);
  }
  return { usable, excluded: { harnessError, contaminated } };
}

// ---------------------------------------------------------------------------
// Wilcoxon signed-rank (paired), normal approx + ties + continuity
// ---------------------------------------------------------------------------

export type WilcoxonResult = {
  /** Non-zero pairs that entered the statistic. */
  n: number;
  /** Pairs dropped because the two task means were equal. */
  nDroppedZero: number;
  wPlus: number;
  wMinus: number;
  /** Continuity-corrected z for the two-sided p-value (non-negative). */
  z: number;
  pValue: number;
  /** Named method string for the report (includes zero-drop count). */
  method: string;
};

/**
 * Two-sided paired Wilcoxon signed-rank via normal approximation.
 *
 * - Zero differences dropped.
 * - Tied |d| values receive the average rank.
 * - Variance uses the standard tie correction Σ(t³ − t)/48.
 * - Continuity correction of 0.5 on |W⁺ − μ|.
 *
 * No scipy in this repo; the formula is the textbook one (e.g. Hollander &
 * Wolfe). See tests for a hand-worked tied-|d| example.
 */
export function wilcoxonSignedRank(diffs: readonly number[]): WilcoxonResult {
  const methodBase =
    "paired Wilcoxon signed-rank, normal approximation with rank-tie correction and continuity correction";

  const nonzero = diffs.filter((d) => d !== 0);
  const nDroppedZero = diffs.length - nonzero.length;
  const n = nonzero.length;

  if (n === 0) {
    return {
      n: 0,
      nDroppedZero,
      wPlus: 0,
      wMinus: 0,
      z: NaN,
      pValue: NaN,
      method: `${methodBase}; ${nDroppedZero} zero-difference pair(s) dropped; no non-zero pairs`,
    };
  }

  const items = nonzero.map((d) => ({ d, abs: Math.abs(d) }));
  items.sort((a, b) => a.abs - b.abs);

  // Average ranks for equal |d|; accumulate t³−t for the variance correction.
  const ranks: number[] = new Array(n);
  let tieSum = 0; // Σ (t³ − t)
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && items[j]!.abs === items[i]!.abs) j += 1;
    const t = j - i;
    // Ranks are 1-based: positions i+1 … j share the average.
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) ranks[k] = avgRank;
    if (t > 1) tieSum += t * t * t - t;
    i = j;
  }

  let wPlus = 0;
  let wMinus = 0;
  for (let k = 0; k < n; k++) {
    const rank = ranks[k]!;
    if (items[k]!.d > 0) wPlus += rank;
    else wMinus += rank;
  }

  const mu = (n * (n + 1)) / 4;
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tieSum / 48;

  if (!(variance > 0)) {
    // Degenerate: every non-zero |d| identical and n so small that σ² ≤ 0.
    return {
      n,
      nDroppedZero,
      wPlus,
      wMinus,
      z: NaN,
      pValue: NaN,
      method: `${methodBase}; ${nDroppedZero} zero-difference pair(s) dropped; variance non-positive`,
    };
  }

  const sigma = Math.sqrt(variance);
  // Continuity-corrected z for two-sided p; clamp so |W−μ| < ½ → p = 1.
  const zCont = Math.max(0, (Math.abs(wPlus - mu) - 0.5) / sigma);
  const pValue = 2 * (1 - normalCdf(zCont));

  return {
    n,
    nDroppedZero,
    wPlus,
    wMinus,
    z: zCont,
    pValue: Math.min(1, Math.max(0, pValue)),
    method: `${methodBase}; ${nDroppedZero} zero-difference pair(s) dropped`,
  };
}

/** Φ(z) via erf (Abramowitz & Stegun 7.1.26). */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  // A&S 7.1.26 — max error ~1.5e-7.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

// ---------------------------------------------------------------------------
// Two-proportion z-test (negative control on firstShotPass)
// ---------------------------------------------------------------------------

export type PropTestResult = {
  n1: number;
  n2: number;
  p1: number;
  p2: number;
  diff: number;
  z: number;
  pValue: number;
  method: string;
};

/**
 * Two-sided two-proportion z-test (pooled H₀ variance).
 *
 * Used only for the negative control: first-shot rates must not differ.
 */
export function twoProportionZTest(
  successes1: number,
  n1: number,
  successes2: number,
  n2: number,
): PropTestResult {
  const method = "two-sided two-proportion z-test (pooled H0 variance)";
  if (n1 === 0 || n2 === 0) {
    return {
      n1,
      n2,
      p1: NaN,
      p2: NaN,
      diff: NaN,
      z: NaN,
      pValue: NaN,
      method: `${method}; empty arm`,
    };
  }
  const p1 = successes1 / n1;
  const p2 = successes2 / n2;
  const p = (successes1 + successes2) / (n1 + n2);
  const se2 = p * (1 - p) * (1 / n1 + 1 / n2);
  if (!(se2 > 0)) {
    // Both rates 0 or both 1 — no evidence of a difference.
    return {
      n1,
      n2,
      p1,
      p2,
      diff: p1 - p2,
      z: 0,
      pValue: 1,
      method: `${method}; zero estimated variance under H0`,
    };
  }
  const z = (p1 - p2) / Math.sqrt(se2);
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return {
    n1,
    n2,
    p1,
    p2,
    diff: p1 - p2,
    z,
    pValue: Math.min(1, Math.max(0, pValue)),
    method,
  };
}

// ---------------------------------------------------------------------------
// Aggregation and report
// ---------------------------------------------------------------------------

export type ArmDescriptives = {
  arm: Arm;
  nUsable: number;
  excludedHarnessError: number;
  excludedContaminated: number;
  meanDv: number;
  greenRate: number;
  firstShotRate: number;
};

export type TaskPair = {
  taskId: string;
  meanText: number;
  meanAgent: number;
  nText: number;
  nAgent: number;
};

export type Verdict =
  | "significant_past_bar"
  | "significant_under_bar"
  | "not_significant"
  | "underpowered";

export type AbReport = {
  arms: { text: ArmDescriptives; agent: ArmDescriptives };
  /** Tasks dropped for < MIN_SAMPLES usable samples in either arm. */
  droppedTasks: string[];
  /** Paired task means used in the primary test. */
  pairs: TaskPair[];
  primary: {
    meanDiffTextMinusAgent: number;
    wilcoxon: WilcoxonResult;
    significant: boolean;
    pastBar: boolean;
    verdict: Verdict;
    verdictLine: string;
  };
  secondary: {
    /** Tasks in the secondary stratum (R0 check failed) with enough samples. */
    pairs: TaskPair[];
    droppedTasks: string[];
    meanDiffTextMinusAgent: number;
    wilcoxon: WilcoxonResult;
  };
  negativeControl: PropTestResult & {
    invalidatesPrimary: boolean;
    note: string;
  };
};

type TaskAccum = {
  dvs: number[];
  firstShots: number;
  greens: number;
};

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function accumulate(rows: readonly AbRow[]): Map<string, TaskAccum> {
  const m = new Map<string, TaskAccum>();
  for (const r of rows) {
    let a = m.get(r.taskId);
    if (!a) {
      a = { dvs: [], firstShots: 0, greens: 0 };
      m.set(r.taskId, a);
    }
    a.dvs.push(censoredDv(r));
    if (r.firstShotPass) a.firstShots += 1;
    if (r.roundsToGreen != null) a.greens += 1;
  }
  return m;
}

function armDescriptives(arm: Arm, usable: AbRow[], excluded: ExclusionCounts): ArmDescriptives {
  const n = usable.length;
  const dvs = usable.map(censoredDv);
  const greens = usable.filter((r) => r.roundsToGreen != null).length;
  const firstShots = usable.filter((r) => r.firstShotPass).length;
  return {
    arm,
    nUsable: n,
    excludedHarnessError: excluded.harnessError,
    excludedContaminated: excluded.contaminated,
    meanDv: mean(dvs),
    greenRate: n === 0 ? NaN : greens / n,
    firstShotRate: n === 0 ? NaN : firstShots / n,
  };
}

function buildPairs(
  textByTask: Map<string, TaskAccum>,
  agentByTask: Map<string, TaskAccum>,
  minSamples: number,
): { pairs: TaskPair[]; droppedTasks: string[] } {
  const allTasks = new Set([...textByTask.keys(), ...agentByTask.keys()]);
  const pairs: TaskPair[] = [];
  const droppedTasks: string[] = [];
  for (const taskId of [...allTasks].sort()) {
    const t = textByTask.get(taskId);
    const a = agentByTask.get(taskId);
    const nText = t?.dvs.length ?? 0;
    const nAgent = a?.dvs.length ?? 0;
    if (nText < minSamples || nAgent < minSamples) {
      droppedTasks.push(taskId);
      continue;
    }
    pairs.push({
      taskId,
      meanText: mean(t!.dvs),
      meanAgent: mean(a!.dvs),
      nText,
      nAgent,
    });
  }
  return { pairs, droppedTasks };
}

function verdictFor(
  wilcoxon: WilcoxonResult,
  meanDiffAbs: number,
  alpha: number,
  bar: number,
): { verdict: Verdict; significant: boolean; pastBar: boolean; verdictLine: string } {
  if (!(wilcoxon.n >= 1) || Number.isNaN(wilcoxon.pValue)) {
    return {
      verdict: "underpowered",
      significant: false,
      pastBar: false,
      verdictLine:
        "VERDICT: UNDERPOWERED / INSUFFICIENT DATA — too few non-zero paired task means to run the pre-registered Wilcoxon.",
    };
  }
  const significant = wilcoxon.pValue < alpha;
  const pastBar = meanDiffAbs >= bar;
  if (significant && pastBar) {
    return {
      verdict: "significant_past_bar",
      significant: true,
      pastBar: true,
      verdictLine: `VERDICT: SIGNIFICANT AND PAST THE ${bar}-ROUND BAR — real difference large enough to ship (α=${alpha}).`,
    };
  }
  if (significant && !pastBar) {
    return {
      verdict: "significant_under_bar",
      significant: true,
      pastBar: false,
      verdictLine: `VERDICT: SIGNIFICANT BUT UNDER THE ${bar}-ROUND BAR — real, not worth shipping (α=${alpha}).`,
    };
  }
  return {
    verdict: "not_significant",
    significant: false,
    pastBar,
    verdictLine: `VERDICT: NOT SIGNIFICANT — no two-sided evidence of a difference at α=${alpha}.`,
  };
}

/**
 * Full pre-registered analysis on two arm row lists (already loaded).
 *
 * Rows may mix formats; each list is filtered to its arm's `diagnosticFormat`.
 */
export function analyze(
  textRows: readonly AbRow[],
  agentRows: readonly AbRow[],
  opts: { minSamples?: number; alpha?: number; bar?: number } = {},
): AbReport {
  const minSamples = opts.minSamples ?? MIN_SAMPLES;
  const alpha = opts.alpha ?? ALPHA;
  const bar = opts.bar ?? EFFECT_BAR;

  const textDeduped = dedupeRows(textRows.filter((r) => r.diagnosticFormat === "text"));
  const agentDeduped = dedupeRows(agentRows.filter((r) => r.diagnosticFormat === "agent"));

  const textEx = excludeRows(textDeduped);
  const agentEx = excludeRows(agentDeduped);

  const textDesc = armDescriptives("text", textEx.usable, textEx.excluded);
  const agentDesc = armDescriptives("agent", agentEx.usable, agentEx.excluded);

  const textByTask = accumulate(textEx.usable);
  const agentByTask = accumulate(agentEx.usable);
  const { pairs, droppedTasks } = buildPairs(textByTask, agentByTask, minSamples);

  const diffs = pairs.map((p) => p.meanText - p.meanAgent);
  const meanDiff = mean(diffs);
  const wilcoxon = wilcoxonSignedRank(diffs);
  const v = verdictFor(wilcoxon, Math.abs(meanDiff), alpha, bar);

  // Secondary: samples whose round-0 check probe failed (per arm), then same
  // pairing rule. Pre-treatment stratum — not the forbidden post-exposure filter.
  const textSec = textEx.usable.filter(round0CheckFailed);
  const agentSec = agentEx.usable.filter(round0CheckFailed);
  const secPairsBuilt = buildPairs(accumulate(textSec), accumulate(agentSec), minSamples);
  const secDiffs = secPairsBuilt.pairs.map((p) => p.meanText - p.meanAgent);
  const secMeanDiff = mean(secDiffs);
  const secWilcoxon = wilcoxonSignedRank(secDiffs);

  const firstText = textEx.usable.filter((r) => r.firstShotPass).length;
  const firstAgent = agentEx.usable.filter((r) => r.firstShotPass).length;
  const neg = twoProportionZTest(
    firstText,
    textEx.usable.length,
    firstAgent,
    agentEx.usable.length,
  );
  const invalidatesPrimary = !Number.isNaN(neg.pValue) && neg.pValue < alpha;

  return {
    arms: { text: textDesc, agent: agentDesc },
    droppedTasks,
    pairs,
    primary: {
      meanDiffTextMinusAgent: meanDiff,
      wilcoxon,
      significant: v.significant,
      pastBar: v.pastBar,
      verdict: v.verdict,
      verdictLine: v.verdictLine,
    },
    secondary: {
      pairs: secPairsBuilt.pairs,
      droppedTasks: secPairsBuilt.droppedTasks,
      meanDiffTextMinusAgent: secMeanDiff,
      wilcoxon: secWilcoxon,
    },
    negativeControl: {
      ...neg,
      invalidatesPrimary,
      note: invalidatesPrimary
        ? "NEGATIVE CONTROL FAILED: firstShotPass differs between arms at α — round-0 prompts should be byte-identical, so something leaked; the primary result is NOT to be trusted."
        : "Negative control OK: firstShotPass does not differ significantly between arms (as required for a valid A/B).",
    },
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtRate(x: number): string {
  if (Number.isNaN(x)) return "   n/a";
  return `${(100 * x).toFixed(1)}%`;
}

function fmtNum(x: number, digits = 3): string {
  if (Number.isNaN(x)) return "n/a";
  return x.toFixed(digits);
}

function fmtP(p: number): string {
  if (Number.isNaN(p)) return "n/a";
  if (p < 0.0001) return "<0.0001";
  return p.toFixed(4);
}

export function formatReport(report: AbReport): string {
  const lines: string[] = [];
  lines.push("# Diagnostic format A/B — diagfmt-01");
  lines.push("");
  lines.push("Pre-registration: analysis/prereg-diagfmt-01.md");
  lines.push(`DV: roundsToGreen if green, else maxRounds+1 (per-row maxRounds).`);
  lines.push(`Primary: paired Wilcoxon on per-task mean DV; α=${ALPHA}; bar=${EFFECT_BAR} rounds.`);
  lines.push("");

  lines.push("## Per-arm descriptives (after dedup + exclusions)");
  lines.push("");
  lines.push(
    "arm     n  excl_harness  excl_contam   mean_DV  green%  firstShot%",
  );
  lines.push("-".repeat(68));
  for (const arm of [report.arms.text, report.arms.agent] as const) {
    lines.push(
      arm.arm.padEnd(7) +
        String(arm.nUsable).padStart(3) +
        String(arm.excludedHarnessError).padStart(14) +
        String(arm.excludedContaminated).padStart(13) +
        fmtNum(arm.meanDv).padStart(10) +
        fmtRate(arm.greenRate).padStart(8) +
        fmtRate(arm.firstShotRate).padStart(12),
    );
  }
  lines.push("");

  if (report.droppedTasks.length > 0) {
    lines.push(
      `## Tasks dropped (<${MIN_SAMPLES} usable samples in either arm) — ${report.droppedTasks.length}`,
    );
    lines.push("");
    for (const t of report.droppedTasks) lines.push(`  - ${t}`);
    lines.push("");
  } else {
    lines.push(`## Tasks dropped (<${MIN_SAMPLES} usable samples in either arm): none`);
    lines.push("");
  }

  lines.push("## Primary analysis");
  lines.push("");
  lines.push(`  paired tasks          ${report.pairs.length}`);
  lines.push(
    `  mean(DV_text − DV_agent)  ${fmtNum(report.primary.meanDiffTextMinusAgent)} rounds` +
      `  (positive ⇒ agent fewer rounds)`,
  );
  const w = report.primary.wilcoxon;
  lines.push(`  Wilcoxon n (non-zero) ${w.n}  (zero-diff pairs dropped: ${w.nDroppedZero})`);
  lines.push(`  W+ ${fmtNum(w.wPlus, 2)}   W− ${fmtNum(w.wMinus, 2)}   z ${fmtNum(w.z)}   p ${fmtP(w.pValue)}`);
  lines.push(`  method: ${w.method}`);
  lines.push("");
  lines.push(report.primary.verdictLine);
  lines.push("");

  lines.push("## Secondary stratum — round-0 `check` probe failed (per arm)");
  lines.push("");
  lines.push(
    "  Pre-treatment: format enters at round 1. Not the forbidden filter on",
  );
  lines.push('  "failed at least once" / "needed a repair round".');
  lines.push("");
  lines.push(`  paired tasks          ${report.secondary.pairs.length}`);
  if (report.secondary.droppedTasks.length > 0) {
    lines.push(
      `  dropped (short samples) ${report.secondary.droppedTasks.length}: ${report.secondary.droppedTasks.join(", ")}`,
    );
  }
  lines.push(
    `  mean(DV_text − DV_agent)  ${fmtNum(report.secondary.meanDiffTextMinusAgent)} rounds`,
  );
  const sw = report.secondary.wilcoxon;
  lines.push(
    `  Wilcoxon n (non-zero) ${sw.n}  (zero-diff dropped: ${sw.nDroppedZero})  z ${fmtNum(sw.z)}  p ${fmtP(sw.pValue)}`,
  );
  lines.push(`  method: ${sw.method}`);
  lines.push("");

  lines.push("## Negative control — firstShotPass");
  lines.push("");
  const nc = report.negativeControl;
  lines.push(
    `  rate text  ${fmtRate(nc.p1)}  (${Math.round(nc.p1 * nc.n1)}/${nc.n1})` +
      `   agent ${fmtRate(nc.p2)}  (${Math.round(nc.p2 * nc.n2)}/${nc.n2})`,
  );
  lines.push(
    `  diff (text − agent) ${fmtNum(nc.diff)}   z ${fmtNum(nc.z)}   p ${fmtP(nc.pValue)}`,
  );
  lines.push(`  method: ${nc.method}`);
  lines.push("");
  lines.push(`  ${nc.note}`);
  if (nc.invalidatesPrimary) {
    lines.push("");
    lines.push(
      "  *** PRIMARY RESULT INVALIDATED by negative control — do not interpret the A/B. ***",
    );
  }
  lines.push("");

  return lines.join("\n");
}

/** Machine-readable subset of the report (same numbers as the text). */
export function reportJson(report: AbReport): unknown {
  return {
    arms: report.arms,
    droppedTasks: report.droppedTasks,
    nPairs: report.pairs.length,
    primary: {
      meanDiffTextMinusAgent: report.primary.meanDiffTextMinusAgent,
      wilcoxon: report.primary.wilcoxon,
      significant: report.primary.significant,
      pastBar: report.primary.pastBar,
      verdict: report.primary.verdict,
      verdictLine: report.primary.verdictLine,
    },
    secondary: {
      nPairs: report.secondary.pairs.length,
      droppedTasks: report.secondary.droppedTasks,
      meanDiffTextMinusAgent: report.secondary.meanDiffTextMinusAgent,
      wilcoxon: report.secondary.wilcoxon,
    },
    negativeControl: {
      n1: report.negativeControl.n1,
      n2: report.negativeControl.n2,
      p1: report.negativeControl.p1,
      p2: report.negativeControl.p2,
      diff: report.negativeControl.diff,
      z: report.negativeControl.z,
      pValue: report.negativeControl.pValue,
      method: report.negativeControl.method,
      invalidatesPrimary: report.negativeControl.invalidatesPrimary,
      note: report.negativeControl.note,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function loadArmFile(name: string): AbRow[] {
  const path = join(RUNS_DIR, name);
  if (!existsSync(path)) {
    console.error(`missing run file: ${path}`);
    console.error("(sweep still starting, wrong cwd, or run-id mismatch)");
    return [];
  }
  return parseJsonl(readFileSync(path, "utf8"));
}

function main(): void {
  const json = process.argv.includes("--json");
  const textRows = loadArmFile(TEXT_FILE);
  const agentRows = loadArmFile(AGENT_FILE);
  const report = analyze(textRows, agentRows);
  process.stdout.write(formatReport(report));
  if (json) {
    process.stdout.write("\n");
    process.stdout.write(JSON.stringify(reportJson(report), null, 2));
    process.stdout.write("\n");
  }
}

// Only run when executed as a script (not when imported by tests).
if (import.meta.main) {
  main();
}
