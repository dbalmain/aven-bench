# What drives benchmark cost

Written 2026-08-05 over every paid Aven attempt on disk: **961 attempts, $18.87,
75 tasks, 4 models** (`deepseek-v4-flash`, `mimo-v2.5`, `minimax-m2.7`, `hy3`).
Free-tier rows are excluded — they report `cost: 0` however many tokens they
burn, so they carry no cost signal. The `hy3` arm was mid-sweep, so its per-task
coverage is partial (32–37 shared tasks rather than 71).

## The one-line answer

**Cost is failure.** 25% of attempts consume 57% of spend.

| outcome         |   n | total | mean per attempt |
| --------------- | --: | ----: | ---------------: |
| `pass`          | 721 | $8.12 |      **$0.0113** |
| `check_error`   |  94 | $3.91 |          $0.0416 |
| `parse_error`   |  25 | $2.15 |      **$0.0861** |
| `timeout`       |  33 | $2.01 |          $0.0611 |
| `runtime_error` |  34 | $1.44 |          $0.0423 |
| `wrong_output`  |  29 | $1.01 |          $0.0347 |
| `refusal`       |  24 | $0.16 |          $0.0066 |

A failing attempt costs 3–8× a passing one, because it burns every repair round.
**`parse_error` is the most expensive outcome per attempt at 7.6× a pass**: the
model never reaches a parseable program, so every round is spent guessing.

## Expensive tasks are a property of the corpus, not of the model

Spearman rank correlation of per-task mean cost, between model pairs:

| pair                                 |   rho | shared tasks |
| ------------------------------------ | ----: | -----------: |
| `deepseek-v4-flash` × `hy3`          | 0.884 |           34 |
| `mimo-v2.5` × `deepseek-v4-flash`    | 0.822 |           71 |
| `minimax-m2.7` × `mimo-v2.5`         | 0.698 |           68 |
| `mimo-v2.5` × `hy3`                  | 0.643 |           37 |
| `minimax-m2.7` × `deepseek-v4-flash` | 0.596 |           69 |
| `minimax-m2.7` × `hy3`               | 0.518 |           32 |

All strongly positive. The same tasks are expensive for every model, so the cost
ranking is a stable feature of the task set and can be used for planning.

## Top drivers, and the concentration

| task              |  total | share |   n |  $/att | pass | min/att |
| ----------------- | -----: | ----: | --: | -----: | ---: | ------: |
| `zipper`          | $0.815 |  4.3% |  12 | 0.0679 |   8% |    25.5 |
| `prism`           | $0.813 |  4.3% |  13 | 0.0625 |  46% |    25.1 |
| `react`           | $0.805 |  4.3% |  12 | 0.0671 |  17% |    26.2 |
| `complex-numbers` | $0.761 |  4.0% |  14 | 0.0544 |  14% |    21.2 |
| `rest-api`        | $0.692 |  3.7% |  13 | 0.0533 |   8% |    22.0 |
| `alphametics`     | $0.637 |  3.4% |  14 | 0.0455 |   0% |    22.3 |
| `camicia`         | $0.625 |  3.3% |  14 | 0.0446 |  21% |    19.0 |
| `pov`             | $0.624 |  3.3% |  12 | 0.0520 |  42% |    22.2 |

- 25% of spend from the top **7** tasks (9% of the corpus)
- 50% of spend from the top **15** tasks (20%)
- 80% of spend from the top **31** tasks (41%)

## Do NOT trim the expensive tasks

The obvious move — drop the top cost drivers — is wrong, because expense and
discrimination are the same thing here. A task only tells you anything about a
model if its outcome _varies_, and outcomes vary precisely where models
struggle.

Splitting the corpus by whether it discriminates at all:

| bucket                             | tasks |  spend | share |
| ---------------------------------- | ----: | -----: | ----: |
| outcomes vary (**discriminating**) |    62 | $17.39 | 92.1% |
| always passed by every model       |    12 |  $0.84 |  4.5% |
| never passed by any model          |     1 |  $0.64 |  3.4% |

**92% of spend buys signal.** There is no meaningful cost saving available by
trimming tasks. This is a good property of the corpus, not a problem to fix.

The single exception is **`alphametics`**: 0/14 across four models, $0.64, 22
minutes per attempt. It is currently pure cost with zero discrimination. It is
_not_ a drop candidate yet — a task nobody passes may become discriminating once
the compiler improves, and dropping it would bake today's limitations into the
corpus. Re-check it after the current diagnostics work lands; if it still never
passes, then consider it.

## Where the cost lever actually is

Not in the task list — in the failure rate. Two consequences:

1. **A better model is a cheaper model.** Per-attempt cost is nearly flat across
   models (round 1: DeepSeek $0.0161 vs MiMo $0.0164, within 2%), so the entire
   cost difference is the pass rate. DeepSeek cost $0.0200 per _working_
   solution against MiMo's $0.0280 — 1.40× — purely by failing less.

2. **Fixing diagnostics is a cost reduction, not only a quality one.**
   `parse_error` is the priciest failure mode at $0.0861/attempt, and the most
   common parse diagnostic (`parse.unsupported-syntax`, 23.9% of round-0
   attempts for the weaker model) currently offers no repair at all. An attempt
   that cannot find its way to parseable syntax spends the full round budget.
   That is the target of task #43.

## Budget rule of thumb

For planning a 142-attempt arm (71 holdout tasks × 2 samples), at observed
rates:

```
cost ≈ 142 × [ passRate × $0.011  +  (1 − passRate) × $0.048 ]
```

which gives ~$2.30 at an 80% pass rate and ~$3.50 at 50%. **Do not price an arm
off a small probe's mean** — a 3-task probe rarely contains a representative
failure, and both probes run so far underestimated: MiMo's by understating, and
hy3's by 2.4× ($0.0079 probe vs $0.0193 measured).
