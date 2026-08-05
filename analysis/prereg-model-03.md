# Pre-registration — model A/B (`model-03`), Qwen 3.7 Plus at 1 sample

Written and committed **before** the first attempt of the Qwen arm was run.
Nothing below may be changed once rows exist; an amendment goes in a new dated
section at the bottom, with its reason, and never edits what is above it.

Runs: `phase5-model-qwen37p-01` (new), compared against `phase4-diagfmt-text-01`
(already on disk, run 2026-08-02).

## Why this file exists

`prereg-model-02.md` specified this arm at n = 2 and fixed a budget gate that
**refused it**: the price probe returned $0.10387/attempt, projecting $14.75
unadjusted (or $35.40 under the pre-registered padding) against a $4.50
threshold. That refusal was escalated, and the authorised response was a
half-size arm at **1 sample per task**, ~$7.4.

`model-02` cannot be amended into that shape. It fixes n = 2 above the line and
its analysis inherits `MIN_SAMPLES = 2`, which would drop **every** task at n
= 1. A new pre-registration is the honest instrument. `model-02` stands as
written, refused and unlaunched.

## Question

Unchanged from `model-02`: on the Aven arm, holding the compiler, the skill doc
and every harness setting fixed, how does `opencode-go/qwen3.7-plus` compare to
`opencode-go/deepseek-v4-flash` at reaching a green suite?

## Independent variable

| Arm | `modelId`                       | Provenance                         | Samples |
| --- | ------------------------------- | ---------------------------------- | ------- |
| A   | `opencode-go/deepseek-v4-flash` | reused, `phase4-diagfmt-text-01`   | 3       |
| B   | `opencode-go/qwen3.7-plus`      | run now, `phase5-model-qwen37p-01` | **1**   |

## Held fixed

As `model-02`, restated so this file stands alone. Only `samples` differs.

|                   |                                                                      |
| ----------------- | -------------------------------------------------------------------- |
| skill doc         | `docs/aven-skill-doc-v2.md`, sha256 `dfa665f6…`, `--doc-id skill-v2` |
| aven-lang commit  | `8ca8620` (via the same `git worktree`, binary `f34e976b…`)          |
| task set          | `holdout`, all 71                                                    |
| language arm      | `aven` only                                                          |
| rounds            | `--rounds 3`                                                         |
| nudges            | `--max-nudges 2`                                                     |
| tool policy       | `no-verify`                                                          |
| suite visibility  | `hidden`                                                             |
| diagnostic format | `text`                                                               |
| sandbox           | bubblewrap (default)                                                 |
| samples           | **1** per task, arm B only                                           |
| harness           | `opencode`                                                           |
| concurrency       | `--jobs 2`                                                           |

`docs/aven-skill-doc-v3.md` is again deliberately **not** used: the doc is a
held-fixed control on the model axis, and swapping it in would confound doc
quality with model identity and break comparability with rounds 1 and 2.

## What n = 1 costs, stated before the data

This is the substantive change, and it is a real weakening of the design.

**Arm B's per-task green rate becomes a single Bernoulli draw**, taking only 0
or 1, where rounds 1 and 2 averaged 2 or 3 attempts. Its per-task measurement
error is therefore at its theoretical maximum, and that noise propagates
straight into the paired differences the Wilcoxon test ranks. Arm A is
unaffected — it keeps all 3 samples, and there is no reason to discard them.

The consequence is **reduced power**, and it is asymmetric in a way worth naming
now:

- A **large** gap should still surface. Rounds 1 and 2 measured 23.2 pp (MiMo)
  and 9.9 pp (Hy3) against arm A; an effect the size of MiMo's would remain
  visible through this much noise.
- A **near-bar** gap probably will not. Hy3's 9.9 pp reached p = 0.0088 only
  with 2 samples per task and 48 tied pairs. At 1 sample the same true effect
  would plausibly miss significance.

Therefore, fixed in advance: **a `no-difference` or `below-effect-bar` verdict
in this round is not evidence that Qwen matches DeepSeek.** It is consistent
with both a genuine tie and a real gap this design was too small to resolve.
Only an `arm-a-better` or `arm-b-better` verdict carries information, and only
in the direction it points. Any write-up must say so.

The effect bars are **not** loosened to compensate. Moving a bar to buy
significance from a weaker design is exactly the manoeuvre pre-registration
exists to prevent. Green-rate bar stays 10.0 pp, censored-rounds bar stays 0.3
rounds, α stays 0.05.

## Harness errors are now single points of failure

At n = 2 a `harness_error` cost a task one sample and the retry pass restored
it. At n = 1 a harness error means the task has **zero** usable samples and
leaves the comparison entirely, whatever the threshold.

The pre-registered retry pass (`--retry-harness-errors`, same run-id, one pass
only, second-time failures stay excluded and counted) is therefore **more**
load-bearing here than in any previous round, not less. It runs unconditionally
after the sweep, before any analysis.

## Dependent variables

Unchanged from `model-01` except the sample threshold:

- **Primary:** per-task green rate, paired Wilcoxon signed-rank, bar 10.0 pp.
- **Secondary:** censored repair rounds (`roundsToGreen` if green, else
  `maxRounds + 1`), bar 0.3 rounds.
- **Descriptive:** first-shot pass rate. Not a negative control in this design.
- **`MIN_SAMPLES = 1`** for this round, passed explicitly as `--min-samples 1`.
  The threshold is recorded in the report so a 1-sample report cannot be
  mistaken for a 2-sample one.
- Dedup key, exclusion rules and α are unchanged.

Analysis, unchanged and already tested:

```sh
bun run analysis/model-ab.ts --arm-b phase5-model-qwen37p-01 \
  --model opencode-go/qwen3.7-plus --min-samples 1
```

The `--min-samples` flag and the report field recording it were added _before_
this arm ran, with tests covering both the pairing change and the guarantee that
lowering the threshold does not smuggle excluded rows back in.

## Budget

71 attempts × $0.10387 (probe mean) = **$7.37** expected.

Hard stop rule: **$9.00** arm spend, covering the retry pass and the chance that
the probe understated. Note the probe drew 2 failures in 3 against a corpus base
rate nearer 25%, so the probe mean more likely **over**states than understates
here — the opposite of the usual direction, and the reason no padding multiplier
is applied to the cap.

Per `model-01` Amendment 4: if the cap is reached the arm is **halted, reported
as halted, and not analysed as complete**. At n = 1 that rule bites harder — a
halted arm simply has no data for the tasks it never reached, and those tasks
leave the comparison.

n is fixed at 1 × 71 = 71 before the first attempt and will not move on the
basis of any result.

## Threats to validity

All four from `model-02` carry over unchanged: **non-concurrent arms**,
**differing binary hash at an identical source commit**, **a pinned compiler now
materially behind HEAD** in exactly the area the corpus exercises, and the
cross-round ranking confound. Read `prereg-model-01.md` and `prereg-model-02.md`
for the arguments; they are not restated here.

Added by this round: **the power limitation above is itself a threat to
validity**, and the one most likely to be misread, because a null result looks
like a finding.
