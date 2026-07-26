/**
 * The language-adapter interface plus the helpers every adapter needs.
 *
 * An adapter is deliberately *not* allowed to know about individual tasks.
 * Anything it cannot express is reported as an omitted case with a reason,
 * which is a measurement, not a bug to paper over.
 */

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
   */
  renderTests(task: Task, only?: ReadonlySet<string>): RenderedSuite;

  /** Language-specific half of the prompt: naming, signatures, error style. */
  renderContract(task: Task): string;

  /** Argv to run the suite, given the directory holding solution + test file. */
  testCommand(dir: string): { argv: string[]; cwd: string };

  /** Exit-code contract. `load-error` means the suite never ran. */
  classifyExit(code: number): "pass" | "fail" | "load-error";
};

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

/**
 * Arrow-form pseudocode: `(x) => x * x`, `(acc, el) -> el + acc`.
 *
 * The **parenthesized** parameter list is required, and that is a deliberate bias
 * rather than laziness. Every one of the 15 affected cases in this corpus writes
 * one, while a bare `a -> b` is perfectly good data — graph-edge notation, for
 * instance. The two error directions are not symmetric: a false positive silently
 * deletes a legitimate case and quietly shrinks the oracle, whereas a false
 * negative ships an unsolvable suite that announces itself as every arm failing
 * the same task at once, which is exactly how this class of defect was found.
 * Prefer the loud failure.
 */
const PSEUDOCODE_FUNCTION = /^\s*\(\s*[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s*\)\s*(?:=>|->)\s*\S/;

function pseudocodeStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (PSEUDOCODE_FUNCTION.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) pseudocodeStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) pseudocodeStrings(v, out);
  }
}

/**
 * Why a case's arguments are pseudocode rather than data, or null if they are not.
 *
 * Reports rather than throws so each adapter can raise its own refusal type.
 *
 * Some Exercism canonical data passes a *function* by writing it as a string and
 * leaving conversion to the track's generator: `accumulate` supplies
 * `"(x) => x * x"` and its own description says "it's up to the test generator to
 * turn that string into a function declaration". This generator is deliberately
 * mechanical (§4: task-specific knowledge in an adapter is what makes a corpus
 * unmaintainable), so it cannot do that, and emitting the string verbatim produces
 * a suite that *no* solution can pass — `accumulator(x)` raises
 * `'str' object is not callable`.
 *
 * That is worth catching loudly rather than shipping. All seven free models scored
 * 0–1/5 on `accumulate`, and every one of them correctly blamed the suite in its
 * exit interview. A case that cannot be passed is not a measurement of the model
 * or of the language; omitting it keeps the pass rate honest, which is what
 * `casesOmitted` is for.
 *
 * Affects 9 cases in 2 tasks of 142 (`accumulate` 5/5, `list-ops` 4/22). Turning
 * the pseudocode into real lambdas per language is a possible future upgrade —
 * it needs its own tiny expression language (`modulo`, `upcase`) — and would
 * recover a genuinely interesting higher-order-function task.
 */
export function pseudocodeArgReason(c: TaskCase): string | null {
  const found: string[] = [];
  for (const a of c.args) pseudocodeStrings(a.value, found);
  if (found.length === 0) return null;
  return (
    `argument is pseudocode, not data (${JSON.stringify(found[0])});` +
    " upstream expects the test generator to build a function from it"
  );
}
