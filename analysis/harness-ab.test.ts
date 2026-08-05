/**
 * Fixture-only tests for the harness A/B analysis (`harness-01`).
 * Never reads data/runs/ — live sweeps must not be the oracle.
 *
 * The statistics are covered by `diagfmt-ab.test.ts` and the pairing rule by
 * `model-ab.test.ts`. What is tested here is what this round adds: two arms
 * carrying *different* modelId strings for the same model, the honest handling
 * of a subscription harness that reports no cost, and the effort-mismatch guard
 * the whole design rests on.
 */

import { describe, expect, test } from "bun:test";

import { analyzeHarnessAb, armEffort, formatHarnessReport } from "./harness-ab.ts";
import type { AbRow } from "./diagfmt-ab.ts";

const A = { run: "codex-run", model: "gpt-5.6-luna" };
const B = { run: "opencode-run", model: "opencode-go/gpt-5.6-luna" };

function row(over: Partial<AbRow> & Pick<AbRow, "taskId">): AbRow {
  return {
    language: "aven",
    modelId: A.model,
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

const line = (r: AbRow, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...r, ...extra });

/** Two samples per task in each arm, so nothing drops on MIN_SAMPLES. */
function arm(model: string, tasks: readonly string[], over: Partial<AbRow> = {}, extra = {}) {
  return tasks
    .flatMap((taskId) => [0, 1].map((sampleIndex) => row({ taskId, modelId: model, sampleIndex, ...over })))
    .map((r) => line(r, extra))
    .join("\n");
}

describe("arms with different modelId strings", () => {
  test("each arm is selected by its own model string and both pair up", () => {
    const r = analyzeHarnessAb(arm(A.model, ["t", "u"]), arm(B.model, ["t", "u"]), A, B);
    expect(r.nPaired).toBe(2);
    expect(r.droppedTasks).toEqual([]);
    expect(r.armA.model).toBe("gpt-5.6-luna");
    expect(r.armB.model).toBe("opencode-go/gpt-5.6-luna");
  });

  test("rows whose modelId belongs to the other arm are not pooled in", () => {
    // The opencode prefix must not be treated as the same model as the bare
    // name: if it were, each arm would absorb the other's rows.
    const contaminated = `${arm(A.model, ["t"])}\n${arm(B.model, ["t"])}`;
    const r = analyzeHarnessAb(contaminated, arm(B.model, ["t"]), A, B);
    expect(r.effort.a.rows).toBe(2);
  });
});

describe("cost on a subscription harness", () => {
  test("an arm reporting no cost stays null, never 0", () => {
    const e = armEffort(arm(A.model, ["t"], {}, { costUsd: null, promptTokens: 10, completionTokens: 5 }).split("\n"), A.model);
    expect(e.costUsd).toBeNull();
    expect(e.totalTokens).toBe(30);
  });

  test("an arm reporting real charges sums them", () => {
    const e = armEffort(arm(B.model, ["t"], {}, { costUsd: 0.25 }).split("\n"), B.model);
    expect(e.costUsd).toBeCloseTo(0.5, 10);
  });

  test("the report prints the subscription arm as n/a, not $0.00", () => {
    const text = formatHarnessReport(
      analyzeHarnessAb(
        arm(A.model, ["t"], {}, { costUsd: null }),
        arm(B.model, ["t"], {}, { costUsd: 0.25 }),
        A,
        B,
      ),
    );
    expect(text).toContain("n/a (subscription)");
    expect(text).not.toContain("cost $0.00");
  });
});

describe("effort matching", () => {
  test("matched efforts produce no warning", () => {
    const text = formatHarnessReport(
      analyzeHarnessAb(
        arm(A.model, ["t"], {}, { agentVariant: "high" }),
        arm(B.model, ["t"], {}, { agentVariant: "high" }),
        A,
        B,
      ),
    );
    expect(text).toContain("arm A high, arm B high");
    expect(text).not.toContain("EFFORT MISMATCH");
  });

  test("a mismatch is surfaced loudly rather than silently analysed", () => {
    // The design rests on the arms being pinned to the same effort. If they
    // are not, the comparison measures effort, not harness.
    const text = formatHarnessReport(
      analyzeHarnessAb(
        arm(A.model, ["t"], {}, { agentVariant: "high" }),
        arm(B.model, ["t"], {}, { agentVariant: "minimal" }),
        A,
        B,
      ),
    );
    expect(text).toContain("EFFORT MISMATCH");
  });

  test("an unpinned arm reads as 'default', not as a named level", () => {
    const r = analyzeHarnessAb(arm(A.model, ["t"]), arm(B.model, ["t"], {}, { agentVariant: "high" }), A, B);
    expect(r.variants.a).toBeNull();
    expect(formatHarnessReport(r)).toContain("arm A default, arm B high");
  });
});

describe("report rendering", () => {
  test("no field renders as undefined", () => {
    // Regression guard: the first draft read `test.tiesDropped`, which does not
    // exist on WilcoxonResult (it is `nDroppedZero`). Every assertion still
    // passed because nothing checked that substring — the report just printed
    // "ties dropped undefined". Only the typechecker caught it, so this pins
    // the whole class from the test side too.
    const text = formatHarnessReport(
      analyzeHarnessAb(
        arm(A.model, ["t", "u"], { outcome: "pass" }),
        arm(B.model, ["t", "u"], { outcome: "wrong_output", roundsToGreen: null, firstShotPass: false }),
        A,
        B,
      ),
    );
    expect(text).not.toContain("undefined");
    expect(text).toContain("ties dropped 0");
  });
});

describe("verdicts follow the pre-registered rule", () => {
  test("identical arms report no-difference, not below-effect-bar", () => {
    // wilcoxon returns NaN when every pair ties; NaN >= ALPHA is false, so the
    // NaN case must be caught before the significance test.
    const r = analyzeHarnessAb(arm(A.model, ["t", "u", "v"]), arm(B.model, ["t", "u", "v"]), A, B);
    expect(r.greenRate.verdict).toBe("no-difference");
    expect(r.censoredRounds.verdict).toBe("no-difference");
  });

  test("a harness_error is excluded and can drop a task below MIN_SAMPLES", () => {
    const aText = arm(A.model, ["t"]);
    const bText = [
      line(row({ taskId: "t", modelId: B.model, sampleIndex: 0 })),
      line(row({ taskId: "t", modelId: B.model, sampleIndex: 1, outcome: "harness_error" })),
    ].join("\n");
    const r = analyzeHarnessAb(aText, bText, A, B);
    expect(r.exclusions.b.harnessError).toBe(1);
    expect(r.nPaired).toBe(0);
    expect(r.droppedTasks).toEqual(["t"]);
  });
});
