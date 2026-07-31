/**
 * Reader for `AVEN_SESSION_LOG` (aven-lang `crates/aven-core/src/session.rs`).
 *
 * Every `aven` process appends one JSONL record when the variable is set:
 * argv, entry path, source hash, phase timings, the full diagnostic list in
 * `check --format json` shape, and the exit code. The harness sets it once per
 * attempt and inherits the whole repair sequence — §3b's "no scraping of stderr
 * anywhere".
 *
 * ## Tagging
 *
 * `AVEN_SESSION_TAG` is set to the attempt id for the *agent* phase and to
 * `<attemptId>#gate.r<N>.<probe>` for the runner's own gate invocations. The
 * attempt id stays a prefix, so all of an attempt's records are still selectable
 * by it, and the two phases stay distinguishable — which is the only way to tell
 * an `aven` invocation the *model* made from one the harness made. That is how
 * `modelToolInvocations` is counted.
 *
 * It counts 0 on every sandboxed row, because bubblewrap exposes no `aven`
 * binary for the model to run; it can only go nonzero under `self-verify` or
 * `--no-sandbox`. Compliance with `toolPolicy: "no-verify"` is measured by
 * `shellCommands`, which counts tool calls the harness log reports regardless
 * of what they ran.
 */

import { existsSync, readFileSync } from "node:fs";

export type SessionSpan = { start: number; end: number };

export type SessionDiagnostic = {
  code: string;
  severity: string;
  message: string;
  labels?: { message: string; span: SessionSpan }[];
  notes?: string[];
};

export type SessionRecord = {
  schema_version: number;
  timestamp: number;
  tag: string | null;
  aven_version: string;
  aven_build_commit: string | null;
  subcommand: string;
  argv: string[];
  entry_path: string | null;
  entry_source_sha256: string | null;
  timings: { parse: number; name: number | null; check: number | null; total: number } | null;
  diagnostics: SessionDiagnostic[];
  exit_code: number;
  summary: { total: number; passed: number; failed: number; errored: number } | null;
};

export const GATE_TAG_MARKER = "#gate.";

export function gateTag(attemptId: string, round: number, probe: string): string {
  return `${attemptId}${GATE_TAG_MARKER}r${round}.${probe}`;
}

export function readSessionLog(path: string): SessionRecord[] {
  if (!existsSync(path)) return [];
  const out: SessionRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as SessionRecord);
    } catch {
      // A concurrently-appended partial line. Skip; the writer is O_APPEND
      // per-line so the next read gets it whole.
    }
  }
  return out;
}

/** Records the model produced itself, i.e. everything not tagged as a gate run. */
export function modelInvocations(records: SessionRecord[]): SessionRecord[] {
  return records.filter((r) => !(r.tag ?? "").includes(GATE_TAG_MARKER));
}
