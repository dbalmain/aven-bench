/**
 * The gate: run the tools, record every probe separately, classify the outcome.
 *
 * ## What gates, and what is only recorded
 *
 * - **Aven** — `aven check`, then the export surface, then `aven test` (Dave's
 *   call on check-and-test). The export check is harness-only: Aven accepts
 *   modules with no export record (effectful modules are legal), but the suite
 *   is about to call named properties, so a forgotten `{ f, g }` is failed here
 *   with a repair-ready diagnostic instead of an opaque suite cascade. It runs
 *   only once `check` passes, because it is a syntactic scan and would otherwise
 *   blame a missing export for a file that simply does not parse. Check and test
 *   remain separate probes so check/test divergence stays queryable; it is not a
 *   hypothetical: `aven test` accepts suites `aven check` rejects.
 * - **Python** — `solution_test.py` gates. `mypy` is recorded and **does not
 *   gate**: running without a static gate is how Python is actually used, so
 *   holding the control arm to Aven's bar would flatter Aven. When mypy is not
 *   installed the probe records `ok: null`, not `false`.
 *
 * ## Why the diagnostics come back twice
 *
 * The gate reads `--format json` because codes and severities are the data. The
 * *repair prompt* gets a separate rendering, produced on demand by
 * `avenCheckText`, because the whole point of the rounds-to-green metric is to
 * measure the diagnostic the model was shown — not a JSON blob. That rendering
 * is an independent variable (`diagnosticFormat` / `--diagnostic-format`):
 * `text` is ariadne (carets, notes); `agent` is `aven check --format agent`.
 * Export-surface failures skip the re-render path and put the precise message
 * in `gate.detail`, which the attempt path already feeds to the repair prompt
 * as tool output.
 */

import { checkAvenExports } from "../adapters/lang/aven.ts";
import type { LangAdapter } from "../adapters/lang/index.ts";
import { AVEN_LANG_DIR } from "../ingest/paths.ts";
import { runProcess, type ProcResult } from "./proc.ts";
import { gateTag } from "./session.ts";
import type {
  CaseResult,
  DiagnosticFormat,
  GateDiagnostic,
  GateProbe,
  GateResult,
  Outcome,
} from "./schema.ts";

/** Bound on what a single probe stores, so one pathological task can't bloat the log. */
const MAX_DIAGNOSTICS = 40;
const MAX_FAILED_CASES = 25;
const MAX_MESSAGE_CHARS = 2_000;

export type GateContext = {
  dir: string;
  adapter: LangAdapter;
  attemptId: string;
  round: number;
  /** Per-tool hard timeout. */
  timeoutMs: number;
  /** `AVEN_SESSION_LOG` and friends; the tag is overridden per probe. */
  env: Record<string, string>;
  /** Record `mypy` on the Python arm. Off makes runs faster and loses the metric. */
  mypy: boolean;
  /**
   * Property names the suite is about to call on `solution`. Aven only: the
   * export-surface check uses these to fail a forgotten or incomplete export
   * record with a repair-ready diagnostic instead of an opaque suite cascade.
   * Absent or empty skips the check (Python, or a call site that has no task).
   */
  requiredExports?: readonly string[];
  /**
   * Rendering for the repair-prompt re-run of `aven check` (`avenCheckText`).
   * The JSON probe always uses `--format json`; this only affects what the
   * model reads. Defaults to `"text"` when omitted (call sites that never
   * re-render).
   */
  diagnosticFormat?: DiagnosticFormat;
};

// --- the test envelope, identical for both arms ----------------------------

type Envelope = {
  ok?: boolean;
  total?: number;
  passed?: number;
  failed?: number;
  errored?: number;
  cases?: { name?: string; outcome?: string; message?: string }[];
  load_error?: string;
};

const DIAGNOSTIC_CODE = /\[([a-z][a-z0-9]*(?:\.[a-z0-9-]+)+)\]/g;

export function extractCodes(text: string): string[] {
  return [...new Set([...text.matchAll(DIAGNOSTIC_CODE)].map((m) => m[1]!))];
}

/**
 * First line worth showing a human. Skips JSON scaffolding: a pretty-printed
 * envelope's first non-empty line is `{`, and its first non-quoted line is `],`
 * — both of which were what this returned before the letters test was added.
 */
export function firstMeaningfulLine(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || !/[A-Za-z]/.test(line)) continue;
    if (line.startsWith("{") || line.startsWith("}") || line.startsWith('"')) continue;
    return line.slice(0, 300);
  }
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed.slice(0, 300);
}

/** Byte offset -> 1-based line/column, for spans that arrive as offsets. */
export function offsetToLineCol(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: Math.max(1, offset - lineStart + 1) };
}

// --- aven check ------------------------------------------------------------

type AvenDiagnostic = {
  code: string;
  severity: string;
  message: string;
  labels?: { message: string; span: { start: number; end: number } }[];
};
type AvenCheckJson =
  | { ok: boolean; files: { path?: string; name?: string; diagnostics: AvenDiagnostic[] }[] }
  | { ok: boolean; path?: string; name?: string; diagnostics: AvenDiagnostic[] };

/**
 * `aven check --format json` emits one of two shapes: a bare file object when a
 * single file was checked, and `{files: [...]}` once imports pull in more. Both
 * are normalized here — a reader that knows only one of them silently loses the
 * solution file's diagnostics, which are the ones that matter.
 */
export function parseAvenCheck(
  stdout: string,
  sources: Map<string, string>,
): { ok: boolean; diagnostics: GateDiagnostic[] } | null {
  let json: AvenCheckJson;
  try {
    json = JSON.parse(stdout) as AvenCheckJson;
  } catch {
    return null;
  }
  const files = "files" in json ? json.files : [{ path: json.path ?? json.name, diagnostics: json.diagnostics }];
  const diagnostics: GateDiagnostic[] = [];
  for (const file of files ?? []) {
    const path = file.path ?? file.name ?? null;
    const source = path ? sources.get(path) : undefined;
    for (const d of file.diagnostics ?? []) {
      const span = d.labels?.[0]?.span;
      const pos = span && source ? offsetToLineCol(source, span.start) : null;
      diagnostics.push({
        code: d.code,
        severity: d.severity,
        message: d.message.slice(0, MAX_MESSAGE_CHARS),
        path: path ? basename(path) : null,
        line: pos?.line ?? null,
        column: pos?.column ?? null,
      });
    }
  }
  return { ok: json.ok === true, diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS) };
}

function describeDiagnostic(d: GateDiagnostic, total: number): string {
  const where = d.path ? `${d.path}:${d.line ?? 0}` : "";
  const more = total > 1 ? ` (+${total - 1} more)` : "";
  return `[${d.code}] ${where} ${d.message}${more}`.trim();
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function avenArgv(args: string[], dir: string): { argv: string[]; cwd: string } {
  const bin = process.env["AVEN_BIN"];
  return bin
    ? { argv: [bin, ...args], cwd: dir }
    : { argv: ["cargo", "run", "-q", "-p", "aven", "--", ...args], cwd: AVEN_LANG_DIR };
}

function probeFromSpawnFailure(name: string, gating: boolean, proc: ProcResult): GateProbe {
  return {
    name,
    gating,
    ok: null,
    exitCode: null,
    wallMs: proc.wallMs,
    timedOut: proc.timedOut,
    diagnosticCodes: [],
    diagnostics: [],
    detail: proc.spawnError,
    unavailableReason: proc.spawnError ?? "process could not be started",
    toolVersion: null,
  };
}

async function avenCheckProbe(ctx: GateContext): Promise<GateProbe> {
  const suite = `${ctx.dir}/${ctx.adapter.testFile}`;
  const { argv, cwd } = avenArgv(["check", "--format", "json", suite], ctx.dir);
  const proc = await runProcess(argv, {
    cwd,
    timeoutMs: ctx.timeoutMs,
    env: { ...ctx.env, AVEN_SESSION_TAG: gateTag(ctx.attemptId, ctx.round, "check") },
  });
  if (proc.spawnError) return probeFromSpawnFailure("check", true, proc);

  const sources = new Map<string, string>();
  for (const file of [ctx.adapter.testFile, ctx.adapter.solutionFile]) {
    const path = `${ctx.dir}/${file}`;
    const text = await Bun.file(path).text().catch(() => null);
    if (text !== null) sources.set(path, text);
  }
  const parsed = parseAvenCheck(proc.stdout, sources);
  const errors = (parsed?.diagnostics ?? []).filter((d) => d.severity === "error");
  const codesFromText = parsed ? [] : extractCodes(`${proc.stdout}\n${proc.stderr}`);
  return {
    name: "check",
    gating: true,
    ok: proc.timedOut ? false : parsed ? parsed.ok && errors.length === 0 : proc.exitCode === 0,
    exitCode: proc.exitCode,
    wallMs: proc.wallMs,
    timedOut: proc.timedOut,
    diagnosticCodes: parsed ? [...new Set(errors.map((d) => d.code))] : codesFromText,
    diagnostics: parsed?.diagnostics ?? [],
    // Summarize the parsed diagnostics rather than scraping stdout: the JSON is
    // pretty-printed, so the "first meaningful line" of it is punctuation. Prefer
    // an error in the *solution* — the suite's cascade diagnostics are noise.
    detail: parsed
      ? errors.length === 0
        ? null
        : describeDiagnostic(
            errors.find((d) => d.path === ctx.adapter.solutionFile) ?? errors[0]!,
            errors.length,
          )
      : firstMeaningfulLine(`${proc.stdout}\n${proc.stderr}`),
    unavailableReason: null,
    // The aven build is pinned by `avenCommit` + `avenBinarySha256` already.
    toolVersion: null,
  };
}

/**
 * Args after the binary for the repair-prompt re-render of `aven check`.
 *
 * `text` keeps today's argv (`check <suite>`) so the default path is unchanged.
 * `agent` adds `--format agent`. The agent renderer writes to stderr (see
 * `print_agent_diagnostics` in aven-cli); callers must read both streams.
 */
export function avenCheckTextArgs(suite: string, format: DiagnosticFormat = "text"): string[] {
  return format === "agent" ? ["check", "--format", "agent", suite] : ["check", suite];
}

/**
 * The human (or agent) rendering, for the repair prompt only.
 *
 * Both ariadne `text` and `--format agent` land on stderr; stdout is usually
 * empty. Concatenating both streams is deliberate, not defensive noise.
 */
export async function avenCheckText(ctx: GateContext): Promise<string> {
  const suite = `${ctx.dir}/${ctx.adapter.testFile}`;
  const format = ctx.diagnosticFormat ?? "text";
  const { argv, cwd } = avenArgv(avenCheckTextArgs(suite, format), ctx.dir);
  const proc = await runProcess(argv, {
    cwd,
    timeoutMs: ctx.timeoutMs,
    env: { ...ctx.env, AVEN_SESSION_TAG: gateTag(ctx.attemptId, ctx.round, "check-text") },
  });
  return `${proc.stdout}\n${proc.stderr}`.trim();
}

// --- the suite -------------------------------------------------------------

async function testProbe(ctx: GateContext): Promise<{ probe: GateProbe; envelope: Envelope | null }> {
  const { argv, cwd } = ctx.adapter.testCommand(ctx.dir);
  const proc = await runProcess(argv, {
    cwd,
    timeoutMs: ctx.timeoutMs,
    env: { ...ctx.env, AVEN_SESSION_TAG: gateTag(ctx.attemptId, ctx.round, "test") },
  });
  if (proc.spawnError) {
    return { probe: probeFromSpawnFailure("test", true, proc), envelope: null };
  }
  let envelope: Envelope | null = null;
  try {
    envelope = JSON.parse(proc.stdout) as Envelope;
  } catch {
    envelope = null;
  }
  const blob = `${proc.stdout}\n${proc.stderr}`;
  const verdict = proc.exitCode === null ? "load-error" : ctx.adapter.classifyExit(proc.exitCode);
  return {
    probe: {
      name: "test",
      gating: true,
      ok: !proc.timedOut && verdict === "pass",
      exitCode: proc.exitCode,
      wallMs: proc.wallMs,
      timedOut: proc.timedOut,
      // Only a load error carries diagnostic codes; a failing case carries a
      // message. Extracting codes from case messages would invent codes.
      diagnosticCodes: verdict === "load-error" ? extractCodes(blob) : [],
      diagnostics: [],
      // When the envelope parsed, summarize it. Scraping the raw output would
      // pick a line of JSON punctuation, which is what it did the first time.
      detail:
        verdict === "load-error"
          ? firstMeaningfulLine(envelope?.load_error ?? blob)
          : envelope
            ? `${envelope.passed ?? 0}/${envelope.total ?? 0} cases passed`
            : firstMeaningfulLine(blob),
      unavailableReason: null,
      // Pinned by `languageVersion` (and `avenCommit`) on the record.
      toolVersion: null,
    },
    envelope,
  };
}

// --- mypy: data, not a gate ------------------------------------------------

const MYPY_MISSING = /No module named mypy|mypy: not found|command not found/i;

/**
 * How mypy is invoked, in preference order: `MYPY_BIN`, then the binary on
 * `PATH`, then the module. `mypy` 1.20.1 is present on the dev box
 * (`~/.nix-profile/bin/mypy`), but the module form keeps a venv-only install
 * working, and the whole probe stays optional because the harness has to run on
 * machines with neither.
 */
function mypyCandidates(): string[][] {
  const explicit = process.env["MYPY_BIN"];
  return explicit ? [[explicit]] : [["mypy"], ["python3", "-m", "mypy"]];
}

/** Memoized per process: `mypy --version` costs ~200ms and never changes. */
let mypyVersionCache: { base: string[]; version: string } | null | undefined;

async function mypyVersion(base: string[]): Promise<string | null> {
  if (mypyVersionCache !== undefined) {
    return mypyVersionCache && mypyVersionCache.base.join(" ") === base.join(" ")
      ? mypyVersionCache.version
      : null;
  }
  const proc = await runProcess([...base, "--version"], { cwd: process.cwd(), timeoutMs: 30_000 });
  if (proc.spawnError || proc.exitCode !== 0) {
    mypyVersionCache = null;
    return null;
  }
  const version = proc.stdout.trim().split("\n")[0] ?? null;
  mypyVersionCache = version ? { base, version } : null;
  return version;
}

async function mypyProbe(ctx: GateContext): Promise<GateProbe> {
  let last: ProcResult | null = null;
  for (const base of mypyCandidates()) {
    const proc = await runProcess(
      [
        ...base,
        "--ignore-missing-imports",
        "--no-color-output",
        // Explicit rather than relying on the default, so a row's codes mean the
        // same thing across mypy versions.
        "--show-error-codes",
        ctx.adapter.solutionFile,
      ],
      { cwd: ctx.dir, timeoutMs: ctx.timeoutMs },
    );
    last = proc;
    if (proc.spawnError) continue;
    if (MYPY_MISSING.test(`${proc.stdout}\n${proc.stderr}`)) continue;
    // mypy writes findings to stdout, one per line:
    //   solution.py:3: error: Incompatible return value type … [return-value]
    // and a trailing summary line, which is not a finding.
    const lines = proc.stdout
      .split("\n")
      .filter((l) => /: (error|note|warning):/.test(l))
      .slice(0, MAX_DIAGNOSTICS);
    return {
      name: "mypy",
      // Recorded, never gating. Python's bar stays "the tests pass"; see the
      // module comment.
      gating: false,
      ok: proc.exitCode === 0,
      exitCode: proc.exitCode,
      wallMs: proc.wallMs,
      timedOut: proc.timedOut,
      diagnosticCodes: [...new Set(lines.map((l) => mypyCode(l)))],
      diagnostics: lines.map((l) => ({
        code: mypyCode(l),
        severity: /: error:/.test(l) ? "error" : /: warning:/.test(l) ? "warning" : "note",
        message: l.slice(0, MAX_MESSAGE_CHARS),
        path: ctx.adapter.solutionFile,
        line: Number(/:(\d+):/.exec(l)?.[1] ?? "") || null,
        column: null,
      })),
      detail: firstMeaningfulLine(proc.stdout),
      unavailableReason: null,
      toolVersion: await mypyVersion(base),
    };
  }
  return {
    name: "mypy",
    gating: false,
    // Not installed is `null`, never `false`: "no opinion" and "found problems"
    // are different rows.
    ok: null,
    exitCode: null,
    wallMs: last?.wallMs ?? 0,
    timedOut: false,
    diagnosticCodes: [],
    diagnostics: [],
    detail: null,
    unavailableReason: "mypy is not installed (`nix-shell -p mypy`, or set MYPY_BIN)",
    toolVersion: null,
  };
}

/** `solution.py:3: error: … [return-value]` -> `mypy.return-value`. */
export function mypyCode(line: string): string {
  const bracket = /\[([a-z-]+)\]\s*$/.exec(line);
  if (bracket) return `mypy.${bracket[1]}`;
  return /: error:/.test(line) ? "mypy.error" : /: warning:/.test(line) ? "mypy.warning" : "mypy.note";
}

// --- classification --------------------------------------------------------

/**
 * Outcome from the probes, in precedence order.
 *
 * Precedence matters: a solution that neither parses nor passes is a
 * `parse_error`, because that is the earliest thing that went wrong and the
 * bucket the §6 triage wants it in.
 */
export function classifyOutcome(probes: GateProbe[], envelope: Envelope | null, blobCodes: string[]): Outcome {
  const gating = probes.filter((p) => p.gating);
  if (gating.some((p) => p.timedOut)) return "timeout";
  if (gating.some((p) => p.ok === null)) return "harness_error";
  if (gating.every((p) => p.ok === true)) return "pass";

  const check = probes.find((p) => p.name === "check");
  const test = probes.find((p) => p.name === "test");
  const codes = [...(check?.diagnosticCodes ?? []), ...(test?.diagnosticCodes ?? []), ...blobCodes];
  const hasParse = codes.some((c) => c.startsWith("parse.") || c.startsWith("lex."));

  // A suite that never loaded: the solution is not runnable at all.
  const loadError = test && test.exitCode !== null && test.exitCode >= 2;
  if (loadError) {
    if (hasParse) return "parse_error";
    return codes.length > 0 ? "check_error" : "runtime_error";
  }
  if (check && check.ok === false) return hasParse ? "parse_error" : "check_error";
  if ((envelope?.errored ?? 0) > 0) return "runtime_error";
  if ((envelope?.failed ?? 0) > 0) return "wrong_output";
  return test?.ok === false ? "runtime_error" : "wrong_output";
}

/**
 * Fail the round when `solution.av` does not export the names the suite needs.
 *
 * Runs **after `aven check` passes**, never before it. The check is syntactic —
 * it looks for a trailing literal record — so on a file that does not parse it
 * reports "exports nothing" no matter what the real defect was. That is an
 * actively misleading diagnostic for the most common malformed output there is:
 * a truncated `{ double` did write an export record, and being told it wrote
 * none points away from the actual problem.
 *
 * Ordering it after `check` costs nothing it was trying to buy. The cascade this
 * probe exists to pre-empt is the *suite* failing to find the functions, which is
 * downstream of `check`; and `check` accepts a no-export module silently (that
 * being the whole finding), so it never swallows the case. Syntax errors get the
 * compiler's diagnostic, and a module that parses but exports the wrong surface
 * gets this one.
 *
 * The message is written so `gate.detail` lands in the repair prompt unchanged —
 * the entire reason this probe exists. It is a model failure (`check_error`),
 * never a harness error: the model wrote a solution whose public surface is wrong.
 */
async function avenExportProbe(ctx: GateContext): Promise<GateProbe | null> {
  const required = ctx.requiredExports;
  if (!required || required.length === 0) return null;
  const path = `${ctx.dir}/${ctx.adapter.solutionFile}`;
  const source = await Bun.file(path).text().catch(() => null);
  if (source === null) {
    // Missing file is already handled by the agent-turn path; if we still reach
    // the gate without a solution the suite will say so. Do not invent a probe.
    return null;
  }
  const check = checkAvenExports(source, required);
  if (check.ok) return null;
  return {
    name: "exports",
    gating: true,
    ok: false,
    exitCode: null,
    wallMs: 0,
    timedOut: false,
    diagnosticCodes: [`bench.${check.kind}`],
    diagnostics: [
      {
        code: `bench.${check.kind}`,
        severity: "error",
        message: check.message.slice(0, MAX_MESSAGE_CHARS),
        path: ctx.adapter.solutionFile,
        line: null,
        column: null,
      },
    ],
    detail: check.message.slice(0, MAX_MESSAGE_CHARS),
    unavailableReason: null,
    toolVersion: null,
  };
}

export async function runGate(ctx: GateContext): Promise<GateResult> {
  const probes: GateProbe[] = [];

  // Static gate first: it is the cheaper tool and the earlier failure.
  if (ctx.adapter.id === "aven") {
    const checkProbe = await avenCheckProbe(ctx);
    probes.push(checkProbe);

    // Export surface, but only once the file parses — see `avenExportProbe`.
    // A syntactic export scan on unparseable source blames the wrong thing.
    if (checkProbe.ok) {
      const exports = await avenExportProbe(ctx);
      if (exports) {
        probes.push(exports);
        return {
          ok: false,
          probes,
          casesTotal: 0,
          casesPassed: 0,
          casesFailed: 0,
          casesErrored: 0,
          failedCases: [],
          // Interface is wrong before the suite runs — same bucket as a check
          // rejection, and not a harness_error (we measured the model).
          outcome: "check_error",
          detail: exports.detail,
        };
      }
    }
  }

  const { probe: test, envelope } = await testProbe(ctx);
  probes.push(test);

  if (ctx.adapter.id === "python" && ctx.mypy) probes.push(await mypyProbe(ctx));

  const cases: CaseResult[] = (envelope?.cases ?? []).map((c) => ({
    name: c.name ?? "(unnamed)",
    outcome: c.outcome ?? "unknown",
    message: (c.message ?? "").slice(0, MAX_MESSAGE_CHARS),
  }));
  const failedCases = cases.filter((c) => c.outcome !== "pass").slice(0, MAX_FAILED_CASES);
  const blobCodes = test.diagnosticCodes;
  const outcome = classifyOutcome(probes, envelope, blobCodes);
  const gating = probes.filter((p) => p.gating);

  return {
    ok: gating.length > 0 && gating.every((p) => p.ok === true),
    probes,
    casesTotal: envelope?.total ?? 0,
    casesPassed: envelope?.passed ?? 0,
    casesFailed: envelope?.failed ?? 0,
    casesErrored: envelope?.errored ?? 0,
    failedCases,
    outcome,
    detail:
      probes.find((p) => p.gating && p.ok !== true)?.detail ??
      (outcome === "pass" ? null : (test.detail ?? null)),
  };
}

/** Flat mirrors of the probe list; see the schema comment for why they exist. */
export function probeMirrors(
  probes: GateProbe[],
  solutionFile: string,
): { checkOk: boolean | null; checkOkSolutionOnly: boolean | null; testOk: boolean | null; mypyOk: boolean | null } {
  const check = probes.find((p) => p.name === "check");
  const test = probes.find((p) => p.name === "test");
  const mypy = probes.find((p) => p.name === "mypy");
  const solutionErrors = check
    ? check.diagnostics.filter((d) => d.severity === "error" && d.path === solutionFile)
    : [];
  return {
    checkOk: check ? check.ok : null,
    // A check that failed only on the generated suite is not the model's
    // failure. Recorded separately so the two causes stay separable.
    checkOkSolutionOnly: check
      ? check.ok === true
        ? true
        : check.diagnostics.length > 0
          ? solutionErrors.length === 0
          : null
      : null,
    testOk: test ? test.ok : null,
    mypyOk: mypy ? mypy.ok : null,
  };
}
