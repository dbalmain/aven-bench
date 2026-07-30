import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { extractFixtures } from "../../ingest/extract-fixtures.ts";
import { checkAvenExports, renderAvenValue, avenAdapter } from "./aven.ts";
import { PY_EMIT, pyName, pythonAdapter } from "./python.ts";
import { RB_EMIT, rbName, renderRubyValue, rubyAdapter } from "./ruby.ts";
import { orderedArgs, snakeCase } from "./common.ts";
import { isPseudocodeFunction, renderPseudocode } from "./pseudocode.ts";
import { inferPropertyShapes } from "./shapes.ts";
import { fromPortable, isIntegerLiteral, toPortable, type JVal } from "../../ingest/json.ts";
import { CORPUS_DIR } from "../../ingest/paths.ts";
import {
  loadAllTasks,
  loadTask,
  TASK_SCHEMA_VERSION,
  type Expected,
  type Task,
  type TaskProperty,
} from "../../ingest/task.ts";
import {
  resolveAnnFile,
  type TypeAnnFile,
  type TypePosition,
} from "../../ingest/type-annotations.ts";

/** Synthetic resolved annotations for emission/contract fixture tests. */
function annFor(taskId: string, positions: TypePosition[]) {
  const file: TypeAnnFile = { schemaVersion: 1, task: taskId, positions };
  return resolveAnnFile(file, "fixture.json");
}

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

function changedValue(value: JVal): JVal {
  switch (value.kind) {
    case "null":
      return value;
    case "bool":
      return { kind: "bool", value: !value.value };
    case "number":
      return {
        kind: "number",
        raw: isIntegerLiteral(value.raw) ? "314159" : "2718.5",
      };
    case "string":
      return { kind: "string", value: "changed expected literal" };
    case "array":
      return { kind: "array", items: value.items.map(changedValue) };
    case "object":
      return {
        kind: "object",
        entries: value.entries.map((entry, index) => ({
          key: `changed_expected_key_${index}`,
          value: changedValue(entry.value),
        })),
      };
  }
}

function changeExpected(expected: Expected): Expected {
  return expected.kind === "error"
    ? { kind: "error", message: "changed error literal" }
    : { kind: "value", value: toPortable(changedValue(fromPortable(expected.value))) };
}

describe("observed contract shapes", () => {
  test("joins array elements and record keys, marking keys absent in some records", () => {
    const property = prop({
      argNames: ["operations"],
      arity: 1,
      returnsResult: true,
    });
    const t = task({
      properties: [property],
      cases: [
        {
          ...caseWithArg([{ kind: "credit", amount: 10 }]),
          uuid: "one",
          expected: { kind: "value", value: 10 },
        },
        {
          ...caseWithArg([{ kind: "balance" }]),
          uuid: "two",
          expected: { kind: "error", message: "invalid" },
        },
        {
          ...caseWithArg([]),
          uuid: "three",
          expected: { kind: "value", value: 0 },
        },
      ],
    });

    expect(inferPropertyShapes(t, property)).toEqual({
      property,
      args: [
        {
          name: "operations",
          shape: {
            kind: "array",
            element: {
              kind: "record",
              keys: "known",
              fields: [
                {
                  name: "amount",
                  shape: {
                    kind: "union",
                    members: [{ kind: "absent" }, { kind: "int" }],
                  },
                },
                { name: "kind", shape: { kind: "text" } },
              ],
            },
          },
        },
      ],
      // The error case describes only the failure path.
      returns: { kind: "int" },
    });
  });

  test("keeps primitive disagreements as a value-free union", () => {
    const property = prop({ argNames: ["value"], arity: 1 });
    const values = [null, true, 1, { $n: "1.5" }, "a private literal"];
    const t = task({
      properties: [property],
      cases: values.map((value, index) => ({
        ...caseWithArg(value),
        uuid: String(index),
      })),
    });
    expect(inferPropertyShapes(t, property).args[0]!.shape).toEqual({
      kind: "union",
      members: [
        { kind: "null" },
        { kind: "bool" },
        { kind: "int" },
        { kind: "float" },
        { kind: "text" },
      ],
    });
  });

  test("describes pseudocode inputs as callables, never as their encoded text", () => {
    const property = prop({ argNames: ["function"], arity: 1 });
    const t = task({
      properties: [property],
      cases: [caseWithArg("(left, right) -> left + right")],
    });
    expect(inferPropertyShapes(t, property).args[0]!.shape).toEqual({
      kind: "callable",
      arity: 2,
    });
  });

  test("does not turn small observed input string sets into literal unions", () => {
    const property = prop({ argNames: ["mode"], arity: 1 });
    const literals = ["private-alpha", "private-beta", "private-gamma"];
    const t = task({
      properties: [property],
      cases: literals.map((value, index) => ({
        ...caseWithArg(value),
        uuid: String(index),
      })),
    });
    expect(inferPropertyShapes(t, property).args[0]!.shape).toEqual({ kind: "text" });
    for (const adapter of [pythonAdapter, rubyAdapter, avenAdapter]) {
      const contract = adapter.renderContract(t);
      for (const literal of literals) expect(contract).not.toContain(literal);
    }
  });

  test("every corpus contract is invariant under value and key changes to expected values", async () => {
    // This exercises successful scalars, arrays, records and error messages over
    // real tasks. Return-record keys are deliberately withheld because dynamic
    // keys are values in tasks such as word-count. Equality is stronger than
    // checking a hand-picked literal: any value-dependent rendering changes the
    // whole contract and fails the test.
    for (const original of await loadAllTasks(CORPUS_DIR)) {
      const changed: Task = {
        ...original,
        cases: original.cases.map((testCase) => ({
          ...testCase,
          expected: changeExpected(testCase.expected),
        })),
      };
      for (const adapter of [pythonAdapter, rubyAdapter, avenAdapter]) {
        expect(adapter.renderContract(changed)).toBe(adapter.renderContract(original));
      }
    }
  });

  test("renders equivalent bank-account record keys and list-ops callable arities", async () => {
    const bank = await loadTask(CORPUS_DIR, "bank-account");
    const pyBank = pythonAdapter.renderContract(bank);
    const rbBank = rubyAdapter.renderContract(bank);
    const avBank = avenAdapter.renderContract(bank);
    expect(pyBank).toContain("operations: list[dict[str, object]]) -> int");
    expect(rbBank).toContain("`amount` (optional; an `Integer`)");
    expect(avBank).toContain(
      "Array({ amount: ?Int, number: ?Int, operation: Text," +
        " operations: ?Array({ amount: Int, operation: Text }) }) -> Result(Int, Text)",
    );
    for (const contract of [pyBank, rbBank, avBank]) {
      for (const key of ["amount", "number", "operation", "operations"]) {
        expect(contract).toContain(key);
      }
      for (const literal of ["deposit", "withdraw", "concurrent"]) {
        expect(contract).not.toContain(literal);
      }
    }

    const listOps = await loadTask(CORPUS_DIR, "list-ops");
    const pyList = pythonAdapter.renderContract(listOps);
    const rbList = rubyAdapter.renderContract(listOps);
    const avList = avenAdapter.renderContract(listOps);
    expect(pyList).toContain("function: Callable[[object, object], object]");
    expect(rbList).toContain("lambda accepting 2 positional arguments");
    expect(avList).toContain("function accepting 2 positional arguments");
  });

  test("withholds dynamic record keys from both inputs and expected records", async () => {
    const cases = [
      { id: "relative-distance", concreteKeys: ["Aditi", "Xiomara"] },
      { id: "word-count", concreteKeys: ["javascript", "whitespaces"] },
      { id: "word-search", concreteKeys: ["clojure", "ecmascript"] },
    ];
    for (const { id, concreteKeys } of cases) {
      const corpusTask = await loadTask(CORPUS_DIR, id);
      for (const adapter of [pythonAdapter, rubyAdapter, avenAdapter]) {
        const contract = adapter.renderContract(corpusTask);
        expect(contract).toContain("not enumerated");
        for (const key of concreteKeys) expect(contract).not.toContain(key);
      }
    }
  });
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

  test("renders integers of any width, since Aven's Int is arbitrary precision", () => {
    // aven-lang `bde5492` made `Int` arbitrary precision, converging the
    // implementation on what the spec had said all along. The adapter used to
    // refuse anything outside i64 and that refusal was the sole cause of 4 of
    // Aven's 6 corpus omissions.
    expect(renderAvenValue({ $n: "9223372036854775807" })).toBe("9223372036854775807");
    expect(renderAvenValue({ $n: "9223372036854775808" })).toBe("9223372036854775808");
    expect(renderAvenValue({ $n: "18446744073709551615" })).toBe("18446744073709551615");
    expect(renderAvenValue({ $n: "115132219018763992565095597973971522401" })).toBe(
      "115132219018763992565095597973971522401",
    );
  });
});

describe("Aven annotated emission (maps / variants)", () => {
  const expectedPath = ["f", "expected"] as const;

  test("empty map-annotated object → Map([]); unannotated empty object → {}", () => {
    const ann = annFor("demo", [{ at: "f.expected", type: "Map(Text, Int)" }]);
    expect(renderAvenValue({}, ann, expectedPath)).toBe("Map([])");
    expect(renderAvenValue({})).toBe("{}");
  });

  test("text-key map always quotes keys (never bare IDENT — K13)", () => {
    const ann = annFor("demo", [{ at: "f.expected", type: "Map(Text, Int)" }]);
    const rendered = renderAvenValue({ word: 1, the: 2 }, ann, expectedPath);
    expect(rendered).toBe('Map([("word", 1), ("the", 2)])');
    // Bare `word` would be name.unbound in Aven.
    expect(rendered).not.toMatch(/\(\s*word\s*,/);
    expect(rendered).not.toContain("(word,");
  });

  test("int-key map (etl $o style) emits integer key literals", () => {
    const ann = annFor("demo", [{ at: "f.expected", type: "Map(Int, Array(Text))" }]);
    // After fromPortable, $o is an ordinary object with string keys "1", …
    const rendered = renderAvenValue(
      { $o: [["1", ["A"]], ["2", ["B", "C"]]] },
      ann,
      expectedPath,
    );
    expect(rendered).toBe('Map([(1, ["A"]), (2, ["B", "C"])])');
  });

  test("?T whole-value null → null", () => {
    const ann = annFor("demo", [{ at: "f.expected", type: "?Map(Text, Int)" }]);
    expect(renderAvenValue(null, ann, expectedPath)).toBe("null");
    expect(renderAvenValue({ a: 1 }, ann, expectedPath)).toBe('Map([("a", 1)])');
  });

  test("Map(Text, ?Object) admits null and object entry values", () => {
    const ann = annFor("demo", [{ at: "f.expected", type: "Map(Text, ?Object)" }]);
    const rendered = renderAvenValue(
      { found: { start: 1, end: 2 }, missing: null },
      ann,
      expectedPath,
    );
    expect(rendered).toBe('Map([("found", { start: 1, end: 2 }), ("missing", null)])');
  });

  test("Float over integer raw forces float spelling (K15)", () => {
    const ann = annFor("demo", [{ at: "f.expected", type: "Float" }]);
    expect(renderAvenValue(3, ann, expectedPath)).toBe("3.0");
    expect(renderAvenValue({ $n: "3" }, ann, expectedPath)).toBe("3.0");
    // Unannotated integer stays Int.
    expect(renderAvenValue(3)).toBe("3");
  });

  test("nested annotated field under unannotated parent record", () => {
    // rest-api style: parent is a record; only owes is a map.
    const ann = annFor("demo", [
      { at: "f.expected.users[].owes", type: "Map(Text, Float)" },
    ]);
    const value = {
      users: [
        { name: "Adam", owes: { Bob: 3 }, balance: 0 },
      ],
    };
    const rendered = renderAvenValue(value, ann, expectedPath);
    expect(rendered).toContain('owes: Map([("Bob", 3.0)])');
    expect(rendered).toContain("name: \"Adam\"");
    // Parent stays a record, not Map.
    expect(rendered.startsWith("{")).toBe(true);
    expect(rendered).not.toMatch(/^Map\(/);
  });

  test("tagField variant emission including payload-free tag", () => {
    const ann = annFor("demo", [
      {
        at: "f.arg.operations[]",
        type: "@Open | @Deposit(Int)",
        encoding: {
          kind: "tagField",
          field: "operation",
          tags: {
            open: { ctor: "Open", payload: { from: "none" } },
            deposit: { ctor: "Deposit", payload: { from: "field", name: "amount" } },
          },
        },
      },
    ]);
    const t = task({
      properties: [prop({ name: "f", argNames: ["operations"], arity: 1 })],
      cases: [
        {
          uuid: "u1",
          name: "ops",
          group: [],
          description: "d",
          property: "f",
          args: [
            {
              name: "operations",
              value: [
                { operation: "open" },
                { operation: "deposit", amount: 10 },
              ],
            },
          ],
          expected: { kind: "value" as const, value: 0 },
        },
      ],
    });
    const { contents, omitted } = avenAdapter.renderTests(t, undefined, ann);
    expect(omitted).toEqual([]);
    expect(contents).toContain("solution.f([@Open, @Deposit(10)])");
  });

  test("exclusiveKey variant emission", () => {
    const ann = annFor("demo", [
      {
        at: "f.expected",
        type: "@Years(Object) | @Months(Object)",
        encoding: {
          kind: "exclusiveKey",
          keys: {
            years: { ctor: "Years", payload: { from: "value" } },
            months: { ctor: "Months", payload: { from: "value" } },
          },
        },
      },
    ]);
    expect(renderAvenValue({ years: { a: 1 } }, ann, expectedPath)).toBe("@Years({ a: 1 })");
    expect(renderAvenValue({ months: {} }, ann, expectedPath)).toBe("@Months({})");
  });

  test("contract bullet contains the Aven type for an annotated position", () => {
    const ann = annFor("demo", [{ at: "f.expected", type: "Map(Text, Int)" }]);
    const t = task({
      properties: [prop({ argNames: ["sentence"], arity: 1, name: "f" })],
      cases: [
        {
          uuid: "u1",
          name: "n",
          group: [],
          description: "d",
          property: "f",
          args: [{ name: "sentence", value: "word" }],
          expected: { kind: "value" as const, value: { word: 1 } },
        },
      ],
    });
    const contract = avenAdapter.renderContract(t, ann);
    expect(contract).toContain("Map(Text, Int)");
    // Without annotation the return is withheld-record prose.
    const bare = avenAdapter.renderContract(t);
    expect(bare).toContain("keys not enumerated");
    expect(bare).not.toContain("Map(Text, Int)");
  });

  test("union of withheld returns emits each annotated note once (rest-api post)", () => {
    // Two success shapes merge into a union of withheld-key records. Nested
    // annotations at that path must appear once per bullet, not once per member.
    const ann = annFor("demo", [
      { at: "f.expected.users[].owes", type: "Map(Text, Float)" },
      { at: "f.expected.owes", type: "Map(Text, Float)" },
    ]);
    const t = task({
      properties: [prop({ argNames: ["x"], arity: 1, name: "f" })],
      cases: [
        {
          uuid: "u1",
          name: "users",
          group: [],
          description: "d",
          property: "f",
          args: [{ name: "x", value: 1 }],
          expected: {
            kind: "value" as const,
            value: { users: [{ owes: { Bob: 3.0 } }] },
          },
        },
        {
          uuid: "u2",
          name: "direct",
          group: [],
          description: "d",
          property: "f",
          args: [{ name: "x", value: 2 }],
          expected: {
            kind: "value" as const,
            value: { owes: { Alice: 1.5 } },
          },
        },
      ],
    });
    const contract = avenAdapter.renderContract(t, ann);
    const noteUsers = "`expected.users[].owes` is `Map(Text, Float)`";
    const noteOwes = "`expected.owes` is `Map(Text, Float)`";
    expect(contract.split(noteUsers).length - 1).toBe(1);
    expect(contract.split(noteOwes).length - 1).toBe(1);
  });

  test("two annotated positions sharing a type string both appear", () => {
    const ann = annFor("demo", [
      { at: "f.expected.owes", type: "Map(Text, Float)" },
      { at: "f.expected.owed_by", type: "Map(Text, Float)" },
    ]);
    const t = task({
      properties: [prop({ argNames: ["x"], arity: 1, name: "f" })],
      cases: [
        {
          uuid: "u1",
          name: "n",
          group: [],
          description: "d",
          property: "f",
          args: [{ name: "x", value: 1 }],
          expected: {
            kind: "value" as const,
            value: { owes: { A: 1.0 }, owed_by: { B: 2.0 } },
          },
        },
      ],
    });
    const contract = avenAdapter.renderContract(t, ann);
    expect(contract).toContain("`expected.owes` is `Map(Text, Float)`");
    expect(contract).toContain("`expected.owed_by` is `Map(Text, Float)`");
  });

  test("unannotated task contract is free of residual type notes", () => {
    const t = task({
      properties: [prop({ argNames: ["x"], arity: 1, name: "f" })],
      cases: [
        {
          uuid: "u1",
          name: "n",
          group: [],
          description: "d",
          property: "f",
          args: [{ name: "x", value: 1 }],
          expected: {
            kind: "value" as const,
            value: { owes: { A: 1.0 }, owed_by: { B: 2.0 } },
          },
        },
      ],
    });
    const contract = avenAdapter.renderContract(t);
    expect(contract).toContain("keys not enumerated");
    expect(contract).not.toMatch(/`[^`]+` is `Map\(/);
    expect(contract).toBe(avenAdapter.renderContract(t, null));
  });

  test("suite expected values use Map when annotated", () => {
    const ann = annFor("demo", [{ at: "f.expected", type: "Map(Text, Int)" }]);
    const t = task({
      properties: [prop({ argNames: ["sentence"], arity: 1, name: "f" })],
      cases: [
        {
          uuid: "u1",
          name: "counts",
          group: [],
          description: "d",
          property: "f",
          args: [{ name: "sentence", value: "word" }],
          expected: { kind: "value" as const, value: { word: 1 } },
        },
      ],
    });
    const { contents } = avenAdapter.renderTests(t, undefined, ann);
    expect(contents).toContain('Map([("word", 1)])');
    expect(contents).not.toContain("word: 1");
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
          name: "exponent float",
          group: [],
          description: "d",
          property: "f",
          args: [{ name: "a", value: 1 }],
          // Was an out-of-i64 integer until `Int` became arbitrary precision and
          // stopped being unrenderable. The mechanism under test is the omission
          // path itself, so it needs a value the adapter still genuinely refuses.
          expected: { kind: "value", value: { $n: "1.0e22" } },
        },
      ],
    });
    const { contents, omitted } = avenAdapter.renderTests(t);
    expect(omitted).toEqual([
      { name: "exponent float", uuid: "u1", reason: expect.stringContaining("exponent-form") },
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

/**
 * The export-surface check is what turns a forgotten `{ f, g }` into a repair
 * diagnostic that names the problem. Without it the suite dies with an opaque
 * missing-field cascade and the model burns rounds on the wrong symptom.
 */
describe("Aven export-surface check", () => {
  test("a module with no trailing export record is rejected with a concrete fix", () => {
    const source = [
      "twoFer = (name) =>",
      '  name ?> null => "One for you, one for me.", person => "One for ${person}, one for me."',
      "",
    ].join("\n");
    const result = checkAvenExports(source, ["twoFer"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("no-export-record");
    expect(result.missing).toEqual(["twoFer"]);
    expect(result.exported).toEqual([]);
    // Repair prompt quotes this message; it must name both the problem and the shape.
    expect(result.message).toContain("exports nothing");
    expect(result.message).toContain("trailing export record");
    expect(result.message).toContain("{ twoFer }");
  });

  test("the scan is syntactic, which is why the gate runs it only after `check` passes", () => {
    // Both of these report "no export record" — the truncated one demonstrably
    // *has* one. That is not a bug in the scan (it cannot parse broken source)
    // but it is why `runGate` gates this probe behind a passing `aven check`:
    // on unparseable input the compiler's diagnostic is the true one, and this
    // message would point the model away from its actual defect.
    const truncated = checkAvenExports("double = (x) => x * 2\n\n{ double\n", ["double"]);
    expect(truncated.ok).toBe(false);
    if (truncated.ok) return;
    expect(truncated.kind).toBe("no-export-record");

    const unparseable = checkAvenExports("double = (x => x *\n", ["double"]);
    expect(unparseable.ok).toBe(false);
  });

  test("a record missing a required name lists the gap and what was exported", () => {
    const source = "square = (n) => n\ntotal = () => 0\n\n{ square }\n";
    const result = checkAvenExports(source, ["square", "total"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("missing-names");
    expect(result.missing).toEqual(["total"]);
    expect(result.exported).toEqual(["square"]);
    expect(result.message).toContain("missing export(s): total");
    expect(result.message).toContain("Exported: square");
  });

  test("shorthand and explicit fields both count, multi-line included", () => {
    expect(checkAvenExports("f = 1\ng = 2\n{ f, g }\n", ["f", "g"])).toEqual({
      ok: true,
      exported: ["f", "g"],
    });
    expect(
      checkAvenExports("f = 1\ng = 2\n{\n  f: f,\n  g,\n}\n", ["f", "g"]),
    ).toEqual({ ok: true, exported: ["f", "g"] });
  });

  test("a record used only as an argument is not an export record", () => {
    // Final expression is a call; the inner `{ a }` must not be mistaken for the
    // module value, or a solution that never exported would look complete.
    const result = checkAvenExports('f = (r) => r\nf({ a: 1 })\n', ["a"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("no-export-record");
  });

  test("line comments do not hide a trailing export record", () => {
    expect(checkAvenExports("f = 1\n{ f } # re-export\n", ["f"]).ok).toBe(true);
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
    const withRecords = task({
      properties: [oneArg()],
      cases: [caseWithArg({ key: 1 })],
      stats: { caseCount: 1, errorCaseCount: 0, droppedCaseCount: 0, valueKinds: ["record"] },
    });
    expect(rubyAdapter.renderContract(withRecords)).toContain("String keys");
    // Ruby is the one arm where `{"a" => 1}` and `{a: 1}` are different values,
    // so the key spelling belongs in the observed shape — but only when it occurs.
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

// --- data fixtures ---------------------------------------------------------

describe("fixture extraction", () => {
  test("grep's three files come out of the prompt matching every expected value", async () => {
    // The strongest available check: the canonical data's expected results are
    // exact lines from these files, so if extraction is off by a character —
    // trailing padding kept, a row dropped — some expected line stops matching.
    const prompt = await Bun.file(join(CORPUS_DIR, "grep", "prompt.md")).text();
    const fixtures = extractFixtures(prompt);
    expect(fixtures.map((f) => f.name).sort()).toEqual([
      "iliad.txt",
      "midsummer-night.txt",
      "paradise-lost.txt",
    ]);

    const lines = new Set(fixtures.flatMap((f) => f.contents.split("\n")));
    const task = JSON.parse(await Bun.file(join(CORPUS_DIR, "grep", "task.json")).text()) as Task;
    let checked = 0;
    for (const testCase of task.cases) {
      if (testCase.expected.kind !== "value") continue;
      for (const raw of testCase.expected.value as unknown[]) {
        // `-l` yields bare file names; `-n` and multi-file runs prefix the line.
        const text = String(raw);
        if (fixtures.some((f) => f.name === text)) continue;
        const bare = /^(?:[A-Za-z0-9._-]+\.txt:)?(?:\d+:)?(.*)$/.exec(text)?.[1] ?? text;
        if (bare === "") continue;
        expect(lines).toContain(bare);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  test("a table that is an illustration rather than a fixture yields nothing", () => {
    expect(extractFixtures("Some prose.\n\n  ------\n  |a|\n  ------\n")).toEqual([]);
  });
});
