-- Analysis over the append-only attempt log. Schema: runner/schema.ts.
--
-- These are the two ranked worklists plus the diagnostics worklist from §6 of
-- PLAN-aven-bench.md. They run once the runner writes data/runs/*.jsonl.

-- The zero-row sentinel forces columns newer than the oldest log on disk to exist
-- anyway. Without it `coalesce(contaminated, false)` below is a binder error
-- rather than a null, and the whole script fails to load until the first new
-- sweep lands — so the guard would be absent exactly when the old data most needs
-- it. `contractGeneration` is here for the same reason, which is what lets 2a read
-- the honest column instead of guessing from `schemaVersion`.
CREATE OR REPLACE VIEW attempts AS
  SELECT * FROM read_json_auto('data/runs/*.jsonl', union_by_name = true)
  UNION ALL BY NAME
  SELECT false AS contaminated, NULL::VARCHAR AS contaminationTier,
         NULL::VARCHAR AS contractGeneration,
         NULL::BIGINT AS nudges, NULL::BIGINT AS maxNudges WHERE false;

CREATE OR REPLACE VIEW split AS
  SELECT unnest(holdout) AS task_id, 'holdout' AS task_set FROM read_json_auto('corpus/split.json')
  UNION ALL
  SELECT unnest(tune) AS task_id, 'tune' AS task_set FROM read_json_auto('corpus/split.json');

-- Holdout only: the tune half is for iterating on the skill doc.
CREATE OR REPLACE VIEW holdout AS
  SELECT a.* FROM attempts a JOIN split s ON s.task_id = a.taskId WHERE s.task_set = 'holdout';

-- Attempts that actually measured the model.
--
-- A harness error measured the *provider*, not the model. `agent-no-tokens` rows
-- are the sharp case: a dead provider returns nothing and the attempt used to be
-- recorded as a timeout, so averaging it into a pass rate reproduces at analysis
-- time exactly the corruption the runner's circuit breaker exists to prevent.
-- §3c excludes harness errors from the capability denominator; this view is where
-- that exclusion actually happens, and every rate below is built on it.
--
-- Contaminated attempts are excluded on the same principle for a different
-- reason: they measured the model, but they measured its ability to fetch the
-- published tests rather than to write the code. Labelling alone is not enough —
-- that was precisely the bug in the first zero-token fix, where rows were
-- correctly classified in the runner and still averaged into every rate here.
--
-- Only `suite` and `solution` tiers set `contaminated`; a bare `lookup` (reading
-- the exercise description the model was handed anyway) stays in.
CREATE OR REPLACE VIEW measured AS
  SELECT * FROM holdout
  WHERE outcome <> 'harness_error'
    AND NOT coalesce(contaminated, false);

-- 1. Language worklist: where is Aven furthest behind the control languages?
--    Ascending delta, so the worst tasks come first.
CREATE OR REPLACE VIEW pass_rate_by_task_language AS
  SELECT taskId, language, avg(CASE WHEN firstShotPass THEN 1.0 ELSE 0.0 END) AS first_shot_rate,
         avg(CASE WHEN outcome = 'pass' THEN 1.0 ELSE 0.0 END) AS eventual_rate,
         count(*) AS n
  FROM measured GROUP BY 1, 2;

-- The control arm is "the best mainstream language on this task", not Python
-- specifically. A task Ruby handles cleanly and Python fumbles is still evidence
-- that Aven is behind, and taking the stronger control keeps the delta from
-- flattering Aven when one control happens to be weak. Adding a language to the
-- corpus needs no change here: anything that is not 'aven' is a control.
CREATE OR REPLACE VIEW baseline_by_task AS
  SELECT taskId,
         max(first_shot_rate) AS first_shot_rate,
         max(eventual_rate) AS eventual_rate,
         arg_max(language, first_shot_rate) AS best_language,
         count(*) AS control_languages
  FROM pass_rate_by_task_language
  WHERE language <> 'aven'
  GROUP BY 1;

.print "--- language worklist (worst Aven deltas first) ---"
SELECT a.taskId,
       a.first_shot_rate AS aven_rate,
       b.first_shot_rate AS control_rate,
       b.best_language AS control,
       a.first_shot_rate - b.first_shot_rate AS delta,
       a.n AS aven_n,
       -- Partial coverage is the normal state of a free-tier sweep: a provider
       -- that dies mid-run leaves a task with some arms recorded and others not,
       -- and the control then silently becomes "best of whichever arms finished".
       -- A row with fewer controls than the sweep requested is not comparable to
       -- one with all of them, so the count travels with the delta rather than
       -- living in a view nobody selects from.
       b.control_languages AS controls
FROM pass_rate_by_task_language a
JOIN baseline_by_task b USING (taskId)
WHERE a.language = 'aven'
ORDER BY delta ASC
LIMIT 30;

-- 2. Ergonomics worklist: where is the Aven solution largest relative to control?
--
-- Only passing solutions are sized: a broken solution's length says nothing about
-- how verbose the language is. The control size is the *smallest* control, which
-- maximises the ratio and so is deliberately harsh on Aven. That is the right bias
-- for a worklist — its job is to nominate candidates for a human to look at, and a
-- generous control surfaces more of them — but it means the ratio ranks suspicion,
-- not guilt. Read the numbers as an ordering, never as a verdict on the language.
.print "--- ergonomics worklist (largest Aven size ratio first) ---"
WITH sizes AS (
  SELECT taskId, language, median(solutionTokens) AS tokens
  FROM measured WHERE outcome = 'pass' GROUP BY 1, 2
), control AS (
  SELECT taskId, min(tokens) AS tokens, arg_min(language, tokens) AS best_language
  FROM sizes WHERE language <> 'aven' GROUP BY 1
)
SELECT a.taskId, a.tokens AS aven_tokens, b.tokens AS control_tokens,
       b.best_language AS control,
       a.tokens / nullif(b.tokens, 0) AS ratio
FROM sizes a JOIN control b USING (taskId)
WHERE a.language = 'aven'
ORDER BY ratio DESC
LIMIT 30;

-- 2b. Harness health. Run this **before** trusting anything above.
--
-- Every rate in this file is conditioned on the harness having actually reached
-- the model, so the share of rows this excluded is a precondition, not a footnote.
-- `agent-no-tokens` is a provider that answered nothing; a nonzero count there
-- means some arm is short of attempts, and a model whose row count is far below
-- the others was probably dropped by preflight or abandoned by the circuit
-- breaker. Both are recoverable by re-running that model — but only if noticed.
--
-- Note this reads `attempts`, not `measured`: the excluded rows are the subject.
-- 2a. Contract generation. Read this before pooling anything.
--
-- Schema 6 began stating observed argument and return shapes in the round-0
-- prompt. That changes what the model is being asked to do — the change exists
-- precisely because models were burning repair rounds guessing return types — so
-- rows either side of it answer different questions and must not be averaged
-- together. The runner enforces this at collection time by putting
-- `contractGeneration` in the resume key; this query is the reader's half.
--
-- This reads `contractGeneration` itself, via the sentinel above. It used to
-- derive the generation from `schemaVersion` instead, because duckdb cannot bind a
-- column no file contains — and that proxy went wrong the moment a *second*
-- generation landed: `shapes-v2` rows are schema 7, so a `>= 6` test labelled them
-- `shapes-v1` and pooled them with the very rows this query exists to keep apart.
-- Reading the recorded value needs no edit when the next generation lands.
-- Pre-schema-6 logs have no such column at all, hence the coalesce.
.print "--- contract generation (more than one row here means do not pool) ---"
SELECT coalesce(trim(CAST(contractGeneration AS VARCHAR), '"'), 'names-v0') AS contract_generation,
       count(*) AS rows_total,
       count(DISTINCT runId) AS runs
FROM attempts
GROUP BY 1
ORDER BY 1;

-- 2c. Wrong-channel rate. Read this before trusting any pass rate.
--
-- The model that answers in chat instead of writing the file is scored a
-- `refusal`, and a refusal counts against the pass rate — it is in `measured`,
-- unlike a harness error. In `phase3-holdout-02` that happened 37 times in 213
-- rows with the finished program sitting in the reply, split 20 Aven / 11 Ruby /
-- 6 Python. A protocol miss with a 3× arm skew lands entirely on the number the
-- campaign is trying to read.
--
-- `nudges > 0` is the honest rate of the miss; `rescued` is how much of it the
-- deterministic re-ask recovered. If `pct_wrong_channel` is materially different
-- across arms, the residual `refusals` are still biasing the delta and the
-- nudge budget (or the round-0 wording) needs another look before the ranked
-- worklists mean anything. `max_nudges = 0` rows are pre-schema-8 or a
-- deliberate ablation: there the miss is invisible and `refusals` absorbs it.
.print "--- 2c. wrong-channel rate (nudges) by arm ---"
SELECT language,
       coalesce(maxNudges, 0) AS max_nudges,
       count(*) AS rows_total,
       count(*) FILTER (WHERE coalesce(nudges, 0) > 0) AS needed_a_nudge,
       count(*) FILTER (WHERE coalesce(nudges, 0) > 0 AND outcome <> 'refusal') AS rescued,
       count(*) FILTER (WHERE outcome = 'refusal') AS refusals,
       round(100.0 * count(*) FILTER (WHERE coalesce(nudges, 0) > 0) / nullif(count(*), 0), 1)
         AS pct_wrong_channel
FROM holdout
GROUP BY 1, 2
ORDER BY 1, 2;

.print "--- harness health (excluded rows by model; expect zeros) ---"
SELECT modelId,
       language,
       count(*) AS rows_total,
       sum(CASE WHEN outcome = 'harness_error' THEN 1 ELSE 0 END) AS harness_errors,
       -- `union_by_name` over mixed schema versions infers this column as JSON when
       -- older logs lack it entirely, and comparing JSON to a bare string is a
       -- parse error. Cast and strip quotes so the query works on any mix of
       -- versions — which is the normal state of `data/runs/`, not an edge case.
       sum(CASE WHEN trim(CAST(harnessErrorKind AS VARCHAR), '"') = 'agent-no-tokens'
                THEN 1 ELSE 0 END) AS no_tokens,
       sum(CASE WHEN outcome = 'timeout' THEN 1 ELSE 0 END) AS timeouts,
       min(schemaVersion) AS min_schema,
       max(schemaVersion) AS max_schema
FROM attempts
GROUP BY 1, 2
ORDER BY harness_errors DESC, rows_total ASC;

-- Pre-schema-5 logs recorded a dead provider as `outcome: 'timeout'` with zero
-- tokens everywhere, and `harnessErrorKind` did not exist. Those rows are
-- indistinguishable from a genuinely slow model *by outcome alone*, so match them
-- on the token columns instead. A nonzero count here means the log predates the
-- fix and needs quarantining, not analysing.
.print "--- legacy poisoned rows (zero-token timeouts; expect 0) ---"
SELECT runId, modelId, count(*) AS poisoned_rows
FROM attempts
WHERE outcome = 'timeout'
  AND coalesce(promptTokens, 0) = 0 AND coalesce(completionTokens, 0) = 0
  AND coalesce(cachedPromptTokens, 0) = 0 AND coalesce(reasoningTokens, 0) = 0
GROUP BY 1, 2
ORDER BY poisoned_rows DESC;

-- 3. Diagnostics worklist: which codes burn the most repair rounds?
.print "--- diagnostics worklist (rounds burned per code) ---"
SELECT code, count(*) AS rounds_seen, count(DISTINCT taskId) AS tasks
FROM (
  SELECT taskId, unnest(r.diagnosticCodes) AS code
  FROM holdout, unnest(repairRounds) AS t(r)
  WHERE language = 'aven'
)
GROUP BY code ORDER BY rounds_seen DESC LIMIT 30;

-- Sanity: omitted cases inflate pass rates if ignored. Should be 0 under
-- `generate --intersect`.
.print "--- omitted-case check (should be all zero for A/B arms) ---"
SELECT language, sum(casesOmitted) AS omitted FROM holdout GROUP BY 1;

-- 4. Check/test divergence. The Aven gate is `check` AND `test`, but the two are
--    recorded separately: rows where the suite went green and the checker still
--    said no are a language finding, not a scoring detail.
.print "--- aven: test green but check rejected ---"
SELECT taskId, modelId, outcome, casesPassed, casesTotal, checkOkSolutionOnly, outcomeDetail
FROM attempts
WHERE language = 'aven' AND testOk AND NOT checkOk
ORDER BY taskId;

-- 5. mypy is recorded, never gating. Two questions it answers: how often a
--    passing Python solution is untyped-and-wrong by mypy's lights, and how often
--    mypy was simply unavailable (null).
.print "--- python: mypy vs the suite ---"
SELECT
  count(*) FILTER (WHERE mypyOk IS NULL) AS mypy_unavailable,
  count(*) FILTER (WHERE mypyOk) AS mypy_clean,
  count(*) FILTER (WHERE NOT mypyOk) AS mypy_flagged,
  count(*) FILTER (WHERE NOT mypyOk AND outcome = 'pass') AS mypy_flagged_but_passing
FROM attempts WHERE language = 'python';

-- 6. Contamination guard. On unsandboxed rows, any nonzero value means the
--    harness may have read outside the attempt. On sandboxed rows it means the
--    model named an outside path; the filesystem boundary makes the access fail.
.print "--- rows that touched files outside the work directory (should be empty) ---"
SELECT runId, taskId, language, modelId, outcome, outsideWorkdirTouches
FROM attempts WHERE outsideWorkdirTouches > 0 ORDER BY outsideWorkdirTouches DESC;

-- 7. Compliance with `toolPolicy: 'no-verify'`, from the Aven session log: how
--    often the model ran the compiler itself despite being told not to.
.print "--- aven: model-initiated compiler runs per round ---"
SELECT modelId, sum(r.modelToolInvocations) AS model_runs, count(*) AS rounds
FROM attempts, unnest(repairRounds) AS t(r)
WHERE language = 'aven' AND toolPolicy = 'no-verify'
GROUP BY 1 ORDER BY 2 DESC;

-- 8. Shell tools are broader than compiler invocations and work on both arms.
--    Under sandboxed no-verify this is usually exploration, not contamination;
--    pair with query 7 (modelToolInvocations) for real self-verification.
.print "--- model shell commands under no-verify, by containment mode ---"
SELECT sandbox, language, modelId, sum(shellCommands) AS shell_commands
FROM attempts
WHERE toolPolicy = 'no-verify'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
