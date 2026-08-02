/**
 * End-of-sweep policy notes for shell activity and work-directory escapes.
 *
 * The shape of these lines matters more than their counts. A skimmer must see
 * at a glance whether any row **actually verified its own work** under
 * `toolPolicy: "no-verify"`. That signal is `modelToolInvocations > 0` (aven
 * session-log entries the model produced), not a bare `shellCommands` count.
 *
 * Sandboxed shell under no-verify is interesting — the model spent turns on
 * `ls`/`cat` and the like — but it is not a contamination flag. Bubblewrap
 * under no-verify does not mount `aven`; interpreters on the other arms can
 * still run ad-hoc code, yet they cannot see the hidden suite. Unsandboxed
 * shell is different: there is no filesystem boundary at all.
 */

import type { SandboxMode, ToolPolicy } from "./schema.ts";

/** Fields the summary needs; fixtures supply only these. */
export type PolicyAnomalyRow = {
  language: string;
  taskId: string;
  sampleIndex: number;
  toolPolicy: ToolPolicy | string;
  sandbox: SandboxMode | string;
  shellCommands: number;
  outsideWorkdirTouches: number;
  repairRounds: readonly { modelToolInvocations: number | null }[];
};

/** Sum of per-round model-initiated `aven` invocations (0 when null / off-arm). */
export function sumModelToolInvocations(
  record: Pick<PolicyAnomalyRow, "repairRounds">,
): number {
  return record.repairRounds.reduce((n, r) => n + (r.modelToolInvocations ?? 0), 0);
}

function rowLabel(r: Pick<PolicyAnomalyRow, "language" | "taskId" | "sampleIndex">): string {
  return `${r.language} ${r.taskId} s${r.sampleIndex}`;
}

function detailLines(
  rows: readonly PolicyAnomalyRow[],
  detail: (r: PolicyAnomalyRow) => string,
): string {
  return rows.map((r) => `       ${rowLabel(r)}: ${detail(r)}`).join("\n");
}

/**
 * Summary footer lines for policy / containment notes.
 *
 * Lines that begin with `!!` are real problems (self-verification under
 * no-verify, or unsandboxed escapes). Lines without `!!` are factual activity
 * reports that must not read as "throw this row away".
 */
export function policyAnomalyLines(records: readonly PolicyAnomalyRow[]): string[] {
  const lines: string[] = [];
  const noVerify = records.filter((r) => r.toolPolicy === "no-verify");

  // Loud: the model actually ran `aven` while told not to verify.
  const toolchain = noVerify.filter((r) => sumModelToolInvocations(r) > 0);
  if (toolchain.length > 0) {
    lines.push(
      `  !! ${toolchain.length} row(s) invoked the aven toolchain under toolPolicy=no-verify` +
        ` (modelToolInvocations > 0 — actual self-verification):\n` +
        detailLines(toolchain, (r) => `${sumModelToolInvocations(r)} invocation(s)`),
    );
  }

  // Loud: no sandbox, so shell could reach host tools, repo, answers, anything.
  const unsandboxedShell = noVerify.filter(
    (r) => r.sandbox === "none" && r.shellCommands > 0 && sumModelToolInvocations(r) === 0,
  );
  if (unsandboxedShell.length > 0) {
    lines.push(
      `  !! ${unsandboxedShell.length} unsandboxed row(s) ran shell commands under toolPolicy=no-verify` +
        ` (no filesystem containment — treat as suspect):\n` +
        detailLines(unsandboxedShell, (r) => `${r.shellCommands} command(s)`),
    );
  }

  // Quiet: sandboxed shell with no aven invocations. Kept on purpose — burning
  // rounds on exploration is worth knowing — but not a contamination flag.
  const sandboxedShell = noVerify.filter(
    (r) => r.sandbox === "bubblewrap" && r.shellCommands > 0 && sumModelToolInvocations(r) === 0,
  );
  if (sandboxedShell.length > 0) {
    lines.push(
      `  ${sandboxedShell.length} sandboxed row(s) used the shell under no-verify` +
        ` (no aven invocations; activity only, not a contamination flag):\n` +
        detailLines(sandboxedShell, (r) => `${r.shellCommands} command(s)`),
    );
  }

  // Escapes: sandbox means the path was *named* and *denied*; unsandboxed means
  // the read may have succeeded.
  const escapedSandbox = records.filter(
    (r) => r.outsideWorkdirTouches > 0 && r.sandbox === "bubblewrap",
  );
  const escapedNone = records.filter((r) => r.outsideWorkdirTouches > 0 && r.sandbox === "none");
  if (escapedNone.length > 0) {
    lines.push(
      `  !! ${escapedNone.length} unsandboxed row(s) named paths outside their work directory` +
        ` (access was not blocked — treat as suspect):\n` +
        detailLines(escapedNone, (r) => `${r.outsideWorkdirTouches} path(s)`),
    );
  }
  if (escapedSandbox.length > 0) {
    lines.push(
      `  ${escapedSandbox.length} sandboxed row(s) named paths outside their work directory` +
        ` (sandbox denied access; not a contamination flag):\n` +
        detailLines(escapedSandbox, (r) => `${r.outsideWorkdirTouches} path(s)`),
    );
  }

  return lines;
}
