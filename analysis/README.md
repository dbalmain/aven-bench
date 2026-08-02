# analysis

DuckDB over `data/runs/*.jsonl`. No database to maintain, trivially
re-derivable, greppable when a number looks wrong.

```sh
duckdb -c ".read analysis/queries.sql"
```

## Diagnostic format A/B (`diagfmt-01`)

Pre-registration: [`prereg-diagfmt-01.md`](prereg-diagfmt-01.md). Analysis
(written before the sweep finished):

```sh
bun run analysis/diagfmt-ab.ts
bun run analysis/diagfmt-ab.ts --json
```

Reads `data/runs/phase4-diagfmt-text-01.jsonl` and
`phase4-diagfmt-agent-01.jsonl`. Tolerates a truncated final JSONL line (live
append). Does **not** offer a filter on post-exposure failure — that collider
is forbidden by the pre-registration.

`data/runs/*.jsonl` is written by the runner (`bun run bench`; see
`runner/README.md`). The queries follow §6 of `PLAN-aven-bench.md`: the language
worklist, the ergonomics worklist and the diagnostics worklist, plus four checks
the first real sweep showed were needed — check/test divergence, mypy as
non-gating data, the work-directory contamination guard, and `no-verify`
compliance.

The two ranked worklists report **holdout only** — they join against
`corpus/split.json`. The four checks deliberately do not: a contaminated or
non-compliant row is worth seeing whichever arm it came from.

## Read the health section first

Every rate in `queries.sql` is built on the `measured` view, which drops
`harness_error` rows: those measured the _provider_, not the model. §3c requires
that exclusion, and the "harness health" section reports how many rows it
removed per model. A model whose row count is far below its peers was dropped by
preflight or abandoned by the circuit breaker, and needs re-running before its
arm means anything — the numbers above it will look plausible either way, which
is exactly why the health section comes first.

The "legacy poisoned rows" query exists because logs written before schema 5
recorded a dead provider as `outcome: 'timeout'` with zero tokens everywhere,
which is indistinguishable from a slow model by outcome alone. It should report
zero rows. If it does not:

```sh
bun run quarantine            # dry run, prints what would move
bun run quarantine --apply    # moves them to data/runs/quarantine/
```

Rows are moved rather than deleted, and the tool skips any log written in the
last five minutes on the assumption a sweep still owns it.

## The control arm is not Python specifically

`baseline_by_task` takes the **best** control language per task, so adding Ruby
or any other control needs no query changes — anything that is not `aven` counts
as a control. The ergonomics worklist instead takes the _smallest_ control
solution, which maximises the ratio and is deliberately harsh on Aven: a
worklist's job is to nominate candidates for a human to read, so the ranking is
suspicion, not guilt.
