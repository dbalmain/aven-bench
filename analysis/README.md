# analysis

DuckDB over `data/runs/*.jsonl`. No database to maintain, trivially
re-derivable, greppable when a number looks wrong.

```sh
duckdb -c ".read analysis/queries.sql"
```

`data/runs/*.jsonl` is written by the runner (`bun run bench`; see
`runner/README.md`). The queries follow §6 of `PLAN-aven-bench.md`: the language
worklist, the ergonomics worklist and the diagnostics worklist, plus four checks
the first real sweep showed were needed — check/test divergence, mypy as
non-gating data, the work-directory contamination guard, and `no-verify`
compliance.

The two ranked worklists report **holdout only** — they join against
`corpus/split.json`. The four checks deliberately do not: a contaminated or
non-compliant row is worth seeing whichever arm it came from.
