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
 *  - **`suiteVisibility`** (default `hidden`). The generated suite is written into
 *    the work directory only for the gate and removed again, so the model never
 *    sees the expected values and has to implement the algorithm rather than
 *    pattern-match a table. `--show-suite` leaves it in place, which is what an
 *    Exercism user sees. Neither is wrong; pooling them is.
 *
 *    Hiding the file does not hide everything: from round 1 the repair prompt
 *    quotes failing-case messages, and both arms' assertions name the expected
 *    value (`std/test`'s `expectEq` says `expected X, got Y`; `unittest`'s
 *    `assertEqual` the same). An Aven check failure also includes the compiler's
 *    plain-text diagnostic, which can quote a source line from the generated
 *    suite. Round 0 is clean; a repair round can leak the expected values of the
 *    cases that failed. `--rounds 0` is the only fully clean configuration, and
 *    that is a property of ordinary tool output, not of this module.
 *
 * The repair prompt is deliberately *just the tooling output*. No hints, no
 * restating of the task, no "you probably meant" — the rounds-to-green metric is
 * a measurement of the diagnostic, so anything added here is measured as if the
 * diagnostic had said it.
 */

import type { LangAdapter } from "../adapters/lang/index.ts";
import type { GateResult, SuiteVisibility, ToolPolicy } from "./schema.ts";

export type { SuiteVisibility };

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
  /**
   * Data files placed in the working directory for the task to read.
   *
   * Naming them matters as much as creating them. `grep`'s instructions describe
   * three text files and say the language track should make sure they exist; a
   * model that is not told they are already there goes looking for them, and the
   * observed behaviour was exactly that — `grep` had one of the highest
   * work-directory escape rates in the corpus.
   */
  fixtures?: string[];
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
      `3. \`${adapter.testFile}\` is not in this directory and you cannot see it: it is run against your` +
        ` solution after you finish. Work from the task statement below, and do not write a test file of your own.`,
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

  // Stated unconditionally, including under `no-verify` where the model cannot
  // run a shell: harnesses may still expose a fetch tool, and models have used
  // one. The reason is spelled out because a bare prohibition reads as
  // arbitrary, while "this invalidates the measurement" is a reason to comply.
  parts.push(
    [
      "5. Solve this yourself. Do not search the web, fetch URLs, or look up this exercise,",
      "   its tests, or an existing solution — on Exercism, GitHub or anywhere else.",
      "   This task is adapted from a public exercise, so the original tests and published",
      "   answers do exist online; retrieving them measures retrieval instead of the thing",
      "   under study, and the attempt is discarded.",
    ].join("\n"),
  );

  // Stated as fact and as already-satisfied, because the task statement below
  // will say these files "should be created" — and a model that reads that as an
  // instruction either writes them itself or goes hunting for them.
  if (inputs.fixtures && inputs.fixtures.length > 0) {
    const names = inputs.fixtures.map((f) => `\`${f}\``).join(", ");
    parts.push(
      `6. The data file(s) this task reads are already in the working directory: ${names}.` +
        ` They exist with the contents the task describes. Do not create or modify them.`,
    );
  }

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
const MAX_CASE_MESSAGE_CHARS = 400;

/**
 * The one line of a failing case worth showing.
 *
 * The two arms report failures in shapes that are not equally front-loaded.
 * `std/test` says it in one line — `expected "…", got "…"`. `unittest` hands back
 * a whole traceback whose *first* line is the useless `Traceback (most recent
 * call last):` and whose last line is the actual `AssertionError: 'x' != 'y'`.
 * Taking line 1 from both, as this did originally, gave Aven a real diagnostic
 * and Python the word "Traceback" — which would have made rounds-to-green
 * incomparable across the arms and flattered Aven's repair loop.
 *
 * Taking the last line of a traceback also keeps the quoted *suite source line*
 * out of the prompt, which matters under `suiteVisibility: "hidden"`.
 */
export function summarizeCaseMessage(message: string): string {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "(no message)";
  const first = lines[0]!;
  const line = first.startsWith("Traceback (most recent call last)") ? lines[lines.length - 1]! : first;
  return line.slice(0, MAX_CASE_MESSAGE_CHARS);
}

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
    const lines = shown.map((c) => `- **${c.name}** (${c.outcome}): ${summarizeCaseMessage(c.message)}`);
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

/**
 * The exit interview: one question, asked after the verdict is already recorded.
 *
 * Rationale, because this is experiment design and not a nicety. The ranked tails
 * say *where* Aven is much worse; they never say why. The model that just spent
 * four rounds fighting the checker is the only witness, and asking it is far
 * cheaper than inferring the cause from diagnostic-code frequencies.
 *
 * Four choices in the wording, each guarding a way this could produce garbage:
 *
 *  - **"already been scored"** — otherwise the answer is written to influence a
 *    grader, and what comes back is flattery or a plea rather than a complaint.
 *  - **One** change, in prose, capped. An unbounded "what would you improve"
 *    returns a tidy essay covering everything, which cannot be ranked. Forcing a
 *    single pick is what makes counting across attempts mean something.
 *  - **"nothing, this was straightforward" is offered explicitly.** A model asked
 *    for a criticism will invent one. Without a licensed null answer the easy
 *    tasks manufacture findings and swamp the real ones.
 *  - **Asked on the control arm too, identically.** A complaint about Aven only
 *    counts against the rate at which the same model complains about Python. That
 *    baseline is the whole reason this is worth recording rather than reading.
 *
 * The response is **untrusted model output**. It is stored as data and quoted in
 * analysis; nothing in the runner may act on its contents.
 */
export type SurveyInputs = {
  adapter: LangAdapter;
  /** Whether the solve loop ended green — the model is told, so it can be candid. */
  passed: boolean;
  /** Rounds the model actually used, for the same reason. */
  roundsUsed: number;
};

export const SURVEY_WORD_LIMIT = 150;

export function buildSurveyPrompt(inputs: SurveyInputs): string {
  const { adapter } = inputs;
  const verdict = inputs.passed
    ? "Your solution passed."
    : "Your solution did not pass, and there are no rounds left.";
  return (
    [
      `${verdict} The exercise is over and the result has already been recorded — nothing you write now changes it.`,
      "",
      "One last question, for language-design research rather than for scoring:",
      "",
      `**What is the single change to ${adapter.displayName} — either to the language itself, or to` +
        ` the documentation you were given — that would have made this task easier?**`,
      "",
      `Answer in prose, in at most ${SURVEY_WORD_LIMIT} words. Pick exactly one thing and be` +
        " concrete: name the construct, the error message, or the specific thing you looked for in" +
        " the documentation and could not find. Prefer whatever actually cost you time here over" +
        " what would be nice in general.",
      "",
      'If the honest answer is "nothing, this was straightforward", say that instead — it is a' +
        " useful answer and inventing a complaint is not.",
      "",
      "Do not create, edit or delete any files. Do not run any commands.",
    ].join("\n") + "\n"
  );
}
