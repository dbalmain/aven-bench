# Results — model A/B (`model-04`), GLM-5.3-Flash vs DeepSeek V4 Flash at high effort, on HEAD

Pre-registration: `analysis/prereg-model-04.md`, committed before the first
attempt of either arm. Nothing below changes it.

| Arm | `modelId`                       | `agentVariant` | Run                              | Samples |
| --- | ------------------------------- | -------------- | -------------------------------- | ------- |
| A   | `opencode-go/deepseek-v4-flash` | `high`         | `phase5-model-deepseek-head-01`  | 1       |
| B   | `opencode-go/glm-5.3-flash`     | `high`         | `phase5-model-glm53f-01`         | 1       |

```sh
bun run analysis/model-ab.ts --arm-a phase5-model-deepseek-head-01 \
  --arm-a-model opencode-go/deepseek-v4-flash \
  --arm-b phase5-model-glm53f-01 --model opencode-go/glm-5.3-flash \
  --min-samples 1
```

Both arms ran concurrently on aven-lang `b22ba54` with skill doc v5, holdout 71,
`--rounds 3`, `--max-nudges 2`, `no-verify`, hidden suites, bubblewrap, text
diagnostics, `--jobs 2`. Neither arm's absolute rate is comparable to any
earlier sweep: the compiler and the doc are both newer than anything on disk.

## Verdict: `below-effect-bar`

GLM is ahead on green rate by **8.5 pp** at p = 0.0411 — significant, and
**below the pre-registered 10.0 pp bar**, so it is reported as below-bar and not
as a win. The bar was not moved.

| DV                             | DeepSeek | GLM       | diff       | test                  | verdict            |
| ------------------------------ | -------- | --------- | ---------- | --------------------- | ------------------ |
| green rate (primary)           | 83.1%    | **91.5%** | +8.5 pp    | z = 2.043, p = 0.0411 | `below-effect-bar` |
| censored rounds (secondary)    | 1.000    | 1.014     | +0.014     | z = 0.202, p = 0.8403 | `no-difference`    |
| first-shot pass (descriptive)  | **57.7%**| 45.1%     | −12.6 pp   | p = 0.1308            | —                  |

71 paired tasks, no exclusions in either arm: zero contamination, and arm B's
single `harness_error` (`complex-numbers`, cut off at 5,322 s) was recovered by
the one pre-registered retry pass, which returned a usable `check_error`. Arm A
had no harness errors at all, so its retry pass had nothing to run — confirmed
by dry run (`71 skipped, 0 to run`) rather than skipped.

**The n = 1 caveat from the pre-registration binds here.** A `below-effect-bar`
verdict at one sample per task is consistent both with a genuine sub-10 pp gap
and with a larger gap this design was too small to resolve. It is not evidence
that the models are equivalent.

## Cost: GLM is 3.1x cheaper per green

| | DeepSeek | GLM |
| ----------------- | -------- | ------- |
| spend             | $2.303   | **$0.807** |
| per green         | $0.0390  | **$0.0124** |
| agent wall time   | 9.2 h    | 13.6 h  |
| wall per green    | 0.16 h   | 0.21 h  |
| output tokens     | 2,425,479 | **84,972** |
| reasoning tokens  | 204,182  | 1,378,017 |

The two models invert the token shape. DeepSeek spends **output**; GLM spends
**reasoning**, 28x less output for 6.8x more reasoning, and on this gateway that
trade is what makes it cheaper. It is also why GLM is slower in wall clock while
costing a third as much — the cheap axis and the fast axis are not the same one.

Per the standing rule, the usage-feed reconciliation is **not load-bearing for
this result**: at 3.1x, doubling GLM's figure for the unresolved "(2x usage)"
multiplier still leaves it cheaper per green. The reconciliation remains worth
doing as bookkeeping, and needs a feed dump captured out of band.

## The failure profiles are not comparable in kind

| outcome        | DeepSeek | GLM |
| -------------- | -------- | --- |
| `pass`         | 59       | 65  |
| `refusal`      | **7**    | 0   |
| `timeout`      | 3        | 0   |
| `wrong_output` | 0        | 3   |
| `check_error`  | 2        | 3   |

This is the finding with the most consequence for reading the primary DV.

**Ten of DeepSeek's twelve losses are budget or latency, not language
competence.** Seven `refusal` rows spent **exactly 96,000 completion tokens**
each — across round 0 and both nudges — and never wrote a solution file:
`book-store`, `complex-numbers`, `diffie-hellman`, `grade-school`, `prism`,
`rest-api`, `zipper`. Seven identical ceilings is one cap being hit seven times,
not seven independent refusals. Two more hit the 1,800 s harness ceiling and
`alphametics` was SIGTERM'd. Only `pov` and `react` are real Aven type failures.

GLM's six losses are all substantive: three wrong answers and three type errors.

So arm A's green rate is in part a measurement of what `--variant high` does to
this model's output budget on this harness, and the 8.5 pp gap should not be
read as 8.5 pp of Aven competence. A follow-up that wanted the language signal
cleanly would either raise the per-attempt output ceiling or run DeepSeek at its
default effort — and the second of those changes the IV, which is why it was not
done here.

## What the arms say about the doc versus the diagnostics

DeepSeek writes the better first draft (57.7% vs 45.1% first-shot) and GLM ends
further ahead (91.5% vs 83.1%). Under the runner's own reading — `firstShotPass`
measures the documentation, `roundsToGreen` measures the diagnostics — the two
models disagree about which half of the Aven surface serves them better. The
censored-rounds DV is flat (p = 0.84), so the green-rate gap is not bought with
extra rounds; it is bought by GLM converting rounds that DeepSeek never got to
spend, because it had already exhausted its budget.

The first-shot difference does not reach significance at n = 1 (p = 0.13) and is
descriptive in this design.

## Threats, as pre-registered

All four stand. Both arms are new ground on compiler and doc, so only the
within-round paired contrast is interpretable. `(2x usage)` on GLM leaves arm B's
`costUsd` possibly 2x low. The installed opencode is 1.18.25 against an adapter
documented as verified at 1.18.4. And `high` is a request, not observed compute:
what each model does with it is provider-side, which the 96,000-token ceiling
makes concrete.
