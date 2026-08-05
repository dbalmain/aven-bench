# Pre-registration — model A/B (`model-01`)

Written and committed **before** the first attempt of the MiMo arm was run.
Nothing below may be changed once rows exist; an amendment goes in a new dated
section at the bottom, with its reason, and never edits what is above it.

Runs: `phase5-model-mimo-01` (new), compared against `phase4-diagfmt-text-01`
(already on disk, run 2026-08-02).

## Question

On the Aven arm, holding the compiler, the skill doc and every harness setting
fixed, how does `opencode-go/mimo-v2.5` compare to
`opencode-go/deepseek-v4-flash` at reaching a green suite?

This is a **model-ranking** question, not a language question. It tells us which
models to spend budget on in later Aven sweeps, and it is the first entry in the
model axis (§8).

## Independent variable

`modelId`. One arm is run now; the other is reused from disk.

| Arm | `modelId`                       | Provenance                       |
| --- | ------------------------------- | -------------------------------- |
| A   | `opencode-go/deepseek-v4-flash` | reused, `phase4-diagfmt-text-01` |
| B   | `opencode-go/mimo-v2.5`         | run now, `phase5-model-mimo-01`  |

## Held fixed

|                   |                                                                      |
| ----------------- | -------------------------------------------------------------------- |
| skill doc         | `docs/aven-skill-doc-v2.md`, sha256 `dfa665f6…`, `--doc-id skill-v2` |
| aven-lang commit  | `8ca8620`                                                            |
| task set          | `holdout`, all 71                                                    |
| language arm      | `aven` only                                                          |
| rounds            | `--rounds 3` (so `roundsToGreen` ∈ {0,1,2,3})                        |
| nudges            | `--max-nudges 2`                                                     |
| tool policy       | `no-verify`                                                          |
| suite visibility  | `hidden`                                                             |
| diagnostic format | `text`                                                               |
| sandbox           | bubblewrap (default)                                                 |
| samples           | 3 per task per arm                                                   |
| harness           | `opencode`                                                           |

## Threats to validity, named up front

Reusing arm A instead of re-running it is what brings this round inside its
budget. It costs two things, and both are written down here rather than
discovered afterwards.

**1. The arms are not concurrent.** `diagfmt-01` deliberately ran its two arms
side by side so that provider load and time-of-day fell on both alike. That
protection is gone here: arm A ran 2026-08-02 (concurrently with the `agent`
arm, `--jobs 2`), arm B runs 2026-08-04 alone. Provider-side latency, capacity
and any silent model revision are therefore **confounded with the arm**. A
difference in `timedOut` or `harness_error` rate between arms is as easily
provider load as model quality, and will not be read as a model property. Arm B
runs at `--jobs 2` to match arm A's concurrency as closely as a solo run can.

**2. The binary hash differs from arm A's record.** Arm A recorded
`avenBinarySha256: 738b7ad0…`. Arm B is built from a `git worktree` at the same
commit `8ca8620` (`git diff` against the pin is empty, worktree clean) and
hashes `f34e976b…`. Debug builds embed absolute paths, and the build directory
differs. The source is identical; the bytes are not. Verified behaviourally: the
rebuilt binary still reports the pre-fix `type.unresolved-method-receiver`
wording on `f = (a) => a[0] + 1`, which HEAD no longer does.

**3. This pins a compiler that is 4 commits stale.** `8ca8620` predates the
diagnostics work landed 2026-08-04 (`0cef006`, `9200f36`, `bcc9f99`, `1b2fc52`).
That is the correct control for a _model_ comparison — the compiler must not
move between arms — but it means **no result here says anything about those
fixes**, and none will be claimed.

## Dependent variables

**Primary: green rate.** Per task per arm, the fraction of the 3 samples whose
`outcome` is `pass` (∈ {0, ⅓, ⅔, 1}). 71 paired observations.

Chosen over `diagfmt-01`'s censored-rounds DV because that prereg picked rounds
specifically to escape a saturated pass rate — and pass rate is _not_ saturated
here. Arm A's text run was 181/226 = 80% pass, leaving room in both directions,
and models are expected to differ grossly rather than marginally.

**Smallest effect worth acting on: 10 percentage points** of green rate. A
significant result smaller than that is reported as "real but not a reason to
switch models".

**Secondary: censored repair rounds**, defined exactly as in `prereg-diagfmt-01`
(`dv = roundsToGreen` if green, else `maxRounds + 1 = 4`), per-task mean over 3
samples. Reported so this round is commensurable with `diagfmt-01`.

**Also reported, not inferential:** `firstShotPass`, cost, wall clock, and the
diagnostic-code mix.

## `firstShotPass` is NOT a negative control here

`diagfmt-01` could use it as one, because its IV entered only at round 1 and so
could not affect round 0. That reasoning **does not carry over**: the model
differs from the first token, so a `firstShotPass` difference is a real effect,
not a leak. There is no negative control available in this design. Said plainly
so the absence is not mistaken for an oversight.

## Primary analysis

Paired **Wilcoxon signed-rank** on the 71 per-task green rates, two-sided, α =
0.05. Ties dropped by the test.

## Exclusions, fixed in advance

- `harness_error` rows are excluded from the denominator; the excluded count is
  reported per arm.
- Rows are deduplicated by `(taskId, language, modelId, sampleIndex)`, keeping
  the latest `finishedAt`.
- Arm A rows are taken from `phase4-diagfmt-text-01` only — the `agent` arm is
  **not** pooled in, because `diagnosticFormat` must stay fixed.
- If a task ends with fewer than 2 usable samples in either arm, it is dropped
  from the paired analysis and named in the report.
- Contaminated rows (`contaminated: true`) are excluded and counted.

## Harness-error retries

One retry pass with `--retry-harness-errors` on arm B, same flags and pinned
commit, matching `diagfmt-01`'s Amendment 1 and for the same reason: a
`harness_error` is a missing observation, not a result, so re-buying it restores
a datum rather than selecting on one. Attempts that fail a second time stay
excluded and are counted. No second retry. Arm A is used as it already stands
(it had its own retry pass under that amendment).

## Stopping rule

n = 3 per task, matching arm A. The run stops there. Extending after seeing the
result would be optional stopping; if it happens anyway it gets a dated
amendment saying so, and the p-value is reported as descriptive.

## Budget gate, fixed in advance

MiMo has no price-table entry, and the one other paid non-DeepSeek model on
record (`minimax-m2.7`) ran 2.5× DeepSeek's per-attempt cost. A 3-task price
probe on the **tune** set (`mimo-price-probe-01` — tune deliberately, so holdout
stays untouched) measures the real rate first. The full arm proceeds only if the
projected 213-attempt cost is **under $5**. If it is not, the round stops and
the decision goes back to Dave rather than being resolved by trimming tasks,
which would break comparability with arm A.

Subsequent rounds, budget permitting: `opencode-go/hy3`, then possibly
`opencode-go/qwen3.7-plus`. Each gets the same probe-then-gate treatment and is
compared against the same arm A.

## Analysis code

`analysis/model-ab.ts`, written before any arm-B rows are analysed. Its output
is the report.

---

## Amendment 1 — 2026-08-04, after the price probe, before any arm-B row exists

**Arm B runs at n = 2 samples per task, not n = 3.** Dave's decision, taken on
the probe result and before any holdout attempt was run.

**Why.** The budget gate above failed. `mimo-price-probe-01` (3 tune tasks, n
= 1) measured a mean of **$0.0296 per attempt**, 1.84× arm A's realised $0.0161,
projecting**$6.31** for 213 attempts against a $5 cap. The gate said the
decision goes back to Dave rather than being resolved by trimming tasks; it was,
and the answer was to cut samples instead of tasks. All 71 tasks stay in, so
every pair arm A offers is still available and comparability with arm A is
preserved — which is what the "no trimming" clause was protecting.

142 attempts project to **$3.07–$4.20**.

The probe also showed _why_ MiMo is dearer: the one failing task cost $0.068
against $0.006 and $0.015 for the two that passed, and ran 1483s against 125s
and 328s. Cost is driven by failure, so the arm's true price depends on MiMo's
holdout pass rate, which is unknown at the time of writing and deliberately not
peeked at. The $4.60 end of the range assumes arm A's 80% pass rate; the $6.31
end assumes the probe's 67%.

**Arm A is not subsampled to match.** It keeps all 3 of its samples. Per-task
green rate stays an unbiased estimate of each arm's green probability under both
n; discarding a third of arm A's data to equalise precision would trade a real
reduction in noise for cosmetic symmetry. The arms therefore differ in per-task
precision, and the paired Wilcoxon is on the per-task _means_, which is the same
estimand either way.

**What this costs, stated plainly.** Arm B's per-task DV can only take {0, ½, 1}
instead of {0, ⅓, ⅔, 1}, so the primary test loses resolution and power. The
10-percentage-point effect bar is **not** relaxed to compensate.

**Second-order consequence, named now.** At n = 2 a single `harness_error`
leaves a task with one usable sample, and the `MIN_SAMPLES = 2` rule then drops
that task from the paired analysis entirely. At n = 3 it would have survived.
Arm A ran ~7.5% harness errors (17/226), so this could remove a non-trivial
share of tasks. The already-preregistered retry pass therefore matters more than
it did, and the dropped-task list must be read as part of the result rather than
as bookkeeping. No new discretion is created by this: the retry procedure and
the drop rule were both fixed before any row existed.

**Unchanged:** every other held-fixed setting, the primary and secondary DVs,
the effect bars, α, the exclusion rules, the retry procedure, and the stopping
rule (which now reads n = 2 for arm B; extending afterwards would still be
optional stopping and would still require a dated amendment saying so).

---

## Amendment 2 — 2026-08-05, round 2 (`hy3`), before any hy3 holdout row exists

**Round 2 runs `opencode-go/hy3` as a second arm B at n = 2**, against the same
unchanged arm A, using `analysis/model-ab.ts --arm-b phase5-model-hy3-01`. Run
id `phase5-model-hy3-01`.

n = 2 rather than n = 3 for consistency with round 1, not for budget: comparing
MiMo and Hy3 to arm A at different sample sizes would give the two rounds
different precision for no reason. Every consequence recorded in Amendment 1 —
the {0, ½, 1} DV resolution, the unrelaxed 10-point bar, and a single
`harness_error` dropping a task below `MIN_SAMPLES` — carries over unchanged,
including the retry pass that neutralised it in round 1.

**Budget gate, measured.** `hy3-price-probe-01` (3 tune tasks, n = 1) came in at
**$0.00794 per attempt**, 3/3 green — under half MiMo's $0.0296. The projection
is deliberately _not_ taken from that mean, because the probe contains no
failure and round 1 established that failures dominate cost (MiMo's failing
probe task cost 4.5× its passing ones). Pricing a realistic failure mix gives
**$1.13** if holdout resembles the probe, **~$1.92** at arm A's 80%
attempt-level pass rate, and**~$2.60** at MiMo's 63%. Round 1 spent $2.58 and
the hy3 probe $0.02, so the top of that range would take cumulative spend just
past $5.

**Stop rule for this round, fixed now:** the arm is halted if its own spend
reaches **$2.40** (cumulative $5.00). A halted arm is reported as halted, with
the completed attempt count, and is **not** analysed as though it were a
complete arm — a partial arm compared against a complete one would silently
change which tasks are paired.

**Not conditioned on any round-1 or round-2 outcome.** Round 1's result is
already known and published (`results-model-01.md`); it plays no part in these
choices, all of which follow the procedure written before round 1 ran.

---

## Amendment 3 — 2026-08-05, at 26/142 arm-B rows, on spend only

**The round-2 stop rule rises from $2.40 to $2.90.** Dave's decision, taken on
the measured burn rate at 26 attempts and before the arm completed.

**Why.** Amendment 2 priced hy3 at $1.13–$2.60 and set the cap at $2.40. The
measured rate is **$0.01925 per attempt**— 2.4× the probe's $0.00794, which is
exactly the failure-cost effect Amendment 2 refused to project away, just larger
than its pessimistic end. The arm projects to **$2.73**, so the old cap would
have halted it at roughly **125 of 142 attempts**.

**Why a truncation there is worse than it looks.** It is not a random 12% of the
data. Failing attempts consume budget faster than passing ones (round 1: ~4.5×),
so the point at which a spend cap bites is **correlated with failure**, and the
attempts bought last are not a fair sample of the ones not bought. On top of
that, at n = 2 the missing attempts leave their tasks with a single usable
sample, which `MIN_SAMPLES` then drops from the paired analysis entirely —
silently changing _which tasks_ arm B is compared to arm A on. Amendment 2
already forbade analysing a halted arm as a complete one for this reason. So the
choice was $0.33 against effectively the whole arm.

**This is not optional stopping, and the distinction is the point.** Optional
stopping is extending or curtailing data collection _because of what the results
look like_. Nothing here touches n: it was fixed at 2 samples × 71 tasks = 142
before round 2 began and is unchanged. The decision was made on **spend alone**,
which is the quantity Amendment 2's stop rule is written in terms of, and no
arm-B outcome breakdown was inspected in reaching it. Raising a budget so that a
pre-registered sample completes is the _opposite_ of stopping early on a result.

Recorded rather than quietly actioned because raising a cap after learning you
would breach it is discretionary, and discretion that leaves no trace is how
pre-registration decays.

**Unchanged:** n = 2, both DVs, both effect bars, α, the exclusion rules, the
dedup key, the harness-error retry procedure, and the rule that a halted arm is
reported as halted rather than analysed. If spend reaches $2.90 the arm still
halts and is still not analysed as complete.

## Amendment 4 — 2026-08-05: cap raised to $3.10, and why the cap was mine

At 73/142 attempts the arm had spent $1.4970 ($0.02051/attempt), projecting
**$2.9119** — $0.0119 past the Amendment 3 cap of $2.90. Cap raised to **$3.10**,
which also absorbs the pre-registered harness-error retry pass.

Two things need saying plainly, because Amendment 3 argued at length that a cap
should bite.

**The cap was never the requester's number.** The stated budget constraint was
"under $5" on round 1, gating whether a round 2 happened at all. Round 1's
marginal spend was $2.4875 (the DeepSeek arm was reused, not re-bought), so that
gate passed with room. The $2.40 and $2.90 figures in Amendments 2 and 3 were
self-imposed proportionality guardrails, derived from a projection, not
constraints handed down. Raising one is therefore a much smaller act than
Amendment 3's framing implies, and it would be misleading to let that framing
stand unqualified.

**Halting here would cost the arm, not trim it.** At 73/142 roughly half the
tasks hold a single sample. `MIN_SAMPLES = 2` would drop every one of them,
so the paired comparison would run on an arbitrary half of the corpus selected
by *when the sweep happened to reach each task* — and, per Amendment 3's own
argument, the attempts bought last are disproportionately the failing ones.
The trade is $0.21 against most of the arm's statistical power.

As in Amendment 3: n is untouched (2 × 71 = 142, fixed before round 2 began),
the decision was made on projected spend alone, and no arm-B outcome breakdown
was consulted in reaching it. This is not optional stopping.

**Unchanged:** n = 2, both DVs, both effect bars, α, exclusions, dedup key, the
harness-error retry procedure, and the rule that a halted arm is reported as
halted rather than analysed. If spend reaches $3.10 the arm still halts and is
still not analysed as complete.

## Amendment 4, outcome — 2026-08-05

Recorded because Amendment 4 was written on a projection, and the projection
should be scored against what happened.

**The raise was load-bearing.** The arm completed 142 attempts at **$2.9956**,
and the harness-error retry took it to **$3.0225**. Both figures are above the
$2.90 cap Amendment 4 replaced, so the old rule would have halted the sweep at
roughly 139/142 — inside the last three attempts, which between them cost
$0.176. Those attempts are exactly the expensive-because-failing kind that
Amendment 3 argued a cap selects for.

This is worth stating plainly because midway through the sweep the projection
had fallen to $2.88 and I judged in passing that the cap would not have bitten.
That judgement was wrong: a projection computed on a corpus whose expensive
tasks are unevenly distributed through the run order is not a reliable guide to
the final total, and it drifted by 4% in the last 20 attempts alone. The
practical lesson for future arms is to set the cap from the corpus mean in
`cost-drivers.md` rather than from a running projection, and to expect the
projection to understate while cheap tasks are over-represented in what has
already run.

Final: 143 rows, $3.0225, cap $3.10 not reached, arm completed and analysed as
complete. Zero tasks dropped.
