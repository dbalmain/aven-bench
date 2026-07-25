/**
 * Subprocess execution with a hard timeout.
 *
 * §3c requires hard timeouts and no interactivity. Every child gets stdin closed
 * (an agent harness that decides to ask a question must die, not hang the sweep),
 * a wall-clock kill, and a SIGKILL escalation for children that ignore SIGTERM.
 *
 * Nothing here throws. A missing binary is a `spawnError`, which the caller turns
 * into `harness_error` — never into a model failure.
 */

export type ProcResult = {
  argv: string[];
  cwd: string;
  /** null when the process was killed rather than exiting on its own. */
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  wallMs: number;
  timedOut: boolean;
  /** Set when the process could not be started at all. */
  spawnError: string | null;
};

export type ProcOptions = {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Truncate each stream to this many characters, keeping head and tail. */
  maxOutputChars?: number;
};

const DEFAULT_MAX_OUTPUT = 400_000;

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 40) / 2);
  return `${text.slice(0, half)}\n…[${text.length - 2 * half} characters elided]…\n${text.slice(-half)}`;
}

export async function runProcess(argv: string[], opts: ProcOptions): Promise<ProcResult> {
  const started = performance.now();
  const base: ProcResult = {
    argv,
    cwd: opts.cwd,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    wallMs: 0,
    timedOut: false,
    spawnError: null,
  };
  const max = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      // Closed stdin: a prompt for input becomes an immediate EOF, not a hang.
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
  } catch (err) {
    return { ...base, wallMs: performance.now() - started, spawnError: String(err) };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, opts.killGraceMs ?? 5_000).unref?.();
  }, opts.timeoutMs);

  let stdout = "";
  let stderr = "";
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
  } catch (err) {
    clearTimeout(timer);
    return { ...base, wallMs: performance.now() - started, spawnError: String(err) };
  }
  clearTimeout(timer);

  return {
    ...base,
    exitCode: proc.exitCode,
    signal: proc.signalCode ?? null,
    stdout: truncateMiddle(stdout, max),
    stderr: truncateMiddle(stderr, max),
    wallMs: performance.now() - started,
    timedOut,
  };
}

/** A counting semaphore. Per-adapter concurrency caps, nothing more. */
export class Semaphore {
  private available: number;
  private waiting: (() => void)[] = [];

  constructor(readonly limit: number) {
    this.available = Math.max(1, limit);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return () => this.release();
  }

  async with<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.available++;
  }
}

/** Run `fn` over `items` with at most `n` in flight, preserving result order. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, n), items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}
