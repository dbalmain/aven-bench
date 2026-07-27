/**
 * Re-scan existing run logs for attempts that fetched the answer.
 *
 * Contamination detection landed in schema 7, so every row written before it is
 * unlabelled — including the whole Phase 2 calibration sweep whose numbers chose
 * the models for Phase 3. The logs are still in the artifact store, so the
 * question is answerable retroactively: this replays `detectContamination` over
 * them and re-scores the sweep with the disqualified rows dropped.
 *
 * Why re-scoring matters more than the count. Aven has no upstream tests to
 * fetch, so contamination only ever inflates the control arm, and every headline
 * number is `aven_pass_rate − baseline_pass_rate`. A model that looks strong
 * because it is good at retrieval is the worst possible pick for a calibration
 * band.
 *
 *   bun run scripts/audit-contamination.ts               # report only
 *   bun run scripts/audit-contamination.ts --verbose     # + per-row evidence
 *   bun run scripts/audit-contamination.ts --quarantine  # move disqualified rows out
 *
 * Report-only is the default: this reads the dataset, and the moving variant
 * rewrites it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contaminationSummary } from "../runner/attempt.ts";
import { detectContamination, type ContaminationHit } from "../runner/contamination.ts";

const RUNS = "data/runs";
const ARTIFACTS = "data/artifacts";
const QUARANTINE = join(RUNS, "quarantine");

/** Matches `quarantine-zero-token.ts`: recent mtime stands in for "a sweep owns this". */
const ACTIVE_LOG_MS = 5 * 60 * 1000;

type Row = Record<string, unknown> & {
  taskId?: string;
  language?: string;
  modelId?: string;
  outcome?: string;
  promptHash?: string;
  repairRounds?: { agentLogHash?: string | null }[];
};

/** Artifacts are content-addressed but the extension varies by kind. */
function artifact(hash: string | null | undefined): string {
  if (!hash) return "";
  const base = join(ARTIFACTS, hash.slice(0, 2), hash);
  for (const ext of ["log", "md", "txt", "json"]) {
    const path = `${base}.${ext}`;
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return "";
}

function scanRow(row: Row): ContaminationHit[] {
  const prompt = artifact(row.promptHash);
  const hits: ContaminationHit[] = [];
  for (const round of row.repairRounds ?? []) {
    hits.push(...detectContamination(artifact(round.agentLogHash), prompt));
  }
  return hits;
}

type Tally = { attempts: number; passes: number; dropped: number; droppedPasses: number };

const key = (row: Row) => `${row.modelId ?? "?"}`;

function rate(passes: number, attempts: number): string {
  if (attempts === 0) return "  n/a";
  return `${((100 * passes) / attempts).toFixed(0).padStart(4)}%`;
}

function main(): void {
  const verbose = process.argv.includes("--verbose");
  const quarantine = process.argv.includes("--quarantine");
  // Rates are only comparable within one sweep, so allow scoping to it. Without
  // this the calibration numbers pool with smoke tests and stop matching the
  // report they are meant to be checked against.
  const only = process.argv.find((a) => a.startsWith("--log="))?.slice("--log=".length);

  const files = readdirSync(RUNS)
    .filter((f) => f.endsWith(".jsonl"))
    .filter((f) => !only || f.includes(only));
  const byModel = new Map<string, Tally>();
  const flagged: { row: Row; hits: ContaminationHit[]; disqualified: boolean }[] = [];
  let scanned = 0;
  let noLog = 0;

  for (const file of files) {
    const path = join(RUNS, file);
    const rows: Row[] = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Row);

    const keep: Row[] = [];
    for (const row of rows) {
      scanned++;
      const hasLog = (row.repairRounds ?? []).some((r) => r.agentLogHash);
      if (!hasLog) noLog++;
      const hits = scanRow(row);
      const { contaminated } = contaminationSummary(hits);

      // Match the `measured` view: a harness error never reached the model, so
      // counting it as a failed attempt understates every rate it appears in.
      // Rates computed any other way are not comparable to the calibration report.
      if (row.outcome !== "harness_error") {
        const t = byModel.get(key(row)) ?? { attempts: 0, passes: 0, dropped: 0, droppedPasses: 0 };
        t.attempts++;
        if (row.outcome === "pass") t.passes++;
        if (contaminated) {
          t.dropped++;
          if (row.outcome === "pass") t.droppedPasses++;
        }
        byModel.set(key(row), t);
      }

      if (hits.length > 0) flagged.push({ row, hits, disqualified: contaminated });
      if (!contaminated) keep.push(row);
    }

    if (quarantine && keep.length !== rows.length) {
      if (Date.now() - statSync(path).mtimeMs < ACTIVE_LOG_MS) {
        console.log(`skip ${file}: modified in the last 5 min, a sweep may own it`);
        continue;
      }
      mkdirSync(QUARANTINE, { recursive: true });
      const moved = rows.filter((r) => !keep.includes(r));
      const dest = join(QUARANTINE, file.replace(/\.jsonl$/, ".contaminated.jsonl"));
      writeFileSync(dest, `${moved.map((r) => JSON.stringify(r)).join("\n")}\n`);
      writeFileSync(path, keep.length > 0 ? `${keep.map((r) => JSON.stringify(r)).join("\n")}\n` : "");
      console.log(`moved ${moved.length} row(s) from ${file} -> ${dest}`);
    }
  }

  console.log(`\nscanned ${scanned} row(s) across ${files.length} log(s)`);
  if (noLog > 0) {
    // Not a warning to dismiss: an unscannable row is an *unknown*, not a clean
    // one, and it bounds how strong any "N rows are contaminated" claim can be.
    console.log(`${noLog} row(s) had no retrievable agent log — they could not be scanned either way`);
  }
  console.log(`${flagged.length} row(s) touched upstream material; ${flagged.filter((f) => f.disqualified).length} disqualifying\n`);

  // The question the count alone cannot answer: did fetching actually *help*?
  // If contaminated rows pass at the same rate as clean ones, they were not
  // buying an advantage and the aggregate is undistorted — even though each
  // individual row is still an invalid measurement of unaided ability.
  const totals = [...byModel.values()].reduce(
    (a, t) => ({
      attempts: a.attempts + t.attempts,
      passes: a.passes + t.passes,
      dropped: a.dropped + t.dropped,
      droppedPasses: a.droppedPasses + t.droppedPasses,
    }),
    { attempts: 0, passes: 0, dropped: 0, droppedPasses: 0 },
  );
  if (totals.dropped > 0) {
    const cleanAttempts = totals.attempts - totals.dropped;
    const cleanPasses = totals.passes - totals.droppedPasses;
    console.log(
      `contaminated rows pass at ${rate(totals.droppedPasses, totals.dropped).trim()} ` +
        `(${totals.droppedPasses}/${totals.dropped}); clean rows at ${rate(cleanPasses, cleanAttempts).trim()} ` +
        `(${cleanPasses}/${cleanAttempts})\n`,
    );
  }

  const width = Math.max(...[...byModel.keys()].map((k) => k.length), 5);
  console.log(`${"model".padEnd(width)}  attempts  pass   rate   dropped  re-scored`);
  console.log("-".repeat(width + 46));
  for (const [model, t] of [...byModel].sort((a, b) => b[1].attempts - a[1].attempts)) {
    const netAttempts = t.attempts - t.dropped;
    const netPasses = t.passes - t.droppedPasses;
    const shift = t.dropped > 0 ? `  ${rate(netPasses, netAttempts)}` : "      —";
    console.log(
      `${model.padEnd(width)}  ${String(t.attempts).padStart(8)}  ${String(t.passes).padStart(4)}  ${rate(t.passes, t.attempts)}  ${String(t.dropped).padStart(7)}${shift}`,
    );
  }

  if (verbose) {
    console.log("\nevidence:");
    for (const { row, hits, disqualified } of flagged) {
      console.log(
        `\n  ${disqualified ? "DISQUALIFIED" : "advisory    "}  ${row.language}/${row.taskId}  ${row.modelId}  (${row.outcome})`,
      );
      for (const h of hits.slice(0, 3)) console.log(`      [${h.tier}/${h.rule}] ${h.evidence.slice(0, 150)}`);
    }
  }

  if (!quarantine && flagged.some((f) => f.disqualified)) {
    console.log("\nreport only. re-run with --quarantine to move disqualified rows out of the logs.");
  }
}

main();
