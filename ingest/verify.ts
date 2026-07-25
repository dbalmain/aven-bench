#!/usr/bin/env bun
/**
 * Prove the generated suites are real, not plausible-looking text.
 *
 *   bun run verify                    # both checks, both languages
 *   bun run verify --lang aven
 *   bun run verify --only-references
 *
 * Two independent checks:
 *
 * 1. **Reference check.** For every task under `references/`, run the generated
 *    suite against the hand-written reference solution and require a green run
 *    (`aven test` exit 0 / py_runner exit 0). A reference that fails means the
 *    generator, not the solution, is probably wrong.
 *
 * 1b. **Negative check.** Wherever a `solution.broken.*` fixture exists, the
 *    same suite must report a *failure*. A generator that emitted a vacuous or
 *    self-satisfying suite would pass check 1 and fail here, so this is the
 *    guard against a false green.
 *
 * 2. **Load sweep.** For every task, run the suite against a generated *stub*
 *    solution that defines the right functions and returns nothing useful. The
 *    suite must fail (exit 1), never fail to load (exit 2). This measures how
 *    much of the corpus the language can even express, separately from whether
 *    anyone can solve it.
 *
 * Results land in `data/verify-report.json` with per-task detail.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { adapterFor, casesOf, type LangAdapter } from "../adapters/lang/index.ts";
import { AVEN_LANG_DIR, CORPUS_DIR, DATA_DIR, REFERENCES_DIR } from "./paths.ts";
import { pyName } from "../adapters/lang/python.ts";
import { renderAvenValue } from "../adapters/lang/aven.ts";
import { loadIndex, loadTask, type Task } from "./task.ts";

const CONCURRENCY = Number(process.env["AVEN_BENCH_CONCURRENCY"] ?? 12);

type Outcome = {
  task: string;
  lang: string;
  exitCode: number;
  verdict: "pass" | "fail" | "load-error";
  total?: number;
  passed?: number;
  /** Diagnostic codes from a load error, e.g. `parse.unexpected-token`. */
  codes?: string[];
  detail?: string;
};

/**
 * A stub solution: right names, right arity, mostly-wrong answers.
 *
 * Each property returns a join of *every* distinct expected value in its cases,
 * through a chain of tautological matches. That matters for the check sweep: a
 * stub returning only the first case's type would report its own narrowness as
 * a type error in the suite. Joining everything means a clean `aven check` says
 * "the suite is expressible given a solution with the right return type", which
 * is the question being asked. Fallible properties also join `@Err` so
 * `expectEq(_, @Ok(v))` and `expectErr(_)` both type-check.
 */
function stubSolution(task: Task, lang: string): string {
  if (lang === "aven") {
    const defs = task.properties.map((p) => {
      const params = p.argNames.map((_, i) => `a${i}`);
      const values: string[] = [];
      for (const c of casesOf(task, p.name)) {
        if (c.expected.kind !== "value") continue;
        try {
          const text = renderAvenValue(c.expected.value);
          if (!values.includes(text)) values.push(text);
        } catch {
          // Unrenderable expected value: its case is omitted from the suite too.
        }
      }
      const arms = p.returnsResult
        ? [...values.map((v) => `@Ok(${v})`), '@Err("stub")']
        : values.length > 0
          ? values
          : ["null"];
      // `a0 == a0` rather than `true` so the checker joins the branches instead
      // of narrowing to the taken one.
      const guard = params[0] ? `${params[0]} == ${params[0]}` : undefined;
      const body =
        arms.length === 1 || guard === undefined
          ? arms[0]!
          : arms
              .slice(0, -1)
              .reduceRight(
                (rest, v) => `(${guard} ?> true => ${v}, false => ${rest})`,
                arms[arms.length - 1]!,
              );
      return `${p.name} = (${params.join(", ")}) => ${body}`;
    });
    const exports = task.properties.map((p) => p.name).join(", ");
    return `# stub: correct names and arity, deliberately wrong answers\n${defs.join("\n")}\n\n{ ${exports} }\n`;
  }
  if (lang === "python") {
    const defs = task.properties.map((p) => {
      const params = p.argNames.map((_, i) => `a${i}`).join(", ");
      const body = p.returnsResult ? '    raise ValueError("stub")' : "    return None";
      return `def ${pyName(p.name)}(${params}):\n${body}\n`;
    });
    return `# stub: correct names and arity, deliberately wrong answers\n${defs.join("\n")}`;
  }
  throw new Error(`no stub generator for ${lang}`);
}

const DIAGNOSTIC_CODE = /\[([a-z][a-z0-9]*(?:\.[a-z0-9-]+)+)\]/g;

function extractCodes(text: string): string[] {
  return [...new Set([...text.matchAll(DIAGNOSTIC_CODE)].map((m) => m[1]!))];
}

async function runSuite(adapter: LangAdapter, dir: string): Promise<Outcome> {
  const { argv, cwd } = adapter.testCommand(dir);
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const verdict = adapter.classifyExit(exitCode);
  const out: Outcome = { task: "", lang: adapter.id, exitCode, verdict };
  try {
    const json = JSON.parse(stdout) as { total?: number; passed?: number };
    if (typeof json.total === "number") out.total = json.total;
    if (typeof json.passed === "number") out.passed = json.passed;
  } catch {
    // Not JSON: a load error printed diagnostics instead.
  }
  if (verdict === "load-error") {
    const blob = `${stdout}\n${stderr}`;
    out.codes = extractCodes(blob);
    out.detail = firstMeaningfulLine(blob);
  }
  return out;
}

function firstMeaningfulLine(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line && !line.startsWith("{") && !line.startsWith("}")) return line.slice(0, 300);
  }
  return text.slice(0, 300);
}

type CheckJson = {
  ok: boolean;
  files: { path: string; diagnostics: { code: string; severity: string; message: string }[] }[];
};

/**
 * `aven test` only parses and evaluates — `aven check` is the static gate, and
 * the stricter, more informative bar for "can Aven express this task". Run
 * against the well-typed stub so any error is the suite's, not the stub's.
 */
async function checkSuite(dir: string, testFile: string): Promise<{
  ok: boolean;
  errorCodes: string[];
  messages: string[];
}> {
  const bin = process.env["AVEN_BIN"];
  const argv = bin
    ? [bin, "check", "--format", "json", `${dir}/${testFile}`]
    : ["cargo", "run", "-q", "-p", "aven", "--", "check", "--format", "json", `${dir}/${testFile}`];
  const proc = Bun.spawn(argv, {
    cwd: bin ? dir : AVEN_LANG_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  let json: CheckJson;
  try {
    json = JSON.parse(stdout) as CheckJson;
  } catch {
    return { ok: false, errorCodes: ["(check produced no JSON)"], messages: [stdout.slice(0, 200)] };
  }
  const errors = json.files.flatMap((f) =>
    f.diagnostics.filter((d) => d.severity === "error").map((d) => ({ ...d, path: f.path })),
  );
  return {
    ok: errors.length === 0,
    errorCodes: [...new Set(errors.map((e) => e.code))],
    messages: [...new Set(errors.map((e) => e.message))].slice(0, 4),
  };
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

function tally(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs.sort()) out[x] = (out[x] ?? 0) + 1;
  return out;
}

async function materialize(
  adapter: LangAdapter,
  task: Task,
  root: string,
  solution: string,
): Promise<string> {
  const dir = `${root}/${adapter.id}/${task.id}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await Bun.write(`${dir}/${adapter.testFile}`, adapter.renderTests(task).contents);
  await Bun.write(`${dir}/${adapter.solutionFile}`, solution);
  return dir;
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const langFlag = argv.indexOf("--lang");
  const languages =
    langFlag >= 0 ? argv[langFlag + 1]!.split(",") : ["aven", "python"];
  const onlyReferences = argv.includes("--only-references");

  const index = await loadIndex(CORPUS_DIR);
  const tasks = await Promise.all(index.tasks.map((t) => loadTask(CORPUS_DIR, t.id)));
  const referenced = existsSync(REFERENCES_DIR)
    ? readdirSync(REFERENCES_DIR).filter((n) => statSync(`${REFERENCES_DIR}/${n}`).isDirectory())
    : [];

  const report: Record<string, unknown> = { languages, referenceTasks: referenced };

  for (const lang of languages) {
    const adapter = adapterFor(lang);

    // --- 1. reference check -------------------------------------------------
    const refRoot = `${DATA_DIR}/verify/reference`;
    const refTasks = tasks.filter(
      (t) => referenced.includes(t.id) && existsSync(`${REFERENCES_DIR}/${t.id}/${adapter.solutionFile}`),
    );
    const refOutcomes = await pool(refTasks, CONCURRENCY, async (task) => {
      const solution = await Bun.file(`${REFERENCES_DIR}/${task.id}/${adapter.solutionFile}`).text();
      const dir = await materialize(adapter, task, refRoot, solution);
      return { ...(await runSuite(adapter, dir)), task: task.id };
    });

    // --- 1b. negative check -------------------------------------------------
    const brokenName = adapter.solutionFile.replace(/(\.[^.]+)$/, ".broken$1");
    const brokenTasks = tasks.filter(
      (t) => referenced.includes(t.id) && existsSync(`${REFERENCES_DIR}/${t.id}/${brokenName}`),
    );
    const brokenOutcomes = await pool(brokenTasks, CONCURRENCY, async (task) => {
      const solution = await Bun.file(`${REFERENCES_DIR}/${task.id}/${brokenName}`).text();
      const dir = await materialize(adapter, task, `${DATA_DIR}/verify/broken`, solution);
      return { ...(await runSuite(adapter, dir)), task: task.id };
    });
    // "fail" is the only acceptable verdict: `pass` is a false green, and
    // `load-error` would mean the suite never got as far as asserting anything.
    const brokenWrong = brokenOutcomes.filter((o) => o.verdict !== "fail");

    // --- 2. load sweep ------------------------------------------------------
    const sweepOutcomes = onlyReferences
      ? []
      : await pool(tasks, CONCURRENCY, async (task) => {
          const dir = await materialize(adapter, task, `${DATA_DIR}/verify/stub`, stubSolution(task, lang));
          return { ...(await runSuite(adapter, dir)), task: task.id };
        });

    // --- 3. static-check sweep (Aven only) ----------------------------------
    const checkResults =
      lang === "aven" && !onlyReferences
        ? await pool(tasks, CONCURRENCY, async (task) => ({
            task: task.id,
            ...(await checkSuite(`${DATA_DIR}/verify/stub/aven/${task.id}`, adapter.testFile)),
          }))
        : [];
    const checkFailures = checkResults.filter((c) => !c.ok);

    const loadErrors = sweepOutcomes.filter((o) => o.verdict === "load-error");
    report[lang] = {
      reference: {
        tasks: refOutcomes.length,
        green: refOutcomes.filter((o) => o.verdict === "pass").length,
        failures: refOutcomes.filter((o) => o.verdict !== "pass"),
      },
      negative: {
        tasks: brokenOutcomes.length,
        correctlyFailed: brokenOutcomes.filter((o) => o.verdict === "fail").length,
        wrong: brokenWrong,
        outcomes: brokenOutcomes,
      },
      loadSweep: {
        tasks: sweepOutcomes.length,
        loadable: sweepOutcomes.filter((o) => o.verdict !== "load-error").length,
        loadErrors: loadErrors.length,
        byCode: tally(loadErrors.flatMap((o) => o.codes ?? ["(no code)"])),
        detail: loadErrors.map((o) => ({ task: o.task, codes: o.codes, detail: o.detail })),
      },
      checkSweep: {
        tasks: checkResults.length,
        clean: checkResults.length - checkFailures.length,
        byCode: tally(checkFailures.flatMap((c) => c.errorCodes)),
        detail: checkFailures,
      },
      outcomes: [...refOutcomes, ...sweepOutcomes],
    };

    console.log(`--- ${adapter.displayName} ---`);
    console.log(
      `references     ${refOutcomes.filter((o) => o.verdict === "pass").length}/${refOutcomes.length} green` +
        (refOutcomes.some((o) => o.verdict !== "pass")
          ? `   FAILED: ${refOutcomes.filter((o) => o.verdict !== "pass").map((o) => `${o.task}(${o.verdict})`).join(", ")}`
          : ""),
    );
    console.log(
      `broken fixtures ${brokenOutcomes.filter((o) => o.verdict === "fail").length}/` +
        `${brokenOutcomes.length} correctly reported as failing` +
        (brokenWrong.length > 0
          ? `   FALSE GREEN: ${brokenWrong.map((o) => `${o.task}(${o.verdict})`).join(", ")}`
          : ""),
    );
    if (!onlyReferences) {
      console.log(
        `load sweep     ${sweepOutcomes.length - loadErrors.length}/${sweepOutcomes.length} suites load` +
          ` (${loadErrors.length} load-error)`,
      );
      for (const [code, n] of Object.entries(tally(loadErrors.flatMap((o) => o.codes ?? ["(no code)"]))))
        console.log(`  ${code.padEnd(40)}${n}`);
      if (checkResults.length > 0) {
        console.log(
          `check sweep    ${checkResults.length - checkFailures.length}/${checkResults.length}` +
            ` suites type-check clean (${checkFailures.length} with errors)`,
        );
        for (const [code, n] of Object.entries(tally(checkFailures.flatMap((c) => c.errorCodes))))
          console.log(`  ${code.padEnd(40)}${n}`);
      }
    }
  }

  mkdirSync(DATA_DIR, { recursive: true });
  await Bun.write(`${DATA_DIR}/verify-report.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nreport -> ${DATA_DIR}/verify-report.json`);
}

await main();
