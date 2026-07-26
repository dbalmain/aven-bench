/**
 * The agent-harness interface.
 *
 * A harness is anything that can be handed a prompt and a directory and will
 * write a file into it. opencode is the implemented one; `pi`, `little-coder`
 * and `ollama` are stubs with the shape filled in and the invocation left blank,
 * because §8 wants harness-vs-harness on identical tasks and models and that is
 * an adapter addition, not a redesign.
 *
 * ## What an adapter owes the runner
 *
 * - **Never throw.** A network failure, a missing binary, a rate limit and a
 *   refusal are all *data*. `ok: false` with `harnessError` set becomes
 *   `outcome: "harness_error"`, which §3c forbids retrying silently into the log.
 * - **Token counts, always.** They are the input to the local price table.
 *   `reportedCostUsd` is recorded but never used for `costUsd` — the free models
 *   report zero cost no matter how much they burn.
 * - **Respect `timeoutMs`.** The runner's only guarantee against a hung sweep.
 */

import type { SandboxMode } from "../../runner/schema.ts";

export type AgentInvocation = {
  /** Working directory. The solution file must land here. */
  dir: string;
  /** Language arm, used to expose only its interpreter/compiler in the sandbox. */
  language: string;
  /** The full prompt text. Adapters must not add task content of their own. */
  prompt: string;
  /** `provider/model`, in the harness's own spelling. */
  model: string;
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
  reasoningTokens: number;
  /** What the harness claims it cost. Recorded for comparison only. */
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

export type AgentAdapter = {
  readonly id: string;
  /** Can a later round continue the same conversation? */
  readonly supportsResume: boolean;
  /** Harness version string, recorded per attempt. Cheap and cached. */
  version(): Promise<string>;
  /** Is the harness usable at all? Checked once before a sweep starts. */
  available(): Promise<{ ok: boolean; detail: string }>;
  run(inv: AgentInvocation): Promise<AgentResult>;
};

export function emptyResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    ok: false,
    harnessError: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
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
