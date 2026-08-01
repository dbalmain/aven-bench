/**
 * Incremental tail: only new bytes are parsed; shrink/inode reset re-reads.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createWatchState, pollWatch, summariesFromWatch, loadSplitSizesSync } from "./watch.ts";

const split = loadSplitSizesSync(
  JSON.stringify({
    tune: Array.from({ length: 72 }, (_, i) => `t${i}`),
    holdout: Array.from({ length: 71 }, (_, i) => `h${i}`),
  }),
);

function line(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId: "r1",
    taskId: "leap",
    language: "aven",
    modelId: "m",
    sampleIndex: 0,
    taskSet: "holdout",
    outcome: "pass",
    harnessErrorKind: null,
    firstShotPass: true,
    roundsToGreen: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    costUsd: 0.01,
    avenCommit: "abc",
    docId: "d",
    probes: [],
    ...over,
  });
}

describe("incremental JSONL watch", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `aven-bench-watch-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("tails new lines without re-parsing old ones", async () => {
    const path = join(dir, "r1.jsonl");
    writeFileSync(path, `${line({ taskId: "a" })}\n`);
    const state = createWatchState(dir, split);
    await pollWatch(state);
    const c = state.files.get(path)!;
    expect(c.rows).toHaveLength(1);
    const offsetAfterFirst = c.offset;

    appendFileSync(path, `${line({ taskId: "b", finishedAt: "2026-01-01T00:02:00.000Z" })}\n`);
    await pollWatch(state);
    expect(c.rows).toHaveLength(2);
    expect(c.offset).toBeGreaterThan(offsetAfterFirst);
    // same object identity for first row — not rebuilt from scratch
    expect(c.rows[0]?.taskId).toBe("a");
    expect(c.rows[1]?.taskId).toBe("b");
  });

  test("re-reads when file shrinks", async () => {
    const path = join(dir, "r1.jsonl");
    writeFileSync(path, `${line({ taskId: "a" })}\n${line({ taskId: "b" })}\n`);
    const state = createWatchState(dir, split);
    await pollWatch(state);
    expect(state.files.get(path)!.rows).toHaveLength(2);

    writeFileSync(path, `${line({ taskId: "only" })}\n`);
    await pollWatch(state);
    const rows = state.files.get(path)!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.taskId).toBe("only");
  });

  test("excludes quarantine subdirectory (only top-level jsonl)", async () => {
    const path = join(dir, "r1.jsonl");
    writeFileSync(path, `${line()}\n`);
    mkdirSync(join(dir, "quarantine"), { recursive: true });
    writeFileSync(join(dir, "quarantine", "bad.jsonl"), `${line({ runId: "bad" })}\n`);
    const state = createWatchState(dir, split);
    await pollWatch(state);
    expect([...state.files.keys()]).toEqual([path]);
    const sums = summariesFromWatch(state, Date.parse("2026-01-01T00:02:00.000Z"));
    expect(sums).toHaveLength(1);
    expect(sums[0]?.runId).toBe("r1");
  });
});
