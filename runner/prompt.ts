/**
 * Prompt construction: the round-0 prompt and the repair prompt.
 *
 * Two decisions here are experiment design, not implementation detail, and both
 * are recorded in the attempt record so that runs made under different choices
 * are never silently pooled:
 *
 *  - **`toolPolicy`** (default `no-verify`). The model is told not to run the
 *    compiler or the suite. `firstShotPass` is supposed to measure the
 *    *documentation*; an agent that loops on the compiler measures the compiler.
 *    Compliance is not assumed: on the Aven arm every `aven` invocation the model
 *    makes lands in the session log with the agent-phase tag, so
 *    `modelToolInvocations` says how often the instruction was ignored.
 *  - **`suiteVisibility`** (default `visible`). The generated suite sits in the
 *    work directory and the model may read it, which is what an Exercism user
 *    sees. `--hide-suite` withholds it until the gate runs, which is a harder and
 *    cleaner test of the prompt+doc alone. Neither is wrong; pooling them is.
 *
 * The repair prompt is deliberately *just the tooling output*. No hints, no
 * restating of the task, no "you probably meant" — the rounds-to-green metric is
 * a measurement of the diagnostic, so anything added here is measured as if the
 * diagnostic had said it.
 */

import type { LangAdapter } from "../adapters/lang/index.ts";
import type { GateResult, ToolPolicy } from "./schema.ts";

export type SuiteVisibility = "visible" | "hidden";

export type PromptInputs = {
  adapter: LangAdapter;
  /** `corpus/<task>/prompt.md` plus the adapter's contract, as generated. */
  taskPrompt: string;
  /** Skill doc contents, when one was supplied. */
  doc: string | null;
  toolPolicy: ToolPolicy;
  suiteVisibility: SuiteVisibility;
  /** Human-readable form of the command that will judge the solution. */
  testCommandDisplay: string;
};

export function buildInitialPrompt(inputs: PromptInputs): string {
  const { adapter } = inputs;
  const parts: string[] = [];

  parts.push(
    [
      `You are writing a solution in ${adapter.displayName}.`,
      "",
      "Rules:",
      `1. Write exactly one file: \`${adapter.solutionFile}\`, in the working directory.`,
      `2. Do not create, edit or delete any other file. In particular, never touch \`${adapter.testFile}\`.`,
    ].join("\n"),
  );
  if (inputs.suiteVisibility === "visible") {
    parts.push(
      `3. \`${adapter.testFile}\` is present and shows exactly how your code will be called. Read it; do not modify it.`,
    );
  } else {
    parts.push(
      `3. The test suite is not in this directory. Work from the task statement below.`,
    );
  }
  parts.push(
    inputs.toolPolicy === "no-verify"
      ? [
          "4. Do not run any commands. Do not compile, do not run tests, do not use a shell.",
          `   Write \`${adapter.solutionFile}\` and stop. Your first version is what gets scored.`,
        ].join("\n")
      : [
          `4. You may run \`${inputs.testCommandDisplay}\` to check your work before finishing.`,
        ].join("\n"),
  );

  if (inputs.doc) {
    parts.push(
      `# Language reference\n\nThis is the reference for ${adapter.displayName}. It is the only documentation you have.\n\n${inputs.doc.trim()}`,
    );
  }

  parts.push(`# Task\n\n${inputs.taskPrompt.trim()}`);
  return `${parts.join("\n\n---\n\n")}\n`;
}

export type RepairInputs = {
  adapter: LangAdapter;
  round: number;
  gate: GateResult;
  /** Plain-text tool output — the rendering a human would read. */
  toolOutput: string;
  /** Whether the harness kept the conversation; a fresh session needs restating. */
  resumed: boolean;
  taskPrompt: string;
  doc: string | null;
  toolPolicy: ToolPolicy;
};

const MAX_CASES_IN_PROMPT = 12;
const MAX_TOOL_OUTPUT_CHARS = 8_000;

export function buildRepairPrompt(inputs: RepairInputs): string {
  const { adapter, gate } = inputs;
  const parts: string[] = [];

  if (!inputs.resumed) {
    // A harness with no session continuation has to be told the task again, or
    // the round measures "fix code you have never seen".
    parts.push(
      `You are fixing \`${adapter.solutionFile}\` in the working directory. It already exists — read it first.`,
    );
    if (inputs.doc) parts.push(`# Language reference\n\n${inputs.doc.trim()}`);
    parts.push(`# Task\n\n${inputs.taskPrompt.trim()}`);
  }

  const failing = gate.probes.filter((p) => p.gating && p.ok !== true).map((p) => p.name);
  parts.push(
    [
      `Your \`${adapter.solutionFile}\` was rejected.`,
      failing.length > 0 ? `Failing stage(s): ${failing.join(", ")}.` : "",
      gate.casesTotal > 0
        ? `Test cases: ${gate.casesPassed}/${gate.casesTotal} passed.`
        : "The suite did not run.",
    ]
      .filter(Boolean)
      .join(" "),
  );

  const output = inputs.toolOutput.trim();
  if (output !== "") {
    parts.push(`## Tool output\n\n\`\`\`\n${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\`\`\``);
  }

  if (gate.failedCases.length > 0) {
    const shown = gate.failedCases.slice(0, MAX_CASES_IN_PROMPT);
    const lines = shown.map((c) => `- **${c.name}** (${c.outcome}): ${c.message.split("\n")[0]}`);
    const more =
      gate.failedCases.length > shown.length
        ? `\n\n…and ${gate.failedCases.length - shown.length} more failing cases.`
        : "";
    parts.push(`## Failing cases\n\n${lines.join("\n")}${more}`);
  }

  parts.push(
    [
      `Fix \`${adapter.solutionFile}\`. Do not modify \`${adapter.testFile}\` or any other file.`,
      inputs.toolPolicy === "no-verify" ? "Do not run any commands." : "",
    ]
      .filter(Boolean)
      .join(" "),
  );

  return `${parts.join("\n\n")}\n`;
}
