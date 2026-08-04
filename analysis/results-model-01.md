# Results — model A/B (`model-01`)

Pre-registration: `analysis/prereg-model-01.md` (committed `03d29ee`, before any
arm-B row existed; Amendment 1 `bd8b86c`, after the price probe and still before
any arm-B row existed).

Arms:

| Arm | Model                           | Run                      | Samples |
| --- | ------------------------------- | ------------------------ | ------- |
| A   | `opencode-go/deepseek-v4-flash` | `phase4-diagfmt-text-01` | 3       |
| B   | `opencode-go/mimo-v2.5`         | `phase5-model-mimo-01`   | 2       |

Reproduce with:

```sh
bun run analysis/model-ab.ts --arm-b phase5-model-mimo-01 --model opencode-go/mimo-v2.5
```

## Headline

**DeepSeek V4 Flash beats MiMo-V2.5 decisively, on every measure, at n = 71
paired tasks.**

|                        | arm A (DeepSeek) | arm B (MiMo) | diff         | p        |
| ---------------------- | ---------------- | ------------ | ------------ | -------- |
| green rate (primary)   | **85.9%**        | 62.7%        | **−23.2 pp** | < 0.0001 |
| censored repair rounds | **1.127**        | 2.063        | +0.937       | < 0.0001 |
| first-shot pass        | **49.8%**        | 26.8%        | −23.0 pp     | < 0.0001 |

The primary effect is **23 percentage points against a pre-registered 10-point
bar** — more than twice the smallest difference declared worth acting on. The
secondary DV agrees at three times its own 0.3-round bar. Verdict on both:
`arm-a-better`.

This is not a marginal call, and no reading of it favours MiMo.

## All 71 tasks paired — the Amendment 1 risk did not materialise

Amendment 1 warned that at n = 2 a single `harness_error` would drop a task
below `MIN_SAMPLES` and out of the analysis entirely, where at n = 3 it would
have survived. **Zero tasks were dropped.**

The preregistered retry pass is why. Arm B's main sweep produced 10
`harness_error` rows (9 of them `agent-no-tokens` — the provider returning
nothing, not the model failing). The retry recovered every one as a real
observation: 5 came back green, 4 came back as genuine task failures (`react`,
`prism`, `rectangles`, `camicia` — each burning the full round limit), and the
dedup rule kept the retried row. Arm B therefore carries **0 harness-error
exclusions**; arm A carries 4 that its own retry pass never recovered.

So the amendment's stated cost was real but was absorbed by a procedure fixed in
advance, which is the outcome that procedure existed for.

## The confound, and why it does not rescue MiMo

The arms were **not run concurrently** (prereg, Threats to validity #1): arm A
ran 2026-08-02 alongside the `agent` arm, arm B ran 2026-08-04–05 alone.
Provider load and time-of-day are confounded with the arm, and that was written
down before any result was seen.

It does not explain this result, for two reasons:

1. **It points the wrong way.** If provider conditions favoured either arm, they
   favoured _arm A_: arm B hit more provider trouble (10 harness errors before
   retry, against 4 unrecovered in arm A). Yet arm B still lost by 23 points.
2. **Provider load does not select correct programs.** The gap is in
   `firstShotPass` and green rate — whether the model wrote a working Aven
   solution — not in latency or availability. Load would surface as `timeout`
   and `harness_error`, which are excluded from the denominator by the
   pre-registration.

A confound that runs opposite to the observed effect makes the effect a
conservative estimate, not a suspect one.

## Cost: MiMo is worse _and_ dearer per unit of success

|                       | arm A        | arm B        |
| --------------------- | ------------ | ------------ |
| spend                 | $3.6255      | $2.4875      |
| rows written          | 226          | 152          |
| usable after dedup    | 209          | 142          |
| green attempts        | 181 (86.6%)  | 89 (62.7%)   |
| per attempt written   | $0.01604     | $0.01637     |
| per usable attempt    | $0.01735     | $0.01752     |
| **per green attempt** | **$0.02003** | **$0.02795** |

Per-attempt cost is within 2% between the arms, so essentially the entire cost
penalty is the failure rate: **MiMo costs 1.40× as much per working solution**,
purely because fewer attempts work. Failures are the expensive outcome. The
price probe measured this directly — its one failing task cost $0.068 against
$0.006 and $0.015 for the two that passed, and ran 1483s against 125s and 328s.

The earlier `minimax-m2.7` reading (2.5× DeepSeek's per-row cost) was the same
phenomenon, not an intrinsically dearer token price.

## Scope — what this does NOT say

- **Nothing about this session's diagnostics work.** Both arms are pinned to
  aven-lang `8ca8620`, four commits behind the fixes landed 2026-08-04
  (`0cef006`, `9200f36`, `bcc9f99`, `1b2fc52`). Pinning is the correct control
  for a _model_ comparison — the compiler must not move between arms — and it
  means the repair-round numbers here reflect the **pre-fix** diagnostics.
  `prism`, the task behind finding #40, failed both retry attempts here under
  the old wording; that is an anecdote, not evidence, and this run cannot be
  used to argue either way.
- **Nothing about Aven versus other languages.** Single language arm.
- **Nothing about MiMo outside this corpus.** Exercism-derived tasks are a lower
  bound on real work.
- **No negative control exists in this design** (prereg): the model differs from
  round 0, so `firstShotPass` is a real effect rather than a leak check. Unlike
  `diagfmt-01`, there is no internal validity check available here.

## What to do with it

Spend Aven sweep budget on **DeepSeek V4 Flash**, not MiMo-V2.5. MiMo is worse
on documentation-following (`firstShotPass`), worse on diagnostic-following
(`roundsToGreen`), worse on final success, and more expensive per success.

Round 2 (`opencode-go/hy3`) is probe-gated against the same arm A and reuses
this analysis unchanged.
