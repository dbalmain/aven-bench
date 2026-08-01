/**
 * Tracked run descriptions, outside the gitignored data/ tree.
 *
 * `data/runs/*.jsonl` vanish with the run data; a description that only lives
 * on the attempt record cannot be version-controlled or applied to finished
 * runs. This file is the editable source of truth for "why did we run this?"
 *
 * Shape (hand-edit friendly — one object per run id):
 *
 *   {
 *     "phase3-holdout-06": { "description": "…" }
 *   }
 *
 * Precedence when resolving what the dashboard shows:
 *
 * 1. Non-empty `description` in this file wins (post-hoc correction).
 * 2. Else the launch-time `--note` stored as `runNote` on attempt rows.
 * 3. Else no description — an empty field, not an error.
 *
 * Empty strings in this file do **not** suppress a `--note`: seeding blanks
 * for every existing run must not hide a note the operator already recorded.
 */

import { existsSync, readFileSync } from "node:fs";

export type RunNoteEntry = {
  description: string;
};

/** Map of run id → note entry. */
export type RunNotes = Record<string, RunNoteEntry>;

/**
 * Parse a notes JSON document. Unknown shapes yield an empty map rather than
 * throwing — a hand-edit typo should not take down the dashboard.
 */
export function parseRunNotes(text: string): RunNotes {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: RunNotes = {};
  for (const [runId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const desc = (entry as Record<string, unknown>)["description"];
    out[runId] = {
      description: typeof desc === "string" ? desc : "",
    };
  }
  return out;
}

export function loadRunNotesSync(path: string): RunNotes {
  if (!existsSync(path)) return {};
  return parseRunNotes(readFileSync(path, "utf8"));
}

/**
 * Resolve the display description for a run.
 *
 * Non-empty notes-file text beats the recorded `--note`. Empty notes-file
 * entries fall through so a launch-time note still shows until Dave fills the
 * tracked field.
 */
export function resolveDescription(
  runId: string,
  notes: RunNotes,
  runNote: string | null | undefined,
): string | null {
  const fromFile = notes[runId]?.description;
  if (fromFile != null) {
    const trimmed = fromFile.trim();
    if (trimmed !== "") return trimmed;
  }
  if (runNote != null) {
    const trimmed = runNote.trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}
