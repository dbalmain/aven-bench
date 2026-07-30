/**
 * Corpus type annotations: load, parse, and validate hand-authored sidecars
 * under `annotations/types/`.
 *
 * Stored form is Aven type *strings* in a closed corpus subset (not a full Aven
 * typechecker). An internal TypeExpr is derived for matching against case data.
 * Variant positions also carry a data-driven `encoding` that maps JSON
 * discriminators to `@Tag` constructors — the adapter must never branch on
 * `task.id`.
 *
 * See `.ai/corpus-type-annotations-draft.md` (rev 5).
 */

import { readdir } from "node:fs/promises";
import { isIntegerLiteral, type JVal } from "./json.ts";
import { TYPE_ANNOTATIONS_DIR } from "./paths.ts";
import {
  decodeCaseArgs,
  decodeExpected,
  type Task,
  type TaskCase,
} from "./task.ts";

// ---------------------------------------------------------------------------
// On-disk schema
// ---------------------------------------------------------------------------

export type PayloadSpec =
  | { from: "none" }
  | { from: "field"; name: string }
  | { from: "rest" }
  | { from: "value" };

export type TagFieldEncoding = {
  kind: "tagField";
  field: string;
  tags: Record<string, { ctor: string; payload: PayloadSpec }>;
};

export type ExclusiveKeyEncoding = {
  kind: "exclusiveKey";
  keys: Record<string, { ctor: string; payload: PayloadSpec }>;
};

export type VariantEncoding = TagFieldEncoding | ExclusiveKeyEncoding;

export type TypePosition = {
  at: string;
  /** Aven type surface string in the corpus subset. */
  type: string;
  encoding?: VariantEncoding;
};

export type TypeAnnFile = {
  schemaVersion: 1;
  task: string;
  positions: TypePosition[];
};

/** Position after load: type string parsed, path segmented. */
export type ResolvedPosition = {
  at: string;
  segments: string[];
  typeString: string;
  type: TypeExpr;
  encoding?: VariantEncoding;
};

export type ResolvedTypeAnn = {
  schemaVersion: 1;
  task: string;
  positions: ResolvedPosition[];
};

// ---------------------------------------------------------------------------
// Internal TypeExpr (not stored)
// ---------------------------------------------------------------------------

export type PrimitiveKind = "null" | "bool" | "int" | "float" | "text";
export type MapKeyKind = "text" | "int";

export type TypeExpr =
  | { kind: "primitive"; of: PrimitiveKind }
  | { kind: "array"; element: TypeExpr }
  | { kind: "map"; key: MapKeyKind; value: TypeExpr }
  | { kind: "object" }
  | { kind: "optional"; inner: TypeExpr }
  | { kind: "union"; members: TypeExpr[] }
  | { kind: "variant"; alts: VariantAlt[] };

export type VariantAlt = { tag: string; payload: TypeExpr | null };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TypeAnnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeAnnError";
  }
}

/** Prefer this wording for valid-but-out-of-subset Aven surface. */
function unsupported(detail: string): never {
  throw new TypeAnnError(`unsupported in corpus annotations: ${detail}`);
}

// ---------------------------------------------------------------------------
// Type-string parser (corpus subset)
// ---------------------------------------------------------------------------

/**
 * Grammar (whitespace ignored between tokens):
 *
 *   type     := union
 *   union    := optional ( "|" optional )*
 *   optional := "?" primary | primary
 *   primary  := Null|Bool|Int|Float|Text|Object
 *             | Array(type) | Map(Text|Int, type)
 *             | @Tag | @Tag(type) | (type)
 */
export function parseTypeString(src: string): TypeExpr {
  const p = new TypeParser(src);
  const t = p.parseType();
  p.skipWs();
  if (!p.eof()) unsupported(`trailing content in type ${JSON.stringify(src)}`);
  return normalizeType(t);
}

class TypeParser {
  i = 0;
  constructor(readonly src: string) {}

  eof(): boolean {
    return this.i >= this.src.length;
  }

  skipWs(): void {
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else break;
    }
  }

  peek(): string | undefined {
    this.skipWs();
    return this.src[this.i];
  }

  /** Consume exact text after skipWs; return whether matched. */
  lit(text: string): boolean {
    this.skipWs();
    if (this.src.startsWith(text, this.i)) {
      this.i += text.length;
      return true;
    }
    return false;
  }

  expect(text: string): void {
    if (!this.lit(text)) {
      unsupported(`expected ${JSON.stringify(text)} in type ${JSON.stringify(this.src)}`);
    }
  }

  parseType(): TypeExpr {
    const members: TypeExpr[] = [this.parseOptional()];
    while (this.lit("|")) members.push(this.parseOptional());
    if (members.length === 1) return members[0]!;
    return { kind: "union", members };
  }

  parseOptional(): TypeExpr {
    if (this.lit("?")) {
      return { kind: "optional", inner: this.parsePrimary() };
    }
    return this.parsePrimary();
  }

  parsePrimary(): TypeExpr {
    this.skipWs();
    if (this.lit("(")) {
      const inner = this.parseType();
      this.expect(")");
      return inner;
    }
    if (this.lit("@")) return this.parseVariant();

    const name = this.readIdent();
    if (name === undefined) {
      unsupported(`expected type at offset ${this.i} in ${JSON.stringify(this.src)}`);
    }

    switch (name) {
      case "Null":
        return { kind: "primitive", of: "null" };
      case "Bool":
        return { kind: "primitive", of: "bool" };
      case "Int":
        return { kind: "primitive", of: "int" };
      case "Float":
        return { kind: "primitive", of: "float" };
      case "Text":
        return { kind: "primitive", of: "text" };
      case "Object":
        return { kind: "object" };
      case "Array": {
        this.expect("(");
        const element = this.parseType();
        this.expect(")");
        return { kind: "array", element };
      }
      case "Map": {
        this.expect("(");
        const keyName = this.readIdent();
        if (keyName !== "Text" && keyName !== "Int") {
          unsupported(`Map key must be Text or Int, got ${JSON.stringify(keyName)}`);
        }
        this.expect(",");
        const value = this.parseType();
        this.expect(")");
        return {
          kind: "map",
          key: keyName === "Text" ? "text" : "int",
          value,
        };
      }
      default:
        unsupported(`type name ${JSON.stringify(name)}`);
    }
  }

  parseVariant(): TypeExpr {
    const tag = this.readIdent();
    if (tag === undefined || !/^[A-Z]/.test(tag)) {
      unsupported(`variant tag must be @Uppercase… in ${JSON.stringify(this.src)}`);
    }
    if (this.lit("(")) {
      // Single payload only; comma would start a tuple — unsupported.
      const payload = this.parseType();
      this.skipWs();
      if (this.peek() === ",") {
        unsupported(`tuple payloads (@${tag}(T1, T2)); use a single payload type`);
      }
      this.expect(")");
      return { kind: "variant", alts: [{ tag, payload }] };
    }
    return { kind: "variant", alts: [{ tag, payload: null }] };
  }

  readIdent(): string | undefined {
    this.skipWs();
    const start = this.i;
    const c0 = this.src[this.i];
    if (c0 === undefined || !/[A-Za-z_]/.test(c0)) return undefined;
    this.i++;
    while (this.i < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.i]!)) {
      this.i++;
    }
    return this.src.slice(start, this.i);
  }
}

function normalizeType(t: TypeExpr): TypeExpr {
  switch (t.kind) {
    case "array":
      return { kind: "array", element: normalizeType(t.element) };
    case "map":
      return { kind: "map", key: t.key, value: normalizeType(t.value) };
    case "optional":
      return { kind: "optional", inner: normalizeType(t.inner) };
    case "variant":
      return {
        kind: "variant",
        alts: t.alts.map((a) => ({
          tag: a.tag,
          payload: a.payload ? normalizeType(a.payload) : null,
        })),
      };
    case "union": {
      const flat: TypeExpr[] = [];
      for (const m of t.members) {
        const n = normalizeType(m);
        if (n.kind === "union") flat.push(...n.members);
        else flat.push(n);
      }
      // Collapse pure variant unions into one variant type.
      if (flat.length > 0 && flat.every((m) => m.kind === "variant")) {
        const alts: VariantAlt[] = [];
        const seen = new Set<string>();
        for (const m of flat as Extract<TypeExpr, { kind: "variant" }>[]) {
          for (const a of m.alts) {
            if (seen.has(a.tag)) {
              throw new TypeAnnError(
                `duplicate variant tag @${a.tag} in type union`,
              );
            }
            seen.add(a.tag);
            alts.push(a);
          }
        }
        return { kind: "variant", alts };
      }
      if (flat.length === 1) return flat[0]!;
      return { kind: "union", members: flat };
    }
    default:
      return t;
  }
}

/** Root type for encoding checks: unwrap a single outer optional. */
export function rootForEncoding(t: TypeExpr): TypeExpr {
  return t.kind === "optional" ? t.inner : t;
}

function typeContainsVariant(t: TypeExpr): boolean {
  switch (t.kind) {
    case "variant":
      return true;
    case "optional":
      return typeContainsVariant(t.inner);
    case "union":
      return t.members.some(typeContainsVariant);
    case "array":
      return typeContainsVariant(t.element);
    case "map":
      return typeContainsVariant(t.value);
    default:
      return false;
  }
}

/** Variants only at root; payloads and nestings must be variant-free. */
function assertVariantPlacement(t: TypeExpr, where: string): void {
  const root = rootForEncoding(t);
  if (root.kind === "variant") {
    for (const a of root.alts) {
      if (a.payload && typeContainsVariant(a.payload)) {
        throw new TypeAnnError(
          `${where}: variant payloads must not contain variants (annotate nested paths instead)`,
        );
      }
    }
    // Outer optional wrapping a variant is fine; other wrappers are not expected.
    if (t.kind === "union") {
      throw new TypeAnnError(
        `${where}: mix of variant and non-variant union members is unsupported in corpus annotations`,
      );
    }
    return;
  }
  if (typeContainsVariant(t)) {
    throw new TypeAnnError(
      `${where}: variants may only appear at the position root (use a path ending in [] for array elements)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Path parser
// ---------------------------------------------------------------------------

/**
 * Parse an author path into segments.
 * Segments use "[]" for array walk; property is segments[0]; root is
 * "expected" or begins with "arg".
 */
export function parsePath(at: string): string[] {
  if (at.includes("*")) {
    throw new TypeAnnError(`path must not contain '*': ${JSON.stringify(at)}`);
  }
  const p = new PathParser(at);
  const property = p.readIdentOrQuoted();
  if (property === undefined) {
    throw new TypeAnnError(`path does not parse: ${JSON.stringify(at)}`);
  }
  p.expectDot();
  const segments: string[] = [property];

  if (p.tryIdent("expected")) {
    segments.push("expected");
  } else if (p.tryIdent("arg")) {
    segments.push("arg");
    p.expectDot();
    const argName = p.readIdentOrQuoted();
    if (argName === undefined) {
      throw new TypeAnnError(`path missing arg name: ${JSON.stringify(at)}`);
    }
    segments.push(argName);
    // `arg.operations[]`
    if (p.tryLit("[]")) segments.push("[]");
  } else {
    throw new TypeAnnError(
      `path must continue with expected or arg after property: ${JSON.stringify(at)}`,
    );
  }

  // Further segments. `users[].owes` = field users, [], field owes — `[]` is a
  // suffix on the preceding field, not a dotted token.
  while (p.tryDot()) {
    if (p.tryLit("[]")) {
      segments.push("[]");
      continue;
    }
    const seg = p.readIdentOrQuoted();
    if (seg === undefined) {
      throw new TypeAnnError(`path does not parse: ${JSON.stringify(at)}`);
    }
    segments.push(seg);
    if (p.tryLit("[]")) segments.push("[]");
  }

  if (!p.eof()) {
    throw new TypeAnnError(`path does not parse: ${JSON.stringify(at)}`);
  }
  return segments;
}

class PathParser {
  i = 0;
  constructor(readonly src: string) {}

  eof(): boolean {
    return this.i >= this.src.length;
  }

  tryLit(text: string): boolean {
    if (this.src.startsWith(text, this.i)) {
      this.i += text.length;
      return true;
    }
    return false;
  }

  tryDot(): boolean {
    if (this.src[this.i] === ".") {
      this.i++;
      return true;
    }
    return false;
  }

  expectDot(): void {
    if (!this.tryDot()) {
      throw new TypeAnnError(`path does not parse: ${JSON.stringify(this.src)}`);
    }
  }

  tryIdent(name: string): boolean {
    const start = this.i;
    const id = this.readIdent();
    if (id === name) return true;
    this.i = start;
    return false;
  }

  readIdent(): string | undefined {
    const start = this.i;
    const c0 = this.src[this.i];
    if (c0 === undefined || !/[A-Za-z_]/.test(c0)) return undefined;
    this.i++;
    while (this.i < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.i]!)) {
      this.i++;
    }
    return this.src.slice(start, this.i);
  }

  readIdentOrQuoted(): string | undefined {
    if (this.src[this.i] === '"') return this.readQuoted();
    return this.readIdent();
  }

  readQuoted(): string {
    if (this.src[this.i] !== '"') {
      throw new TypeAnnError(`path does not parse: ${JSON.stringify(this.src)}`);
    }
    this.i++;
    let out = "";
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === "\\") {
        this.i++;
        const e = this.src[this.i];
        if (e === undefined) {
          throw new TypeAnnError(`path does not parse: ${JSON.stringify(this.src)}`);
        }
        if (e === '"' || e === "\\") out += e;
        else if (e === "n") out += "\n";
        else if (e === "t") out += "\t";
        else {
          throw new TypeAnnError(`path bad escape: ${JSON.stringify(this.src)}`);
        }
        this.i++;
        continue;
      }
      out += c;
      this.i++;
    }
    throw new TypeAnnError(`path does not parse: ${JSON.stringify(this.src)}`);
  }
}

/** True when `a` is a proper segment-prefix of `b` (or equal if allowEqual). */
export function isSegmentPrefix(
  a: readonly string[],
  b: readonly string[],
  allowEqual = false,
): boolean {
  if (a.length > b.length) return false;
  if (a.length === b.length) return allowEqual && a.every((s, i) => s === b[i]);
  return a.every((s, i) => s === b[i]);
}

export function checkPathOverlaps(positions: { at: string; segments: string[] }[]): void {
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i]!;
      const b = positions[j]!;
      if (isSegmentPrefix(a.segments, b.segments, true) || isSegmentPrefix(b.segments, a.segments, true)) {
        throw new TypeAnnError(
          `path overlap (segment prefix): ${JSON.stringify(a.at)} vs ${JSON.stringify(b.at)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Path resolve
// ---------------------------------------------------------------------------

export function resolvePath(segments: readonly string[], value: JVal): JVal[] {
  if (segments.length === 0) return [value];
  const [head, ...tail] = segments as [string, ...string[]];
  if (head === "[]") {
    if (value.kind !== "array") return [];
    return value.items.flatMap((item) => resolvePath(tail, item));
  }
  if (value.kind !== "object") return [];
  const entry = value.entries.find((e) => e.key === head);
  if (!entry) return [];
  return resolvePath(tail, entry.value);
}

/**
 * Collect hits for a property-scoped path across all cases.
 * Segments: [property, "expected"] or [property, "arg", argName, ...fieldPath]
 */
export function collectHits(task: Task, segments: readonly string[]): JVal[] {
  const property = segments[0];
  if (property === undefined) return [];
  const hits: JVal[] = [];
  for (const c of task.cases) {
    if (c.property !== property) continue;
    const root = caseRoot(c, segments);
    if (root === undefined) continue;
    const rest = segments[1] === "expected"
      ? segments.slice(2)
      : segments.slice(3); // drop property, "arg", argName
    hits.push(...resolvePath(rest, root));
  }
  return hits;
}

function caseRoot(c: TaskCase, segments: readonly string[]): JVal | undefined {
  if (segments[1] === "expected") {
    const exp = decodeExpected(c);
    if (exp.kind === "error") return undefined;
    return exp.value;
  }
  if (segments[1] === "arg") {
    const argName = segments[2];
    if (argName === undefined) return undefined;
    const args = decodeCaseArgs(c);
    const arg = args.find((a) => a.name === argName);
    return arg?.value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Encoding validation helpers
// ---------------------------------------------------------------------------

const CTOR_RE = /^[A-Z][A-Za-z0-9_]*$/;

function parsePayloadSpec(raw: unknown, ctx: string): PayloadSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeAnnError(`${ctx}: payload must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const from = o["from"];
  if (from === "none") return { from: "none" };
  if (from === "rest") return { from: "rest" };
  if (from === "value") return { from: "value" };
  if (from === "field") {
    if (typeof o["name"] !== "string" || o["name"].length === 0) {
      throw new TypeAnnError(`${ctx}: payload.from field requires name`);
    }
    return { from: "field", name: o["name"] };
  }
  throw new TypeAnnError(`${ctx}: payload.from must be none|field|rest|value`);
}

function parseEncoding(raw: unknown, ctx: string): VariantEncoding {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeAnnError(`${ctx}: encoding must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const kind = o["kind"];
  if (kind === "tagField") {
    if (typeof o["field"] !== "string" || o["field"].length === 0) {
      throw new TypeAnnError(`${ctx}: tagField.field required`);
    }
    if (typeof o["tags"] !== "object" || o["tags"] === null || Array.isArray(o["tags"])) {
      throw new TypeAnnError(`${ctx}: tagField.tags required`);
    }
    const tags: TagFieldEncoding["tags"] = {};
    for (const [jsonTag, spec] of Object.entries(o["tags"] as Record<string, unknown>)) {
      if (typeof spec !== "object" || spec === null) {
        throw new TypeAnnError(`${ctx}: tags[${JSON.stringify(jsonTag)}] invalid`);
      }
      const s = spec as Record<string, unknown>;
      if (typeof s["ctor"] !== "string" || !CTOR_RE.test(s["ctor"])) {
        throw new TypeAnnError(
          `${ctx}: tags[${JSON.stringify(jsonTag)}].ctor must be Uppercase ident`,
        );
      }
      const payload = parsePayloadSpec(s["payload"], `${ctx}.tags[${jsonTag}]`);
      if (payload.from === "value") {
        throw new TypeAnnError(`${ctx}: tagField cannot use payload.from value`);
      }
      tags[jsonTag] = { ctor: s["ctor"], payload };
    }
    if (Object.keys(tags).length === 0) {
      throw new TypeAnnError(`${ctx}: tagField.tags must be non-empty`);
    }
    return { kind: "tagField", field: o["field"], tags };
  }
  if (kind === "exclusiveKey") {
    if (typeof o["keys"] !== "object" || o["keys"] === null || Array.isArray(o["keys"])) {
      throw new TypeAnnError(`${ctx}: exclusiveKey.keys required`);
    }
    const keys: ExclusiveKeyEncoding["keys"] = {};
    for (const [jsonKey, spec] of Object.entries(o["keys"] as Record<string, unknown>)) {
      if (typeof spec !== "object" || spec === null) {
        throw new TypeAnnError(`${ctx}: keys[${JSON.stringify(jsonKey)}] invalid`);
      }
      const s = spec as Record<string, unknown>;
      if (typeof s["ctor"] !== "string" || !CTOR_RE.test(s["ctor"])) {
        throw new TypeAnnError(
          `${ctx}: keys[${JSON.stringify(jsonKey)}].ctor must be Uppercase ident`,
        );
      }
      const payload = parsePayloadSpec(s["payload"], `${ctx}.keys[${jsonKey}]`);
      if (payload.from === "field" || payload.from === "rest") {
        throw new TypeAnnError(
          `${ctx}: exclusiveKey payload.from must be none or value`,
        );
      }
      keys[jsonKey] = { ctor: s["ctor"], payload };
    }
    if (Object.keys(keys).length === 0) {
      throw new TypeAnnError(`${ctx}: exclusiveKey.keys must be non-empty`);
    }
    return { kind: "exclusiveKey", keys };
  }
  throw new TypeAnnError(`${ctx}: encoding.kind must be tagField or exclusiveKey`);
}

function crossCheckEncoding(type: TypeExpr, encoding: VariantEncoding, ctx: string): void {
  const root = rootForEncoding(type);
  if (root.kind !== "variant") {
    throw new TypeAnnError(`${ctx}: encoding requires a variant type`);
  }
  const alts = new Map(root.alts.map((a) => [a.tag, a]));
  const entries =
    encoding.kind === "tagField"
      ? Object.values(encoding.tags)
      : Object.values(encoding.keys);
  const ctors = new Set<string>();
  for (const e of entries) {
    if (ctors.has(e.ctor)) {
      throw new TypeAnnError(`${ctx}: duplicate ctor @${e.ctor} in encoding`);
    }
    ctors.add(e.ctor);
    const alt = alts.get(e.ctor);
    if (!alt) {
      throw new TypeAnnError(
        `${ctx}: encoding ctor @${e.ctor} not in type ${JSON.stringify(typeStringOf(type))}`,
      );
    }
    const encNone = e.payload.from === "none";
    const typeNone = alt.payload === null;
    if (encNone !== typeNone) {
      throw new TypeAnnError(
        `${ctx}: @${e.ctor} payload presence mismatch between type and encoding`,
      );
    }
  }
  for (const tag of alts.keys()) {
    if (!ctors.has(tag)) {
      throw new TypeAnnError(
        `${ctx}: type tag @${tag} missing from encoding`,
      );
    }
  }
}

/** Best-effort re-print for error messages only (not normative). */
function typeStringOf(t: TypeExpr): string {
  switch (t.kind) {
    case "primitive":
      return t.of === "null"
        ? "Null"
        : t.of === "bool"
          ? "Bool"
          : t.of === "int"
            ? "Int"
            : t.of === "float"
              ? "Float"
              : "Text";
    case "object":
      return "Object";
    case "array":
      return `Array(${typeStringOf(t.element)})`;
    case "map":
      return `Map(${t.key === "text" ? "Text" : "Int"}, ${typeStringOf(t.value)})`;
    case "optional":
      return `?${typeStringOf(t.inner)}`;
    case "union":
      return t.members.map(typeStringOf).join(" | ");
    case "variant":
      return t.alts
        .map((a) => (a.payload ? `@${a.tag}(${typeStringOf(a.payload)})` : `@${a.tag}`))
        .join(" | ");
  }
}

// ---------------------------------------------------------------------------
// matches
// ---------------------------------------------------------------------------

export type MatchOptions = {
  encoding?: VariantEncoding;
};

/**
 * Structural match of a TypeExpr against a JVal.
 * For variants, `opts.encoding` is required (position encoding).
 */
export function matches(type: TypeExpr, value: JVal, opts: MatchOptions = {}): boolean {
  switch (type.kind) {
    case "primitive":
      return matchPrimitive(type.of, value);
    case "object":
      return value.kind === "object";
    case "array":
      return (
        value.kind === "array" &&
        value.items.every((item) => matches(type.element, item, opts))
      );
    case "map":
      return matchMap(type, value, opts);
    case "optional":
      return value.kind === "null" || matches(type.inner, value, opts);
    case "union":
      return type.members.some((m) => matches(m, value, opts));
    case "variant":
      return matchVariant(type, value, opts.encoding);
  }
}

function matchPrimitive(of: PrimitiveKind, value: JVal): boolean {
  switch (of) {
    case "null":
      return value.kind === "null";
    case "bool":
      return value.kind === "bool";
    case "text":
      return value.kind === "string";
    case "int":
      return value.kind === "number" && isIntegerLiteral(value.raw);
    case "float":
      return value.kind === "number";
  }
}

function matchMap(
  type: Extract<TypeExpr, { kind: "map" }>,
  value: JVal,
  opts: MatchOptions,
): boolean {
  if (value.kind !== "object") return false;
  for (const e of value.entries) {
    if (type.key === "int" && !/^-?[0-9]+$/.test(e.key)) return false;
    if (!matches(type.value, e.value, opts)) return false;
  }
  return true;
}

function matchVariant(
  type: Extract<TypeExpr, { kind: "variant" }>,
  value: JVal,
  encoding: VariantEncoding | undefined,
): boolean {
  if (!encoding) return false;
  if (value.kind !== "object") return false;
  const extracted = extractVariant(value, encoding);
  if (!extracted) return false;
  const alt = type.alts.find((a) => a.tag === extracted.ctor);
  if (!alt) return false;
  if (alt.payload === null) return extracted.payload === null;
  // Empty rest is represented as null extraction; treat as `{}` when the type
  // expects an Object payload.
  const payload =
    extracted.payload ??
    (alt.payload.kind === "object" ? ({ kind: "object", entries: [] } as JVal) : null);
  if (payload === null) return false;
  return matches(alt.payload, payload, {});
}

export type ExtractedVariant = {
  ctor: string;
  payload: JVal | null;
};

/**
 * Extract ctor + payload from a JSON object using encoding.
 * Returns null if the object does not fit the encoding shape.
 */
export function extractVariant(
  value: Extract<JVal, { kind: "object" }>,
  encoding: VariantEncoding,
): ExtractedVariant | null {
  if (encoding.kind === "tagField") {
    const tagEntry = value.entries.find((e) => e.key === encoding.field);
    if (!tagEntry || tagEntry.value.kind !== "string") return null;
    const spec = encoding.tags[tagEntry.value.value];
    if (!spec) return null;
    return extractPayload(value, encoding.field, spec.ctor, spec.payload, "tagField");
  }
  // exclusiveKey
  if (value.entries.length !== 1) return null;
  const only = value.entries[0]!;
  const spec = encoding.keys[only.key];
  if (!spec) return null;
  return extractPayload(value, only.key, spec.ctor, spec.payload, "exclusiveKey");
}

function extractPayload(
  value: Extract<JVal, { kind: "object" }>,
  discKey: string,
  ctor: string,
  payload: PayloadSpec,
  mode: "tagField" | "exclusiveKey",
): ExtractedVariant | null {
  if (payload.from === "none") {
    if (mode === "tagField") {
      if (value.entries.some((e) => e.key !== discKey)) return null;
      return { ctor, payload: null };
    }
    // exclusiveKey: value under the exclusive key must be null
    const only = value.entries[0]!;
    if (only.value.kind !== "null") return null;
    return { ctor, payload: null };
  }
  if (payload.from === "field") {
    if (mode !== "tagField") return null;
    const field = value.entries.find((e) => e.key === payload.name);
    if (!field) return null;
    // Extra non-tag, non-payload fields are forbidden.
    for (const e of value.entries) {
      if (e.key !== discKey && e.key !== payload.name) return null;
    }
    return { ctor, payload: field.value };
  }
  if (payload.from === "rest") {
    if (mode !== "tagField") return null;
    const rest = value.entries.filter((e) => e.key !== discKey);
    if (rest.length === 0) return { ctor, payload: null };
    return { ctor, payload: { kind: "object", entries: rest } };
  }
  if (payload.from === "value") {
    if (mode !== "exclusiveKey") return null;
    const only = value.entries[0]!;
    return { ctor, payload: only.value };
  }
  return null;
}

/** Human label for a JVal in mismatch messages (type-ish, not JVal.kind). */
function valueTypeLabel(value: JVal): string {
  switch (value.kind) {
    case "null":
      return "Null";
    case "bool":
      return "Bool";
    case "string":
      return "Text";
    case "number":
      return isIntegerLiteral(value.raw) ? "Int" : "Float";
    case "array":
      return "Array";
    case "object":
      return "Object";
  }
}

/**
 * Like matches, but throws TypeAnnError with a specific cause on failure.
 * Used by validation so wrong annotations name the offending key/index/member.
 *
 * Walks the same structure as `matches` (accept/reject rules unchanged) and
 * threads a breadcrumb site string so the message names the failure without a
 * second explain pass.
 */
export function assertMatches(
  type: TypeExpr,
  value: JVal,
  opts: MatchOptions & { ctx: string },
): void {
  assertMatchAt(type, value, opts.ctx, "", opts);
}

/** `site` is a relative breadcrumb under `ctx` (e.g. ` value at key "word"`). */
function fail(ctx: string, site: string, detail: string): never {
  throw new TypeAnnError(`${ctx}${site}: ${detail}`);
}

function assertMatchAt(
  type: TypeExpr,
  value: JVal,
  ctx: string,
  site: string,
  opts: MatchOptions,
): void {
  switch (type.kind) {
    case "optional":
      if (value.kind === "null") return;
      assertMatchAt(type.inner, value, ctx, site, opts);
      return;
    case "union": {
      if (type.members.some((m) => matches(m, value, opts))) return;
      const tried = type.members.map(typeStringOf).join(", ");
      fail(
        ctx,
        site,
        `no union member matched among ${tried} (got ${valueTypeLabel(value)})`,
      );
    }
    case "variant":
      // Variants keep their own diagnostics; fold site into ctx for the prefix.
      assertMatchVariant(type, value, {
        ...opts,
        ctx: site ? `${ctx}${site}` : ctx,
      });
      return;
    case "map":
      assertMatchMap(type, value, ctx, site, opts);
      return;
    case "array":
      assertMatchArray(type, value, ctx, site, opts);
      return;
    case "object":
      if (value.kind !== "object") {
        fail(ctx, site, `expected Object, got ${valueTypeLabel(value)}`);
      }
      return;
    case "primitive":
      assertMatchPrimitive(type.of, value, ctx, site);
      return;
  }
}

function assertMatchPrimitive(
  of: PrimitiveKind,
  value: JVal,
  ctx: string,
  site: string,
): void {
  if (matchPrimitive(of, value)) return;
  const want =
    of === "null"
      ? "Null"
      : of === "bool"
        ? "Bool"
        : of === "int"
          ? "Int"
          : of === "float"
            ? "Float"
            : "Text";
  fail(ctx, site, `expected ${want}, got ${valueTypeLabel(value)}`);
}

function assertMatchMap(
  type: Extract<TypeExpr, { kind: "map" }>,
  value: JVal,
  ctx: string,
  site: string,
  opts: MatchOptions,
): void {
  if (value.kind !== "object") {
    fail(ctx, site, `expected Map, got ${valueTypeLabel(value)}`);
  }
  for (const e of value.entries) {
    if (type.key === "int" && !/^-?[0-9]+$/.test(e.key)) {
      fail(ctx, site, `key ${JSON.stringify(e.key)} is not an integer`);
    }
    assertMatchAt(
      type.value,
      e.value,
      ctx,
      `${site} value at key ${JSON.stringify(e.key)}`,
      opts,
    );
  }
}

function assertMatchArray(
  type: Extract<TypeExpr, { kind: "array" }>,
  value: JVal,
  ctx: string,
  site: string,
  opts: MatchOptions,
): void {
  if (value.kind !== "array") {
    fail(ctx, site, `expected Array, got ${valueTypeLabel(value)}`);
  }
  for (let i = 0; i < value.items.length; i++) {
    assertMatchAt(type.element, value.items[i]!, ctx, `${site} element[${i}]`, opts);
  }
}

function assertMatchVariant(
  type: Extract<TypeExpr, { kind: "variant" }>,
  value: JVal,
  opts: MatchOptions & { ctx: string },
): void {
  if (!opts.encoding) {
    throw new TypeAnnError(`${opts.ctx}: variant type requires encoding`);
  }
  if (value.kind !== "object") {
    throw new TypeAnnError(
      `${opts.ctx}: variant expects object, got ${valueTypeLabel(value)}`,
    );
  }
  const enc = opts.encoding;
  if (enc.kind === "tagField") {
    const tagEntry = value.entries.find((e) => e.key === enc.field);
    if (!tagEntry) {
      throw new TypeAnnError(
        `${opts.ctx}: missing tag field ${JSON.stringify(enc.field)}`,
      );
    }
    if (tagEntry.value.kind !== "string") {
      throw new TypeAnnError(
        `${opts.ctx}: tag field ${JSON.stringify(enc.field)} must be a string`,
      );
    }
    if (!(tagEntry.value.value in enc.tags)) {
      throw new TypeAnnError(
        `${opts.ctx}: unknown tag ${JSON.stringify(tagEntry.value.value)} for field ${JSON.stringify(enc.field)}`,
      );
    }
  } else {
    if (value.entries.length !== 1) {
      throw new TypeAnnError(
        `${opts.ctx}: exclusiveKey expects exactly one key, got ${value.entries.length}`,
      );
    }
    const k = value.entries[0]!.key;
    if (!(k in enc.keys)) {
      throw new TypeAnnError(
        `${opts.ctx}: unknown exclusive key ${JSON.stringify(k)}`,
      );
    }
  }

  const extracted = extractVariant(value, enc);
  if (!extracted) {
    throw new TypeAnnError(
      `${opts.ctx}: payload extraction failed for encoding ${enc.kind}`,
    );
  }
  const alt = type.alts.find((a) => a.tag === extracted.ctor);
  if (!alt) {
    throw new TypeAnnError(`${opts.ctx}: ctor @${extracted.ctor} not in type`);
  }
  if (alt.payload === null) {
    if (extracted.payload !== null) {
      throw new TypeAnnError(
        `${opts.ctx}: @${extracted.ctor} is nullary but payload present`,
      );
    }
    return;
  }
  if (extracted.payload === null) {
    // Empty rest → treat as empty object when the type expects Object.
    if (enc.kind === "tagField") {
      const spec = Object.values(enc.tags).find((t) => t.ctor === extracted.ctor);
      if (spec?.payload.from === "rest" && alt.payload.kind === "object") {
        assertMatches(
          alt.payload,
          { kind: "object", entries: [] },
          { ctx: `${opts.ctx} @${extracted.ctor} payload` },
        );
        return;
      }
    }
    throw new TypeAnnError(`${opts.ctx}: @${extracted.ctor} missing payload`);
  }
  assertMatches(alt.payload, extracted.payload, {
    ctx: `${opts.ctx} @${extracted.ctor} payload`,
  });
}

// ---------------------------------------------------------------------------
// Load + validate
// ---------------------------------------------------------------------------

const POSITION_FIELDS = new Set(["at", "type", "encoding"]);

/** Parse raw JSON into TypeAnnFile, rejecting any field this schema does not define. */
export function asTypeAnnFile(raw: unknown, fileLabel: string): TypeAnnFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeAnnError(`${fileLabel}: root must be an object`);
  }
  const o = raw as Record<string, unknown>;
  if (o["schemaVersion"] !== 1) {
    throw new TypeAnnError(`${fileLabel}: schemaVersion must be 1`);
  }
  if (typeof o["task"] !== "string" || o["task"].length === 0) {
    throw new TypeAnnError(`${fileLabel}: task must be a non-empty string`);
  }
  if (!Array.isArray(o["positions"])) {
    throw new TypeAnnError(`${fileLabel}: positions must be an array`);
  }
  const positions: TypePosition[] = o["positions"].map((pos, i) => {
    const ctx = `${fileLabel} positions[${i}]`;
    if (typeof pos !== "object" || pos === null || Array.isArray(pos)) {
      throw new TypeAnnError(`${ctx}: must be an object`);
    }
    const p = pos as Record<string, unknown>;
    if (typeof p["at"] !== "string") throw new TypeAnnError(`${ctx}: at required`);
    if (typeof p["type"] !== "string") throw new TypeAnnError(`${ctx}: type required`);
    // A field this code does not read is either a typo or an invention, and
    // silently dropping it would mean an annotation that does not say what its
    // author thinks it says.
    for (const key of Object.keys(p)) {
      if (!POSITION_FIELDS.has(key)) {
        throw new TypeAnnError(
          `${ctx}: unknown field ${JSON.stringify(key)} (expected ${[...POSITION_FIELDS].join(", ")})`,
        );
      }
    }
    const out: TypePosition = { at: p["at"], type: p["type"] };
    if (p["encoding"] !== undefined) {
      out.encoding = parseEncoding(p["encoding"], `${ctx}.encoding`);
    }
    return out;
  });
  return { schemaVersion: 1, task: o["task"], positions };
}

export function resolveAnnFile(file: TypeAnnFile, fileLabel: string): ResolvedTypeAnn {
  const positions: ResolvedPosition[] = file.positions.map((pos, i) => {
    const ctx = `${fileLabel} positions[${i}] (${pos.at})`;
    let segments: string[];
    try {
      segments = parsePath(pos.at);
    } catch (e) {
      if (e instanceof TypeAnnError) throw new TypeAnnError(`${ctx}: ${e.message}`);
      throw e;
    }
    let type: TypeExpr;
    try {
      type = parseTypeString(pos.type);
    } catch (e) {
      if (e instanceof TypeAnnError) throw new TypeAnnError(`${ctx}: ${e.message}`);
      throw e;
    }
    assertVariantPlacement(type, ctx);
    const root = rootForEncoding(type);
    const isVariant = root.kind === "variant";
    if (isVariant && !pos.encoding) {
      throw new TypeAnnError(`${ctx}: variant type requires encoding`);
    }
    if (!isVariant && pos.encoding) {
      throw new TypeAnnError(`${ctx}: encoding is only valid for variant types`);
    }
    if (pos.encoding) {
      crossCheckEncoding(type, pos.encoding, ctx);
    }
    return {
      at: pos.at,
      segments,
      typeString: pos.type,
      type,
      ...(pos.encoding ? { encoding: pos.encoding } : {}),
    };
  });
  checkPathOverlaps(positions);
  return { schemaVersion: 1, task: file.task, positions };
}

function validatePropertyAndArgs(task: Task, pos: ResolvedPosition, ctx: string): void {
  const propName = pos.segments[0]!;
  const prop = task.properties.find((p) => p.name === propName);
  if (!prop) {
    throw new TypeAnnError(`${ctx}: unknown property ${JSON.stringify(propName)}`);
  }
  if (pos.segments[1] === "arg") {
    const argName = pos.segments[2]!;
    if (!prop.argNames.includes(argName)) {
      // Still allow if some case uses it (ambiguous order tasks).
      const seen = task.cases.some(
        (c) => c.property === propName && c.args.some((a) => a.name === argName),
      );
      if (!seen) {
        throw new TypeAnnError(
          `${ctx}: unknown arg ${JSON.stringify(argName)} on property ${propName}`,
        );
      }
    }
  }
}

export function validateTypeAnnotations(task: Task, ann: ResolvedTypeAnn): void {
  if (ann.task !== task.id) {
    throw new TypeAnnError(
      `annotation task ${JSON.stringify(ann.task)} does not match corpus id ${JSON.stringify(task.id)}`,
    );
  }
  for (const pos of ann.positions) {
    const ctx = `${task.id} ${pos.at}`;
    validatePropertyAndArgs(task, pos, ctx);
    const hits = collectHits(task, pos.segments);
    if (hits.length === 0) {
      throw new TypeAnnError(`${ctx}: path resolved to zero hits (stale path?)`);
    }
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i]!;
      assertMatches(pos.type, hit, {
        ctx: `${ctx} hit[${i}]`,
        ...(pos.encoding ? { encoding: pos.encoding } : {}),
      });
    }
  }
}

export async function loadTypeAnnotations(
  taskId: string,
  typesDir: string = TYPE_ANNOTATIONS_DIR,
): Promise<TypeAnnFile | null> {
  const path = `${typesDir}/${taskId}.json`;
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  let raw: unknown;
  try {
    raw = await file.json();
  } catch (e) {
    throw new TypeAnnError(
      `${path}: invalid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const ann = asTypeAnnFile(raw, path);
  if (ann.task !== taskId) {
    throw new TypeAnnError(
      `${path}: task field ${JSON.stringify(ann.task)} !== filename stem ${JSON.stringify(taskId)}`,
    );
  }
  return ann;
}

/**
 * Shared production entry: load sidecar (or null), resolve, validate against
 * task. Callers must not invent their own load rules.
 */
export async function loadAndValidateAnnotations(
  task: Task,
  typesDir: string = TYPE_ANNOTATIONS_DIR,
): Promise<ResolvedTypeAnn | null> {
  const file = await loadTypeAnnotations(task.id, typesDir);
  if (!file) return null;
  const path = `${typesDir}/${task.id}.json`;
  const resolved = resolveAnnFile(file, path);
  validateTypeAnnotations(task, resolved);
  return resolved;
}

export type CheckTypesResult = {
  files: number;
  positions: number;
  errors: string[];
};

/** Walk every annotation file; validate against corpus tasks. */
export async function checkAllTypeAnnotations(
  corpusDir: string,
  typesDir: string = TYPE_ANNOTATIONS_DIR,
): Promise<CheckTypesResult> {
  const errors: string[] = [];
  let files = 0;
  let positions = 0;

  let names: string[];
  try {
    names = await readdir(typesDir);
  } catch {
    // No annotations directory yet — zero files is success.
    return { files: 0, positions: 0, errors: [] };
  }

  const jsonFiles = names.filter((n) => n.endsWith(".json")).sort();
  for (const name of jsonFiles) {
    if (name === "from-variance.json") continue; // proposals live elsewhere
    const stem = name.slice(0, -".json".length);
    const path = `${typesDir}/${name}`;
    files++;
    try {
      const raw = await Bun.file(path).json();
      const file = asTypeAnnFile(raw, path);
      if (file.task !== stem) {
        throw new TypeAnnError(
          `task field ${JSON.stringify(file.task)} !== filename stem ${JSON.stringify(stem)}`,
        );
      }
      const taskPath = `${corpusDir}/${stem}/task.json`;
      if (!(await Bun.file(taskPath).exists())) {
        throw new TypeAnnError(`no corpus task for ${JSON.stringify(stem)}`);
      }
      const task = (await Bun.file(taskPath).json()) as Task;
      const resolved = resolveAnnFile(file, path);
      positions += resolved.positions.length;
      validateTypeAnnotations(task, resolved);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return { files, positions, errors };
}
