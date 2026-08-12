# Post-`#71` layout residue — `phase4-layout-residue-01`

## Decision

**No substantial layout residue survives this sweep. Do not build the
significant-indentation A/B from #67 on this evidence.**

There were **0 layout-attributed tasks among 66 usable tasks** and **0
layout-attributed episodes among 45 failed model-authored rounds**. The
pre-registered decision boundary is `ceil(10% * 66) = 7` tasks. Even the
deliberately pessimistic assignment of all five excluded tasks to layout would
only produce 5 of 71, still below the original seven-task boundary.

This answers the residue question, not whether explicit block markers are good
language design in the abstract. The observed failures are no longer a reason
to pay for that experiment.

## Run identity and integrity

The logical sweep is 71 holdout tasks split across two append-only logs:

- `data/runs/phase4-layout-residue-smoke-01.jsonl`: the three accepted smoke
  tasks (`acronym`, `armstrong-numbers`, `hello-world`), all first-shot passes.
- `data/runs/phase4-layout-residue-01.jsonl`: the remaining 68 base attempts,
  the harness-error retry rows, and five surplus retry rows described below.

The runner's resume key is global across run ids. Consequently, the full
command correctly skipped the three already-recorded smoke keys instead of
writing them again under the main run id. Combining the smoke companion with
the main log is therefore the complete 71-task sweep; it is not an extension of
the task set.

All 83 physical rows across the two logs, including retry surplus, agree on:

| Field | Recorded value |
| --- | --- |
| language / task set | `aven` / `holdout` |
| harness / model | `opencode 1.18.15` / `opencode-go/deepseek-v4-flash` |
| rounds / nudges | 3 / 2 |
| policy | hidden suite, `no-verify`, bubblewrap, text diagnostics |
| doc | `skill-v4`, sha256 `d8e8537fb5a5bfb699669c10c3830715a8b7bffcd14a3b1c8702fa54f80984da` |
| aven commit | `af52d49f176333941fa5d5420f62403ded6e5e15` |
| release binary sha256 | `a5875563fba3c9817b797fd108ee8ad4caca79e1f2d1bdd81616853297ceb9cc` |

There are no contaminated rows, no outside-work-directory touches and no model
invocations of `aven`. In particular, both `avenCommit` and
`avenBinarySha256` held for every written row; the compiler did not move under
the run.

## Harness errors and the analysis row

The base sweep produced seven `harness_error` keys. The pre-registration permits
one replacement attempt for each. The first replacement row to land in the
append-only log is the canonical retry observation:

| Replacement result | Tasks |
| --- | --- |
| usable pass | `grade-school`, `rail-fence-cipher` |
| second `harness_error`, excluded | `camicia`, `complex-numbers`, `ledger`, `prism`, `rest-api` |

The first detached retry process outlived the wrapper that appeared to have
lost it. Resuming the apparently incomplete pass therefore overlapped it and
appended five late, surplus `harness_error` rows for keys whose replacement had
already landed. Nothing under `data/` was rewritten or deleted. For the
pre-registered one-retry rule, those surplus rows are retained but ignored;
letting a late duplicate replace the first completed observation would turn an
execution accident into an analysis choice.

The 71 logical tasks thus yield 66 usable observations and five exclusions.
The terminal usable outcomes are:

| Outcome | Tasks |
| --- | ---: |
| pass | 62 |
| wrong output | 1 (`connect`) |
| runtime error | 2 (`gigasecond`, `zipper`) |
| check error | 1 (`react`) |

Headline rates are **62/66 = 93.9% eventual pass** and **37/66 = 56.1%
first-shot pass**. They are not causally or absolutely comparable to
`phase3-holdout-06`: both the compiler (`86ee877` to `af52d49`) and skill
document (v2 to v4) moved. The failure shape is the intended comparison.

## Classification method

I inspected the retained `.av` source artifact and probe diagnostics for every
non-green round in each usable canonical attempt, applying the rule in
`analysis/prereg-layout-residue-01.md`. A failure counted as layout only when
the source plus diagnostic evidence made indentation, layout separation or a
line-break-sensitive parse causal. A type error near a newline and an
incorrect program that happened to contain wrapped calls did not count.

The review covered 45 failed rounds across 29 usable tasks:

| Harness outcome of failed round | Rounds | Layout-attributed |
| --- | ---: | ---: |
| check error | 17 | 0 |
| wrong output | 15 | 0 |
| runtime error | 10 | 0 |
| test timeout | 3 | 0 |
| **Total** | **45** | **0** |

All diagnostics on the 17 check-error rounds were `type.*` diagnostics. There
was no `parse.unexpected-indentation`, `parse.mixed-match-arm-layout`, other
`layout`/`indent` diagnostic, or source-verified layout parse failure. The
`type.incompatible-match-arms` findings in `space-age` were ordinary result-type
disagreements, not mixed arm layout.

The source read matters beyond diagnostic-code filtering. For example,
`go-counting`, `house` and `knapsack` got through parsing with multiline calls
or nested call-heavy expressions and failed later on record shape, output or
type constraints. The other wrong-output, runtime and timeout rounds likewise
contained runnable/checkable programs rather than a layout obstruction.

As a sensitivity read only, four of the five excluded replacement attempts
retained a model-authored failed round before OpenCode's state-directory error;
`prism` retained two. Those five partial rounds were also all type failures and
none was layout-attributed. They remain excluded from the decision exactly as
pre-registered.

## Layout taxonomy versus #52

No current layout cluster exists to distribute: every current cell is zero.
For comparison, the retained #52 task note
(`/home/dave/w/clex/.ai/claude-paren-layout.md`) reports this exact table within
the 67 attempts whose primary diagnostic was `parse.unexpected-indentation`:

| Syntactic shape | #52 primary episodes | This sweep episodes | This sweep tasks |
| --- | ---: | ---: | ---: |
| multiline call arguments | 25 (37.3%) | 0 | 0 |
| method-chain continuation | 25 (37.3%) | 0 | 0 |
| C-style `? :` | 12 (17.9%) | 0 | 0 |
| inline-then-block match arms | 3 (4.5%) | 0 | 0 |
| pipe `\|>` | 1 (1.5%) | 0 | 0 |
| genuine over-indentation | 1 (1.5%) | 0 | 0 |
| other layout shape | 0 | 0 | 0 |
| **Total** | **67** | **0** | **0** |

There is a denominator discrepancy worth preserving rather than smoothing
over. The task brief summarizes parentheses plus chains as about 48% of #52's
layout failures. The retained #52 note's exact counts instead give 50/67 =
74.6% within its primary-diagnostic table, or 50/128 = 39.1% if divided by all
128 live repros; the note's surrounding prose also calls 50/67 “79%”. The
underlying denominator for “about 48%” is not recoverable from that note. This
write-up therefore compares the exact counts and names the mismatch. It cannot
affect the present decision because all current layout counts are zero under
every denominator.

## Recommendation

Close #67's significant-indentation A/B rather than building its wrapper. The
post-#71 compiler plus current v4 documentation did not leave a measurable
layout residue in this sweep, and the result is far below the pre-registered
action threshold. Reopen only on new evidence from a meaningfully different
task/model population, not from the four remaining capability failures here.
