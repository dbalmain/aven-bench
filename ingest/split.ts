#!/usr/bin/env bun
/**
 * The frozen tune/holdout split.
 *
 *   bun run split            # create it, or extend it with newly-added tasks
 *   bun run split --rewrite  # re-derive from scratch (invalidates past A/Bs)
 *
 * Rule, deterministic and unseeded-randomness-free:
 *
 *   1. take every task id, sorted
 *   2. key each by sha256(SALT + ":" + id), hex
 *   3. sort by that key, then by id
 *   4. first half -> tune, second half -> holdout
 *
 * Sorting by a hash rather than by the id itself keeps the split from tracking
 * the alphabet (`a*` exercises are not systematically easier, but they are
 * systematically *related* — `binary`, `binary-search`, `binary-search-tree`
 * would otherwise land in the same arm).
 *
 * Once committed, assignments never move: a task already in the file keeps its
 * arm, and only new task ids are placed. Everything reported is holdout-only,
 * so a shifting split would silently invalidate comparisons across runs.
 */

import { existsSync } from "node:fs";
import { CORPUS_DIR } from "./paths.ts";
import { loadIndex, type Split } from "./task.ts";

const SPLIT_PATH = `${CORPUS_DIR}/split.json`;
const SALT = "aven-bench/tune-holdout/v1";
const RULE =
  "sort ids; key = sha256('aven-bench/tune-holdout/v1:' + id); sort by key then id; " +
  "first half tune, rest holdout; existing assignments are never moved";

function hashKey(id: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`${SALT}:${id}`);
  return h.digest("hex");
}

export function deriveSplit(ids: string[]): { tune: string[]; holdout: string[] } {
  const ordered = [...ids]
    .sort()
    .map((id) => ({ id, key: hashKey(id) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1))
    .map((x) => x.id);
  const half = Math.ceil(ordered.length / 2);
  return { tune: ordered.slice(0, half).sort(), holdout: ordered.slice(half).sort() };
}

async function main(): Promise<void> {
  const rewrite = Bun.argv.includes("--rewrite");
  const index = await loadIndex(CORPUS_DIR);
  const ids = index.tasks.map((t) => t.id);

  const fresh = deriveSplit(ids);
  let split: Split;

  if (existsSync(SPLIT_PATH) && !rewrite) {
    const prior = (await Bun.file(SPLIT_PATH).json()) as Split;
    const known = new Set([...prior.tune, ...prior.holdout]);
    const added = ids.filter((id) => !known.has(id));
    const removed = [...known].filter((id) => !ids.includes(id));
    const tune = prior.tune.filter((id) => ids.includes(id));
    const holdout = prior.holdout.filter((id) => ids.includes(id));
    // Place new tasks by the same rule, restricted to the new ids.
    const placement = deriveSplit(added);
    tune.push(...placement.tune);
    holdout.push(...placement.holdout);
    split = {
      frozenAt: prior.frozenAt,
      rule: prior.rule,
      tune: tune.sort(),
      holdout: holdout.sort(),
    };
    console.log(
      `extended existing split: +${added.length} new, -${removed.length} gone upstream`,
    );
    if (added.length > 0) console.log(`  added: ${added.join(", ")}`);
    if (removed.length > 0) console.log(`  removed: ${removed.join(", ")}`);
  } else {
    split = {
      frozenAt: new Date().toISOString().slice(0, 10),
      rule: RULE,
      tune: fresh.tune,
      holdout: fresh.holdout,
    };
    console.log(rewrite ? "rewrote split from scratch" : "froze a new split");
  }

  await Bun.write(SPLIT_PATH, JSON.stringify(split, null, 2) + "\n");
  console.log(
    `tune ${split.tune.length}  holdout ${split.holdout.length}  -> ${SPLIT_PATH}`,
  );
}

if (import.meta.main) await main();
