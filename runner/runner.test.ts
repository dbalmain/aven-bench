/**
 * Unit tests for the runner's pure parts: the bits that decide what a row says.
 *
 * Everything here runs without a network, a model or a compiler. The things that
 * genuinely need those (an end-to-end attempt) are exercised by an actual run —
 * see the acceptance recipe in `runner/README.md`; a runner nobody ran is
 * worthless, and a test that mocks the model would prove nothing about it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEvents } from "../adapters/agent/opencode.ts";
import { AGENTS, agentFor, emptyResult, type AgentAdapter } from "../adapters/agent/index.ts";
import { adapterFor } from "../adapters/lang/index.ts";
import {
  classifyOutcome,
  extractCodes,
  firstMeaningfulLine,
  mypyCode,
  offsetToLineCol,
  parseAvenCheck,
  probeMirrors,
} from "./gate.ts";
import { computeShadowCost, resetPriceTableCache, type PriceTable } from "./prices.ts";
import { runProcess, Semaphore } from "./proc.ts";
import { buildInitialPrompt, buildRepairPrompt, buildSurveyPrompt, summarizeCaseMessage } from "./prompt.ts";
import { enclosingRepo, parseArgv } from "./run.ts";
import { bubblewrapCommand, sandboxAvailability } from "./sandbox.ts";
import { DEFAULT_WORK_ROOT, isInside, runAttempt, type RunContext } from "./attempt.ts";
import { REPO_ROOT } from "../ingest/paths.ts";
import {
  attemptKey,
  SCHEMA_VERSION,
  type AttemptRecord,
  type GateProbe,
  type GateResult,
  type Outcome,
} from "./schema.ts";
import { appendRecord, isDone, loadResumeIndex, putArtifact, sha256 } from "./store.ts";
import { approxTokens, countLoc } from "./tokens.ts";
import { GATE_TAG_MARKER, gateTag, modelInvocations, type SessionRecord } from "./session.ts";

// --- fixtures --------------------------------------------------------------

function probe(over: Partial<GateProbe> = {}): GateProbe {
  return {
    name: "test",
    gating: true,
    ok: true,
    exitCode: 0,
    wallMs: 1,
    timedOut: false,
    diagnosticCodes: [],
    diagnostics: [],
    detail: null,
    unavailableReason: null,
    toolVersion: null,
    ...over,
  };
}

function record(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: "r",
    attemptId: "a",
    runnerVersion: "test",
    startedAt: "now",
    finishedAt: "now",
    taskId: "two-fer",
    taskSource: "exercism",
    taskSet: "tune",
    casesOmitted: 0,
    casesExcludedByIntersect: 0,
    language: "python",
    languageVersion: "Python 3",
    avenCommit: null,
    avenBinarySha256: null,
    docId: null,
    docHash: null,
    docTokens: null,
    modelId: "opencode/deepseek-v4-flash-free",
    provider: "opencode",
    quantization: null,
    agentHarness: "opencode",
    harnessVersion: "1.18.4",
    agentSessionRef: null,
    sampleIndex: 0,
    temperature: null,
    seed: null,
    toolPolicy: "no-verify",
    suiteVisibility: "hidden",
    sandbox: "bubblewrap",
    maxRounds: 2,
    roundsUsed: 1,
    repairRounds: [],
    outcome: "pass",
    outcomeDetail: null,
    harnessError: null,
    timedOut: false,
    firstShotPass: true,
    roundsToGreen: 0,
    casesPassed: 3,
    casesTotal: 3,
    probes: [],
    checkOk: null,
    checkOkSolutionOnly: null,
    testOk: true,
    mypyOk: null,
    promptTokens: 10,
    completionTokens: 5,
    cachedPromptTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    priceSource: "harness",
    priceTableVersion: "test",
    shadowCostUsd: 0,
    shadowPriceSource: "free",
    reportedCostUsd: 0,
    harnessSessionCostUsd: null,
    harnessSessionTokens: null,
    surveyed: false,
    surveyResponse: null,
    surveyResponseHash: null,
    surveyPromptTokens: 0,
    surveyCompletionTokens: 0,
    surveyCostUsd: null,
    surveyWallMs: 0,
    surveyError: null,
    wallMs: 1,
    agentWallMs: 1,
    gateWallMs: 0,
    tokensPerSec: null,
    solutionBytes: 1,
    solutionLoc: 1,
    solutionTokens: 1,
    tokenEstimator: "heuristic-v1",
    artifactHash: null,
    promptHash: "p",
    suiteHash: "s",
    sessionLogHash: null,
    workDir: "/tmp/aven-bench-work/x",
    outsideWorkdirTouches: 0,
    shellCommands: 0,
    ...over,
  };
}

function gate(over: Partial<GateResult> = {}): GateResult {
  return {
    ok: false,
    probes: [probe({ ok: false })],
    casesTotal: 3,
    casesPassed: 1,
    casesFailed: 2,
    casesErrored: 0,
    failedCases: [{ name: "a name given", outcome: "fail", message: 'expected "x", got "y"' }],
    outcome: "wrong_output",
    detail: "expected x",
    ...over,
  };
}

// --- token estimation ------------------------------------------------------

describe("token estimation", () => {
  test("is deterministic, monotone in length, and charges long identifiers more than one token", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("x = 1")).toBe(3);
    expect(approxTokens("aVeryLongIdentifierName")).toBeGreaterThan(1);
    const short = approxTokens("twoFer(name)");
    expect(approxTokens("twoFer(name)\ntwoFer(name)")).toBeGreaterThan(short);
  });

  test("LOC skips blanks and comment-only lines", () => {
    expect(countLoc("# a comment\n\nx = 1\n  # indented comment\ny = 2\n")).toBe(2);
  });
});

// --- price table -----------------------------------------------------------

describe("shadow cost", () => {
  const table: PriceTable = {
    version: "test",
    models: {
      "free/model": { in: 0, out: 0 },
      "paid/model": { in: 1, out: 10, cacheReadIn: 0.1, cacheWriteIn: 1.25 },
    },
  };
  const zero = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, cachedWriteTokens: 0 };

  test.each([
    ["free/model", { ...zero, promptTokens: 1_000_000, completionTokens: 1_000_000 }, 0, "free"],
    ["paid/model", { ...zero, promptTokens: 1_000_000, completionTokens: 100_000 }, 2, "table"],
    ["paid/model", { ...zero, cachedPromptTokens: 1_000_000 }, 0.1, "table"],
    ["paid/model", { ...zero, cachedWriteTokens: 1_000_000 }, 1.25, "table"],
  ] as const)("%s prices each token category at its own rate", (model, tokens, expected, source) => {
    const cost = computeShadowCost(model, tokens, table);
    expect(cost.shadowCostUsd).toBeCloseTo(expected, 9);
    expect(cost.shadowPriceSource).toBe(source);
  });

  /**
   * The regression that motivated schema 4. A real qwen3.7-max turn billed
   * $0.02788375 on 6 input, 20 output and 8 870 cache-write tokens. Before cache
   * writes were priced, the dominant term was silently dropped.
   */
  test("cache writes dominate a real paid turn and must not be dropped", () => {
    const measured = { promptTokens: 6, completionTokens: 20, cachedPromptTokens: 0, cachedWriteTokens: 8_870 };
    const withWrites = computeShadowCost("paid/model", measured, table).shadowCostUsd ?? 0;
    const withoutWrites = computeShadowCost(
      "paid/model",
      { ...measured, cachedWriteTokens: 0 },
      table,
    ).shadowCostUsd ?? 0;
    expect(withWrites).toBeGreaterThan(withoutWrites * 20);
  });

  test("a model with no entry records null, never a fabricated zero", () => {
    const cost = computeShadowCost("mystery/model", { ...zero, promptTokens: 99, completionTokens: 99 }, table);
    expect(cost.shadowCostUsd).toBeNull();
    expect(cost.shadowPriceSource).toBe("unknown");
  });

  test("the built-in table prices every free opencode model at zero", () => {
    resetPriceTableCache();
    for (const model of [
      "opencode/deepseek-v4-flash-free",
      "opencode/laguna-s-2.1-free",
      "opencode/ling-3.0-flash-free",
      "opencode/mimo-v2.5-free",
      "opencode/nemotron-3-ultra-free",
      "opencode/north-mini-code-free",
      "opencode/big-pickle",
    ]) {
      const cost = computeShadowCost(model, {
        promptTokens: 5_000,
        completionTokens: 500,
        cachedPromptTokens: 100,
        cachedWriteTokens: 100,
      });
      expect(cost.shadowCostUsd).toBe(0);
      expect(cost.shadowPriceSource).toBe("free");
    }
  });
});

// --- opencode event parsing ------------------------------------------------

describe("opencode --format json", () => {
  // Trimmed from a real run: two step_finish events, one text part, one tool use.
  const stream = [
    JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }),
    JSON.stringify({ type: "tool_use", sessionID: "ses_1", part: { type: "tool", tool: "write" } }),
    JSON.stringify({
      type: "step_finish",
      sessionID: "ses_1",
      part: { type: "step-finish", tokens: { input: 8993, output: 124, reasoning: 27, cache: { read: 0, write: 0 } }, cost: 0 },
    }),
    "not json at all",
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "Done." } }),
    JSON.stringify({
      type: "step_finish",
      sessionID: "ses_1",
      part: { type: "step-finish", tokens: { input: 72, output: 3, reasoning: 8, cache: { read: 9088, write: 0 } }, cost: 0 },
    }),
  ].join("\n");

  test("sums tokens across steps and keeps cache reads separate", () => {
    const usage = parseEvents(stream);
    expect(usage.promptTokens).toBe(8993 + 72);
    expect(usage.completionTokens).toBe(124 + 3);
    expect(usage.cachedPromptTokens).toBe(9088);
    expect(usage.reasoningTokens).toBe(35);
    expect(usage.reportedCostUsd).toBe(0);
    expect(usage.sessionRef).toBe("ses_1");
    expect(usage.assistantText).toBe("Done.\n");
    expect(usage.errors).toEqual([]);
  });

  /**
   * Verbatim from a paid `opencode-go/qwen3.7-max` session: two turns whose costs
   * are deltas summing to the $0.03271125 the harness reported for the session, on
   * a token shape where cache writes dwarf everything else. Both properties are
   * load-bearing — rounds are summed, and cache writes are what get billed.
   */
  test("real paid turns: costs are summable deltas and cache writes are kept", () => {
    const paid = [
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_062029af3ffeZ664qMnv6qe5S7",
        part: {
          type: "step-finish",
          tokens: { total: 8896, input: 6, output: 20, reasoning: 0, cache: { write: 8870, read: 0 } },
          cost: 0.02788375,
        },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_062029af3ffeZ664qMnv6qe5S7",
        part: {
          type: "step-finish",
          tokens: { total: 8952, input: 6, output: 42, reasoning: 0, cache: { write: 20, read: 8870 } },
          cost: 0.0048275,
        },
      }),
    ].join("\n");
    const usage = parseEvents(paid);
    expect(usage.cachedWriteTokens).toBe(8890);
    expect(usage.cachedPromptTokens).toBe(8870);
    expect(usage.reportedCostUsd).toBeCloseTo(0.03271125, 9);
    // The charge is not explainable from input+output alone; that is the whole point.
    expect(usage.promptTokens + usage.completionTokens).toBe(74);
  });

  test("tool paths are collected, which is how work-directory escapes are caught", () => {
    const usage = parseEvents(
      [
        JSON.stringify({
          type: "tool_use",
          part: { type: "tool", tool: "read", state: { input: { filePath: "/w/s0/solution.av" } } },
        }),
        JSON.stringify({
          type: "tool_use",
          part: { type: "tool", tool: "glob", state: { input: { path: "/home/dave/w/clex/aven-bench" } } },
        }),
        JSON.stringify({
          type: "tool_use",
          part: { type: "tool", tool: "read", state: { input: { filePath: "/w/s0/solution.av" } } },
        }),
      ].join("\n"),
    );
    expect(usage.touchedPaths).toEqual(["/w/s0/solution.av", "/home/dave/w/clex/aven-bench"]);
  });

  test("shell commands are counted and their absolute path arguments are sampled", () => {
    const usage = parseEvents(
      [
        JSON.stringify({
          type: "tool_use",
          part: {
            type: "tool",
            tool: "bash",
            state: { input: { command: "find /home/dave/w/clex -name '*.av'" } },
          },
        }),
        JSON.stringify({
          type: "tool_use",
          part: {
            type: "tool",
            tool: "bash",
            state: { input: { command: "cat ../../references/two-fer/solution.av" } },
          },
        }),
      ].join("\n"),
    );
    expect(usage.shellCommands).toBe(2);
    // Relative shell paths cannot be classified from the event alone. The
    // command count still records that the structured path accounting is blind.
    expect(usage.touchedPaths).toEqual(["/home/dave/w/clex"]);
  });

  test("an error event is surfaced, which is how a bad model id is caught", () => {
    const usage = parseEvents(
      JSON.stringify({
        type: "error",
        sessionID: "ses_2",
        error: { name: "UnknownError", data: { message: "Unexpected server error." } },
      }),
    );
    expect(usage.errors).toEqual(["Unexpected server error."]);
    expect(usage.reportedCostUsd).toBeNull();
  });
});

// --- aven check parsing ----------------------------------------------------

describe("aven check --format json", () => {
  const source = "x = 1\ny: Int = \"s\"\n";
  const diagnostic = {
    code: "type.mismatch",
    severity: "error",
    message: "expected `Int`, found a text literal",
    labels: [{ message: "this is a text literal", span: { start: 15, end: 18 } }],
  };

  test("reads the single-file shape", () => {
    const parsed = parseAvenCheck(
      JSON.stringify({ ok: false, path: "/w/solution.av", diagnostics: [diagnostic] }),
      new Map([["/w/solution.av", source]]),
    );
    expect(parsed?.ok).toBe(false);
    expect(parsed?.diagnostics[0]).toMatchObject({ code: "type.mismatch", path: "solution.av", line: 2 });
  });

  test("reads the multi-file shape imports produce", () => {
    const parsed = parseAvenCheck(
      JSON.stringify({
        ok: false,
        files: [
          { path: "/w/solution_test.av", diagnostics: [] },
          { path: "/w/solution.av", diagnostics: [diagnostic] },
        ],
      }),
      new Map([["/w/solution.av", source]]),
    );
    expect(parsed?.diagnostics).toHaveLength(1);
    expect(parsed?.diagnostics[0]?.path).toBe("solution.av");
  });

  test("non-JSON output is a null parse, not a crash", () => {
    expect(parseAvenCheck("error: unrecognized subcommand 'check'", new Map())).toBeNull();
  });

  test("offsets map to 1-based line and column", () => {
    expect(offsetToLineCol("ab\ncd\n", 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToLineCol("ab\ncd\n", 4)).toEqual({ line: 2, column: 2 });
  });

  test("codes are scraped from text output when JSON is unavailable", () => {
    expect(extractCodes("[parse.expected-expression] Error: …\n[type.mismatch] Error: …\n[type.mismatch] again")).toEqual([
      "parse.expected-expression",
      "type.mismatch",
    ]);
  });

  test("firstMeaningfulLine skips JSON punctuation", () => {
    expect(firstMeaningfulLine('{\n  "ok": false\n}\nError: check failed')).toBe("Error: check failed");
    // `],` was what a load error's detail actually said before this was fixed.
    expect(firstMeaningfulLine('  "cases": [\n  ],\n[parse.unsupported-syntax] Error: nope')).toBe(
      "[parse.unsupported-syntax] Error: nope",
    );
  });
});

// --- outcome classification ------------------------------------------------

describe("outcome classification", () => {
  const cases: [string, GateProbe[], { failed?: number; errored?: number } | null, Outcome][] = [
    ["all gating probes green", [probe({ name: "check" }), probe()], { failed: 0 }, "pass"],
    [
      "a non-gating probe cannot fail the attempt",
      [probe(), probe({ name: "mypy", gating: false, ok: false })],
      { failed: 0 },
      "pass",
    ],
    [
      "check rejects with a parse code",
      [probe({ name: "check", ok: false, diagnosticCodes: ["parse.expected-expression"] }), probe({ ok: false, exitCode: 1 })],
      { failed: 1 },
      "parse_error",
    ],
    [
      "check rejects with a type code",
      [probe({ name: "check", ok: false, diagnosticCodes: ["type.mismatch"] }), probe({ ok: false, exitCode: 1 })],
      { failed: 1 },
      "check_error",
    ],
    [
      "the suite never loaded",
      [probe({ name: "check", ok: true }), probe({ ok: false, exitCode: 2, diagnosticCodes: ["eval.type-error"] })],
      null,
      "check_error",
    ],
    ["a case raised", [probe({ ok: false, exitCode: 1 })], { errored: 1 }, "runtime_error"],
    ["a case asserted", [probe({ ok: false, exitCode: 1 })], { failed: 2 }, "wrong_output"],
    ["a tool timed out", [probe({ ok: false, timedOut: true })], null, "timeout"],
    ["a tool was missing", [probe({ ok: null, unavailableReason: "no binary" })], null, "harness_error"],
  ];

  test.each(cases)("%s -> %s", (_name, probes, envelope, expected) => {
    expect(classifyOutcome(probes, envelope, [])).toBe(expected);
  });

  test("runtime errors beat wrong output when both are present", () => {
    expect(classifyOutcome([probe({ ok: false, exitCode: 1 })], { failed: 1, errored: 1 }, [])).toBe("runtime_error");
  });
});

describe("probe mirrors", () => {
  const suiteError = { code: "module.uppercase-export-not-type", severity: "error", message: "…", path: "solution_test.av", line: 4, column: 3 };
  const solutionError = { code: "type.mismatch", severity: "error", message: "…", path: "solution.av", line: 2, column: 1 };

  test("a check that failed only on the generated suite is flagged as not the solution's fault", () => {
    const m = probeMirrors([probe({ name: "check", ok: false, diagnostics: [suiteError] }), probe()], "solution.av");
    expect(m.checkOk).toBe(false);
    expect(m.checkOkSolutionOnly).toBe(true);
    expect(m.testOk).toBe(true);
  });

  test("a check that failed on the solution is the solution's fault", () => {
    const m = probeMirrors([probe({ name: "check", ok: false, diagnostics: [suiteError, solutionError] })], "solution.av");
    expect(m.checkOkSolutionOnly).toBe(false);
  });

  test("probes that did not run mirror as null, not false", () => {
    const m = probeMirrors([probe()], "solution.av");
    expect(m.checkOk).toBeNull();
    expect(m.mypyOk).toBeNull();
    expect(m.testOk).toBe(true);
  });
});

// --- prompts ---------------------------------------------------------------

describe("prompts", () => {
  const adapter = adapterFor("aven");
  const base = {
    adapter,
    taskPrompt: "Return one for you and one for me.",
    doc: "Aven in one line.",
    toolPolicy: "no-verify" as const,
    suiteVisibility: "hidden" as const,
    testCommandDisplay: "aven test --format json solution_test.av",
  };

  test("no-verify tells the model not to run anything and names the one file to write", () => {
    const p = buildInitialPrompt(base);
    expect(p).toContain("Do not run any commands");
    expect(p).toContain("solution.av");
    expect(p).toContain("Aven in one line.");
  });

  test("the default hides the suite and says so", () => {
    const p = buildInitialPrompt(base);
    expect(p).toContain("is not in this directory and you cannot see it");
    expect(p).not.toContain("Read it; do not modify it.");
  });

  test("self-verify offers the real test command instead", () => {
    const p = buildInitialPrompt({ ...base, toolPolicy: "self-verify" });
    expect(p).toContain("aven test --format json solution_test.av");
    expect(p).not.toContain("Do not run any commands");
  });

  test("--show-suite invites the model to read it", () => {
    const p = buildInitialPrompt({ ...base, suiteVisibility: "visible" });
    expect(p).toContain("Read it; do not modify it.");
    expect(p).not.toContain("cannot see it");
  });

  test("a resumed repair prompt carries diagnostics and adds no hints of its own", () => {
    const p = buildRepairPrompt({
      adapter,
      round: 1,
      gate: gate(),
      toolOutput: "[type.mismatch] Error: expected `Int`",
      resumed: true,
      taskPrompt: base.taskPrompt,
      doc: base.doc,
      toolPolicy: "no-verify",
    });
    expect(p).toContain("[type.mismatch]");
    expect(p).toContain("a name given");
    expect(p).toContain("1/3 passed");
    // A resumed session must not repeat the task or the doc: that would make the
    // repair round a second first shot.
    expect(p).not.toContain("Return one for you");
    expect(p).not.toContain("Aven in one line.");
  });

  test.each([
    // std/test: one line, already the diagnostic.
    ['expected "One for you, one for me.", got "nope"', 'expected "One for you, one for me.", got "nope"'],
    // unittest: a traceback whose first line says nothing and whose last line is
    // the assertion. Line 1 from both arms would have been "Traceback".
    [
      "Traceback (most recent call last):\n  File \"x.py\", line 9, in test_000\n    self.assertEqual(a, b)\nAssertionError: 'nope' != 'One for you, one for me.'",
      "AssertionError: 'nope' != 'One for you, one for me.'",
    ],
    ["", "(no message)"],
  ])("case messages summarize to the informative line", (message, expected) => {
    expect(summarizeCaseMessage(message)).toBe(expected);
  });

  test("an unresumed repair prompt restates task and doc, because the model has no memory", () => {
    const p = buildRepairPrompt({
      adapter,
      round: 1,
      gate: gate(),
      toolOutput: "",
      resumed: false,
      taskPrompt: base.taskPrompt,
      doc: base.doc,
      toolPolicy: "no-verify",
    });
    expect(p).toContain("Return one for you");
    expect(p).toContain("Aven in one line.");
  });
});

// --- hidden suite, end to end ----------------------------------------------

/**
 * The default is `suiteVisibility: "hidden"`, so the path that every future sweep
 * takes is the one where the suite is on disk only while the gate runs. Two ways
 * that can go wrong silently: the model can still read the expected values (the
 * hiding achieves nothing), or the suite fails to execute (which looks exactly
 * like a model failure). Both are checked here with a fake harness, so the test
 * needs no network and no model.
 */
describe("hidden suite (the default)", () => {
  /** A harness that records what it can see, then writes `solution`. */
  function spyAgent(solutions: string[], shellCommands = 0): { adapter: AgentAdapter; seen: string[][] } {
    const seen: string[][] = [];
    let round = 0;
    const adapter: AgentAdapter = {
      id: "spy",
      supportsResume: false,
      version: async () => "spy",
      available: async () => ({ ok: true, detail: "spy" }),
      run: async (inv) => {
        seen.push(readdirSync(inv.dir).sort());
        const source = solutions[Math.min(round, solutions.length - 1)]!;
        round++;
        await Bun.write(join(inv.dir, "solution.py"), source);
        return emptyResult({ ok: true, promptTokens: 1, completionTokens: 1, shellCommands, wallMs: 1 });
      },
    };
    return { adapter, seen };
  }

  function context(agent: AgentAdapter, workRoot: string, maxRounds: number): RunContext {
    return {
      runId: "test",
      agent,
      harnessVersion: "spy",
      modelId: "spy/model",
      provider: "spy",
      quantization: null,
      avenCommit: null,
      avenBinarySha256: null,
      languageVersions: { python: "test" },
      docId: null,
      docHash: null,
      docTokens: null,
      doc: null,
      toolPolicy: "no-verify",
      suiteVisibility: "hidden",
      sandbox: "none",
      avenBin: null,
      maxRounds,
      agentTimeoutMs: 60_000,
      toolTimeoutMs: 60_000,
      mypy: false,
      temperature: null,
      seed: null,
      agentSem: new Semaphore(1),
      langSem: new Semaphore(1),
      workRoot,
      resumeSessions: false,
      survey: true,
      keepWork: true,
    };
  }

  const spec = { taskId: "two-fer", language: "python", sampleIndex: 0, taskSet: "holdout" as const };

  test("the model never sees the suite, and the suite still runs", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "aven-bench-hidden-"));
    // Wrong on purpose: round 0 must fail so a round 1 happens at all.
    const wrong = 'def two_fer(name=None):\n    return "nope"\n';
    const right = 'def two_fer(name=None):\n    return f"One for {name or \'you\'}, one for me."\n';
    const { adapter, seen } = spyAgent([wrong, right], 2);
    const record = await runAttempt(context(adapter, workRoot, 1), spec);

    expect(seen).toHaveLength(2);
    for (const listing of seen) {
      // No suite, and no bytecode of it either: a .pyc carries every expected
      // value as a code constant.
      expect(listing).not.toContain("solution_test.py");
      expect(listing).not.toContain("__pycache__");
    }
    // The suite ran anyway, both times: 3 real cases, failing then passing.
    expect(record.repairRounds[0]).toMatchObject({ outcome: "wrong_output", casesPassed: 0, casesTotal: 3 });
    expect(record.repairRounds[1]).toMatchObject({ outcome: "pass", casesPassed: 3, casesTotal: 3 });
    expect(record.outcome).toBe("pass");
    expect(record.firstShotPass).toBe(false);
    expect(record.roundsToGreen).toBe(1);
    expect(record.suiteVisibility).toBe("hidden");
    expect(record.repairRounds.map((r) => r.shellCommands)).toEqual([2, 2]);
    expect(record.shellCommands).toBe(4);
    // And nothing is left behind for the next attempt to read.
    expect(readdirSync(record.workDir)).not.toContain("solution_test.py");
  });

  test("--show-suite puts it in the directory the model works in", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "aven-bench-visible-"));
    const { adapter, seen } = spyAgent(['def two_fer(name=None):\n    return "nope"\n']);
    const ctx = { ...context(adapter, workRoot, 0), suiteVisibility: "visible" as const };
    const record = await runAttempt(ctx, spec);
    expect(seen[0]).toContain("solution_test.py");
    expect(record.suiteVisibility).toBe("visible");
  });

  /**
   * The survey exists to explain the ranked tails, so the thing that must hold is
   * that it cannot move them: its tokens, cost and wall time stay out of the solve
   * totals, and it happens after the verdict is fixed.
   */
  describe("post-verdict survey", () => {
    /** Resumable spy: writes a solution each round, then answers the survey. */
    function surveyAgent(solution: string): { adapter: AgentAdapter; prompts: string[] } {
      const prompts: string[] = [];
      const adapter: AgentAdapter = {
        id: "spy",
        supportsResume: true,
        version: async () => "spy",
        available: async () => ({ ok: true, detail: "spy" }),
        run: async (inv) => {
          prompts.push(inv.prompt);
          const surveying = inv.prompt.includes("language-design research");
          if (!surveying) await Bun.write(join(inv.dir, "solution.py"), solution);
          return emptyResult({
            ok: true,
            promptTokens: surveying ? 500 : 1,
            completionTokens: surveying ? 70 : 1,
            reportedCostUsd: surveying ? 0.004 : 0.01,
            sessionRef: "ses_spy",
            assistantText: surveying ? "Pattern matching on optional arguments was hard to find." : "",
            wallMs: surveying ? 900 : 1,
          });
        },
      };
      return { adapter, prompts };
    }

    const right = 'def two_fer(name=None):\n    return f"One for {name or \'you\'}, one for me."\n';

    test("is asked after the verdict and accounted separately from the solve loop", async () => {
      const workRoot = mkdtempSync(join(tmpdir(), "aven-bench-survey-"));
      const { adapter, prompts } = surveyAgent(right);
      const ctx = { ...context(adapter, workRoot, 0), resumeSessions: true };
      const record = await runAttempt(ctx, spec);

      // One solve round, then exactly one survey turn.
      expect(record.roundsUsed).toBe(1);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("already been recorded");
      expect(prompts[1]).toContain("Python");

      expect(record.outcome).toBe("pass");
      expect(record.surveyed).toBe(true);
      expect(record.surveyResponse).toContain("optional arguments");
      expect(record.surveyResponseHash).not.toBeNull();
      expect(record.surveyError).toBeNull();

      // The separation that matters: survey usage is not in the solve totals.
      expect(record.surveyCompletionTokens).toBe(70);
      expect(record.completionTokens).toBe(1);
      expect(record.promptTokens).toBe(1);
      expect(record.surveyCostUsd).toBeCloseTo(0.004, 9);
      expect(record.costUsd).toBeCloseTo(0.01, 9);
      expect(record.priceSource).toBe("harness");
      expect(record.agentWallMs).toBe(1);
      expect(record.surveyWallMs).toBe(900);
    });

    test("--no-survey leaves the fields empty without touching the verdict", async () => {
      const workRoot = mkdtempSync(join(tmpdir(), "aven-bench-nosurvey-"));
      const { adapter, prompts } = surveyAgent(right);
      const ctx = { ...context(adapter, workRoot, 0), resumeSessions: true, survey: false };
      const record = await runAttempt(ctx, spec);
      expect(prompts).toHaveLength(1);
      expect(record.outcome).toBe("pass");
      expect(record.surveyed).toBe(false);
      expect(record.surveyResponse).toBeNull();
      expect(record.surveyError).toBeNull();
      expect(record.surveyCostUsd).toBeNull();
    });

    test("a model that writes nothing is not surveyed about it", async () => {
      const workRoot = mkdtempSync(join(tmpdir(), "aven-bench-refusal-"));
      const prompts: string[] = [];
      const adapter: AgentAdapter = {
        id: "spy",
        supportsResume: true,
        version: async () => "spy",
        available: async () => ({ ok: true, detail: "spy" }),
        run: async (inv) => {
          prompts.push(inv.prompt);
          return emptyResult({ ok: true, sessionRef: "ses_spy", assistantText: "I would rather not.", wallMs: 1 });
        },
      };
      const record = await runAttempt({ ...context(adapter, workRoot, 0), resumeSessions: true }, spec);
      expect(record.outcome).toBe("refusal");
      expect(prompts).toHaveLength(1);
      expect(record.surveyed).toBe(false);
    });

    test("the question offers a licensed null answer, so easy tasks stop inventing findings", () => {
      const adapter = adapterFor("python");
      const prompt = buildSurveyPrompt({ adapter, passed: true, roundsUsed: 1 });
      expect(prompt).toContain("nothing, this was straightforward");
      expect(prompt).toContain("single change");
      // Asked identically on the control arm; that baseline is the point.
      expect(buildSurveyPrompt({ adapter: adapterFor("aven"), passed: false, roundsUsed: 3 })).toContain(
        "no rounds left",
      );
    });
  });
});

// --- store: append-only, content-addressed, resumable ----------------------

describe("store", () => {
  test("artifacts are content-addressed and written once", () => {
    const hash = putArtifact("solution contents", "av");
    expect(hash).toBe(sha256("solution contents"));
    expect(putArtifact("solution contents", "av")).toBe(hash);
  });

  test("records append and re-read by natural key", () => {
    const dir = mkdtempSync(join(tmpdir(), "aven-bench-runs-"));
    const log = join(dir, "run.jsonl");
    appendRecord(log, record({ taskId: "leap" }));
    appendRecord(log, record({ taskId: "two-fer", outcome: "harness_error" }));
    const index = loadResumeIndex(dir);
    expect(index.records).toBe(2);
    expect(index.files).toBe(1);

    const leap = attemptKey(record({ taskId: "leap" }));
    const twoFer = attemptKey(record({ taskId: "two-fer" }));
    // Default policy: a harness_error row still counts as present, so a sweep
    // never silently re-rolls it into a model failure.
    expect(isDone(index, leap, false).done).toBe(true);
    expect(isDone(index, twoFer, false).done).toBe(true);
    expect(isDone(index, twoFer, true).done).toBe(false);
    expect(isDone(index, leap, true).done).toBe(true);
    expect(isDone(index, "nothing here", false).done).toBe(false);
  });

  test("a truncated final line is counted, not fatal", () => {
    const dir = mkdtempSync(join(tmpdir(), "aven-bench-runs-"));
    const log = join(dir, "run.jsonl");
    appendRecord(log, record());
    Bun.spawnSync(["sh", "-c", `printf '{"taskId": "trunc' >> ${JSON.stringify(log)}`]);
    const index = loadResumeIndex(dir);
    expect(index.records).toBe(1);
    expect(index.malformedLines).toBe(1);
  });

  test("the natural key ignores everything not knowable before the attempt", () => {
    const key = attemptKey(record());
    expect(key).toBe(attemptKey(record({ outcome: "wrong_output", casesPassed: 0, wallMs: 999 })));
    expect(key).not.toBe(attemptKey(record({ sampleIndex: 1 })));
    expect(key).not.toBe(attemptKey(record({ language: "aven", avenCommit: "abc" })));
    expect(key).not.toBe(attemptKey(record({ toolPolicy: "self-verify" })));
    expect(key).not.toBe(attemptKey(record({ suiteVisibility: "visible" })));
    expect(key).not.toBe(attemptKey(record({ sandbox: "none" })));
  });
});

// --- session log -----------------------------------------------------------

describe("session log", () => {
  const rec = (tag: string): SessionRecord => ({
    schema_version: 1,
    timestamp: 0,
    tag,
    aven_version: "0.1.0",
    aven_build_commit: null,
    subcommand: "check",
    argv: [],
    entry_path: null,
    entry_source_sha256: null,
    timings: null,
    diagnostics: [],
    exit_code: 0,
    summary: null,
  });

  test("gate invocations keep the attempt id as a prefix but stay distinguishable", () => {
    const tag = gateTag("run-abc", 1, "check");
    expect(tag.startsWith("run-abc")).toBe(true);
    expect(tag).toContain(GATE_TAG_MARKER);
  });

  test("model-made invocations are the ones without the gate marker", () => {
    const records = [rec("run-abc"), rec(gateTag("run-abc", 0, "check")), rec(gateTag("run-abc", 0, "test"))];
    expect(modelInvocations(records)).toHaveLength(1);
  });
});

// --- scheduling ------------------------------------------------------------

describe("concurrency", () => {
  test("a semaphore never lets more than its limit run at once", async () => {
    const sem = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        sem.with(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await Bun.sleep(1);
          inFlight--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(inFlight).toBe(0);
  });
});

// --- mypy normalization ----------------------------------------------------

describe("mypy", () => {
  test.each([
    ['solution.py:3: error: Incompatible return value type (got "int", expected "str")  [return-value]', "mypy.return-value"],
    ["solution.py:7: error: Function is missing a type annotation  [no-untyped-def]", "mypy.no-untyped-def"],
    ["solution.py:1: note: See https://mypy.rtfd.io/en/stable/_refs.html", "mypy.note"],
    ["solution.py:2: error: something with no bracketed code", "mypy.error"],
  ])("%s -> %s", (line, code) => {
    expect(mypyCode(line)).toBe(code);
  });
});

// --- contamination guard ---------------------------------------------------

describe("work directory containment", () => {
  test.each([
    ["/w/s0", "/w/s0/solution.av", true],
    ["/w/s0", "/w/s0", true],
    ["/w/s0", "/w/s0x/solution.av", false],
    ["/w/s0", "/home/dave/w/clex/aven-bench/references/acronym/solution.av", false],
  ] as const)("isInside(%s, %s) === %s", (dir, path, expected) => {
    expect(isInside(dir, path)).toBe(expected);
  });

  test("the repo is detected as an enclosing repository; a stray empty .git is not", () => {
    // A work root inside the repo hands the model references/ — observed for real.
    expect(enclosingRepo(REPO_ROOT)).toBe(REPO_ROOT);
    expect(enclosingRepo(join(REPO_ROOT, "runner"))).toBe(REPO_ROOT);
    // This box has an empty /tmp/.git that git itself rejects; treating it as a
    // repository would make the runner refuse perfectly good work roots.
    expect(enclosingRepo(tmpdir())).toBeNull();
  });

  test("the default work root is outside the repo and outside /tmp", () => {
    // /tmp is a shared junk drawer: models globbed `/tmp/**/*.av` and found other
    // agents' Aven files, including a copy of the std library.
    expect(enclosingRepo(DEFAULT_WORK_ROOT)).toBeNull();
    expect(DEFAULT_WORK_ROOT.startsWith(`${tmpdir()}/`)).toBe(false);
    expect(isInside(REPO_ROOT, DEFAULT_WORK_ROOT)).toBe(false);
  });
});

// --- bubblewrap filesystem boundary ---------------------------------------

describe("bubblewrap filesystem boundary", () => {
  test("an unavailable bwrap is reported instead of becoming an unsandboxed fallback", async () => {
    const availability = await sandboxAvailability("/definitely/not/bwrap");
    expect(availability.ok).toBe(false);
    expect(availability.detail).toContain("cannot run");
  });

  test.skipIf(Bun.which("bwrap") === null)("real reads outside the attempt fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "aven-bench-sandbox-"));
    const work = join(root, "attempt-a");
    const sibling = join(root, "attempt-b");
    mkdirSync(work);
    mkdirSync(sibling);
    const siblingSecret = join(sibling, "solution.py");
    writeFileSync(siblingSecret, "SIBLING_SECRET\n");

    const bash = realpathSync(Bun.which("bash")!);
    const script = [
      'if head -c 1 "$1" >/dev/null 2>&1; then echo "reference=READABLE"; else echo "reference=unreachable"; fi',
      'if ls "$2" >/dev/null 2>&1; then echo "corpus=READABLE"; else echo "corpus=unreachable"; fi',
      'if head -c 1 "$3" >/dev/null 2>&1; then echo "sibling=READABLE"; else echo "sibling=unreachable"; fi',
      'printf "attempt-write-ok\\n" > sandbox-write.txt',
      "cat sandbox-write.txt",
    ].join("\n");
    const command = bubblewrapCommand(
      [
        bash,
        "-c",
        script,
        "sandbox-probe",
        join(REPO_ROOT, "references/two-fer/solution.py"),
        join(REPO_ROOT, "corpus"),
        siblingSecret,
      ],
      { dir: work, language: "python", avenBin: null },
    );
    const proc = await runProcess(command, { cwd: work, timeoutMs: 30_000 });

    expect(proc.spawnError).toBeNull();
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toBe(
      "reference=unreachable\ncorpus=unreachable\nsibling=unreachable\nattempt-write-ok\n",
    );
    expect(await Bun.file(join(work, "sandbox-write.txt")).text()).toBe("attempt-write-ok\n");
    expect(existsSync(join(work, ".agent-state/data"))).toBe(true);
  });
});

// --- argv ------------------------------------------------------------------

describe("argv", () => {
  test("handles --flag value, --flag=value and bare booleans", () => {
    const args = parseArgv(["--lang", "aven,python", "--rounds=3", "--dry-run", "--model", "a/b"]);
    expect(args.flags.get("lang")).toBe("aven,python");
    expect(args.flags.get("rounds")).toBe("3");
    expect(args.flags.get("model")).toBe("a/b");
    expect(args.bools.has("dry-run")).toBe(true);
  });
});

// --- agent registry --------------------------------------------------------

describe("agent registry", () => {
  test("opencode is implemented; the other three are stubs that fail with a reason", async () => {
    expect(agentFor("opencode").id).toBe("opencode");
    for (const id of ["pi", "little-coder", "ollama"]) {
      const adapter = agentFor(id);
      const availability = await adapter.available();
      expect(availability.ok).toBe(false);
      expect(availability.detail).toContain("stub");
      const result = await adapter.run({
        dir: "/tmp",
        language: "python",
        prompt: "x",
        model: "m",
        timeoutMs: 1,
        sessionRef: null,
        env: {},
        sandbox: "none",
        avenBin: null,
        temperature: null,
        seed: null,
      });
      expect(result.ok).toBe(false);
      expect(result.harnessError).toContain("stub");
    }
    expect(Object.keys(AGENTS).sort()).toEqual(["little-coder", "ollama", "opencode", "pi"]);
  });

  test("an unknown harness is rejected by name", () => {
    expect(() => agentFor("nope")).toThrow(/unknown agent harness/);
  });
});
