/**
 * JSON -> Python literal. Python can express everything the canonical data
 * contains (arbitrary-precision ints, floats, None, dicts, nested lists), so
 * unlike the Aven renderer this never refuses a value. That asymmetry is the
 * point of having a control arm.
 */

import { isIntegerLiteral, type JVal } from "../../ingest/json.ts";

/** JSON string escapes are a subset of Python's, so JSON.stringify is safe. */
function pyText(s: string): string {
  return JSON.stringify(s);
}

export function fromPythonSafe(v: JVal): string {
  switch (v.kind) {
    case "null":
      return "None";
    case "bool":
      return v.value ? "True" : "False";
    case "number":
      // Python ints are arbitrary precision; float text carries through as-is.
      return isIntegerLiteral(v.raw) ? v.raw : v.raw;
    case "string":
      return pyText(v.value);
    case "array":
      return `[${v.items.map(fromPythonSafe).join(", ")}]`;
    case "object":
      if (v.entries.length === 0) return "{}";
      return `{${v.entries.map((e) => `${pyText(e.key)}: ${fromPythonSafe(e.value)}`).join(", ")}}`;
  }
}
