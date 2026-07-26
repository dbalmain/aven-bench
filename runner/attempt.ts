/**
 * One attempt: prompt, gate, repair, record.
 *
 * The shape of the loop is the shape of the two headline metrics (§2). Round 0 is
 * the first shot and `firstShotPass` is its verdict — that number is about the
 * documentation. Every later round exists because the model was shown the
 * tooling's diagnostics and tried again, and `roundsToGreen` is about *those* —
 * the diagnostics. Nothing else in the record is allowed to blur the two: the
 * per-round entry carries its own tokens, probes, diagnostics and outcome.
 *
 * Failure handling follows §3c to the letter. A harness or tooling failure ends
 * the attempt with `outcome: "harness_error"`, keeping whatever rounds already
 * happened. It is never retried in place and never recorded as the model getting
 * the answer wrong, because those two are not the same measurement.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { adapterFor, type LangAdapter } from "../adapters/lang/index.ts";
import type { AgentAdapter } from "../adapters/agent/index.ts";
import { CORPUS_DIR } from "../ingest/paths.ts";
import { loadTask, type Task } from "../ingest/task.ts";
import { avenCheckText, probeMirrors, runGate, type GateContext } from "./gate.ts";
import { computeCost } from "./prices.ts";
import { Semaphore } from "./proc.ts";
import { buildInitialPrompt, buildRepairPrompt, type SuiteVisibility } from "./prompt.ts";
import {
  SCHEMA_VERSION,
  TOKEN_ESTIMATOR,
  attemptKey,
  type AttemptRecord,
  type GateResult,
  type Outcome,
  type RepairRound,
  type SandboxMode,
  type TaskSet,
  type TaskSource,
  type ToolPolicy,
} from "./schema.ts";
import { modelInvocations, readSessionLog } from "./session.ts";
import { putArtifact, repoRelative, sha256 } from "./store.ts";
import { approxTokens, countLoc } from "./tokens.ts";

export const RUNNER_VERSION = "0.1.0";

export type RunContext = {
  runId: string;
  agent: AgentAdapter;
  harnessVersion: string;
  modelId: string;
  provider: string;
  quantization: string | null;
  /** aven-lang commit at run start; null when no Aven arm is in the run. */
  avenCommit: string | null;
  avenBinarySha256: string | null;
  languageVersions: Record<string, string>;
  docId: string | null;
  docHash: string | null;
  docTokens: number | null;
  doc: string | null;
  toolPolicy: ToolPolicy;
  suiteVisibility: SuiteVisibility;
  sandbox: SandboxMode;
  avenBin: string | null;
  maxRounds: number;
  agentTimeoutMs: number;
  toolTimeoutMs: number;
  mypy: boolean;
  temperature: number | null;
  seed: number | null;
  /** Concurrency caps: one per harness, one for the language toolchain. */
  agentSem: Semaphore;
  langSem: Semaphore;
  workRoot: string;
  resumeSessions: boolean;
  /**
   * Keep the work directory after the attempt. Off by default: every durable
   * thing (solution, prompts, harness log, session log, suite) is already in the
   * artifact store, and a directory that lingers is one more `.av` file for a
   * concurrent attempt to glob up.
   */
  keepWork: boolean;
};

export type AttemptSpec = {
  taskId: string;
  language: string;
  sampleIndex: number;
  taskSet: TaskSet;
  /** Case uuids all arms in this run can express; undefined means no restriction. */
  only?: ReadonlySet<string>;
};

export function attemptIdFor(ctx: RunContext, spec: AttemptSpec): string {
  const key = attemptKey({
    taskId: spec.taskId,
    language: spec.language,
    modelId: ctx.modelId,
    agentHarness: ctx.agent.id,
    docId: ctx.docId,
    sampleIndex: spec.sampleIndex,
    avenCommit: spec.language === "aven" ? ctx.avenCommit : null,
    toolPolicy: ctx.toolPolicy,
    suiteVisibility: ctx.suiteVisibility,
    sandbox: ctx.sandbox,
  });
  return `${ctx.runId}-${sha256(key).slice(0, 12)}`;
}

export function workDirFor(ctx: RunContext, spec: AttemptSpec): string {
  const model = ctx.modelId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${ctx.workRoot}/${ctx.runId}/${spec.language}/${spec.taskId}/${ctx.agent.id}__${model}/s${spec.sampleIndex}`;
}

function taskSourceOf(task: Task): TaskSource {
  return /problem-specifications/.test(task.source) ? "exercism" : "design-center";
}

/** Is `path` inside `dir`? Both are absolute; no symlink resolution. */
export function isInside(dir: string, path: string): boolean {
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  return path === dir || path.startsWith(base);
}

/**
 * Emptied every time — a stale solution from a previous run would score itself —
 * and made a git repository of its own.
 *
 * The `git init` scopes opencode's project glob and grep to the attempt. Verified:
 * with it, `glob **\/*.av` returns only the attempt's own file; without it, the
 * same prompt walked up to aven-bench and read a hand-written reference answer.
 * It is defence in depth, not the boundary — bubblewrap supplies that.
 */
function freshDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Failure is not fatal under bubblewrap. The work-root guard still protects an
  // explicit --no-sandbox debugging run.
  Bun.spawnSync(["git", "init", "--quiet", "."], { cwd: dir, stdout: "ignore", stderr: "ignore" });
}

type SolutionSnapshot = {
  exists: boolean;
  text: string;
  hash: string | null;
  bytes: number;
  loc: number;
  tokens: number;
};

async function snapshotSolution(dir: string, adapter: LangAdapter): Promise<SolutionSnapshot> {
  const path = `${dir}/${adapter.solutionFile}`;
  if (!existsSync(path)) {
    return { exists: false, text: "", hash: null, bytes: 0, loc: 0, tokens: 0 };
  }
  const text = await Bun.file(path).text();
  return {
    exists: true,
    text,
    hash: putArtifact(text, adapter.solutionFile.replace(/^.*\./, "")),
    bytes: Buffer.byteLength(text, "utf8"),
    loc: countLoc(text),
    tokens: approxTokens(text),
  };
}

export async function runAttempt(ctx: RunContext, spec: AttemptSpec): Promise<AttemptRecord> {
  const adapter = adapterFor(spec.language);
  const task = await loadTask(CORPUS_DIR, spec.taskId);
  const attemptId = attemptIdFor(ctx, spec);
  const dir = workDirFor(ctx, spec);
  const startedAt = new Date().toISOString();
  const started = performance.now();

  freshDir(dir);

  const { contents: suite, omitted } = adapter.renderTests(task, spec.only);
  const suiteHash = putArtifact(suite, adapter.testFile.replace(/^.*\./, ""));
  const suitePath = `${dir}/${adapter.testFile}`;
  const writeSuite = async () => Bun.write(suitePath, suite);
  /**
   * Undo `writeSuite`, leaving nothing the model can read the answers out of.
   *
   * The suite file is the obvious half. `__pycache__` is the other one: running
   * the Python suite byte-compiles it, and every expected value survives in the
   * `.pyc` as a code constant — `strings solution_test.cpython-313.pyc` prints
   * them. Hiding the source and leaving the bytecode would hide nothing.
   */
  const unwriteSuite = () => {
    rmSync(suitePath, { force: true });
    rmSync(`${dir}/__pycache__`, { recursive: true, force: true });
    // mypy's cache is gate residue too. It holds no expected values (only
    // solution.py is analysed) but it tells the model a gate ran, and the
    // directory is supposed to look untouched between rounds.
    rmSync(`${dir}/.mypy_cache`, { recursive: true, force: true });
  };
  if (ctx.suiteVisibility === "visible") await writeSuite();

  const taskPrompt = `${(await Bun.file(`${CORPUS_DIR}/${spec.taskId}/prompt.md`).text()).trimEnd()}\n\n${adapter.renderContract(task)}`;
  const { argv } = adapter.testCommand(dir);
  // Trusted gates use their normal host-side wrappers. A self-verifying model
  // needs a command made only from binaries and files present in its namespace.
  const modelTestCommand =
    ctx.sandbox === "bubblewrap"
      ? spec.language === "python"
        ? `python3 ${adapter.testFile}`
        : `aven test --format json ${adapter.testFile}`
      : argv.join(" ");
  const initialPrompt = buildInitialPrompt({
    adapter,
    taskPrompt,
    doc: ctx.doc,
    toolPolicy: ctx.toolPolicy,
    suiteVisibility: ctx.suiteVisibility,
    testCommandDisplay: modelTestCommand,
  });
  const promptHash = putArtifact(initialPrompt, "md");

  const sessionLogPath = `${dir}/session.jsonl`;
  const agentEnv: Record<string, string> = {
    AVEN_SESSION_LOG: sessionLogPath,
    AVEN_SESSION_TAG: attemptId,
  };

  const rounds: RepairRound[] = [];
  let outcome: Outcome = "harness_error";
  let outcomeDetail: string | null = null;
  let harnessError: string | null = null;
  let timedOut = false;
  let roundsToGreen: number | null = null;
  let sessionRef: string | null = null;
  let lastGate: GateResult | null = null;
  let lastSolution: SolutionSnapshot | null = null;
  let seenModelInvocations = 0;
  let prompt = initialPrompt;

  for (let round = 0; round <= ctx.maxRounds; round++) {
    const roundStarted = performance.now();
    const agentResult = await ctx.agentSem.with(() =>
      ctx.agent.run({
        dir,
        language: spec.language,
        prompt,
        model: ctx.modelId,
        timeoutMs: ctx.agentTimeoutMs,
        sessionRef: ctx.resumeSessions && ctx.agent.supportsResume ? sessionRef : null,
        env: agentEnv,
        sandbox: ctx.sandbox,
        avenBin: spec.language === "aven" ? ctx.avenBin : null,
        temperature: ctx.temperature,
        seed: ctx.seed,
      }),
    );
    if (agentResult.sessionRef) sessionRef = agentResult.sessionRef;
    const agentLogHash = agentResult.log === "" ? null : putArtifact(agentResult.log, "log");

    // `aven` runs the *model* made this round: everything in the session log not
    // tagged as one of the gate's own invocations.
    const modelRuns =
      spec.language === "aven" ? modelInvocations(readSessionLog(sessionLogPath)).length : null;
    const modelRunsThisRound = modelRuns === null ? null : modelRuns - seenModelInvocations;
    if (modelRuns !== null) seenModelInvocations = modelRuns;

    // Anything the harness named outside the work directory. Without the
    // sandbox, a pass with a nonzero count may have copied this repo's reference
    // answer. With bubblewrap, it records the attempt even though access failed.
    const escaped = agentResult.touchedPaths.filter((p) => !isInside(dir, p));

    const baseRound = {
      round,
      promptHash: round === 0 ? promptHash : putArtifact(prompt, "md"),
      outsideWorkdirTouches: escaped.length,
      escapedPaths: escaped.slice(0, 8),
      shellCommands: agentResult.shellCommands,
      promptTokens: agentResult.promptTokens,
      completionTokens: agentResult.completionTokens,
      cachedPromptTokens: agentResult.cachedPromptTokens,
      reasoningTokens: agentResult.reasoningTokens,
      reportedCostUsd: agentResult.reportedCostUsd,
      agentWallMs: agentResult.wallMs,
      agentLogHash,
      modelToolInvocations: modelRunsThisRound,
    };

    if (!agentResult.ok) {
      // The harness, not the model. Record it and stop; §3c forbids folding this
      // into a model failure or retrying it silently.
      outcome = agentResult.timedOut ? "timeout" : "harness_error";
      timedOut = agentResult.timedOut;
      harnessError = agentResult.harnessError;
      outcomeDetail = agentResult.harnessError;
      rounds.push({
        ...baseRound,
        diagnosticCodes: [],
        outcome,
        casesPassed: 0,
        casesTotal: 0,
        probes: [],
        wallMs: performance.now() - roundStarted,
        gateWallMs: 0,
        timedOut: agentResult.timedOut,
        harnessError: agentResult.harnessError,
        artifactHash: null,
        solutionBytes: 0,
        solutionLoc: 0,
        solutionTokens: 0,
      });
      break;
    }

    const solution = await snapshotSolution(dir, adapter);
    if (solution.exists) lastSolution = solution;
    if (!solution.exists) {
      // The harness ran and wrote nothing. That is a refusal (or a model that
      // answered in prose), not a wrong answer.
      outcome = "refusal";
      outcomeDetail = agentResult.assistantText.slice(0, 300) || "no solution file was written";
      rounds.push({
        ...baseRound,
        diagnosticCodes: [],
        outcome,
        casesPassed: 0,
        casesTotal: 0,
        probes: [],
        wallMs: performance.now() - roundStarted,
        gateWallMs: 0,
        timedOut: false,
        harnessError: null,
        artifactHash: null,
        solutionBytes: 0,
        solutionLoc: 0,
        solutionTokens: 0,
      });
      break;
    }

    const gateStarted = performance.now();
    const gateCtx: GateContext = {
      dir,
      adapter,
      attemptId,
      round,
      timeoutMs: ctx.toolTimeoutMs,
      env: { AVEN_SESSION_LOG: sessionLogPath },
      mypy: ctx.mypy,
    };
    if (ctx.suiteVisibility === "hidden") await writeSuite();
    const gate = await ctx.langSem.with(() => runGate(gateCtx));

    // The repair text has to be produced *now*, while the suite is still on disk:
    // `aven check` type-checks the suite, so running it after the file is gone
    // would report a missing file instead of the model's mistake. Only produced
    // when another round will actually use it.
    const anotherRound = !gate.ok && gate.outcome !== "harness_error" && round < ctx.maxRounds;
    const needsCheckText = anotherRound && gate.probes.some((p) => p.name === "check" && p.ok !== true);
    const toolOutput = needsCheckText
      ? await ctx.langSem.with(() => avenCheckText(gateCtx))
      : (gate.detail ?? "");

    // The next round's agent call must not find it — including the bytecode.
    if (ctx.suiteVisibility === "hidden") unwriteSuite();
    const gateWallMs = performance.now() - gateStarted;
    lastGate = gate;

    const diagnosticCodes = gate.probes.filter((p) => p.gating).flatMap((p) => p.diagnosticCodes);
    rounds.push({
      ...baseRound,
      diagnosticCodes,
      outcome: gate.outcome,
      casesPassed: gate.casesPassed,
      casesTotal: gate.casesTotal,
      probes: gate.probes,
      wallMs: performance.now() - roundStarted,
      gateWallMs,
      timedOut: gate.probes.some((p) => p.timedOut),
      harnessError: gate.outcome === "harness_error" ? gate.detail : null,
      artifactHash: solution.hash,
      solutionBytes: solution.bytes,
      solutionLoc: solution.loc,
      solutionTokens: solution.tokens,
    });

    outcome = gate.outcome;
    outcomeDetail = gate.detail;
    if (gate.outcome === "harness_error") {
      // A tool that could not run at all: same rule as a harness failure.
      harnessError = gate.detail ?? "gate tooling unavailable";
      break;
    }
    if (gate.ok) {
      roundsToGreen = round;
      break;
    }
    if (round === ctx.maxRounds) break;

    // Another round: show the model exactly what a human would have seen.
    const resumed = ctx.resumeSessions && ctx.agent.supportsResume && sessionRef !== null;
    prompt = buildRepairPrompt({
      adapter,
      round: round + 1,
      gate,
      toolOutput,
      resumed,
      taskPrompt,
      doc: ctx.doc,
      toolPolicy: ctx.toolPolicy,
    });
  }

  const sessionRecords = spec.language === "aven" ? readSessionLog(sessionLogPath) : [];
  const sessionLogHash =
    sessionRecords.length > 0
      ? putArtifact(sessionRecords.map((r) => JSON.stringify(r)).join("\n") + "\n", "jsonl")
      : null;

  const promptTokens = rounds.reduce((n, r) => n + r.promptTokens, 0);
  const completionTokens = rounds.reduce((n, r) => n + r.completionTokens, 0);
  const cachedPromptTokens = rounds.reduce((n, r) => n + r.cachedPromptTokens, 0);
  const reasoningTokens = rounds.reduce((n, r) => n + r.reasoningTokens, 0);
  const agentWallMs = rounds.reduce((n, r) => n + r.agentWallMs, 0);
  const gateWallMs = rounds.reduce((n, r) => n + r.gateWallMs, 0);
  const reportedCosts = rounds.map((r) => r.reportedCostUsd).filter((c): c is number => c !== null);
  const cost = computeCost(ctx.modelId, { promptTokens, completionTokens, cachedPromptTokens });
  const mirrors = probeMirrors(lastGate?.probes ?? [], adapter.solutionFile);

  const record: AttemptRecord = {
    schemaVersion: SCHEMA_VERSION,
    runId: ctx.runId,
    attemptId,
    runnerVersion: RUNNER_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),

    taskId: spec.taskId,
    taskSource: taskSourceOf(task),
    taskSet: spec.taskSet,
    casesOmitted: omitted.length,
    casesExcludedByIntersect: spec.only ? task.cases.length - spec.only.size : 0,

    language: spec.language,
    languageVersion: ctx.languageVersions[spec.language] ?? "unknown",
    avenCommit: spec.language === "aven" ? ctx.avenCommit : null,
    avenBinarySha256: spec.language === "aven" ? ctx.avenBinarySha256 : null,

    docId: ctx.docId,
    docHash: ctx.docHash,
    docTokens: ctx.docTokens,

    modelId: ctx.modelId,
    provider: ctx.provider,
    quantization: ctx.quantization,

    agentHarness: ctx.agent.id,
    harnessVersion: ctx.harnessVersion,
    agentSessionRef: sessionRef,

    sampleIndex: spec.sampleIndex,
    temperature: ctx.temperature,
    seed: ctx.seed,
    toolPolicy: ctx.toolPolicy,
    suiteVisibility: ctx.suiteVisibility,
    sandbox: ctx.sandbox,

    maxRounds: ctx.maxRounds,
    roundsUsed: rounds.length,
    repairRounds: rounds,

    outcome,
    outcomeDetail,
    harnessError,
    timedOut,
    firstShotPass: rounds[0]?.outcome === "pass",
    roundsToGreen,

    casesPassed: lastGate?.casesPassed ?? 0,
    casesTotal: lastGate?.casesTotal ?? 0,

    probes: lastGate?.probes ?? [],
    ...mirrors,

    promptTokens,
    completionTokens,
    cachedPromptTokens,
    reasoningTokens,
    ...cost,
    reportedCostUsd: reportedCosts.length > 0 ? reportedCosts.reduce((a, b) => a + b, 0) : null,

    wallMs: performance.now() - started,
    agentWallMs,
    gateWallMs,
    tokensPerSec: agentWallMs > 0 ? completionTokens / (agentWallMs / 1000) : null,

    solutionBytes: lastSolution?.bytes ?? 0,
    solutionLoc: lastSolution?.loc ?? 0,
    solutionTokens: lastSolution?.tokens ?? 0,
    tokenEstimator: TOKEN_ESTIMATOR,
    outsideWorkdirTouches: rounds.reduce((n, r) => n + r.outsideWorkdirTouches, 0),
    shellCommands: rounds.reduce((n, r) => n + r.shellCommands, 0),

    artifactHash: lastSolution?.hash ?? null,
    promptHash,
    suiteHash,
    sessionLogHash,
    workDir: ctx.keepWork ? repoRelative(dir) : `${repoRelative(dir)} (pruned)`,
  };
  // Everything durable is in the artifact store by now. Leaving the directory
  // behind only gives the *next* concurrent attempt something to glob.
  if (!ctx.keepWork) rmSync(dir, { recursive: true, force: true });
  return record;
}

/**
 * Work directories live outside the repository, and outside `/tmp`.
 *
 * Both halves were bought with real observations:
 *
 *  - Under `data/work/`, opencode resolved its project root to the enclosing git
 *    repository and read `references/acronym/solution.av` — the hand-written
 *    answer — before "solving" acronym.
 *  - Moved to `/tmp/aven-bench-work`, models globbed `/tmp/**\/*.av` and found
 *    `/tmp/aven-audit/*.av` and a checkout of `crates/aven-host/std/*.av` left
 *    there by other work. `/tmp` on a dev box is a shared junk drawer.
 *
 * So: a private cache directory, plus a `git init` per attempt (see `freshDir`),
 * plus escape and shell-command accounting on every round. Those remain useful
 * defence in depth and make explicit `--no-sandbox` debugging rows diagnosable.
 * The default model harness now runs inside bubblewrap; see `sandbox.ts`.
 */
export const DEFAULT_WORK_ROOT = `${process.env["XDG_CACHE_HOME"] ?? `${homedir()}/.cache`}/aven-bench/work`;
