import { describe, expect, test } from "bun:test";
import { fromPortable, type JVal, type Portable } from "./json.ts";
import {
  asTypeAnnFile,
  assertMatches,
  avenSpellableType,
  checkPathOverlaps,
  isSegmentPrefix,
  matches,
  parsePath,
  parseTypeString,
  resolveAnnFile,
  rootForEncoding,
  typeContainsObject,
  TypeAnnError,
  type TypeAnnFile,
  type TypeExpr,
  type VariantEncoding,
} from "./type-annotations.ts";

function j(p: Portable): JVal {
  return fromPortable(p);
}

// ---------------------------------------------------------------------------
// Type-string parser
// ---------------------------------------------------------------------------

describe("parseTypeString — accepted", () => {
  test.each([
    ["Null", { kind: "primitive", of: "null" }],
    ["Bool", { kind: "primitive", of: "bool" }],
    ["Int", { kind: "primitive", of: "int" }],
    ["Float", { kind: "primitive", of: "float" }],
    ["Text", { kind: "primitive", of: "text" }],
    ["Object", { kind: "object" }],
    [
      "Map(Text, Int)",
      { kind: "map", key: "text", value: { kind: "primitive", of: "int" } },
    ],
    [
      "Map(Int, Array(Text))",
      {
        kind: "map",
        key: "int",
        value: { kind: "array", element: { kind: "primitive", of: "text" } },
      },
    ],
    [
      "Map(Text, Null | Object)",
      {
        kind: "map",
        key: "text",
        value: {
          kind: "union",
          members: [{ kind: "primitive", of: "null" }, { kind: "object" }],
        },
      },
    ],
    [
      "?Int",
      { kind: "optional", inner: { kind: "primitive", of: "int" } },
    ],
    [
      "@Open",
      { kind: "variant", alts: [{ tag: "Open", payload: null }] },
    ],
    [
      "@Deposit(Int)",
      {
        kind: "variant",
        alts: [{ tag: "Deposit", payload: { kind: "primitive", of: "int" } }],
      },
    ],
    [
      "@Open | @Deposit(Int)",
      {
        kind: "variant",
        alts: [
          { tag: "Open", payload: null },
          { tag: "Deposit", payload: { kind: "primitive", of: "int" } },
        ],
      },
    ],
    [
      "@Tree(Object) | @Int(Int)",
      {
        kind: "variant",
        alts: [
          { tag: "Tree", payload: { kind: "object" } },
          { tag: "Int", payload: { kind: "primitive", of: "int" } },
        ],
      },
    ],
  ] as const)("%s", (src, expected) => {
    expect(parseTypeString(src)).toEqual(expected as TypeExpr);
  });

  test("allows whitespace", () => {
    expect(parseTypeString(" Map ( Text , Int ) ")).toEqual({
      kind: "map",
      key: "text",
      value: { kind: "primitive", of: "int" },
    });
  });

  test("parenthesized grouping", () => {
    expect(parseTypeString("(Null | Object)")).toEqual({
      kind: "union",
      members: [{ kind: "primitive", of: "null" }, { kind: "object" }],
    });
  });
});

describe("avenSpellableType / typeContainsObject", () => {
  test("spellable types round-trip; object-bearing types are null", () => {
    expect(avenSpellableType(parseTypeString("Map(Text, Int)"))).toBe("Map(Text, Int)");
    expect(avenSpellableType(parseTypeString("@Open | @Deposit(Int)"))).toBe(
      "@Open | @Deposit(Int)",
    );
    expect(avenSpellableType(parseTypeString("?Map(Text, Int)"))).toBe("?Map(Text, Int)");
    expect(avenSpellableType(parseTypeString("Object"))).toBeNull();
    expect(avenSpellableType(parseTypeString("?Object"))).toBeNull();
    expect(avenSpellableType(parseTypeString("Map(Text, ?Object)"))).toBeNull();
    expect(avenSpellableType(parseTypeString("@Concurrent(Object)"))).toBeNull();
    expect(typeContainsObject(parseTypeString("Int"))).toBe(false);
    expect(typeContainsObject(parseTypeString("@Bag(Object)"))).toBe(true);
  });
});

describe("parseTypeString — rejected", () => {
  test.each([
    ["string", "unsupported"], // lowercase / wrong name
    ["Dict(Text, Int)", "unsupported"],
    ["Map(Bool, Int)", "Map key"],
    ["Map(Text)", "expected"],
    ["@open", "variant tag"], // lowercase tag
    ["@Tag(Int, Text)", "tuple"],
    ["@Tag({ name: Text })", "unsupported"],
    ["Result(Int, Text)", "unsupported"],
    ["@{@A, @B}", "unsupported"],
    ["", "expected type"],
  ])("%j mentions %s", (src, needle) => {
    expect(() => parseTypeString(src)).toThrow(TypeAnnError);
    try {
      parseTypeString(src);
    } catch (e) {
      expect((e as Error).message.toLowerCase()).toContain(needle.toLowerCase());
      // Valid-but-unsupported Aven should not claim "invalid type"
      if (src.startsWith("@") || src.startsWith("Result") || src.startsWith("@{")) {
        expect((e as Error).message).toContain("unsupported in corpus annotations");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe("parsePath", () => {
  test.each([
    ["countWords.expected", ["countWords", "expected"]],
    ["transform.arg.legacy", ["transform", "arg", "legacy"]],
    [
      "post.expected.users[].owes",
      ["post", "expected", "users", "[]", "owes"],
    ],
    [
      "bankAccount.arg.operations[]",
      ["bankAccount", "arg", "operations", "[]"],
    ],
    ['post.expected."weird.key"', ["post", "expected", "weird.key"]],
  ])("%s", (src, segs) => {
    expect(parsePath(src)).toEqual(segs);
  });

  test.each([
    "post.expected.users[].owes.*",
    "arg.legacy",
    "foo.bar",
    "countWords",
    "",
  ])("rejects %j", (src) => {
    expect(() => parsePath(src)).toThrow(TypeAnnError);
  });
});

describe("segment-prefix overlap", () => {
  test("users vs users[].owes is a prefix (reject)", () => {
    const a = parsePath("post.expected.users");
    const b = parsePath("post.expected.users[].owes");
    expect(isSegmentPrefix(a, b)).toBe(true);
    expect(() =>
      checkPathOverlaps([
        { at: "post.expected.users", segments: a },
        { at: "post.expected.users[].owes", segments: b },
      ]),
    ).toThrow(/overlap/);
  });

  test("owes vs owed_by allowed", () => {
    const a = parsePath("post.expected.users[].owes");
    const b = parsePath("post.expected.users[].owed_by");
    expect(isSegmentPrefix(a, b)).toBe(false);
    expect(isSegmentPrefix(b, a)).toBe(false);
    checkPathOverlaps([
      { at: "post.expected.users[].owes", segments: a },
      { at: "post.expected.users[].owed_by", segments: b },
    ]);
  });

  test("user vs users is not a segment prefix (allow)", () => {
    const a = parsePath("post.expected.user");
    const b = parsePath("post.expected.users");
    expect(isSegmentPrefix(a, b)).toBe(false);
    checkPathOverlaps([
      { at: "post.expected.user", segments: a },
      { at: "post.expected.users", segments: b },
    ]);
  });

  test("equal paths rejected", () => {
    const a = parsePath("countWords.expected");
    expect(() =>
      checkPathOverlaps([
        { at: "countWords.expected", segments: a },
        { at: "countWords.expected", segments: a },
      ]),
    ).toThrow(/overlap/);
  });
});

// ---------------------------------------------------------------------------
// matches matrix
// ---------------------------------------------------------------------------

describe("matches matrix", () => {
  const nullT = parseTypeString("Null");
  const boolT = parseTypeString("Bool");
  const intT = parseTypeString("Int");
  const floatT = parseTypeString("Float");
  const textT = parseTypeString("Text");
  const arrInt = parseTypeString("Array(Int)");
  const mapTI = parseTypeString("Map(Text, Int)");
  const mapII = parseTypeString("Map(Int, Array(Text))");
  const objT = parseTypeString("Object");
  const unionNO = parseTypeString("Null | Object");
  const optInt = parseTypeString("?Int");

  test("primitives", () => {
    expect(matches(nullT, j(null))).toBe(true);
    expect(matches(nullT, j(true))).toBe(false);
    expect(matches(boolT, j(true))).toBe(true);
    expect(matches(boolT, j(1))).toBe(false);
    expect(matches(intT, j(3))).toBe(true);
    expect(matches(intT, j({ $n: "3.0" }))).toBe(false);
    expect(matches(floatT, j(3))).toBe(true);
    expect(matches(floatT, j({ $n: "3.0" }))).toBe(true);
    expect(matches(floatT, j("x"))).toBe(false);
    expect(matches(textT, j("hi"))).toBe(true);
    expect(matches(textT, j(1))).toBe(false);
  });

  test("array", () => {
    expect(matches(arrInt, j([1, 2]))).toBe(true);
    expect(matches(arrInt, j([]))).toBe(true);
    expect(matches(arrInt, j([1, "x"]))).toBe(false);
    expect(matches(arrInt, j({}))).toBe(false);
  });

  test("map text keys", () => {
    expect(matches(mapTI, j({ word: 1, a: 2 }))).toBe(true);
    expect(matches(mapTI, j({}))).toBe(true);
    expect(matches(mapTI, j({ word: "x" }))).toBe(false);
    expect(matches(mapTI, j([1]))).toBe(false);
  });

  test("map int keys", () => {
    expect(matches(mapII, j({ $o: [["1", ["A"]], ["2", ["B", "C"]]] }))).toBe(true);
    expect(matches(mapII, j({ a: ["A"] }))).toBe(false);
  });

  test("object opaque", () => {
    expect(matches(objT, j({ start: 1 }))).toBe(true);
    expect(matches(objT, j({}))).toBe(true);
    expect(matches(objT, j(null))).toBe(false);
  });

  test("union and optional", () => {
    expect(matches(unionNO, j(null))).toBe(true);
    expect(matches(unionNO, j({ a: 1 }))).toBe(true);
    expect(matches(unionNO, j(1))).toBe(false);
    expect(matches(optInt, j(null))).toBe(true);
    expect(matches(optInt, j(3))).toBe(true);
    expect(matches(optInt, j("x"))).toBe(false);
  });

  test("map value union Null | Object (word-search style)", () => {
    const t = parseTypeString("Map(Text, Null | Object)");
    expect(
      matches(
        t,
        j({
          clojure: { start: { column: 1, row: 1 }, end: { column: 7, row: 1 } },
          missing: null,
        }),
      ),
    ).toBe(true);
    expect(matches(t, j({ bad: 1 }))).toBe(false);
  });

  test("nested nullability: Map(Text, ?Int) vs Map(Text, Int)", () => {
    const optVals = parseTypeString("Map(Text, ?Int)");
    const bareVals = parseTypeString("Map(Text, Int)");
    const withNullEntry = j({ a: 1, b: null });
    expect(matches(optVals, withNullEntry)).toBe(true);
    expect(matches(bareVals, withNullEntry)).toBe(false);
    expect(matches(optVals, j({ a: 1 }))).toBe(true);
    expect(matches(bareVals, j({ a: 1 }))).toBe(true);
  });

  test("top-level optional map: ?Map(Text, Int) accepts null whole value", () => {
    const t = parseTypeString("?Map(Text, Int)");
    expect(matches(t, j(null))).toBe(true);
    expect(matches(t, j({ a: 1 }))).toBe(true);
    expect(matches(t, j({ a: "x" }))).toBe(false);
    // Bare Map does not accept whole-value null.
    expect(matches(parseTypeString("Map(Text, Int)"), j(null))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertMatches diagnostics
// ---------------------------------------------------------------------------

describe("assertMatches messages", () => {
  test("map key kind names the key", () => {
    const t = parseTypeString("Map(Int, Int)");
    expect(() => assertMatches(t, j({ word: 1 }), { ctx: "hit" })).toThrow(
      /key "word" is not an integer/,
    );
  });

  test("map value mismatch names the key and types", () => {
    const t = parseTypeString("Map(Text, Int)");
    expect(() => assertMatches(t, j({ word: "x" }), { ctx: "hit" })).toThrow(
      /value at key "word".*expected Int, got Text/,
    );
  });

  test("array element names the index", () => {
    const t = parseTypeString("Array(Int)");
    expect(() => assertMatches(t, j([1, "x"]), { ctx: "hit" })).toThrow(
      /element\[1\].*expected Int, got Text/,
    );
  });

  test("union lists members tried", () => {
    const t = parseTypeString("Null | Object");
    expect(() => assertMatches(t, j(1), { ctx: "hit" })).toThrow(
      /no union member matched among Null, Object/,
    );
  });

  test("optional at position accepts null; bare type rejects", () => {
    assertMatches(parseTypeString("?Int"), j(null), { ctx: "hit" });
    expect(() =>
      assertMatches(parseTypeString("Int"), j(null), { ctx: "hit" }),
    ).toThrow(/expected Int, got Null/);
  });
});

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

describe("variant matches + encoding", () => {
  const type = parseTypeString("@Open | @Deposit(Int) | @Concurrent(Object)");
  const encoding: VariantEncoding = {
    kind: "tagField",
    field: "operation",
    tags: {
      open: { ctor: "Open", payload: { from: "none" } },
      deposit: { ctor: "Deposit", payload: { from: "field", name: "amount" } },
      concurrent: { ctor: "Concurrent", payload: { from: "rest" } },
    },
  };

  test("nullary open", () => {
    expect(matches(type, j({ operation: "open" }), { encoding })).toBe(true);
  });

  test("deposit with amount", () => {
    expect(
      matches(type, j({ operation: "deposit", amount: 100 }), { encoding }),
    ).toBe(true);
  });

  test("concurrent rest payload", () => {
    expect(
      matches(
        type,
        j({ operation: "concurrent", number: 2, operations: [] }),
        { encoding },
      ),
    ).toBe(true);
  });

  test("unknown tag fails assertMatches loudly", () => {
    expect(() =>
      assertMatches(type, j({ operation: "explode" }), {
        encoding,
        ctx: "test",
      }),
    ).toThrow(/unknown tag/);
  });

  test("extra field on nullary fails", () => {
    expect(matches(type, j({ operation: "open", x: 1 }), { encoding })).toBe(
      false,
    );
  });

  test("missing amount on deposit fails", () => {
    expect(matches(type, j({ operation: "deposit" }), { encoding })).toBe(false);
  });

  test("exclusiveKey years/months/days", () => {
    const t = parseTypeString("@Years(Object) | @Months(Object) | @Days(Object)");
    const enc: VariantEncoding = {
      kind: "exclusiveKey",
      keys: {
        years: { ctor: "Years", payload: { from: "value" } },
        months: { ctor: "Months", payload: { from: "value" } },
        days: { ctor: "Days", payload: { from: "value" } },
      },
    };
    expect(matches(t, j({ years: { leapYear: false } }), { encoding: enc })).toBe(
      true,
    );
    expect(matches(t, j({ months: { random: true } }), { encoding: enc })).toBe(
      true,
    );
    expect(matches(t, j({ years: { leapYear: false }, months: {} }), { encoding: enc })).toBe(
      false,
    );
    expect(() =>
      assertMatches(t, j({ weeks: {} }), { encoding: enc, ctx: "x" }),
    ).toThrow(/unknown exclusive key/);
  });

  test("zipper-style type field", () => {
    const t = parseTypeString("@Tree(Object) | @Int(Int) | @Zipper(Object)");
    const enc: VariantEncoding = {
      kind: "tagField",
      field: "type",
      tags: {
        tree: { ctor: "Tree", payload: { from: "field", name: "value" } },
        int: { ctor: "Int", payload: { from: "field", name: "value" } },
        zipper: { ctor: "Zipper", payload: { from: "rest" } },
      },
    };
    expect(
      matches(
        t,
        j({ type: "tree", value: { value: 1, left: null, right: null } }),
        { encoding: enc },
      ),
    ).toBe(true);
    expect(matches(t, j({ type: "int", value: 3 }), { encoding: enc })).toBe(true);
    expect(
      matches(
        t,
        j({ type: "zipper", initialTree: {}, operations: [] }),
        { encoding: enc },
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveAnnFile structural rules
// ---------------------------------------------------------------------------

describe("resolveAnnFile", () => {
  test("map position without encoding", () => {
    const file: TypeAnnFile = {
      schemaVersion: 1,
      task: "word-count",
      positions: [{ at: "countWords.expected", type: "Map(Text, Int)" }],
    };
    const r = resolveAnnFile(file, "test.json");
    expect(r.positions[0]!.type.kind).toBe("map");
    expect(r.positions[0]!.encoding).toBeUndefined();
  });

  test("variant without encoding fails", () => {
    const file: TypeAnnFile = {
      schemaVersion: 1,
      task: "bank-account",
      positions: [{ at: "bankAccount.arg.operations[]", type: "@Open" }],
    };
    expect(() => resolveAnnFile(file, "test.json")).toThrow(/requires encoding/);
  });

  test("encoding on map fails", () => {
    const file: TypeAnnFile = {
      schemaVersion: 1,
      task: "word-count",
      positions: [
        {
          at: "countWords.expected",
          type: "Map(Text, Int)",
          encoding: {
            kind: "tagField",
            field: "type",
            tags: { x: { ctor: "X", payload: { from: "none" } } },
          },
        },
      ],
    };
    expect(() => resolveAnnFile(file, "test.json")).toThrow(
      /encoding is only valid/,
    );
  });

  test("ctor set mismatch fails", () => {
    const file: TypeAnnFile = {
      schemaVersion: 1,
      task: "bank-account",
      positions: [
        {
          at: "bankAccount.arg.operations[]",
          type: "@Open | @Close",
          encoding: {
            kind: "tagField",
            field: "operation",
            tags: {
              open: { ctor: "Open", payload: { from: "none" } },
              // missing Close; extra Deposit
              deposit: { ctor: "Deposit", payload: { from: "field", name: "amount" } },
            },
          },
        },
      ],
    };
    expect(() => resolveAnnFile(file, "test.json")).toThrow(TypeAnnError);
  });

  test("nested variant in map value rejected", () => {
    const file: TypeAnnFile = {
      schemaVersion: 1,
      task: "x",
      positions: [
        {
          at: "p.expected",
          type: "Map(Text, @A | @B)",
        },
      ],
    };
    expect(() => resolveAnnFile(file, "test.json")).toThrow(/variants may only appear/);
  });

  test("a field the schema does not define is rejected, not ignored", () => {
    const withUnknown = (field: string) => () =>
      asTypeAnnFile(
        {
          schemaVersion: 1,
          task: "alphametics",
          positions: [
            { at: "solve.expected", type: "Map(Text, Int)", [field]: true },
          ],
        },
        "test.json",
      );
    // A typo and an invented field are the same defect: the annotation would
    // not say what its author meant, and silence would hide it.
    expect(withUnknown("typeo")).toThrow(/unknown field "typeo"/);
    expect(withUnknown("nullOk")).toThrow(/unknown field "nullOk"/);
  });

  test("optional variant root is accepted with encoding", () => {
    // Parentheses required: `?@Open | @Deposit(Int)` is optional@Open | @Deposit,
    // not optional of a collapsed variant.
    const file: TypeAnnFile = {
      schemaVersion: 1,
      task: "bank-account",
      positions: [
        {
          at: "bankAccount.arg.operations[]",
          type: "?(@Open | @Deposit(Int))",
          encoding: {
            kind: "tagField",
            field: "operation",
            tags: {
              open: { ctor: "Open", payload: { from: "none" } },
              deposit: { ctor: "Deposit", payload: { from: "field", name: "amount" } },
            },
          },
        },
      ],
    };
    const r = resolveAnnFile(file, "test.json");
    expect(r.positions[0]!.type.kind).toBe("optional");
    expect(rootForEncoding(r.positions[0]!.type).kind).toBe("variant");
  });
});
