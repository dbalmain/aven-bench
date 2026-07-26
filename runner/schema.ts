/**
 * The attempt record — one row per (model, task, language, sample).
 *
 * This is §3d of `PLAN-aven-bench.md`, written down before the runner existed
 * because it "can't be retro-collected": a field the first run does not capture
 * is a question the dataset can never answer.
 *
 * Storage: JSONL under `data/runs/`, append-only, never rewritten. Analysis is
 * DuckDB over the glob. Bump `SCHEMA_VERSION` on any change and leave old rows
 * alone — readers switch on the version.
 *
 * ## Version history
 *
 * - **1** — the pre-runner sketch. No data was ever written at that version.
 * - **2** — what the runner actually writes. Additions, all forced by building
 *   it:
 *   - `probes[]`, per round and per attempt. The Aven gate is `check` AND `test`
 *     both passing, but one bit would hide check/test divergence, which is a
 *     language finding in its own right. A probe list also lets Python carry
 *     `mypy` as *data* rather than as a gate (`gating: false`), and lets an
 *     unavailable tool say `ok: null` instead of lying.
 *   - `checkOk` / `checkOkSolutionOnly` / `testOk` / `mypyOk` — flat mirrors of
 *     the probes, because a one-line DuckDB query beats unnesting for the
 *     questions that get asked constantly. `checkOkSolutionOnly` exists because
 *     many generated Aven suites fail `aven check` for reasons that have nothing
 *     to do with the model's solution; without it those tasks are
 *     unconditionally red and the data cannot separate the two causes.
 *   - `costUsd: number | null` (was `number`) plus `priceSource`,
 *     `priceTableVersion`, `reportedCostUsd`. Cost is computed from the local
 *     table; a model with no entry records `null`, not a fabricated 0.
 *     `reportedCostUsd` keeps what the harness claimed, for comparison only.
 *   - `toolPolicy` / `suiteVisibility` — whether the model was told it may run the
 *     compiler itself, and whether it could read the generated suite.
 *     `firstShotPass` means nothing without both.
 *   - `modelToolInvocations` — `aven` invocations the *model* made in a round,
 *     counted from the session log. Measures compliance with `no-verify`.
 *   - `harnessError`, `outcomeDetail`, `timedOut`, `roundsUsed`, `maxRounds`.
 *   - `avenBinarySha256`, `runnerVersion`, `startedAt`, `finishedAt`,
 *     `agentWallMs`, `gateWallMs`, `sessionLogHash`, `promptHash`, `suiteHash`,
 *     `casesExcludedByIntersect`, `cachedPromptTokens`, `reasoningTokens`,
 *     `tokenEstimator`, `agentSessionRef`, `workDir`.
 * - **3** — containment and the experiment-policy fields needed to audit it:
 *   - `shellCommands`, per round and summed on the attempt. Structured file-tool
 *     paths missed the model's filesystem searches through `bash`; this counts
 *     those invocations even when their effect cannot be reconstructed.
 *   - `sandbox` records `bubblewrap` or the explicit debugging opt-out `none`.
 *     Silent fallback is forbidden, so the field says what actually ran.
 *   - `toolPolicy`, `suiteVisibility` and `sandbox` join the natural key. A row
 *     produced under one policy must not make resume skip a different experiment.
 */

export const SCHEMA_VERSION = 3 as const;

/** How `solutionTokens` / `docTokens` were counted. Not a real BPE tokenizer. */
export const TOKEN_ESTIMATOR = "heuristic-v1" as const;

export type Outcome =
  | "pass"
  | "wrong_output"
  | "runtime_error"
  | "check_error"
  | "parse_error"
  | "timeout"
  | "refusal"
  | "harness_error";

export type TaskSet = "tune" | "holdout";
export type TaskSource = "exercism" | "design-center" | "rosetta";

/**
 * Whether the model was allowed to compile or run the suite before submitting.
 * `no-verify` is the default: `firstShotPass` is meant to measure the
 * documentation, and an agent that loops on the compiler measures the compiler
 * instead. Recorded because it is the difference between two incomparable
 * experiments.
 */
export type ToolPolicy = "no-verify" | "self-verify";

/**
 * Whether the model could read the generated suite while it worked.
 *
 * `hidden` is the default: the suite is written into the work directory only for
 * the gate and removed again, so a model cannot pattern-match the expected values
 * instead of implementing the algorithm. `visible` is what an Exercism user sees.
 *
 * Recorded because the two are not comparable — and because hiding is only total
 * in round 0: from round 1 the repair prompt quotes assertion messages, which name
 * actual and expected values, and Aven compiler output can quote a generated
 * suite source line.
 */
export type SuiteVisibility = "visible" | "hidden";

/** Filesystem containment applied to the model-driven agent harness. */
export type SandboxMode = "bubblewrap" | "none";

/** One diagnostic, flattened out of `aven check --format json`. */
export type GateDiagnostic = {
  code: string;
  severity: string;
  message: string;
  /** File it points at, relative to the work directory where possible. */
  path: string | null;
  line: number | null;
  column: number | null;
};

/**
 * One tool invocation in the gate.
 *
 * `gating: false` means "recorded, does not decide the verdict" — that is how
 * `mypy` is carried on the Python arm. `ok: null` means the tool could not be
 * run at all, which is different from the tool saying no.
 */
export type GateProbe = {
  name: string;
  gating: boolean;
  ok: boolean | null;
  exitCode: number | null;
  wallMs: number;
  timedOut: boolean;
  diagnosticCodes: string[];
  diagnostics: GateDiagnostic[];
  /** First meaningful line of output; for eyeballing a row. */
  detail: string | null;
  /** Set when the tool itself could not be run (missing binary, spawn failure). */
  unavailableReason: string | null;
  /**
   * Version of the tool that ran, when it reports one cheaply (`mypy --version`).
   * Null for probes whose version is already pinned elsewhere in the record —
   * `aven` by `avenCommit` + `avenBinarySha256`, the suite by `languageVersion`.
   */
  toolVersion: string | null;
};

export type CaseResult = {
  name: string;
  outcome: string;
  message: string;
};

/** The verdict for one round: every probe, plus the case counts. */
export type GateResult = {
  /** Every *gating* probe said ok. */
  ok: boolean;
  probes: GateProbe[];
  casesTotal: number;
  casesPassed: number;
  casesFailed: number;
  casesErrored: number;
  /** Bounded sample of failing cases, for the repair prompt and for humans. */
  failedCases: CaseResult[];
  outcome: Outcome;
  detail: string | null;
};

/** One turn of the repair loop. Round 0 is the first shot. */
export type RepairRound = {
  round: number;
  /**
   * The prompt this round sent, content-addressed. §7 says the diagnostics work
   * starts by *reading the repair transcripts*; without this the text the model
   * was shown — the diagnostic under measurement — is gone.
   */
  promptHash: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  /** What the harness claimed. Never used to compute `costUsd`. */
  reportedCostUsd: number | null;
  /** Diagnostic codes emitted by this round's compile/test, in order. */
  diagnosticCodes: string[];
  outcome: Outcome;
  casesPassed: number;
  casesTotal: number;
  /** Per-probe verdicts, so check/test divergence is queryable per round. */
  probes: GateProbe[];
  wallMs: number;
  agentWallMs: number;
  gateWallMs: number;
  timedOut: boolean;
  harnessError: string | null;
  /** Content-addressed source produced by this round; null when none was written. */
  artifactHash: string | null;
  solutionBytes: number;
  solutionLoc: number;
  solutionTokens: number;
  /** The harness's own log for this round, content-addressed. */
  agentLogHash: string | null;
  /** `aven` invocations the model made itself this round; null off the Aven arm. */
  modelToolInvocations: number | null;
  /**
   * Paths the harness touched outside the work directory.
   *
   * Not paranoia. On the first real sweep opencode resolved its project root to
   * the enclosing git repository and read `references/acronym/solution.av` — the
   * hand-written answer — before "solving" acronym. On an unsandboxed row any
   * nonzero value makes the row suspect; on a bubblewrap row it records an
   * attempted path whose access the namespace denied. `escapedPaths` keeps a
   * bounded sample for triage.
   */
  outsideWorkdirTouches: number;
  escapedPaths: string[];
  /**
   * Shell commands the harness ran this round. Should be 0 under
   * `toolPolicy: "no-verify"`; on the Aven arm it is routinely not, and a shell
   * can read anything, so this is the second half of `outsideWorkdirTouches`.
   */
  shellCommands: number;
};

export type AttemptRecord = {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  attemptId: string;
  runnerVersion: string;
  startedAt: string;
  finishedAt: string;

  taskId: string;
  taskSource: TaskSource;
  taskSet: TaskSet;
  /** Cases the language adapter could not express, so pass rates stay honest. */
  casesOmitted: number;
  /** Cases dropped because a *sibling* arm could not express them (`--intersect`). */
  casesExcludedByIntersect: number;

  language: string;
  languageVersion: string;
  /** Pinned aven-lang commit; null for non-Aven arms. A/B pairs must match. */
  avenCommit: string | null;
  /** Hash of the binary actually used — a commit alone does not pin a build. */
  avenBinarySha256: string | null;

  /** Skill-doc variant under test; null when no doc was supplied. */
  docId: string | null;
  docHash: string | null;
  docTokens: number | null;

  modelId: string;
  provider: string;
  quantization: string | null;

  agentHarness: string;
  harnessVersion: string;
  /** The harness's own conversation id, when it has one. */
  agentSessionRef: string | null;

  sampleIndex: number;
  temperature: number | null;
  seed: number | null;
  toolPolicy: ToolPolicy;
  suiteVisibility: SuiteVisibility;
  /** `none` is reachable only through the explicit `--no-sandbox` debugging flag. */
  sandbox: SandboxMode;

  maxRounds: number;
  roundsUsed: number;
  repairRounds: RepairRound[];

  outcome: Outcome;
  outcomeDetail: string | null;
  harnessError: string | null;
  timedOut: boolean;
  /** The two headline metrics. */
  firstShotPass: boolean;
  roundsToGreen: number | null;

  casesPassed: number;
  casesTotal: number;

  /** Final-round probe verdicts. */
  probes: GateProbe[];
  /** Flat mirrors of `probes`. `null` = not applicable or unavailable. */
  checkOk: boolean | null;
  /** `check` ignoring diagnostics that point at the generated suite. */
  checkOkSolutionOnly: boolean | null;
  testOk: boolean | null;
  mypyOk: boolean | null;

  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  /** Computed from a local price table, never trusted from the harness. */
  costUsd: number | null;
  /** How `costUsd` was derived: a table entry, a known-free model, or nothing. */
  priceSource: "table" | "free" | "unknown";
  priceTableVersion: string;
  /** What the harness claimed it cost. Recorded for comparison only. */
  reportedCostUsd: number | null;

  wallMs: number;
  agentWallMs: number;
  gateWallMs: number;
  tokensPerSec: number | null;

  solutionBytes: number;
  solutionLoc: number;
  /** The size metric; LOC recorded but secondary. */
  solutionTokens: number;
  tokenEstimator: typeof TOKEN_ESTIMATOR;

  artifactHash: string | null;
  /** The prompt the model actually saw in round 0. */
  promptHash: string;
  /** The generated suite it was written against. */
  suiteHash: string;
  /** Full `AVEN_SESSION_LOG` for the attempt; null off the Aven arm. */
  sessionLogHash: string | null;
  /** Work directory. Relative to the repo root when inside it, else absolute. */
  workDir: string;
  /** Sum of `repairRounds[].outsideWorkdirTouches`; nonzero means suspect. */
  outsideWorkdirTouches: number;
  /** Sum of `repairRounds[].shellCommands`; nonzero under `no-verify` is a violation. */
  shellCommands: number;
};

/**
 * The natural key a resumable run skips on. Everything in it must be knowable
 * before the attempt is made, or resume degenerates into re-running everything.
 */
export function attemptKey(
  r: Pick<
    AttemptRecord,
    | "taskId"
    | "language"
    | "modelId"
    | "agentHarness"
    | "docId"
    | "sampleIndex"
    | "avenCommit"
    | "toolPolicy"
    | "suiteVisibility"
    | "sandbox"
  >,
): string {
  return [
    r.taskId,
    r.language,
    r.modelId,
    r.agentHarness,
    r.docId ?? "-",
    r.avenCommit ?? "-",
    r.sampleIndex,
    r.toolPolicy,
    r.suiteVisibility,
    r.sandbox,
  ].join(" ");
}
