/**
 * Pure aggregation over attempt rows for the live dashboard.
 *
 * Two counting rules that every rate depends on (see the dashboard brief):
 *
 * 1. Deduplicate by (taskId, language, modelId, sampleIndex), keeping the latest
 *    `finishedAt`. Retries append; counting raw rows inflates the denominator.
 * 2. Exclude `harness_error` from the scored set. Those rows measured the
 *    provider, not the model — and they cluster on hard tasks, so silently
 *    dropping them without showing the count biases pass rate upward.
 */

import type { HarnessErrorKind, Outcome, TaskSet } from "../runner/schema.ts";

/** Fields the dashboard needs from an attempt record. */
export type AttemptSlice = {
  runId: string;
  taskId: string;
  language: string;
  modelId: string;
  sampleIndex: number;
  taskSet: TaskSet | string;
  outcome: Outcome | string;
  harnessErrorKind: HarnessErrorKind | string | null;
  firstShotPass: boolean;
  roundsToGreen: number | null;
  startedAt: string;
  finishedAt: string;
  costUsd: number | null;
  avenCommit: string | null;
  docId: string | null;
  probes?: Array<{ diagnosticCodes?: string[] }>;
};

export type SplitSizes = {
  tune: number;
  holdout: number;
};

export type RunStatus = "live" | "stalled" | "finished";

export type NonPassTask = {
  taskId: string;
  language: string;
  modelId: string;
  sampleIndex: number;
  outcome: string;
  harnessErrorKind: string | null;
  diagnosticCodes: string[];
};

export type RunSummary = {
  runId: string;
  models: string[];
  languages: string[];
  taskSets: string[];
  avenCommits: string[];
  docIds: string[];
  /** Unique keys after dedup (progress numerator). */
  done: number;
  /** Known total, or null when unknowable — never invented. */
  total: number | null;
  status: RunStatus;
  /** Wall clock from earliest startedAt to last activity. */
  elapsedMs: number;
  lastActivityAt: string | null;
  /** File mtime (ISO), when the watcher supplies it. */
  mtimeAt: string | null;
  /** Passes / scored; null when scored is 0. */
  passRate: number | null;
  /** firstShotPass among scored. */
  firstShotRate: number | null;
  scored: number;
  passes: number;
  firstShots: number;
  /** harness_error count after dedup, broken down by kind. */
  excluded: number;
  excludedByKind: Record<string, number>;
  /**
   * Histogram of roundsToGreen for passing tasks only.
   * Keys are round counts as strings for stable JSON; ordered when rendered.
   */
  roundsToGreen: Record<string, number>;
  nonPassing: NonPassTask[];
  costUsd: number | null;
  rawRows: number;
};

/** How long without file growth before a short-of-total run is "stalled". */
export const STALL_MS = 3 * 60 * 1000;

export function dedupeKey(
  r: Pick<AttemptSlice, "taskId" | "language" | "modelId" | "sampleIndex">,
): string {
  return `${r.taskId}\0${r.language}\0${r.modelId}\0${r.sampleIndex}`;
}

/**
 * One row per (taskId, language, modelId, sampleIndex), latest finishedAt wins.
 * Ties keep the later array element (append order ≈ finish order).
 */
export function dedupeAttempts(rows: AttemptSlice[]): AttemptSlice[] {
  const best = new Map<string, AttemptSlice>();
  for (const r of rows) {
    const k = dedupeKey(r);
    const prev = best.get(k);
    if (!prev || r.finishedAt >= prev.finishedAt) best.set(k, r);
  }
  return [...best.values()];
}

export function isHarnessError(r: Pick<AttemptSlice, "outcome">): boolean {
  return r.outcome === "harness_error";
}

/** Scored set: deduped rows that are not harness errors. */
export function scoredAttempts(deduped: AttemptSlice[]): AttemptSlice[] {
  return deduped.filter((r) => !isHarnessError(r));
}

export function countExcludedByKind(
  deduped: AttemptSlice[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of deduped) {
    if (!isHarnessError(r)) continue;
    const kind = r.harnessErrorKind ?? "unknown";
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

/** Histogram of roundsToGreen among passes; skips null. */
export function roundsToGreenHist(scored: AttemptSlice[]): Record<string, number> {
  const hist: Record<string, number> = {};
  for (const r of scored) {
    if (r.outcome !== "pass" || r.roundsToGreen == null) continue;
    const k = String(r.roundsToGreen);
    hist[k] = (hist[k] ?? 0) + 1;
  }
  return hist;
}

function diagnosticCodes(r: AttemptSlice): string[] {
  const codes = new Set<string>();
  for (const p of r.probes ?? []) {
    for (const c of p.diagnosticCodes ?? []) codes.add(c);
  }
  return [...codes];
}

/**
 * Expected attempt count when every row shares one known task set.
 *
 * M = |taskSet| × |observed (language, modelId, sampleIndex)|.
 * Returns null when task sets are mixed/unknown or the split size is missing —
 * never invent a total for --tasks / --limit runs that we cannot recognise.
 */
export function expectedTotal(
  deduped: AttemptSlice[],
  split: SplitSizes,
): number | null {
  if (deduped.length === 0) return null;
  const sets = new Set(deduped.map((r) => r.taskSet));
  if (sets.size !== 1) return null;
  const only = [...sets][0];
  let setSize: number | undefined;
  if (only === "tune") setSize = split.tune;
  else if (only === "holdout") setSize = split.holdout;
  if (setSize == null || setSize <= 0) return null;

  const cells = new Set(
    deduped.map((r) => `${r.language}\0${r.modelId}\0${r.sampleIndex}`),
  );
  return setSize * cells.size;
}

export function deriveStatus(
  done: number,
  total: number | null,
  mtimeMs: number,
  nowMs: number,
  stallMs: number = STALL_MS,
): RunStatus {
  if (total != null && done >= total) return "finished";
  const age = nowMs - mtimeMs;
  if (age < stallMs) return "live";
  if (total != null && done < total) return "stalled";
  return "finished";
}

function uniqueSorted(xs: Iterable<string | null | undefined>): string[] {
  return [...new Set([...xs].filter((x): x is string => x != null && x !== ""))].sort();
}

export function summarizeRun(
  rows: AttemptSlice[],
  opts: {
    split: SplitSizes;
    mtimeMs: number;
    nowMs: number;
    stallMs?: number;
  },
): RunSummary {
  const deduped = dedupeAttempts(rows);
  const scored = scoredAttempts(deduped);
  const passes = scored.filter((r) => r.outcome === "pass");
  const firstShots = scored.filter((r) => r.firstShotPass);
  const excludedByKind = countExcludedByKind(deduped);
  const excluded = Object.values(excludedByKind).reduce((a, b) => a + b, 0);
  const total = expectedTotal(deduped, opts.split);
  const done = deduped.length;
  const status = deriveStatus(done, total, opts.mtimeMs, opts.nowMs, opts.stallMs);

  let costSum = 0;
  let costAny = false;
  for (const r of deduped) {
    if (r.costUsd != null) {
      costSum += r.costUsd;
      costAny = true;
    }
  }

  const startedAts = rows.map((r) => r.startedAt).filter(Boolean).sort();
  const finishedAts = rows.map((r) => r.finishedAt).filter(Boolean).sort();
  const earliest = startedAts[0] ?? null;
  const latest = finishedAts[finishedAts.length - 1] ?? null;
  const lastActivityAt =
    latest != null && opts.mtimeMs > 0
      ? new Date(Math.max(Date.parse(latest), opts.mtimeMs)).toISOString()
      : latest ?? (opts.mtimeMs > 0 ? new Date(opts.mtimeMs).toISOString() : null);

  let elapsedMs = 0;
  if (earliest) {
    const end = status === "live" || status === "stalled" ? opts.nowMs : Date.parse(lastActivityAt ?? earliest);
    elapsedMs = Math.max(0, end - Date.parse(earliest));
  }

  const nonPassing: NonPassTask[] = deduped
    .filter((r) => r.outcome !== "pass")
    .map((r) => ({
      taskId: r.taskId,
      language: r.language,
      modelId: r.modelId,
      sampleIndex: r.sampleIndex,
      outcome: String(r.outcome),
      harnessErrorKind: r.harnessErrorKind != null ? String(r.harnessErrorKind) : null,
      diagnosticCodes: diagnosticCodes(r),
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.language.localeCompare(b.language));

  const runId = rows[0]?.runId ?? "unknown";

  return {
    runId,
    models: uniqueSorted(deduped.map((r) => r.modelId)),
    languages: uniqueSorted(deduped.map((r) => r.language)),
    taskSets: uniqueSorted(deduped.map((r) => String(r.taskSet))),
    avenCommits: uniqueSorted(deduped.map((r) => r.avenCommit)),
    docIds: uniqueSorted(deduped.map((r) => r.docId)),
    done,
    total,
    status,
    elapsedMs,
    lastActivityAt,
    mtimeAt: opts.mtimeMs > 0 ? new Date(opts.mtimeMs).toISOString() : null,
    passRate: scored.length > 0 ? passes.length / scored.length : null,
    firstShotRate: scored.length > 0 ? firstShots.length / scored.length : null,
    scored: scored.length,
    passes: passes.length,
    firstShots: firstShots.length,
    excluded,
    excludedByKind,
    roundsToGreen: roundsToGreenHist(scored),
    nonPassing,
    costUsd: costAny ? costSum : null,
    rawRows: rows.length,
  };
}

export function sortSummaries(runs: RunSummary[]): RunSummary[] {
  const rank: Record<RunStatus, number> = { live: 0, stalled: 1, finished: 2 };
  return [...runs].sort((a, b) => {
    const dr = rank[a.status] - rank[b.status];
    if (dr !== 0) return dr;
    const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return tb - ta;
  });
}

/** Pull the dashboard slice from a parsed JSONL object; returns null if unusable. */
export function sliceFromUnknown(raw: unknown): AttemptSlice | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["taskId"] !== "string" || typeof o["language"] !== "string") return null;
  if (typeof o["modelId"] !== "string" || typeof o["finishedAt"] !== "string") return null;
  const sampleIndex = typeof o["sampleIndex"] === "number" ? o["sampleIndex"] : 0;
  return {
    runId: typeof o["runId"] === "string" ? o["runId"] : "unknown",
    taskId: o["taskId"],
    language: o["language"],
    modelId: o["modelId"],
    sampleIndex,
    taskSet: typeof o["taskSet"] === "string" ? o["taskSet"] : "unknown",
    outcome: typeof o["outcome"] === "string" ? o["outcome"] : "unknown",
    harnessErrorKind:
      o["harnessErrorKind"] == null
        ? null
        : typeof o["harnessErrorKind"] === "string"
          ? o["harnessErrorKind"]
          : String(o["harnessErrorKind"]),
    firstShotPass: o["firstShotPass"] === true,
    roundsToGreen: typeof o["roundsToGreen"] === "number" ? o["roundsToGreen"] : null,
    startedAt: typeof o["startedAt"] === "string" ? o["startedAt"] : o["finishedAt"],
    finishedAt: o["finishedAt"],
    costUsd: typeof o["costUsd"] === "number" ? o["costUsd"] : null,
    avenCommit: typeof o["avenCommit"] === "string" ? o["avenCommit"] : null,
    docId: typeof o["docId"] === "string" ? o["docId"] : null,
    probes: Array.isArray(o["probes"])
      ? (o["probes"] as Array<{ diagnosticCodes?: string[] }>)
      : undefined,
  };
}
