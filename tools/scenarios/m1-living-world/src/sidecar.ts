// Drives the compiled sidecar binary as a child process: launch with the
// token on stdin, read the port from stdout, call it over authenticated
// HTTP, and stop it by signal. Every live child is tracked so a failed run
// never leaves one behind.

import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "../../../..");

/** The sidecar binary `apps/simulation/scripts/build-sidecar.sh` writes for this host. */
export function sidecarBinaryPath(): string {
  const triple =
    platform() === "darwin" && arch() === "arm64"
      ? "aarch64-apple-darwin"
      : platform() === "darwin"
        ? "x86_64-apple-darwin"
        : undefined;
  if (!triple) {
    throw new Error(`unsupported host: ${platform()}/${arch()}`);
  }
  return join(
    REPO_ROOT,
    "apps/desktop/src-tauri/binaries",
    `panthea-sim-${triple}`,
  );
}

/** Compiles the sidecar with the product build script and returns the binary path. */
export function buildSidecar(): string {
  const script = join(REPO_ROOT, "apps/simulation/scripts/build-sidecar.sh");
  const result = Bun.spawnSync(["bash", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`build-sidecar failed:\n${result.stderr.toString()}`);
  }
  const binary = sidecarBinaryPath();
  if (!existsSync(binary)) {
    throw new Error(`build-sidecar did not produce ${binary}`);
  }
  return binary;
}

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

export interface Sidecar {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly dataDir: string;
  /** Combined stdout/stderr the child has written so far. */
  log(): string;
  /** The same output line by line, each with the wall time it was read. */
  lines(): readonly { readonly at: number; readonly text: string }[];
  request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<HttpResult>;
  /** Sends `signal` and waits for the process to exit; resolves with its exit code. */
  stop(signal: "SIGTERM" | "SIGKILL"): Promise<number | null>;
  readonly exited: Promise<number | null>;
}

const live = new Set<Bun.Subprocess>();

/** Kills every child this module started that is still running. */
export function killAllSidecars(): void {
  for (const child of live) {
    child.kill("SIGKILL");
  }
  live.clear();
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    onText(decoder.decode(chunk, { stream: true }));
  }
}

const PORT_PATTERN = /PANTHEA_PORT=(\d+)/;
const START_TIMEOUT_MS = 15_000;

export interface StartOptions {
  /** How long to wait for the port line. Defaults to 15 s. */
  readonly startTimeoutMs?: number;
  /** Called with the child's pid as soon as it is spawned, and awaited before the token is written (for tests). */
  readonly onSpawn?: (pid: number) => void | Promise<void>;
  /** Extra environment for the child, on top of this process's and `PANTHEA_APP_DATA_DIR`. */
  readonly env?: Readonly<Record<string, string>>;
  /** The launch config line sent after the token, as the shell sends it: `{ models, offline, keys }`. Defaults to no settings, so no god takes a turn. */
  readonly launchConfig?: LaunchConfigLine;
}

/** What the shell hands the sidecar after its token: the model settings' routing config (or null), the offline switch, and keys by `keyRef`. */
export interface LaunchConfigLine {
  readonly models: object | null;
  readonly offline: boolean;
  readonly keys: Readonly<Record<string, string>>;
}

const NO_SETTINGS: LaunchConfigLine = {
  models: null,
  offline: false,
  keys: {},
};

/** How many sidecars this module started that are still running. */
export function liveSidecarCount(): number {
  return live.size;
}

/** Launches the binary against `dataDir`, hands it a fresh token and its launch config on stdin, and resolves once it prints its port. Stdin stays open: EOF makes the sidecar shut itself down. A child whose startup fails is killed before the error propagates. */
export async function startSidecar(
  binary: string,
  dataDir: string,
  options: StartOptions = {},
): Promise<Sidecar> {
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const token = crypto.randomUUID();
  const child = Bun.spawn([binary], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env, PANTHEA_APP_DATA_DIR: dataDir },
  });
  live.add(child);
  await options.onSpawn?.(child.pid);

  let output = "";
  const lines: { at: number; text: string }[] = [];
  let partial = "";
  let resolvePort!: (port: number) => void;
  const portPromise = new Promise<number>((resolvePromise) => {
    resolvePort = resolvePromise;
  });
  const onText = (text: string): void => {
    output += text;
    const at = Date.now();
    const parts = (partial + text).split("\n");
    partial = parts.pop() ?? "";
    for (const line of parts) lines.push({ at, text: line });
    const match = PORT_PATTERN.exec(output);
    if (match?.[1]) {
      resolvePort(Number(match[1]));
    }
  };
  void drain(child.stdout, onText);
  void drain(child.stderr, onText);

  const exited: Promise<number | null> = child.exited.then((code) => {
    live.delete(child);
    return code;
  });

  let port: number;
  try {
    try {
      child.stdin.write(
        `${token}\n${JSON.stringify(options.launchConfig ?? NO_SETTINGS)}\n`,
      );
      await child.stdin.flush();
    } catch (error) {
      // A child that closed its stdin or exited before reading the token breaks the pipe:
      // report its exit, and rethrow the write error only if it is still running.
      const code = await Promise.race([
        exited,
        Bun.sleep(1000).then(() => undefined),
      ]);
      if (code === undefined) throw error;
      throw new Error(
        `sidecar exited (${code}) before printing its port:\n${output}`,
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      port = await Promise.race([
        portPromise,
        exited.then((code) => {
          throw new Error(
            `sidecar exited (${code}) before printing its port:\n${output}`,
          );
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `sidecar did not print its port in ${startTimeoutMs} ms:\n${output}`,
                ),
              ),
            startTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  }

  const base = `http://127.0.0.1:${port}`;
  return {
    pid: child.pid,
    port,
    token,
    dataDir,
    log: () => output,
    lines: () => lines,
    exited,
    async request(method, path, body) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined
          ? {}
          : {
              body: typeof body === "string" ? body : JSON.stringify(body),
            }),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A non-JSON body (e.g. "Unauthorized") is returned as text.
      }
      return { status: response.status, body: parsed };
    },
    async stop(signal) {
      child.kill(signal);
      return exited;
    },
  };
}
