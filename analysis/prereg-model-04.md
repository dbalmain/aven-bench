# Pre-registration — model A/B (`model-04`), GLM-5.3-Flash vs DeepSeek V4 Flash at matched effort, on HEAD

Written and committed **before** the first attempt of either arm. Nothing below
may be changed once rows exist; an amendment goes in a new dated section at the
bottom, with its reason, and never edits what is above it.

Runs: `phase5-model-glm53f-01` and `phase5-model-deepseek-head-01`, both new,
both run now, concurrently.

## Why this file is not `model-03` with a new model name

Rounds 1–3 (`mimo-v2.5`, `hy3`, `qwen3.7-plus`) all reused
`phase4-diagfmt-text-01` as arm A: `opencode-go/deepseek-v4-flash`, aven-lang
`8ca8620`, skill doc v2. That ladder is now three weeks and ~40 commits behind
the compiler, and two skill-doc revisions behind. The question asked here is
about the models as they would be used **today**, so arm A is re-run on HEAD
rather than reused, and this round therefore joins no ladder: its absolute
numbers are comparable to `model-01/02/03` in neither arm.

## Question

On the Aven arm, holding the compiler, the skill doc and every harness setting
fixed, how does `opencode-go/glm-5.3-flash` compare to
`opencode-go/deepseek-v4-flash` at reaching a green suite, with both models at
reasoning effort `high`?

## Independent variable

| Arm | `modelId`                       | `agentVariant` | Provenance                        | Samples |
| --- | ------------------------------- | -------------- | --------------------------------- | ------- |
| A   | `opencode-go/deepseek-v4-flash` | `high`         | run now, `phase5-model-deepseek-head-01` | 1 |
| B   | `opencode-go/glm-5.3-flash`     | `high`         | run now, `phase5-model-glm53f-01` | **1**   |

Effort is **matched at `high` on both arms** so the IV is model identity alone.
`opencode models opencode-go --verbose` shows both models exposing the same
`low` / `high` / `max` variant set, so this is available symmetrically. The
price of matching is continuity: every previous DeepSeek row ran with no
`--variant` at all, i.e. at the provider default, so arm A here is **not** the
same configuration as `phase4-diagfmt-text-01` or `phase4-layout-residue-01`
even setting the compiler and doc aside. Both arms are run now for exactly that
reason.

## Held fixed

|                   |                                                                        |
| ----------------- | ---------------------------------------------------------------------- |
| skill doc         | `docs/aven-skill-doc-v5.md`, `--doc-id skill-v5`                       |
| aven-lang commit  | `b22ba54` (main checkout, clean), release binary sha256 `d734d66e…`    |
| task set          | `holdout`, all 71                                                      |
| language arm      | `aven` only                                                            |
| rounds            | `--rounds 3`                                                           |
| nudges            | `--max-nudges 2`                                                       |
| tool policy       | `no-verify`                                                            |
| suite visibility  | `hidden`                                                               |
| diagnostic format | `text`                                                                 |
| sandbox           | bubblewrap (default)                                                   |
| samples           | **1** per task, both arms                                              |
| harness           | `opencode` 1.18.25                                                     |
| concurrency       | `--jobs 2` per arm, the two arms concurrent                            |

`b22ba54` is a test-only commit on top of `598ab24`; the release binary built at
`598ab24` is therefore the binary for this commit and no rebuild was needed.
`avenCommit` records `b22ba54` and `avenBinarySha256` pins the build.

## Commands

```sh
AVEN_BIN=/home/dave/w/clex/aven-lang/target/release/aven \
bun run bench --lang aven --task-set holdout --samples 1 \
  --model opencode-go/glm-5.3-flash --variant high \
  --rounds 3 --max-nudges 2 --jobs 2 \
  --doc ../docs/aven-skill-doc-v5.md --doc-id skill-v5 \
  --run-id phase5-model-glm53f-01

AVEN_BIN=/home/dave/w/clex/aven-lang/target/release/aven \
bun run bench --lang aven --task-set holdout --samples 1 \
  --model opencode-go/deepseek-v4-flash --variant high \
  --rounds 3 --max-nudges 2 --jobs 2 \
  --doc ../docs/aven-skill-doc-v5.md --doc-id skill-v5 \
  --run-id phase5-model-deepseek-head-01
```

## What n = 1 costs, stated before the data

Carried over from `model-03` and still binding, now on **both** arms rather than
one. Each per-task green rate is a single Bernoulli draw, so per-task
measurement error is at its maximum on both sides of every paired difference.

Fixed in advance: **a `no-difference` or `below-effect-bar` verdict in this
round is not evidence that the two models are equivalent.** Only an
`arm-a-better` or `arm-b-better` verdict carries information, and only in the
direction it points. Any write-up must say so.

The effect bars are **not** loosened to compensate: green-rate bar 10.0 pp,
censored-rounds bar 0.3 rounds, α 0.05.

## Dependent variables

- **Primary:** per-task green rate, paired Wilcoxon signed-rank, bar 10.0 pp.
- **Secondary:** censored repair rounds (`roundsToGreen` if green, else
  `maxRounds + 1`), bar 0.3 rounds.
- **Descriptive:** first-shot pass rate, cost per green, wall time per green.
- **`MIN_SAMPLES = 1`**, passed explicitly as `--min-samples 1` and recorded in
  the report.
- Dedup key, exclusion rules and α unchanged from `model-01`.

`analysis/model-ab.ts` currently hardcodes arm A as
`phase4-diagfmt-text-01.jsonl` / `opencode-go/deepseek-v4-flash`. It gains an
`--arm-a <run-id>` flag (and `--arm-a-model`) before this round is analysed. The
change is mechanical: it parameterises which file and modelId select arm A's
rows and adds nothing to the filtering, and it is covered by the existing
`model-ab.test.ts` plus a case pinning the new flags. Defaults stay as they are
so rounds 1–3 continue to reproduce.

## Harness errors

The pre-registered retry pass (`--retry-harness-errors`, same run-id, one pass
only per arm, second-time failures stay excluded and counted) runs
unconditionally after each arm, before any analysis. At n = 1 a harness error
otherwise removes the task from the comparison entirely.

## Budget

No price-table entry exists for either model, so `shadowCostUsd` will be null
and `costUsd` — the harness's own per-round charge — is the only spend figure.
Projection from list prices at models.dev (glm-5.3-flash $0.075 in / $0.25 out;
deepseek-v4-flash $0.22 / $0.66) and from `phase4-layout-residue-01`'s measured
$0.0075/attempt for DeepSeek at default effort, scaled for `high`: expected
**under $3.00 for the two arms together**.

Hard stop: **$6.00 combined**. Per `model-01` Amendment 4, an arm that reaches
its share of the cap is halted, reported as halted, and not analysed as
complete.

n is fixed at 1 × 71 per arm before the first attempt and will not move on the
basis of any result.

## Threats to validity

- **New ground on both axes.** Compiler and skill doc are both newer than any
  recorded sweep, so neither arm's absolute rate is comparable to anything on
  disk. Only the within-round paired contrast is interpretable.
- **`(2x usage)` on the treatment model.** opencode names this model
  "GLM-5.3-Flash (2x usage)". The `gpt-5.6-luna` billing audit found opencode's
  reported `part.cost` used the un-multiplied base rate and was therefore
  exactly half the true charge for such a model. Arm B's `costUsd` may
  understate spend by 2x; the cost DV is descriptive here, and a billing
  reconciliation against the usage feed is deferred.
- **Harness version drift.** `adapters/agent/opencode.ts` documents its
  invocation as verified against opencode 1.18.4; the installed CLI is 1.18.25.
  The event fields the adapter reads are unchanged as far as the preflight probe
  and the first rows show, but this is not a verified-against claim.
- **Effort semantics are provider-side.** `high` is passed through to the
  gateway; what each model does with it is not observable from here, so
  "matched effort" means matched request, not matched compute.
