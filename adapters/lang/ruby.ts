/**
 * Ruby language adapter — the second control arm.
 *
 * Emits a stdlib `minitest` suite that `require_relative`s the model's
 * `solution.rb`. The idiom translations are the same two the Python arm makes,
 * and are stated to the model in the contract:
 *
 *  - upstream properties are lowerCamelCase; Ruby solutions expose snake_case,
 *    exactly as Python does, so both arms share `snakeCase`.
 *  - "expects an error" is `raise ArgumentError`, which is what the Exercism Ruby
 *    track requires. Python's equivalent is `ValueError` and Aven's is
 *    `@Err(...)`; the differing class is a language-idiom difference, not a
 *    scoring one — every arm only checks that the failure happened.
 *
 * The solution is a module named `Solution`, so the suite calls
 * `Solution.two_fer(…)`. That mirrors Python's `import solution` /
 * `solution.two_fer(…)` and keeps one fixed name across 142 tasks. The Exercism
 * Ruby track's own convention — a class named after the exercise, `TwoFer`,
 * `ListOps` — was the alternative, and was rejected because it makes the model
 * guess a per-task constant spelling that the Python arm never has to guess, and
 * a wrong guess would be recorded as a language failure rather than a naming one.
 *
 * Floating-point expectations are compared exactly, the same as both other arms.
 * `assert_in_delta` exists and `std/test` has no approximate assertion, so using
 * it here would flatter Ruby.
 */

import { fromRubySafe, rubyString } from "./ruby-values.ts";
import { fromPortable, type Portable } from "../../ingest/json.ts";
import type { Task } from "../../ingest/task.ts";
import {
  orderedArgs,
  propertyOf,
  snakeCase,
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
import { inferTaskShapes, membersOf, mergeShapes, type Shape } from "./shapes.ts";

const RB_TEST_FILE = "solution_test.rb";
const RB_RUNNER = new URL("./rb_runner.rb", import.meta.url).pathname;

/** The module the solution must define, and the receiver every case calls. */
const RB_MODULE = "Solution";

const RB_KEYWORDS = new Set([
  "BEGIN", "END", "alias", "and", "begin", "break", "case", "class", "def",
  "defined?", "do", "else", "elsif", "end", "ensure", "false", "for", "if",
  "in", "module", "next", "nil", "not", "or", "redo", "rescue", "retry",
  "return", "self", "super", "then", "true", "undef", "unless", "until",
  "when", "while", "yield", "__FILE__", "__LINE__", "__ENCODING__",
]);

/**
 * Ruby method name for an upstream property.
 *
 * Ruby is in fact laxer than Python here — `def end` parses, because after `def`
 * and after `.` the lexer accepts keywords as method names — so the trailing
 * underscore is a rendering choice, not a language limit. It is kept anyway: the
 * contract then names something a model will spell the same way without thinking
 * about Ruby's lexer states, and the two snake_case arms stay symmetric.
 */
export function rbName(property: string): string {
  const s = snakeCase(property);
  return RB_KEYWORDS.has(s) ? `${s}_` : s;
}

function methodName(index: number, caseName: string): string {
  const slug = caseName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return `test_${String(index).padStart(3, "0")}_${slug.slice(0, 80) || "case"}`;
}

/** `two-fer` -> `TwoFerTest`. Every corpus id starts with a lowercase letter. */
function testClassName(taskId: string): string {
  return `${taskId.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase())}Test`;
}

/**
 * Ruby rendering of the pseudocode expression language (`pseudocode.ts`).
 *
 * Division is the interesting operator, and the three arms split three ways.
 * Upstream's `/` is float division — the only reading under which
 * `foldl((acc, el) -> el / acc, [1,2,3,4], 24)` gives the expected 64. Python's
 * `/` already is float division, so `PY_EMIT` needs no special case. Ruby's `/`
 * on two Integers *truncates*, so a naive `el / acc` computes `1 / 24 == 0` and
 * then divides by zero, exactly as Aven's does — but unlike Aven, Ruby has
 * `Integer#fdiv`, which is float division under another name, and Ruby's `==`
 * accepts `64.0 == 64`, so the upstream expected value still matches. Aven can
 * do neither: `AVEN_EMIT` throws `Unrenderable` because its `Int / Int` is
 * integer division *and* its static typing rejects comparing a Float accumulator
 * against an Int expectation. Two languages express upstream's semantics, one
 * refuses; that contrast is a finding about Aven and is preserved rather than
 * smoothed over.
 */
export const RB_EMIT: EmitTarget = {
  lambda: (params, body) => `->(${params.join(", ")}) { ${body} }`,
  binary: (op, left, right) => {
    // See the note above: `fdiv` is what makes Ruby agree with upstream.
    if (op === "/") return `(${left}).fdiv(${right})`;
    return `(${left} ${op === "modulo" ? "%" : op} ${right})`;
  },
  builtin: (name, args) => {
    const [x] = args;
    if (name === "upcase") return `(${x}).upcase`;
    if (name === "downcase") return `(${x}).downcase`;
    if (name === "reverse") return `(${x}).reverse`;
    throw new PseudocodeError(`no Ruby rendering for pseudocode builtin '${name}'`);
  },
  solutionCall: (property, args) => `${RB_MODULE}.${rbName(property)}(${args.join(", ")})`,
  int: (v) => v,
  text: (v) => rubyString(v),
  array: (items) => `[${items.join(", ")}]`,
};

/** An argument: pseudocode functions become real lambdas, everything else is data. */
function renderArg(task: Task, value: unknown): string {
  if (typeof value === "string" && isPseudocodeFunction(value)) {
    return renderPseudocode(value, RB_EMIT, new Set(task.properties.map((p) => p.name)));
  }
  return fromRubySafe(fromPortable(value as Portable));
}

function render(task: Task, only?: ReadonlySet<string>): RenderedSuite {
  const omitted: OmittedCase[] = [];
  const body: string[] = [];
  /** `method name -> upstream description`, for the suite's CASE_NAMES table. */
  const names: string[] = [];
  let index = 0;

  for (const c of task.cases) {
    if (only && !only.has(c.uuid)) continue;
    const prop = propertyOf(task, c.property);
    try {
      const args = orderedArgs(prop, c)
        .map((a) => renderArg(task, a.value))
        .join(", ");
      const call = `${RB_MODULE}.${rbName(c.property)}(${args})`;
      const method = methodName(index, c.name);
      names.push(`    ${rubyString(method)} => ${rubyString(c.name.replace(/\s+/g, " "))},`);
      body.push(`  def ${method}`);
      if (c.expected.kind === "error") {
        body.push(`    assert_raises(ArgumentError) { ${call} }`);
      } else {
        const expected = fromRubySafe(fromPortable(c.expected.value));
        // Assertions are always parenthesized. Ruby's own idiom is
        // `assert_equal exp, act`, but a *Hash* first argument then starts with
        // `{`, which the parser reads as a block: `assert_equal {"a" => 1}, x`
        // is a syntax error ("unexpected write target"), and it took out 33 of
        // 142 suites before the parens went in. Nothing about that is per-task,
        // so the parens are unconditional rather than only for Hash values.
        //
        // minitest 5 also deprecates `assert_equal nil, x` in favour of
        // assert_nil: it still passes, but warns on stderr for every such case
        // in every round, so emit the assertion it asks for.
        body.push(expected === "nil" ? `    assert_nil(${call})` : `    assert_equal(${expected}, ${call})`);
      }
      body.push("  end");
      body.push("");
      index++;
    } catch (err) {
      omitted.push({ name: c.name, uuid: c.uuid, reason: (err as Error).message });
    }
  }

  if (body.length === 0) {
    // A suite with no cases is not a suite; one failing case beats a vacuous green.
    body.push("  def test_000_no_renderable_cases", '    flunk("every case was omitted")', "  end", "");
  }

  const contents = [
    `# ${task.title} — generated by aven-bench from ${task.source}. Do not edit.`,
    `# task: ${task.id}   cases: ${index}/${task.cases.length}`,
    "",
    'require "minitest"',
    'require_relative "solution"',
    "",
    `class ${testClassName(task.id)} < Minitest::Test`,
    // Ruby has no docstrings, so the upstream case descriptions live in a table
    // that rb_runner.rb reads back; py_runner.py gets the same thing out of the
    // test method's docstring. Both arms then label cases identically.
    "  CASE_NAMES = {",
    ...names,
    "  }.freeze",
    "",
    ...body,
    "end",
    "",
    "# Running this file directly runs the suite. `rb_runner.rb` loads it instead and",
    "# drives minitest itself, so autorun's at_exit hook must not fire there — hence",
    "# the guard, which is this language's `if __name__ == \"__main__\"`.",
    'require "minitest/autorun" if $PROGRAM_NAME == __FILE__',
    "",
  ].join("\n");

  return { contents, omitted };
}

function rubyShapeDescription(shape: Shape): string {
  switch (shape.kind) {
    case "unknown":
      return "a value whose shape was not observed";
    case "absent":
      return "absent";
    case "null":
      return "`nil`";
    case "bool":
      return "a `true` or `false` value";
    case "int":
      return "an `Integer`";
    case "float":
      return "a `Float`";
    case "text":
      return "a `String`";
    case "callable":
      return shape.arity === null
        ? "a `Proc` or lambda of unknown arity"
        : `a \`Proc\` or lambda accepting ${shape.arity} positional argument${shape.arity === 1 ? "" : "s"}`;
    case "array":
      return `an \`Array\` whose elements are ${rubyShapeDescription(shape.element)}`;
    case "record": {
      if (shape.keys === "withheld") {
        return (
          "a `Hash` with String keys (not enumerated) and values of shape " +
          rubyShapeDescription(shape.value)
        );
      }
      if (shape.fields.length === 0) return "a `Hash` with no observed keys";
      const fields = shape.fields.map((field) => {
        const members = membersOf(field.shape);
        const optional = members.some((member) => member.kind === "absent");
        const value = mergeShapes(members.filter((member) => member.kind !== "absent"));
        return `\`${field.name}\` (${optional ? "optional; " : ""}${rubyShapeDescription(value)})`;
      });
      return `a \`Hash\` with String keys ${fields.join(", ")}`;
    }
    case "union":
      return `either ${shape.members.map(rubyShapeDescription).join(" or ")}`;
  }
}

function contract(task: Task): string {
  const lines = [
    "## Your task",
    "",
    `Write \`solution.rb\` defining a module \`${RB_MODULE}\` with these module methods`,
    `(\`module ${RB_MODULE}\` … \`def self.name(…)\`):`,
    "",
    "The shapes below are observed across this task's cases, not a complete specification.",
    "",
  ];
  for (const observed of inferTaskShapes(task)) {
    const p = observed.property;
    const args = observed.args.map((argument) => snakeCase(argument.name)).join(", ");
    const argumentsDescription =
      observed.args.length === 0
        ? "no arguments"
        : `observed arguments: ${observed.args
            .map(
              (argument) =>
                `\`${snakeCase(argument.name)}\` is ${rubyShapeDescription(argument.shape)}`,
            )
            .join("; ")}`;
    const ending = p.returnsResult
      ? "; raise `ArgumentError` when the input is invalid."
      : ".";
    lines.push(
      `- \`${RB_MODULE}.${rbName(p.name)}(${args})\` — ${argumentsDescription};` +
        ` observed successful return: ${rubyShapeDescription(observed.returns)}${ending}`,
    );
  }
  lines.push("", "Names are snake_case even where the task statement uses lowerCamelCase.");
  lines.push(
    `The suite in \`${RB_TEST_FILE}\` does \`require_relative "solution"\`. Do not edit the suite.`,
  );
  return lines.join("\n");
}

export const rubyAdapter: LangAdapter = {
  id: "ruby",
  displayName: "Ruby 3",
  solutionFile: "solution.rb",
  testFile: RB_TEST_FILE,
  renderTests: render,
  renderContract: contract,
  testCommand: (dir) => ({
    // rb_runner.rb normalizes minitest into the same JSON envelope and the same
    // 0/1/2 exit-code contract as `aven test --format json` and py_runner.py.
    argv: ["ruby", RB_RUNNER, RB_TEST_FILE, dir],
    cwd: dir,
  }),
  // `rb_runner.rb` lives in this repo, which the sandbox does not mount, so a
  // self-verifying model runs the suite directly and reads minitest's own output.
  modelTestCommand: () => `ruby ${RB_TEST_FILE}`,
  classifyExit: (code) => (code === 0 ? "pass" : code === 1 ? "fail" : "load-error"),
};

/** Exported for tests: the value renderer, in isolation. */
export function renderRubyValue(p: Portable): string {
  return fromRubySafe(fromPortable(p));
}
