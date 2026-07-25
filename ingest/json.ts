/**
 * A tiny order- and precision-preserving JSON reader.
 *
 * Why not `JSON.parse`? Two properties of the canonical data are load-bearing
 * and `JSON.parse` destroys both:
 *
 *  1. **Number text.** `1.0` and `1` are the same JS number but different Aven
 *     values (`Float` vs `Int`), and `18446744073709551615` (grains) does not
 *     survive a double at all. We keep the raw literal text and let each
 *     language adapter decide what to do with it.
 *  2. **Key order.** `input` is a JSON *object*, so the only signal for
 *     positional argument order is key insertion order. `JSON.parse` happens to
 *     preserve that for non-integer-like keys, but silently reorders
 *     integer-like ones. An explicit entry list removes the footgun.
 */

export type JVal =
  | { kind: "null" }
  | { kind: "bool"; value: boolean }
  | { kind: "number"; raw: string }
  | { kind: "string"; value: string }
  | { kind: "array"; items: JVal[] }
  | { kind: "object"; entries: JEntry[] };

export type JEntry = { key: string; value: JVal };

class Scanner {
  private i = 0;
  constructor(private readonly src: string) {}

  parse(): JVal {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.i !== this.src.length) this.die("trailing content");
    return v;
  }

  private die(msg: string): never {
    const line = this.src.slice(0, this.i).split("\n").length;
    throw new Error(`JSON: ${msg} at offset ${this.i} (line ${line})`);
  }

  private ws(): void {
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else break;
    }
  }

  private lit(text: string): boolean {
    if (this.src.startsWith(text, this.i)) {
      this.i += text.length;
      return true;
    }
    return false;
  }

  private value(): JVal {
    const c = this.src[this.i];
    if (c === undefined) this.die("unexpected end of input");
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"') return { kind: "string", value: this.string() };
    if (this.lit("true")) return { kind: "bool", value: true };
    if (this.lit("false")) return { kind: "bool", value: false };
    if (this.lit("null")) return { kind: "null" };
    return this.number();
  }

  private object(): JVal {
    this.i++; // {
    const entries: JEntry[] = [];
    this.ws();
    if (this.src[this.i] === "}") {
      this.i++;
      return { kind: "object", entries };
    }
    for (;;) {
      this.ws();
      if (this.src[this.i] !== '"') this.die("expected object key");
      const key = this.string();
      this.ws();
      if (this.src[this.i] !== ":") this.die("expected ':'");
      this.i++;
      this.ws();
      entries.push({ key, value: this.value() });
      this.ws();
      const c = this.src[this.i];
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "}") {
        this.i++;
        return { kind: "object", entries };
      }
      this.die("expected ',' or '}'");
    }
  }

  private array(): JVal {
    this.i++; // [
    const items: JVal[] = [];
    this.ws();
    if (this.src[this.i] === "]") {
      this.i++;
      return { kind: "array", items };
    }
    for (;;) {
      this.ws();
      items.push(this.value());
      this.ws();
      const c = this.src[this.i];
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "]") {
        this.i++;
        return { kind: "array", items };
      }
      this.die("expected ',' or ']'");
    }
  }

  private string(): string {
    this.i++; // opening quote
    let out = "";
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) this.die("unterminated string");
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c !== "\\") {
        out += c;
        this.i++;
        continue;
      }
      this.i++;
      const e = this.src[this.i];
      this.i++;
      switch (e) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = this.src.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.die("bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
          break;
        }
        default:
          this.die(`bad escape \\${e ?? "<eof>"}`);
      }
    }
  }

  private number(): JVal {
    const start = this.i;
    if (this.src[this.i] === "-") this.i++;
    while (/[0-9]/.test(this.src[this.i] ?? "")) this.i++;
    if (this.src[this.i] === ".") {
      this.i++;
      while (/[0-9]/.test(this.src[this.i] ?? "")) this.i++;
    }
    const e = this.src[this.i];
    if (e === "e" || e === "E") {
      this.i++;
      const sign = this.src[this.i];
      if (sign === "+" || sign === "-") this.i++;
      while (/[0-9]/.test(this.src[this.i] ?? "")) this.i++;
    }
    const raw = this.src.slice(start, this.i);
    if (raw === "" || raw === "-") this.die("expected a value");
    return { kind: "number", raw };
  }
}

export function parseJson(src: string): JVal {
  return new Scanner(src).parse();
}

/** Is this number literal an integer (no fraction, no exponent, no `.0`)? */
export function isIntegerLiteral(raw: string): boolean {
  return /^-?[0-9]+$/.test(raw);
}

/** Does the literal fit in a signed 64-bit integer? */
export function fitsI64(raw: string): boolean {
  if (!isIntegerLiteral(raw)) return false;
  try {
    const v = BigInt(raw);
    return v >= -(2n ** 63n) && v <= 2n ** 63n - 1n;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Portable encoding, for the committed corpus/*.json files.
//
// Plain JSON where plain JSON is lossless; explicitly tagged where it is not:
//   { "$n": "1.0" }                 a number whose text must survive verbatim
//   { "$o": [["k", v], ...] }       an object whose key order must survive
// ---------------------------------------------------------------------------

export type Portable = unknown;

const RESERVED_KEYS = new Set(["$n", "$o"]);

function keyIsOrderSafe(key: string): boolean {
  // V8 hoists integer-like keys to the front of an object in ascending order.
  if (/^(0|[1-9][0-9]*)$/.test(key)) return false;
  return !RESERVED_KEYS.has(key);
}

export function toPortable(v: JVal): Portable {
  switch (v.kind) {
    case "null":
      return null;
    case "bool":
      return v.value;
    case "string":
      return v.value;
    case "number":
      // Round-trips through a JS double unchanged? Then plain JSON is lossless.
      return String(Number(v.raw)) === v.raw ? Number(v.raw) : { $n: v.raw };
    case "array":
      return v.items.map(toPortable);
    case "object": {
      const safe = v.entries.every((e) => keyIsOrderSafe(e.key));
      if (safe) {
        const out: Record<string, Portable> = {};
        for (const e of v.entries) out[e.key] = toPortable(e.value);
        return out;
      }
      return { $o: v.entries.map((e) => [e.key, toPortable(e.value)]) };
    }
  }
}

export function fromPortable(p: Portable): JVal {
  if (p === null) return { kind: "null" };
  if (typeof p === "boolean") return { kind: "bool", value: p };
  if (typeof p === "string") return { kind: "string", value: p };
  if (typeof p === "number") return { kind: "number", raw: String(p) };
  if (Array.isArray(p)) return { kind: "array", items: p.map(fromPortable) };
  if (typeof p === "object") {
    const o = p as Record<string, unknown>;
    if (typeof o["$n"] === "string") return { kind: "number", raw: o["$n"] };
    if (Array.isArray(o["$o"])) {
      const entries = (o["$o"] as [string, Portable][]).map(([key, value]) => ({
        key,
        value: fromPortable(value),
      }));
      return { kind: "object", entries };
    }
    return {
      kind: "object",
      entries: Object.entries(o).map(([key, value]) => ({
        key,
        value: fromPortable(value),
      })),
    };
  }
  throw new Error(`fromPortable: unsupported ${typeof p}`);
}

/** A coarse structural fingerprint, used for coverage reporting. */
export function valueKinds(v: JVal, into: Set<string> = new Set()): Set<string> {
  switch (v.kind) {
    case "null":
      into.add("null");
      break;
    case "bool":
      into.add("bool");
      break;
    case "string":
      into.add("string");
      break;
    case "number":
      if (!isIntegerLiteral(v.raw)) into.add("float");
      else if (!fitsI64(v.raw)) into.add("bigint");
      else into.add("int");
      break;
    case "array":
      into.add("array");
      if (v.items.some((i) => i.kind === "array")) into.add("nested-array");
      if (v.items.some((i) => i.kind === "object")) into.add("array-of-record");
      for (const i of v.items) valueKinds(i, into);
      break;
    case "object":
      into.add("record");
      if (v.entries.length === 0) into.add("empty-record");
      for (const e of v.entries) valueKinds(e.value, into);
      break;
  }
  return into;
}
