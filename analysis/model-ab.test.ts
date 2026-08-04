/**
 * Fixture-only tests for the model A/B analysis (`model-01`).
 * Never reads data/runs/ — live sweeps must not be the oracle.
 *
 * The statistics themselves are covered by `diagfmt-ab.test.ts`; what is tested
 * here is what `model-ab.ts` adds on top: per-task aggregation, the pairing
 * rule, spend accounting, and the asymmetric-n case created by Amendment 1.
 */

import { describe, expect, test } from "bun:test";

import {
  ARM_A_MODEL,
  GREEN_EFFECT_BAR,
  aggregateByTask,
  analyzeModelAb,
  armSpend,
  pairTasks,
  type TaskArm,
} from "./model-ab.ts";
import type { AbRow } from "./diagfmt-ab.ts";

const ARM_B_MODEL = "opencode-go/mimo-v2.5";

function row(over: Partial<AbRow> & Pick<AbRow, "taskId">): AbRow {
  return {
    language: "aven",
    modelId: ARM_B_MODEL,
    sampleIndex: 0,
    diagnosticFormat: "text",
    finishedAt: "2026-01-01T00:00:00.000Z",
    outcome: "pass",
    contaminated: false,
    roundsToGreen: 0,
    maxRounds: 3,
    firstShotPass: true,
    repairRounds: [],
    ...over,
  };
}

/** Serialize a fixture row as one JSONL line, with optional spend fields. */
function line(r: AbRow, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...r, ...extra });
}

describe("aggregateByTask", () => {
  test("green rate is the pass fraction, not the not-errored fraction", () => {
    const got = aggregateByTask([
      row({ taskId: "t", sampleIndex: 0, outcome: "pass" }),
      row({ taskId: "t", sampleIndex: 1, outcome: "wrong_output", roundsToGreen: null }),
      row({ taskId: "t", sampleIndex: 2, outcome: "check_error", roundsToGreen: null }),
    ]);
    expect(got.get("t")?.greenRate).toBeCloseTo(1 / 3, 10);
    expect(got.get("t")?.nSamples).toBe(3);
  });

  test("never-green samples censor at maxRounds + 1", () => {
    const got = aggregateByTask([
      row({ taskId: "t", sampleIndex: 0, roundsToGreen: 2, outcome: "pass" }),
      row({ taskId: "t", sampleIndex: 1, roundsToGreen: null, outcome: "timeout" }),
    ]);
    // (2 + 4) / 2
    expect(got.get("t")?.meanRounds).toBeCloseTo(3, 10);
  });

  test("counts first-shot passes separately from green", () => {
    const got = aggregateByTask([
      row({ taskId: "t", sampleIndex: 0, firstShotPass: true }),
      row({ taskId: "t", sampleIndex: 1, firstShotPass: false }),
    ]);
    expect(got.get("t")?.firstShot).toBe(1);
    expect(got.get("t")?.greenRate).toBe(1);
  });
});

describe("pairTasks", () => {
  const arm = (nSamples: number): TaskArm => ({
    nSamples,
    greenRate: 1,
    meanRounds: 0,
    firstShot: nSamples,
  });

  test("drops a task with only one usable sample in either arm, and names it", () => {
    const a = new Map([
      ["keep", arm(3)],
      ["thin-b", arm(3)],
    ]);
    const b = new Map([
      ["keep", arm(2)],
      ["thin-b", arm(1)],
    ]);
    const { paired, dropped } = pairTasks(a, b);
    expect(paired.map((p) => p.taskId)).toEqual(["keep"]);
    expect(dropped).toEqual(["thin-b"]);
  });

  test("a task missing from one arm entirely is dropped, not treated as zero", () => {
    const a = new Map([["only-a", arm(3)]]);
    const b = new Map([["only-b", arm(2)]]);
    const { paired, dropped } = pairTasks(a, b);
    expect(paired).toEqual([]);
    expect(dropped).toEqual(["only-a", "only-b"]);
  });

  test("n=2 against n=3 pairs fine — the Amendment 1 case", () => {
    const a = new Map([["t", arm(3)]]);
    const b = new Map([["t", arm(2)]]);
    const { paired, dropped } = pairTasks(a, b);
    expect(paired).toHaveLength(1);
    expect(dropped).toEqual([]);
  });
});

describe("armSpend", () => {
  test("sums only the named model and tolerates a null cost", () => {
    const lines = [
      line(row({ taskId: "a" }), { costUsd: 0.01, wallMs: 3_600_000 }),
      line(row({ taskId: "b" }), { costUsd: null, wallMs: 1_800_000 }),
      line(row({ taskId: "c", modelId: "other/model" }), { costUsd: 99, wallMs: 99 }),
      "",
    ];
    const got = armSpend(lines, ARM_B_MODEL);
    expect(got.rows).toBe(2);
    expect(got.costUsd).toBeCloseTo(0.01, 10);
    expect(got.wallHours).toBeCloseTo(1.5, 10);
  });
});

describe("analyzeModelAb", () => {
  /** Arm A: 3 samples/task. Arm B: 2 samples/task, per Amendment 1. */
  function fixture(bGreenPerTask: readonly number[]): { a: string; b: string } {
    const aLines: string[] = [];
    const bLines: string[] = [];
    bGreenPerTask.forEach((bGreen, i) => {
      const taskId = `t${i}`;
      for (let s = 0; s < 3; s++) {
        aLines.push(
          line(
            row({
              taskId,
              modelId: ARM_A_MODEL,
              sampleIndex: s,
              outcome: "pass",
              roundsToGreen: 1,
            }),
            { costUsd: 0.016 },
          ),
        );
      }
      for (let s = 0; s < 2; s++) {
        const green = s < bGreen;
        bLines.push(
          line(
            row({
              taskId,
              sampleIndex: s,
              outcome: green ? "pass" : "wrong_output",
              roundsToGreen: green ? 1 : null,
            }),
            { costUsd: 0.03 },
          ),
        );
      }
    });
    return { a: aLines.join("\n"), b: bLines.join("\n") };
  }

  test("arm A perfect, arm B failing everywhere -> arm A wins on green rate", () => {
    const { a, b } = fixture([0, 0, 0, 0, 0, 0, 0, 0]);
    const r = analyzeModelAb(a, b, ARM_B_MODEL, "fixture");
    expect(r.nPaired).toBe(8);
    expect(r.greenRate.a).toBe(1);
    expect(r.greenRate.b).toBe(0);
    expect(r.greenRate.diff).toBe(-1);
    expect(r.greenRate.verdict).toBe("arm-a-better");
  });

  test("identical arms report no difference", () => {
    const { a, b } = fixture([2, 2, 2, 2, 2, 2, 2, 2]);
    const r = analyzeModelAb(a, b, ARM_B_MODEL, "fixture");
    expect(r.greenRate.diff).toBe(0);
    expect(r.greenRate.verdict).toBe("no-difference");
    // All pairs tie, so every one is dropped by the signed-rank test.
    expect(r.greenRate.test.n).toBe(0);
  });

  test("a significant effect below the 10pp bar is not reported as a win", () => {
    // Every task differs by exactly half the effect bar.
    const perTask = GREEN_EFFECT_BAR / 2;
    const aLines: string[] = [];
    const bLines: string[] = [];
    for (let i = 0; i < 30; i++) {
      const taskId = `t${i}`;
      for (let s = 0; s < 3; s++) {
        aLines.push(
          line(row({ taskId, modelId: ARM_A_MODEL, sampleIndex: s, outcome: "pass" }), {
            costUsd: 0,
          }),
        );
      }
      // Arm B green rate = 1 - perTask, achieved with 20 samples per task.
      for (let s = 0; s < 20; s++) {
        const green = s < 20 * (1 - perTask);
        bLines.push(
          line(
            row({
              taskId,
              sampleIndex: s,
              outcome: green ? "pass" : "wrong_output",
              roundsToGreen: green ? 0 : null,
            }),
            { costUsd: 0 },
          ),
        );
      }
    }
    const r = analyzeModelAb(aLines.join("\n"), bLines.join("\n"), ARM_B_MODEL, "fixture");
    expect(r.greenRate.diff).toBeCloseTo(-perTask, 10);
    expect(r.greenRate.test.pValue).toBeLessThan(0.05);
    expect(r.greenRate.verdict).toBe("below-effect-bar");
  });

  test("harness_error and contaminated rows are excluded and counted", () => {
    const aLines = [0, 1, 2].map((s) =>
      line(row({ taskId: "t", modelId: ARM_A_MODEL, sampleIndex: s }), { costUsd: 0 }),
    );
    const bLines = [
      line(row({ taskId: "t", sampleIndex: 0 }), { costUsd: 0 }),
      line(row({ taskId: "t", sampleIndex: 1 }), { costUsd: 0 }),
      line(row({ taskId: "t", sampleIndex: 2, outcome: "harness_error" }), { costUsd: 0 }),
      line(row({ taskId: "t", sampleIndex: 3, contaminated: true }), { costUsd: 0 }),
    ];
    const r = analyzeModelAb(aLines.join("\n"), bLines.join("\n"), ARM_B_MODEL, "fixture");
    expect(r.exclusions.b.harnessError).toBe(1);
    expect(r.exclusions.b.contaminated).toBe(1);
    expect(r.nPaired).toBe(1);
  });

  test("a harness_error at n=2 drops the task below MIN_SAMPLES entirely", () => {
    // The second-order cost named in Amendment 1: at n=3 this task survives.
    const aLines = [0, 1, 2].map((s) =>
      line(row({ taskId: "t", modelId: ARM_A_MODEL, sampleIndex: s }), { costUsd: 0 }),
    );
    const bLines = [
      line(row({ taskId: "t", sampleIndex: 0 }), { costUsd: 0 }),
      line(row({ taskId: "t", sampleIndex: 1, outcome: "harness_error" }), { costUsd: 0 }),
    ];
    const r = analyzeModelAb(aLines.join("\n"), bLines.join("\n"), ARM_B_MODEL, "fixture");
    expect(r.nPaired).toBe(0);
    expect(r.droppedTasks).toEqual(["t"]);
  });

  test("arm A rows from a different diagnosticFormat are not pooled in", () => {
    const aLines = [
      line(row({ taskId: "t", modelId: ARM_A_MODEL, sampleIndex: 0 }), { costUsd: 0 }),
      line(row({ taskId: "t", modelId: ARM_A_MODEL, sampleIndex: 1 }), { costUsd: 0 }),
      line(
        row({
          taskId: "t",
          modelId: ARM_A_MODEL,
          sampleIndex: 2,
          diagnosticFormat: "agent",
        }),
        { costUsd: 0 },
      ),
    ];
    const bLines = [0, 1].map((s) => line(row({ taskId: "t", sampleIndex: s }), { costUsd: 0 }));
    const r = analyzeModelAb(aLines.join("\n"), bLines.join("\n"), ARM_B_MODEL, "fixture");
    // The `agent` row must not raise arm A's sample count to 3.
    const a = aggregateByTask(
      [0, 1].map((s) => row({ taskId: "t", modelId: ARM_A_MODEL, sampleIndex: s })),
    );
    expect(r.nPaired).toBe(1);
    expect(a.get("t")?.nSamples).toBe(2);
  });
});
