/**
 * The local price table.
 *
 * §3d is explicit: `cost_usd` is **computed here, never read back from the
 * harness**. The highest-volume models in this benchmark are free and report
 * `cost: 0` regardless of how many tokens they burned, so trusting the harness
 * would erase the cost axis exactly where the data is thickest. Free models must
 * still carry token counts, which is why the free entries are real entries with
 * a rate of zero rather than an absence.
 *
 * A model with no entry records `costUsd: null` and `priceSource: "unknown"`.
 * That is deliberate: a fabricated 0 is indistinguishable from a free model in
 * the data, and would quietly understate every paid arm.
 *
 * Rates are USD per million tokens. `cacheReadIn` defaults to `in` when a
 * provider's cache discount is not known — that overstates cost slightly, which
 * is the safe direction.
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
  /** USD per million cached prompt tokens; defaults to `in`. */
  cacheReadIn?: number;
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
 * `step_finish` event they emit reports `cost: 0`); `ollama/*` is local compute,
 * charged at zero because there is no marginal token price. Paid `opencode-go/*`
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

export type Cost = {
  costUsd: number | null;
  priceSource: "table" | "free" | "unknown";
  priceTableVersion: string;
};

export type TokenCounts = {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
};

/**
 * Cost for a model's token usage.
 *
 * `promptTokens` is charged at the uncached rate and `cachedPromptTokens` at the
 * cache-read rate; harnesses report the two separately and opencode's
 * `tokens.input` already excludes `tokens.cache.read`.
 */
export function computeCost(modelId: string, t: TokenCounts, table = priceTable()): Cost {
  const entry = table.models[modelId];
  if (!entry) {
    return { costUsd: null, priceSource: "unknown", priceTableVersion: table.version };
  }
  const cacheRate = entry.cacheReadIn ?? entry.in;
  const cost =
    (t.promptTokens * entry.in + t.cachedPromptTokens * cacheRate + t.completionTokens * entry.out) /
    1_000_000;
  const free = entry.in === 0 && entry.out === 0 && cacheRate === 0;
  return {
    costUsd: cost,
    priceSource: free ? "free" : "table",
    priceTableVersion: table.version,
  };
}

/** Reset the memoized table. Tests only. */
export function resetPriceTableCache(): void {
  cached = null;
}
