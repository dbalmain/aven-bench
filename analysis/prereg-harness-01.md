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
