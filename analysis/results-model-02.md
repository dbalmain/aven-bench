# Results — model A/B (`model-01` round 2, Hy3)

Pre-registration: `analysis/prereg-model-01.md` — Amendment 2 (`d628c91`) fixed
the round-2 design before any arm-B row existed; Amendments 3 (`cd64f7e`) and 4
(`c027dd9`) raised the spend cap mid-sweep and are argued there.

Arms:

| Arm | Model                           | Run                      | Samples |
| --- | ------------------------------- | ------------------------ | ------- |
| A   | `opencode-go/deepseek-v4-flash` | `phase4-diagfmt-text-01` | 3       |
| B   | `opencode-go/hy3`               | `phase5-model-hy3-01`    | 2       |

Reproduce with:

```sh
bun run analysis/model-ab.ts --arm-b phase5-model-hy3-01 --model opencode-go/hy3
```

## Headline

**DeepSeek V4 Flash beats Hy3 on repair effort decisively. On green rate the
difference is real but lands 0.1 pp under the pre-registered bar.**

|                        | arm A (DeepSeek) | arm B (Hy3) | diff     |      p | verdict            |
| ---------------------- | ---------------- | ----------- | -------- | -----: | ------------------ |
| green rate (primary)   | **85.9%**        | 76.1%       | −9.9 pp  | 0.0088 | `below-effect-bar` |
| censored repair rounds | **1.127**        | 1.676       | +0.549   | 0.0000 | `arm-a-better`     |
| first-shot pass        | **49.8%**        | 30.3%       | −19.5 pp | 0.0003 | descriptive only   |

### The primary DV is a knife-edge, and the rule decides it

The green-rate gap is **9.9 pp against a 10.0 pp bar**. It is statistically
significant (p = 0.0088, so the difference is very unlikely to be noise) and it
still returns `below-effect-bar`, because the bar does not ask whether a
difference exists — it asks whether the difference is large enough to act on,
and 10 pp was declared as that threshold before any data was collected.

This is the case pre-registration exists for. With the result in hand it is easy
to argue the bar should have been 9.5, or to quote the p-value and call it a win
for DeepSeek. Both would be choosing the rule after seeing the number. The
verdict stands as `below-effect-bar`, and the honest one-line reading is: **on
green rate alone, DeepSeek is better than Hy3 by an amount just under what we
said in advance would matter.**

The secondary DV carries no such ambiguity: 0.549 rounds against a 0.3-round
bar, at p < 0.0001. Hy3 needs materially more repair rounds to reach green.
Taken together the two DVs point the same way, and only the primary is close.

## All 71 tasks paired — one harness error, recovered

Arm B's sweep produced exactly **one** `harness_error` (`go-counting`, sample 1)
— the cleanest arm the campaign has run, against MiMo's 10 and arm A's 4. The
preregistered retry pass recovered it as a real observation (`parse_error`,
$0.0269), the dedup rule kept the retried row, and **zero tasks were dropped**.
All 71 tasks carry 2 usable samples.

Worth noting because Amendment 1's whole argument was that at n = 2 a single
provider fault silently removes a task from the comparison. Here it would have
cost exactly one task; the procedure cost $0.03 and removed the question.

Arm A still carries 4 harness-error exclusions its own retry never recovered.

## Cost and speed

Post-dedup, harness errors excluded:

| model    |   n | pass |  spend |   $/attempt | $/green solution | agent time |
| -------- | --: | ---: | -----: | ----------: | ---------------: | ---------: |
| DeepSeek | 209 |  181 | $3.626 |     $0.0174 |      **$0.0200** |      25.2h |
| MiMo     | 142 |   89 | $2.482 |     $0.0175 |          $0.0279 |      21.2h |
| Hy3      | 142 |  108 | $3.023 | **$0.0213** |          $0.0280 |  **10.6h** |

Two things fall out of this table that the significance tests do not show.

**Hy3 is not cheaper per working solution than MiMo, despite solving far more
tasks.** 76.1% green against MiMo's 62.7% is a large quality gap, but Hy3 costs
22% more per attempt, and the two effects cancel almost exactly: $0.0280 against
$0.0279 per green. DeepSeek remains 1.40× cheaper than either. This is the
`cost-drivers.md` finding holding up — per-attempt price is nearly flat across
models and the pass rate is what moves cost — except that Hy3 is the first model
priced far enough above the others to offset its own quality advantage.

**Hy3 is roughly 2× faster in wall time** — 10.6h against 21.2h and 25.2h for
the same 142-attempt shape. That is an operational property worth recording for
sweep planning even though no DV measures it.

## Ranking after two rounds

Against the common DeepSeek baseline: **DeepSeek > Hy3 > MiMo**. Hy3 beats MiMo
by 13.4 pp of green rate, which is comfortably past the 10 pp bar — but that
comparison is _between two arm-Bs run on different days_, so it inherits the
non-concurrency confound twice over and is the weakest claim on this page.
DeepSeek's lead over each challenger is the sound comparison, because each was
measured against the same arm A.

Nothing here dislodges DeepSeek V4 Flash as the model to spend sweep budget on.

## The confound, unchanged

Arms were **not run concurrently** (prereg, Threats to validity #1): arm A ran
2026-08-02 alongside the `agent` arm, arm B ran 2026-08-04–05 alone. Provider
load and time-of-day are confounded with the arm, and this was written down
before any result was seen.

As in round 1, the confound points the wrong way to rescue arm B: arm B ran
_alone_ on an otherwise idle provider and still needed more rounds. If load were
driving the gap it would have favoured the solo arm.

## What this does not say

The comparison pins aven-lang `8ca8620`, which now predates the `Bool`
exhaustiveness fix (`2e37df6`) and the bare-match-arm diagnostic (`843af8a`).
Holding the pin is the correct control for a model comparison, but **the
absolute green rates on this page describe a compiler we no longer ship** and
must not be quoted as current Aven capability.
