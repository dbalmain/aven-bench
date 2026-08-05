/**
 * Codex adapter.
 *
 * Invocation, verified against the Codex CLI:
 *
 *   codex exec -C <workdir> -m <model> -s workspace-write \
 *     --skip-git-repo-check --json [-c model_reasoning_effort="<effort>"] -
 *
 * Unlike opencode, Codex reads the prompt from stdin. `--json` writes JSONL to
 * stdout, and every `turn.completed` carries a usage delta. Agentic runs can
 * complete several turns, so all such events are summed.
 *
 * Codex bills against a subscription but emits no cost field. The adapter
 * therefore reports `null`, never a fabricated zero or token-price estimate;
 * the runner records that with `priceSource: "unknown"`.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../runner/proc.ts";
import { bubblewrapCommand } from "../../runner/sandbox.ts";
import {
  emptyResult,
  type AgentAdapter,
  type AgentInvocation,
  type AgentResult,
  type ModelProbe,
  type ModelProbeResult,
} from "./common.ts";

type TurnUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
};

type CodexItem = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  changes?: { path?: string }[];
};

type Event = {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: string | { message?: string };
  item?: CodexItem;
  usage?: TurnUsage;
};

export type CodexUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  cachedWriteTokens: number;
  reasoningTokens: number;
  reportedCostUsd: null;
  sessionRef: string | null;
  assistantText: string;
  errors: string[];
  events: number;
  touchedPaths: string[];
  shellCommands: number;
};

const MAX_TOUCHED_PATHS = 200;
const PROBE_PROMPT = "Reply with exactly the word OK and nothing else.";

function pathsInCommand(command: string): string[] {
  return [...command.matchAll(/(?<![\w./-])\/[^\s"';|&()<>]+/g)].map((m) => m[0]);
}

function eventError(ev: Event): string {
  if (typeof ev.error === "string") return ev.error;
  return ev.error?.message ?? ev.message ?? "unknown codex error";
}

/** Fold the Codex JSONL stream into the adapter's accounting fields. */
export function parseCodexEvents(stdout: string): CodexUsage {
  const usage: CodexUsage = {
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
  const seenCommands = new Set<string>();
  const addPath = (path: string): void => {
    if (seenPaths.has(path) || seenPaths.size >= MAX_TOUCHED_PATHS) return;
    seenPaths.add(path);
    usage.touchedPaths.push(path);
  };

  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let ev: Event;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      ev = parsed as Event;
    } catch {
      // A killed process can leave a truncated final line; keep prior usage.
      continue;
    }
    usage.events++;
    if (ev.thread_id) usage.sessionRef = ev.thread_id;
    if (ev.type === "error" || ev.type === "turn.failed") usage.errors.push(eventError(ev));

    const item = ev.item;
    if (ev.type === "item.completed" && item?.type === "agent_message" && item.text) {
      usage.assistantText += `${item.text}\n`;
    }
    if (item?.type === "command_execution" && typeof item.command === "string") {
      const key = item.id ?? item.command;
      if (!seenCommands.has(key)) {
        seenCommands.add(key);
        usage.shellCommands++;
        for (const path of pathsInCommand(item.command)) addPath(path);
      }
    }
    if (item?.type === "file_change") {
      for (const change of Array.isArray(item.changes) ? item.changes : []) {
        if (change.path) addPath(change.path);
      }
    }
    if (ev.type === "turn.completed") {
      usage.promptTokens += ev.usage?.input_tokens ?? 0;
      usage.completionTokens += ev.usage?.output_tokens ?? 0;
      usage.reasoningTokens += ev.usage?.reasoning_output_tokens ?? 0;
      usage.cachedPromptTokens += ev.usage?.cached_input_tokens ?? 0;
      usage.cachedWriteTokens += ev.usage?.cache_write_input_tokens ?? 0;
    }
  }
  return usage;
}

function codexBin(): string {
  return process.env["CODEX_BIN"] ?? "codex";
}

function codexCommand(bin: string, dir: string, model: string, variant: string | null): string[] {
  const command = [
    bin,
    "exec",
    "-C",
    dir,
    "-m",
    model,
    "-s",
    "workspace-write",
    "--skip-git-repo-check",
    "--json",
  ];
  if (variant) command.push("-c", `model_reasoning_effort="${variant}"`);
  command.push("-");
  return command;
}

const versionCache = new Map<string, string>();

export const codexAdapter: AgentAdapter = {
  id: "codex",
  // `codex exec resume` was not part of the verified invocation for this slice.
  supportsResume: false,

  async version(): Promise<string> {
    const bin = codexBin();
    const cached = versionCache.get(bin);
    if (cached) return cached;
    const proc = await runProcess([bin, "--version"], { cwd: process.cwd(), timeoutMs: 30_000 });
    const version = proc.spawnError ? "unknown" : (proc.stdout.trim().split("\n")[0] ?? "unknown");
    versionCache.set(bin, version);
    return version;
  },

  async available(): Promise<{ ok: boolean; detail: string }> {
    const bin = codexBin();
    const proc = await runProcess([bin, "--version"], { cwd: process.cwd(), timeoutMs: 30_000 });
    if (proc.spawnError) return { ok: false, detail: `cannot run ${bin}: ${proc.spawnError}` };
    return { ok: proc.exitCode === 0, detail: proc.stdout.trim() || proc.stderr.trim() };
  },

  async run(inv: AgentInvocation): Promise<AgentResult> {
    let argv: string[];
    try {
      const configuredBin = codexBin();
      const bin =
        inv.sandbox === "bubblewrap"
          ? realpathSync(Bun.which(configuredBin) ?? configuredBin)
          : configuredBin;
      const command = codexCommand(bin, inv.dir, inv.model, inv.variant);
      argv =
        inv.sandbox === "bubblewrap"
          ? bubblewrapCommand(command, {
              dir: inv.dir,
              language: inv.language,
              avenBin: inv.avenBin,
              harness: "codex",
            })
          : command;
    } catch (err) {
      return emptyResult({ harnessError: `cannot configure agent sandbox: ${String(err)}` });
    }

    const proc = await runProcess(argv, {
      cwd: inv.dir,
      timeoutMs: inv.timeoutMs,
      env: inv.env,
      stdin: inv.prompt,
    });
    if (proc.spawnError) {
      return emptyResult({
        harnessError: `codex could not be started: ${proc.spawnError}`,
        wallMs: proc.wallMs,
        log: proc.stderr,
      });
    }
    const usage = parseCodexEvents(proc.stdout);
    const log = `# argv: ${argv.join(" ")} <prompt via stdin>\n# exit: ${proc.exitCode}\n${proc.stdout}\n--- stderr ---\n${proc.stderr}`;

    const failed = proc.timedOut || proc.exitCode !== 0 || usage.errors.length > 0;
    return {
      ok: !failed,
      harnessError: proc.timedOut
        ? `codex timed out after ${inv.timeoutMs}ms`
        : usage.errors.length > 0
          ? usage.errors.join("; ")
          : proc.exitCode !== 0
            ? `codex exited ${proc.exitCode}: ${(proc.stderr.trim() || proc.stdout.trim()).slice(0, 300)}`
            : null,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedPromptTokens: usage.cachedPromptTokens,
      cachedWriteTokens: usage.cachedWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      reportedCostUsd: null,
      sessionRef: usage.sessionRef,
      wallMs: proc.wallMs,
      timedOut: proc.timedOut,
      log,
      assistantText: usage.assistantText.trim(),
      touchedPaths: usage.touchedPaths,
      shellCommands: usage.shellCommands,
    };
  },

  async probeModel(probe: ModelProbe): Promise<ModelProbeResult> {
    let dir: string | null = null;
    try {
      dir = mkdtempSync(join(tmpdir(), "aven-bench-preflight-"));
      const proc = await runProcess(codexCommand(codexBin(), dir, probe.model, probe.variant), {
        cwd: dir,
        timeoutMs: probe.timeoutMs,
        stdin: PROBE_PROMPT,
      });
      if (proc.spawnError) {
        return {
          ok: false,
          detail: `codex could not be started: ${proc.spawnError}`,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: null,
          wallMs: proc.wallMs,
        };
      }
      const usage = parseCodexEvents(proc.stdout);
      const reply = usage.assistantText.trim().split("\n")[0]?.slice(0, 120) ?? "";
      const detail = proc.timedOut
        ? `no reply within ${Math.round(probe.timeoutMs / 1000)}s`
        : usage.errors.length > 0
          ? usage.errors.join("; ")
          : proc.exitCode !== 0
            ? `codex exited ${proc.exitCode}: ${(proc.stderr.trim() || proc.stdout.trim()).slice(0, 200)}`
            : reply || "replied without any text";
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
        costUsd: null,
        wallMs: proc.wallMs,
      };
    } catch (err) {
      return {
        ok: false,
        detail: `codex probe failed: ${String(err)}`,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: null,
        wallMs: 0,
      };
    } finally {
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Probe cleanup cannot turn an otherwise valid result into a failure.
        }
      }
    }
  },
};
