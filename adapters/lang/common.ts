/**
 * The language-adapter interface plus the helpers every adapter needs.
 *
 * An adapter is deliberately *not* allowed to know about individual tasks.
 * Anything it cannot express is reported as an omitted case with a reason,
 * which is a measurement, not a bug to paper over.
 */

import type { ResolvedTypeAnn } from "../../ingest/type-annotations.ts";
import type { Task, TaskCase, TaskProperty } from "../../ingest/task.ts";

/** A case the adapter refused to render, with the reason it refused. */
export type OmittedCase = { name: string; uuid: string; reason: string };

export type RenderedSuite = {
  /** Contents of the test file. */
  contents: string;
  /** Cases present upstream but absent from `contents`, and why. */
  omitted: OmittedCase[];
};

export type LangAdapter = {
  readonly id: string;
  readonly displayName: string;
  /** File the model is asked to write. */
  readonly solutionFile: string;
  /** File the generator writes. */
  readonly testFile: string;

  /**
   * Render the suite. `only` restricts to a set of case uuids, which the runner
   * uses to compare arms over an identical case set.
   *
   * `ann` is the shared validated type annotation for this task (or null when
   * none). Aven uses it for map/variant emission; other arms ignore it.
   */
  renderTests(
    task: Task,
    only?: ReadonlySet<string>,
    ann?: ResolvedTypeAnn | null,
  ): RenderedSuite;

  /**
   * Language-specific half of the prompt: naming, signatures, error style.
   * `ann` matches `renderTests` so suite oracles and contract prose stay aligned.
   */
  renderContract(task: Task, ann?: ResolvedTypeAnn | null): string;

  /** Argv to run the suite, given the directory holding solution + test file. */
  testCommand(dir: string): { argv: string[]; cwd: string };

  /**
   * The command a self-verifying model runs *inside the sandbox*, as one line.
   *
   * Not the same command as `testCommand`, and deliberately so: the trusted gate
   * runs on the host and may reach a `cargo run` fallback or the `py_runner.py`
   * wrapper, neither of which exists in the model's mount namespace. This one is
   * built only from binaries and files the sandbox profile actually puts there.
   * Lives on the adapter because the alternative — a language ternary at the one
   * call site — becomes a chain the moment a third arm is added.
   */
  modelTestCommand(): string;

  /** Exit-code contract. `load-error` means the suite never ran. */
  classifyExit(code: number): "pass" | "fail" | "load-error";
};

/**
 * Upstream lowerCamelCase property name -> snake_case.
 *
 * Lives here rather than in one adapter because it is the same translation on
 * every snake_case arm: Python and Ruby both need it, identically, and a second
 * copy is a second thing to keep in step.
 */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

/** Cases of a task belonging to one property, in upstream order. */
export function casesOf(task: Task, property: string): TaskCase[] {
  return task.cases.filter((c) => c.property === property);
}

export function propertyOf(task: Task, name: string): TaskProperty {
  const p = task.properties.find((x) => x.name === name);
  if (!p) throw new Error(`${task.id}: no property ${name}`);
  return p;
}

/**
 * Positional argument order for a case.
 *
 * `input` is a JSON object, so order comes from key insertion order — what
 * every Exercism track relies on, but not something the data guarantees. When a
 * case's key order differs from its property's modal order we reorder to the
 * modal order and append any extra keys, so arity and the common prefix stay
 * stable across a property's cases. `corpus/ingest-report.json` lists every
 * property where this mattered.
 */
export function orderedArgs(prop: TaskProperty, c: TaskCase): TaskCase["args"] {
  const remaining = new Map(c.args.map((a) => [a.name, a]));
  const out: TaskCase["args"] = [];
  for (const name of prop.argNames) {
    const a = remaining.get(name);
    if (a) {
      out.push(a);
      remaining.delete(name);
    }
  }
  for (const a of c.args) if (remaining.has(a.name)) out.push(a);
  return out;
}

