/**
 * Fixture-only tests for the billing reconciliation. Never reads data/runs/.
 *
 * The point of this join is that it is self-checking: if the session-ref mapping
 * were wrong, unmatched harness rows would not line up with the rows that never
 * reached a model. These tests pin that property, because it is the only reason
 * to trust the corrected cost figures at all.
 */

import { describe, expect, test } from "bun:test";

import { COST_UNIT_USD, formatReconciliation, reconcile, type FeedRecord } from "./opencode-billing.ts";

const feedRow = (over: Partial<FeedRecord> & Pick<FeedRecord, "sessionId" | "costUnits">): FeedRecord => ({
  id: `usg_${Math.random().toString(36).slice(2)}`,
  t: "2026-08-05T10:00:00.000Z",
  model: "gpt-5.6-luna",
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  ...over,
});

const row = (taskId: string, sampleIndex: number, ref: string | null, costUsd: number | null, outcome = "pass") => ({
  taskId,
  sampleIndex,
  agentSessionRef: ref,
  costUsd,
  outcome,
  finishedAt: "2026-08-05T10:00:00.000Z",
});

describe("session join", () => {
  test("sums every billed request belonging to a matched session", () => {
    const feed = [
      feedRow({ sessionId: "ses_a", costUnits: 100_000 }),
      feedRow({ sessionId: "ses_a", costUnits: 25_000 }),
      feedRow({ sessionId: "ses_b", costUnits: 50_000 }),
    ];
    const r = reconcile([row("t", 0, "ses_a", 0.0005), row("u", 0, "ses_b", 0.00025)], feed, "run");
    expect(r.matchedSessions).toBe(2);
    expect(r.matchedRequests).toBe(3);
    expect(r.invoicedUsd).toBeCloseTo(175_000 * COST_UNIT_USD, 10);
    expect(r.perAttempt.get("t|0")?.requests).toBe(2);
  });

  test("a row that never reached a model has no billing session, and that is the consistency check", () => {
    const feed = [feedRow({ sessionId: "ses_a", costUnits: 100_000 })];
    const r = reconcile([row("t", 0, "ses_a", 0.001), row("u", 1, "ses_gone", null, "harness_error")], feed, "run");
    expect(r.unmatchedRows).toBe(1);
    expect(r.unmatchedNullOutcomes).toBe(1);
    expect(formatReconciliation(r)).toContain("join is consistent");
  });

  test("an unmatched row that DID produce an outcome is flagged, not absorbed", () => {
    // This is the failure mode that would invalidate the reconciliation: a real
    // attempt whose spend we cannot locate. It must be loud.
    const r = reconcile([row("t", 0, "ses_missing", 0.001, "pass")], [], "run");
    expect(r.unmatchedRows).toBe(1);
    expect(r.unmatchedNullOutcomes).toBe(0);
    expect(formatReconciliation(r)).toContain("INVESTIGATE");
  });

  test("feed sessions with no harness row are reported separately, never folded into the run", () => {
    const feed = [feedRow({ sessionId: "ses_a", costUnits: 100_000 }), feedRow({ sessionId: "ses_survey", costUnits: 7_000 })];
    const r = reconcile([row("t", 0, "ses_a", 0.001)], feed, "run");
    expect(r.orphanSessions).toBe(1);
    expect(r.orphanUsd).toBeCloseTo(7_000 * COST_UNIT_USD, 10);
    expect(r.invoicedUsd).toBeCloseTo(100_000 * COST_UNIT_USD, 10);
  });

  test("another round's sessions are not charged to this run", () => {
    // The feed spans every round the account billed. Without a window guard the
    // first draft reported 316 orphan sessions for a run that had four, silently
    // attributing other sweeps' spend to this one.
    const feed = [
      feedRow({ sessionId: "ses_a", costUnits: 100_000, t: "2026-08-05T10:00:00.000Z" }),
      feedRow({ sessionId: "ses_other_round", costUnits: 999_000, t: "2026-08-04T02:00:00.000Z" }),
    ];
    const r = reconcile([row("t", 0, "ses_a", 0.001)], feed, "run");
    expect(r.orphanSessions).toBe(0);
    expect(r.orphanUsd).toBe(0);
  });
});

describe("reporting", () => {
  test("the understatement ratio is stated, and nothing renders as undefined", () => {
    const feed = [feedRow({ sessionId: "ses_a", costUnits: 300_000 })];
    const text = formatReconciliation(reconcile([row("t", 0, "ses_a", 0.001)], feed, "run"));
    expect(text).toContain("3.00x");
    expect(text).not.toContain("undefined");
  });

  test("a run that logged nothing reports n/a rather than Infinity", () => {
    const feed = [feedRow({ sessionId: "ses_a", costUnits: 300_000 })];
    const text = formatReconciliation(reconcile([row("t", 0, "ses_a", null)], feed, "run"));
    expect(text).toContain("n/a");
    expect(text).not.toContain("Infinity");
  });
});
