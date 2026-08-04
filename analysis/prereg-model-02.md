# Pre-registration — model A/B (`model-02`), Qwen 3.7 Plus

Written and committed **before** the first attempt of the Qwen arm was run.
Nothing below may be changed once rows exist; an amendment goes in a new dated
section at the bottom, with its reason, and never edits what is above it.

Runs: `phase5-model-qwen37p-01` (new), compared against `phase4-diagfmt-text-01`
(already on disk, run 2026-08-02).

This is round 3 of the model axis. Round 1 (`model-01`) compared MiMo-V2.5
against DeepSeek V4 Flash; round 2 reused that pre-registration by amendment to
run Hy3 against the same arm A. This round gets its own file rather than a
fourth amendment, because `model-01`'s amendment stack is now long enough that
appending a third arm to it would obscure rather than record.

## Question

On the Aven arm, holding the compiler, the skill doc and every harness setting
fixed, how does `opencode-go/qwen3.7-plus` compare to
`opencode-go/deepseek-v4-flash` at reaching a green suite?

Model-ranking, not a language question. Arm A is the same reused DeepSeek arm
used in rounds 1 and 2, so all three challengers are measured against a common
baseline and are therefore rankable against each other — subject to the
non-concurrency threat below, which applies to that cross-round comparison more
strongly than to any single round.

## Independent variable

`modelId`. One arm is run now; the other is reused from disk.

| Arm | `modelId`                       | Provenance                         |
| --- | ------------------------------- | ---------------------------------- |
| A   | `opencode-go/deepseek-v4-flash` | reused, `phase4-diagfmt-text-01`   |
| B   | `opencode-go/qwen3.7-plus`      | run now, `phase5-model-qwen37p-01` |

## Held fixed

Identical to `model-01`, restated so this file stands alone.

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
| samples           | **2** per task per arm (as round 2, not round 1's 3)                 |
| harness           | `opencode`                                                           |
| concurrency       | `--jobs 2`                                                           |

**`docs/aven-skill-doc-v3.md` is deliberately NOT used**, even though it landed
today and closes real gaps. The doc is a held-fixed control on the model axis;
swapping it in would confound doc quality with model identity and would break
comparability with rounds 1 and 2. v3 belongs to a future doc-axis round, where
it is the independent variable and the model is held fixed.

## Threats to validity, named up front

The three threats in `model-01` all still apply verbatim: the arms are **not
concurrent** (arm A ran 2026-08-02, arm B runs 2026-08-05), the **binary hash
differs** from arm A's record while the source commit is identical, and the
comparison **pins a stale compiler**. They are not restated in full here; read
`prereg-model-01.md` for the argument.

One threat has grown enough to need its own entry.

**4. The pinned compiler is now materially behind HEAD, in exactly the area the
benchmark measures.** At round 1 the pin was 4 commits stale. It is now further
behind and, more importantly, two of the intervening commits (`2e37df6`, closing
finite `Bool` matches; and the `parse.unsupported-syntax` repair-hint work
landing today) target failure modes this corpus actually exercises —
`parse_error` is the priciest outcome on the corpus at $0.0861/attempt. Holding
the pin is still the correct control for a _model_ comparison, and the ranking
between arms remains interpretable. But the **absolute** green rates in this
round increasingly describe a compiler we no longer ship, and must not be quoted
as current Aven capability. A re-baseline of arm A on current HEAD is the
cleanest fix and is the natural next round on this axis; it is not in scope here
because it would cost a full arm.

## Dependent variables

Identical to `model-01`, including the censored repair-rounds secondary DV
(`roundsToGreen` if green, else `maxRounds + 1`), `MIN_SAMPLES = 2`, the dedup
key, the exclusion rules, α, both effect bars, and the harness-error retry
procedure.
`analysis/model-ab.ts --arm-b phase5-model-qwen37p-01 --model opencode-go/qwen3.7-plus`
is the analysis, unchanged and already tested.

## Budget, decided before any row exists

Prior arms cost $0.0160/attempt (DeepSeek), $0.0164 (MiMo) and $0.0205 (Hy3).
Qwen 3.7 Plus is a higher tier than any of these and its per-attempt cost is
**unknown**, so a cap set by analogy would be guesswork.

Procedure, fixed now so the decision is not made after seeing results:

1. Run a 3-task probe under run-id `phase5-model-qwen37p-probe`. **Probe rows
   are excluded from all analysis** — they are a price quote, not data.
2. Compute a projected arm cost as `probe mean × 142 × 2.4`. The 2.4 multiplier
   is not padding: it is the measured probe-underestimate factor from
   `cost-drivers.md`, where Hy3's 3-task probe quoted $0.0079/attempt against
   $0.0193 realised. Probes systematically miss failures, and failures are where
   the money goes.
3. **If that projection exceeds $4.50, do not launch.** Report the quote and
   stop; a spend of that size is the requester's call, not mine. The $4.50
   figure is chosen as roughly 1.5× the Hy3 arm, which is the most the model
   axis is worth without a decision from the requester.
4. If it is under $4.50, launch with a hard stop rule at **$4.50 arm spend**.

As in `model-01` Amendment 4: a halted arm is **reported as halted, never
analysed as a complete one**, because `MIN_SAMPLES = 2` would silently drop
every single-sample task and the attempts bought last are disproportionately the
failing ones.

n is fixed at 2 × 71 = 142 before the first attempt and will not move on the
basis of any result.
