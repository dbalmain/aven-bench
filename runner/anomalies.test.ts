import { describe, expect, test } from "bun:test";
import {
  policyAnomalyLines,
  sumModelToolInvocations,
  type PolicyAnomalyRow,
} from "./anomalies.ts";

function row(over: Partial<PolicyAnomalyRow> & Pick<PolicyAnomalyRow, "taskId">): PolicyAnomalyRow {
  return {
    language: "aven",
    sampleIndex: 0,
    toolPolicy: "no-verify",
    sandbox: "bubblewrap",
    shellCommands: 0,
    outsideWorkdirTouches: 0,
    repairRounds: [{ modelToolInvocations: 0 }],
    ...over,
  };
}

describe("sumModelToolInvocations", () => {
  test("sums rounds and treats null as zero", () => {
    expect(
      sumModelToolInvocations({
        repairRounds: [
          { modelToolInvocations: 2 },
          { modelToolInvocations: null },
          { modelToolInvocations: 1 },
        ],
      }),
    ).toBe(3);
  });
});

describe("policyAnomalyLines", () => {
  test("sandboxed shell with no aven invocations is not a !! violation", () => {
    const lines = policyAnomalyLines([
      row({ taskId: "camicia", shellCommands: 1, repairRounds: [{ modelToolInvocations: 0 }] }),
      row({
        taskId: "complex-numbers",
        shellCommands: 3,
        repairRounds: [{ modelToolInvocations: 0 }, { modelToolInvocations: 0 }],
      }),
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("2 sandboxed row(s) used the shell under no-verify");
    expect(joined).toContain("activity only, not a contamination flag");
    expect(joined).toContain("aven camicia s0: 1 command(s)");
    expect(joined).toContain("aven complex-numbers s0: 3 command(s)");
    // No loud bang on those lines.
    for (const line of lines) {
      if (line.includes("used the shell under no-verify")) {
        expect(line.startsWith("  !!")).toBe(false);
      }
    }
    expect(joined).not.toContain("invoked the aven toolchain");
  });

  test("modelToolInvocations > 0 under no-verify is a loud !! violation", () => {
    const lines = policyAnomalyLines([
      row({
        taskId: "leap",
        shellCommands: 2,
        repairRounds: [{ modelToolInvocations: 0 }, { modelToolInvocations: 3 }],
      }),
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("!! 1 row(s) invoked the aven toolchain under toolPolicy=no-verify");
    expect(joined).toContain("actual self-verification");
    expect(joined).toContain("aven leap s0: 3 invocation(s)");
    // Shell activity is absorbed into the toolchain warning; do not also list
    // the same row as quiet shell exploration.
    expect(joined).not.toContain("used the shell under no-verify");
  });

  test("unsandboxed shell under no-verify is loud even with zero aven invocations", () => {
    const lines = policyAnomalyLines([
      row({
        taskId: "hamming",
        sandbox: "none",
        shellCommands: 4,
        repairRounds: [{ modelToolInvocations: 0 }],
      }),
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("!! 1 unsandboxed row(s) ran shell commands under toolPolicy=no-verify");
    expect(joined).toContain("no filesystem containment");
    expect(joined).toContain("aven hamming s0: 4 command(s)");
  });

  test("sandboxed outside-workdir paths are quiet; unsandboxed are loud", () => {
    const lines = policyAnomalyLines([
      row({ taskId: "linked-list", outsideWorkdirTouches: 5 }),
      row({ taskId: "rest-api", sandbox: "none", outsideWorkdirTouches: 2 }),
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain(
      "!! 1 unsandboxed row(s) named paths outside their work directory",
    );
    expect(joined).toContain("access was not blocked");
    expect(joined).toContain(
      "1 sandboxed row(s) named paths outside their work directory",
    );
    expect(joined).toContain("sandbox denied access; not a contamination flag");
    for (const line of lines) {
      if (line.includes("sandbox denied access")) {
        expect(line.startsWith("  !!")).toBe(false);
      }
    }
  });

  test("self-verify rows with shell or aven use produce no no-verify warnings", () => {
    const lines = policyAnomalyLines([
      row({
        taskId: "grains",
        toolPolicy: "self-verify",
        shellCommands: 5,
        repairRounds: [{ modelToolInvocations: 4 }],
      }),
    ]);
    expect(lines.filter((l) => l.includes("no-verify"))).toEqual([]);
  });

  test("clean rows produce no policy lines", () => {
    expect(policyAnomalyLines([row({ taskId: "two-fer" })])).toEqual([]);
  });
});
