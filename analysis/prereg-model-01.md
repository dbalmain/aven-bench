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
