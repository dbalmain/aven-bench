/**
 * The pseudocode expression language used by Exercism canonical data.
 *
 * Some canonical data passes a **function** as an argument by writing it as text
 * and leaving the conversion to each track's test generator. `accumulate` supplies
 * `"(x) => x * x"` and says so explicitly: "it's up to the test generator to turn
 * that string into a function declaration."
 *
 * There is nothing wrong with the oracle in these cases — the expected values are
 * all present upstream (`[1, 4, 9]`). The only thing missing is a way to render one
 * *input*. Emitting the text verbatim produced suites where every case died on
 * `'str' object is not callable`, and omitting them threw away the corpus's only
 * higher-order-function tasks, which for a language benchmark are among the more
 * interesting ones. So: parse it once, emit it per language.
 *
 * The whole corpus uses nine distinct expressions across two tasks, but they are
 * not trivial — one is `(x) => accumulate(["1", "2", "3"], (y) => x + y)`, a nested
 * lambda that closes over `x` and recursively calls the solution's own function.
 *
 * ## Semantics are upstream's, not the target language's
 *
 * The pseudocode is JavaScript-flavoured, and that is the contract a backend has to
 * meet or refuse. The sharp case is `/`. In `list-ops`,
 * `foldl((acc, el) -> el / acc, [1,2,3,4], 24)` expects **64**, which only comes
 * out under *float* division: `1/24 = 0.0417`, `2/0.0417 = 48`, `3/48 = 0.0625`,
 * `4/0.0625 = 64`. Integer division hits `2/0` on the second step. (foldr expects
 * 9, and checks the same way.)
 *
 * Python's `/` is float division, so it matches for free. Aven's `Int / Int` is
 * integer division — measured: `1 / 24` evaluates to `0`, and `2 / 0` is a runtime
 * error — so it cannot express these two cases over Int inputs at all. That is a
 * genuine finding about Aven's numeric tower rather than a defect here, and the
 * Aven backend refuses those cases with that reason instead of emitting something
 * that quietly computes a different function.
 *
 * ## Unknown constructs refuse, loudly
 *
 * Only the operators and calls the corpus actually uses are supported. Anything
 * else throws. The two error directions are not symmetric: silently
 * mis-translating an expression fabricates an oracle that looks fine and tests the
 * wrong thing, whereas refusing shows up as an omitted case with a reason. When a
 * future corpus adds a form, it should fail visibly.
 */

export type Expr =
  | { kind: "lambda"; params: string[]; body: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr }
  | { kind: "call"; callee: string; args: Expr[] }
  | { kind: "var"; name: string }
  | { kind: "int"; value: string }
  | { kind: "text"; value: string }
  | { kind: "array"; items: Expr[] };

export type BinaryOp = "+" | "-" | "*" | "/" | "modulo" | "==";

export class PseudocodeError extends Error {}

// --- lexer -----------------------------------------------------------------

type Token =
  | { t: "ident"; v: string }
  | { t: "int"; v: string }
  | { t: "text"; v: string }
  | { t: "op"; v: string };

const PUNCT = ["=>", "->", "==", "(", ")", "[", "]", ",", "+", "-", "*", "/"] as const;

function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      // Canonical data uses JSON strings, so JSON's escapes are the right set.
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") {
          const esc = src[j + 1];
          if (esc === undefined) throw new PseudocodeError("unterminated escape in string literal");
          value += JSON.parse(`"\\${esc}"`) as string;
          j += 2;
        } else {
          value += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new PseudocodeError("unterminated string literal");
      out.push({ t: "text", v: value });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      // A decimal point would silently become a different number in a language
      // whose `/` differs; refuse rather than guess.
      if (src[j] === ".") throw new PseudocodeError(`non-integer literal in pseudocode: ${src.slice(i)}`);
      out.push({ t: "int", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      out.push({ t: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const punct = PUNCT.find((p) => src.startsWith(p, i));
    if (!punct) throw new PseudocodeError(`unexpected character '${ch}' in pseudocode`);
    out.push({ t: "op", v: punct });
    i += punct.length;
  }
  return out;
}

// --- parser ----------------------------------------------------------------

/**
 * Recursive descent. Precedence, loosest first: `==`, then `+`/`-`, then
 * `*`/`/`/`modulo`. `modulo` is a word rather than a symbol upstream
 * (`x modulo 2 == 1`), which is why it is lexed as an identifier and promoted to
 * an operator here.
 */
class Parser {
  private pos = 0;

  constructor(private readonly toks: Token[]) {}

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }

  private eatOp(v: string): boolean {
    const t = this.peek();
    if (t?.t === "op" && t.v === v) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectOp(v: string): void {
    if (!this.eatOp(v)) throw new PseudocodeError(`expected '${v}' in pseudocode`);
  }

  private isWordOp(word: string): boolean {
    const t = this.peek();
    return t?.t === "ident" && t.v === word;
  }

  parseProgram(): Expr {
    const e = this.parseExpr();
    if (this.pos !== this.toks.length) throw new PseudocodeError("trailing tokens in pseudocode");
    return e;
  }

  /** A lambda is only recognised where one can start, so `(a + b)` stays grouping. */
  private parseExpr(): Expr {
    const lambda = this.tryParseLambda();
    return lambda ?? this.parseEquality();
  }

  private tryParseLambda(): Expr | null {
    const start = this.pos;
    if (!this.eatOp("(")) return null;
    const params: string[] = [];
    if (!this.eatOp(")")) {
      for (;;) {
        const t = this.peek();
        if (t?.t !== "ident") {
          this.pos = start;
          return null;
        }
        params.push(t.v);
        this.pos++;
        if (this.eatOp(",")) continue;
        if (this.eatOp(")")) break;
        this.pos = start;
        return null;
      }
    }
    if (!this.eatOp("=>") && !this.eatOp("->")) {
      this.pos = start;
      return null;
    }
    return { kind: "lambda", params, body: this.parseExpr() };
  }

  private parseEquality(): Expr {
    let left = this.parseAdditive();
    while (this.eatOp("==")) {
      left = { kind: "binary", op: "==", left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      if (this.eatOp("+")) left = { kind: "binary", op: "+", left, right: this.parseMultiplicative() };
      else if (this.eatOp("-")) left = { kind: "binary", op: "-", left, right: this.parseMultiplicative() };
      else return left;
    }
  }

  private parseMultiplicative(): Expr {
    let left = this.parsePrimary();
    for (;;) {
      if (this.eatOp("*")) left = { kind: "binary", op: "*", left, right: this.parsePrimary() };
      else if (this.eatOp("/")) left = { kind: "binary", op: "/", left, right: this.parsePrimary() };
      else if (this.isWordOp("modulo")) {
        this.pos++;
        left = { kind: "binary", op: "modulo", left, right: this.parsePrimary() };
      } else return left;
    }
  }

  private parsePrimary(): Expr {
    const lambda = this.tryParseLambda();
    if (lambda) return lambda;
    const t = this.peek();
    if (t === undefined) throw new PseudocodeError("unexpected end of pseudocode");
    if (t.t === "int") {
      this.pos++;
      return { kind: "int", value: t.v };
    }
    if (t.t === "text") {
      this.pos++;
      return { kind: "text", value: t.v };
    }
    if (t.t === "ident") {
      this.pos++;
      if (this.eatOp("(")) {
        const args: Expr[] = [];
        if (!this.eatOp(")")) {
          for (;;) {
            args.push(this.parseExpr());
            if (this.eatOp(",")) continue;
            this.expectOp(")");
            break;
          }
        }
        return { kind: "call", callee: t.v, args };
      }
      return { kind: "var", name: t.v };
    }
    if (t.t === "op" && t.v === "[") {
      this.pos++;
      const items: Expr[] = [];
      if (!this.eatOp("]")) {
        for (;;) {
          items.push(this.parseExpr());
          if (this.eatOp(",")) continue;
          this.expectOp("]");
          break;
        }
      }
      return { kind: "array", items };
    }
    if (t.t === "op" && t.v === "(") {
      this.pos++;
      const inner = this.parseExpr();
      this.expectOp(")");
      return inner;
    }
    throw new PseudocodeError(`unexpected token '${t.v}' in pseudocode`);
  }
}

export function parsePseudocode(src: string): Expr {
  return new Parser(lex(src)).parseProgram();
}

/** Does this string look like a pseudocode function rather than data? */
export function isPseudocodeFunction(value: string): boolean {
  // A parenthesized parameter list followed by an arrow. Requiring the parens
  // keeps ordinary data such as a graph edge `"a -> b"` from matching, and a
  // false positive here silently deletes a real case.
  if (!/^\s*\(\s*(?:[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)?\s*\)\s*(?:=>|->)/.test(value)) return false;
  try {
    return parsePseudocode(value).kind === "lambda";
  } catch {
    // Looks like a lambda but does not parse: still a function, still not data.
    // Reported as unsupported by the emitter rather than treated as a string.
    return true;
  }
}

// --- emitters --------------------------------------------------------------

export type EmitTarget = {
  /** `params` and a rendered body → a lambda in the target language. */
  lambda(params: string[], body: string): string;
  /** Binary operator applied to rendered operands. Throw to refuse. */
  binary(op: BinaryOp, left: string, right: string): string;
  /** A pseudocode builtin (`upcase`, `reverse`) on a rendered argument. */
  builtin(name: string, args: string[]): string;
  /** A call to one of the task's own properties. */
  solutionCall(property: string, args: string[]): string;
  int(value: string): string;
  text(value: string): string;
  array(items: string[]): string;
};

/** Pseudocode's own helpers, distinct from any task's properties. */
const BUILTINS = new Set(["upcase", "downcase", "reverse"]);

/**
 * Render an expression for a target.
 *
 * `properties` are the task's own property names, and they win over `BUILTINS`.
 * That ordering matters: `list-ops` has a `reverse` property of its own, and a
 * `reverse(x)` inside its pseudocode would mean the solution's function, not
 * text reversal. Resolving the task's own names first makes shadowing correct
 * rather than accidental.
 */
export function emit(e: Expr, target: EmitTarget, properties: ReadonlySet<string>): string {
  switch (e.kind) {
    case "lambda":
      return target.lambda(e.params, emit(e.body, target, properties));
    case "binary":
      return target.binary(e.op, emit(e.left, target, properties), emit(e.right, target, properties));
    case "var":
      return e.name;
    case "int":
      return target.int(e.value);
    case "text":
      return target.text(e.value);
    case "array":
      return target.array(e.items.map((i) => emit(i, target, properties)));
    case "call": {
      const args = e.args.map((a) => emit(a, target, properties));
      if (properties.has(e.callee)) return target.solutionCall(e.callee, args);
      if (BUILTINS.has(e.callee)) return target.builtin(e.callee, args);
      throw new PseudocodeError(
        `pseudocode calls '${e.callee}', which is neither a property of this task` +
          " nor a known pseudocode builtin",
      );
    }
  }
}

/** Parse and emit in one step, for adapters. */
export function renderPseudocode(
  src: string,
  target: EmitTarget,
  properties: ReadonlySet<string>,
): string {
  return emit(parsePseudocode(src), target, properties);
}
