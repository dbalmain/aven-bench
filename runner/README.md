# runner

Drives one (task, language, model, agent-harness) combination: prompt the model
to write a solution, gate it with the language's real tooling, feed the
diagnostics back for a bounded number of repair rounds, and append one JSONL
attempt record per attempt.

```sh
bun run bench --help

# the shape of a real sweep
AVEN_BIN=../aven-lang/target/debug/aven \
bun run bench --lang aven,python --intersect \
              --model opencode/deepseek-v4-flash-free \
              --task-set tune --rounds 2 --jobs 4 --run-id calib-03
```

## Files

| file                 | what it owns                                                          |
| -------------------- | --------------------------------------------------------------------- |
| `schema.ts`          | the attempt record (§3d) and the natural key resume uses              |
| `run.ts`             | CLI, planning, resume, concurrency, the summary                       |
| `attempt.ts`         | one attempt: rounds, prompts, gate, record assembly                   |
| `gate.ts`            | the probes (`aven check`, `aven test`, `python`, `mypy`) and outcomes |
| `prompt.ts`          | round-0 and repair prompts                                            |
| `prices.ts`          | the local price table — `cost_usd` is computed here, never read back  |
| `store.ts`           | append-only JSONL, content-addressed artifacts, the resume index      |
| `session.ts`         | `AVEN_SESSION_LOG` reader and the phase tagging scheme                |
| `proc.ts`            | subprocess with a hard timeout; semaphores                            |
| `tokens.ts`          | the size-metric estimator (`heuristic-v1`)                            |
| `../adapters/agent/` | harness adapters: `opencode` real, `pi`/`little-coder`/`ollama` stubs |

## The two metrics

`firstShotPass` is round 0's verdict and measures the **documentation**.
`roundsToGreen` is the index of the first green round and measures the
**diagnostics**. Every round carries its own tokens, probes, diagnostic codes,
prompt hash and outcome, so a repair sequence can be replayed from the record
alone.

`firstShotPass` is only meaningful together with two recorded policy fields:

- **`toolPolicy`** (default `no-verify`) — the model is told not to run the
  compiler or the suite. An agent that loops on the compiler measures the
  compiler, not the docs. Compliance is measured, not assumed: on the Aven arm
  every `aven` the model runs itself lands in the session log and is counted as
  `repairRounds[].modelToolInvocations`. `--self-verify` flips the policy.
- **`suiteVisibility`** (default `visible`) — the generated suite is in the work
  directory and the model may read it, which is what an Exercism user sees.
  `--hide-suite` withholds it until the gate runs. Both are legitimate
  experiments; pooling them is not.

## Gates and probes

Every tool invocation is recorded as a probe with its own verdict, exit code,
timing and diagnostics. `gating: false` means recorded-but-not-decisive;
`ok: null` means the tool could not be run at all.

| language | gating probes             | recorded only |
| -------- | ------------------------- | ------------- |
| aven     | `aven check`, `aven test` | —             |
| python   | `solution_test.py`        | `mypy`        |

**Aven is gated on `check` AND `test`** — and both are recorded separately
regardless, because the two disagree in practice. A real example from the first
sweep: `leap` round 0 passed 9/9 cases under `aven test` while `aven check`
rejected it with `type.invalid-operator-operands` (`==` is not defined for
`?Int` and `Int`). Collapsing that into one bit would have hidden it.

Because many generated Aven suites are themselves rejected by `aven check` for
reasons unrelated to any solution, the record also carries
`checkOkSolutionOnly`: false only when a check error points at `solution.av`.

**mypy is data, not a gate.** Python's bar stays "the tests pass" on purpose —
running without a static gate is how Python is actually used, and holding the
control arm to Aven's `check`-and-`test` bar would flatter Aven. mypy output is
also deliberately _not_ fed back in repair rounds, for the same reason. It is the
lever for making the comparison symmetric later, if that becomes the experiment.

Resolution order is `MYPY_BIN`, then `mypy` on `PATH`, then `python3 -m mypy`.
The probe records the version it found (here `mypy 1.20.1 (compiled: yes)`) and
normalizes each finding: the whole line is the message, the trailing bracket
becomes the code, path and line are parsed out.

```
solution.py:2: error: Incompatible return value type (got "bool", expected "str")  [return-value]
  -> { code: "mypy.return-value", severity: "error", path: "solution.py", line: 2 }
```

Worked example: `leap` with `def leap_year(year: int) -> str` returning a bool
gives `test ok` / `mypy not ok`, and the attempt's outcome is still `pass` —
mypy's verdict lands in `mypyOk` and nowhere else.

If mypy is absent the probe records `ok: null` plus a reason (`ok: false` would
claim it found problems) and everything else still works:

```sh
MYPY_BIN=/path/to/mypy bun run bench …      # point at a specific one
nix-shell -p mypy --run 'bun run bench …'   # or bring one along
bun run bench --no-mypy …                   # or skip the probe entirely
```

## Cost

`costUsd` is computed in `prices.ts` from token counts, **never** read back from
the harness. The free opencode models report `cost: 0` no matter how much they
burn, so trusting the harness would erase the cost axis exactly where the data
is thickest. A model with no table entry records `costUsd: null` and
`priceSource: "unknown"` rather than a fabricated zero; what the harness claimed
is kept alongside as `reportedCostUsd`. Extend the table without editing the
file:

```sh
AVEN_BENCH_PRICES=my-prices.json bun run bench …
# { "version": "2026-08", "models": { "opencode-go/glm-5.2": { "in": 0.5, "out": 1.5 } } }
```

## Data layout

```
data/runs/<run-id>.jsonl        append-only attempt records, one line each
data/artifacts/<ab>/<sha256>.*  solutions, prompts, harness logs, session logs
~/.cache/aven-bench/work/…      per-attempt work directory, pruned when it ends
```

Nothing is ever rewritten. Analysis is DuckDB over `data/runs/*.jsonl` — see
`analysis/`. Work directories carry nothing durable: the solution, every round's
prompt, the harness log, the session log and the suite are all in the artifact
store before the directory is removed. `--keep-work` keeps them.

## Contamination

The models try to read things outside their work directory, and on the first real
sweep they succeeded twice:

1. With work directories under `data/work/`, opencode resolved its project root
   to the enclosing git repository and read `references/acronym/solution.av` —
   the hand-written answer to the task it was solving.
2. Moved to `/tmp/aven-bench-work`, models globbed `/tmp/**/*.av` and found
   `/tmp/aven-audit/*.av` and a checkout of `crates/aven-host/std/*.av` left
   there by unrelated work, plus each other's work directories.

Three defences, none of which is a sandbox:

- the work root defaults to `~/.cache/aven-bench/work` — outside the repo, and
  not a shared junk drawer. The runner **refuses** a work root inside a git
  repository unless `--allow-repo-workdir`;
- every attempt directory is `git init`-ed, which is what scopes opencode's own
  glob and grep. Verified: with it, `glob **/*.av` returns only the attempt's own
  file;
- every round records `outsideWorkdirTouches` and a sample of `escapedPaths`, and
  the run summary shouts about any nonzero count.

An agent can still read anything its user can, so **a row with
`outsideWorkdirTouches > 0` is evidence of nothing** — `analysis/queries.sql`
lists them so they can be excluded. A real fix is an OS sandbox (`bwrap` is on
this box); it is not wired up.

## Resume

An attempt is identified by `attemptKey()`: task, language, model, harness,
`docId`, aven commit, sample index. Resume reads **every** log under
`data/runs/`, so re-running the same command adds nothing:

```sh
bun run bench … --run-id calib-03     # 8 attempts
bun run bench … --run-id calib-03     # "8 records in 1 log(s) -> 8 skipped, 0 to run"
```

`harness_error` rows count as present too, so a network blip is never quietly
re-rolled into a model failure. `--retry-harness-errors` re-attempts those keys
deliberately; it appends a new row and leaves the old one alone.

## Failure handling

| what happened                              | recorded as     |
| ------------------------------------------ | --------------- |
| bad model id, provider error, opencode ≠ 0 | `harness_error` |
| harness or tool exceeded its timeout       | `timeout`       |
| model wrote no solution file               | `refusal`       |
| gate tool could not be run at all          | `harness_error` |
| suite would not load / parse               | `parse_error`   |
| `aven check` rejected it                   | `check_error`   |
| a case raised                              | `runtime_error` |
| a case asserted                            | `wrong_output`  |
| every gating probe green                   | `pass`          |

A harness failure ends the attempt with whatever rounds already happened and is
never folded into a model failure or retried in place.

## Concurrency and timeouts

`--agent-jobs` (default 3) bounds harness calls; `--lang-jobs` (default 8)
bounds compiler/interpreter runs; `--jobs` bounds whole attempts and defaults to
`--agent-jobs`. `--agent-timeout` defaults to 900s because a **cold** opencode
start took ~2 minutes before its first event in testing (warm calls are ~6s) —
size for the cold case or the first attempt of a sweep dies for a reason that
has nothing to do with the model. `--tool-timeout` defaults to 120s.

## Aven wiring

- `AVEN_BIN` should point at a built `aven` (`cargo build -p aven` in
  `aven-lang`; the crate is `aven`, not `aven-cli`). Without it every invocation
  goes through `cargo run`, which is slow and can rebuild mid-sweep — the runner
  warns. `AVEN_LANG_DIR` overrides where the workspace lives.
- Each attempt gets `AVEN_SESSION_LOG=<workdir>/session.jsonl` and
  `AVEN_SESSION_TAG=<attemptId>`. The runner's own gate invocations use
  `<attemptId>#gate.r<N>.<probe>`, so the attempt id stays a prefix while the
  two phases remain distinguishable — that difference is what makes
  `modelToolInvocations` measurable. The whole log is stored as an artifact
  (`sessionLogHash`).
- Both the aven-lang commit **and** a hash of the binary in use are recorded.
  The commit alone does not pin a build: `AVEN_BIN` is usually a `target/debug`
  binary that may predate `HEAD`. A/B halves that disagree are then detectable
  rather than mysterious.

## Adding a harness

Implement `AgentAdapter` in `adapters/agent/` and register it. The contract is
three lines: never throw (a failure is `ok: false` plus `harnessError`), always
report token counts, honour `timeoutMs`. `pi`, `little-coder` and `ollama` are
registered as stubs that fail immediately with a reason — raw `ollama` in
particular is not an agent at all and needs a decision about how much
scaffolding is fair before it is comparable.

## Acceptance recipe

What was actually run to prove this works:

```sh
export AVEN_BIN=../aven-lang/target/debug/aven

# four tasks, both arms, one free model, intersected case sets
bun run bench --lang aven,python --intersect --rounds 2 --jobs 4 \
              --model opencode/deepseek-v4-flash-free \
              --tasks two-fer,leap,hamming,raindrops --run-id calib-03

# resume: the identical command again -> "8 skipped, 0 to run", 0 records written
# harness_error: a model id that does not exist
bun run bench --lang python --model opencode/definitely-not-a-model \
              --tasks two-fer --run-id bogus-model

# resume policy on that row: skipped by default, re-attempted only on request
bun run bench … --run-id bogus-model --dry-run                        # skip
bun run bench … --run-id bogus-model --retry-harness-errors --dry-run # run

# the mypy-unavailable path (probe records ok: null, the attempt is unaffected)
MYPY_BIN=/nonexistent/mypy bun run bench --lang python --tasks acronym \
              --model opencode/deepseek-v4-flash-free --run-id mypy-null
```

That sweep also exercised, without being asked to: the repair loop reaching green
at round 1 (`raindrops`, Aven), the round cap being exhausted (`two-fer`, Aven,
`roundsToGreen: null`), and the hard timeout (`hamming`, Aven — opencode hung and
was killed at 900s, recorded as `outcome: "timeout"`).

## Not built

- `--temperature` / `--seed` are recorded but opencode exposes no knob for
  either, so on that harness they document intent rather than control anything.
- `docTokens` and `solutionTokens` use `tokens.ts`'s heuristic, not a real BPE
  tokenizer. Recorded under `tokenEstimator` so a later change is detectable.
- The 2×2 doc/model attribution grid (§4 of the plan) is a scheduling layer over
  this runner, not part of it.
