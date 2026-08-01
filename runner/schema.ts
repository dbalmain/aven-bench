import type { ContaminationHit, ContaminationTier } from "./contamination.ts";

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
 *     counted from the session log. Structurally 0 under the default
 *     `sandbox: "bubblewrap"`, which exposes no `aven` binary; only meaningful
 *     under `self-verify` or `--no-sandbox`. `shellCommands` is what measures
 *     `no-verify` compliance.
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
 * - **6** — generated contracts state observed argument and successful-return
 *   shapes:
 *   - `contractGeneration` distinguishes the old name-and-arity-only prompt from
 *     `shapes-v1`. A calibration sweep already exists under the old contract, so
 *     commit dates are not an adequate provenance boundary.
 *   - The field joins the natural key. Otherwise resume would treat an old-prompt
 *     row as completion of the new experiment and silently skip it.
 * - **7** — contamination detection. Every task is a public Exercism exercise
 *   whose suite and worked answer are reachable over the network, and the
 *   sandbox runs `--share-net` because the agent must reach its provider, so
 *   `suiteVisibility: "hidden"` only ever meant *hidden locally*. Re-auditing
 *   existing logs found 14 of 143 rows fetching upstream material, six of them
 *   passes, all on the control arm — a bias that can only inflate the baseline
 *   and therefore manufacture an Aven gap. `contaminated` /
 *   `contaminationTier` / `upstreamHits` record it; `contractGeneration` moves
 *   to `shapes-v2` because the prompt now prohibits lookup.
 * - **8** — the nudge loop. 37 of 213 holdout rows scored `refusal`; none were
 *   refusals. Every one made zero tool calls and 36 answered with the finished
 *   program in a fenced block, `hello-world` among them. The split was 20 Aven /
 *   11 Ruby / 6 Python, so a harness-contract miss was being read as a language
 *   difference of up to 31 points. `maxNudges` / `nudges` record the deterministic
 *   re-ask and its cost. `contractGeneration` stays `shapes-v2`: the round-0
 *   prompt is untouched, so what the model is asked for has not changed — only
 *   what happens when it answers in the wrong channel.
 * - **9** — run-level free-text note (`runNote`), from the runner's `--note`.
 *   Intent is not recoverable from models/commits/task-sets alone; the note is
 *   copied onto every attempt so a new run is self-describing from the first
 *   row. Does **not** join the natural key: it is description, not experiment
 *   identity. The dashboard's tracked `run-notes.json` overrides this field
 *   when present (see `dashboard/notes.ts`).
 */

export const SCHEMA_VERSION = 9 as const;

/**
 * Generated task-contract policy embedded in every round-0 prompt.
 *
 * `shapes-v2` adds the no-lookup rule. It is a generation bump rather than a
 * silent edit because the instruction changes model behaviour, so rows either
 * side of it are not poolable.
 */
export const CONTRACT_GENERATION = "shapes-v2" as const;

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
 *
 * `agent-timeout` is the same *record* shape — no tokens, no solution — reached a
 * different way: the call hit `--agent-timeout` rather than returning empty. The
 * two were pooled until holdout-05, where `alphametics` and `satellite` timed out
 * at the 900s ceiling to the millisecond, twice each, while tasks that passed
 * routinely spent 1.5–2.2M ms across their rounds. Pooling them reads as "the
 * provider, not the model" and silently drops the slowest — which is to say the
 * hardest — tasks out of the denominator. A row that returns empty in 24s and a
 * row cut off mid-work at the ceiling are different events and want different
 * fixes: chase the provider, or raise the ceiling.
 *
 * Both still count toward the circuit breaker. A dead provider's original
 * signature was ten consecutive 420s zero-token rows, so exempting timeouts would
 * disarm the breaker for the case that motivated it.
 */
export type HarnessErrorKind =
  | "agent-no-tokens"
  | "agent-timeout"
  | "agent-failed"
  | "gate-unavailable"
  | "runner-exception";

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
  /**
   * Extra "you wrote no file" turns this round needed (see `buildNudgePrompt`).
   *
   * Their tokens, cost and wall time are folded into this round's totals — a
   * nudge is part of what the round cost — but the count stays separate so a
   * rescued attempt is never mistaken for one that got it right unaided.
   */
  nudges: number;
  /** Content-addressed source produced by this round; null when none was written. */
  artifactHash: string | null;
  solutionBytes: number;
  solutionLoc: number;
  solutionTokens: number;
  /** The harness's own log for this round, content-addressed. */
  agentLogHash: string | null;
  /**
   * `aven` invocations the model made itself this round; null off the Aven arm.
   *
   * Expect 0 on any sandboxed row: bubblewrap exposes neither the aven-lang
   * checkout nor a built binary, so the model has nothing to invoke. A nonzero
   * value is only reachable under `self-verify` (with `AVEN_BIN`) or
   * `--no-sandbox`. Do not read 0 here as evidence the model ran no tools —
   * that is `shellCommands`.
   */
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
  /**
   * Evidence this round fetched upstream Exercism material — the canonical
   * suite, the worked example, or the exercise page. See `contamination.ts`.
   *
   * `escapedPaths` is not a substitute: it caps at 8 entries per round and only
   * sees URLs the path extractor happened to recognise, which is why it showed
   * 2 affected rows where a log scan finds 14.
   */
  upstreamHits: ContaminationHit[];
};

export type AttemptRecord = {
  schemaVersion: typeof SCHEMA_VERSION;
  contractGeneration: typeof CONTRACT_GENERATION;
  runId: string;
  attemptId: string;
  runnerVersion: string;
  startedAt: string;
  finishedAt: string;

  /**
   * Free-text note for the whole run (`--note` on the CLI). Same value on every
   * row of a run. Null when the operator did not pass one.
   *
   * Human intent only — never machine-read for resume, scoring, or identity.
   * Dashboard display prefers the committed `run-notes.json` entry when that
   * description is non-empty (post-hoc edits beat the launch-time flag).
   */
  runNote: string | null;

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

  /**
   * Nudge budget per round, and how much of it was spent (see `buildNudgePrompt`).
   *
   * `nudges` is the whole point of recording this: it is the rate at which the
   * model answered in chat instead of writing the file, which is a property of
   * the harness contract and not of the language. `--max-nudges 0` reproduces the
   * old behaviour exactly, and joins the natural key so an ablation resumes
   * against the right rows instead of the nudged ones.
   */
  maxNudges: number;
  nudges: number;

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

  /**
   * True when this attempt fetched the suite or the worked answer, making its
   * outcome a measurement of retrieval rather than of unaided ability.
   *
   * Deliberately **not** folded into `outcome`. The attempt really was measured
   * — unlike a zero-token harness error, where nothing happened — so the pass
   * or failure is a real event that simply answers a different question.
   * Keeping the axes separate is also what makes "how often does fetching the
   * tests actually work?" queryable, which is worth knowing.
   */
  contaminated: boolean;
  /** Most severe evidence found, or null when clean. */
  contaminationTier: ContaminationTier | null;
  /** Distinct detector rules that fired, for triage without reading logs. */
  contaminationRules: string[];
  /** Sum of `repairRounds[].upstreamHits.length`. */
  upstreamLookups: number;
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
    // Required, not optional: an optional `maxNudges` let a caller omit it and
    // build a key that could never match the one `loadResumeIndex` derives from
    // the recorded row, which silently re-buys an entire sweep. Legacy rows that
    // predate the field still read as `undefined` at runtime, which is what the
    // `nudges<N>` segment below is written to tolerate.
    | "maxNudges"
  > & { contractGeneration: string },
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
    // Rows written before schema 6 have no field at runtime. Naming that legacy
    // generation keeps their resume keys stable and distinct from shapes-v1.
    r.contractGeneration ?? "names-v0",
    // Rows written before schema 8 had no nudge loop, which is `--max-nudges 0`.
    // Appended only when nonzero so those keys stay byte-identical: a `0`
    // ablation then resumes against the existing rows instead of re-buying them.
    ...(r.maxNudges ? [`nudges${r.maxNudges}`] : []),
  ].join(" ");
}
