/**
 * Token estimation for text the harness does not count for us.
 *
 * `promptTokens` / `completionTokens` come from the harness, which knows the
 * real tokenizer. `solutionTokens` and `docTokens` do not: nobody tokenizes the
 * solution file on its own, and the size metric in §3d is supposed to be
 * comparable *across models*, so a model-specific tokenizer would be the wrong
 * instrument even if we had one.
 *
 * So: one deterministic heuristic, recorded under `tokenEstimator` so a later
 * change is detectable rather than silently mixed into old rows. Zero deps is a
 * project constraint; a BPE table is not zero deps.
 *
 * The rule: split into identifier runs, number runs, and single other
 * characters, then charge one token per ~4 characters of a long identifier
 * (which is roughly how BPE handles `camelCaseIdentifiers`). Whitespace is free
 * except that a newline costs one.
 */

const CHARS_PER_SUBWORD = 4;

export function approxTokens(text: string): number {
  let total = 0;
  for (const m of text.matchAll(/[A-Za-z_]+|[0-9]+(?:\.[0-9]+)?|\n|[^\sA-Za-z0-9_]/g)) {
    const tok = m[0];
    if (tok.length <= CHARS_PER_SUBWORD) total += 1;
    else total += Math.ceil(tok.length / CHARS_PER_SUBWORD);
  }
  return total;
}

/** Non-blank, non-comment-only lines. `#` for Aven, `#` for Python — same char. */
export function countLoc(text: string, commentPrefix = "#"): number {
  let n = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (commentPrefix !== "" && line.startsWith(commentPrefix)) continue;
    n++;
  }
  return n;
}
