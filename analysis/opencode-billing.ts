/**
 * Reconcile a run's logged `costUsd` against opencode.ai's own usage feed.
 *
 * Why this exists: opencode's per-step `cost` is not the invoice. On the
 * phase6-harness-opencode-01 arm it reported $0.8460 against a real charge of
 * $2.7846 — 30% of the bill. Three independent faults stacked up, and only the
 * feed can separate them, because two of the three are invisible from inside a
 * run:
 *
 *   1. Luna carries a "2x usage" multiplier that opencode's `cost` omits. The
 *      ratio is exactly 2.0000 in all 141 sessions — not approximately.
 *   2. Fresh input is billed under BOTH `inputTokens` and `cacheWrite5mTokens`.
 *      opencode surfaces those tokens once, as `cache.write`.
 *   3. The adapter observed ~72-80% of the cache token events and ~96.5% of the
 *      output. That residue is a real gap and is reported, not silently absorbed.
 *
 * The join key is `agentSessionRef` against the feed's `sessionID`. Its
 * correctness is self-checking: every harness row that fails to match should be
 * one that never reached a model. On arm B that came out exactly right — 14
 * unmatched rows, and 14 `agent-no-tokens` outcomes.
 *
 * The feed dump is captured out of band (it needs a browser session cookie) and
 * committed alongside as a plain JSON array. Nothing here touches `data/runs`.
 *
 *   bun run analysis/opencode-billing.ts [--run <runId>] [--feed <path>]
 */

import { readFileSync } from "node:fs";

const RUNS_DIR = new URL("../data/runs", import.meta.url).pathname;
const DEFAULT_FEED = new URL("./opencode-usage-feed-2026-08-06.json", import.meta.url).pathname;

/** 1 cost unit = 1e-8 USD. Recovered by regression; see `reconcile`. */
export const COST_UNIT_USD = 1e-8;

export type FeedRecord = {
  id: string;
  t: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  costUnits: number;
  sessionId: string;
};

export type Reconciliation = {
  runId: string;
  matchedSessions: number;
  matchedRequests: number;
  /** Harness rows with no billing session — expected to be exactly the nulls. */
  unmatchedRows: number;
  unmatchedNullOutcomes: number;
  /** Feed sessions with no harness row: survey, preflight probe. */
  orphanSessions: number;
  orphanUsd: number;
  loggedUsd: number;
  invoicedUsd: number;
  /** Per-attempt truth, keyed `taskId|sampleIndex`. */
  perAttempt: Map<string, { loggedUsd: number; invoicedUsd: number; requests: number }>;
};

type Row = {
  taskId: string;
  sampleIndex: number;
  agentSessionRef: string | null;
  costUsd: number | null;
  outcome: string;
  finishedAt: string | null;
};

export function readFeed(path: string): FeedRecord[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: FeedRecord[] };
  return parsed.records;
}

export function reconcile(rows: readonly Row[], feed: readonly FeedRecord[], runId: string): Reconciliation {
  const bySession = new Map<string, FeedRecord[]>();
  for (const r of feed) {
    const list = bySession.get(r.sessionId);
    if (list) list.push(r);
    else bySession.set(r.sessionId, [r]);
  }

  const perAttempt = new Map<string, { loggedUsd: number; invoicedUsd: number; requests: number }>();
  let matchedSessions = 0;
  let matchedRequests = 0;
  let unmatchedRows = 0;
  let unmatchedNullOutcomes = 0;
  let loggedUsd = 0;
  let invoicedUsd = 0;
  const claimed = new Set<string>();

  for (const row of rows) {
    loggedUsd += row.costUsd ?? 0;
    const hit = row.agentSessionRef ? bySession.get(row.agentSessionRef) : undefined;
    if (!hit) {
      unmatchedRows += 1;
      if (row.outcome === "harness_error") unmatchedNullOutcomes += 1;
      continue;
    }
    claimed.add(row.agentSessionRef as string);
    matchedSessions += 1;
    matchedRequests += hit.length;
    const usd = hit.reduce((a, r) => a + r.costUnits, 0) * COST_UNIT_USD;
    invoicedUsd += usd;
    perAttempt.set(`${row.taskId}|${row.sampleIndex}`, {
      loggedUsd: row.costUsd ?? 0,
      invoicedUsd: usd,
      requests: hit.length,
    });
  }

  // Orphans are only meaningful inside this run's own wall-clock window. The feed
  // spans every round the account ever billed, so counting all unclaimed sessions
  // would attribute other sweeps' spend to this one — which the first draft did,
  // reporting 316 "survey + preflight" sessions for a run that had four.
  const stamps = rows.map((r) => r.finishedAt).filter((t): t is string => Boolean(t));
  const from = stamps.reduce((a, b) => (a < b ? a : b), stamps[0] ?? "");
  const to = stamps.reduce((a, b) => (a > b ? a : b), stamps[0] ?? "");
  let orphanSessions = 0;
  let orphanUsd = 0;
  for (const [id, list] of bySession) {
    if (claimed.has(id)) continue;
    if (!list.some((r) => r.t >= from && r.t <= to)) continue;
    orphanSessions += 1;
    orphanUsd += list.reduce((a, r) => a + r.costUnits, 0) * COST_UNIT_USD;
  }

  return {
    runId,
    matchedSessions,
    matchedRequests,
    unmatchedRows,
    unmatchedNullOutcomes,
    orphanSessions,
    orphanUsd,
    loggedUsd,
    invoicedUsd,
    perAttempt,
  };
}

export function formatReconciliation(r: Reconciliation): string {
  const usd = (n: number): string => `$${n.toFixed(4)}`;
  const lines: string[] = [];
  lines.push(`# opencode billing reconciliation — ${r.runId}`);
  lines.push("");
  lines.push(`  logged by harness : ${usd(r.loggedUsd)}`);
  lines.push(`  actually invoiced : ${usd(r.invoicedUsd)}`);
  const ratio = r.loggedUsd === 0 ? NaN : r.invoicedUsd / r.loggedUsd;
  lines.push(`  understated by    : ${Number.isNaN(ratio) ? "n/a" : `${ratio.toFixed(2)}x`}`);
  lines.push("");
  lines.push(`  matched  ${r.matchedSessions} sessions / ${r.matchedRequests} billed requests`);
  lines.push(
    `  unmatched harness rows ${r.unmatchedRows}, of which ${r.unmatchedNullOutcomes} are harness_error` +
      (r.unmatchedRows === r.unmatchedNullOutcomes ? "  <- join is consistent" : "  <- INVESTIGATE"),
  );
  lines.push(`  feed sessions with no harness row: ${r.orphanSessions} (${usd(r.orphanUsd)}) — survey + preflight`);
  return lines.join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string, dflt: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 || !argv[i + 1] ? dflt : (argv[i + 1] as string);
  };
  const runId = flag("run", "phase6-harness-opencode-01");
  const feed = readFeed(flag("feed", DEFAULT_FEED));
  const rows = readFileSync(`${RUNS_DIR}/${runId}.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Row);
  const result = reconcile(rows, feed, runId);
  console.log(formatReconciliation(result));
}

if (import.meta.main) main();
