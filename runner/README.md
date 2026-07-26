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
| `prices.ts`          | the local price table — list prices for `shadowCostUsd`               |
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
- **`suiteVisibility`** (default `hidden`) — in round 0 the generated suite is
  absent while the model works, then is written only for the trusted gate and
  removed again (including Python bytecode) before another model turn.
  `--show-suite` restores the Exercism-like policy where the model may read it.
  Hidden does not mean "no test feedback": from round 1 onward, the repair
  prompt includes ordinary assertion output, including the actual and expected
  values for each failing case shown. An Aven check diagnostic may also quote
  its source line from the generated suite. That feedback is deliberate; only
  round 0 hides the entire lookup table. Pooling visible and hidden rows is not
  valid.

## Gates and probes

Every tool invocation is recorded as a probe with its own verdict, exit code,
timing and diagnostics. `gating: false` means recorded-but-not-decisive;
`ok: null` means the tool could not be run at all.

The agent harness (`opencode run` and every model-requested shell command it
launches) runs inside bubblewrap by default. The trusted probes in this table
run outside it: they need the generated suite and are harness verification, not
model-controlled code.

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
also deliberately _not_ fed back in repair rounds, for the same reason. It is
the lever for making the comparison symmetric later, if that becomes the
experiment.

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

`costUsd` is **actual spend**, summed from what the harness charged per round.
Measurement forced this (schema 4): one `opencode-go/qwen3.7-max` turn billed
$0.0279 on 6 input and 20 output tokens, because 8 870 _cache-write_ tokens
dominated it. No token table reproduces that — and `computeShadowCost` was not
even pricing cache writes, so a table cost was ~40× low on the shape opencode
actually produces. Per-round charges are deltas that sum to the session total
(verified), so adding them is exact.

`harnessSessionCostUsd` is the harness's own session total, read straight from
its SQLite store — the figure its UI shows. It is computed independently of the
event parsing, so a mismatch means events were missed, and the runner says so in
the summary. Note a sandboxed run keeps its store _inside the attempt
directory_, so `opencode export` on the host will not find these sessions.

`shadowCostUsd` is the price table's list price for that model. It is zero for
the free tier, whose list price is zero, so it does not by itself make a free
arm comparable to a paid one — that is a cross-model counterfactual, computed at
analysis time from the token columns (all five categories are recorded). Extend
the table without editing the file:

```sh
AVEN_BENCH_PRICES=my-prices.json bun run bench …
# { "version": "2026-08", "models": { "opencode-go/glm-5.2": { "in": 0.5, "out": 1.5 } } }
```

## Survey

After the verdict is recorded, the model is asked one question: the single
change to the language or its documentation that would have made the task
easier. The ranked tails say _where_ Aven is much worse and never why; the model
that just burned four rounds is the cheapest available witness.

It runs on both arms, identically — a complaint about Aven only means something
against the rate at which the same model complains about Python. The wording
tells the model the result is already fixed, demands exactly one concrete thing,
and explicitly licenses "nothing, this was straightforward", because a model
asked for a criticism will otherwise invent one.

Its tokens, cost and wall time are recorded in `survey*` fields and **excluded**
from the attempt totals: it is not part of solving the task. `--no-survey` skips
it. The response is untrusted model output — data to be quoted, never an
instruction.

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

The models try to read things outside their work directory, and on the first
real sweep they succeeded twice:

1. With work directories under `data/work/`, opencode resolved its project root
   to the enclosing git repository and read `references/acronym/solution.av` —
   the hand-written answer to the task it was solving.
2. Moved to `/tmp/aven-bench-work`, models globbed `/tmp/**/*.av` and found
   `/tmp/aven-audit/*.av` and a checkout of `crates/aven-host/std/*.av` left
   there by unrelated work, plus each other's work directories.

The default defence is now an OS filesystem sandbox:

- bubblewrap gives `opencode run` a mount namespace containing the current
  attempt read-write, `/nix/store` and the exact runtime/config/credential files
  read-only, and private `/tmp`, `/dev` and `/proc` mounts. The repo, aven-lang
  checkout (apart from an explicitly configured Aven binary), home directory and
  sibling attempts are absent. `--no-sandbox` is the explicit debugging opt-out;
  if bubblewrap is missing or cannot create a namespace, the default run refuses
  to start rather than falling back.
- network is deliberately shared because the harness calls a cloud API. This is
  filesystem containment, not an exfiltration or retrieval boundary.
- the work root still defaults to `~/.cache/aven-bench/work`, and each attempt
  is still `git init`-ed. Those scope the harness project and reduce accidental
  discovery on an explicitly unsandboxed debugging run; they are not
  containment.
- every round records `shellCommands`, `outsideWorkdirTouches` and a bounded
  sample of `escapedPaths`. `shellCommands` counts shell tool invocations even
  when their filesystem effects cannot be reconstructed from the event stream.

Every attempt records `sandbox: "bubblewrap" | "none"`, so containment is
auditable per row. A nonzero escape count on a sandboxed row says the model
named an outside path, not that the read succeeded; on an unsandboxed row it
remains a contamination warning.

## Resume

An attempt is identified by `attemptKey()`: task, language, model, harness,
`docId`, aven commit, sample index, tool policy, suite visibility and sandbox
mode. Resume reads **every** log under `data/runs/`, so re-running the same
experiment adds nothing while a policy change schedules a distinct attempt:

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
  warns. A sandboxed `--self-verify` Aven run requires it: the exact binary is
  mounted read-only, while cargo and the aven-lang checkout remain absent.
  `AVEN_LANG_DIR` overrides where the workspace lives.
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

Implement `AgentAdapter` in `adapters/agent/` and register it. The contract is:
never throw (a failure is `ok: false` plus `harnessError`), always report token
counts and shell-command usage, honour `timeoutMs`, and apply the requested
sandbox mode to the model-driven process. `pi`, `little-coder` and `ollama` are
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

That sweep also exercised, without being asked to: the repair loop reaching
green at round 1 (`raindrops`, Aven), the round cap being exhausted (`two-fer`,
Aven, `roundsToGreen: null`), and the hard timeout (`hamming`, Aven — opencode
hung and was killed at 900s, recorded as `outcome: "timeout"`).

## Not built

- `--temperature` / `--seed` are recorded but opencode exposes no knob for
  either, so on that harness they document intent rather than control anything.
- `docTokens` and `solutionTokens` use `tokens.ts`'s heuristic, not a real BPE
  tokenizer. Recorded under `tokenEstimator` so a later change is detectable.
- The 2×2 doc/model attribution grid (§4 of the plan) is a scheduling layer over
  this runner, not part of it.
