/**
 * opencode adapter — the implemented harness.
 *
 * Invocation, verified against opencode 1.18.4:
 *
 *   opencode run --model <provider>/<model> --log-level ERROR --format json \
 *                --dir <workdir> "<prompt>"
 *
 * `--format json` writes newline-delimited events to stdout; `step_finish` events
 * carry `tokens: {total, input, output, reasoning, cache: {read, write}}` and
 * `cost`. That is where the token counts come from — the price table does the
 * rest, because every free model reports `cost: 0` regardless of usage.
 *
 * Two field notes worth keeping:
 *
 *  - A **cold** opencode start took ~2 minutes before the first event (provider
 *    setup); warm starts are ~6s end to end. Size timeouts for the cold case, or
 *    the first attempt of a sweep dies for a reason that has nothing to do with
 *    the model.
 *  - A **bad model id** exits 1 and emits a single `{"type":"error"}` event with
 *    `UnknownError`. That is the `harness_error` path, not a model failure.
 *
 * The prompt is passed as an argv positional, exactly as documented. Long prompts
 * are fine (the corpus statements plus a skill doc run to tens of KB, well inside
 * `ARG_MAX`), and the alternative — a file plus an instruction to read it — would
 * change what the model is measured on.
 */

import { runProcess } from "../../runner/proc.ts";
import { emptyResult, type AgentAdapter, type AgentInvocation, type AgentResult } from "./common.ts";

type Tokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
type Event = {
  type?: string;
  sessionID?: string;
  error?: { name?: string; data?: { message?: string } };
  part?: {
    type?: string;
    text?: string;
    tokens?: Tokens;
    cost?: number;
    tool?: string;
    state?: { input?: Record<string, unknown> };
  };
};

export type OpencodeUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  reportedCostUsd: number | null;
  sessionRef: string | null;
  assistantText: string;
  errors: string[];
  events: number;
  /** Absolute paths the tool calls named, deduplicated in first-seen order. */
  touchedPaths: string[];
};

/** Tool inputs that name a filesystem location, across opencode's tool set. */
const PATH_KEYS = ["filePath", "path", "file", "directory"] as const;
const MAX_TOUCHED_PATHS = 200;

/** Fold the event stream into usage. Exported for tests: this is the fiddly part. */
export function parseEvents(stdout: string): OpencodeUsage {
  const usage: OpencodeUsage = {
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    reportedCostUsd: null,
    sessionRef: null,
    assistantText: "",
    errors: [],
    events: 0,
    touchedPaths: [],
  };
  const seenPaths = new Set<string>();
  let sawCost = false;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let ev: Event;
    try {
      ev = JSON.parse(line) as Event;
    } catch {
      // opencode also prints non-JSON on some paths; ignore rather than fail.
      continue;
    }
    usage.events++;
    if (ev.sessionID) usage.sessionRef = ev.sessionID;
    if (ev.type === "error") {
      usage.errors.push(ev.error?.data?.message ?? ev.error?.name ?? "unknown opencode error");
    }
    if (ev.type === "text" && ev.part?.text) {
      usage.assistantText += `${ev.part.text}\n`;
    }
    if (ev.type === "tool_use") {
      const input = ev.part?.state?.input ?? {};
      for (const key of PATH_KEYS) {
        const value = input[key];
        if (typeof value !== "string" || value === "") continue;
        if (seenPaths.has(value) || seenPaths.size >= MAX_TOUCHED_PATHS) continue;
        seenPaths.add(value);
        usage.touchedPaths.push(value);
      }
    }
    if (ev.type === "step_finish") {
      const t = ev.part?.tokens;
      usage.promptTokens += t?.input ?? 0;
      usage.completionTokens += t?.output ?? 0;
      usage.reasoningTokens += t?.reasoning ?? 0;
      usage.cachedPromptTokens += t?.cache?.read ?? 0;
      if (typeof ev.part?.cost === "number") {
        usage.reportedCostUsd = (usage.reportedCostUsd ?? 0) + ev.part.cost;
        sawCost = true;
      }
    }
  }
  if (!sawCost) usage.reportedCostUsd = null;
  return usage;
}

const OPENCODE_BIN = process.env["OPENCODE_BIN"] ?? "opencode";

let versionCache: string | null = null;

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  supportsResume: true,

  async version() {
    if (versionCache) return versionCache;
    const proc = await runProcess([OPENCODE_BIN, "--version"], { cwd: process.cwd(), timeoutMs: 30_000 });
    versionCache = proc.spawnError ? "unknown" : proc.stdout.trim().split("\n")[0] ?? "unknown";
    return versionCache;
  },

  async available() {
    const proc = await runProcess([OPENCODE_BIN, "--version"], { cwd: process.cwd(), timeoutMs: 30_000 });
    if (proc.spawnError) return { ok: false, detail: `cannot run ${OPENCODE_BIN}: ${proc.spawnError}` };
    return { ok: proc.exitCode === 0, detail: proc.stdout.trim() || proc.stderr.trim() };
  },

  async run(inv: AgentInvocation): Promise<AgentResult> {
    const argv = [
      OPENCODE_BIN,
      "run",
      "--model",
      inv.model,
      "--log-level",
      "ERROR",
      "--format",
      "json",
      "--dir",
      inv.dir,
    ];
    // Continuing the session is what makes a repair round a *conversation*; a
    // fresh session would measure "can it fix code it has never seen".
    if (inv.sessionRef) argv.push("--session", inv.sessionRef);
    argv.push(inv.prompt);

    const proc = await runProcess(argv, {
      cwd: inv.dir,
      timeoutMs: inv.timeoutMs,
      env: inv.env,
    });
    if (proc.spawnError) {
      return emptyResult({
        harnessError: `opencode could not be started: ${proc.spawnError}`,
        wallMs: proc.wallMs,
        log: proc.stderr,
      });
    }
    const usage = parseEvents(proc.stdout);
    const log = `# argv: ${argv.slice(0, -1).join(" ")} <prompt>\n# exit: ${proc.exitCode}\n${proc.stdout}\n--- stderr ---\n${proc.stderr}`;

    const failed = proc.timedOut || proc.exitCode !== 0 || usage.errors.length > 0;
    return {
      ok: !failed,
      harnessError: proc.timedOut
        ? `opencode timed out after ${inv.timeoutMs}ms`
        : usage.errors.length > 0
          ? usage.errors.join("; ")
          : proc.exitCode !== 0
            ? `opencode exited ${proc.exitCode}: ${(proc.stderr.trim() || proc.stdout.trim()).slice(0, 300)}`
            : null,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedPromptTokens: usage.cachedPromptTokens,
      reasoningTokens: usage.reasoningTokens,
      reportedCostUsd: usage.reportedCostUsd,
      sessionRef: usage.sessionRef,
      wallMs: proc.wallMs,
      timedOut: proc.timedOut,
      log,
      assistantText: usage.assistantText.trim(),
      touchedPaths: usage.touchedPaths,
    };
  },
};
