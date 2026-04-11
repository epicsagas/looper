import { setTimeout as delay } from "node:timers/promises";

export interface CommandRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunCommandOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs?: number;
  gracefulShutdownMs?: number;
  maxOutputBytes?: number;
}

export class CommandExecutionError extends Error {
  constructor(
    message: string,
    public readonly result: CommandRunnerResult,
  ) {
    super(message);
    this.name = "CommandExecutionError";
  }
}

export async function runCommand(
  options: RunCommandOptions,
): Promise<CommandRunnerResult> {
  const startedAt = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  const gracefulShutdownMs = options.gracefulShutdownMs ?? 5_000;

  const subprocess = Bun.spawn({
    cmd: [options.command, ...options.args],
    cwd: options.cwd,
    env: sanitizeEnv(options.env),
    stdin: options.stdin ? "pipe" : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (options.stdin) {
    if (subprocess.stdin) {
      await subprocess.stdin.write(new TextEncoder().encode(options.stdin));
      await subprocess.stdin.end();
    }
  }

  const stdoutPromise = readStream(subprocess.stdout, maxOutputBytes);
  const stderrPromise = readStream(subprocess.stderr, maxOutputBytes);

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  if (options.timeoutMs) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      subprocess.kill("SIGTERM");
      void delay(gracefulShutdownMs).then(() => {
        if (subprocess.exitCode === null) {
          subprocess.kill("SIGKILL");
        }
      });
    }, options.timeoutMs);
  }

  const exitCode = await subprocess.exited;

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const result: CommandRunnerResult = {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
  };

  if (timedOut) {
    throw new CommandExecutionError("Command timed out", result);
  }

  if (exitCode !== 0) {
    throw new CommandExecutionError(
      `Command exited with code ${exitCode}`,
      result,
    );
  }

  return result;
}

export function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

async function readStream(
  stream: ReadableStream<Uint8Array> | undefined,
  maxOutputBytes: number,
): Promise<string> {
  if (!stream) {
    return "";
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    if (total >= maxOutputBytes) {
      continue;
    }

    const remaining = maxOutputBytes - total;
    const chunk =
      value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    total += chunk.byteLength;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}

function sanitizeEnv(
  env?: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
