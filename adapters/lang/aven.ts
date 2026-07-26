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

const I64_MAX = 2n ** 63n - 1n;
const I64_MIN = -(2n ** 63n);

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
  if (isIntegerLiteral(raw)) {
    const v = BigInt(raw);
    if (v > I64_MAX || v < I64_MIN) {
      throw new Unrenderable(`integer ${raw} does not fit Aven's 64-bit Int`);
    }
    return raw;
  }
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
