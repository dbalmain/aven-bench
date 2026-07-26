#!/usr/bin/env ruby
# Run a generated Ruby suite and report results in aven-bench's shape.
#
# Usage: rb_runner.rb <suite-file> [working-dir]
#
# Emits the same JSON envelope as `aven test --format json` and `py_runner.py`,
# and the same exit code contract, so the runner can read every arm with one
# parser:
#
#     {"ok": bool, "total": n, "passed": n, "failed": n, "errored": n,
#      "cases": [{"name": str, "outcome": "pass"|"fail"|"error", "message": str}]}
#
#     0  every case passed
#     1  the suite ran, at least one case failed or errored
#     2  the suite could not be loaded (missing/broken solution or suite)
#
# minitest is driven directly rather than through `Minitest.autorun` and a
# reporter: a reporter formats for humans and would have to be parsed back, while
# `Runnable#run` already returns a `Minitest::Result` carrying everything the
# envelope needs. It also keeps the generated suite runnable on its own with
# plain `ruby solution_test.rb`, which is what a self-verifying model uses.

require "json"

# Keys are emitted in sorted order so the two runners' output diffs cleanly
# (py_runner.py dumps with sort_keys=True).
def emit(payload, code)
  $stdout.puts JSON.pretty_generate(payload)
  $stdout.flush
  exit code
end

def load_error(message)
  emit(
    {
      "cases" => [],
      "errored" => 0,
      "failed" => 0,
      "load_error" => message,
      "ok" => false,
      "passed" => 0,
      "total" => 0
    },
    2
  )
end

def describe_exception(err)
  "#{err.class}: #{err.message}\n#{(err.backtrace || []).first(4).join("\n")}"
end

# The upstream description of a case. Ruby has no docstrings, so the generated
# suite carries a CASE_NAMES table; `py_runner.py` reads the same thing out of
# the test method's docstring. Falling back to the method name matches it too.
def case_name(klass, method)
  table = klass.const_defined?(:CASE_NAMES, false) ? klass.const_get(:CASE_NAMES) : nil
  (table.is_a?(Hash) && table[method.to_s]) || method.to_s
end

# minitest's own message layout, normalized to the runner's one-line assumption.
#
# A `Minitest::Assertion` message is two lines ("Expected: …" / "  Actual: …"),
# and a diffed one starts with the uninformative "--- expected". The repair
# prompt shows the *first* line of each failing case, and on the Python arm that
# line carries both values ("AssertionError: 'a' != 'b'"), so leaving minitest's
# layout alone would hand the Ruby arm strictly worse repair feedback for exactly
# the same information — a harness artefact, not a language difference. An
# UnexpectedError is left as-is: its first line is already "ArgumentError: …" and
# the lines below it are a backtrace worth keeping.
def failure_message(failure)
  text = failure.message.to_s
  return text if failure.is_a?(Minitest::UnexpectedError)

  text.split("\n").map(&:strip).reject(&:empty?).join(" ")
end

def outcome_of(result)
  return "pass" if result.passed?
  # A generated suite never calls `skip`, so a skip is a case that measured
  # nothing rather than one that passed. The envelope has no fourth state, and
  # "error" is the one that keeps it out of the passed count.
  return "error" if result.error? || result.skipped?

  "fail"
end

suite_arg = ARGV[0]
load_error("usage: rb_runner.rb <suite-file> [working-dir]") if suite_arg.nil?
workdir = ARGV[1] || Dir.pwd

begin
  require "minitest"
rescue LoadError => e
  load_error("minitest is not available: #{e.message}")
end

# `Minitest::Test.runnable_methods` seeds the shuffle from `Minitest.seed`, which
# only `Minitest.run` sets. Nothing here depends on the order it produces — the
# methods are sorted below, so cases are reported in upstream order — but the
# attribute has to hold an Integer or the first call raises.
Minitest.seed = 0

begin
  load File.expand_path(suite_arg, workdir)
rescue Exception => e
  # Deliberately Exception, not StandardError: a missing solution.rb raises
  # LoadError and a broken one SyntaxError, and neither is a StandardError.
  # Those are the two "the suite never ran" cases the exit-2 contract is for.
  load_error(describe_exception(e))
end

classes = Minitest::Runnable.runnables.reject { |k| k.runnable_methods.empty? }
# The suite loaded but defined nothing to run: still "never ran", not "passed".
load_error("suite defined no runnable test methods") if classes.empty?

cases = []
failed = 0
errored = 0
started = Process.clock_gettime(Process::CLOCK_MONOTONIC)

classes.each do |klass|
  klass.runnable_methods.sort.each do |method|
    result = klass.new(method).run
    outcome = outcome_of(result)
    failed += 1 if outcome == "fail"
    errored += 1 if outcome == "error"
    cases << {
      "message" => result.failures.map { |f| failure_message(f) }.join("\n"),
      "name" => case_name(klass, method),
      "outcome" => outcome
    }
  end
end

duration_ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000.0
total = cases.length
ok = failed.zero? && errored.zero?

emit(
  {
    "cases" => cases,
    "duration_ms" => duration_ms,
    "errored" => errored,
    "failed" => failed,
    "ok" => ok,
    "passed" => total - failed - errored,
    "total" => total
  },
  ok ? 0 : 1
)
