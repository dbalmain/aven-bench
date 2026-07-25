#!/usr/bin/env bun
/**
 * Materialize per-language work directories from the committed corpus.
 *
 *   bun run generate --lang aven,python [--task two-fer,acronym] [--out DIR]
 *                    [--intersect] [--with-reference]
 *
 * Output (gitignored — derived, cheap to rebuild):
 *
 *   data/generated/<lang>/<task>/solution_test.av   the suite
 *   data/generated/<lang>/<task>/prompt.md          statement + language contract
 *   data/generated/<lang>/<task>/solution.*         only with --with-reference
 *   data/generated/report.json                      omitted cases, per language
 *
 * `--intersect` restricts every language to the cases *all* selected languages
 * can render, which is what an A/B between arms needs. Without it each language
 * gets everything it can express, and the difference is visible in report.json.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { adapterFor, type LangAdapter, type OmittedCase } from "../adapters/lang/index.ts";
import { CORPUS_DIR, DATA_DIR, REFERENCES_DIR } from "./paths.ts";
import { loadIndex, loadTask, type Task } from "./task.ts";

export type GenerateOptions = {
  languages: string[];
  tasks?: string[];
  outDir: string;
  intersect: boolean;
  withReference: boolean;
};

export type GenerateReport = {
  outDir: string;
  intersect: boolean;
  languages: string[];
  perLanguage: Record<
    string,
    {
      tasks: number;
      casesRendered: number;
      casesOmitted: number;
      tasksFullyRendered: number;
      tasksWithOmissions: string[];
      omissionReasons: Record<string, number>;
      omitted: (OmittedCase & { task: string })[];
    }
  >;
};

function parseList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseArgs(argv: string[]): GenerateOptions {
  const flags = new Map<string, string>();
  const bare = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      bare.add(key);
    }
  }
  const languages = parseList(flags.get("lang")) ?? ["aven", "python"];
  const tasks = parseList(flags.get("task"));
  return {
    languages,
    ...(tasks ? { tasks } : {}),
    outDir: flags.get("out") ?? `${DATA_DIR}/generated`,
    intersect: bare.has("intersect"),
    withReference: bare.has("with-reference"),
  };
}

/** Which cases can this adapter render? Derived by rendering and diffing. */
function renderableUuids(adapter: LangAdapter, task: Task): Set<string> {
  const { omitted } = adapter.renderTests(task);
  const bad = new Set(omitted.map((o) => o.uuid));
  return new Set(task.cases.map((c) => c.uuid).filter((u) => !bad.has(u)));
}

export async function generate(opts: GenerateOptions): Promise<GenerateReport> {
  const adapters = opts.languages.map(adapterFor);
  const index = await loadIndex(CORPUS_DIR);
  const ids = opts.tasks ?? index.tasks.map((t) => t.id);

  const report: GenerateReport = {
    outDir: opts.outDir,
    intersect: opts.intersect,
    languages: opts.languages,
    perLanguage: Object.fromEntries(
      opts.languages.map((l) => [
        l,
        {
          tasks: 0,
          casesRendered: 0,
          casesOmitted: 0,
          tasksFullyRendered: 0,
          tasksWithOmissions: [] as string[],
          omissionReasons: {} as Record<string, number>,
          omitted: [] as (OmittedCase & { task: string })[],
        },
      ]),
    ),
  };

  for (const adapter of adapters) rmSync(`${opts.outDir}/${adapter.id}`, { recursive: true, force: true });

  for (const id of ids) {
    const task = await loadTask(CORPUS_DIR, id);
    const promptBody = await Bun.file(`${CORPUS_DIR}/${id}/prompt.md`).text();

    let only: ReadonlySet<string> | undefined;
    if (opts.intersect) {
      const sets = adapters.map((a) => renderableUuids(a, task));
      only = new Set(task.cases.map((c) => c.uuid).filter((u) => sets.every((s) => s.has(u))));
    }

    for (const adapter of adapters) {
      const stats = report.perLanguage[adapter.id]!;
      const { contents, omitted } = adapter.renderTests(task, only);
      const dir = `${opts.outDir}/${adapter.id}/${id}`;
      mkdirSync(dir, { recursive: true });
      await Bun.write(`${dir}/${adapter.testFile}`, contents);
      await Bun.write(
        `${dir}/prompt.md`,
        `${promptBody.trimEnd()}\n\n${adapter.renderContract(task)}\n`,
      );

      if (opts.withReference) {
        const ref = `${REFERENCES_DIR}/${id}/${adapter.solutionFile}`;
        if (existsSync(ref)) cpSync(ref, `${dir}/${adapter.solutionFile}`);
      }

      const rendered = (only ? [...only].length : task.cases.length) - omitted.length;
      stats.tasks++;
      stats.casesRendered += rendered;
      stats.casesOmitted += omitted.length;
      if (omitted.length === 0) stats.tasksFullyRendered++;
      else stats.tasksWithOmissions.push(id);
      for (const o of omitted) {
        stats.omitted.push({ task: id, ...o });
        const bucket = classifyReason(o.reason);
        stats.omissionReasons[bucket] = (stats.omissionReasons[bucket] ?? 0) + 1;
      }
    }
  }

  mkdirSync(opts.outDir, { recursive: true });
  await Bun.write(`${opts.outDir}/report.json`, JSON.stringify(report, null, 2) + "\n");
  return report;
}

/** Collapse a per-value reason into a bucket, so the report stays readable. */
export function classifyReason(reason: string): string {
  if (/does not fit/.test(reason)) return "integer-too-large-for-i64";
  if (/exponent-form/.test(reason)) return "exponent-form-float";
  return reason;
}

if (import.meta.main) {
  const opts = parseArgs(Bun.argv.slice(2));
  const report = await generate(opts);
  console.log(`out           ${opts.outDir}${opts.intersect ? "  (intersected)" : ""}`);
  for (const [lang, s] of Object.entries(report.perLanguage)) {
    console.log(
      `${lang.padEnd(14)}${s.tasks} tasks, ${s.casesRendered} cases rendered, ` +
        `${s.casesOmitted} omitted (${s.tasksWithOmissions.length} tasks affected)` +
        (Object.keys(s.omissionReasons).length > 0
          ? `\n              ${JSON.stringify(s.omissionReasons)}`
          : ""),
    );
  }
}
