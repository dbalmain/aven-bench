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
