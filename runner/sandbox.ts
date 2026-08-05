/**
 * Filesystem sandbox for the model-driven harness process.
 *
 * The gate never comes through here: it is trusted harness code and runs outside
 * the namespace. The agent harness, including every shell command it launches
 * for the model, does come through here.
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { runProcess } from "./proc.ts";
import type { SandboxMode } from "./schema.ts";

const SANDBOX_HOME = "/home/agent";
const STATE_DIR = ".agent-state";
const AVEN_SANDBOX_BIN = "/run/aven-bench/bin/aven";

export type SandboxCommandOptions = {
  dir: string;
  language: string;
  avenBin: string | null;
  /** Harness whose minimal state and credentials must exist in the namespace. */
  harness?: "opencode" | "codex";
};

export type SandboxAvailability = {
  ok: boolean;
  detail: string;
};

export function bwrapBin(): string {
  return process.env["BWRAP_BIN"] ?? "bwrap";
}

function executable(name: string): string {
  const path = Bun.which(name);
  if (!path) throw new Error(`required executable '${name}' is not on PATH`);
  return realpathSync(path);
}

function existingRealpath(path: string): string | null {
  return existsSync(path) ? realpathSync(path) : null;
}

/**
 * Test the namespace setup, not merely `bwrap --version`.
 *
 * A binary can be installed on a host whose user-namespace policy prevents it
 * from doing any useful work. Default-sandboxed runs must reject that host
 * before writing a sweep of harness-error rows.
 */
export async function sandboxAvailability(bin = bwrapBin()): Promise<SandboxAvailability> {
  if (!existsSync("/nix/store")) {
    return { ok: false, detail: "/nix/store is absent; the bubblewrap profile requires the Nix runtime store" };
  }
  let shell: string;
  try {
    shell = executable("bash");
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
  const proc = await runProcess(
    [
      bin,
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--share-net",
      "--ro-bind",
      "/nix/store",
      "/nix/store",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--chdir",
      "/",
      shell,
      "-c",
      "true",
    ],
    { cwd: process.cwd(), timeoutMs: 30_000 },
  );
  if (proc.spawnError) return { ok: false, detail: `cannot run ${bin}: ${proc.spawnError}` };
  if (proc.exitCode !== 0) {
    return {
      ok: false,
      detail: `${bin} could not create the sandbox (exit ${proc.exitCode}): ${proc.stderr.trim()}`,
    };
  }
  const version = await runProcess([bin, "--version"], { cwd: process.cwd(), timeoutMs: 30_000 });
  return { ok: true, detail: version.stdout.trim() || "bubblewrap (version unknown)" };
}

/**
 * Wrap an absolute command in the benchmark's bubblewrap profile.
 *
 * Bind order matters. The harness state directories are first mounted at their
 * XDG locations, then hidden under a private tmpfs at their host location inside
 * the project. This keeps opencode's database out of its project scan while
 * retaining it between repair rounds.
 */
export function bubblewrapCommand(command: string[], options: SandboxCommandOptions): string[] {
  if (command.length === 0 || !isAbsolute(command[0]!)) {
    throw new Error("the sandboxed command must start with an absolute executable path");
  }
  if (!isAbsolute(options.dir)) throw new Error(`sandbox work directory is not absolute: ${options.dir}`);

  const stateRoot = join(options.dir, STATE_DIR);
  const dataDir = join(stateRoot, "data");
  const cacheDir = join(stateRoot, "cache");
  const stateDir = join(stateRoot, "state");
  const codexDir = join(stateRoot, "codex");
  const harness = options.harness ?? "opencode";
  const harnessState = harness === "codex" ? [codexDir] : [dataDir, cacheDir, stateDir];
  for (const path of harnessState) mkdirSync(path, { recursive: true });

  const argv = [
    bwrapBin(),
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    // The harness calls a cloud API. This is intentionally a filesystem
    // boundary, not a network or exfiltration boundary.
    "--share-net",
    "--ro-bind",
    "/nix/store",
    "/nix/store",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    // The harness needs scratch space, but it must not inherit the host's shared
    // /tmp (where models found other checkouts and attempts in real runs).
    "--tmpfs",
    "/tmp",
  ];

  const madeDirs = new Set(["/", "/nix", "/nix/store", "/proc", "/dev", "/tmp"]);
  const addDir = (path: string): void => {
    if (madeDirs.has(path)) return;
    const parent = dirname(path);
    if (parent !== path) addDir(parent);
    argv.push("--dir", path);
    madeDirs.add(path);
  };
  const roBind = (source: string, target: string): void => {
    addDir(dirname(target));
    argv.push("--ro-bind", source, target);
  };

  // Exact resolver, hosts, NSS and CA files: enough for HTTPS without exposing
  // the rest of /etc.
  for (const [sourcePath, target] of [
    ["/etc/resolv.conf", "/etc/resolv.conf"],
    ["/etc/hosts", "/etc/hosts"],
    ["/etc/nsswitch.conf", "/etc/nsswitch.conf"],
    ["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/certs/ca-certificates.crt"],
  ] as const) {
    const source = existingRealpath(sourcePath);
    if (source) roBind(source, target);
  }

  addDir(dirname(options.dir));
  argv.push("--bind", options.dir, options.dir);

  const harnessPaths =
    harness === "codex"
      ? [SANDBOX_HOME, `${SANDBOX_HOME}/.codex`]
      : [
          SANDBOX_HOME,
          `${SANDBOX_HOME}/.config/opencode`,
          `${SANDBOX_HOME}/.local/share`,
          `${SANDBOX_HOME}/.cache`,
          `${SANDBOX_HOME}/.local/state`,
        ];
  for (const path of harnessPaths) {
    addDir(path);
  }
  if (harness === "codex") {
    argv.push("--bind", codexDir, `${SANDBOX_HOME}/.codex`);
  } else {
    argv.push(
      "--bind",
      dataDir,
      `${SANDBOX_HOME}/.local/share/opencode`,
      "--bind",
      cacheDir,
      `${SANDBOX_HOME}/.cache/opencode`,
      "--bind",
      stateDir,
      `${SANDBOX_HOME}/.local/state/opencode`,
    );
  }

  // Mount only the chosen harness's configuration and authentication files.
  // They are over-mounted read-only while mutable state stays attempt-local.
  const hostConfig = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  const hostData = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local/share");
  if (harness === "codex") {
    const hostCodex = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
    const config = existingRealpath(join(hostCodex, "config.toml"));
    const auth = existingRealpath(join(hostCodex, "auth.json"));
    if (config) roBind(config, `${SANDBOX_HOME}/.codex/config.toml`);
    if (auth) roBind(auth, `${SANDBOX_HOME}/.codex/auth.json`);
  } else {
    const config = existingRealpath(join(hostConfig, "opencode/opencode.jsonc"));
    const auth = existingRealpath(join(hostData, "opencode/auth.json"));
    const account = existingRealpath(join(hostData, "opencode/account.json"));
    if (config) roBind(config, `${SANDBOX_HOME}/.config/opencode/opencode.jsonc`);
    if (auth) roBind(auth, `${SANDBOX_HOME}/.local/share/opencode/auth.json`);
    if (account) roBind(account, `${SANDBOX_HOME}/.local/share/opencode/account.json`);
  }

  const pathDirs = new Set<string>([
    dirname(command[0]!),
    ...["bash", "git", "ls", "find", "sed", "grep"].map((name) => dirname(executable(name))),
  ]);
  if (options.language === "python") pathDirs.add(dirname(executable("python3")));
  if (options.language === "ruby") pathDirs.add(dirname(executable("ruby")));

  // Caller passes avenBin only under toolPolicy self-verify. Under no-verify the
  // model must not find a compiler; the trusted gate uses host AVEN_BIN outside
  // this namespace.
  if (options.language === "aven" && options.avenBin) {
    const avenBin = realpathSync(options.avenBin);
    roBind(avenBin, AVEN_SANDBOX_BIN);
    pathDirs.add(dirname(AVEN_SANDBOX_BIN));
  }

  argv.push(
    // Hide the host backing directory from opencode's project scan. Its three
    // mounts at the XDG paths above remain live and persist across rounds.
    "--tmpfs",
    stateRoot,
    "--setenv",
    "HOME",
    SANDBOX_HOME,
    "--setenv",
    "USER",
    "agent",
    "--setenv",
    "LOGNAME",
    "agent",
    "--setenv",
    "XDG_CONFIG_HOME",
    `${SANDBOX_HOME}/.config`,
    "--setenv",
    "XDG_DATA_HOME",
    `${SANDBOX_HOME}/.local/share`,
    "--setenv",
    "XDG_CACHE_HOME",
    `${SANDBOX_HOME}/.cache`,
    "--setenv",
    "XDG_STATE_HOME",
    `${SANDBOX_HOME}/.local/state`,
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "LC_ALL",
    "C.UTF-8",
    "--setenv",
    "SHELL",
    executable("bash"),
    "--setenv",
    "PATH",
    [...pathDirs].join(":"),
    "--setenv",
    "SSL_CERT_FILE",
    "/etc/ssl/certs/ca-certificates.crt",
    "--setenv",
    "NIX_SSL_CERT_FILE",
    "/etc/ssl/certs/ca-certificates.crt",
  );
  if (harness === "codex") {
    // A host CODEX_HOME would point outside the namespace; pin the mounted copy.
    argv.push("--setenv", "CODEX_HOME", `${SANDBOX_HOME}/.codex`);
  }
  if (options.language === "aven" && options.avenBin) {
    argv.push("--setenv", "AVEN_BIN", AVEN_SANDBOX_BIN);
  }
  argv.push("--chdir", options.dir, ...command);
  return argv;
}

export function sandboxLabel(enabled: boolean): SandboxMode {
  return enabled ? "bubblewrap" : "none";
}
