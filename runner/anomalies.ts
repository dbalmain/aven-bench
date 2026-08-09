/**
 * End-of-sweep policy notes for shell activity and work-directory escapes.
 *
 * The shape of these lines matters more than their counts. A skimmer must see
 * at a glance whether any row **actually verified its own work** under
 * `toolPolicy: "no-verify"`. On the Aven arm that signal is
 * `modelToolInvocations > 0` (aven session-log entries the model produced); on
 * the control arms it is `modelRuntimeInvocations` read together with `sandbox`.
 * Neither is a bare `shellCommands` count.
 *
 * Sandboxed shell under no-verify is interesting — the model spent turns on
 * `ls`/`cat` and the like — but it is not a contamination flag. Bubblewrap under
 * no-verify mounts neither `aven` nor the control arms' interpreters, so a
 * command that names one was denied rather than run. Unsandboxed shell is
 * different: there is no filesystem boundary at all and the host PATH has
 * everything.
 *
 * ## Reading rows written before schema 13
 *
 * Until 2026-08-09 `python3` and `ruby` were on the model's sandbox PATH
 * regardless of tool policy, while `aven` was mounted only under `self-verify`.
 * So on a pre-13 row `no-verify` means "could not check its own work" on the
 * Aven arm and "could, unrecorded" on the controls, and nothing in the record
 * distinguishes a control row that self-verified from one that did not. The
 * campaign's headline cross-language deltas — `phase3-holdout-02` and
 * `-03` — were measured that way, which makes them a **lower bound** on Aven's
 * relative standing rather than a clean comparison. `modelRuntimeInvocations`
 * is absent on those rows (hence `number | null | undefined` below); they are
 * still valid data and must not be rewritten, only read with that caveat.
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
  repairRounds: readonly {
    modelToolInvocations: number | null;
    /** Undefined on rows written before schema 13 — see the header. */
    modelRuntimeInvocations?: number | null;
  }[];
};

/** Sum of per-round model-initiated `aven` invocations (0 when null / off-arm). */
export function sumModelToolInvocations(
  record: Pick<PolicyAnomalyRow, "repairRounds">,
): number {
  return record.repairRounds.reduce((n, r) => n + (r.modelToolInvocations ?? 0), 0);
}

/** Sum of per-round interpreter commands (0 when null / undefined / off-arm). */
export function sumModelRuntimeInvocations(
  record: Pick<PolicyAnomalyRow, "repairRounds">,
): number {
  return record.repairRounds.reduce((n, r) => n + (r.modelRuntimeInvocations ?? 0), 0);
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
  const selfVerified = (r: PolicyAnomalyRow): boolean => sumModelToolInvocations(r) > 0;
  const namedRuntime = (r: PolicyAnomalyRow): boolean => sumModelRuntimeInvocations(r) > 0;
  // A row is reported once, by its strongest signal: interpreter use implies
  // shell use, and shell use is the weakest thing to say about it.
  const quiet = (r: PolicyAnomalyRow): boolean => !selfVerified(r) && !namedRuntime(r);

  // Loud: the model actually ran `aven` while told not to verify.
  const toolchain = noVerify.filter(selfVerified);
  if (toolchain.length > 0) {
    lines.push(
      `  !! ${toolchain.length} row(s) invoked the aven toolchain under toolPolicy=no-verify` +
        ` (modelToolInvocations > 0 — actual self-verification):\n` +
        detailLines(toolchain, (r) => `${sumModelToolInvocations(r)} invocation(s)`),
    );
  }

  // Loud: an interpreter the host PATH really had, on an arm told not to verify.
  const unsandboxedRuntime = noVerify.filter(
    (r) => !selfVerified(r) && namedRuntime(r) && r.sandbox === "none",
  );
  if (unsandboxedRuntime.length > 0) {
    lines.push(
      `  !! ${unsandboxedRuntime.length} row(s) ran their language runtime under toolPolicy=no-verify` +
        ` (sandbox=none, so the host PATH had it — actual self-verification):\n` +
        detailLines(unsandboxedRuntime, (r) => `${sumModelRuntimeInvocations(r)} command(s)`),
    );
  }

  // Quiet: the model reached for its interpreter and the namespace had none.
  // Not nothing — it says the model tried to self-verify — but not a breach.
  const sandboxedRuntime = noVerify.filter(
    (r) => !selfVerified(r) && namedRuntime(r) && r.sandbox === "bubblewrap",
  );
  if (sandboxedRuntime.length > 0) {
    lines.push(
      `  ${sandboxedRuntime.length} sandboxed row(s) named their language runtime under no-verify` +
        ` (not mounted under this policy; attempted, not run):\n` +
        detailLines(sandboxedRuntime, (r) => `${sumModelRuntimeInvocations(r)} command(s)`),
    );
  }

  // Loud: no sandbox, so shell could reach host tools, repo, answers, anything.
  const unsandboxedShell = noVerify.filter(
    (r) => r.sandbox === "none" && r.shellCommands > 0 && quiet(r),
  );
  if (unsandboxedShell.length > 0) {
    lines.push(
      `  !! ${unsandboxedShell.length} unsandboxed row(s) ran shell commands under toolPolicy=no-verify` +
        ` (no filesystem containment — treat as suspect):\n` +
        detailLines(unsandboxedShell, (r) => `${r.shellCommands} command(s)`),
    );
  }

  // Quiet: sandboxed shell that reached for no toolchain at all. Kept on purpose
  // — burning rounds on exploration is worth knowing — but not a contamination
  // flag.
  const sandboxedShell = noVerify.filter(
    (r) => r.sandbox === "bubblewrap" && r.shellCommands > 0 && quiet(r),
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
