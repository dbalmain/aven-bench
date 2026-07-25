# analysis

DuckDB over `data/runs/*.jsonl`. No database to maintain, trivially
re-derivable, greppable when a number looks wrong.

```sh
duckdb -c ".read analysis/queries.sql"
```

`data/runs/` does not exist until the runner does (see `runner/README.md`), so
these queries are written against the schema in `runner/schema.ts` rather than
against data. Treat them as the spec for the two ranked worklists in §6 of
`PLAN-aven-bench.md`.

Everything reported is **holdout only** — join against `corpus/split.json`.
