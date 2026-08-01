/**
 * Incremental JSONL tail over data/runs/*.jsonl.
 *
 * Tracks a byte offset per file and parses only new bytes. Re-reads from
 * scratch only when a file shrinks or its inode changes. Never writes.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import {
  sliceFromUnknown,
  summarizeRun,
  sortSummaries,
  type AttemptSlice,
  type RunSummary,
  type SplitSizes,
} from "./stats.ts";

export type FileCursor = {
  path: string;
  runId: string;
  offset: number;
  size: number;
  ino: number;
  mtimeMs: number;
  rows: AttemptSlice[];
  /** Incomplete trailing line between polls. */
  partial: string;
  malformed: number;
};

export type WatchState = {
  runsDir: string;
  split: SplitSizes;
  files: Map<string, FileCursor>;
  stallMs: number;
};

export function loadSplitSizesSync(text: string): SplitSizes {
  const raw = JSON.parse(text) as { tune?: unknown[]; holdout?: unknown[] };
  return {
    tune: Array.isArray(raw.tune) ? raw.tune.length : 0,
    holdout: Array.isArray(raw.holdout) ? raw.holdout.length : 0,
  };
}

export function createWatchState(
  runsDir: string,
  split: SplitSizes,
  stallMs?: number,
): WatchState {
  return {
    runsDir,
    split,
    files: new Map(),
    stallMs: stallMs ?? 3 * 60 * 1000,
  };
}

function listRunFiles(runsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".jsonl") && !n.startsWith("."))
    .map((n) => join(runsDir, n))
    .sort();
}

function parseLines(
  cursor: FileCursor,
  chunk: string,
): void {
  const combined = cursor.partial + chunk;
  const parts = combined.split("\n");
  cursor.partial = parts.pop() ?? "";
  for (const line of parts) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      cursor.malformed += 1;
      continue;
    }
    const slice = sliceFromUnknown(raw);
    if (!slice) {
      cursor.malformed += 1;
      continue;
    }
    // Prefer filename run id when the row disagrees (shouldn't, but quarantine-safe).
    if (slice.runId === "unknown") slice.runId = cursor.runId;
    cursor.rows.push(slice);
  }
}

async function readSlice(path: string, start: number, end: number): Promise<string> {
  if (end <= start) return "";
  const file = Bun.file(path);
  return await file.slice(start, end).text();
}

/**
 * Poll the runs directory once: discover files, tail new bytes, drop gone files.
 * Read-only. Safe to call while a sweep is appending.
 */
export async function pollWatch(state: WatchState): Promise<void> {
  const paths = listRunFiles(state.runsDir);
  const seen = new Set(paths);

  for (const path of paths) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    const runId = basename(path, ".jsonl");
    const prev = state.files.get(path);
    const ino = Number(st.ino);
    const size = st.size;
    const mtimeMs = st.mtimeMs;

    const reset = prev == null || prev.ino !== ino || size < prev.offset;
    const cursor: FileCursor = reset
      ? {
          path,
          runId,
          offset: 0,
          size: 0,
          ino,
          mtimeMs,
          rows: [],
          partial: "",
          malformed: 0,
        }
      : prev;
    if (reset) state.files.set(path, cursor);

    cursor.mtimeMs = mtimeMs;
    cursor.ino = ino;

    if (size > cursor.offset) {
      const text = await readSlice(path, cursor.offset, size);
      parseLines(cursor, text);
      cursor.offset = size;
      cursor.size = size;
    } else {
      cursor.size = size;
    }
  }

  for (const path of state.files.keys()) {
    if (!seen.has(path)) state.files.delete(path);
  }
}

export function summariesFromWatch(
  state: WatchState,
  nowMs: number = Date.now(),
): RunSummary[] {
  const runs: RunSummary[] = [];
  for (const cursor of state.files.values()) {
    if (cursor.rows.length === 0 && cursor.size === 0) continue;
    runs.push(
      summarizeRun(cursor.rows, {
        split: state.split,
        mtimeMs: cursor.mtimeMs,
        nowMs,
        stallMs: state.stallMs,
      }),
    );
  }
  return sortSummaries(runs);
}
