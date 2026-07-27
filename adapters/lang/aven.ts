/**
 * Aven language adapter.
 *
 * A suite is a module whose value is a record of zero-arg thunks returning
 * `Result` — there is no `test` keyword:
 *
 *   test = import("std/test")
 *   solution = import("./solution.av")
 *
 *   {
 *     "no name given": () => test.expectEq(solution.twoFer("you"), "One for …"),
 *   }
 *
 * Every case is rendered as a single line. That is not only for readability:
 * Aven rejects a trailing comma after a *multi-line* field value, so keeping
 * each field on one line keeps the emitter free of layout special cases in a
 * layout-sensitive language.
 */

import { fromPortable, isIntegerLiteral, type JVal, type Portable } from "../../ingest/json.ts";
import type { Task } from "../../ingest/task.ts";
import {
  orderedArgs,
  propertyOf,
  type LangAdapter,
  type OmittedCase,
  type RenderedSuite,
} from "./common.ts";
import { isPseudocodeFunction, renderPseudocode, type EmitTarget } from "./pseudocode.ts";
import { AVEN_LANG_DIR } from "../../ingest/paths.ts";
import { inferTaskShapes, membersOf, mergeShapes, type Shape } from "./shapes.ts";

const AVEN_TEST_FILE = "solution_test.av";

/** Thrown when a value has no Aven spelling; caught per case and reported. */
class Unrenderable extends Error {}

/** Supported escapes are `\\ \" \n \r \t \u{H}` — everything else goes via \u{}. */
function avenText(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    // `${` opens an interpolation and there is no `\$` escape.
    else if (ch === "$") out += "\\u{24}";
    else if (cp < 0x20 || cp === 0x7f) out += `\\u{${cp.toString(16)}}`;
    else out += ch;
  }
  return out + '"';
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function avenNumber(raw: string): string {
  // Any integer literal renders. Aven's `Int` became arbitrary precision on
  // 2026-07-27 (aven-lang `bde5492`), which is what the spec had always said it
  // was; until then this refused values outside i64 and that refusal was four of
  // the six cases Aven omitted corpus-wide, across `grains` and
  // `armstrong-numbers`. Verified against the binary, not just the commit:
  // `115132219018763992565095597973971522401` evaluates and round-trips.
  if (isIntegerLiteral(raw)) return raw;
  // Floats: keep the upstream text, but make sure it reads as a Float literal.
  if (/[eE]/.test(raw)) {
    // No exponent-form floats exist in the corpus today; refuse rather than
    // guess at a spelling nothing has exercised.
    throw new Unrenderable(`exponent-form float literal ${raw} is not emitted`);
  }
  return /\./.test(raw) ? raw : `${raw}.0`;
}

function avenValue(v: JVal): string {
  switch (v.kind) {
    case "null":
      return "null";
    case "bool":
      return v.value ? "true" : "false";
    case "number":
      return avenNumber(v.raw);
    case "string":
      return avenText(v.value);
    case "array":
      return `[${v.items.map(avenValue).join(", ")}]`;
    case "object": {
      if (v.entries.length === 0) return "{}";
      const fields = v.entries.map((e) => {
        const key = IDENT.test(e.key) ? e.key : avenText(e.key);
        return `${key}: ${avenValue(e.value)}`;
      });
      return `{ ${fields.join(", ")} }`;
    }
  }
}

/**
 * Aven rendering of the pseudocode expression language (`pseudocode.ts`).
 *
 * One operator cannot be rendered. Upstream's `/` is float division — that is the
 * only reading under which `foldl((acc, el) -> el / acc, [1,2,3,4], 24)` gives the
 * expected 64 — while Aven's `Int / Int` is integer division, measured: `1 / 24`
 * evaluates to `0` and `2 / 0` is `runtime.division-by-zero`. So the same
 * expression over the same Int inputs computes a different function and then dies.
 *
 * Emitting `.toFloat()` around the operands would not rescue it either: the fold's
 * accumulator would become a Float while the expected value upstream is the
 * integer 64, and `expectEq` would be comparing across types. The honest answer is
 * that these two cases are not expressible in Aven with this case data, which is a
 * finding about Aven's numeric tower rather than a gap in this file — so it is
 * refused with that reason and reported as an omitted case.
 */
const AVEN_EMIT: EmitTarget = {
  lambda: (params, body) => `(${params.join(", ")}) => ${body}`,
  binary: (op, left, right) => {
    if (op === "/") {
      throw new Unrenderable(
        "pseudocode `/` is float division (upstream's expected values only follow" +
          " under it), but Aven's `Int / Int` is integer division and `2 / 0` is a" +
          " runtime error, so this case cannot be expressed over Int inputs",
      );
    }
    return `(${left} ${op === "modulo" ? "%" : op} ${right})`;
  },
  builtin: (name, args) => {
    const [x] = args;
    if (name === "upcase") return `(${x}).toUpper()`;
    if (name === "downcase") return `(${x}).toLower()`;
    if (name === "reverse") return `(${x}).reverse()`;
    throw new Unrenderable(`no Aven rendering for pseudocode builtin '${name}'`);
  },
  solutionCall: (property, args) => `solution.${property}(${args.join(", ")})`,
  int: (v) => v,
  text: (v) => avenText(v),
  array: (items) => `[${items.join(", ")}]`,
};

/** An argument: pseudocode functions become real lambdas, everything else is data. */
function renderAvenArg(task: Task, value: unknown): string {
  if (typeof value === "string" && isPseudocodeFunction(value)) {
    return renderPseudocode(value, AVEN_EMIT, new Set(task.properties.map((p) => p.name)));
  }
  return avenValue(fromPortable(value as Portable));
}

function render(task: Task, only?: ReadonlySet<string>): RenderedSuite {
  const omitted: OmittedCase[] = [];
  const lines: string[] = [];

  for (const c of task.cases) {
    if (only && !only.has(c.uuid)) continue;
    const prop = propertyOf(task, c.property);
    try {
      const args = orderedArgs(prop, c)
        .map((a) => renderAvenArg(task, a.value))
        .join(", ");
      const call = `solution.${c.property}(${args})`;
      const assertion =
        c.expected.kind === "error"
          ? `test.expectErr(${call})`
          : prop.returnsResult
            ? `test.expectEq(${call}, @Ok(${avenValue(fromPortable(c.expected.value))}))`
            : `test.expectEq(${call}, ${avenValue(fromPortable(c.expected.value))})`;
      lines.push(`  ${avenText(c.name)}: () => ${assertion},`);
    } catch (err) {
      if (!(err instanceof Unrenderable)) throw err;
      omitted.push({ name: c.name, uuid: c.uuid, reason: err.message });
    }
  }

  const header = [
    `# ${task.title} — generated by aven-bench from ${task.source}. Do not edit.`,
    `# task: ${task.id}   cases: ${lines.length}/${task.cases.length}`,
    "",
    'test = import("std/test")',
    'solution = import("./solution.av")',
    "",
  ];
  // A suite with no cases is not a suite; emit a single failing case so the
  // runner sees `fail`, never a vacuous green.
  const body =
    lines.length > 0
      ? ["{", ...lines, "}", ""]
      : ["{", '  "no renderable cases": () => test.fail("every case was omitted"),', "}", ""];
  return { contents: [...header, ...body].join("\n"), omitted };
}

function avenFieldName(name: string): string {
  return IDENT.test(name) ? name : avenText(name);
}

/**
 * A valid Aven type spelling, or null when Aven has no such type expression.
 *
 * Aven's `|` is for literal and tagged unions, not a general untagged union of
 * base types. Rendering `Int | Text` would therefore turn an observation into a
 * false signature. Those shapes fall back to prose made from valid type
 * fragments below.
 */
function avenShape(shape: Shape, absentAsOptional = false): string | null {
  switch (shape.kind) {
    case "unknown":
      return null;
    case "absent":
      return "Undefined";
    case "null":
      return "Null";
    case "bool":
      return "Bool";
    case "int":
      return "Int";
    case "float":
      return "Float";
    case "text":
      return "Text";
    case "callable":
      // Arity alone cannot honestly supply the parameter and result types.
      return null;
    case "array": {
      const element = avenShape(shape.element);
      return element === null ? null : `Array(${element})`;
    }
    case "record": {
      if (shape.keys === "withheld") return null;
      if (shape.fields.length === 0) return "{}";
      const fields = shape.fields.map((field) => {
        const value = avenShape(field.shape, true);
        return value === null ? null : `${avenFieldName(field.name)}: ${value}`;
      });
      return fields.some((field) => field === null)
        ? null
        : `{ ${fields.join(", ")} }`;
    }
    case "union": {
      const absent = shape.members.some((member) => member.kind === "absent");
      const nullable = shape.members.some((member) => member.kind === "null");
      const values = shape.members.filter(
        (member) => member.kind !== "absent" && member.kind !== "null",
      );
      // Prefix `?T` is the right spelling for an omittable record field, but it
      // does not turn a positional parameter into a defaulted argument.
      if (absent && !absentAsOptional) return null;
      if (values.length === 0) {
        if (absent && nullable) return "?Null";
        return absent ? "Undefined" : "Null";
      }
      if (values.length !== 1) return null;
      const value = avenShape(values[0]!);
      return value === null ? null : `${absent ? "?" : ""}${value}${nullable ? "?" : ""}`;
    }
  }
}

function avenShapeDescription(shape: Shape): string {
  const exact = avenShape(shape);
  if (exact !== null) return `\`${exact}\``;
  switch (shape.kind) {
    case "unknown":
      return "a value whose shape was not observed";
    case "callable":
      return shape.arity === null
        ? "a function of unknown arity"
        : `a function accepting ${shape.arity} positional argument${shape.arity === 1 ? "" : "s"}` +
            " (its parameter and return shapes were not inferred)";
    case "array":
      return `an \`Array\` whose elements are ${avenShapeDescription(shape.element)}`;
    case "record": {
      if (shape.keys === "withheld") {
        return (
          "a record with keys not enumerated by this contract and values of shape " +
          avenShapeDescription(shape.value)
        );
      }
      if (shape.fields.length === 0) return "a record with no observed keys";
      const fields = shape.fields.map((field) => {
        const members = membersOf(field.shape);
        const optional = members.some((member) => member.kind === "absent");
        const value = mergeShapes(members.filter((member) => member.kind !== "absent"));
        return `\`${field.name}\` (${optional ? "optional; " : ""}${avenShapeDescription(value)})`;
      });
      return `a record with observed keys ${fields.join(", ")}`;
    }
    case "union":
      return `either ${shape.members.map(avenShapeDescription).join(" or ")}`;
    // Every other shape has an exact spelling and returned above.
    default:
      return "a value whose shape could not be expressed";
  }
}

function contract(task: Task): string {
  const lines = [
    "## Your task",
    "",
    "Write `solution.av`. Its module value must be a record exporting these functions:",
    "",
    "The types and shapes below are observed across this task's cases, not a complete specification.",
    "",
  ];
  for (const observed of inferTaskShapes(task)) {
    const p = observed.property;
    const args = observed.args.map((argument) => argument.name).join(", ");
    const argumentTypes = observed.args.map((argument) => avenShape(argument.shape));
    const returnType = avenShape(observed.returns);
    const successType =
      returnType === null ? null : p.returnsResult ? `Result(${returnType}, Text)` : returnType;
    if (argumentTypes.every((type) => type !== null) && successType !== null) {
      const inputType =
        argumentTypes.length === 0
          ? "()"
          : argumentTypes.length === 1
            ? argumentTypes[0]!
            : `(${argumentTypes.join(", ")})`;
      const error = p.returnsResult
        ? " Return `@Ok(value)` on success and `@Err(message)` when the input is invalid."
        : "";
      lines.push(
        `- \`${p.name}(${args})\` — observed type \`${inputType} -> ${successType}\`.${error}`,
      );
    } else {
      const argumentsDescription =
        observed.args.length === 0
          ? "no arguments"
          : `observed arguments: ${observed.args
              .map(
                (argument) =>
                  `\`${argument.name}\` is ${avenShapeDescription(argument.shape)}`,
              )
              .join("; ")}`;
      const error = p.returnsResult
        ? " Return `@Ok(value)` on success and `@Err(message)` when the input is invalid."
        : "";
      lines.push(
        `- \`${p.name}(${args})\` — ${argumentsDescription}; observed successful return:` +
          ` ${avenShapeDescription(observed.returns)}.${error}`,
      );
    }
  }
  const exportList = task.properties.map((p) => p.name).join(", ");
  lines.push(
    "",
    "The last expression in the file is the module value, so end it with:",
    "",
    "```aven",
    `{ ${exportList} }`,
    "```",
    "",
    `The suite in \`${AVEN_TEST_FILE}\` imports it as \`import("./solution.av")\`. Do not edit the suite.`,
  );
  return lines.join("\n");
}

export const avenAdapter: LangAdapter = {
  id: "aven",
  displayName: "Aven",
  solutionFile: "solution.av",
  testFile: AVEN_TEST_FILE,
  renderTests: render,
  renderContract: contract,
  testCommand: (dir) => {
    const suite = `${dir}/${AVEN_TEST_FILE}`;
    const bin = process.env["AVEN_BIN"];
    // AVEN_BIN skips cargo's ~200ms of per-invocation bookkeeping; without it
    // fall back to the workspace so a fresh checkout works with no setup.
    // The CLI crate is named `aven`, not `aven-cli`.
    return bin
      ? { argv: [bin, "test", "--format", "json", suite], cwd: dir }
      : {
          argv: ["cargo", "run", "-q", "-p", "aven", "--", "test", "--format", "json", suite],
          cwd: AVEN_LANG_DIR,
        };
  },
  // The sandbox binds the configured AVEN_BIN in as plain `aven` on PATH, so the
  // model's command names neither the host path nor cargo.
  modelTestCommand: () => `aven test --format json ${AVEN_TEST_FILE}`,
  classifyExit: (code) => (code === 0 ? "pass" : code === 1 ? "fail" : "load-error"),
};

/** Exported for tests: the value renderer, in isolation. */
export function renderAvenValue(p: Portable): string {
  return avenValue(fromPortable(p));
}

// --- export-surface check --------------------------------------------------
//
// Aven modules may be effectful and need not export anything — `aven check` and
// `aven test` accept a file whose final expression is not a record. That is the
// right call for the language. It is the wrong call for the benchmark: the suite
// is about to call `solution.<property>(…)` for every property on the task, and
// when the model forgets the export record the suite fails with an opaque
// "no such field" cascade that never names the actual problem.
//
// The harness knows the property names. Checking the trailing export record
// against them is a pure text look at `solution.av` — no compiler invocation —
// and the diagnostic it produces is what the repair prompt needs so round 2
// can fix the surface instead of chasing suite fallout.

/** Result of comparing a solution's trailing export record to the task's properties. */
export type ExportCheck =
  | { ok: true; exported: string[] }
  | {
      ok: false;
      kind: "no-export-record" | "missing-names";
      message: string;
      exported: string[];
      missing: string[];
    };

/**
 * Strip `#` line comments without walking into string literals.
 *
 * Models produce ordinary Aven; this is not a full lexer. Double-quoted strings
 * and `\u{…}` / `\"` escapes are enough to keep a `#` inside a string from
 * eating the rest of the line, which is the only way comment stripping would
 * invent or destroy a trailing export record.
 */
function stripAvenLineComments(source: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < source.length) {
    const ch = source[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < source.length) {
          out += source[i + 1]!;
          i += 2;
          continue;
        }
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Body of a trailing top-level record literal, or null when the module's final
 * expression is not one.
 *
 * Aven's module value is the final expression. The contract tells the model to
 * end the file with `{ f, g }`; reference solutions and the verify stubs all do.
 * A bare identifier that happens to name a record elsewhere in the file is not
 * accepted here — that shape is rare under the contract, and reporting it as
 * "no export record" still points the repair at the fix the prompt already
 * describes.
 *
 * The open brace must begin its own line (or the file). That rejects a record
 * that is only an argument or operand of some other final expression
 * (`f({ a })`, `x + { a }`) without needing a full Aven parser.
 */
function trailingRecordBody(source: string): string | null {
  const text = stripAvenLineComments(source).trimEnd();
  if (!text.endsWith("}")) return null;

  let depth = 0;
  let inString = false;
  const end = text.length - 1;
  let start = -1;
  for (let i = end; i >= 0; i--) {
    const ch = text[i]!;
    if (inString) {
      // Walking backwards: a quote ends the string unless it is escaped by an
      // odd run of backslashes immediately before it.
      if (ch === '"') {
        let bs = 0;
        for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) bs++;
        if (bs % 2 === 0) inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "}") {
      depth++;
      continue;
    }
    if (ch === "{") {
      depth--;
      if (depth === 0) {
        start = i;
        break;
      }
    }
  }
  if (start < 0) return null;

  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (text.slice(lineStart, start).trim() !== "") return null;
  return text.slice(start + 1, end);
}

/**
 * Field names of a record body, top-level only.
 *
 * Understands the shapes models actually write: shorthand `{ f, g }`, explicit
 * `{ f: f, g: g }`, and multi-line forms. Nested braces/brackets/parens and
 * strings keep field values from being split on interior commas.
 */
function recordFieldNames(body: string): string[] {
  const names: string[] = [];
  let i = 0;
  let depth = 0;
  let inString = false;
  let fieldStart = 0;

  const pushField = (from: number, to: number) => {
    const raw = body.slice(from, to).trim();
    if (raw === "") return;
    // `name` or `name: value` or `"name": value`. The name is the first token.
    const m = /^([A-Za-z_][A-Za-z0-9_]*|"([^"\\]|\\.)*")/.exec(raw);
    if (!m) return;
    const tok = m[1]!;
    names.push(tok.startsWith('"') ? JSON.parse(tok) as string : tok);
  };

  while (i < body.length) {
    const ch = body[i]!;
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      i++;
      continue;
    }
    if (ch === "," && depth === 0) {
      pushField(fieldStart, i);
      fieldStart = i + 1;
      i++;
      continue;
    }
    i++;
  }
  pushField(fieldStart, body.length);
  return names;
}

/**
 * Compare `solution.av` against the property names the suite is about to call.
 *
 * Returns a precise diagnostic the repair prompt can quote. This is a *model*
 * failure (the solution's public surface is wrong), never a harness error.
 */
export function checkAvenExports(source: string, required: readonly string[]): ExportCheck {
  const body = trailingRecordBody(source);
  if (body === null) {
    const example = `{ ${required.join(", ")} }`;
    return {
      ok: false,
      kind: "no-export-record",
      exported: [],
      missing: [...required],
      message:
        `solution.av exports nothing: the module has no trailing export record. ` +
        `A module must end in a literal record like \`${example}\` to export anything.`,
    };
  }
  const exported = recordFieldNames(body);
  const have = new Set(exported);
  const missing = required.filter((name) => !have.has(name));
  if (missing.length === 0) return { ok: true, exported };
  return {
    ok: false,
    kind: "missing-names",
    exported,
    missing,
    message:
      `solution.av is missing export(s): ${missing.join(", ")}. ` +
      `Exported: ${exported.length > 0 ? exported.join(", ") : "(none)"}.`,
  };
}
