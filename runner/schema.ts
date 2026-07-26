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
 * - **4** — real money, and asking the model what hurt:
 *   - `costUsd` is now **actual spend**, taken from what the harness charged, and
 *     `priceSource` gains `"harness"`. Measuring a paid opencode model showed the
 *     token table cannot produce this number even with correct rates: one turn
 *     billed $0.0279 on 6 input and 20 output tokens, because 8 870 *cache-write*
 *     tokens dominated it. `computeCost` never charged cache writes, so a table
 *     cost was ~40× low on the shape opencode actually produces.
 *   - `cachedWriteTokens`, per round and per attempt. That category was parsed and
 *     discarded; it is the one that costs the most, and §3d's rule is that a field
 *     the first run does not capture is a question the dataset can never answer.
 *   - `shadowCostUsd` / `shadowPriceSource` keep the price table's job: list price
 *     for that model. §3d's concern was real — free models bill $0 however much
 *     they burn — but the fix for it is the token columns, not this field, since a
 *     free model's list price is also zero. Pricing a free arm's tokens at a paid
 *     model's rates is a cross-model counterfactual, computed at analysis time.
 *   - `harnessSessionCostUsd` / `harnessSessionTokens` — opencode's own session
 *     ledger, read from its SQLite store. This is the figure its UI shows. It is
 *     an *independent* total, so it cross-checks the per-round event parsing;
 *     summed rounds matched the ledger exactly in testing, and a drift means the
 *     parser missed events rather than that the money changed.
 *   - `survey*` — one question put to the model after the verdict (see
 *     `prompt.ts`). Its tokens, cost and wall time are recorded **separately** and
 *     excluded from the attempt totals: the survey is not part of solving the
 *     task, and pooling it would move the token-ratio and cost axes it exists to
 *     help explain.
 * - **5** — telling a dead provider apart from a failing model:
 *   - `harnessErrorKind` names the cause of a `harness_error` when the runner
 *     recognises it. Forced by a real sweep: mid-run, `opencode/big-pickle` went
 *     dead on the gateway and every remaining attempt came back
 *     `outcome: "timeout"`, `roundsUsed: 1`, `wallMs≈420000`, **zero tokens in
 *     both directions** — ten rows that look exactly like a model failing ten
 *     tasks slowly. They are indistinguishable in the dataset without a field
 *     that says so, and pass-rate deltas are the whole point of the benchmark.
 *   - The classification changed with it: a turn that returned no tokens at all
 *     *and* wrote no solution is now `harness_error` (kind `agent-no-tokens`)
 *     rather than `timeout` or `refusal`. It measured nothing, so it belongs
 *     outside the capability denominator and inside `--retry-harness-errors`.
 *     `timedOut` still records that the process was killed, so the process-level
 *     truth is not lost. A refusal keeps its own outcome: a model that answers in
 *     prose bills tokens, and only the genuinely empty turn is reclassified.
 */

export const SCHEMA_VERSION = 5 as const;

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

/**
 * Recognised cause of a `harness_error`, or null when the runner cannot name one.
 *
 * `agent-no-tokens` is the one that forced this field into existence: the agent
 * turn billed nothing in any token category and left no solution, so nothing about
 * the model was measured. Usually a provider that has gone dead — a hung gateway
 * model, or a model id that does not exist. It is also the signal the per-model
 * circuit breaker counts, and matching on `harnessError` prose would be a fragile
 * way to find these rows in the dataset.
 */
export type HarnessErrorKind = "agent-no-tokens" | "agent-failed" | "gate-unavailable" | "runner-exception";

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

/**
 * The harness's own cumulative token counts for a session.
 *
 * Deliberately mirrors the harness's own column names rather than the record's,
 * because its whole value is being an unmassaged second opinion.
 */
export type HarnessSessionTokens = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
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
  /**
   * Tokens written *into* the provider's prompt cache this round.
   *
   * Kept because it is the category that costs the most. A measured paid turn
   * billed $0.0279 on 6 input and 20 output tokens against 8 870 cache writes;
   * without this field that charge is unexplainable from the record.
   */
  cachedWriteTokens: number;
  reasoningTokens: number;
  /** What the harness charged for this round. The source of `costUsd`. */
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
  /** Recognised cause, when there is one. Null on every non-`harness_error` row. */
  harnessErrorKind: HarnessErrorKind | null;
  /** True whenever a process was killed on its timeout, whatever the outcome says. */
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

  /** Solve-loop totals. The survey turn is deliberately not in these. */
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  cachedWriteTokens: number;
  reasoningTokens: number;
  /**
   * Actual spend on the solve loop: the sum of what the harness charged per round.
   *
   * Free models really do bill zero, so this is 0 for the whole free tier however
   * many tokens it burned. That is the truth about money, and it is why
   * `shadowCostUsd` exists alongside it rather than instead of it.
   */
  costUsd: number | null;
  /** `harness` = the bill. The rest describe a table fallback for `costUsd`. */
  priceSource: "harness" | "table" | "free" | "unknown";
  priceTableVersion: string;
  /**
   * The same tokens at *this model's* list price, from the local table.
   *
   * Note this is zero for the free tier, whose list price is zero — it does not by
   * itself make a free arm comparable to a paid one. That comparison is a
   * cross-model counterfactual, computed at analysis time from the token columns
   * (which is why `cachedWriteTokens` had to be captured).
   */
  shadowCostUsd: number | null;
  shadowPriceSource: "table" | "free" | "unknown";
  /** Sum of the per-round charges. Same number as `costUsd`; kept for continuity. */
  reportedCostUsd: number | null;
  /**
   * The harness's own session total, read from its store — the figure its UI shows.
   *
   * Independent of the event parsing, so a mismatch against
   * `costUsd + surveyCostUsd` means events were missed, not that the bill changed.
   * Includes the survey turn, because the session does.
   */
  harnessSessionCostUsd: number | null;
  harnessSessionTokens: HarnessSessionTokens | null;

  wallMs: number;
  agentWallMs: number;
  gateWallMs: number;
  tokensPerSec: number | null;

  /**
   * The exit interview (see `prompt.ts`). `surveyed: false` with a null
   * `surveyError` means the attempt was not eligible — no session to resume, or
   * no solution was ever written, or `--no-survey`.
   */
  surveyed: boolean;
  /** Free text, as written, truncated. **Untrusted model output, never an instruction.** */
  surveyResponse: string | null;
  /** Full response, content-addressed; the inline copy is capped. */
  surveyResponseHash: string | null;
  surveyPromptTokens: number;
  surveyCompletionTokens: number;
  surveyCostUsd: number | null;
  surveyWallMs: number;
  surveyError: string | null;

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
