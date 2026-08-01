/**
 * Description precedence: tracked notes file ≻ launch-time --note.
 * Empty descriptions are normal, not broken.
 */

import { describe, expect, test } from "bun:test";

import { parseRunNotes, resolveDescription } from "./notes.ts";
import { summarizeRun, type AttemptSlice } from "./stats.ts";

function row(over: Partial<AttemptSlice> & Pick<AttemptSlice, "taskId">): AttemptSlice {
  return {
    runId: "t",
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
    costUsd: null,
    avenCommit: "abc",
    docId: "skill-v2",
    runNote: null,
    ...over,
  };
}

describe("resolveDescription precedence", () => {
  test("notes-file non-empty wins over runNote", () => {
    const notes = parseRunNotes(
      JSON.stringify({ "r1": { description: "from notes file" } }),
    );
    expect(resolveDescription("r1", notes, "from --note")).toBe("from notes file");
  });

  test("empty notes-file entry falls through to runNote", () => {
    const notes = parseRunNotes(
      JSON.stringify({ "r1": { description: "" } }),
    );
    expect(resolveDescription("r1", notes, "launch note")).toBe("launch note");
  });

  test("whitespace-only notes-file falls through to runNote", () => {
    const notes = parseRunNotes(
      JSON.stringify({ "r1": { description: "  \n  " } }),
    );
    expect(resolveDescription("r1", notes, "launch note")).toBe("launch note");
  });

  test("absent notes entry uses runNote", () => {
    expect(resolveDescription("missing", {}, "only note")).toBe("only note");
  });

  test("run with no note at all → null (unremarkable, not broken)", () => {
    expect(resolveDescription("r1", {}, null)).toBeNull();
    expect(resolveDescription("r1", {}, undefined)).toBeNull();
    expect(resolveDescription("r1", {}, "")).toBeNull();
    expect(resolveDescription("r1", { r1: { description: "" } }, null)).toBeNull();
  });

  test("notes-file trims surrounding whitespace", () => {
    const notes = parseRunNotes(
      JSON.stringify({ "r1": { description: "  re-baseline  " } }),
    );
    expect(resolveDescription("r1", notes, null)).toBe("re-baseline");
  });
});

describe("parseRunNotes", () => {
  test("malformed JSON yields empty map", () => {
    expect(parseRunNotes("{not json")).toEqual({});
  });

  test("ignores non-object entries", () => {
    const notes = parseRunNotes(
      JSON.stringify({ ok: { description: "yes" }, bad: "string", worse: 3 }),
    );
    expect(notes).toEqual({ ok: { description: "yes" } });
  });
});

describe("summarizeRun description wiring", () => {
  test("opts.description is what the card shows", () => {
    const rows = [row({ taskId: "a", runId: "r1", runNote: "cli note" })];
    const withOverride = summarizeRun(rows, {
      split: { tune: 72, holdout: 71 },
      mtimeMs: 1,
      nowMs: 1,
      description: "file wins",
    });
    expect(withOverride.description).toBe("file wins");
    expect(withOverride.runNote).toBe("cli note");

    const noNote = summarizeRun([row({ taskId: "a", runNote: null })], {
      split: { tune: 72, holdout: 71 },
      mtimeMs: 1,
      nowMs: 1,
      description: null,
    });
    expect(noNote.description).toBeNull();
    expect(noNote.runNote).toBeNull();
  });

  test("without opts.description, falls back to runNote from rows", () => {
    const s = summarizeRun([row({ taskId: "a", runNote: "from rows" })], {
      split: { tune: 72, holdout: 71 },
      mtimeMs: 1,
      nowMs: 1,
    });
    expect(s.description).toBe("from rows");
    expect(s.runNote).toBe("from rows");
  });
});
