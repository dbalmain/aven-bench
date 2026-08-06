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
| `../adapters/agent/` | harness adapters: `opencode`/`codex` real; the other entries are stubs |

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
  `repairRounds[].modelToolInvocations` — that is the end-of-sweep
  self-verification signal. `shellCommands` still records shell tool use
  (often exploration under the sandbox) but is not treated as contamination by
  itself. `--self-verify` flips the policy and mounts `aven` into the model
  namespace when `AVEN_BIN` is set.
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

The agent harness (`opencode run` or `codex exec`, plus every model-requested
shell command it launches) runs inside bubblewrap by default. The trusted probes
in this table run outside it: they need the generated suite and are harness
verification, not model-controlled code.

| language | gating probes             | recorded only |
| -------- | ------------------------- | ------------- |
| aven     | `aven check`, `aven test` | —             |
| python   | `solution_test.py`        | `mypy`        |
| ruby     | `solution_test.rb`        | —             |

Ruby gates on the suite alone: there is no static gate to record, and running
`ruby solution_test.rb` leaves no bytecode behind, so hiding the suite between
rounds needs nothing beyond deleting it (unlike Python's `__pycache__`).

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

Codex bills against a subscription but emits no cost field. Its rows therefore
record `costUsd: null` and `priceSource: "unknown"`; zero would incorrectly claim
the harness was free. Token counts and `shadowCostUsd` remain available.

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
run-notes.json                  tracked free-text descriptions (outside data/)
```

Nothing under `data/` is ever rewritten. Analysis is DuckDB over
`data/runs/*.jsonl` — see `analysis/`. Work directories carry nothing durable:
the solution, every round's prompt, the harness log, the session log and the
suite are all in the artifact store before the directory is removed.
`--keep-work` keeps them.

`--note "…"` records a run-level free-text description on every attempt row
(`runNote`, schema 9). Because `data/` is gitignored, the committed
`run-notes.json` (keyed by run id) is the durable, editable source — the live
dashboard prefers a non-empty entry there over the launch-time flag.

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

- bubblewrap gives the agent harness a mount namespace containing the current
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
  Under sandboxed `no-verify` the summary reports that as activity, not as a
  contamination flag; `modelToolInvocations > 0` is what gets a loud warning.

Every attempt records `sandbox: "bubblewrap" | "none"`, so containment is
auditable per row. A nonzero escape count on a sandboxed row says the model
named an outside path and the namespace denied it; on an unsandboxed row it
remains a contamination warning.

## Resume

An attempt is identified by `attemptKey()`: task, language, model, harness,
`docId`, aven commit, sample index, tool policy, suite visibility, sandbox
mode, the generated-contract version, the nudge budget (when nonzero), and
`diagnosticFormat` (when not the legacy `text` default). Resume reads **every**
log under `data/runs/`, so re-running the same experiment adds nothing while a
policy or contract change schedules a distinct attempt:

```sh
bun run bench … --run-id calib-03     # 8 attempts
bun run bench … --run-id calib-03     # "8 records in 1 log(s) -> 8 skipped, 0 to run"
```

`harness_error` rows count as present too, so a network blip is never quietly
re-rolled into a model failure. `--retry-harness-errors` re-attempts those keys
deliberately; it appends a new row and leaves the old one alone.

## Failure handling

| what happened                              | recorded as                          |
| ------------------------------------------ | ------------------------------------ |
| bad model id, provider error, opencode ≠ 0 | `harness_error`                      |
| harness or tool exceeded its timeout       | `timeout`                            |
| gate process killed by a signal (not timeout) | `harness_error` (probe `signal` set) |
| agent turn returned **no tokens at all**   | `harness_error` (`agent-no-tokens`)  |
| model wrote no solution file, after nudges  | `refusal`                            |
| gate tool could not be run at all          | `harness_error` (`gate-unavailable`) |
| suite would not load / parse               | `parse_error`                        |
| `aven check` rejected it                   | `check_error`                        |
| a case raised                              | `runtime_error`                      |
| a case asserted                            | `wrong_output`                       |
| every gating probe green                   | `pass`                               |

A harness failure ends the attempt with whatever rounds already happened and is
never folded into a model failure or retried in place.

`harnessErrorKind` (schema 5) names the cause when the runner recognises one:
`agent-no-tokens`, `agent-failed`, `gate-unavailable`, `runner-exception`.

**A model that answers in chat is nudged, not scored as a refusal.** A turn that
writes no file gets up to `--max-nudges` (default 2) deterministic re-asks naming
the missing file, then the round proceeds normally; `nudges` on the row says it
happened. This is not politeness — in `phase3-holdout-02` 37 of 213 rows were
scored `refusal` and none were refusals: all 37 made zero tool calls and 36
replied with the finished program in a fenced block, `hello-world` among them.
The miss split 20 Aven / 11 Ruby / 6 Python, so a harness-contract failure was
being read as a language gap of up to 31 points. The nudge says nothing about the
task or the language, so a rescued solution is still the model's first shot and
still scores `firstShotPass`; filter on `nudges` if you disagree. `--max-nudges 0`
restores the old behaviour and resumes against the pre-schema-8 rows, because the
nudge budget joins the natural key.

**`--diagnostic-format text|agent` (default `text`) is an independent variable,
not a convenience flag.** It chooses how Aven compiler diagnostics are rendered
into the repair prompt: `text` is ariadne (box-drawing gutter, carets, `Note:`
lines); `agent` is `aven check --format agent` (one line per diagnostic plus
indented `in:` / `at:` / `help:`). The JSON gate probe is unchanged — only the
text the model reads on a failed check differs. The field joins the natural
key, so the arms never pool. It is Aven-only in effect: Python and Ruby rows
always record `diagnosticFormat: "text"` (they never saw an Aven diagnostic),
which keeps control rows shared across format arms instead of re-buying them.
Pre-schema-10 rows lack the field and resume as `text`.

**A turn that billed nothing measured nothing.** Zero tokens in every category
_and_ no solution file is the provider, not the model, so it outranks both
`timeout` and `refusal` — a real timeout burns tokens, and a refusal bills for
the prose it refuses in. `timedOut` still records that a process was killed, so
the process-level truth survives the reclassification. This matters twice:
harness errors are outside the capability denominator, and
`--retry-harness-errors` can re-attempt these keys once the provider is back.

## Dead models

Individual models on the opencode gateway stop answering mid-sweep, and the
harness used to have no idea. Measured once, for real: from 12:20 in
`phase2-calibration-02` every `opencode/big-pickle` attempt came back
`outcome=timeout, roundsUsed=1, wallMs≈420000`, zero tokens — ten consecutive
rows that look exactly like a model failing ten tasks slowly. Probed by hand
afterwards,
`opencode run --model opencode/big-pickle "Reply with exactly the word OK and nothing else."`
hung past 120s while `opencode/ling-3.0-flash-free` answered in about a second.
At 71 tasks and four jobs, a dead model costs ~2 hours of wall clock and
silently corrupts the pass-rate deltas.

Two defences, and the classification above is the third:

- **Preflight.** Before anything is planned, each requested model gets one
  trivial turn (`AgentAdapter.probeModel`, `--preflight-timeout`, default 120s).
  Models that fail are printed with the reason and dropped — not attempted, so
  no rows exist and a later run picks them up cleanly. If that leaves nothing,
  the run refuses to start. `--no-preflight` skips the probe. The probe's tokens
  and cost are reported beside the run's cost and never inside it, the same rule
  the survey turn follows. Note `agent.available()` is a different question: it
  checks the harness, and `opencode --version` was happy throughout.

  The default is 120s rather than 60s. A measured live probe answers well inside
  either budget (`opencode/ling-3.0-flash-free`, 19.3s wall, reply `OK`), but
  the ~2 minute cold opencode start documented under "Concurrency and timeouts"
  does not, so a 60s budget would drop a live model on the first sweep after a
  reboot for being merely cold. Two minutes per dead model is a rounding error
  against the ~2 hours the breaker exists to save, so the budget is set by the
  cold-start case, not the warm one. A drop is loud rather than silent either
  way: it prints `DEAD … no reply within Ns` and is listed again in the summary.

- **A per-model circuit breaker.** Two trip conditions, same open/skip/report
  machinery. After `--breaker-threshold` consecutive zero-token attempts
  (default 3; `0` disables it), or — when opted in — after the zero-token share
  in a sliding window exceeds `--breaker-rate` (default **0 = off**, window
  `--breaker-window` default 10), the model's remaining planned attempts are
  skipped rather than dispatched. Skipped, not recorded: a row would assert an
  attempt that never happened, and since resume counts `harness_error` rows as
  present, the next run would need `--retry-harness-errors` to do work this one
  simply never did. Any attempt that measured something — a wrong answer, a
  refusal, a token-burning timeout — clears the consecutive streak, so the
  consecutive trip can never stop measuring a model that is merely bad. The rate
  trip is off by default on purpose: abandoning a model that works half the time
  changes what the benchmark measures, so it is an explicit opt-in per run (it
  exists for the intermittent case consecutive streaks miss, observed live on
  `laguna-s-2.1-free`). Other models are unaffected, and every tripped model is
  named in the end-of-run summary with which condition fired.

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
sandbox mode to the model-driven process. Two optional methods are worth having:
`sessionLedger` (the harness's own cost total, which cross-checks the event
parsing) and `probeModel` (one cheap turn against one model, which is what makes
preflight possible; an adapter without it simply gets no preflight). `pi`,
`little-coder` and `ollama` are registered as stubs that fail immediately with a
reason — raw `ollama` in particular is not an agent at all and needs a decision
about how much scaffolding is fair before it is comparable.

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
