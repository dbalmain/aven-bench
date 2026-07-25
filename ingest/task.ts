/**
 * The normalized task schema. This is the contract between the ingest
 * (which writes `corpus/<id>/task.json`) and everything downstream —
 * language adapters, the runner, analysis.
 */

import type { Portable } from "./json.ts";
import { fromPortable, type JVal } from "./json.ts";

export const TASK_SCHEMA_VERSION = 1 as const;

export type Expected =
  | { kind: "value"; value: Portable }
  | { kind: "error"; message: string };

export type TaskCase = {
  uuid: string;
  /** Unique within the task; group path + leaf description. Used as a test name. */
  name: string;
  /** Enclosing group descriptions, outermost first. */
  group: string[];
  /** The leaf case description, verbatim from upstream. */
  description: string;
  /** The function under test. */
  property: string;
  /**
   * Positional arguments, in `input` key insertion order. See
   * `ingest-report.json` for tasks where that order is questionable.
   */
  args: { name: string; value: Portable }[];
  expected: Expected;
  /** Upstream scenario tags (`big-integer`, `floating-point`, `unicode`, …). */
  scenarios?: string[];
};

export type TaskProperty = {
  name: string;
  /** Argument names in the order used by the majority of this property's cases. */
  argNames: string[];
  arity: number;
  caseCount: number;
  /** True when at least one case expects an error: this property returns a Result. */
  returnsResult: boolean;
  /** Every distinct argument-name tuple seen, in first-observed order. */
  argOrderVariants: string[][];
  /** More than one distinct tuple: positional order cannot be trusted. */
  ambiguousArgOrder: boolean;
};

export type Task = {
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  id: string;
  title: string;
  blurb: string;
  source: string;
  sourceCommit: string;
  /** Which upstream markdown files the prompt was built from. */
  promptFiles: string[];
  /** Upstream `comments`, kept because they sometimes carry the real contract. */
  comments: string[];
  properties: TaskProperty[];
  cases: TaskCase[];
  stats: {
    caseCount: number;
    errorCaseCount: number;
    /** Superseded by a `reimplements` case and therefore dropped. */
    droppedCaseCount: number;
    valueKinds: string[];
  };
};

export type CorpusIndex = {
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  source: string;
  sourceCommit: string;
  sourceLicense: string;
  generatedBy: string;
  taskCount: number;
  caseCount: number;
  errorCaseCount: number;
  tasks: {
    id: string;
    title: string;
    caseCount: number;
    errorCaseCount: number;
    properties: string[];
    valueKinds: string[];
  }[];
  /** Upstream exercises with no `canonical-data.json` — no oracle, so no task. */
  skipped: { id: string; reason: string }[];
};

export type Split = {
  frozenAt: string;
  rule: string;
  tune: string[];
  holdout: string[];
};

// --- loading ---------------------------------------------------------------

export function decodeCaseArgs(c: TaskCase): { name: string; value: JVal }[] {
  return c.args.map((a) => ({ name: a.name, value: fromPortable(a.value) }));
}

export function decodeExpected(
  c: TaskCase,
): { kind: "value"; value: JVal } | { kind: "error"; message: string } {
  return c.expected.kind === "error"
    ? c.expected
    : { kind: "value", value: fromPortable(c.expected.value) };
}

export async function loadIndex(corpusDir: string): Promise<CorpusIndex> {
  return (await Bun.file(`${corpusDir}/index.json`).json()) as CorpusIndex;
}

export async function loadTask(corpusDir: string, id: string): Promise<Task> {
  return (await Bun.file(`${corpusDir}/${id}/task.json`).json()) as Task;
}

export async function loadAllTasks(corpusDir: string): Promise<Task[]> {
  const index = await loadIndex(corpusDir);
  return Promise.all(index.tasks.map((t) => loadTask(corpusDir, t.id)));
}
