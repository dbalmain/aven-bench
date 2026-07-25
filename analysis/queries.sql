-- Analysis over the append-only attempt log. Schema: runner/schema.ts.
--
-- These are the two ranked worklists plus the diagnostics worklist from §6 of
-- PLAN-aven-bench.md. They run once the runner writes data/runs/*.jsonl.

CREATE OR REPLACE VIEW attempts AS
  SELECT * FROM read_json_auto('data/runs/*.jsonl', union_by_name = true);

CREATE OR REPLACE VIEW split AS
  SELECT unnest(holdout) AS task_id, 'holdout' AS task_set FROM read_json_auto('corpus/split.json')
  UNION ALL
  SELECT unnest(tune) AS task_id, 'tune' AS task_set FROM read_json_auto('corpus/split.json');

-- Holdout only: the tune half is for iterating on the skill doc.
CREATE OR REPLACE VIEW holdout AS
  SELECT a.* FROM attempts a JOIN split s ON s.task_id = a.taskId WHERE s.task_set = 'holdout';

-- 1. Language worklist: where is Aven furthest behind the control language?
--    Ascending delta, so the worst tasks come first.
CREATE OR REPLACE VIEW pass_rate_by_task_language AS
  SELECT taskId, language, avg(CASE WHEN firstShotPass THEN 1.0 ELSE 0.0 END) AS first_shot_rate,
         avg(CASE WHEN outcome = 'pass' THEN 1.0 ELSE 0.0 END) AS eventual_rate,
         count(*) AS n
  FROM holdout GROUP BY 1, 2;

.print "--- language worklist (worst Aven deltas first) ---"
SELECT a.taskId,
       a.first_shot_rate AS aven_rate,
       b.first_shot_rate AS control_rate,
       a.first_shot_rate - b.first_shot_rate AS delta
FROM pass_rate_by_task_language a
JOIN pass_rate_by_task_language b USING (taskId)
WHERE a.language = 'aven' AND b.language = 'python'
ORDER BY delta ASC
LIMIT 30;

-- 2. Ergonomics worklist: where is the Aven solution largest relative to control?
.print "--- ergonomics worklist (largest Aven size ratio first) ---"
WITH sizes AS (
  SELECT taskId, language, median(solutionTokens) AS tokens
  FROM holdout WHERE outcome = 'pass' GROUP BY 1, 2
)
SELECT a.taskId, a.tokens AS aven_tokens, b.tokens AS control_tokens,
       a.tokens / nullif(b.tokens, 0) AS ratio
FROM sizes a JOIN sizes b USING (taskId)
WHERE a.language = 'aven' AND b.language = 'python'
ORDER BY ratio DESC
LIMIT 30;

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

-- 6. Contamination guard. Any nonzero value means the harness read something
--    outside the attempt's work directory — in this repo that includes
--    `references/`, i.e. the answers. Such rows are not evidence of anything.
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
