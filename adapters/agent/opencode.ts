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
 * `cost`. Both the token counts and the **bill** come from there.
 *
 * `cost` is real on paid models and 0 on the free tier, which is simply true.
 * Measured on `opencode-go/qwen3.7-max`: turn 1 billed $0.02788375, turn 2
 * $0.0048275, and the session total came to $0.03271125 — so per-turn costs are
 * deltas that sum to the session, and rounds can be added without double
 * counting. That measurement is also why `cache.write` is now kept: turn 1 was 6
 * input and 20 output tokens against 8 870 cache writes, so the charge is
 * essentially all cache-write and no input/output rate can reproduce it.
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

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bubblewrapCommand } from "../../runner/sandbox.ts";
import { runProcess } from "../../runner/proc.ts";
import {
  emptyResult,
  type AgentAdapter,
  type AgentInvocation,
  type AgentResult,
  type ModelProbe,
  type ModelProbeResult,
  type SessionLedger,
  type SessionLedgerQuery,
} from "./common.ts";

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
  cachedWriteTokens: number;
  reasoningTokens: number;
  reportedCostUsd: number | null;
  sessionRef: string | null;
  assistantText: string;
  errors: string[];
  events: number;
  /** Absolute paths the tool calls named, deduplicated in first-seen order. */
  touchedPaths: string[];
  /** `bash` tool calls. A shell can reach anything, so it is counted separately. */
  shellCommands: number;
};

/** Tool inputs that name a filesystem location, across opencode's tool set. */
const PATH_KEYS = ["filePath", "path", "file", "directory"] as const;
const MAX_TOUCHED_PATHS = 200;

/**
 * Absolute paths mentioned anywhere in a shell command.
 *
 * The structured path arguments (`read`, `glob`, …) are only half the story: the
 * Aven arm's models did their searching through `bash`, whose only input is a
 * command string. `ls /home/…`, `find /home/dave/.cache/aven-bench -name
 * "solution_test.av"` and `cat …/references/two-fer/solution.av` all appeared in
 * a real run, and none of them named a path in a field this could read. Scanning
 * the command text is coarse — it cannot know what the command did — but a run
 * that mentions a path outside the work directory is exactly what should be
 * flagged as suspect.
 */
function pathsInCommand(command: string): string[] {
  return [...command.matchAll(/(?<![\w./-])\/[^\s"';|&()<>]+/g)].map((m) => m[0]);
}

/** Fold the event stream into usage. Exported for tests: this is the fiddly part. */
export function parseEvents(stdout: string): OpencodeUsage {
  const usage: OpencodeUsage = {
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    reportedCostUsd: null,
    sessionRef: null,
    assistantText: "",
    errors: [],
    events: 0,
    touchedPaths: [],
    shellCommands: 0,
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
      const command = input["command"];
      if (ev.part?.tool === "bash" || typeof command === "string") {
        usage.shellCommands++;
        if (typeof command === "string") {
          for (const p of pathsInCommand(command)) {
            if (seenPaths.has(p) || seenPaths.size >= MAX_TOUCHED_PATHS) continue;
            seenPaths.add(p);
            usage.touchedPaths.push(p);
          }
        }
      }
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
      usage.cachedWriteTokens += t?.cache?.write ?? 0;
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

type OpencodeCommandInvocation = Pick<
  AgentInvocation,
  "dir" | "model" | "variant" | "sessionRef" | "prompt"
>;

/** Build the unsandboxed argv. Exported to lock optional-variant behaviour in tests. */
export function opencodeCommand(bin: string, inv: OpencodeCommandInvocation): string[] {
  const command = [
    bin,
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
  if (inv.variant) command.push("--variant", inv.variant);
  // Continuing the session is what makes a repair round a *conversation*; a
  // fresh session would measure "can it fix code it has never seen".
  if (inv.sessionRef) command.push("--session", inv.sessionRef);
  command.push(inv.prompt);
  return command;
}

/**
 * The liveness question, kept as small as a prompt can be.
 *
 * Deliberately answerable without a tool call, so a model that is merely slow at
 * agentic work still passes and only an unreachable one fails.
 */
const PROBE_PROMPT = "Reply with exactly the word OK and nothing else.";

/**
 * Where opencode's SQLite store lives for a given attempt.
 *
 * A sandboxed run does not write to this machine's opencode database: the
 * bubblewrap profile binds `<dir>/.agent-state/data` over `~/.local/share/opencode`
 * so the session store is attempt-local (that is what makes `--session` resume
 * work across rounds without leaking the host's 80 other sessions into the
 * model's project scan). So the ledger has to be looked up where the run actually
 * put it, and `opencode export` on the host would find nothing.
 */
function ledgerPath(query: SessionLedgerQuery): string {
  if (query.sandbox === "bubblewrap") {
    return join(query.dir, ".agent-state", "data", "opencode.db");
  }
  const hostData = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local/share");
  return join(hostData, "opencode", "opencode.db");
}

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
    let argv: string[];
    try {
      const opencodeBin =
        inv.sandbox === "bubblewrap"
          ? realpathSync(Bun.which(OPENCODE_BIN) ?? OPENCODE_BIN)
          : OPENCODE_BIN;
      const command = opencodeCommand(opencodeBin, inv);
      argv =
        inv.sandbox === "bubblewrap"
          ? bubblewrapCommand(command, {
              dir: inv.dir,
              language: inv.language,
              avenBin: inv.avenBin,
              harness: "opencode",
            })
          : command;
    } catch (err) {
      return emptyResult({ harnessError: `cannot configure agent sandbox: ${String(err)}` });
    }

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
      cachedWriteTokens: usage.cachedWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      reportedCostUsd: usage.reportedCostUsd,
      sessionRef: usage.sessionRef,
      wallMs: proc.wallMs,
      timedOut: proc.timedOut,
      log,
      assistantText: usage.assistantText.trim(),
      touchedPaths: usage.touchedPaths,
      shellCommands: usage.shellCommands,
    };
  },

  /**
   * Is this one model answering?
   *
   * Verified by hand on the gateway: `opencode/big-pickle` and
   * `opencode/deepseek-v4-flash-free` hung past 120s on this exact prompt while
   * `opencode/ling-3.0-flash-free` and `opencode/north-mini-code-free` answered in
   * about a second — and `opencode --version` was happy throughout, which is why
   * `available()` cannot answer this.
   *
   * Not sandboxed, and not run in a work directory. A throwaway `--dir` outside
   * this repository is what stops opencode taking aven-bench as its project root
   * (the contamination lesson), and there is no task, no suite and no record here
   * for a stray read to corrupt. `--session` is not passed: a probe must not
   * become part of any attempt's conversation.
   */
  async probeModel(probe: ModelProbe): Promise<ModelProbeResult> {
    const dir = mkdtempSync(join(tmpdir(), "aven-bench-preflight-"));
    try {
      const proc = await runProcess(
        [
          OPENCODE_BIN,
          "run",
          "--model",
          probe.model,
          "--log-level",
          "ERROR",
          "--format",
          "json",
          "--dir",
          dir,
          ...(probe.variant ? ["--variant", probe.variant] : []),
          PROBE_PROMPT,
        ],
        { cwd: dir, timeoutMs: probe.timeoutMs },
      );
      if (proc.spawnError) {
        return {
          ok: false,
          detail: `opencode could not be started: ${proc.spawnError}`,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: null,
          wallMs: proc.wallMs,
        };
      }
      const usage = parseEvents(proc.stdout);
      const reply = usage.assistantText.trim().split("\n")[0]?.slice(0, 120) ?? "";
      const detail = proc.timedOut
        ? `no reply within ${Math.round(probe.timeoutMs / 1000)}s`
        : usage.errors.length > 0
          ? usage.errors.join("; ")
          : proc.exitCode !== 0
            ? `opencode exited ${proc.exitCode}: ${(proc.stderr.trim() || proc.stdout.trim()).slice(0, 200)}`
            : reply || "replied without any text";
      // A reply with no tokens at all is the same silent-provider shape the
      // breaker watches for downstream, so it fails preflight here too.
      const ok =
        !proc.timedOut &&
        proc.exitCode === 0 &&
        usage.errors.length === 0 &&
        usage.promptTokens + usage.completionTokens > 0;
      return {
        ok,
        detail,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        costUsd: usage.reportedCostUsd,
        wallMs: proc.wallMs,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  /**
   * opencode's own running total for the session — the number its UI shows.
   *
   * Read straight out of its SQLite store, read-only, via bun's built-in driver
   * (the repo has no runtime dependencies and this keeps it that way). The
   * `session` table carries `cost` and the five token counters as columns, so
   * this needs no knowledge of its message format.
   *
   * Every failure path returns null. This figure exists to audit the event
   * parsing; it must never be able to turn a finished attempt into an error.
   */
  async sessionLedger(query: SessionLedgerQuery): Promise<SessionLedger | null> {
    const path = ledgerPath(query);
    if (!existsSync(path)) return null;
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(path, { readonly: true });
      try {
        const row = db
          .query(
            "SELECT cost, tokens_input, tokens_output, tokens_reasoning," +
              " tokens_cache_read, tokens_cache_write FROM session WHERE id = ?",
          )
          .get(query.sessionRef) as Record<string, number> | null;
        if (!row) return null;
        return {
          costUsd: row["cost"] ?? 0,
          tokens: {
            input: row["tokens_input"] ?? 0,
            output: row["tokens_output"] ?? 0,
            reasoning: row["tokens_reasoning"] ?? 0,
            cacheRead: row["tokens_cache_read"] ?? 0,
            cacheWrite: row["tokens_cache_write"] ?? 0,
          },
        };
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  },
};
