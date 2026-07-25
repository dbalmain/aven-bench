import { describe, expect, test } from "bun:test";
import { renderAvenValue, avenAdapter } from "./aven.ts";
import { pyName, pythonAdapter, snakeCase } from "./python.ts";
import { orderedArgs } from "./common.ts";
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
