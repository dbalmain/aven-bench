#!/usr/bin/env bun
/**
 * Ingest: `vendor/problem-specifications` -> the committed `corpus/`.
 *
 *   bun run ingest
 *
 * Reads every `exercises/<id>/canonical-data.json`, flattens the case tree,
 * normalizes each case into `{property, args[], expected}`, and writes:
 *
 *   corpus/index.json             the task list + aggregate counts
 *   corpus/ingest-report.json     everything questionable, for humans
 *   corpus/<id>/task.json         normalized cases
 *   corpus/<id>/prompt.md         the task statement, both upstream layouts
 *
 * Nothing here is hand-authored and nothing here is task-specific: if a task
 * cannot be expressed, that is a finding, not a place to add a special case.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import {
  fromPortable,
  parseJson,
  toPortable,
  valueKinds,
  type JVal,
  type Portable,
} from "./json.ts";
import { CORPUS_DIR, VENDOR_DIR } from "./paths.ts";
import {
  TASK_SCHEMA_VERSION,
  type CorpusIndex,
  type Expected,
  type Task,
  type TaskCase,
  type TaskProperty,
} from "./task.ts";

const UPSTREAM = "exercism/problem-specifications";

// --- upstream tree walking -------------------------------------------------

type RawNode = Map<string, JVal>;

function asObject(v: JVal, what: string): RawNode {
  if (v.kind !== "object") throw new Error(`${what}: expected object, got ${v.kind}`);
  return new Map(v.entries.map((e) => [e.key, e.value]));
}

function str(node: RawNode, key: string): string | undefined {
  const v = node.get(key);
  return v && v.kind === "string" ? v.value : undefined;
}

function strList(node: RawNode, key: string): string[] {
  const v = node.get(key);
  if (!v || v.kind !== "array") return [];
  return v.items.flatMap((i) => (i.kind === "string" ? [i.value] : []));
}

/** `{ "error": "..." }` is the one structure the upstream schema pins down. */
function asExpected(v: JVal): Expected {
  if (v.kind === "object" && v.entries.length === 1) {
    const only = v.entries[0]!;
    if (only.key === "error" && only.value.kind === "string") {
      return { kind: "error", message: only.value.value };
    }
  }
  return { kind: "value", value: toPortable(v) };
}

type Leaf = {
  uuid: string;
  description: string;
  group: string[];
  property: string;
  input: { key: string; value: JVal }[];
  expected: Expected;
  scenarios: string[];
  reimplements?: string;
};

function collectLeaves(cases: JVal, group: string[], out: Leaf[], where: string): void {
  if (cases.kind !== "array") throw new Error(`${where}: cases must be an array`);
  for (const [i, item] of cases.items.entries()) {
    const node = asObject(item, `${where}[${i}]`);
    const description = str(node, "description") ?? `case ${i}`;
    const nested = node.get("cases");
    if (nested) {
      collectLeaves(nested, [...group, description], out, `${where}[${i}].cases`);
      continue;
    }
    const uuid = str(node, "uuid");
    const property = str(node, "property");
    const input = node.get("input");
    const expected = node.get("expected");
    if (!uuid || !property || !input || expected === undefined) {
      throw new Error(`${where}[${i}]: leaf case missing uuid/property/input/expected`);
    }
    if (input.kind !== "object") {
      throw new Error(`${where}[${i}]: input must be an object, got ${input.kind}`);
    }
    const reimplements = str(node, "reimplements");
    out.push({
      uuid,
      description,
      group,
      property,
      input: input.entries.map((e) => ({ key: e.key, value: e.value })),
      expected: asExpected(expected),
      scenarios: strList(node, "scenarios"),
      ...(reimplements ? { reimplements } : {}),
    });
  }
}

// --- prompt assembly -------------------------------------------------------

/**
 * Two disjoint upstream layouts: legacy `description.md`, or the current
 * `introduction.md` + `instructions.md` pair. Neither filename covers the
 * corpus, so read whichever exist and record which were used.
 */
async function buildPrompt(dir: string): Promise<{ body: string; files: string[] }> {
  const parts: string[] = [];
  const files: string[] = [];
  for (const name of ["introduction.md", "instructions.md", "description.md"]) {
    const path = `${dir}/${name}`;
    if (!existsSync(path)) continue;
    files.push(name);
    parts.push((await Bun.file(path).text()).trim());
  }
  return { body: parts.join("\n\n"), files };
}

/** metadata.toml is a handful of flat `key = "value"` lines; no TOML dep needed. */
async function readMetadata(dir: string): Promise<{ title?: string; blurb?: string }> {
  const path = `${dir}/metadata.toml`;
  if (!existsSync(path)) return {};
  const text = await Bun.file(path).text();
  const pick = (key: string): string | undefined => {
    const m = text.match(new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m"));
    return m?.[1]?.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  };
  const title = pick("title");
  const blurb = pick("blurb");
  return { ...(title ? { title } : {}), ...(blurb ? { blurb } : {}) };
}

// --- normalization ---------------------------------------------------------

function uniqueNames(leaves: Leaf[]): string[] {
  const seen = new Map<string, number>();
  return leaves.map((leaf) => {
    const base = [...leaf.group, leaf.description].join(" > ");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

function buildProperties(cases: TaskCase[]): TaskProperty[] {
  const byProperty = new Map<string, TaskCase[]>();
  for (const c of cases) {
    const list = byProperty.get(c.property) ?? [];
    list.push(c);
    byProperty.set(c.property, list);
  }
  return [...byProperty].map(([name, list]) => {
    const variantCounts = new Map<string, number>();
    for (const c of list) {
      const key = JSON.stringify(c.args.map((a) => a.name));
      variantCounts.set(key, (variantCounts.get(key) ?? 0) + 1);
    }
    const variants = [...variantCounts].sort((a, b) => b[1] - a[1]);
    const argNames = JSON.parse(variants[0]![0]) as string[];
    return {
      name,
      argNames,
      arity: argNames.length,
      caseCount: list.length,
      returnsResult: list.some((c) => c.expected.kind === "error"),
      argOrderVariants: variants.map(([k]) => JSON.parse(k) as string[]),
      ambiguousArgOrder: variants.length > 1,
    };
  });
}

// --- findings --------------------------------------------------------------

export type Finding =
  | { task: string; kind: "arg-order-variants"; property: string; variants: string[][] }
  | { task: string; kind: "arg-name-set-differs"; property: string; variants: string[][] }
  | { task: string; kind: "arity-varies"; property: string; arities: number[] }
  | { task: string; kind: "positional-order-unverifiable"; property: string; argNames: string[] }
  | { task: string; kind: "dropped-superseded-cases"; uuids: string[] }
  | { task: string; kind: "duplicate-case-names"; names: string[] };

function argKindSignature(value: Portable): string {
  return [...valueKinds(fromPortable(value))].sort().join("+");
}

function findingsFor(task: Task, droppedUuids: string[], names: string[]): Finding[] {
  const out: Finding[] = [];
  for (const p of task.properties) {
    if (p.ambiguousArgOrder) {
      const arities = [...new Set(p.argOrderVariants.map((v) => v.length))];
      if (arities.length > 1) {
        out.push({ task: task.id, kind: "arity-varies", property: p.name, arities });
      }
      const sets = new Set(p.argOrderVariants.map((v) => JSON.stringify([...v].sort())));
      out.push({
        task: task.id,
        kind: sets.size === 1 ? "arg-order-variants" : "arg-name-set-differs",
        property: p.name,
        variants: p.argOrderVariants,
      });
    }
    // Adjacent arguments that always carry the same kind of value: a generator
    // cannot detect a swap, so a wrong order guess yields a silently wrong test
    // rather than a failing one. Worth a human glance, per task.
    if (p.arity > 1 && !p.ambiguousArgOrder) {
      const rows = task.cases
        .filter((c) => c.property === p.name)
        .map((c) => c.args.map((a) => argKindSignature(a.value)));
      const columns = p.argNames.map((_, i) => new Set(rows.map((r) => r[i] ?? "")));
      const perColumn = columns.map((s) => [...s].sort().join("|"));
      if (new Set(perColumn).size === 1) {
        out.push({
          task: task.id,
          kind: "positional-order-unverifiable",
          property: p.name,
          argNames: p.argNames,
        });
      }
    }
  }
  if (droppedUuids.length > 0) {
    out.push({ task: task.id, kind: "dropped-superseded-cases", uuids: droppedUuids });
  }
  const dupes = names.filter((n) => /\(\d+\)$/.test(n));
  if (dupes.length > 0) {
    out.push({ task: task.id, kind: "duplicate-case-names", names: dupes });
  }
  return out;
}

// --- rendering -------------------------------------------------------------

function renderPromptFile(blurb: string, body: string, task: Task): string {
  const lines: string[] = [`# ${task.title}`, ""];
  if (blurb) lines.push(blurb, "");
  lines.push(
    body
      .replace(/^#\s+Introduction\s*$/m, "## Introduction")
      .replace(/^#\s+Instructions\s*$/m, "## Instructions"),
  );
  if (task.comments.length > 0) {
    lines.push("", "## Notes from the exercise authors", "", ...task.comments.map((c) => `- ${c}`));
  }
  lines.push("", "## Functions to implement", "");
  for (const p of task.properties) {
    const args = p.argNames.length > 0 ? p.argNames.join(", ") : "";
    const res = p.returnsResult ? " — some inputs are invalid and must be rejected" : "";
    lines.push(`- \`${p.name}(${args})\`${res}`);
  }
  lines.push(
    "",
    `<!-- generated from ${task.source} exercises/${task.id}` +
      ` (${task.promptFiles.join(", ")}); do not edit -->`,
    "",
  );
  return lines.join("\n");
}

function tally(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs.sort()) out[x] = (out[x] ?? 0) + 1;
  return out;
}

// --- main ------------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(VENDOR_DIR)) {
    console.error(`missing ${VENDOR_DIR}\nrun scripts/fetch-corpus.sh first`);
    process.exit(1);
  }
  const sourceCommit = (await Bun.$`git -C ${VENDOR_DIR} rev-parse HEAD`.text()).trim();

  const exercisesDir = `${VENDOR_DIR}/exercises`;
  const ids = readdirSync(exercisesDir)
    .filter((n) => statSync(`${exercisesDir}/${n}`).isDirectory())
    .sort();

  // corpus/ is fully generated: wipe task directories so an exercise dropped
  // upstream cannot linger as a stale committed task.
  if (existsSync(CORPUS_DIR)) {
    for (const n of readdirSync(CORPUS_DIR)) {
      if (statSync(`${CORPUS_DIR}/${n}`).isDirectory()) {
        rmSync(`${CORPUS_DIR}/${n}`, { recursive: true });
      }
    }
  }
  mkdirSync(CORPUS_DIR, { recursive: true });

  const index: CorpusIndex = {
    schemaVersion: TASK_SCHEMA_VERSION,
    source: UPSTREAM,
    sourceCommit,
    sourceLicense: "MIT",
    generatedBy: "ingest/ingest.ts",
    taskCount: 0,
    caseCount: 0,
    errorCaseCount: 0,
    tasks: [],
    skipped: [],
  };
  const findings: Finding[] = [];
  const layouts: string[] = [];

  for (const id of ids) {
    const dir = `${exercisesDir}/${id}`;
    const cdPath = `${dir}/canonical-data.json`;
    if (!existsSync(cdPath)) {
      index.skipped.push({ id, reason: "no canonical-data.json (no oracle)" });
      continue;
    }
    const root = asObject(parseJson(await Bun.file(cdPath).text()), `${id}/canonical-data.json`);
    const casesNode = root.get("cases");
    if (!casesNode) {
      index.skipped.push({ id, reason: "canonical-data.json has no cases" });
      continue;
    }

    const leaves: Leaf[] = [];
    collectLeaves(casesNode, [], leaves, `${id}.cases`);

    // A case carrying `reimplements: <uuid>` supersedes that uuid; keeping both
    // would assert two different answers for the same scenario.
    const superseded = new Set(leaves.flatMap((l) => (l.reimplements ? [l.reimplements] : [])));
    const kept = leaves.filter((l) => !superseded.has(l.uuid));
    const droppedUuids = leaves.filter((l) => superseded.has(l.uuid)).map((l) => l.uuid);

    const names = uniqueNames(kept);
    const cases: TaskCase[] = kept.map((leaf, i) => ({
      uuid: leaf.uuid,
      name: names[i]!,
      group: leaf.group,
      description: leaf.description,
      property: leaf.property,
      args: leaf.input.map((e) => ({ name: e.key, value: toPortable(e.value) })),
      expected: leaf.expected,
      ...(leaf.scenarios.length > 0 ? { scenarios: leaf.scenarios } : {}),
    }));

    const kinds = new Set<string>();
    for (const leaf of kept) {
      for (const a of leaf.input) valueKinds(a.value, kinds);
      if (leaf.expected.kind === "error") kinds.add("error");
      else valueKinds(fromPortable(leaf.expected.value), kinds);
    }

    const { body, files: promptFiles } = await buildPrompt(dir);
    const meta = await readMetadata(dir);
    layouts.push(promptFiles.join("+") || "(none)");

    const task: Task = {
      schemaVersion: TASK_SCHEMA_VERSION,
      id,
      title: meta.title ?? id,
      blurb: meta.blurb ?? "",
      source: UPSTREAM,
      sourceCommit,
      promptFiles,
      comments: strList(root, "comments"),
      properties: buildProperties(cases),
      cases,
      stats: {
        caseCount: cases.length,
        errorCaseCount: cases.filter((c) => c.expected.kind === "error").length,
        droppedCaseCount: droppedUuids.length,
        valueKinds: [...kinds].sort(),
      },
    };

    mkdirSync(`${CORPUS_DIR}/${id}`, { recursive: true });
    await Bun.write(`${CORPUS_DIR}/${id}/task.json`, JSON.stringify(task, null, 2) + "\n");
    await Bun.write(`${CORPUS_DIR}/${id}/prompt.md`, renderPromptFile(meta.blurb ?? "", body, task));

    findings.push(...findingsFor(task, droppedUuids, names));
    index.tasks.push({
      id,
      title: task.title,
      caseCount: task.stats.caseCount,
      errorCaseCount: task.stats.errorCaseCount,
      properties: task.properties.map((p) => p.name),
      valueKinds: task.stats.valueKinds,
    });
    index.caseCount += task.stats.caseCount;
    index.errorCaseCount += task.stats.errorCaseCount;
  }
  index.taskCount = index.tasks.length;

  await Bun.write(`${CORPUS_DIR}/index.json`, JSON.stringify(index, null, 2) + "\n");
  await Bun.write(
    `${CORPUS_DIR}/ingest-report.json`,
    JSON.stringify(
      {
        sourceCommit,
        promptLayouts: tally(layouts),
        findingCounts: tally(findings.map((f) => f.kind)),
        findings,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(
    [
      `source        ${UPSTREAM} @ ${sourceCommit.slice(0, 12)}`,
      `tasks         ${index.taskCount} (${index.skipped.length} skipped)`,
      `cases         ${index.caseCount} (${index.errorCaseCount} expect an error)`,
      `prompts       ${JSON.stringify(tally(layouts))}`,
      `findings      ${findings.length}`,
      ...Object.entries(tally(findings.map((f) => f.kind))).map(
        ([k, n]) => `  ${k.padEnd(32)}${n}`,
      ),
    ].join("\n"),
  );
}

await main();
