#!/usr/bin/env bun
/**
 * The runner. Non-interactive, parallel, resumable, hard-timeouts, `--dry-run`.
 *
 *   bun run bench --lang python --model opencode/deepseek-v4-flash-free \
 *                 --tasks two-fer,leap,acronym --rounds 2
 *
 * See `runner/README.md` for the full flag list and the acceptance recipe.
 *
 * Design notes that are not obvious from the flags:
 *
 *  - **Resume is by natural key** (`attemptKey`), read from every
 *    `data/runs/*.jsonl`, not just this run's file. Re-running the same command
 *    therefore adds nothing. `harness_error` rows count as present too, so a
 *    network blip is never quietly re-rolled into a model failure; pass
 *    `--retry-harness-errors` to deliberately try those keys again, which appends
 *    a new row and leaves the old one alone.
 *  - **Two concurrency caps.** `--agent-jobs` bounds calls into the harness (rate
 *    limits, and one opencode server per call); `--lang-jobs` bounds compiler and
 *    interpreter runs (CPU). `--jobs` bounds whole attempts, and defaults to the
 *    agent cap because that is the slow half.
 *  - **The environment is pinned at start**: the aven-lang commit, the hash of
 *    the `aven` binary in use, the Python version and the harness version all go
 *    into every row. A sweep whose compiler changed underneath it is detectable
 *    afterwards instead of being an unexplained step in the numbers.
 *  - **A model can die mid-sweep, so the runner watches for it.** Two defences,
 *    both bought with 45 minutes of wasted wall clock: every model is probed once
 *    before planning (`preflightModels`), and a model whose attempts come back
 *    with no tokens at all three times running is dropped for the rest of the run
 *    (`ModelBreaker`). Without them a dead gateway model is handed all 71 tasks and
 *    charges the full agent timeout for each, writing rows that look exactly like
 *    genuine slow failures.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { adapterFor } from "../adapters/lang/index.ts";
import { agentFor, type AgentAdapter } from "../adapters/agent/index.ts";
import { AVEN_LANG_DIR, CORPUS_DIR } from "../ingest/paths.ts";
import { loadIndex, loadTask, type Split } from "../ingest/task.ts";
import { pool, runProcess, Semaphore } from "./proc.ts";
import { priceTable } from "./prices.ts";
import type { SuiteVisibility } from "./prompt.ts";
import { sandboxAvailability, sandboxLabel } from "./sandbox.ts";
import {
  SCHEMA_VERSION,
  attemptKey,
  type AttemptRecord,
  type SandboxMode,
  type TaskSet,
  type ToolPolicy,
} from "./schema.ts";
import { appendRecord, isDone, loadResumeIndex, putArtifact, RUNS_DIR, sha256 } from "./store.ts";
import { approxTokens } from "./tokens.ts";
import {
  DEFAULT_WORK_ROOT,
  RUNNER_VERSION,
  attemptIdFor,
  runAttempt,
  type AttemptSpec,
  type RunContext,
} from "./attempt.ts";

// --- argv ------------------------------------------------------------------

type Args = {
  flags: Map<string, string>;
  bools: Set<string>;
};

export function parseArgv(argv: string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      bools.add(key);
    }
  }
  return { flags, bools };
}

/**
 * Every flag this runner accepts, including the `no-` spelling of each boolean.
 *
 * Silently ignoring an unknown flag is the expensive kind of harmless. `--only`
 * looked plausible (attempt specs really do carry an `only` set of case uuids) but
 * the CLI spells it `--tasks`; the flag was dropped without comment and a
 * three-task smoke test quietly became a seventy-one-task sweep against a shared
 * provider. A filter that silently does nothing is worse than one that errors,
 * because the run still looks like it worked.
 */
const KNOWN_FLAGS = new Set([
  "help",
  "tasks",
  "task-set",
  "limit",
  "lang",
  "model",
  "harness",
  "doc",
  "doc-id",
  "samples",
  "rounds",
  "jobs",
  "agent-jobs",
  "lang-jobs",
  "agent-timeout",
  "tool-timeout",
  "out",
  "run-id",
  "work-root",
  "keep-work",
  "intersect",
  "sandbox",
  "mypy",
  "survey",
  "preflight",
  "preflight-timeout",
  "breaker-threshold",
  "resume-sessions",
  "self-verify",
  "show-suite",
  "dry-run",
  "retry-harness-errors",
  "allow-repo-workdir",
  "temperature",
  "seed",
]);

/** Unknown flags, so the CLI can refuse rather than ignore them. */
export function unknownFlags(args: Args): string[] {
  const seen = [...args.flags.keys(), ...args.bools];
  return seen.filter((key) => {
    const bare = key.startsWith("no-") ? key.slice(3) : key;
    return !KNOWN_FLAGS.has(key) && !KNOWN_FLAGS.has(bare);
  });
}

function list(args: Args, key: string): string[] | undefined {
  const v = args.flags.get(key);
  if (v === undefined) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(args: Args, key: string, dflt: number): number {
  const v = args.flags.get(key);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} expects a number, got '${v}'`);
  return n;
}

function bool(args: Args, key: string, dflt: boolean): boolean {
  if (args.bools.has(key)) return true;
  if (args.bools.has(`no-${key}`)) return false;
  const v = args.flags.get(key);
  if (v === undefined) return dflt;
  return v !== "false" && v !== "0";
}

const USAGE = `bun run bench [options]

selection
  --lang aven,python           language arms (default python)
  --model provider/model[,…]   models to run (required unless --dry-run)
  --harness opencode           agent harness (default opencode)
  --tasks a,b,c                explicit task ids
  --task-set tune|holdout|all  select by the frozen split (default: whatever --tasks says, else tune)
  --limit N                    first N tasks after selection
  --samples N                  samples per (task, lang, model) (default 1)

experiment
  --rounds N                   max repair rounds after round 0 (default 2)
  --doc PATH                   skill doc to inline into the prompt (Aven arm)
  --doc-id ID                  label for that doc (default: its file name)
  --self-verify                let the model run the compiler/suite itself
  --show-suite                 let the model read the generated suite (default: hidden until gate time)
  --intersect                  restrict cases to those every --lang arm can render
  --temperature F  --seed N    recorded; passed through where the harness supports it
  --no-mypy                    skip the (non-gating) mypy probe on the Python arm
  --no-resume-sessions         each repair round starts a fresh harness session
  --no-survey                  skip the post-verdict "what would you change" turn

execution
  --no-sandbox                 run the model harness without bubblewrap (debugging only)
  --jobs N                     attempts in flight (default = --agent-jobs)
  --agent-jobs N               concurrent harness calls (default 3)
  --lang-jobs N                concurrent compiler/interpreter runs (default 8)
  --agent-timeout SEC          per harness call (default 900; cold opencode start is ~2min)
  --tool-timeout SEC           per compiler/test invocation (default 120)
  --no-preflight               skip the one-turn liveness probe per model
  --preflight-timeout SEC      per liveness probe (default 120)
  --breaker-threshold N        drop a model after N zero-token attempts in a row (default 3; 0 disables)
  --out PATH                   run log (default data/runs/<run-id>.jsonl)
  --run-id ID                  default: timestamp
  --work-root DIR              default ~/.cache/aven-bench/work (must be outside any git repo)
  --keep-work                  keep per-attempt work dirs (default: prune once archived)
  --allow-repo-workdir         permit a work root inside a repo (unsafe with --no-sandbox)
  --retry-harness-errors       re-attempt keys whose only rows are harness_error
  --dry-run                    print the plan, write nothing
`;

// --- environment probing ---------------------------------------------------

async function gitHead(dir: string): Promise<string | null> {
  const proc = await runProcess(["git", "-C", dir, "rev-parse", "HEAD"], {
    cwd: dir,
    timeoutMs: 15_000,
  });
  if (proc.spawnError || proc.exitCode !== 0) return null;
  return proc.stdout.trim() || null;
}

/**
 * Nearest enclosing git repository of `dir`, or null.
 *
 * A work directory inside a git repo is a correctness problem, not a style one:
 * opencode takes the enclosing repository as its project root, which handed the
 * model glob and grep over all of aven-bench — `references/` included, where the
 * hand-written solutions live. It read them. So the runner refuses.
 */
export function enclosingRepo(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    if (isGitRepo(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * A `.git` that is actually a repository.
 *
 * Not just `existsSync(".git")`: this machine has a stray empty `/tmp/.git`
 * directory that git itself rejects, and treating that as a repository would
 * make the runner refuse its own default work root.
 */
function isGitRepo(dir: string): boolean {
  const dotGit = join(dir, ".git");
  if (!existsSync(dotGit)) return false;
  // A worktree or submodule has `.git` as a file pointing elsewhere.
  if (statSync(dotGit).isFile()) return true;
  return existsSync(join(dotGit, "HEAD"));
}

/**
 * Version string for a language's interpreter, for provenance.
 *
 * Both streams are read because `python3 --version` wrote to stderr for years and
 * `ruby --version` writes to stdout; asking which is which per tool is a detail
 * this does not need to know.
 */
async function interpreterVersion(argv: string[]): Promise<string> {
  const proc = await runProcess(argv, { cwd: process.cwd(), timeoutMs: 15_000 });
  if (proc.spawnError) return "unavailable";
  return `${proc.stdout}${proc.stderr}`.trim() || "unknown";
}

/** How to ask each control language its version. Aven's comes from its git commit. */
const VERSION_COMMANDS: Record<string, string[]> = {
  python: ["python3", "--version"],
  ruby: ["ruby", "--version"],
};

/**
 * Hash of the `aven` binary actually used.
 *
 * The commit alone does not pin a build: `AVEN_BIN` often points at a
 * `target/debug` binary that is older or newer than `HEAD`, and in this repo's
 * layout the aven-lang checkout can move under a long sweep. Hashing the file is
 * cheap once per run and makes non-comparable A/B halves detectable.
 */
async function avenBinaryHash(bin: string | null): Promise<string | null> {
  if (!bin) return null;
  const h = new Bun.CryptoHasher("sha256");
  h.update(await Bun.file(bin).bytes());
  return h.digest("hex");
}

function avenBinaryPath(): string | null {
  const configured = process.env["AVEN_BIN"];
  if (!configured) return null;
  const path = resolve(configured);
  return existsSync(path) ? realpathSync(path) : path;
}

// --- model health ----------------------------------------------------------

export type ProbeOutcome = {
  modelId: string;
  ok: boolean;
  detail: string;
  wallMs: number;
};

export type PreflightReport = {
  results: ProbeOutcome[];
  /** Out-of-band spend, reported separately and never folded into any row. */
  costUsd: number | null;
  promptTokens: number;
  completionTokens: number;
};

/**
 * Ask each requested model one trivial question before the run plans anything.
 *
 * Null when the harness has no `probeModel` — no preflight is better than a
 * fabricated verdict about a model nobody asked.
 *
 * This exists because `agent.available()` answers about the *harness*: `opencode
 * --version` was perfectly happy while two of its gateway models silently stopped
 * answering, and the sweep then paid a 420s timeout on every remaining task for
 * each of them. One cheap call per model buys back hours, and a model that fails
 * the probe is dropped rather than measured, because a row it produced would not
 * be a measurement of anything.
 *
 * The probe's tokens and cost are returned for separate reporting — the same rule
 * the survey turn follows. Nothing here may reach an attempt record.
 */
export async function preflightModels(
  agent: AgentAdapter,
  models: string[],
  timeoutMs: number,
  jobs: number,
): Promise<PreflightReport | null> {
  const probeModel = agent.probeModel?.bind(agent);
  if (!probeModel) return null;
  const report: PreflightReport = { results: [], costUsd: null, promptTokens: 0, completionTokens: 0 };
  const probed = await pool(models, jobs, async (modelId) => {
    // The adapter contract says probes do not throw, but a preflight that crashed
    // the run would be worse than the problem it is here to prevent.
    try {
      return { modelId, result: await probeModel({ model: modelId, timeoutMs }) };
    } catch (err) {
      return {
        modelId,
        result: {
          ok: false,
          detail: `probe threw: ${String(err)}`,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: null,
          wallMs: 0,
        },
      };
    }
  });
  for (const { modelId, result } of probed) {
    report.results.push({ modelId, ok: result.ok, detail: result.detail, wallMs: result.wallMs });
    report.promptTokens += result.promptTokens;
    report.completionTokens += result.completionTokens;
    if (result.costUsd !== null) report.costUsd = (report.costUsd ?? 0) + result.costUsd;
  }
  return report;
}

/**
 * Per-model circuit breaker over consecutive zero-token attempts.
 *
 * The failure it exists for, from `phase2-calibration-02`: at 12:20 the model
 * `opencode/big-pickle` stopped answering, and the next ten attempts were all
 * `roundsUsed: 1`, `wallMs≈420000`, zero tokens both directions. The harness had
 * no idea and would have kept going for another two hours at four jobs.
 *
 * Only `agent-no-tokens` attempts count. A genuine timeout that burned tokens, a
 * refusal and a wrong answer all reset the streak, because all three are the model
 * working: this must never be able to stop measuring a model that is merely bad.
 * Threshold 0 disables it entirely, for deliberately investigating a flaky
 * provider.
 */
export class ModelBreaker {
  private readonly streak = new Map<string, number>();
  private readonly open = new Map<string, { after: number; skipped: number }>();

  constructor(private readonly threshold: number) {}

  /** Fold one finished attempt in. True only on the call that trips the breaker. */
  observe(modelId: string, noTokens: boolean): boolean {
    if (!noTokens) {
      this.streak.set(modelId, 0);
      return false;
    }
    const streak = (this.streak.get(modelId) ?? 0) + 1;
    this.streak.set(modelId, streak);
    if (this.threshold <= 0 || streak < this.threshold || this.open.has(modelId)) return false;
    this.open.set(modelId, { after: streak, skipped: 0 });
    return true;
  }

  isOpen(modelId: string): boolean {
    return this.open.has(modelId);
  }

  /** Count one planned attempt the breaker refused to dispatch. */
  skip(modelId: string): void {
    const entry = this.open.get(modelId);
    if (entry) entry.skipped++;
  }

  /** Tripped models, for the progress line and the end-of-run summary. */
  report(): { modelId: string; after: number; skipped: number }[] {
    return [...this.open].map(([modelId, e]) => ({ modelId, after: e.after, skipped: e.skipped }));
  }
}

// --- main ------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgv(Bun.argv.slice(2));
  if (args.bools.has("help") || args.bools.has("h")) {
    console.log(USAGE);
    return 0;
  }

  const unknown = unknownFlags(args);
  if (unknown.length > 0) {
    console.error(`unknown flag(s): ${unknown.map((f) => `--${f}`).join(", ")}`);
    console.error("A misspelled filter would otherwise run a far larger sweep than intended.");
    console.error(USAGE);
    return 2;
  }

  const languages = list(args, "lang") ?? ["python"];
  for (const l of languages) adapterFor(l); // fail fast on a typo
  const models = list(args, "model") ?? [];
  const harnessId = args.flags.get("harness") ?? "opencode";
  const dryRun = args.bools.has("dry-run");
  if (models.length === 0 && !dryRun) {
    console.error("--model is required (e.g. --model opencode/deepseek-v4-flash-free)");
    console.error(USAGE);
    return 2;
  }

  const index = await loadIndex(CORPUS_DIR);
  const split = (await Bun.file(`${CORPUS_DIR}/split.json`).json()) as Split;
  const setOf = new Map<string, TaskSet>();
  for (const id of split.tune) setOf.set(id, "tune");
  for (const id of split.holdout) setOf.set(id, "holdout");

  const explicit = list(args, "tasks");
  const wantedSet = args.flags.get("task-set") ?? (explicit ? "all" : "tune");
  let taskIds = explicit ?? index.tasks.map((t) => t.id);
  for (const id of taskIds) {
    if (!setOf.has(id)) throw new Error(`unknown task '${id}' (not in corpus/split.json)`);
  }
  if (wantedSet !== "all") taskIds = taskIds.filter((id) => setOf.get(id) === wantedSet);
  const limit = args.flags.get("limit");
  if (limit) taskIds = taskIds.slice(0, Number(limit));
  if (taskIds.length === 0) {
    console.error("no tasks selected");
    return 2;
  }

  const samples = num(args, "samples", 1);
  const maxRounds = num(args, "rounds", 2);
  const agentJobs = num(args, "agent-jobs", 3);
  const langJobs = num(args, "lang-jobs", 8);
  const jobs = num(args, "jobs", agentJobs);
  const agentTimeoutMs = num(args, "agent-timeout", 900) * 1000;
  const toolTimeoutMs = num(args, "tool-timeout", 120) * 1000;
  const preflight = bool(args, "preflight", true);
  // 60s, not the agent timeout: the probe is one sentence with no tool calls, and
  // the whole point is to find a dead model in seconds instead of in 15 minutes.
  // 120s, not 60s: a healthy probe answers in ~20s warm, but a cold opencode start
  // runs to ~2 minutes, so a 60s budget drops a live model for being cold. Two minutes
  // per dead model is a rounding error against the two hours the breaker exists to save.
  const preflightTimeoutMs = num(args, "preflight-timeout", 120) * 1000;
  const breakerThreshold = num(args, "breaker-threshold", 3);
  const toolPolicy: ToolPolicy = bool(args, "self-verify", false) ? "self-verify" : "no-verify";
  // Hidden by default: a visible suite tempts a model into pattern-matching the
  // expected values instead of implementing the algorithm (Dave's call).
  const suiteVisibility: SuiteVisibility = bool(args, "show-suite", false) ? "visible" : "hidden";
  const sandbox: SandboxMode = sandboxLabel(bool(args, "sandbox", true));
  const intersect = bool(args, "intersect", false);
  const mypy = bool(args, "mypy", true);
  const resumeSessions = bool(args, "resume-sessions", true);
  const survey = bool(args, "survey", true);
  const keepWork = bool(args, "keep-work", false);
  const retryHarnessErrors = bool(args, "retry-harness-errors", false);
  const runId = args.flags.get("run-id") ?? new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = args.flags.get("out") ?? `${RUNS_DIR}/${runId}.jsonl`;
  const workRoot = resolve(args.flags.get("work-root") ?? DEFAULT_WORK_ROOT);
  const temperature = args.flags.get("temperature") !== undefined ? num(args, "temperature", 0) : null;
  const seed = args.flags.get("seed") !== undefined ? num(args, "seed", 0) : null;

  const docPath = args.flags.get("doc");
  const doc = docPath ? await Bun.file(docPath).text() : null;
  const docId = docPath ? (args.flags.get("doc-id") ?? basename(docPath)) : null;

  const agent = agentFor(harnessId);
  const harnessVersion = await agent.version();
  const avenNeeded = languages.includes("aven");
  const avenBin = avenNeeded ? avenBinaryPath() : null;
  const avenCommit = avenNeeded ? await gitHead(AVEN_LANG_DIR) : null;
  const avenBinary = avenNeeded ? await avenBinaryHash(avenBin) : null;
  // Only the languages this run actually uses. Recording `python` unconditionally
  // meant a ruby-only sweep carried Python's version as its provenance, which is
  // worse than recording nothing: `languageVersion` is the field that says which
  // toolchain produced a row.
  const languageVersions: Record<string, string> = {
    ...(avenNeeded ? { aven: `aven-lang@${(avenCommit ?? "unknown").slice(0, 12)}` } : {}),
  };
  for (const lang of languages) {
    const argv = VERSION_COMMANDS[lang];
    if (argv) languageVersions[lang] = await interpreterVersion(argv);
  }

  // Contamination guard. See `enclosingRepo`: this is why the default work root
  // is outside the repository.
  const repo = enclosingRepo(workRoot);
  if (repo && !bool(args, "allow-repo-workdir", false)) {
    console.error(
      `refusing to run: work root ${workRoot} is inside the git repository ${repo}.\n` +
        "  The agent harness takes the enclosing repo as its project root, which lets the model\n" +
        "  glob and read anything in it — including references/, which holds solutions to corpus\n" +
        "  tasks. Observed for real: opencode read references/acronym/solution.av before answering.\n" +
        `  Use --work-root outside any repo (the default is ${DEFAULT_WORK_ROOT}),\n` +
        "  or --allow-repo-workdir if you truly want contaminated rows.",
    );
    return 2;
  }

  if (!dryRun) {
    if (sandbox === "bubblewrap") {
      const availability = await sandboxAvailability();
      if (!availability.ok) {
        console.error(
          `sandbox unavailable: ${availability.detail}\n` +
            "  Refusing to run the model harness without filesystem containment.\n" +
            "  Install/fix bubblewrap, or pass --no-sandbox deliberately for debugging.",
        );
        return 2;
      }
      if (avenNeeded && toolPolicy === "self-verify" && !avenBin) {
        console.error(
          "sandboxed Aven self-verification requires AVEN_BIN to name a built `aven` binary.\n" +
            "  The sandbox does not expose the aven-lang checkout or cargo. Set AVEN_BIN,\n" +
            "  use the default --no-verify policy, or pass --no-sandbox deliberately.",
        );
        return 2;
      }
    }
    const availability = await agent.available();
    if (!availability.ok) {
      // Nothing to record: no attempt was made. A sweep of harness_error rows
      // would be noise, not data.
      console.error(`agent harness '${harnessId}' unavailable: ${availability.detail}`);
      return 2;
    }
    if (avenNeeded && !process.env["AVEN_BIN"]) {
      console.error(
        "warning: AVEN_BIN is unset, so every aven invocation goes through `cargo run` " +
          "(slow, and it can rebuild mid-sweep). Build once and set AVEN_BIN.",
      );
    }
  }

  // Preflight, before anything is planned: a model that cannot answer one sentence
  // must not be handed 71 tasks at a 900s timeout each. Skipped on a dry run, which
  // is meant to cost nothing.
  let liveModels = models;
  let preflightReport: PreflightReport | null = null;
  const dropped: ProbeOutcome[] = [];
  if (!dryRun && preflight && models.length > 0) {
    preflightReport = await preflightModels(agent, models, preflightTimeoutMs, agentJobs);
    if (preflightReport === null) {
      console.log(`preflight     skipped: harness '${harnessId}' does not implement a model probe`);
    } else {
      for (const r of preflightReport.results) {
        console.log(
          `preflight     ${r.modelId.padEnd(34)} ${r.ok ? "ok  " : "DEAD"} ${Math.round(r.wallMs)}ms  ${r.detail.slice(0, 90)}`,
        );
      }
      dropped.push(...preflightReport.results.filter((r) => !r.ok));
      liveModels = preflightReport.results.filter((r) => r.ok).map((r) => r.modelId);
      if (liveModels.length === 0) {
        console.error(
          "refusing to run: no requested model answered its preflight probe.\n" +
            dropped.map((r) => `  ${r.modelId}: ${r.detail}`).join("\n") +
            "\n  Check the provider, name a different --model, or pass --no-preflight to run anyway.",
        );
        return 2;
      }
    }
  }

  // Intersected case sets, computed once per task rather than per attempt.
  const onlyByTask = new Map<string, ReadonlySet<string>>();
  if (intersect && languages.length > 1) {
    const adapters = languages.map(adapterFor);
    for (const id of taskIds) {
      const task = await loadTask(CORPUS_DIR, id);
      const sets = adapters.map((a) => {
        const bad = new Set(a.renderTests(task).omitted.map((o) => o.uuid));
        return new Set(task.cases.map((c) => c.uuid).filter((u) => !bad.has(u)));
      });
      onlyByTask.set(id, new Set(task.cases.map((c) => c.uuid).filter((u) => sets.every((s) => s.has(u)))));
    }
  }

  const table = priceTable();
  const resume = loadResumeIndex();

  /**
   * (task, language) pairs with nothing left to test.
   *
   * A suite whose every case was omitted asserts `fail("every case was omitted")`,
   * so running it scores a model on a task that has no oracle. `accumulate` is the
   * live example: all five of its cases pass a function as pseudocode text, which a
   * mechanical generator cannot turn into a callable, so every arm fails it for
   * reasons that have nothing to do with the model or the language. Excluded from
   * the plan and reported, rather than silently depressing every pass rate.
   */
  const empty: { taskId: string; language: string }[] = [];
  for (const taskId of taskIds) {
    const task = await loadTask(CORPUS_DIR, taskId);
    const only = onlyByTask.get(taskId);
    for (const language of languages) {
      const omitted = new Set(adapterFor(language).renderTests(task, only).omitted.map((o) => o.uuid));
      const renderable = task.cases.filter(
        (c) => !omitted.has(c.uuid) && (!only || only.has(c.uuid)),
      ).length;
      if (renderable === 0) empty.push({ taskId, language });
    }
  }
  // The key separator is written as an escape, never as a literal NUL byte: an actual
  // NUL in the source makes grep classify the file as binary and skip it silently,
  // which breaks code search for every tool and agent that reads this repo.
  const isEmpty = new Set(empty.map((e) => `${e.taskId}\u0000${e.language}`));

  type Planned = { spec: AttemptSpec; modelId: string; key: string; done: boolean; outcomes: string[] };
  const planned: Planned[] = [];
  // Only models that survived preflight are planned at all: a dropped model has no
  // attempts, so a later run picks it up cleanly once its provider is back.
  for (const modelId of liveModels.length > 0 ? liveModels : ["(none)"]) {
    for (let sample = 0; sample < samples; sample++) {
      for (const taskId of taskIds) {
        for (const language of languages) {
          if (isEmpty.has(`${taskId}\u0000${language}`)) continue;
          const only = onlyByTask.get(taskId);
          const spec: AttemptSpec = {
            taskId,
            language,
            sampleIndex: sample,
            taskSet: setOf.get(taskId)!,
            ...(only ? { only } : {}),
          };
          const key = attemptKey({
            taskId,
            language,
            modelId,
            agentHarness: harnessId,
            docId,
            sampleIndex: sample,
            avenCommit: language === "aven" ? avenCommit : null,
            toolPolicy,
            suiteVisibility,
            sandbox,
          });
          const { done, outcomes } = isDone(resume, key, retryHarnessErrors);
          planned.push({ spec, modelId, key, done, outcomes });
        }
      }
    }
  }
  const todo = planned.filter((p) => !p.done);

  console.log(`run-id        ${runId}`);
  console.log(`harness       ${harnessId} ${harnessVersion}`);
  console.log(
    `models        ${liveModels.join(", ") || "(none)"}` +
      (dropped.length > 0 ? `   (dropped by preflight: ${dropped.map((d) => d.modelId).join(", ")})` : ""),
  );
  console.log(`languages     ${languages.join(", ")}   versions: ${JSON.stringify(languageVersions)}`);
  if (avenNeeded) {
    console.log(`aven          commit ${avenCommit ?? "unknown"}  binary ${avenBinary?.slice(0, 12) ?? "(cargo run)"}`);
  }
  console.log(`tasks         ${taskIds.length} (${wantedSet})   samples ${samples}   rounds<=${maxRounds}`);
  if (empty.length > 0) {
    console.log(
      `excluded      ${empty.length} (task, lang) pair(s) with no renderable cases: ` +
        empty.map((e) => `${e.taskId}/${e.language}`).join(", "),
    );
  }
  console.log(
    `policy        toolPolicy=${toolPolicy} suite=${suiteVisibility} sandbox=${sandbox}` +
      ` intersect=${intersect} mypy=${mypy}`,
  );
  console.log(
    `health        preflight=${preflight ? `${preflightTimeoutMs / 1000}s` : "off"}` +
      ` breaker=${breakerThreshold > 0 ? `${breakerThreshold} zero-token attempts` : "off"}`,
  );
  console.log(`prices        table ${table.version}`);
  console.log(
    `resume        ${resume.records} records in ${resume.files} log(s)` +
      (resume.malformedLines > 0 ? `, ${resume.malformedLines} malformed line(s)` : "") +
      ` -> ${planned.length - todo.length} skipped, ${todo.length} to run`,
  );
  console.log(`out           ${outPath}`);
  console.log(`work          ${workRoot}`);

  if (dryRun) {
    for (const p of planned) {
      console.log(
        `${p.done ? "skip" : "run "}  ${p.spec.taskId.padEnd(28)} ${p.spec.language.padEnd(7)}` +
          ` ${p.modelId.padEnd(34)} s${p.spec.sampleIndex}` +
          (p.done ? `   (have: ${p.outcomes.join(",")})` : ""),
      );
    }
    console.log(`\ndry run: nothing executed, nothing written`);
    return 0;
  }

  const agentSem = new Semaphore(agentJobs);
  const langSem = new Semaphore(langJobs);
  const records: AttemptRecord[] = [];
  let finished = 0;

  const contexts = new Map<string, RunContext>();
  const contextFor = (modelId: string): RunContext => {
    const existing = contexts.get(modelId);
    if (existing) return existing;
    const ctx: RunContext = {
      runId,
      agent,
      harnessVersion,
      modelId,
      provider: modelId.includes("/") ? modelId.slice(0, modelId.indexOf("/")) : harnessId,
      quantization: null,
      avenCommit,
      avenBinarySha256: avenBinary,
      languageVersions,
      docId,
      docHash: doc ? sha256(doc) : null,
      docTokens: doc ? approxTokens(doc) : null,
      doc,
      toolPolicy,
      suiteVisibility,
      sandbox,
      avenBin,
      maxRounds,
      agentTimeoutMs,
      toolTimeoutMs,
      mypy,
      temperature,
      seed,
      agentSem,
      langSem,
      workRoot,
      resumeSessions,
      survey,
      keepWork,
    };
    if (doc) putArtifact(doc, "md");
    contexts.set(modelId, ctx);
    return ctx;
  };

  // Attempt-level parallelism; the semaphores above are what actually bound the
  // harness and the toolchain.
  const breaker = new ModelBreaker(breakerThreshold);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const p = todo[i]!;
      // A model the breaker has given up on is skipped, not recorded. Writing a
      // row per skipped attempt would assert an attempt that never happened, and
      // resume counts `harness_error` rows as present — so the next run would need
      // `--retry-harness-errors` to pick up work this run simply never did.
      if (breaker.isOpen(p.modelId)) {
        breaker.skip(p.modelId);
        continue;
      }
      const ctx = contextFor(p.modelId);
      let record: AttemptRecord;
      try {
        record = await runAttempt(ctx, p.spec);
      } catch (err) {
        // A bug in the runner is a harness error too: record it rather than
        // dropping the attempt on the floor.
        record = harnessErrorRecord(ctx, p.spec, err);
      }
      appendRecord(outPath, record);
      records.push(record);
      finished++;
      const rounds = record.repairRounds.length;
      console.log(
        `[${String(finished).padStart(String(todo.length).length)}/${todo.length}] ` +
          `${record.taskId.padEnd(26)} ${record.language.padEnd(7)} s${record.sampleIndex} ` +
          `${record.outcome.padEnd(14)} ${record.casesPassed}/${record.casesTotal} cases` +
          ` rounds=${rounds}${record.roundsToGreen !== null ? ` green@${record.roundsToGreen}` : ""}` +
          ` ${Math.round(record.wallMs)}ms` +
          (record.harnessError ? `  !! ${record.harnessError.slice(0, 120)}` : ""),
      );
      if (breaker.observe(p.modelId, record.harnessErrorKind === "agent-no-tokens")) {
        console.log(
          `[breaker] ${p.modelId} returned no tokens on ${breakerThreshold} attempt(s) in a row` +
            " — its remaining attempts are skipped, not recorded. Other models continue.",
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, todo.length)) }, worker));

  summarize(records, { breaker: breaker.report(), dropped, preflight: preflightReport });
  console.log(`\nwrote ${records.length} record(s) -> ${outPath}`);
  return records.some((r) => r.outcome === "harness_error") ? 1 : 0;
}

function harnessErrorRecord(ctx: RunContext, spec: AttemptSpec, err: unknown): AttemptRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: ctx.runId,
    attemptId: attemptIdFor(ctx, spec),
    runnerVersion: RUNNER_VERSION,
    startedAt: now,
    finishedAt: now,
    taskId: spec.taskId,
    taskSource: "exercism",
    taskSet: spec.taskSet,
    casesOmitted: 0,
    casesExcludedByIntersect: 0,
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
    agentSessionRef: null,
    sampleIndex: spec.sampleIndex,
    temperature: ctx.temperature,
    seed: ctx.seed,
    toolPolicy: ctx.toolPolicy,
    suiteVisibility: ctx.suiteVisibility,
    sandbox: ctx.sandbox,
    maxRounds: ctx.maxRounds,
    roundsUsed: 0,
    repairRounds: [],
    outcome: "harness_error",
    outcomeDetail: String(err).slice(0, 500),
    harnessError: String(err).slice(0, 500),
    harnessErrorKind: "runner-exception",
    timedOut: false,
    firstShotPass: false,
    roundsToGreen: null,
    casesPassed: 0,
    casesTotal: 0,
    probes: [],
    checkOk: null,
    checkOkSolutionOnly: null,
    testOk: null,
    mypyOk: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
    priceSource: "unknown",
    priceTableVersion: priceTable().version,
    shadowCostUsd: null,
    shadowPriceSource: "unknown",
    reportedCostUsd: null,
    harnessSessionCostUsd: null,
    harnessSessionTokens: null,
    wallMs: 0,
    agentWallMs: 0,
    gateWallMs: 0,
    tokensPerSec: null,
    surveyed: false,
    surveyResponse: null,
    surveyResponseHash: null,
    surveyPromptTokens: 0,
    surveyCompletionTokens: 0,
    surveyCostUsd: null,
    surveyWallMs: 0,
    surveyError: null,
    solutionBytes: 0,
    solutionLoc: 0,
    solutionTokens: 0,
    tokenEstimator: "heuristic-v1",
    outsideWorkdirTouches: 0,
    shellCommands: 0,
    artifactHash: null,
    promptHash: "",
    suiteHash: "",
    sessionLogHash: null,
    workDir: "",
  };
}

/**
 * Model health, reported alongside the outcomes.
 *
 * These belong in the summary rather than only in the scrollback: a dead model is
 * the one failure mode that silently corrupts the pass-rate deltas the benchmark
 * exists to produce, and 45 minutes of it went unnoticed once already.
 */
type HealthSummary = {
  breaker: { modelId: string; after: number; skipped: number }[];
  dropped: ProbeOutcome[];
  preflight: PreflightReport | null;
};

function summarize(records: AttemptRecord[], health: HealthSummary): void {
  // Health is reported even when nothing ran — a fully resumed sweep still has to
  // say that a model was dropped, because that is why its rows are missing.
  if (records.length === 0) {
    if (health.dropped.length > 0 || health.breaker.length > 0) console.log("\n--- summary ---");
    summarizeHealth(health);
    return;
  }
  const byOutcome = new Map<string, number>();
  for (const r of records) byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
  // Harness errors are already outside the capability denominator; zero-token rows
  // are the subset of them that measured nothing at all.
  const noTokens = records.filter((r) => r.harnessErrorKind === "agent-no-tokens").length;
  const scored = records.filter((r) => r.outcome !== "harness_error");
  const green = records.filter((r) => r.roundsToGreen !== null);
  const cost = records.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const unknownCost = records.filter((r) => r.costUsd === null).length;
  const surveyCost = records.reduce((n, r) => n + (r.surveyCostUsd ?? 0), 0);
  const surveyed = records.filter((r) => r.surveyed).length;
  const surveyFailed = records.filter((r) => r.surveyError !== null).length;
  // A drift here means the event parsing missed charges, not that the bill moved.
  const drifted = records.filter(
    (r) =>
      r.harnessSessionCostUsd !== null &&
      Math.abs(r.harnessSessionCostUsd - ((r.costUsd ?? 0) + (r.surveyCostUsd ?? 0))) > 1e-6,
  ).length;

  console.log("\n--- summary ---");
  for (const [outcome, n] of [...byOutcome].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${outcome.padEnd(15)}${n}`);
  }
  if (scored.length > 0) {
    const firstShot = scored.filter((r) => r.firstShotPass).length;
    console.log(`  first-shot     ${firstShot}/${scored.length}`);
    console.log(`  eventual green ${green.length}/${scored.length}`);
    if (green.length > 0) {
      const mean = green.reduce((n, r) => n + (r.roundsToGreen ?? 0), 0) / green.length;
      console.log(`  mean rounds-to-green ${mean.toFixed(2)}`);
    }
  }
  console.log(
    `  cost           $${cost.toFixed(6)}` + (unknownCost > 0 ? `  (${unknownCost} row(s) reported no charge)` : ""),
  );
  if (surveyCost > 0 || surveyed > 0) {
    console.log(
      `  survey         $${surveyCost.toFixed(6)}  ${surveyed} answered` +
        (surveyFailed > 0 ? `, ${surveyFailed} failed` : "") +
        "  (not included in cost above)",
    );
  }
  if (drifted > 0) {
    console.log(`  !! ${drifted} row(s) disagree with the harness's own session total — check event parsing`);
  }
  if (noTokens > 0) {
    console.log(
      `  !! ${noTokens} row(s) returned no tokens at all (harness_error, kind agent-no-tokens):` +
        " the provider, not the model. Excluded from the rates above; --retry-harness-errors re-attempts them.",
    );
  }
  const tokens = records.reduce((n, r) => n + r.promptTokens + r.completionTokens, 0);
  console.log(`  tokens         ${tokens}`);
  const escaped = records.filter((r) => r.outsideWorkdirTouches > 0);
  if (escaped.length > 0) {
    const unsandboxed = escaped.filter((r) => r.sandbox === "none").length;
    console.log(
      `  !! ${escaped.length} row(s) named paths OUTSIDE their work directory` +
        (unsandboxed > 0 ? `; ${unsandboxed} unsandboxed row(s) are suspect` : " (sandbox denied access)") +
        ":\n" +
        escaped
          .map((r) => `       ${r.language} ${r.taskId} s${r.sampleIndex}: ${r.outsideWorkdirTouches} path(s)`)
          .join("\n"),
    );
  }
  const shellViolations = records.filter((r) => r.toolPolicy === "no-verify" && r.shellCommands > 0);
  if (shellViolations.length > 0) {
    console.log(
      `  !! ${shellViolations.length} row(s) ran shell commands despite toolPolicy=no-verify:\n` +
        shellViolations
          .map((r) => `       ${r.language} ${r.taskId} s${r.sampleIndex}: ${r.shellCommands} command(s)`)
          .join("\n"),
    );
  }
  summarizeHealth(health);
}

function summarizeHealth(health: HealthSummary): void {
  const probe = health.preflight;
  if (probe && probe.promptTokens + probe.completionTokens > 0) {
    console.log(
      `  preflight      $${(probe.costUsd ?? 0).toFixed(6)}  ${probe.results.length} probe(s),` +
        ` ${probe.promptTokens + probe.completionTokens} token(s)  (not included in cost above)`,
    );
  }
  if (health.dropped.length > 0) {
    console.log(
      `  !! ${health.dropped.length} model(s) dropped by preflight and never attempted:\n` +
        health.dropped.map((d) => `       ${d.modelId}: ${d.detail.slice(0, 100)}`).join("\n"),
    );
  }
  if (health.breaker.length > 0) {
    console.log(
      `  !! ${health.breaker.length} model(s) tripped the circuit breaker mid-run — treat their rows as partial:\n` +
        health.breaker
          .map(
            (b) =>
              `       ${b.modelId}: ${b.after} zero-token attempt(s) in a row,` +
              ` ${b.skipped} planned attempt(s) skipped (re-run to pick them up)`,
          )
          .join("\n"),
    );
  }
}

if (import.meta.main) {
  // A directory check that is cheap and catches the commonest setup mistake.
  if (!existsSync(CORPUS_DIR) || !statSync(CORPUS_DIR).isDirectory()) {
    console.error(`corpus not found at ${CORPUS_DIR}; run \`bun run ingest\` first`);
    process.exit(2);
  }
  process.exit(await main());
}
