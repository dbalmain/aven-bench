# Pre-registration — post-`#71` layout residue (`phase4-layout-residue-01`)

Written and committed **before the first non-dry-run attempt**. Nothing below
may be changed once rows exist; any amendment must be appended with its date and
reason.

## Question

After `(` began suspending layout, does enough layout-attributed failure residue
remain in an ordinary Aven holdout sweep to justify building the significant-
indentation versus explicit-block-marker A/B from #67?

This is one Aven arm, not the A/B. The run uses the 71-task holdout set,
`opencode-go/deepseek-v4-flash`, three repair rounds, two nudges, hidden suites,
`no-verify`, bubblewrap, skill doc v4, and pinned aven-lang commit
`af52d49f176333941fa5d5420f62403ded6e5e15`.

## Classification unit

Every non-green model-authored round retained by the run is inspected from its
source artifact together with its diagnostics. A round is layout-attributed
only when the source and diagnostic/replay evidence show that indentation,
layout separators, or a line-break-sensitive parse is the cause. An ordinary
syntax, name, type, runtime, or wrong-output failure merely reported near a
newline is not layout-attributed.

The decision threshold is task-level: a task counts once if any of its usable
rounds has a source-verified layout-attributed failure. Repair rounds therefore
cannot multiply one task into several votes. `harness_error` attempts are not
usable language observations and are excluded; a retry of such a natural key
replaces the missing observation for this decision.

Episode-level counts and syntactic-shape distributions will also be reported so
the result can be compared descriptively with #52, but they do not determine
the threshold.

## Decision threshold

A **substantial layout residue** survives if at least **7 of the 71 usable
tasks** (9.9%, approximately one task in ten) contain a layout-attributed failed
round.

Seven tasks is chosen in advance as the smallest residue broad enough to justify
the implementation and interpretation cost of a new syntax wrapper: it says
layout still obstructs roughly one in ten representative tasks, rather than a
few isolated solutions. At 6 or fewer tasks, the recommendation will be not to
build the #67 A/B on this evidence. This is a decision threshold for a single
recorded sweep, not an inferential population estimate.

If fewer than 71 usable tasks remain after the one permitted harness-error retry
pass, the proportional rule is used instead: substantial means at least 10% of
usable tasks, rounding up. Harness errors and any retry are reported explicitly.

## Comparability

Headline pass and first-shot rates will be reported, but neither is compared
causally with `phase3-holdout-06`: both the skill document (v2 to v4) and
compiler (`86ee877` to `af52d49`) moved. The comparison of interest is the shape
of the source-verified layout taxonomy, especially against #52's finding that
non-suspending parentheses plus broken method chains made up about 48% of its
layout failures.
