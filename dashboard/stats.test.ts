/**
 * Counting traps for the dashboard: dedup keys and harness-error exclusion.
 * Fixtures only — never reads data/runs/.
 */

import { describe, expect, test } from "bun:test";

import {
  countExcludedByKind,
  dedupeAttempts,
  dedupeKey,
  deriveStatus,
  expectedTotal,
  roundsToGreenHist,
  scoredAttempts,
  sortSummaries,
  summarizeRun,
  type AttemptSlice,
  type RunSummary,
} from "./stats.ts";

function row(over: Partial<AttemptSlice> & Pick<AttemptSlice, "taskId">): AttemptSlice {
  return {
    runId: "t",
    language: "aven",
    modelId: "m",
    sampleIndex: 0,
    taskSet: "holdout",
    outcome: "pass",
    harnessErrorKind: null,
    firstShotPass: true,
    roundsToGreen: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    costUsd: null,
    avenCommit: "abc12345deadbeef",
    docId: "skill-v2",
    runNote: null,
    ...over,
  };
}

describe("dedupe by (taskId, language, modelId, sampleIndex)", () => {
  test("keeps latest finishedAt for the same key", () => {
    const rows = [
      row({
        taskId: "alphametics",
        outcome: "timeout",
        firstShotPass: false,
        roundsToGreen: null,
        finishedAt: "2026-01-01T00:01:00.000Z",
      }),
      row({
        taskId: "leap",
        outcome: "pass",
        finishedAt: "2026-01-01T00:02:00.000Z",
      }),
      row({
        taskId: "alphametics",
        outcome: "pass",
        firstShotPass: false,
        roundsToGreen: 2,
        finishedAt: "2026-01-01T00:05:00.000Z",
      }),
      // older retry must not win
      row({
        taskId: "alphametics",
        outcome: "check_error",
        firstShotPass: false,
        roundsToGreen: null,
        finishedAt: "2026-01-01T00:03:00.000Z",
      }),
    ];
    const d = dedupeAttempts(rows);
    expect(d).toHaveLength(2);
    const alpha = d.find((r) => r.taskId === "alphametics");
    expect(alpha?.outcome).toBe("pass");
    expect(alpha?.roundsToGreen).toBe(2);
    expect(alpha?.finishedAt).toBe("2026-01-01T00:05:00.000Z");
  });

  test("different sampleIndex or language are distinct keys", () => {
    const rows = [
      row({ taskId: "leap", language: "aven", sampleIndex: 0 }),
      row({ taskId: "leap", language: "python", sampleIndex: 0 }),
      row({ taskId: "leap", language: "aven", sampleIndex: 1 }),
    ];
    expect(new Set(rows.map(dedupeKey)).size).toBe(3);
    expect(dedupeAttempts(rows)).toHaveLength(3);
  });

  test("raw row count is not the done count when retries exist", () => {
    // Mirrors the holdout-05 shape: more rows than unique keys.
    const rows = [
      row({ taskId: "a", finishedAt: "2026-01-01T00:01:00.000Z", outcome: "timeout", firstShotPass: false, roundsToGreen: null }),
      row({ taskId: "a", finishedAt: "2026-01-01T00:02:00.000Z", outcome: "pass", roundsToGreen: 1, firstShotPass: false }),
      row({ taskId: "b", finishedAt: "2026-01-01T00:03:00.000Z" }),
      row({ taskId: "c", finishedAt: "2026-01-01T00:04:00.000Z" }),
    ];
    expect(rows).toHaveLength(4);
    expect(dedupeAttempts(rows)).toHaveLength(3);
  });
});

describe("harness_error exclusion from pass-rate denominator", () => {
  test("pass rate ignores harness_error and reports excluded count", () => {
    const rows = [
      row({ taskId: "a", outcome: "pass", firstShotPass: true, roundsToGreen: 0 }),
      row({ taskId: "b", outcome: "pass", firstShotPass: false, roundsToGreen: 1 }),
      row({
        taskId: "c",
        outcome: "wrong_output",
        firstShotPass: false,
        roundsToGreen: null,
      }),
      row({
        taskId: "d",
        outcome: "harness_error",
        harnessErrorKind: "agent-no-tokens",
        firstShotPass: false,
        roundsToGreen: null,
      }),
      row({
        taskId: "e",
        outcome: "harness_error",
        harnessErrorKind: "agent-timeout",
        firstShotPass: false,
        roundsToGreen: null,
      }),
    ];
    const deduped = dedupeAttempts(rows);
    const scored = scoredAttempts(deduped);
    expect(scored).toHaveLength(3); // a,b,c — not d,e
    const passes = scored.filter((r) => r.outcome === "pass");
    expect(passes).toHaveLength(2);
    // 2/3, not 2/5
    expect(passes.length / scored.length).toBeCloseTo(2 / 3);

    const byKind = countExcludedByKind(deduped);
    expect(byKind).toEqual({
      "agent-no-tokens": 1,
      "agent-timeout": 1,
    });

    const summary = summarizeRun(rows, {
      split: { tune: 72, holdout: 71 },
      mtimeMs: Date.parse("2026-01-01T00:10:00.000Z"),
      nowMs: Date.parse("2026-01-01T00:10:00.000Z"),
    });
    expect(summary.passRate).toBeCloseTo(2 / 3);
    expect(summary.excluded).toBe(2);
    expect(summary.excludedByKind["agent-no-tokens"]).toBe(1);
    expect(summary.excludedByKind["agent-timeout"]).toBe(1);
    expect(summary.scored).toBe(3);
    expect(summary.done).toBe(5);
    // Denominator must not be raw or deduped-all
    expect(summary.passRate).not.toBeCloseTo(2 / 5);
  });

  test("all harness_error → null pass rate, excluded still visible", () => {
    const rows = [
      row({
        taskId: "a",
        outcome: "harness_error",
        harnessErrorKind: "agent-failed",
        firstShotPass: false,
        roundsToGreen: null,
      }),
    ];
    const s = summarizeRun(rows, {
      split: { tune: 72, holdout: 71 },
      mtimeMs: 1,
      nowMs: 1,
    });
    expect(s.passRate).toBeNull();
    expect(s.excluded).toBe(1);
    expect(s.excludedByKind["agent-failed"]).toBe(1);
  });
});

describe("roundsToGreen histogram", () => {
  test("counts only passes", () => {
    const scored = [
      row({ taskId: "a", roundsToGreen: 0 }),
      row({ taskId: "b", roundsToGreen: 0 }),
      row({ taskId: "c", roundsToGreen: 1, firstShotPass: false }),
      row({
        taskId: "d",
        outcome: "timeout",
        roundsToGreen: null,
        firstShotPass: false,
      }),
    ];
    expect(roundsToGreenHist(scored)).toEqual({ "0": 2, "1": 1 });
  });
});

describe("expected total and liveness", () => {
  test("holdout × one cell → 71", () => {
    const rows = [row({ taskId: "leap", taskSet: "holdout" })];
    expect(expectedTotal(dedupeAttempts(rows), { tune: 72, holdout: 71 })).toBe(71);
  });

  test("two languages double the total", () => {
    const rows = [
      row({ taskId: "leap", language: "aven" }),
      row({ taskId: "leap", language: "python" }),
    ];
    expect(expectedTotal(dedupeAttempts(rows), { tune: 72, holdout: 71 })).toBe(142);
  });

  test("mixed task sets → null total", () => {
    const rows = [
      row({ taskId: "a", taskSet: "holdout" }),
      row({ taskId: "b", taskSet: "tune" }),
    ];
    expect(expectedTotal(dedupeAttempts(rows), { tune: 72, holdout: 71 })).toBeNull();
  });

  test("status: live / stalled / finished from mtime and total", () => {
    const stall = 60_000;
    const now = 1_000_000;
    expect(deriveStatus(71, 71, now - 10_000, now, stall)).toBe("finished");
    expect(deriveStatus(10, 71, now - 5_000, now, stall)).toBe("live");
    expect(deriveStatus(10, 71, now - 120_000, now, stall)).toBe("stalled");
    expect(deriveStatus(10, null, now - 120_000, now, stall)).toBe("finished");
  });

  test("sort is by start time newest first; status does not reorder", () => {
    const mk = (
      runId: string,
      status: RunSummary["status"],
      startedAt: string,
    ): RunSummary =>
      ({
        runId,
        models: [],
        languages: [],
        taskSets: [],
        avenCommits: [],
        docIds: [],
        done: 0,
        total: null,
        status,
        startedAt,
        elapsedMs: 0,
        lastActivityAt: startedAt,
        mtimeAt: startedAt,
        passRate: null,
        firstShotRate: null,
        scored: 0,
        passes: 0,
        firstShots: 0,
        excluded: 0,
        excludedByKind: {},
        roundsToGreen: {},
        nonPassing: [],
        costUsd: null,
        rawRows: 0,
        description: null,
        runNote: null,
      });
    // Live but older must not float above a finished newer run.
    const sorted = sortSummaries([
      mk("old-live", "live", "2026-01-01T00:00:00.000Z"),
      mk("new-finished", "finished", "2026-01-03T00:00:00.000Z"),
      mk("mid-stalled", "stalled", "2026-01-02T00:00:00.000Z"),
    ]);
    expect(sorted.map((r) => r.runId)).toEqual([
      "new-finished",
      "mid-stalled",
      "old-live",
    ]);
  });

  test("summarizeRun exposes startedAt as earliest attempt start", () => {
    const rows = [
      row({ taskId: "a", startedAt: "2026-01-02T12:00:00.000Z" }),
      row({ taskId: "b", startedAt: "2026-01-01T08:00:00.000Z" }),
    ];
    const s = summarizeRun(rows, {
      split: { tune: 72, holdout: 71 },
      mtimeMs: Date.parse("2026-01-02T13:00:00.000Z"),
      nowMs: Date.parse("2026-01-02T13:00:00.000Z"),
    });
    expect(s.startedAt).toBe("2026-01-01T08:00:00.000Z");
  });
});
