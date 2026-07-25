import { describe, expect, test } from "bun:test";
import {
  fitsI64,
  fromPortable,
  isIntegerLiteral,
  parseJson,
  toPortable,
  valueKinds,
  type JVal,
} from "./json.ts";

/** Round-trip source -> JVal -> portable -> JVal, which is what the corpus does. */
function roundTrip(src: string): JVal {
  return fromPortable(toPortable(parseJson(src)));
}

describe("parseJson", () => {
  test.each([
    ['"a\\"b\\\\c\\n"', { kind: "string", value: 'a"b\\c\n' }],
    ['"\\u0041\\u00e9"', { kind: "string", value: "Aé" }],
    ["true", { kind: "bool", value: true }],
    ["null", { kind: "null" }],
    ["-12", { kind: "number", raw: "-12" }],
    ["1.0", { kind: "number", raw: "1.0" }],
    ["1e3", { kind: "number", raw: "1e3" }],
    ["[]", { kind: "array", items: [] }],
    ["{}", { kind: "object", entries: [] }],
  ])("parses %s", (src, expected) => {
    expect(parseJson(src as string)).toEqual(expected as JVal);
  });

  test("preserves number text a double would destroy", () => {
    // The whole reason for a hand-rolled reader: `1.0` is an Aven Float and `1`
    // is an Aven Int, and grains' answer does not fit a double at all.
    expect(parseJson("1.0")).toEqual({ kind: "number", raw: "1.0" });
    expect(parseJson("18446744073709551615")).toEqual({
      kind: "number",
      raw: "18446744073709551615",
    });
  });

  test("preserves key insertion order, including integer-like keys", () => {
    // JSON.parse would hoist "1" ahead of "b". Argument order depends on this.
    const v = parseJson('{"b": 1, "1": 2, "a": 3}');
    expect(v.kind).toBe("object");
    expect((v as Extract<JVal, { kind: "object" }>).entries.map((e) => e.key)).toEqual([
      "b",
      "1",
      "a",
    ]);
  });

  test.each(["", "{", "[1,]", '{"a" 1}', "1 2", "tru"])("rejects %p", (src) => {
    expect(() => parseJson(src)).toThrow();
  });
});

describe("portable encoding", () => {
  test("is lossless for values a double would mangle", () => {
    for (const src of ["1.0", "18446744073709551615", "1e3", "-0.5", "0"]) {
      expect(roundTrip(src)).toEqual(parseJson(src));
    }
  });

  test("keeps integer-like keys in order via the $o form", () => {
    const src = '{"b": 1, "1": 2}';
    expect(toPortable(parseJson(src))).toEqual({ $o: [["b", 1], ["1", 2]] });
    expect(roundTrip(src)).toEqual(parseJson(src));
  });

  test("uses plain JSON when plain JSON is lossless", () => {
    expect(toPortable(parseJson('{"name": "Alice", "n": [1, 2]}'))).toEqual({
      name: "Alice",
      n: [1, 2],
    });
  });
});

describe("number classification", () => {
  test.each([
    ["1", true, true],
    ["-9223372036854775808", true, true],
    ["9223372036854775808", true, false],
    ["18446744073709551615", true, false],
    ["1.0", false, false],
    ["1e3", false, false],
  ])("%s -> integer=%p fitsI64=%p", (raw, integer, fits) => {
    expect(isIntegerLiteral(raw as string)).toBe(integer as boolean);
    expect(fitsI64(raw as string)).toBe(fits as boolean);
  });
});

describe("valueKinds", () => {
  test("names the structures a language adapter has to express", () => {
    expect([...valueKinds(parseJson('[[1], {"a": 1.5}, null, "x", true]'))].sort()).toEqual(
      ["array", "array-of-record", "bool", "float", "int", "nested-array", "null", "record", "string"],
    );
    expect([...valueKinds(parseJson("18446744073709551615"))]).toEqual(["bigint"]);
  });
});
