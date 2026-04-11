import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { createDefaultLooperConfig, getDefaultConfigPath } from "./defaults";
import { detectToolPaths } from "./tools";
import type {
  DeepPartial,
  LoadLooperConfigOptions,
  LoadedLooperConfig,
  LooperConfig,
  ToolPathsConfig,
} from "./types";
import { validateLooperConfig } from "./validate";

interface ParsedCliArgs {
  configPath?: string;
  overrides: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDeep<T>(base: T, override: DeepPartial<T>): T {
  if (Array.isArray(base) || Array.isArray(override)) {
    return (override ?? base) as T;
  }

  if (isRecord(base) && isRecord(override)) {
    const merged: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) {
        continue;
      }

      const current = merged[key];
      merged[key] =
        isRecord(current) && isRecord(value)
          ? mergeDeep(current, value)
          : value;
    }

    return merged as T;
  }

  return override as T;
}

function compactObject<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => compactObject(item)) as T;
  }

  if (isRecord(value)) {
    const compactedEntries = Object.entries(value)
      .map(([key, entryValue]) => [key, compactObject(entryValue)] as const)
      .filter(([, entryValue]) => entryValue !== undefined)
      .filter(
        ([, entryValue]) =>
          !isRecord(entryValue) || Object.keys(entryValue).length > 0,
      );

    return Object.fromEntries(compactedEntries) as T;
  }

  return value;
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }

  return undefined;
}

function matchesFlag(arg: string, flag: string): boolean {
  return arg === flag || arg.startsWith(`${flag}=`);
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  const overrides: Record<string, unknown> = {};
  let configPath: string | undefined;

  const takeValue = (index: number, flag: string): [string, number] => {
    const current = argv[index];
    if (!current) {
      throw new Error(`Missing value for ${flag}`);
    }

    const eqIndex = current.indexOf("=");
    if (eqIndex >= 0) {
      return [current.slice(eqIndex + 1), index];
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }

    return [next, index + 1];
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      continue;
    }

    switch (true) {
      case matchesFlag(arg, "--config"): {
        const [value, nextIndex] = takeValue(index, "--config");
        configPath = value;
        index = nextIndex;
        break;
      }
      case matchesFlag(arg, "--host"): {
        const [value, nextIndex] = takeValue(index, "--host");
        overrides.server = { ...(overrides.server as object), host: value };
        index = nextIndex;
        break;
      }
      case matchesFlag(arg, "--port"): {
        const [value, nextIndex] = takeValue(index, "--port");
        overrides.server = {
          ...(overrides.server as object),
          port: parseInteger(value),
        };
        index = nextIndex;
        break;
      }
      case matchesFlag(arg, "--db-path"): {
        const [value, nextIndex] = takeValue(index, "--db-path");
        overrides.storage = { ...(overrides.storage as object), dbPath: value };
        index = nextIndex;
        break;
      }
      case matchesFlag(arg, "--log-dir"): {
        const [value, nextIndex] = takeValue(index, "--log-dir");
        overrides.daemon = { ...(overrides.daemon as object), logDir: value };
        index = nextIndex;
        break;
      }
      case matchesFlag(arg, "--daemon-mode"): {
        const [value, nextIndex] = takeValue(index, "--daemon-mode");
        overrides.daemon = { ...(overrides.daemon as object), mode: value };
        index = nextIndex;
        break;
      }
      case matchesFlag(arg, "--bun-path"): {
        const [value, nextIndex] = takeValue(index, "--bun-path");
        overrides.tools = { ...(overrides.tools as object), bunPath: value };
        index = nextIndex;
        break;
      }
      case matchesFlag(arg, "--git-path"): {
        const [value, nextIndex] = takeValue(index, "--git-path");
        overrides.tools = { ...(overrides.tools as object), gitPath: value };
        index = nextIndex;
        break;
      }
      case matchesFlag(arg, "--gh-path"): {
        const [value, nextIndex] = takeValue(index, "--gh-path");
        overrides.tools = { ...(overrides.tools as object), ghPath: value };
        index = nextIndex;
        break;
      }
      case matchesFlag(arg, "--allow-auto-commit"): {
        const [value, nextIndex] = takeValue(index, "--allow-auto-commit");
        overrides.defaults = {
          ...(overrides.defaults as object),
          allowAutoCommit: parseBoolean(value),
        };
        index = nextIndex;
        break;
      }
      case matchesFlag(arg, "--allow-auto-push"): {
        const [value, nextIndex] = takeValue(index, "--allow-auto-push");
        overrides.defaults = {
          ...(overrides.defaults as object),
          allowAutoPush: parseBoolean(value),
        };
        index = nextIndex;
        break;
      }
      case matchesFlag(arg, "--allow-auto-approve"): {
        const [value, nextIndex] = takeValue(index, "--allow-auto-approve");
        overrides.defaults = {
          ...(overrides.defaults as object),
          allowAutoApprove: parseBoolean(value),
        };
        index = nextIndex;
        break;
      }
      case matchesFlag(arg, "--osascript-path"): {
        const [value, nextIndex] = takeValue(index, "--osascript-path");
        overrides.tools = {
          ...(overrides.tools as object),
          osascriptPath: value,
        };
        index = nextIndex;
        break;
      }
      default:
        throw new Error(`Unknown looperd argument: ${arg}`);
    }
  }

  return { configPath, overrides };
}

function buildEnvOverrides(
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  return compactObject({
    server: {
      host: env.LOOPER_HOST,
      port: parseInteger(env.LOOPER_PORT),
    },
    daemon: {
      logDir: env.LOOPER_LOG_DIR,
      mode: env.LOOPER_DAEMON_MODE,
      workingDirectory: env.LOOPER_WORKING_DIRECTORY,
    },
    storage: {
      dbPath: env.LOOPER_DB_PATH,
    },
    notifications: {
      inApp: parseBoolean(env.LOOPER_IN_APP_NOTIFICATIONS),
      osascript: {
        enabled: parseBoolean(env.LOOPER_OSASCRIPT_ENABLED),
      },
    },
    defaults: {
      allowAutoCommit: parseBoolean(env.LOOPER_ALLOW_AUTO_COMMIT),
      allowAutoPush: parseBoolean(env.LOOPER_ALLOW_AUTO_PUSH),
      allowAutoApprove: parseBoolean(env.LOOPER_ALLOW_AUTO_APPROVE),
    },
    tools: {
      bunPath: env.LOOPER_BUN_PATH,
      gitPath: env.LOOPER_GIT_PATH,
      ghPath: env.LOOPER_GH_PATH,
      osascriptPath: env.LOOPER_OSASCRIPT_PATH,
    },
  });
}

async function readConfigFile(
  path: string,
): Promise<{ data: Record<string, unknown>; present: boolean }> {
  try {
    const raw = await readFile(path, "utf8");
    return { data: JSON.parse(raw) as Record<string, unknown>, present: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { data: {}, present: false };
    }

    throw new Error(
      `Failed to read config file at ${path}: ${(error as Error).message}`,
    );
  }
}

function resolveConfigPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export async function loadLooperConfig(
  options: LoadLooperConfigOptions = {},
): Promise<LoadedLooperConfig> {
  const argv = options.argv ?? [];
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const parsedCli = parseCliArgs(argv);

  const configPath = resolveConfigPath(
    parsedCli.configPath ??
      env.LOOPER_CONFIG ??
      options.defaultConfigPath ??
      getDefaultConfigPath(),
    cwd,
  );

  const defaults = createDefaultLooperConfig(cwd);
  const fileConfig = await readConfigFile(configPath);
  const envOverrides = buildEnvOverrides(env);

  const mergedBase = mergeDeep(
    defaults,
    fileConfig.data as DeepPartial<LooperConfig>,
  );
  const mergedWithEnv = mergeDeep(
    mergedBase,
    envOverrides as DeepPartial<LooperConfig>,
  );
  const merged = mergeDeep(
    mergedWithEnv,
    parsedCli.overrides as DeepPartial<LooperConfig>,
  );

  const toolDetection = detectToolPaths(
    (merged.tools ?? {}) as ToolPathsConfig,
  );
  const config: LooperConfig = {
    ...merged,
    tools: toolDetection.paths,
  } as LooperConfig;

  await validateLooperConfig(config);

  return {
    config,
    metadata: {
      configPath,
      configFilePresent: fileConfig.present,
      cliOverrides: parsedCli.overrides,
      envOverrides,
      toolDetection: toolDetection.detection,
    },
  };
}
