/**
 * The local price table — the **shadow price**, not the bill.
 *
 * §3d said `cost_usd` must be computed here and never read back from the harness,
 * on the grounds that the free tier reports `cost: 0` however many tokens it
 * burned, so trusting the harness erases the cost axis where the data is
 * thickest. That reasoning still holds, but it answers a counterfactual — *what
 * would this run have cost at list price* — and measurement showed it cannot
 * answer the other question at all:
 *
 *   qwen3.7-max, one turn: 6 input tokens, 20 output, 8 870 cache-write. Billed
 *   $0.02788375. No input/output rate reproduces that; the charge is essentially
 *   all cache-write, a category this function did not price.
 *
 * So actual spend comes from the harness (`costUsd`) and this table produces
 * `shadowCostUsd`: what the same tokens cost **at that model's own list price**.
 * Cache writes are priced here now — omitting them made the shadow price wrong in
 * the same direction as the bill, just less visibly.
 *
 * What this deliberately does *not* do is rescue the free tier's cost axis. A free
 * model's list price is zero, so its shadow cost is zero too. The comparison §3d
 * actually wants — "what would this run have cost on a paid model" — is a
 * counterfactual *across* models, not within one, and it is an analysis-time
 * computation: price any arm's recorded token columns at a chosen reference
 * model's rates. That is why getting `cachedWriteTokens` into the record mattered
 * more than anything in this file; without the dominant token category, no such
 * counterfactual could be computed after the fact at all.
 *
 * A model with no entry records `null` and `"unknown"`. A fabricated 0 is
 * indistinguishable from a free model in the data.
 *
 * Rates are USD per million tokens. `cacheReadIn` defaults to `in` and
 * `cacheWriteIn` to `in` when a provider's cache rates are not known — both
 * overstate slightly, which is the safe direction.
 *
 * Override or extend without editing this file:
 *
 *   AVEN_BENCH_PRICES=/path/to/prices.json
 *
 * with the shape `{ "version": "...", "models": { "provider/model": {"in": 0.5,
 * "out": 1.5, "cacheReadIn": 0.05, "note": "..."} } }`. Entries merge over the
 * built-in table.
 */

import { readFileSync } from "node:fs";

export type PriceEntry = {
  /** USD per million prompt tokens. */
  in: number;
  /** USD per million completion tokens. */
  out: number;
  /** USD per million cache-read prompt tokens; defaults to `in`. */
  cacheReadIn?: number;
  /** USD per million cache-*write* tokens; defaults to `in`. Usually the largest term. */
  cacheWriteIn?: number;
  note?: string;
};

export type PriceTable = {
  version: string;
  models: Record<string, PriceEntry>;
};

/**
 * Built-in table.
 *
 * Only entries that can actually be verified locally are listed. The seven
 * `opencode/*` models are the free tier (`opencode models`, and every
 * `step_finish` event they emit reports `cost: 0`). `ollama/*` needs no entries at
 * all — see `isLocalModel`. Paid `opencode-go/*`
 * models are deliberately **absent**: their per-token rates are not published
 * anywhere this runner can read, and inventing numbers would poison the one axis
 * this table exists to protect. Add them by hand, with a dated note, when you
 * have a real invoice or a real price page.
 */
export const BUILTIN_PRICES: PriceTable = {
  version: "2026-07-25",
  models: {
    "opencode/big-pickle": { in: 0, out: 0, note: "opencode free tier" },
    "opencode/deepseek-v4-flash-free": { in: 0, out: 0, note: "opencode free tier" },
    "opencode/laguna-s-2.1-free": { in: 0, out: 0, note: "opencode free tier" },
    "opencode/ling-3.0-flash-free": { in: 0, out: 0, note: "opencode free tier" },
    "opencode/mimo-v2.5-free": { in: 0, out: 0, note: "opencode free tier" },
    "opencode/nemotron-3-ultra-free": { in: 0, out: 0, note: "opencode free tier" },
    "opencode/north-mini-code-free": { in: 0, out: 0, note: "opencode free tier" },
  },
};

/**
 * Locally-hosted models price at zero *by construction*, not by table entry.
 *
 * The rule against fabricating a 0 exists because a made-up zero is
 * indistinguishable from a genuinely free model. Local inference is the case where
 * zero is the true marginal token price — the cost is electricity and 24GB of RAM,
 * neither of which is denominated per token — so recording it is a fact rather than
 * a fabrication. Matching on the provider prefix instead of listing entries matters
 * because derived models multiply: `num_ctx` variants alone (`qwen3.6-32k`,
 * `qwen3.6-64k`, …) would each need a row, and a missed row would silently record
 * `unknown` for a model whose price is known exactly.
 *
 * The real cost of a local arm is wall clock, which `wallMs` already records.
 */
const LOCAL_PROVIDERS = ["ollama/"];
const LOCAL_FREE: PriceEntry = { in: 0, out: 0, note: "local inference; no marginal token price" };

export function isLocalModel(modelId: string): boolean {
  return LOCAL_PROVIDERS.some((p) => modelId.startsWith(p));
}

let cached: PriceTable | null = null;

/** Built-in table merged with `AVEN_BENCH_PRICES`, if set. Read once. */
export function priceTable(): PriceTable {
  if (cached) return cached;
  const path = process.env["AVEN_BENCH_PRICES"];
  if (!path) {
    cached = BUILTIN_PRICES;
    return cached;
  }
  const override = JSON.parse(readFileSync(path, "utf8")) as Partial<PriceTable>;
  cached = {
    version: `${BUILTIN_PRICES.version}+${override.version ?? "override"}`,
    models: { ...BUILTIN_PRICES.models, ...(override.models ?? {}) },
  };
  return cached;
}

export type ShadowCost = {
  shadowCostUsd: number | null;
  shadowPriceSource: "table" | "free" | "unknown";
  priceTableVersion: string;
};

export type TokenCounts = {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  cachedWriteTokens: number;
};

/**
 * List-price cost for a model's token usage.
 *
 * Each token category is charged at its own rate: opencode reports them
 * separately and `tokens.input` already excludes both cache figures, so summing
 * them here does not double-count.
 */
export function computeShadowCost(modelId: string, t: TokenCounts, table = priceTable()): ShadowCost {
  const entry = table.models[modelId] ?? (isLocalModel(modelId) ? LOCAL_FREE : undefined);
  if (!entry) {
    return { shadowCostUsd: null, shadowPriceSource: "unknown", priceTableVersion: table.version };
  }
  const readRate = entry.cacheReadIn ?? entry.in;
  const writeRate = entry.cacheWriteIn ?? entry.in;
  const cost =
    (t.promptTokens * entry.in +
      t.cachedPromptTokens * readRate +
      t.cachedWriteTokens * writeRate +
      t.completionTokens * entry.out) /
    1_000_000;
  const free = entry.in === 0 && entry.out === 0 && readRate === 0 && writeRate === 0;
  return {
    shadowCostUsd: cost,
    shadowPriceSource: free ? "free" : "table",
    priceTableVersion: table.version,
  };
}

/** Reset the memoized table. Tests only. */
export function resetPriceTableCache(): void {
  cached = null;
}
