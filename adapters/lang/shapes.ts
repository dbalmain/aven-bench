/**
 * Structural shapes observed in a property's cases.
 *
 * This is deliberately weaker than a type inference engine. Canonical data is
 * an oracle, not a specification: it can show that every observed value was an
 * Array(Int), but it cannot prove that the function is monomorphic or that a
 * future case will have the same shape. In particular, literal values never
 * enter this model. Input strings that canonical data marks as pseudocode
 * functions are the one exception to ordinary JSON decoding: every adapter
 * passes those as callables, so calling them Text here would be false. Record
 * keys seen only in expected values are withheld: in tasks such as word-count
 * those keys are the answers, not a return-type declaration.
 */

import { fromPortable, isIntegerLiteral, type JVal, type Portable } from "../../ingest/json.ts";
import type { Task, TaskProperty } from "../../ingest/task.ts";
import { casesOf, orderedArgs } from "./common.ts";
import { isPseudocodeFunction, parsePseudocode } from "./pseudocode.ts";

export type Shape =
  | { kind: "unknown" }
  | { kind: "absent" }
  | { kind: "null" }
  | { kind: "bool" }
  | { kind: "int" }
  | { kind: "float" }
  | { kind: "text" }
  | { kind: "callable"; arity: number | null }
  | { kind: "array"; element: Shape }
  | { kind: "record"; keys: "known"; fields: ShapeField[] }
  | { kind: "record"; keys: "withheld"; value: Shape }
  | { kind: "union"; members: Shape[] };

export type ShapeField = { name: string; shape: Shape };

export type PropertyShapes = {
  property: TaskProperty;
  args: { name: string; shape: Shape }[];
  /** Successful values only. Error cases already have a separate contract. */
  returns: Shape;
};

const UNKNOWN: Shape = { kind: "unknown" };
const ABSENT: Shape = { kind: "absent" };
const MAX_STRUCTURAL_RECORD_KEYS = 8;

function shapeKey(shape: Shape): string {
  switch (shape.kind) {
    case "callable":
      return `callable:${shape.arity ?? "unknown"}`;
    case "array":
      return `array:${shapeKey(shape.element)}`;
    case "record":
      return shape.keys === "known"
        ? `record:${shape.fields.map((f) => `${JSON.stringify(f.name)}:${shapeKey(f.shape)}`).join(",")}`
        : `record-withheld:${shapeKey(shape.value)}`;
    case "union":
      return `union:${shape.members.map(shapeKey).join(",")}`;
    default:
      return shape.kind;
  }
}

const KIND_ORDER: Record<Shape["kind"], number> = {
  absent: 0,
  null: 1,
  bool: 2,
  int: 3,
  float: 4,
  text: 5,
  callable: 6,
  array: 7,
  record: 8,
  unknown: 9,
  union: 10,
};

function compareShapes(a: Shape, b: Shape): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || shapeKey(a).localeCompare(shapeKey(b));
}

function mergeRecords(records: Extract<Shape, { kind: "record" }>[]): Shape {
  if (records.some((record) => record.keys === "withheld")) {
    return {
      kind: "record",
      keys: "withheld",
      value: mergeShapes(
        records.flatMap((record) =>
          record.keys === "withheld"
            ? [record.value]
            : record.fields.flatMap((field) =>
                membersOf(field.shape).filter((member) => member.kind !== "absent"),
              ),
        ),
      ),
    };
  }
  const known = records as Extract<Shape, { kind: "record"; keys: "known" }>[];
  const names = [...new Set(known.flatMap((record) => record.fields.map((field) => field.name)))].sort();
  const fields = names.map((name) => ({
    name,
    shape: mergeShapes(
      known.map((record) => record.fields.find((field) => field.name === name)?.shape ?? ABSENT),
    ),
  }));
  // A large or entirely unstable key set is data, not an anonymous record
  // declaration. Enumerating it would expose concrete input strings and make a
  // hidden suite easier to reconstruct. Small records with at least one stable
  // key retain their structural fields — the bank-account operation record is
  // the motivating case.
  const hasStableKey = fields.some(
    (field) => !membersOf(field.shape).some((member) => member.kind === "absent"),
  );
  if (fields.length > MAX_STRUCTURAL_RECORD_KEYS || (fields.length > 0 && !hasStableKey)) {
    return {
      kind: "record",
      keys: "withheld",
      value: mergeShapes(
        fields.flatMap((field) =>
          membersOf(field.shape).filter((member) => member.kind !== "absent"),
        ),
      ),
    };
  }
  return {
    kind: "record",
    keys: "known",
    fields,
  };
}

/**
 * Join observations in the small lattice.
 *
 * `unknown` is bottom here: it means "no value was observed", as with the
 * element of an empty array or a property with only error cases. Heterogeneous
 * observations stay as unions. Record observations merge by key and mark a key
 * absent when it did not occur in every record; this intentionally forgets
 * correlations between fields rather than inventing a discriminated union.
 */
export function mergeShapes(shapes: readonly Shape[]): Shape {
  const flat = shapes.flatMap((shape) => (shape.kind === "union" ? shape.members : [shape]));
  const observed = flat.filter((shape) => shape.kind !== "unknown");
  if (observed.length === 0) return UNKNOWN;

  const arrays = observed.filter((shape): shape is Extract<Shape, { kind: "array" }> => shape.kind === "array");
  const records = observed.filter(
    (shape): shape is Extract<Shape, { kind: "record" }> => shape.kind === "record",
  );
  const rest = observed.filter((shape) => shape.kind !== "array" && shape.kind !== "record");
  const consolidated: Shape[] = [...rest];
  if (arrays.length > 0) {
    consolidated.push({ kind: "array", element: mergeShapes(arrays.map((array) => array.element)) });
  }
  if (records.length > 0) consolidated.push(mergeRecords(records));

  const unique = new Map(consolidated.map((shape) => [shapeKey(shape), shape]));
  const members = [...unique.values()].sort(compareShapes);
  return members.length === 1 ? members[0]! : { kind: "union", members };
}

function shapeOfValue(value: JVal, exposeRecordKeys: boolean): Shape {
  switch (value.kind) {
    case "null":
      return { kind: "null" };
    case "bool":
      return { kind: "bool" };
    case "number":
      return { kind: isIntegerLiteral(value.raw) ? "int" : "float" };
    case "string":
      // Even a small closed set stays Text. Canonical cases are observations,
      // not an enum declaration, and spelling the literals would expose hidden
      // inputs for a modest gain in interface precision.
      return { kind: "text" };
    case "array":
      return {
        kind: "array",
        element: mergeShapes(value.items.map((item) => shapeOfValue(item, exposeRecordKeys))),
      };
    case "object": {
      if (!exposeRecordKeys) {
        return {
          kind: "record",
          keys: "withheld",
          value: mergeShapes(value.entries.map((entry) => shapeOfValue(entry.value, false))),
        };
      }
      return {
        kind: "record",
        keys: "known",
        fields: value.entries
          .map((entry) => ({
            name: entry.key,
            shape: shapeOfValue(entry.value, true),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }
  }
}

/** Runtime shape of one argument after the adapters' shared input conversion. */
function shapeOfArgument(value: Portable): Shape {
  const decoded = fromPortable(value);
  if (decoded.kind !== "string" || !isPseudocodeFunction(decoded.value)) {
    return shapeOfValue(decoded, true);
  }
  try {
    const expression = parsePseudocode(decoded.value);
    return expression.kind === "lambda"
      ? { kind: "callable", arity: expression.params.length }
      : { kind: "callable", arity: null };
  } catch {
    // The adapters will refuse malformed pseudocode, but it is still more honest
    // to call the intended argument a callable than to relabel it as Text.
    return { kind: "callable", arity: null };
  }
}

export function inferPropertyShapes(task: Task, property: TaskProperty): PropertyShapes {
  const cases = casesOf(task, property.name);
  const args = property.argNames.map((name, index) => ({
    name,
    // Calls are positional. Using the normalized order also covers rare cases
    // whose upstream argument names differ from the property's modal tuple.
    shape: mergeShapes(
      cases.map((testCase) => {
        const argument = orderedArgs(property, testCase)[index];
        return argument ? shapeOfArgument(argument.value) : ABSENT;
      }),
    ),
  }));
  const returns = mergeShapes(
    cases.flatMap((testCase) =>
      testCase.expected.kind === "value"
        ? [shapeOfValue(fromPortable(testCase.expected.value), false)]
        : [],
    ),
  );
  return { property, args, returns };
}

export function inferTaskShapes(task: Task): PropertyShapes[] {
  return task.properties.map((property) => inferPropertyShapes(task, property));
}

export function membersOf(shape: Shape): Shape[] {
  return shape.kind === "union" ? shape.members : [shape];
}

export function containsShape(shape: Shape, kind: Shape["kind"]): boolean {
  if (shape.kind === kind) return true;
  if (shape.kind === "array") return containsShape(shape.element, kind);
  if (shape.kind === "record") {
    return shape.keys === "known"
      ? shape.fields.some((field) => containsShape(field.shape, kind))
      : containsShape(shape.value, kind);
  }
  if (shape.kind === "union") return shape.members.some((member) => containsShape(member, kind));
  return false;
}
