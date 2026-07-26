/**
 * JSON -> Ruby literal, the sibling of `python-values.ts`.
 *
 * Ruby can express everything the canonical data contains (arbitrary-precision
 * Integers, Floats, nil, Hashes, nested Arrays), so like the Python renderer and
 * unlike the Aven one this never refuses a value. Three places where Ruby's
 * spelling genuinely differs from Python's:
 *
 *  - `nil` / `true` / `false`, not `None` / `True` / `False`.
 *  - Hashes are `{"key" => value}`. The shorter `{key: value}` form makes a
 *    *Symbol* key, and `{"a" => 1} == {a: 1}` is false, so the two are not
 *    interchangeable the way they look. Canonical data has string keys, so
 *    string keys are the faithful reading — and because Ruby forces a choice
 *    Python does not, the adapter states it in the contract rather than leaving
 *    the model to guess which one the suite compares against.
 *  - Double-quoted strings interpolate, so `#` needs escaping. `JSON.stringify`
 *    does not escape it, which is why this file has its own escaper instead of
 *    borrowing Python's one-liner. (`aven.ts` has the same problem with `$`.)
 *
 * Everything else JSON escapes — `\" \\ \n \r \t \uXXXX` — is spelled the same
 * way in Ruby, so only the interpolation sigil needs special handling.
 */

import type { JVal } from "../../ingest/json.ts";

/** A Ruby double-quoted string literal. Also used for suite text the adapter emits. */
export function rubyString(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    // `#{`, `#$` and `#@` all begin an interpolation. Every `#` is escaped
    // unconditionally rather than by lookahead: `\#` is just `#` in any Ruby
    // string, so the unconditional form cannot be wrong, while a lookahead has
    // to keep knowing all three sigils. Single-quoted strings would dodge
    // interpolation entirely but have no `\n`, which the corpus needs.
    else if (ch === "#") out += "\\#";
    else {
      const cp = ch.codePointAt(0)!;
      out += cp < 0x20 || cp === 0x7f ? `\\u${cp.toString(16).padStart(4, "0")}` : ch;
    }
  }
  return out + '"';
}

export function fromRubySafe(v: JVal): string {
  switch (v.kind) {
    case "null":
      return "nil";
    case "bool":
      return v.value ? "true" : "false";
    case "string":
      return rubyString(v.value);
    case "number":
      // Upstream's literal text is already a Ruby literal, whichever kind it is:
      // Integers are arbitrary precision, so no case is too large (`grains`'
      // 2**64 - 1 needs that), and float text — including exponent form, which
      // Ruby reads as a Float — carries through unchanged. Aven is the arm that
      // has to inspect the text, and it is the arm that refuses values.
      return v.raw;
    case "array":
      return `[${v.items.map(fromRubySafe).join(", ")}]`;
    case "object":
      if (v.entries.length === 0) return "{}";
      return `{${v.entries.map((e) => `${rubyString(e.key)} => ${fromRubySafe(e.value)}`).join(", ")}}`;
  }
}
