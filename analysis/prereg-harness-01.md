# Pre-registration — harness A/B (`harness-01`), GPT-5.6 Luna

Written and committed **before** the first attempt of either arm was run.
Nothing below may be changed once rows exist; an amendment goes in a new dated
section at the bottom, with its reason, and never edits what is above it.

Runs: `phase6-harness-codex-01` and `phase6-harness-opencode-01`, both new.

This opens the **harness axis** (§8). Rounds 1–3 varied the model with the
harness held fixed; this round does the reverse.

## Question

Holding the model, the compiler, the skill doc, the reasoning effort and every
other harness setting fixed, does driving GPT-5.6 Luna through **`codex`**
differ from driving it through **`opencode`** at reaching a green suite?

## Independent variable

`agentHarness`. **Both arms are run now.**

| Arm | `agentHarness` | `modelId`                  | Run                          |
| --- | -------------- | -------------------------- | ---------------------------- |
| A   | `codex`        | `gpt-5.6-luna`             | `phase6-harness-codex-01`    |
| B   | `opencode`     | `opencode-go/gpt-5.6-luna` | `phase6-harness-opencode-01` |

Note the `modelId` strings differ by necessity — codex names the model bare,
opencode requires the `opencode-go/` provider prefix. They are the same model
name reached two ways, which is precisely threat 2 below. The analysis filters
each arm by its own run-id and model string; it must not attempt to match them.

## The threat this round finally removes

Every model round so far (`model-01`, `-02`, `-03`) carried the same lead
threat: **arms were not concurrent**, because arm A was reused from disk and arm
B ran days later. Provider load, time-of-day and any silent model revision were
confounded with the arm, and every result had to be read through that.

**Both arms here are run now, concurrently, at `--jobs 2` each.** Provider load
and time-of-day therefore fall on both arms alike. This is the first clean
comparison in the campaign, and it is the reason the harness axis is worth
running before re-baselining the model axis.

## Held fixed

|                      |                                                                      |
| -------------------- | -------------------------------------------------------------------- |
| model                | GPT-5.6 Luna (see threat 2 on what "same model" is worth)            |
| **reasoning effort** | **`high` on both arms**, recorded per row as `agentVariant`          |
| skill doc            | `docs/aven-skill-doc-v2.md`, sha256 `dfa665f6…`, `--doc-id skill-v2` |
| aven-lang commit     | `8ca8620` (same worktree, binary `f34e976b…`)                        |
| task set             | `holdout`, all 71                                                    |
| language arm         | `aven` only                                                          |
| rounds               | `--rounds 3`                                                         |
| nudges               | `--max-nudges 2`                                                     |
| tool policy          | `no-verify`                                                          |
| suite visibility     | `hidden`                                                             |
| diagnostic format    | `text`                                                               |
| sandbox              | bubblewrap                                                           |
| samples              | 2 per task per arm                                                   |
| concurrency          | `--jobs 2` per arm                                                   |

### How effort is pinned, and why it is recorded

The two harnesses have **different defaults**, and codex's is invisible: it
reads `model_reasoning_effort` from the user's `~/.codex/config.toml` (set to
`high` on this machine). A naive run would have compared codex-at-high against
opencode-at-provider-default and called the difference "harness".

Both arms are therefore pinned explicitly:

- codex: `-c model_reasoning_effort="high"` passed on the command line by the
  adapter, **not** inherited from the config file, so the arm does not depend on
  a file outside the repo.
- opencode: `--variant high`.

Evidence that `--variant` is live rather than silently ignored, measured before
this round (reasoning tokens on identical prompts):

| prompt                                    |    `minimal` | `high` |
| ----------------------------------------- | -----------: | -----: |
| hard (smallest n with 100 trailing zeros) |           62 |     98 |
| easy (sheep word problem)                 | 38 (default) |     41 |

Monotonic and in the right direction, but the absolute counts are small on
prompts this trivial. This is **suggestive, not conclusive**. If the two arms
come out indistinguishable, an unpinned-effort explanation cannot be fully
excluded, and that must be said rather than glossed.

Every row records `agentVariant` (schema 11), so the claim that the arms were
matched is checkable from the data instead of resting on this document.

## Threats to validity, named up front

**1. The codex arm is cost-blind.** codex bills against a subscription and emits
no cost field anywhere in its event stream. Its rows carry `costUsd: null` with
`priceSource: "unknown"` — deliberately not `0`, which would pool into cost
analyses as though the arm were free. **No cost DV is defined for this round**,
and no $/green comparison will be made. Token counts are available on both arms
and carry the efficiency signal instead.

**2. "Same model" is an assumption, not a control.** `opencode-go/gpt-5.6-luna`
reaches the model through a gateway; codex goes direct to OpenAI
(`provider: openai`). Same advertised name, different routing, and possibly a
different served version, system prompt or sampling default. **A difference
between arms is therefore attributable to "harness as a whole route", not to the
harness's tool loop specifically.** This threat cannot be designed away without
a provider that both harnesses reach identically, and none exists here.

**3. The harnesses differ in more than their tool loop.** codex takes its prompt
on stdin and ships its own system prompt and sandbox conventions; opencode takes
an argv positional and ships different ones. That _is_ the harness, so it is in
scope — but it means a result says "use this tool", not "this tool loop is
better".

**4. The pinned compiler is stale.** `8ca8620` predates the `Bool`
exhaustiveness fix (`2e37df6`) and the bare-match-arm diagnostic (`843af8a`).
Correct as a control — it must not move between arms — but absolute green rates
here describe a compiler we no longer ship and must not be quoted as current
Aven capability.

**5. The codex adapter is new.** It was written for this round and has one
end-to-end verification per harness, not a track record. A `harness_error` rate
materially above opencode's is as easily an adapter defect as a harness
property, and will be investigated as the former first.

## Dependent variables

Unchanged in definition from `model-01`:

- **Primary:** per-task green rate (fraction of 2 samples passing), paired
  Wilcoxon signed-rank across 71 tasks. Effect bar **10.0 pp**.
- **Secondary:** censored repair rounds — `roundsToGreen` if green, else
  `maxRounds + 1`. Effect bar **0.3 rounds**.
- **Descriptive:** first-shot pass rate; total tokens per green solution (the
  cost proxy, since money is unavailable on arm A).
- α = 0.05. `MIN_SAMPLES = 2`. Dedup key and exclusion rules unchanged.

**No cost DV.** See threat 1.

Direction is not predicted. Unlike the model rounds, there is no prior
expectation about which harness wins, so this is genuinely two-sided.

## Analysis

`analysis/model-ab.ts` hard-codes arm A as the reused DeepSeek file and is the
wrong instrument here — both arms are fresh and neither is DeepSeek. A
`analysis/harness-ab.ts` will be written **before the arms finish**, reusing the
same tested statistical core (`wilcoxonSignedRank`, `dedupeRows`, `excludeRows`,
`censoredDv`) from `diagfmt-ab.ts`, with fixture-only tests as
`model-ab.test.ts` has. It will not read `data/runs` in tests.

Writing it before the data lands is deliberate: an analysis written after seeing
results is an analysis shaped by them.

## Budget

Only arm B costs money; arm A is subscription-billed and free at the margin.

Per `results-model-03`, a padded point estimate from a 3-task probe is the wrong
instrument — probes have overstated by 1.8× and understated by 2.4× in this
campaign, depending on whether their own failure rate lands above or below the
corpus base rate. So no probe multiplier is used. The range is taken from the
observed corpus mean across four models ($0.0174–$0.0585/attempt):

**142 attempts × $0.0174–$0.0585 = $2.47–$8.31.**

Hard stop rule: **$6.00** on arm B spend. If reached, arm B is **halted,
reported as halted, and not analysed as complete** — at 2 samples a halt leaves
tasks below `MIN_SAMPLES`, and the attempts bought last are disproportionately
the failing ones.

The preregistered harness-error retry pass (`--retry-harness-errors`, one pass,
same run-id, second-time failures stay excluded and counted) runs on **both**
arms after the sweep and before any analysis.

n is fixed at 2 × 71 = 142 per arm before the first attempt and will not move on
the basis of any result.

## Amendment 1 — 2026-08-05: `leap` will be dropped from both arms

Recorded **before any arm-B outcome was inspected**, minutes after launch, from
the runner's startup line rather than from any result.

Both arms reported `resume … 1 skipped, 141 to run`. The skipped attempt is
`leap` sample 0, satisfied by the two adapter smoke tests
(`harness-codex-smoke2`, `harness-opencode-smoke`) run shortly before launch to
verify the new codex adapter end to end.

**Why it happens.** Resume is keyed on the *natural key* (`attemptKey`), which
deliberately excludes `runId` so that an interrupted sweep does not re-buy work.
It also excludes `maxRounds`. The smoke attempts therefore satisfy the arms'
plans, but they carry a different run-id and `--rounds 2` rather than 3, so the
analysis — which filters by run-id — will never see them.

**Consequence.** `leap` will hold 1 usable sample in each arm and be dropped by
`MIN_SAMPLES = 2`. The paired analysis runs on **70 tasks, not 71**.

**Why it is not corrected.** Backfilling is not possible: a targeted re-run
under the arm's run-id hits the same resume match and skips again. The only
remaining route is moving the smoke rows aside, and `data/runs/` is permanently
append-only in this project — rows are never deleted, moved or truncated, which
is a rule worth more than one task.

**Why it is tolerable.** The loss is **symmetric**: both smoke tests used
`leap`, so both arms lose the same task. A symmetric loss costs one pair of
observations; it does not bias the comparison, which is what a *differential*
loss would do. The prior rounds' concern — that dropped tasks silently change
*which* tasks the arms are compared on, in a way correlated with difficulty —
does not apply, because the drop is identical on both sides and was caused by
tooling order, not by task difficulty or outcome.

**Process lesson, for the next round.** Smoke-test a new adapter on a task
outside the task set being swept (a `tune` task, not a `holdout` one), or under
settings that differ in a natural-key field. The first smoke test did use a
`tune` task (`accumulate`); the second used `leap` only because resume had
already skipped `accumulate`, and `leap` is in `holdout`. That is the mistake.

**Unchanged:** n = 2 per arm, both DVs, both effect bars, α, exclusions, the
dedup key, the stop rule, and the harness-error retry procedure. The paired
task count in the results must be reported as 70 with this amendment cited.

## Amendment 2 — 2026-08-05: arm B tripped its circuit breaker at 52/142

Recorded **before any arm outcome distribution was inspected**. The only arm-B
fields consulted in reaching this decision were `harness_error` counts and
`harnessErrorKind` — operational health, which threat 5 above explicitly
reserves the right to check. No green rate, no rounds, no pass/fail breakdown.

**What happened.** Arm B halted after 3 consecutive attempts returned zero
tokens (`agent-no-tokens` — the gateway returning nothing, not the model
failing). The runner's circuit breaker fired as designed, skipped the remaining
89 planned attempts, wrote 52 records and exited non-zero. Arm A (codex) was
unaffected and kept running; it reaches OpenAI directly, so the two arms do not
share a provider and could not have loaded each other.

**Response.** The gateway was probed directly and returned tokens normally, so
the burst was transient. Arm B was resumed under the same run-id — resume
skips the 52 completed attempts and picks up the 89 — with the breaker
threshold raised from 3 to 6 (`--breaker-threshold 6`).

**Why raising the breaker is not gaming the design.** The breaker governs how
many provider faults are tolerated before abandoning a model; it is not a DV,
not an analysis rule, and not sensitive to any outcome. Raising it makes the
pre-registered n = 142 more likely to be *reached*, which is what the
pre-registration demands. Zero-token attempts cost $0, so the added tolerance
buys nothing at risk. Recorded here because it is an operational parameter that
was not fixed above the line, and an unrecorded mid-run parameter change is how
pre-registration decays.

**The real cost: concurrency is now partial.** The headline claim of this round
is that both arms run concurrently, removing the non-concurrency confound that
qualified model rounds 1–3. That claim is now weaker and must be stated
precisely in the results:

- Arm B attempts **1–52** ran concurrently with arm A.
- Arm B attempts **53–142** ran after a gap, still overlapping arm A (which had
  ~100 attempts outstanding at relaunch), but not from the same start.

So the arms remain **substantially** concurrent — far closer than any model
round, where arms were days apart — but "fully concurrent" is no longer true and
will not be claimed. The results must report the split above rather than the
unqualified claim in "The threat this round finally removes".

**Reliability as a finding, not just noise.** Arm B produced 6 `agent-no-tokens`
in its first 52 attempts (11.5%) against arm A's 0 in 42. Earlier opencode-go
rounds ran 0.7% (hy3) and 2.8% (qwen). The retry pass will recover these rows,
but the results must report **pre-retry** error rates alongside post-retry ones:
harness reliability is a legitimate property of a harness, and cleaning it away
before reporting would hide the most operationally relevant difference measured
so far. Whether this is a `gpt-5.6-luna`-on-gateway effect or provider weather
is not determinable from one round, and will not be asserted either way.

**Unchanged:** n = 2 × 71 per arm, both DVs, both effect bars, α, exclusions,
the dedup key, the $6.00 stop rule, and the harness-error retry procedure.

## Amendment 3 — 2026-08-06: retry null measurements until a measurement exists

Recorded **before any outcome distribution was inspected**. The fields consulted
were `outcome === "harness_error"`, `harnessErrorKind`, and per-key attempt
history — operational health only.

**The rule being changed.** Every prereg in this campaign has carried "retry
pass, one pass only; second-time failures stay excluded and counted", inherited
from `model-01`. Applied here it costs three tasks: after one retry,
`two-bucket|s0`, `phone-number|s1` and `react|s1` had each returned
`agent-no-tokens` twice, so their tasks fall below `MIN_SAMPLES` and leave the
comparison. With `leap` (Amendment 1) that is 67 paired tasks, not 71.

**Why one pass was the wrong rule.** It conflated two operations that are not
alike:

- **Re-running a completed measurement** — a key that produced a real outcome.
  That is re-rolling a result already seen, selects on the DV, and stays
  forbidden.
- **Re-running a null measurement** — `agent-no-tokens` means the gateway
  returned nothing at all. The model never ran, no solution was attempted, no
  outcome exists. There is nothing for the retry decision to have selected on.
  Retrying it does not bias the DV; it fills a hole the provider punched in the
  design.

The harness already enforces the safe version structurally: `isDone` marks a key
done as soon as it has **any** non-`harness_error` outcome, so
`--retry-harness-errors` cannot re-roll a real result no matter how often it is
run. The stopping condition is "a measurement exists", never "a measurement we
like" — the first real outcome is kept whether it passes or fails.

**New rule, for this round and stated for future ones.** Retry passes repeat
while they make progress, up to **4 passes total per arm**, and stop early when
a pass recovers nothing. Keys still null after that are excluded and counted,
and their tasks drop as before. The bound exists so a genuinely broken key
cannot loop forever, not because further retries would bias anything.

**What must still be reported.** Amendment 2's requirement stands and matters
more now: **pre-retry harness-error rates are reported alongside post-retry
ones**, together with how many passes each arm needed. Retrying until a
measurement exists is the right way to get unbiased *outcomes*; it would be the
wrong way to report *reliability*, which is a real harness property. Both go in
the results.

**Non-independence, noted not asserted.** Three of 11 retried keys failed a
second time, against roughly 0.8 expected if re-failure were independent at the
observed ~7% rate. That hints the failures are not uniform across keys. n = 11
is far too small to conclude anything, and nothing is concluded; it is recorded
because it is the reason attempt counts are worth keeping rather than
collapsing.

**Unchanged:** n = 2 × 71 per arm, both DVs, both effect bars, α, the exclusion
rules, the dedup key, and the $6.00 stop rule.
