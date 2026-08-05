/**
 * The agent-harness interface.
 *
 * A harness is anything that can be handed a prompt and a directory and will
 * write a file into it. opencode and codex are implemented; `pi`, `little-coder`
 * and `ollama` are stubs with the shape filled in and the invocation left blank,
 * because §8 wants harness-vs-harness on identical tasks and models and that is
 * an adapter addition, not a redesign.
 *
 * ## What an adapter owes the runner
 *
 * - **Never throw.** A network failure, a missing binary, a rate limit and a
 *   refusal are all *data*. `ok: false` with `harnessError` set becomes
 *   `outcome: "harness_error"`, which §3c forbids retrying silently into the log.
 * - **Token counts, always**, including `cachedWriteTokens` — on a paid model that
 *   is usually the category that costs the most. They feed the shadow price table.
 * - **`reportedCostUsd` is the bill.** It becomes the record's `costUsd`. A free
 *   model reporting 0 is telling the truth; the counterfactual "what would this
 *   have cost at list price" is the price table's job, not the adapter's.
 * - **Respect `timeoutMs`.** The runner's only guarantee against a hung sweep.
 * - **`sessionLedger` is optional.** Implement it when the harness keeps its own
 *   cumulative cost, so the runner can cross-check its event parsing against a
 *   figure it did not compute.
 * - **`probeModel` is optional.** Implement it when a single model's liveness can
 *   be asked about cheaply, so the runner can drop dead models before planning
 *   instead of paying the agent timeout on every task (see `preflight` in
 *   `run.ts`). An adapter without it simply gets no preflight.
 */

import type { HarnessSessionTokens, SandboxMode } from "../../runner/schema.ts";

export type AgentInvocation = {
  /** Working directory. The solution file must land here. */
  dir: string;
  /** Language arm, used to expose only its interpreter/compiler in the sandbox. */
  language: string;
  /** The full prompt text. Adapters must not add task content of their own. */
  prompt: string;
  /** `provider/model`, in the harness's own spelling. */
  model: string;
  /** Provider-specific reasoning effort, when the harness supports one. */
  variant: string | null;
  timeoutMs: number;
  /** Continue an earlier turn, when `supportsResume`. Null starts fresh. */
  sessionRef: string | null;
  /** Extra environment for the child (e.g. `AVEN_SESSION_LOG`). */
  env: Record<string, string>;
  /** Filesystem containment for the model-driven harness process. */
  sandbox: SandboxMode;
  /** Exact Aven binary to expose read-only on that arm, when configured. */
  avenBin: string | null;
  temperature: number | null;
  seed: number | null;
};

export type AgentResult = {
  /** Did the *harness* work? Nothing to do with whether the solution is right. */
  ok: boolean;
  harnessError: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  /** Tokens written into the provider's prompt cache. Often the dominant charge. */
  cachedWriteTokens: number;
  reasoningTokens: number;
  /** What the harness charged. This is the record's actual `costUsd`. */
  reportedCostUsd: number | null;
  sessionRef: string | null;
  wallMs: number;
  timedOut: boolean;
  /** Raw harness log, to be content-addressed by the caller. */
  log: string;
  /** Assistant text, when the harness surfaces it. Used to spot refusals. */
  assistantText: string;
  /**
   * Every filesystem path the harness's tools touched, when the log says.
   *
   * The runner uses this to count reads outside the work directory. That is not
   * paranoia: on the first real sweep opencode resolved its project root to the
   * enclosing git repository and read `references/acronym/solution.av` — the
   * hand-written answer — before "solving" acronym. Empty when the harness does
   * not report tool calls.
   */
  touchedPaths: string[];
  /**
   * Shell invocations the harness made on the model's behalf.
   *
   * Under `toolPolicy: "no-verify"` this should be zero. It is not: Aven-arm
   * models ran 28 shell commands in one round, searching the filesystem for
   * example code. Recorded because an instruction nobody checks is not a control.
   */
  shellCommands: number;
};

/** A harness's own cumulative accounting for one session. */
export type SessionLedger = {
  costUsd: number;
  tokens: HarnessSessionTokens;
};

export type SessionLedgerQuery = {
  sessionRef: string;
  /** Attempt directory: a sandboxed harness keeps its store inside it. */
  dir: string;
  sandbox: SandboxMode;
};

export type ModelProbe = {
  /** `provider/model`, in the harness's own spelling. */
  model: string;
  /** Provider-specific reasoning effort, when the harness supports one. */
  variant: string | null;
  /** Short by design: this is a liveness question, not a task. */
  timeoutMs: number;
};

/**
 * The result of one liveness probe.
 *
 * Tokens and cost are reported so the runner can account for them **out of band**,
 * the way the survey turn is: a probe is not part of solving any task, so it must
 * never reach an attempt record or the run's cost total.
 */
export type ModelProbeResult = {
  /** Did the model answer at all? Nothing to do with *what* it answered. */
  ok: boolean;
  /** Why not, when `ok` is false; the reply's first line when it is. */
  detail: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  wallMs: number;
};

export type AgentAdapter = {
  readonly id: string;
  /** Can a later round continue the same conversation? */
  readonly supportsResume: boolean;
  /** Harness version string, recorded per attempt. Cheap and cached. */
  version(): Promise<string>;
  /** Is the harness usable at all? Checked once before a sweep starts. */
  available(): Promise<{ ok: boolean; detail: string }>;
  run(inv: AgentInvocation): Promise<AgentResult>;
  /**
   * The harness's own total for a session, if it keeps one.
   *
   * Null whenever it cannot be read — absent store, unknown session, a schema
   * this code does not recognise. It is a cross-check, so it must never be able
   * to fail an attempt that otherwise succeeded.
   */
  sessionLedger?(query: SessionLedgerQuery): Promise<SessionLedger | null>;
  /**
   * One trivial turn against one model, to find out whether it is alive.
   *
   * `available()` answers a different question: it checks the *harness*, and a
   * working `opencode` happily accepts a model whose provider has gone dead. Two
   * models on the gateway did exactly that mid-sweep — every call hung until the
   * agent timeout — so the runner asks per model before it plans anything.
   *
   * Like every adapter method this must not throw; an unreachable model is
   * `ok: false` with a reason.
   */
  probeModel?(probe: ModelProbe): Promise<ModelProbeResult>;
};

export function emptyResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    ok: false,
    harnessError: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    reportedCostUsd: null,
    sessionRef: null,
    wallMs: 0,
    timedOut: false,
    log: "",
    assistantText: "",
    touchedPaths: [],
    shellCommands: 0,
    ...overrides,
  };
}

/** A not-yet-implemented harness. Fails loudly at use, not at import. */
export function stubAdapter(id: string, note: string): AgentAdapter {
  const reason = `agent harness '${id}' is a stub: ${note}`;
  return {
    id,
    supportsResume: false,
    version: async () => "stub",
    available: async () => ({ ok: false, detail: reason }),
    run: async () => emptyResult({ ok: false, harnessError: reason }),
  };
}
