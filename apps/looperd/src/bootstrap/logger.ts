import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { LoggingConfig } from "../config/index";

const LOG_PRIORITIES = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export async function createLogger(
  config: LoggingConfig,
  logDir: string,
): Promise<Logger> {
  await mkdir(logDir, { recursive: true });
  const logFilePath = join(logDir, "looperd.log");

  const write = (
    level: keyof typeof LOG_PRIORITIES,
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    if (LOG_PRIORITIES[level] < LOG_PRIORITIES[config.level]) {
      return;
    }

    const entry = {
      ts: formatLocalTimestamp(new Date()),
      level,
      message,
      context,
    };

    const line = `${JSON.stringify(entry)}\n`;
    void appendFile(logFilePath, line).catch((error) => {
      console.error(`failed to write looperd log: ${(error as Error).message}`);
    });

    if (level === "error" || level === "warn") {
      console.error(line.trim());
      return;
    }

    console.log(line.trim());
  };

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}

function formatLocalTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  const seconds = String(shifted.getUTCSeconds()).padStart(2, "0");
  const milliseconds = String(shifted.getUTCMilliseconds()).padStart(3, "0");

  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffsetMinutes / 60)).padStart(
    2,
    "0",
  );
  const offsetRemainderMinutes = String(absoluteOffsetMinutes % 60).padStart(
    2,
    "0",
  );

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${sign}${offsetHours}:${offsetRemainderMinutes}`;
}

export { formatLocalTimestamp };
