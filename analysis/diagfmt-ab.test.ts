/**
 * Fixture-only tests for the diagnostic-format A/B analysis.
 * Never reads data/runs/ — live sweeps must not be the oracle.
 */

import { describe, expect, test } from "bun:test";

import {
  analyze,
  censoredDv,
  dedupeRows,
  excludeRows,
  parseJsonl,
  round0CheckFailed,
  wilcoxonSignedRank,
  type AbRow,
} from "./diagfmt-ab.ts";

function row(over: Partial<AbRow> & Pick<AbRow, "taskId">): AbRow {
  return {
    language: "aven",
    modelId: "m",
    sampleIndex: 0,
    diagnosticFormat: "text",
    finishedAt: "2026-01-01T00:00:00.000Z",
    outcome: "pass",
    contaminated: false,
    roundsToGreen: 0,
    maxRounds: 3,
    firstShotPass: true,
    repairRounds: [
      {
        round: 0,
        probes: [
          { name: "check", ok: true },
          { name: "test", ok: true },
        ],
      },
    ],
    ...over,
  };
}

describe("censoredDv", () => {
  test("green attempt uses roundsToGreen, including green-at-round-0", () => {
    expect(censoredDv({ roundsToGreen: 0, maxRounds: 3 })).toBe(0);
    expect(censoredDv({ roundsToGreen: 2, maxRounds: 3 })).toBe(2);
  });

  test("never-green uses the row's own maxRounds + 1 (not a literal 4)", () => {
    expect(censoredDv({ roundsToGreen: null, maxRounds: 3 })).toBe(4);
    expect(censoredDv({ roundsToGreen: null, maxRounds: 5 })).toBe(6);
    expect(censoredDv({ roundsToGreen: null, maxRounds: 1 })).toBe(2);
  });
});

describe("wilcoxonSignedRank — hand-worked tied |d|", () => {
  test("matches independent hand calculation (tie correction + continuity)", () => {
    // Differences (text − agent) for five paired task means:
    //   d = [1.5, 1.5, 2.0, −3.0, 0.5]
    //
    // Sorted |d| with average ranks for the tied 1.5s:
    //   |d|   0.5  1.5  1.5  2.0  3.0
    //   rank  1    2.5  2.5  4    5
    //
    // W+ = ranks of positive d: 2.5 + 2.5 + 4 + 1 = 10
    // W− = rank of −3.0: 5
    // n = 5, μ = n(n+1)/4 = 7.5
    // uncorrected σ² = n(n+1)(2n+1)/24 = 13.75
    // one tie group t=2: (t³−t)/48 = 6/48 = 0.125
    // σ² = 13.75 − 0.125 = 13.625
    // z_cont = (|10 − 7.5| − 0.5) / √13.625 = 2 / √13.625 ≈ 0.541828
    // p = 2(1−Φ(z_cont)) ≈ 0.5879
    //
    // Expected values recomputed with the same A&S erf used in production
    // (and cross-checked by hand for μ, σ², W+, W−). Not taken from scipy.
    const d = [1.5, 1.5, 2.0, -3.0, 0.5];
    const r = wilcoxonSignedRank(d);
    expect(r.n).toBe(5);
    expect(r.nDroppedZero).toBe(0);
    expect(r.wPlus).toBe(10);
    expect(r.wMinus).toBe(5);
    expect(r.z).toBeCloseTo(0.5418283691828771, 10);
    expect(r.pValue).toBeCloseTo(0.5879367000271201, 10);
    expect(r.method).toContain("tie correction");
    expect(r.method).toContain("continuity");
    expect(r.method).toContain("0 zero-difference");
  });

  test("drops zero differences and names the count in the method string", () => {
    // d = [2, −1, 0, 3, −2]
    // non-zero: 2, −1, 3, −2
    // |d| ranks: 1 → 1; 2,2 → 2.5 each; 3 → 4
    // W+ = 2.5(+2) + 4(+3) = 6.5
    // W− = 1(−1) + 2.5(−2) = 3.5
    // n=4, μ=5, tie t=2 → (8−2)/48=0.125
    // σ² = 4*5*9/24 − 0.125 = 7.5 − 0.125 = 7.375
    // z = (|6.5−5|−0.5)/√7.375 = 1/√7.375 ≈ 0.36823
    const r = wilcoxonSignedRank([2, -1, 0, 3, -2]);
    expect(r.n).toBe(4);
    expect(r.nDroppedZero).toBe(1);
    expect(r.wPlus).toBe(6.5);
    expect(r.wMinus).toBe(3.5);
    expect(r.z).toBeCloseTo(0.3682298471593294, 10);
    expect(r.method).toContain("1 zero-difference");
  });
});

describe("parseJsonl", () => {
  test("skips a truncated final line rather than throwing", () => {
    const good = row({
      taskId: "leap",
      roundsToGreen: 1,
      firstShotPass: false,
      finishedAt: "2026-01-01T00:01:00.000Z",
    });
    const text =
      JSON.stringify(good) +
      "\n" +
      '{"taskId":"alphametics","language":"aven","modelId":"m",' + // truncated mid-object
      "\n";
    const rows = parseJsonl(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskId).toBe("leap");
  });

  test("skips blank lines and fully-corrupt mid-file lines", () => {
    const a = row({ taskId: "a" });
    const b = row({ taskId: "b", sampleIndex: 1 });
    const text = [JSON.stringify(a), "NOT JSON", "", JSON.stringify(b)].join("\n");
    expect(parseJsonl(text).map((r) => r.taskId)).toEqual(["a", "b"]);
  });
});

describe("dedupe and exclusions", () => {
  test("dedupe keeps latest finishedAt per full natural key including diagnosticFormat", () => {
    const rows = [
      row({
        taskId: "leap",
        diagnosticFormat: "text",
        sampleIndex: 0,
        finishedAt: "2026-01-01T00:01:00.000Z",
        roundsToGreen: 2,
      }),
      row({
        taskId: "leap",
        diagnosticFormat: "text",
        sampleIndex: 0,
        finishedAt: "2026-01-01T00:05:00.000Z",
        roundsToGreen: 0,
      }),
      row({
        taskId: "leap",
        diagnosticFormat: "agent",
        sampleIndex: 0,
        finishedAt: "2026-01-01T00:03:00.000Z",
        roundsToGreen: 1,
      }),
    ];
    const d = dedupeRows(rows);
    expect(d).toHaveLength(2);
    const text = d.find((r) => r.diagnosticFormat === "text");
    expect(text?.roundsToGreen).toBe(0);
    expect(text?.finishedAt).toBe("2026-01-01T00:05:00.000Z");
  });

  test("excludes harness_error and contaminated and counts both", () => {
    const rows = [
      row({ taskId: "a", outcome: "pass" }),
      row({ taskId: "b", sampleIndex: 1, outcome: "harness_error", roundsToGreen: null }),
      row({
        taskId: "c",
        sampleIndex: 2,
        outcome: "pass",
        contaminated: true,
        roundsToGreen: 0,
      }),
      row({
        taskId: "d",
        sampleIndex: 3,
        outcome: "harness_error",
        contaminated: true,
        roundsToGreen: null,
      }),
    ];
    const { usable, excluded } = excludeRows(rows);
    // harness_error is excluded first; contaminated harness_error counts as harness only.
    expect(excluded.harnessError).toBe(2);
    expect(excluded.contaminated).toBe(1);
    expect(usable.map((r) => r.taskId)).toEqual(["a"]);
  });
});

describe("round0CheckFailed", () => {
  test("reads repairRounds[0] check probe, ok !== true", () => {
    expect(
      round0CheckFailed({
        repairRounds: [{ round: 0, probes: [{ name: "check", ok: false }] }],
      }),
    ).toBe(true);
    expect(
      round0CheckFailed({
        repairRounds: [{ round: 0, probes: [{ name: "check", ok: null }] }],
      }),
    ).toBe(true);
    expect(
      round0CheckFailed({
        repairRounds: [{ round: 0, probes: [{ name: "check", ok: true }] }],
      }),
    ).toBe(false);
    expect(
      round0CheckFailed({
        repairRounds: [{ round: 0, probes: [{ name: "test", ok: false }] }],
      }),
    ).toBe(false);
  });
});

describe("analyze — sample shortfall", () => {
  test("names tasks with fewer than 2 usable samples in either arm", () => {
    // Task "short": text has 3 samples, agent has 1 → dropped and named.
    // Task "ok": both arms have 2 samples → kept.
    const text: AbRow[] = [
      row({
        taskId: "short",
        diagnosticFormat: "text",
        sampleIndex: 0,
        roundsToGreen: 1,
        firstShotPass: false,
      }),
      row({
        taskId: "short",
        diagnosticFormat: "text",
        sampleIndex: 1,
        roundsToGreen: 1,
        firstShotPass: false,
      }),
      row({
        taskId: "short",
        diagnosticFormat: "text",
        sampleIndex: 2,
        roundsToGreen: 2,
        firstShotPass: false,
      }),
      row({
        taskId: "ok",
        diagnosticFormat: "text",
        sampleIndex: 0,
        roundsToGreen: 0,
        firstShotPass: true,
      }),
      row({
        taskId: "ok",
        diagnosticFormat: "text",
        sampleIndex: 1,
        roundsToGreen: 1,
        firstShotPass: false,
      }),
    ];
    const agent: AbRow[] = [
      row({
        taskId: "short",
        diagnosticFormat: "agent",
        sampleIndex: 0,
        roundsToGreen: 0,
        firstShotPass: true,
      }),
      // only one agent sample for "short"
      row({
        taskId: "ok",
        diagnosticFormat: "agent",
        sampleIndex: 0,
        roundsToGreen: 0,
        firstShotPass: true,
      }),
      row({
        taskId: "ok",
        diagnosticFormat: "agent",
        sampleIndex: 1,
        roundsToGreen: 0,
        firstShotPass: true,
      }),
    ];
    const report = analyze(text, agent);
    expect(report.droppedTasks).toContain("short");
    expect(report.droppedTasks).not.toContain("ok");
    expect(report.pairs.map((p) => p.taskId)).toEqual(["ok"]);
    expect(report.arms.text.nUsable).toBe(5);
    expect(report.arms.agent.nUsable).toBe(3);
  });

  test("exclusion counts are reported per arm", () => {
    const text = [
      row({ taskId: "a", diagnosticFormat: "text", sampleIndex: 0 }),
      row({
        taskId: "b",
        diagnosticFormat: "text",
        sampleIndex: 0,
        outcome: "harness_error",
        roundsToGreen: null,
        firstShotPass: false,
      }),
    ];
    const agent = [
      row({ taskId: "a", diagnosticFormat: "agent", sampleIndex: 0 }),
      row({
        taskId: "c",
        diagnosticFormat: "agent",
        sampleIndex: 0,
        contaminated: true,
      }),
    ];
    const report = analyze(text, agent);
    expect(report.arms.text.excludedHarnessError).toBe(1);
    expect(report.arms.text.excludedContaminated).toBe(0);
    expect(report.arms.agent.excludedHarnessError).toBe(0);
    expect(report.arms.agent.excludedContaminated).toBe(1);
  });
});
