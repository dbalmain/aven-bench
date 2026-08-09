/**
 * Which language runtime an arm's *model* may use, and how to spot it reaching
 * for one.
 *
 * `toolPolicy: "no-verify"` means the model cannot check its own work before
 * submitting, and the cross-language delta is only fair if that means the same
 * thing on every arm. It did not: the Aven binary was mounted into the sandbox
 * only under `self-verify`, while `python3` and `ruby` were mounted
 * unconditionally, so a control-arm model could run its solution and an Aven one
 * could not — an uninstrumented capability in the exact dimension the campaign
 * measures. This module is the single place that says what an arm's runtime is,
 * so the mount decision and the compliance counter cannot drift apart.
 *
 * Aven is deliberately absent from the table. It is mounted by path (`avenBin`,
 * bound at a fixed sandbox location) rather than found by name, and its
 * compliance signal is ground truth from `AVEN_SESSION_LOG` — every `aven`
 * process the model starts writes a record. See `session.ts`.
 */

type LanguageRuntime = {
  /** Executables put on the model's sandbox PATH when the caller grants a runtime. */
  readonly mount: readonly string[];
  /** Names that count as "the model reached for its runtime" in a shell log. */
  readonly detect: readonly string[];
};

const RUNTIMES: Readonly<Record<string, LanguageRuntime>> = {
  // `python` is not mounted (the host and the gate both use `python3`) but is
  // still detected: a model typing it was trying to run its solution.
  python: { mount: ["python3"], detect: ["python3", "python"] },
  ruby: { mount: ["ruby"], detect: ["ruby"] },
};

/** Executables to expose for an arm, or `[]` when it has no name-found runtime. */
export function runtimeExecutables(language: string): readonly string[] {
  return RUNTIMES[language]?.mount ?? [];
}

/**
 * Command heads: start of string, a shell separator, or an opening quote.
 *
 * Matching a bare word anywhere would count `ls ruby-notes`; anchoring to the
 * whole string would miss `cd /tmp && python3 x.py` and `bash -c "ruby x.rb"`,
 * which is how agent harnesses actually phrase things. Leading `VAR=value`
 * assignments are skipped, and an absolute or relative path prefix is allowed so
 * `/nix/store/…/bin/python3` counts.
 */
const COMMAND_HEAD = String.raw`(?:^|[\n;&|(\`'"]|\$\()\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:[\w./+-]*/)?`;

const patterns = new Map<string, RegExp[]>();

function runtimePatterns(language: string): RegExp[] {
  let cached = patterns.get(language);
  if (!cached) {
    cached = (RUNTIMES[language]?.detect ?? []).map(
      (name) => new RegExp(`${COMMAND_HEAD}${name}\\b`, "g"),
    );
    patterns.set(language, cached);
  }
  return cached;
}

/**
 * How many times one shell command names this arm's language runtime.
 *
 * A count of *attempts*, not of successful runs: the harness event streams
 * report what was launched, never its exit status, so "ran the interpreter" and
 * "typed the interpreter and got `command not found`" are indistinguishable
 * per row. The `sandbox` field is what separates them — under `bubblewrap` the
 * runtime is absent unless the caller granted it, under `none` the host PATH has
 * it — and `anomalies.ts` reads the pair. The heuristic is deliberately biased
 * toward a false alarm (`echo "python3 is slow"` counts) over a miss, because
 * over-reporting costs a line in a summary and under-reporting costs the
 * campaign's headline comparison. Returns 0 on the Aven arm, which has a real
 * counter instead.
 */
export function countRuntimeInvocations(language: string, command: string): number {
  let n = 0;
  for (const pattern of runtimePatterns(language)) {
    pattern.lastIndex = 0;
    while (pattern.exec(command) !== null) n++;
  }
  return n;
}
