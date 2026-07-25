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
 */

import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { adapterFor } from "../adapters/lang/index.ts";
import { agentFor } from "../adapters/agent/index.ts";
import { AVEN_LANG_DIR, CORPUS_DIR } from "../ingest/paths.ts";
import { loadIndex, loadTask, type Split } from "../ingest/task.ts";
import { runProcess, Semaphore } from "./proc.ts";
import { priceTable } from "./prices.ts";
import type { SuiteVisibility } from "./prompt.ts";
import { attemptKey, type AttemptRecord, type TaskSet, type ToolPolicy } from "./schema.ts";
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
  --hide-suite                 withhold the generated suite from the model
  --intersect                  restrict cases to those every --lang arm can render
  --temperature F  --seed N    recorded; passed through where the harness supports it
  --no-mypy                    skip the (non-gating) mypy probe on the Python arm
  --no-resume-sessions         each repair round starts a fresh harness session

execution
  --jobs N                     attempts in flight (default = --agent-jobs)
  --agent-jobs N               concurrent harness calls (default 3)
  --lang-jobs N                concurrent compiler/interpreter runs (default 8)
  --agent-timeout SEC          per harness call (default 900; cold opencode start is ~2min)
  --tool-timeout SEC           per compiler/test invocation (default 120)
  --out PATH                   run log (default data/runs/<run-id>.jsonl)
  --run-id ID                  default: timestamp
  --work-root DIR              default ~/.cache/aven-bench/work (must be outside any git repo)
  --keep-work                  keep per-attempt work dirs (default: prune once archived)
  --allow-repo-workdir         permit a work root inside a repo (contaminates rows)
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

async function pythonVersion(): Promise<string> {
  const proc = await runProcess(["python3", "--version"], { cwd: process.cwd(), timeoutMs: 15_000 });
  if (proc.spawnError) return "unavailable";
  return `${proc.stdout}${proc.stderr}`.trim() || "unknown";
}

/**
 * Hash of the `aven` binary actually used.
 *
 * The commit alone does not pin a build: `AVEN_BIN` often points at a
 * `target/debug` binary that is older or newer than `HEAD`, and in this repo's
 * layout the aven-lang checkout can move under a long sweep. Hashing the file is
 * cheap once per run and makes non-comparable A/B halves detectable.
 */
async function avenBinaryHash(): Promise<string | null> {
  const bin = process.env["AVEN_BIN"];
  if (!bin || !existsSync(bin)) return null;
  const h = new Bun.CryptoHasher("sha256");
  h.update(await Bun.file(bin).bytes());
  return h.digest("hex");
}

// --- main ------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgv(Bun.argv.slice(2));
  if (args.bools.has("help") || args.bools.has("h")) {
    console.log(USAGE);
    return 0;
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
  const toolPolicy: ToolPolicy = bool(args, "self-verify", false) ? "self-verify" : "no-verify";
  const suiteVisibility: SuiteVisibility = bool(args, "hide-suite", false) ? "hidden" : "visible";
  const intersect = bool(args, "intersect", false);
  const mypy = bool(args, "mypy", true);
  const resumeSessions = bool(args, "resume-sessions", true);
  const keepWork = bool(args, "keep-work", false);
  const retryHarnessErrors = bool(args, "retry-harness-errors", false);
  const runId = args.flags.get("run-id") ?? new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = args.flags.get("out") ?? `${RUNS_DIR}/${runId}.jsonl`;
  const workRoot = args.flags.get("work-root") ?? DEFAULT_WORK_ROOT;
  const temperature = args.flags.get("temperature") !== undefined ? num(args, "temperature", 0) : null;
  const seed = args.flags.get("seed") !== undefined ? num(args, "seed", 0) : null;

  const docPath = args.flags.get("doc");
  const doc = docPath ? await Bun.file(docPath).text() : null;
  const docId = docPath ? (args.flags.get("doc-id") ?? basename(docPath)) : null;

  const agent = agentFor(harnessId);
  const harnessVersion = await agent.version();
  const avenNeeded = languages.includes("aven");
  const avenCommit = avenNeeded ? await gitHead(AVEN_LANG_DIR) : null;
  const avenBinary = avenNeeded ? await avenBinaryHash() : null;
  const languageVersions: Record<string, string> = {
    python: await pythonVersion(),
    ...(avenNeeded ? { aven: `aven-lang@${(avenCommit ?? "unknown").slice(0, 12)}` } : {}),
  };

  // Contamination guard. See `enclosingRepo`: this is why the default work root
  // is outside the repository.
  const repo = enclosingRepo(workRoot);
  if (repo && !bool(args, "allow-repo-workdir", false)) {
    console.error(
      `refusing to run: work root ${workRoot} is inside the git repository ${repo}.\n` +
        "  The agent harness takes the enclosing repo as its project root, which lets the model\n" +
        "  glob and read anything in it — including references/, which holds solutions to corpus\n" +
        "  tasks. Observed for real: opencode read references/acronym/solution.av before answering.\n" +
        "  Use --work-root outside any repo (the default is os.tmpdir()/aven-bench-work),\n" +
        "  or --allow-repo-workdir if you truly want contaminated rows.",
    );
    return 2;
  }

  if (!dryRun) {
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

  type Planned = { spec: AttemptSpec; modelId: string; key: string; done: boolean; outcomes: string[] };
  const planned: Planned[] = [];
  for (const modelId of models.length > 0 ? models : ["(none)"]) {
    for (let sample = 0; sample < samples; sample++) {
      for (const taskId of taskIds) {
        for (const language of languages) {
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
  console.log(`models        ${models.join(", ") || "(none)"}`);
  console.log(`languages     ${languages.join(", ")}   versions: ${JSON.stringify(languageVersions)}`);
  if (avenNeeded) {
    console.log(`aven          commit ${avenCommit ?? "unknown"}  binary ${avenBinary?.slice(0, 12) ?? "(cargo run)"}`);
  }
  console.log(`tasks         ${taskIds.length} (${wantedSet})   samples ${samples}   rounds<=${maxRounds}`);
  console.log(
    `policy        toolPolicy=${toolPolicy} suite=${suiteVisibility} intersect=${intersect} mypy=${mypy}`,
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
      keepWork,
    };
    if (doc) putArtifact(doc, "md");
    contexts.set(modelId, ctx);
    return ctx;
  };

  // Attempt-level parallelism; the semaphores above are what actually bound the
  // harness and the toolchain.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const p = todo[i]!;
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
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, todo.length)) }, worker));

  summarize(records);
  console.log(`\nwrote ${records.length} record(s) -> ${outPath}`);
  return records.some((r) => r.outcome === "harness_error") ? 1 : 0;
}

function harnessErrorRecord(ctx: RunContext, spec: AttemptSpec, err: unknown): AttemptRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
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
    maxRounds: ctx.maxRounds,
    roundsUsed: 0,
    repairRounds: [],
    outcome: "harness_error",
    outcomeDetail: String(err).slice(0, 500),
    harnessError: String(err).slice(0, 500),
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
    reasoningTokens: 0,
    costUsd: null,
    priceSource: "unknown",
    priceTableVersion: priceTable().version,
    reportedCostUsd: null,
    wallMs: 0,
    agentWallMs: 0,
    gateWallMs: 0,
    tokensPerSec: null,
    solutionBytes: 0,
    solutionLoc: 0,
    solutionTokens: 0,
    tokenEstimator: "heuristic-v1",
    outsideWorkdirTouches: 0,
    artifactHash: null,
    promptHash: "",
    suiteHash: "",
    sessionLogHash: null,
    workDir: "",
  };
}

function summarize(records: AttemptRecord[]): void {
  if (records.length === 0) return;
  const byOutcome = new Map<string, number>();
  for (const r of records) byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
  const scored = records.filter((r) => r.outcome !== "harness_error");
  const green = records.filter((r) => r.roundsToGreen !== null);
  const cost = records.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const unknownCost = records.filter((r) => r.costUsd === null).length;

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
    `  cost           $${cost.toFixed(6)}` + (unknownCost > 0 ? `  (${unknownCost} row(s) with no price entry)` : ""),
  );
  const tokens = records.reduce((n, r) => n + r.promptTokens + r.completionTokens, 0);
  console.log(`  tokens         ${tokens}`);
  const escaped = records.filter((r) => r.outsideWorkdirTouches > 0);
  if (escaped.length > 0) {
    // Loud, because such a row may have read an answer from somewhere on disk.
    console.log(
      `  !! ${escaped.length} row(s) touched files OUTSIDE their work directory — treat as suspect:\n` +
        escaped
          .map((r) => `       ${r.language} ${r.taskId} s${r.sampleIndex}: ${r.outsideWorkdirTouches} path(s)`)
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
