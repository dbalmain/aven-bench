# aven-bench

Benchmark harness for [Aven](https://github.com/dbalmain/aven-lang): drive
coding models through a task corpus in Aven and in control languages, and use
the deltas to steer Aven's development.

**Status: the corpus (Phase 1) and the model runner (Phase 0c/0d) are built.**
One agent harness is real (opencode); `pi`, `little-coder` and `ollama` are
registered stubs. See `runner/README.md`.

## Layout

```
corpus/                 generated, committed. The oracle.
  index.json            task list, counts, per-task value kinds, skipped exercises
  split.json            the frozen tune/holdout split
  ingest-report.json    everything questionable the ingest found
  <task>/task.json      normalized cases: {property, args[], expected}
  <task>/prompt.md      the task statement, language-agnostic
annotations/            hand-authored; never wiped by ingest
  types/<task>.json     sparse type annotations (Map / variant) for Aven rendering
adapters/lang/          one adapter per language: render tests, run them, read exit codes
  common.ts             the LangAdapter interface
  aven.ts               the measured arm
  python.ts  ruby.ts    the control arms
  py_runner.py          normalizes unittest into `aven test --format json`'s envelope
  rb_runner.rb          the same, for minitest
adapters/agent/         one adapter per agent harness: prompt in, tokens + files out
  opencode.ts           the implemented harness
  index.ts              registry; pi / little-coder / ollama are stubs
ingest/                 vendor/ -> corpus/, plus generate and verify
references/             hand-written solutions, used only to verify the generators
runner/                 the model runner: prompt -> gate -> repair -> one JSONL row
analysis/               DuckDB queries over data/runs/*.jsonl
vendor/                 gitignored. Upstream problem-specifications checkout.
data/                   gitignored. Run logs + content-addressed artifacts.
```

`corpus/` is committed and fully generated. Upstream normalization is
task-agnostic: a task an adapter cannot express is reported as omitted, not
special-cased. Hand-designed generated tasks live in `ingest/design-center/` and
are appended through a separate registry after upstream ingest.

`annotations/types/` is the opposite: hand-authored, sparse type annotations
(Aven type strings + optional variant encodings) consumed when rendering Aven
suites and contracts. Ingest never deletes this tree. Validate with
`bun run check-types` (see `annotations/README.md`).

## Corpus

Spine:
[`exercism/problem-specifications`](https://github.com/exercism/problem-specifications).

|                                    |                                                                      |
| ---------------------------------- | -------------------------------------------------------------------- |
| upstream exercises                 | 151                                                                  |
| upstream tasks with canonical data | **142**                                                              |
| design-center tasks                | **1**                                                                |
| corpus tasks                       | **143**                                                              |
| cases                              | **2256** (2310 upstream leaves, 64 superseded and dropped)           |
| cases expecting an error           | 169 (7.5%)                                                           |
| prompt layouts                     | 81 legacy `description.md`, 61 `introduction.md` + `instructions.md` |
| tune / holdout                     | 72 / 71                                                              |

## Running it

```sh
bun install

scripts/fetch-corpus.sh            # clone/update vendor/problem-specifications
bun run ingest                     # vendor/ -> corpus/   (regenerates it wholesale)
bun run generate:design-center     # regenerate only the hand-designed tasks
bun run split                      # extend corpus/split.json with any new tasks
bun run generate --lang aven,python --intersect
bun run verify                     # prove the generated suites are real
bun run check-types                # validate annotations/types against corpus
bun test                           # unit tests for the ingest, adapters and runner
bun run typecheck                  # bunx tsc --noEmit
```

Set `AVEN_BIN=/path/to/aven` to skip cargo's per-invocation overhead — the
sweeps are ~10x faster with it. `AVEN_LANG_DIR` overrides where the Aven
workspace lives (default `../aven-lang`).

### Running models against it

```sh
bun run bench --help

# one free model, both arms, the same case set on each, two repair rounds
AVEN_BIN=../aven-lang/target/debug/aven \
bun run bench --lang aven,python --intersect --rounds 2 --jobs 4 \
              --model opencode/deepseek-v4-flash-free \
              --tasks two-fer,leap,acronym --run-id calib-03

bun run bench … --dry-run          # print the plan, write nothing
bun run bench … --no-sandbox       # explicit debugging opt-out; recorded as sandbox: "none"
# Aven-only IV: which diagnostic rendering the model repairs from (joins the key)
bun run bench … --lang aven --diagnostic-format agent --run-id diag-agent-01
```

One JSONL row per attempt lands in `data/runs/<run-id>.jsonl`, append-only, with
solutions, prompts, harness logs and `AVEN_SESSION_LOG` transcripts
content-addressed under `data/artifacts/`. Re-running a command skips what is
already recorded, by natural key (including `--diagnostic-format`: `text` vs
`agent` are distinct experiments; control-language rows always record `text`).
Flags, gates, cost policy, failure taxonomy and the acceptance recipe are all in
**`runner/README.md`** — read that before starting a sweep. Model-driven harness processes run in a bubblewrap filesystem
sandbox by default; trusted gates run outside it. The sandbox keeps the network
because the harness calls a cloud API, so it is not an exfiltration boundary.

### What the first sweep showed

Four tasks (`two-fer`, `leap`, `hamming`, `raindrops`), both arms, one free
model (`opencode/deepseek-v4-flash-free`), no Aven skill doc, `--rounds 2`:

|                  | Python | Aven                                         |
| ---------------- | ------ | -------------------------------------------- |
| first-shot pass  | 4 / 4  | 1 / 4                                        |
| eventually green | 4 / 4  | 2 / 4 (one at round 1)                       |
| other outcomes   | —      | 1 `parse_error` (cap exhausted), 1 `timeout` |

Three findings that matter more than the numbers:

- **The models go looking for Aven examples on disk.** With no documentation,
  every Aven attempt that failed round 0 started globbing: first `references/`
  in this repo (the answers), then `/tmp/aven-audit/*.av` and a stray checkout
  of `crates/aven-host/std/*.av`, then sibling attempts' work directories. See
  "Contamination" in `runner/README.md` for the current bubblewrap boundary and
  its network limitation. The runner also records `outsideWorkdirTouches`,
  `escapedPaths`, `shellCommands` and sandbox mode per row.
- **These easy tasks do not discriminate on Python.** A free model passes all of
  them first shot, so Phase 2's weak-model band has to be found on harder tasks
  — this end of the corpus tells you nothing about a model.
- **`aven check` and `aven test` disagree in the field.** One `leap` solution
  passed 9/9 cases while the checker rejected it
  (`type.invalid-operator-operands`: `==` is not defined for `?Int` and `Int`).
  Both verdicts are recorded per round for exactly this reason.

### Re-fetching upstream

`scripts/fetch-corpus.sh` does a depth-1 clone (or `fetch` + `reset --hard`)
into `vendor/`, which is gitignored. Then re-run `bun run ingest` and
`bun run split`. Ingest wipes and rewrites every task directory, so an exercise
removed upstream cannot linger as a stale committed task; the design-center
registry then restores its generated tasks. `split` never moves an existing task
between arms; it only places new ones, and it carries any recorded `exceptions`
forward untouched. Use `bun run split --rewrite` to re-derive from scratch,
which invalidates every prior A/B.

`corpus/index.json` records the exact upstream commit. Each generated
design-center task records its generator version and seed in its own
`task.json`.

### The tune/holdout split

Deterministic, no randomness: sort the task ids, key each by
`sha256("aven-bench/tune-holdout/v1:" + id)`, sort by that key, first half tune
and second half holdout. Hashing rather than splitting the sorted ids keeps
related exercises (`binary`, `binary-search`, `binary-search-tree`) from all
landing in the same arm. Report holdout only.

Assignments do not move, so that a number from one sweep means the same thing as
a number from the next. Where one has been moved anyway, `split.json` carries an
`exceptions` entry saying which task, which direction, when and why — an
undocumented swap and a bug are indistinguishable after a few weeks.

One such move has been made, on 2026-08-01. `zebra-puzzle` went to tune and
`zebra-puzzle-generated` took its place in holdout. Upstream's zebra puzzle has
two zero-arity cases whose answers are common knowledge, so two constant returns
pass it and a holdout pass carried no information; the generated task takes the
puzzle's constraints as an argument, so the answer has to be derived. **Holdout
sweeps before that date measured the memorisable task**, which is worth knowing
when comparing them to later ones.

## How a suite is generated

The normalized case list is language-agnostic; each adapter turns it into a
runnable file that imports a solution file the model writes.

Aven — a module whose value is a record of zero-arg thunks returning `Result`:

```aven
test = import("std/test")
solution = import("./solution.av")

{
  "no name given": () => test.expectEq(solution.twoFer(null), "One for you, one for me."),
  "a name given": () => test.expectEq(solution.twoFer("Alice"), "One for Alice, one for me."),
}
```

Python — stdlib `unittest`, `import solution`, snake_case names.

Ruby — stdlib `minitest`, `require_relative "solution"`, snake_case names on a
module named `Solution`. The Exercism Ruby track's per-exercise class (`TwoFer`,
`ListOps`) was rejected: it makes the model guess a constant spelling the Python
arm never has to guess, and a wrong guess would be recorded as a language
failure. Assertions are parenthesized because `assert_equal {"a" => 1}, x` reads
the brace as a block, which is a syntax error.

All three are run through the same envelope:
`{ok, total, passed, failed, errored, cases[]}` and exit `0` all pass / `1` a
case failed / `2` the suite could not be loaded. Aven gets that from
`aven test --format json`; Python gets it from `adapters/lang/py_runner.py` and
Ruby from `adapters/lang/rb_runner.rb`.

**Error expectations.** 169 cases expect an error rather than a value. A
property with any such case is treated as fallible for _all_ its cases: Aven
compares against `@Ok(v)` and uses `expectErr`, Python uses
`assertRaises(ValueError)`, Ruby `assert_raises(ArgumentError)`. Each is that
track's idiom; every arm only checks that the failure happened, so the differing
class is not a scoring difference.

**Argument order.** `input` is a JSON object, so positional order comes from key
insertion order. `ingest/json.ts` is a hand-rolled JSON reader specifically to
preserve that (and raw number text), because `JSON.parse` silently reorders
integer-like keys and collapses `1.0` into `1`. Every property where the order
looks questionable is listed in `corpus/ingest-report.json`.

## Verifying the generators

`bun run verify` runs four checks and writes `data/verify-report.json`:

1. **Reference check** — every task under `references/` must go green against
   the generated suite, in every language that has a reference.
2. **Negative check** — every `references/*/solution.broken.*` fixture must be
   reported as _failing_. A generator that emitted a vacuous suite would pass
   check 1 and fail here.
3. **Load sweep** — all 143 tasks, run against a generated stub solution. The
   suite must fail (exit 1), never fail to load (exit 2).
4. **Check sweep** (Aven only) — `aven check` over the same suite+stub.
   `aven test` only parses and evaluates; `check` is the static gate, and the
   stricter bar.

### Results as of the first ingest

Upstream `22e2aa465858fc497ef3b6b9dbb82e706ac8569c`.

|                                 | Aven          | Python      |
| ------------------------------- | ------------- | ----------- |
| cases rendered                  | 2242 / 2246   | 2246 / 2246 |
| suites that load (exit ≠ 2)     | **142 / 142** | 142 / 142   |
| suites `aven check` accepts     | **81 / 142**  | n/a         |
| reference solutions green       | 7 / 7         | 7 / 7       |
| broken fixture reported failing | 1 / 1         | 1 / 1       |

The four omitted Aven cases are all integers too large for a 64-bit `Int`
(`armstrong-numbers` ×2, `grains` square 64 and the board total). `grains`'
`total` therefore has no testable case in Aven.

The 61 `aven check` rejections split cleanly:

- **44 tasks — `module.uppercase-export-not-type`.** Aven rejects a _quoted_
  record field name that begins with a capital letter when it appears in a
  module's export record, so any suite with a case description like
  `"Zero is an Armstrong number"` is statically invalid. `aven test` accepts the
  same file and passes. Minimal repro:

  ```aven
  test = import("std/test")
  { "Zero is fine at runtime": () => test.pass }
  ```

  The generator deliberately does not work around this by rewriting descriptions
  — they are the upstream data, and hiding it would remove the finding.

- **16 tasks — `type.incompatible-match-arms`.** The property's `expected`
  values have no single Aven type across cases: records of differing width
  (`word-count`, `etl`, `dot-dsl`, `parallel-letter-frequency`, `satellite`,
  `tree-building`), `null` mixed with a value (`binary`, `relative-distance`,
  `binary-search-tree`, `pov`, `word-search`, `zipper`, `alphametics`), or
  nested arrays of varying element shape (`accumulate`, `list-ops`, `strain`).
  Attributed to the verification stub rather than the suite — all 16 load and
  run — but a real solution faces the same modelling question.

- **1 task — `dnd-character`.** Not an example-based exercise: its `expected`
  values are assertion source text (`"score >= 3 && score <= 18"`). No adapter
  can make an oracle out of it; consider excluding it from headline numbers.

### The Ruby arm

Added after that snapshot, measured on the same upstream commit with nine
reference tasks: **2246 / 2246** cases rendered (no omissions), **142 / 142**
suites load, **9 / 9** reference solutions green, **1 / 1** broken fixture
correctly reported as failing — the same numbers Python posts on the run that
added it. Aven's own omission count is six by then, not four: the two extra are
`list-ops`' float-division folds, which Python gets natively, Ruby gets through
`fdiv`, and Aven cannot express at all.

### Aven ergonomics, from hand-writing the reference solutions

- **`Text` has no length and no character list.** No `length`, no `chars`, no
  indexing (`"abc"[0]` is a runtime type error), and `"abc".splitOn("")` returns
  `["abc"]`. The only way to walk a string is `slice(i, i + 1)` until it returns
  `""`, relying on `slice` clamping out of range —
  `references/hamming/solution.av` has to define its own `textLength` by
  recursion. Exercism is full of character-level string work; expect this to
  dominate the Aven failure tail.
- **No `\$` escape** (supported: `\\ \" \n \r \t \u{H}`), and `${` opens an
  interpolation, so a literal `$` has to be emitted as `\u{24}`.
- **`&&` / `||`, not `and` / `or`** — and `and` inside a `${}` interpolation
  reports `parse.unsupported-syntax` "this operator cannot appear in this
  position", which reads as if the operator exists elsewhere.
- **`Int` is 64-bit, no bignum path.** Four corpus cases are unrepresentable.
- **No approximate float assertion** in `std/test`, so the 9 float-bearing tasks
  compare exactly. Python was left comparing exactly too, so the arms stay
  comparable and are brittle in the same way.
- Worked first try: `?>` matching, `@Ok`/`@Err`, quoted record fields, ambient
  array methods (`fold` with no import). The `Result`-shaped `std/test` needed
  no extra machinery for the 169 error-expecting cases — the §3a bet paid off.

## Attribution and licence

The task corpus under `corpus/` is generated from
[`exercism/problem-specifications`](https://github.com/exercism/problem-specifications),
which is distributed under the **MIT License**, Copyright (c) 2014, 2019, 2021
Exercism. The upstream `LICENSE` text travels with the checkout in `vendor/`
(gitignored); a copy is kept in `corpus/UPSTREAM-LICENSE` so the committed
corpus carries its own attribution. Exercise statements (`prompt.md`) and
canonical test data (`task.json`) are derived works of that repository.

Everything else in this repository is MIT licensed — see `LICENSE`. It
benchmarks [aven-lang](https://github.com/dbalmain/aven-lang), which is MIT
licensed too.
