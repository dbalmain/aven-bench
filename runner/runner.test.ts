/**
 * Unit tests for the runner's pure parts: the bits that decide what a row says.
 *
 * Everything here runs without a network, a model or a compiler. The things that
 * genuinely need those (an end-to-end attempt) are exercised by an actual run —
 * see the acceptance recipe in `runner/README.md`; a runner nobody ran is
 * worthless, and a test that mocks the model would prove nothing about it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEvents } from "../adapters/agent/opencode.ts";
import { agentFor, AGENTS } from "../adapters/agent/index.ts";
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
import { computeCost, resetPriceTableCache, type PriceTable } from "./prices.ts";
import { Semaphore } from "./proc.ts";
import { buildInitialPrompt, buildRepairPrompt } from "./prompt.ts";
import { enclosingRepo, parseArgv } from "./run.ts";
import { DEFAULT_WORK_ROOT, isInside } from "./attempt.ts";
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
    reasoningTokens: 0,
    costUsd: 0,
    priceSource: "free",
    priceTableVersion: "test",
    reportedCostUsd: 0,
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

describe("cost", () => {
  const table: PriceTable = {
    version: "test",
    models: {
      "free/model": { in: 0, out: 0 },
      "paid/model": { in: 1, out: 10, cacheReadIn: 0.1 },
    },
  };

  test.each([
    ["free/model", { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedPromptTokens: 0 }, 0, "free"],
    ["paid/model", { promptTokens: 1_000_000, completionTokens: 100_000, cachedPromptTokens: 0 }, 2, "table"],
    ["paid/model", { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 1_000_000 }, 0.1, "table"],
  ] as const)("%s prices from the table, not the harness", (model, tokens, expected, source) => {
    const cost = computeCost(model, tokens, table);
    expect(cost.costUsd).toBeCloseTo(expected, 9);
    expect(cost.priceSource).toBe(source);
  });

  test("a model with no entry records null, never a fabricated zero", () => {
    const cost = computeCost("mystery/model", { promptTokens: 99, completionTokens: 99, cachedPromptTokens: 0 }, table);
    expect(cost.costUsd).toBeNull();
    expect(cost.priceSource).toBe("unknown");
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
      const cost = computeCost(model, { promptTokens: 5_000, completionTokens: 500, cachedPromptTokens: 100 });
      expect(cost.costUsd).toBe(0);
      expect(cost.priceSource).toBe("free");
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
    suiteVisibility: "visible" as const,
    testCommandDisplay: "aven test --format json solution_test.av",
  };

  test("no-verify tells the model not to run anything and names the one file to write", () => {
    const p = buildInitialPrompt(base);
    expect(p).toContain("Do not run any commands");
    expect(p).toContain("solution.av");
    expect(p).toContain("Aven in one line.");
    expect(p).toContain("Read it; do not modify it.");
  });

  test("self-verify offers the real test command instead", () => {
    const p = buildInitialPrompt({ ...base, toolPolicy: "self-verify" });
    expect(p).toContain("aven test --format json solution_test.av");
    expect(p).not.toContain("Do not run any commands");
  });

  test("hide-suite says the suite is absent", () => {
    expect(buildInitialPrompt({ ...base, suiteVisibility: "hidden" })).toContain("not in this directory");
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
        prompt: "x",
        model: "m",
        timeoutMs: 1,
        sessionRef: null,
        env: {},
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
