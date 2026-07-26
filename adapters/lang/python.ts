/**
 * Python language adapter — the control arm.
 *
 * Emits a stdlib `unittest` suite importing `solution`. Two idiom translations
 * are deliberate and are stated to the model in the contract:
 *
 *  - upstream properties are lowerCamelCase; Python solutions expose snake_case.
 *  - "expects an error" is `raise ValueError(...)`, which is what the Exercism
 *    Python track requires. Aven's equivalent is `@Err(...)`; that asymmetry is
 *    a language-idiom difference, not a scoring difference — both arms only
 *    check that the failure happened.
 *
 * Floating-point expectations are compared exactly, the same as Aven, so the
 * two arms stay comparable. `std/test` has no approximate assertion, so adding
 * a tolerance on the Python side only would flatter Python.
 */

import { fromPythonSafe } from "./python-values.ts";
import { fromPortable } from "../../ingest/json.ts";
import type { Task } from "../../ingest/task.ts";
import {
  orderedArgs,
  propertyOf,
  type LangAdapter,
  type OmittedCase,
  type RenderedSuite,
} from "./common.ts";
import {
  PseudocodeError,
  isPseudocodeFunction,
  renderPseudocode,
  type EmitTarget,
} from "./pseudocode.ts";

const PY_TEST_FILE = "solution_test.py";
const PY_RUNNER = new URL("./py_runner.py", import.meta.url).pathname;

export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

const PY_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "False", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass",
  "raise", "return", "True", "try", "while", "with", "yield",
]);

/** Python function name for an upstream property. */
export function pyName(property: string): string {
  const s = snakeCase(property);
  return PY_KEYWORDS.has(s) ? `${s}_` : s;
}

function methodName(index: number, caseName: string): string {
  const slug = caseName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return `test_${String(index).padStart(3, "0")}_${slug.slice(0, 80) || "case"}`;
}

/**
 * Python rendering of the pseudocode expression language (`pseudocode.ts`).
 *
 * Python needs no special handling for `/`: upstream's `/` is float division and
 * so is Python's, which is what makes `foldl((acc, el) -> el / acc, [1,2,3,4], 24)`
 * come out at 64. The expected value is the integer `64` and Python computes
 * `64.0`, which `assertEqual` accepts.
 */
export const PY_EMIT: EmitTarget = {
  lambda: (params, body) => `lambda ${params.join(", ")}: ${body}`,
  binary: (op, left, right) => {
    const sym = op === "modulo" ? "%" : op;
    return `(${left} ${sym} ${right})`;
  },
  builtin: (name, args) => {
    const [x] = args;
    if (name === "upcase") return `(${x}).upper()`;
    if (name === "downcase") return `(${x}).lower()`;
    if (name === "reverse") return `(${x})[::-1]`;
    throw new PseudocodeError(`no Python rendering for pseudocode builtin '${name}'`);
  },
  solutionCall: (property, args) => `solution.${pyName(property)}(${args.join(", ")})`,
  int: (v) => v,
  text: (v) => JSON.stringify(v),
  array: (items) => `[${items.join(", ")}]`,
};

/** An argument: pseudocode functions become real lambdas, everything else is data. */
function renderArg(task: Task, value: unknown): string {
  if (typeof value === "string" && isPseudocodeFunction(value)) {
    return renderPseudocode(value, PY_EMIT, new Set(task.properties.map((p) => p.name)));
  }
  return fromPythonSafe(fromPortable(value as Parameters<typeof fromPortable>[0]));
}

function render(task: Task, only?: ReadonlySet<string>): RenderedSuite {
  const omitted: OmittedCase[] = [];
  const body: string[] = [];
  let index = 0;

  for (const c of task.cases) {
    if (only && !only.has(c.uuid)) continue;
    const prop = propertyOf(task, c.property);
    try {
      const args = orderedArgs(prop, c)
        .map((a) => renderArg(task, a.value))
        .join(", ");
      const call = `solution.${pyName(c.property)}(${args})`;
      body.push(`    def ${methodName(index, c.name)}(self):`);
      // A docstring, not a comment: py_runner.py reports it as the case name,
      // so both arms label cases with the upstream description.
      body.push(`        ${JSON.stringify(c.name.replace(/\s+/g, " "))}`);
      if (c.expected.kind === "error") {
        body.push(`        with self.assertRaises(ValueError):`);
        body.push(`            ${call}`);
      } else {
        const expected = fromPythonSafe(fromPortable(c.expected.value));
        body.push(`        self.assertEqual(${call}, ${expected})`);
      }
      body.push("");
      index++;
    } catch (err) {
      omitted.push({ name: c.name, uuid: c.uuid, reason: (err as Error).message });
    }
  }

  if (body.length === 0) {
    body.push(
      "    def test_000_no_renderable_cases(self):",
      '        self.fail("every case was omitted")',
      "",
    );
  }

  const contents = [
    `# ${task.title} — generated by aven-bench from ${task.source}. Do not edit.`,
    `# task: ${task.id}   cases: ${index}/${task.cases.length}`,
    "",
    "import unittest",
    "",
    "import solution",
    "",
    "",
    `class ${task.id.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase())}Test(unittest.TestCase):`,
    ...body,
    "",
    'if __name__ == "__main__":',
    "    unittest.main()",
    "",
  ].join("\n");

  return { contents, omitted };
}

function contract(task: Task): string {
  const lines = [
    "## Your task",
    "",
    "Write `solution.py` defining these module-level functions:",
    "",
  ];
  for (const p of task.properties) {
    const args = p.argNames.map(snakeCase).join(", ");
    if (p.returnsResult) {
      lines.push(
        `- \`${pyName(p.name)}(${args})\` — raise \`ValueError\` when the input is invalid.`,
      );
    } else {
      lines.push(`- \`${pyName(p.name)}(${args})\``);
    }
  }
  lines.push(
    "",
    "Names are snake_case even where the task statement uses lowerCamelCase.",
    `The suite in \`${PY_TEST_FILE}\` does \`import solution\`. Do not edit the suite.`,
  );
  return lines.join("\n");
}

export const pythonAdapter: LangAdapter = {
  id: "python",
  displayName: "Python 3",
  solutionFile: "solution.py",
  testFile: PY_TEST_FILE,
  renderTests: render,
  renderContract: contract,
  testCommand: (dir) => ({
    // py_runner.py normalizes unittest into the same JSON envelope and the same
    // 0/1/2 exit-code contract as `aven test --format json`.
    argv: ["python3", PY_RUNNER, "solution_test", dir],
    cwd: dir,
  }),
  classifyExit: (code) => (code === 0 ? "pass" : code === 1 ? "fail" : "load-error"),
};
