import { describe, expect, test } from "bun:test";
import { renderAvenValue, avenAdapter } from "./aven.ts";
import { PY_EMIT, pyName, pythonAdapter } from "./python.ts";
import { RB_EMIT, rbName, renderRubyValue, rubyAdapter } from "./ruby.ts";
import { orderedArgs, snakeCase } from "./common.ts";
import { isPseudocodeFunction, renderPseudocode } from "./pseudocode.ts";
import { TASK_SCHEMA_VERSION, type Task, type TaskProperty } from "../../ingest/task.ts";

const prop = (over: Partial<TaskProperty> = {}): TaskProperty => ({
  name: "f",
  argNames: ["a", "b"],
  arity: 2,
  caseCount: 1,
  returnsResult: false,
  argOrderVariants: [["a", "b"]],
  ambiguousArgOrder: false,
  ...over,
});

const task = (over: Partial<Task> = {}): Task => ({
  schemaVersion: TASK_SCHEMA_VERSION,
  id: "demo",
  title: "Demo",
  blurb: "",
  source: "exercism/problem-specifications",
  sourceCommit: "0".repeat(40),
  promptFiles: ["description.md"],
  comments: [],
  properties: [prop()],
  cases: [],
  stats: { caseCount: 0, errorCaseCount: 0, droppedCaseCount: 0, valueKinds: [] },
  ...over,
});

/** A one-argument case whose argument is `value`. */
const caseWithArg = (value: unknown) => ({
  uuid: "u",
  name: "n",
  group: [],
  description: "d",
  property: "f",
  args: [{ name: "a", value }],
  expected: { kind: "value" as const, value: 0 },
});

describe("Aven value rendering", () => {
  test.each([
    [null, "null"],
    [true, "true"],
    [12, "12"],
    [-12, "-12"],
    [{ $n: "1.0" }, "1.0"],
    [{ $n: "3.0" }, "3.0"],
    ["hi", '"hi"'],
    [[1, [2]], "[1, [2]]"],
    [[], "[]"],
    [{}, "{}"],
    [{ a: 1, b: "x" }, '{ a: 1, b: "x" }'],
    [{ "two words": 1 }, '{ "two words": 1 }'],
  ])("renders %j", (input, expected) => {
    expect(renderAvenValue(input)).toBe(expected);
  });

  test("escapes only what Aven supports, and routes the rest through \\u{}", () => {
    // Aven's escapes are \\ \" \n \r \t \u{H}. There is no \$, and `${` opens
    // an interpolation, so `$` must always be escaped numerically.
    expect(renderAvenValue('a"b\\c\nd\te')).toBe('"a\\"b\\\\c\\nd\\te"');
    expect(renderAvenValue("cost $5")).toBe('"cost \\u{24}5"');
    expect(renderAvenValue("bell")).toBe('"bell\\u{7}"');
    expect(renderAvenValue("日本 → ok")).toBe('"日本 → ok"');
  });

  test("refuses integers Aven's 64-bit Int cannot hold", () => {
    expect(renderAvenValue({ $n: "9223372036854775807" })).toBe("9223372036854775807");
    expect(() => renderAvenValue({ $n: "9223372036854775808" })).toThrow(/does not fit/);
    expect(() => renderAvenValue({ $n: "18446744073709551615" })).toThrow(/does not fit/);
  });
});

describe("Aven suite rendering", () => {
  const cases = [
    {
      uuid: "u1",
      name: 'plain "quoted" case',
      group: [],
      description: "d",
      property: "f",
      args: [{ name: "a", value: 1 }, { name: "b", value: "x" }],
      expected: { kind: "value" as const, value: 3 },
    },
    {
      uuid: "u2",
      name: "an error case",
      group: ["group"],
      description: "d",
      property: "f",
      args: [{ name: "a", value: 0 }, { name: "b", value: "" }],
      expected: { kind: "error" as const, message: "nope" },
    },
  ];

  test("wraps value expectations in @Ok when the property can fail", () => {
    const t = task({ properties: [prop({ returnsResult: true })], cases });
    const { contents, omitted } = avenAdapter.renderTests(t);
    expect(omitted).toEqual([]);
    expect(contents).toContain(
      '  "plain \\"quoted\\" case": () => test.expectEq(solution.f(1, "x"), @Ok(3)),',
    );
    expect(contents).toContain('  "an error case": () => test.expectErr(solution.f(0, "")),');
    expect(contents).toContain('test = import("std/test")');
    expect(contents).toContain('solution = import("./solution.av")');
  });

  test("compares bare values when the property cannot fail", () => {
    const t = task({ cases: [cases[0]!] });
    expect(avenAdapter.renderTests(t).contents).toContain(
      '() => test.expectEq(solution.f(1, "x"), 3),',
    );
  });

  test("omits unrenderable cases with a reason, and never emits an empty suite", () => {
    const t = task({
      properties: [prop({ argNames: ["a"], arity: 1 })],
      cases: [
        {
          uuid: "u1",
          name: "too big",
          group: [],
          description: "d",
          property: "f",
          args: [{ name: "a", value: 1 }],
          expected: { kind: "value", value: { $n: "18446744073709551615" } },
        },
      ],
    });
    const { contents, omitted } = avenAdapter.renderTests(t);
    expect(omitted).toEqual([
      { name: "too big", uuid: "u1", reason: expect.stringContaining("does not fit") },
    ]);
    // A vacuous green would be worse than a failure.
    expect(contents).toContain("test.fail(");
  });

  test("`only` restricts to the requested case set", () => {
    const t = task({ properties: [prop({ returnsResult: true })], cases });
    const { contents } = avenAdapter.renderTests(t, new Set(["u2"]));
    expect(contents).not.toContain("expectEq");
    expect(contents).toContain("expectErr");
  });

  test("exit codes follow the aven test contract", () => {
    expect(avenAdapter.classifyExit(0)).toBe("pass");
    expect(avenAdapter.classifyExit(1)).toBe("fail");
    expect(avenAdapter.classifyExit(2)).toBe("load-error");
  });
});

describe("Python adapter", () => {
  test.each([
    ["twoFer", "two_fer"],
    ["abbreviate", "abbreviate"],
    ["treeFromTraversals", "tree_from_traversals"],
    ["toRNA", "to_rna"],
  ])("%s -> %s", (property, expected) => {
    expect(snakeCase(property as string)).toBe(expected as string);
  });

  test("avoids colliding with Python keywords", () => {
    expect(pyName("class")).toBe("class_");
    expect(pyName("hash")).toBe("hash");
  });

  test("renders values Aven cannot, which is the point of the control arm", () => {
    const t = task({
      properties: [prop({ argNames: ["a"], arity: 1 })],
      cases: [
        {
          uuid: "u1",
          name: "big",
          group: [],
          description: "d",
          property: "f",
          args: [{ name: "a", value: 64 }],
          expected: { kind: "value", value: { $n: "18446744073709551615" } },
        },
      ],
    });
    const { contents, omitted } = pythonAdapter.renderTests(t);
    expect(omitted).toEqual([]);
    expect(contents).toContain("self.assertEqual(solution.f(64), 18446744073709551615)");
  });

  test("error expectations become assertRaises(ValueError)", () => {
    const t = task({
      properties: [prop({ argNames: ["a"], arity: 1, returnsResult: true })],
      cases: [
        {
          uuid: "u1",
          name: "bad input",
          group: [],
          description: "d",
          property: "f",
          args: [{ name: "a", value: 0 }],
          expected: { kind: "error", message: "nope" },
        },
      ],
    });
    expect(pythonAdapter.renderTests(t).contents).toContain("with self.assertRaises(ValueError):");
  });
});

describe("Ruby value rendering", () => {
  test.each([
    [null, "nil"],
    [true, "true"],
    [false, "false"],
    [12, "12"],
    [-12, "-12"],
    [{ $n: "1.0" }, "1.0"],
    ["hi", '"hi"'],
    [[1, [2, null]], "[1, [2, nil]]"],
    [[], "[]"],
    [{}, "{}"],
    [{ a: 1, b: "x" }, '{"a" => 1, "b" => "x"}'],
    [{ a: { b: [true, false] } }, '{"a" => {"b" => [true, false]}}'],
    [{ "two words": 1 }, '{"two words" => 1}'],
  ])("renders %j", (input, expected) => {
    expect(renderRubyValue(input)).toBe(expected);
  });

  test("escapes the interpolation sigil, which JSON does not", () => {
    // `#{`, `#$` and `#@` all interpolate in a double-quoted Ruby string, so an
    // unescaped `#` would either interpolate or fail to parse. Everything else
    // JSON escapes is spelled the same way in Ruby.
    expect(renderRubyValue("cost #{5}")).toBe('"cost \\#{5}"');
    expect(renderRubyValue('a"b\\c\nd\te')).toBe('"a\\"b\\\\c\\nd\\te"');
    expect(renderRubyValue("bell")).toBe('"bell\\u0007"');
    expect(renderRubyValue("日本 → ok")).toBe('"日本 → ok"');
  });

  test("renders integers Aven's 64-bit Int cannot hold, like the Python arm", () => {
    expect(renderRubyValue({ $n: "18446744073709551615" })).toBe("18446744073709551615");
  });
});

describe("Ruby adapter", () => {
  const oneArg = (over: Partial<TaskProperty> = {}) => prop({ argNames: ["a"], arity: 1, ...over });

  test("shares the snake_case translation with the Python arm", () => {
    expect(rbName("twoFer")).toBe("two_fer");
    expect(rbName("toRNA")).toBe("to_rna");
  });

  test("avoids colliding with Ruby keywords, which are not Python's", () => {
    expect(rbName("end")).toBe("end_");
    expect(rbName("unless")).toBe("unless_");
    // Each arm guards its own reserved list: `lambda` is a Python keyword and an
    // ordinary Ruby method name, `end` the reverse.
    expect(rbName("lambda")).toBe("lambda");
    expect(pyName("lambda")).toBe("lambda_");
    expect(pyName("end")).toBe("end");
    expect(rbName("hash")).toBe("hash");
  });

  test("emits a minitest suite that requires the solution and calls Solution", () => {
    const t = task({
      id: "two-fer",
      properties: [oneArg({ name: "twoFer" })],
      cases: [{ ...caseWithArg(null), property: "twoFer", expected: { kind: "value", value: "One for you." } }],
    });
    const { contents, omitted } = rubyAdapter.renderTests(t);
    expect(omitted).toEqual([]);
    expect(contents).toContain('require "minitest"');
    expect(contents).toContain('require_relative "solution"');
    expect(contents).toContain("class TwoFerTest < Minitest::Test");
    expect(contents).toContain('assert_equal("One for you.", Solution.two_fer(nil))');
    // Ruby has no docstrings; the table is how rb_runner.rb reports a case under
    // its upstream description.
    expect(contents).toContain('"test_000_n" => "n",');
    // autorun must be conditional, or rb_runner.rb's `load` would run the suite
    // a second time through the at_exit hook.
    expect(contents).toContain('require "minitest/autorun" if $PROGRAM_NAME == __FILE__');
  });

  test("parenthesizes assertions, because a leading `{` argument is a block", () => {
    // `assert_equal {"a" => 1}, x` is a Ruby syntax error: the brace opens a
    // block, not a Hash. Unparenthesized assertions cost 33 of 142 suites.
    const t = task({
      properties: [oneArg()],
      cases: [{ ...caseWithArg("x"), expected: { kind: "value", value: { a: 1 } } }],
    });
    expect(rubyAdapter.renderTests(t).contents).toContain(
      'assert_equal({"a" => 1}, Solution.f("x"))',
    );
  });

  test("uses assert_nil for a null expectation, which minitest demands", () => {
    const t = task({
      properties: [oneArg()],
      cases: [{ ...caseWithArg(1), expected: { kind: "value", value: null } }],
    });
    const { contents } = rubyAdapter.renderTests(t);
    expect(contents).toContain("assert_nil(Solution.f(1))");
    expect(contents).not.toContain("assert_equal(nil");
  });

  test("error expectations become assert_raises(ArgumentError)", () => {
    const t = task({
      properties: [oneArg({ returnsResult: true })],
      cases: [{ ...caseWithArg(0), expected: { kind: "error", message: "nope" } }],
    });
    const { contents } = rubyAdapter.renderTests(t);
    expect(contents).toContain("assert_raises(ArgumentError) { Solution.f(0) }");
    // The three arms raise three different things — ValueError, ArgumentError,
    // @Err — and all three only check that the failure happened.
    expect(rubyAdapter.renderContract(t)).toContain("raise `ArgumentError`");
    expect(pythonAdapter.renderContract(t)).toContain("raise `ValueError`");
  });

  test("the contract names the Hash key spelling only where records occur", () => {
    const withRecords = task({ stats: { caseCount: 0, errorCaseCount: 0, droppedCaseCount: 0, valueKinds: ["record"] } });
    expect(rubyAdapter.renderContract(withRecords)).toContain("String keys");
    // Ruby is the one arm where `{"a" => 1}` and `{a: 1}` are different values,
    // so the note is worth its prompt tokens — but only when it can matter.
    expect(rubyAdapter.renderContract(task())).not.toContain("String keys");
  });

  test("never emits an empty suite", () => {
    const t = task({ properties: [oneArg()], cases: [] });
    expect(rubyAdapter.renderTests(t).contents).toContain("flunk(");
  });

  test("the self-verify command runs the suite without the host-side runner", () => {
    expect(rubyAdapter.modelTestCommand()).toBe("ruby solution_test.rb");
    expect(rubyAdapter.modelTestCommand()).not.toContain("rb_runner");
  });

  test("exit codes follow the shared envelope contract", () => {
    expect(rubyAdapter.classifyExit(0)).toBe("pass");
    expect(rubyAdapter.classifyExit(1)).toBe("fail");
    expect(rubyAdapter.classifyExit(2)).toBe("load-error");
  });
});

describe("orderedArgs", () => {
  test("uses the property's modal key order, not the case's", () => {
    const p = prop();
    const c = {
      uuid: "u",
      name: "n",
      group: [],
      description: "d",
      property: "f",
      args: [{ name: "b", value: 2 }, { name: "a", value: 1 }],
      expected: { kind: "value" as const, value: 0 },
    };
    expect(orderedArgs(p, c).map((a) => a.name)).toEqual(["a", "b"]);
  });

  test("appends keys the property has never seen rather than dropping them", () => {
    const p = prop({ argNames: ["a"], arity: 1 });
    const c = {
      uuid: "u",
      name: "n",
      group: [],
      description: "d",
      property: "f",
      args: [{ name: "a", value: 1 }, { name: "extra", value: 2 }],
      expected: { kind: "value" as const, value: 0 },
    };
    expect(orderedArgs(p, c).map((a) => a.name)).toEqual(["a", "extra"]);
  });
});

// --- pseudocode expression language ----------------------------------------

/**
 * Upstream passes a *function* as text and leaves the conversion to each track's
 * generator. The expected values are all present, so the oracle is fine — only the
 * input needed rendering. Emitting the text verbatim gave suites where every case
 * died on `'str' object is not callable`, which is how all seven free models came
 * to score 0-1/5 on `accumulate`.
 */
describe("pseudocode expressions", () => {
  const props = new Set(["accumulate", "foldl"]);

  test.each([
    ["(x) => x * x", "lambda x: (x * x)"],
    ["(x) -> x + 1", "lambda x: (x + 1)"],
    ["(acc, el) -> el * acc", "lambda acc, el: (el * acc)"],
    ["(x) -> x modulo 2 == 1", "lambda x: ((x % 2) == 1)"],
    ["(x) => upcase(x)", "lambda x: (x).upper()"],
    ["(x) => reverse(x)", "lambda x: (x)[::-1]"],
  ])("python renders %s", (src, want) => {
    expect(renderPseudocode(src, PY_EMIT, props)).toBe(want);
  });

  /** Closes over `x` and calls the solution's own function. The hard one. */
  test("python renders a nested lambda that recurses through the solution", () => {
    expect(renderPseudocode('(x) => accumulate(["1", "2"], (y) => x + y)', PY_EMIT, props)).toBe(
      'lambda x: solution.accumulate(["1", "2"], lambda y: (x + y))',
    );
  });

  test.each([
    ["(x) => x * x", "->(x) { (x * x) }"],
    ["(acc, el) -> el * acc", "->(acc, el) { (el * acc) }"],
    ["(x) -> x modulo 2 == 1", "->(x) { ((x % 2) == 1) }"],
    ["(x) => upcase(x)", "->(x) { (x).upcase }"],
    ["(x) => reverse(x)", "->(x) { (x).reverse }"],
  ])("ruby renders %s", (src, want) => {
    expect(renderPseudocode(src, RB_EMIT, props)).toBe(want);
  });

  test("ruby renders a nested lambda that recurses through the solution", () => {
    expect(renderPseudocode('(x) => accumulate(["1", "2"], (y) => x + y)', RB_EMIT, props)).toBe(
      '->(x) { Solution.accumulate(["1", "2"], ->(y) { (x + y) }) }',
    );
  });

  test("a task's own property wins over a same-named pseudocode builtin", () => {
    // `list-ops` really does have a `reverse` property, so resolving builtins
    // first would silently call text-reversal instead of the solution.
    expect(renderPseudocode("(x) => reverse(x)", PY_EMIT, new Set(["reverse"]))).toBe(
      "lambda x: solution.reverse(x)",
    );
  });

  test.each([
    ["(x) => x $ 2", "unknown operator"],
    ["(x) => nope(x)", "unknown function"],
    ["(x) => 1.5", "non-integer literal"],
    ["(x) => (", "truncated"],
  ])("refuses %s (%s) rather than mis-translating", (src) => {
    expect(() => renderPseudocode(src, PY_EMIT, props)).toThrow();
  });

  test.each([
    ["(x) => x * x", true],
    ["(acc, el) -> el / acc", true],
    ["a -> b", false],
    ["x => x * x", false],
    ["Hello, world", false],
    ["", false],
  ])("isPseudocodeFunction(%s) is %s", (src, want) => {
    expect(isPseudocodeFunction(src)).toBe(want);
  });

  /**
   * The division asymmetry, three ways. Upstream's `/` is float division — the
   * only reading under which `foldl((acc, el) -> el / acc, [1,2,3,4], 24)` yields
   * 64. Python's `/` matches it outright. Ruby's `/` truncates on two Integers,
   * so it goes through `fdiv`, and Ruby's `==` then accepts `64.0 == 64`. Aven can
   * do neither — its `Int / Int` would hit `2 / 0` on the second step, and a Float
   * accumulator would not type-check against the Int expectation — so it refuses
   * the case. That split is a finding about Aven, and this test is what keeps it
   * from being smoothed over.
   */
  test("float division: native in python, via fdiv in ruby, refused in aven", () => {
    const t = task({
      id: "list-ops",
      properties: [prop({ name: "foldl", argNames: ["a"], arity: 1 })],
      cases: [
        { ...caseWithArg("(acc, el) -> el / acc"), property: "foldl" },
        { ...caseWithArg("(acc, el) -> el + acc"), uuid: "v", property: "foldl" },
      ],
    });
    const py = pythonAdapter.renderTests(t);
    const rb = rubyAdapter.renderTests(t);
    const av = avenAdapter.renderTests(t);
    expect(py.omitted).toEqual([]);
    expect(py.contents).toContain("lambda acc, el: (el / acc)");
    expect(rb.omitted).toEqual([]);
    expect(rb.contents).toContain("->(acc, el) { (el).fdiv(acc) }");
    // Not a bare `/`: on two Integers that truncates, computing `1 / 24 == 0` and
    // then dividing by zero, which is exactly Aven's problem.
    expect(rb.contents).not.toContain("(el / acc)");
    expect(av.omitted.map((o) => o.uuid)).toEqual(["u"]);
    expect(av.omitted[0]!.reason).toContain("integer division");
    expect(av.contents).toContain("(acc, el) => (el + acc)");
  });

  test("aven renders the non-division forms", () => {
    const t = task({
      id: "accumulate",
      properties: [prop({ name: "accumulate", argNames: ["a"], arity: 1 })],
      cases: [{ ...caseWithArg("(x) => upcase(x)"), property: "accumulate" }],
    });
    const av = avenAdapter.renderTests(t);
    expect(av.omitted).toEqual([]);
    expect(av.contents).toContain("(x) => (x).toUpper()");
  });
});
