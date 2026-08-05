# Billing audit — opencode-reported cost vs the real invoice

**Date:** 2026-08-06 **Trigger:** the logged cost for
`phase6-harness-opencode-01` did not match the opencode.ai web console.
**Method:** `analysis/opencode-billing.ts`, joining each run's `agentSessionRef`
against the workspace usage feed
(`analysis/opencode-usage-feed-2026-08-06.json`, 3,416 billed requests,
2026-08-03T23:13Z → 2026-08-05T19:49Z).

## Headline

| run                          | model        | logged  | invoiced      | understated |
| ---------------------------- | ------------ | ------- | ------------- | ----------- |
| `phase6-harness-opencode-01` | gpt-5.6-luna | $0.8460 | **$2.7999**   | **3.31×**   |
| `phase5-model-hy3-01`        | hy3          | $3.0225 | **$3.3496**   | 1.11×       |
| `phase5-model-mimo-01`       | mimo-v2.5    | $2.4875 | **$2.7000**   | 1.09×       |
| `phase5-model-qwen37p-01`    | qwen3.7-plus | $4.1563 | _not in feed_ | unknown     |

**The large error is Luna-specific.** Hy3 and MiMo are out by ~10%, which is the
event-capture residue alone. Only Luna carries the 2× multiplier that produced
the 3.31×.

## Why the join can be trusted

The reconciliation is self-checking. A harness row that failed to match a
billing session should be one that never reached a model, and on the Luna arm
that came out exactly: **14 unmatched rows, and exactly 14 `agent-no-tokens`
outcomes.** Hy3 and MiMo matched every row. The tool prints `INVESTIGATE` when
unmatched rows carry real outcomes — which is how the qwen gap below was caught
rather than silently averaged away.

## The three stacked faults

### 1. Luna's 2× usage multiplier (Luna only)

opencode's per-step `cost` uses the un-multiplied base rate. Against the price
card derived from the invoice, the ratio is **exactly 2.0000 in all 141
sessions** — min, median and max identical to four decimals. The opencode model
picker labels this "GPT 5.6 Luna (2x usage)"; nothing in the JSON event stream
carries it.

### 2. Fresh input is invoiced twice, and reported once

The provider meters fresh input under **both** `inputTokens` and
`cacheWrite5mTokens` (aggregate ratio 0.9988) and charges each. opencode
surfaces those same tokens only as `cache.write`, and reports `input` ≈ 0 —
2,079 tokens across 141 attempts. My first pass read that as the harness losing
input tokens; it is a representational difference, not a loss. `cacheWriteIn`
now folds both rates together at $0.45/M.

### 3. Reasoning tokens were never priced

`computeShadowCost` charged `completionTokens` only. On a reasoning model that
is most of the output charge — **489k reasoning against 194k completion** on
this arm, so the formula saw 28% of the output it paid for.

## Recovered price card — `opencode-go/gpt-5.6-luna`

Regressing 978 invoiced requests against their token columns fits **R² =
1.000000** with exactly round coefficients, which also pins the feed's cost unit
at 1e-8 USD. These are effective rates, post-multiplier:

| category                 | $/Mtok                         |
| ------------------------ | ------------------------------ |
| input                    | 0.20                           |
| output (incl. reasoning) | 1.20                           |
| cache read               | 0.02                           |
| cache write              | 0.45 (0.20 input + 0.25 write) |

## Residual gap, stated rather than absorbed

With the corrected card, the harness's _own_ token counts still only reach ~80%
of the invoice, because the adapter observes roughly 72–80% of cache token
events and 96.5% of output. That shortfall is real and unexplained. It is the
reason the price-table entry gets a run to "close", not "exact" — for exact
figures, use the feed join.

Per-category capture, matched sessions, Luna arm:

|                               | harness    | provider   | captured |
| ----------------------------- | ---------- | ---------- | -------- |
| output (completion+reasoning) | 682,635    | 707,475    | 96.5%    |
| cache read                    | 10,301,669 | 12,955,138 | 79.5%    |
| cache write                   | 2,665,405  | 3,724,373  | 71.6%    |

## Open: qwen3.7-plus is absent from the feed

`phase5-model-qwen37p-01` ran 2026-08-05T04:02Z → 08:52Z, inside the captured
range, yet **the feed contains a 430-minute hole from 01:31Z to 08:41Z** and not
a single `qwen3.7-plus` record anywhere. Its $4.1563 cannot be confirmed or
corrected from this source. Possibilities not yet distinguished: a different
billing key, plan-allowance consumption that the usage feed omits, or a feed
filter not visible in the captured request. **`results-model-03.md`'s cost
claims depend on this figure and should be treated as unverified until it is
resolved.**

## Effect on published results

- **`results-harness-01`** (unwritten): unaffected. Cost was never a DV — codex
  is subscription-billed and logs `costUsd: null`. The green-rate finding
  stands.
- **`results-model-02`** (MiMo vs DeepSeek): the MiMo arm was understated by
  8.5%. DeepSeek was free tier at a true $0. The direction and rough magnitude
  of the cost claim survive; the absolute figure should be restated as $2.70.
- **`results-model-03`** (Qwen vs DeepSeek): the "3.9× per green" claim rests on
  an unverifiable arm cost. Flag as provisional.
