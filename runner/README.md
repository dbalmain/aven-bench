# runner — not built yet

This directory is a deliberate stub. The corpus half of Phase 1 is done; the
model runner is a separate piece of work.

What exists:

- `schema.ts` — the attempt record (§3d of `PLAN-aven-bench.md`), written down
  first because the plan says it cannot be retro-collected. Any field the first
  run fails to capture is a question the dataset can never answer.

What the runner still needs, from §3c:

- fully non-interactive, `--dry-run`
- N-way parallel with per-adapter concurrency caps
- resumable: skip attempts already in the log by `attemptKey()`
- hard timeouts
- network failures recorded as `harness_error`, never silently retried into the
  data
- `AVEN_SESSION_LOG` set per attempt so the whole repair sequence is inherited
  rather than scraped from stderr (§3b — also not built)
- agent adapters under `adapters/agent/` (opencode, pi, little-coder,
  claude-code, grok)

What it can already rely on:

- `bun run generate --lang aven,python --intersect` materializes a work
  directory per task per language, containing the suite, the prompt, and nothing
  else. `--intersect` restricts every arm to the cases all arms can express,
  which is what a fair A/B needs.
- `adapters/lang/*.testCommand(dir)` gives the argv, and `classifyExit(code)`
  the verdict. Both languages emit the same JSON envelope
  (`ok`/`total`/`passed`/`failed`/`errored`/`cases[]`) and the same 0/1/2 exit
  codes, so one parser reads both arms.
- `AVEN_BIN=<path to aven>` skips cargo's per-invocation overhead. Set it.
- `corpus/split.json` is the frozen tune/holdout split. Report holdout only.
