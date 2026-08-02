# Pre-registration — diagnostic format A/B (`diagfmt-01`)

Written and committed **before** the first attempt was run. Nothing below may be
changed once rows exist; an amendment goes in a new dated section at the bottom,
with its reason, and never edits what is above it.

Runs: `phase4-diagfmt-text-01`, `phase4-diagfmt-agent-01`.

## Question

Does rendering Aven compiler diagnostics in the line-oriented `--format agent`
style, rather than the default ariadne box-drawing style, reduce the number of
repair rounds a model needs to reach a green suite?

## Independent variable

`diagnosticFormat`, recorded on every row and part of the natural key
(`runner/schema.ts`). Exactly one thing differs between the arms: the text of
the compiler output quoted into the **repair** prompt.

| Arm | Value   | Repair prompt gets                                                                                       |
| --- | ------- | -------------------------------------------------------------------------------------------------------- |
| A   | `text`  | `aven check <suite>` — ariadne gutter, carets, `Note:`                                                   |
| B   | `agent` | `aven check --format agent <suite>` — `error[code] file:line:col:` plus indented `in:` / `at:` / `help:` |

Round-0 prompts are byte-identical across arms. The format is only reachable
from round 1, and only when the `check` probe failed — a test-only failure
quotes `gate.detail`, which is the same string in both arms.

### A co-varying property of the renderings, named up front

With `AVEN_BIN` set the harness runs `aven` with cwd set to the work directory,
and the agent renderer strips that prefix while the ariadne renderer does not.
So arm B's prompts carry `solution_test.av` where arm A's carry
`/tmp/aven-bench-.../solution_test.av`. This is a property of the renderings
themselves, not a harness artefact, so it stays in. It is written down here so
that if arm B wins, "shorter paths" is on the record as a candidate mechanism
rather than being discovered afterwards.

## Held fixed

|                  |                                                                      |
| ---------------- | -------------------------------------------------------------------- |
| model            | `opencode-go/deepseek-v4-flash` (harness `opencode`)                 |
| skill doc        | `docs/aven-skill-doc-v2.md`, sha256 `dfa665f6…`, `--doc-id skill-v2` |
| aven-lang commit | `8ca8620`                                                            |
| task set         | `holdout`, all 71                                                    |
| language arm     | `aven` only — the IV cannot affect a control arm                     |
| rounds           | `--rounds 3` (so `roundsToGreen` ∈ {0,1,2,3})                        |
| nudges           | `--max-nudges 2`                                                     |
| tool policy      | `no-verify`                                                          |
| suite visibility | `hidden`                                                             |
| sandbox          | bubblewrap (default)                                                 |
| samples          | 3 per task per arm                                                   |

The doc is one commit newer than holdout-06's (`52c934ce…` → `dfa665f6…`,
"Document slice's optional end"). Both arms share it, so the A/B is internally
valid; its absolute numbers are **not** comparable to holdout-06's.

The two arms run **concurrently**, as two processes at `--jobs 2` each, so that
provider load and time-of-day fall on both arms alike rather than on whichever
ran second.

## Dependent variable

**Censored repair rounds.**

```
dv = roundsToGreen            if the attempt went green
dv = maxRounds + 1  (= 4)     if it never did
```

Per task per arm, take the mean over the 3 samples. That gives 71 paired
observations.

Chosen over pass rate deliberately: holdout-05 was already 93% green, so a
green-rate comparison has almost no room to move and would report null whatever
is true.

## Primary analysis

Paired **Wilcoxon signed-rank** on the 71 per-task means, two-sided, α = 0.05.
Ties (per-task means equal) are dropped by the test, as usual.

**Smallest effect worth acting on: 0.3 rounds** of mean difference. A result
that is significant but smaller than that is reported as "real but not worth
shipping", not as a win.

## Secondary, pre-registered — not post-hoc

Restricted to tasks whose **round-0 `check` probe failed** in that arm.

This is a legitimate stratification, not a post-hoc filter, and the distinction
is the whole reason it is written down here. Round 0 is _pre-exposure_: the
format enters at round 1, so a round-0 outcome cannot have been caused by the
IV. Conditioning on it is conditioning on a pre-treatment covariate.

What is **forbidden** is the filter that looks superficially similar —
restricting to "tasks that failed at least once", or to "tasks that needed a
repair round". Those are measured after exposure and are exactly the collider
that would manufacture an effect. No such filter will be reported.

## Negative control

`firstShotPass` must **not** differ between the arms. Round-0 prompts are
byte-identical, so a significant difference there means something leaked and the
primary result is not to be trusted. Reported either way.

## Exclusions, fixed in advance

- `harness_error` rows are excluded from the denominator, and the excluded count
  is reported per arm.
- Rows are deduplicated by
  `(taskId, language, modelId, sampleIndex, diagnosticFormat)`, keeping the
  latest `finishedAt`.
- If a task ends with fewer than 2 usable samples in either arm after
  exclusions, it is dropped from the paired analysis and named in the report.
- Contaminated rows (`contaminated: true`) are excluded and counted.

## Stopping rule

n = 3 per task per arm. The run stops there. Extending to n = 5 after seeing the
result is optional stopping and would invalidate the α; if it happens anyway it
gets a dated amendment below saying so plainly, and the p-value is reported as
descriptive rather than inferential.

## Analysis code

`analysis/diagfmt-ab.ts`, written before any rows exist. Its output is the
report. If it needs fixing after rows land, the fix is a commit whose message
says what was wrong, so the diff is inspectable against the results.
