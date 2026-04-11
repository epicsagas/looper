export const AGENT_VENDORS = [
  "claude-code",
  "codex",
  "opencode",
  "cursor-cli",
] as const;
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const AUTH_MODES = ["none", "local-token"] as const;
export const DAEMON_MODES = ["foreground", "launchd"] as const;
export const OPEN_PR_STRATEGIES = [
  "all_done",
  "first_commit",
  "manual",
] as const;
export const NOTIFICATION_SOUND_LEVELS = [
  "action_required",
  "failure",
] as const;

export type AgentVendor = (typeof AGENT_VENDORS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type AuthMode = (typeof AUTH_MODES)[number];
export type DaemonMode = (typeof DAEMON_MODES)[number];
export type OpenPrStrategy = (typeof OPEN_PR_STRATEGIES)[number];
export type NotificationSoundLevel = (typeof NOTIFICATION_SOUND_LEVELS)[number];

export interface ServerConfig {
  host: string;
  port: number;
  baseUrl?: string;
  authMode: AuthMode;
  localToken?: string;
}

export interface StorageConfig {
  mode: "sqlite";
  dbPath: string;
  backupDir?: string;
}

export interface SchedulerConfig {
  pollIntervalSeconds: number;
  maxConcurrentRuns: number;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
}

export interface AgentConfig {
  vendor?: AgentVendor;
  model?: string;
  params?: Record<string, unknown>;
  env?: Record<string, string>;
}

export interface NotificationConfig {
  inApp: boolean;
  osascript: {
    enabled: boolean;
    soundForLevels?: NotificationSoundLevel[];
    throttleWindowSeconds: number;
  };
}

export interface LoggingConfig {
  level: LogLevel;
  maxSizeMB: number;
  maxFiles: number;
}

export interface ToolPathsConfig {
  bunPath?: string;
  gitPath?: string;
  ghPath?: string;
  osascriptPath?: string;
}

export interface DaemonConfig {
  mode: DaemonMode;
  plistPath?: string;
  logDir: string;
  workingDirectory: string;
  environment?: Record<string, string>;
}

export interface PackageConfig {
  distribution: "npm";
  autoMigrateOnStartup: boolean;
  requireBackupBeforeMigrate: boolean;
}

export interface DefaultsConfig {
  baseBranch: string;
  allowAutoCommit: boolean;
  allowAutoPush: boolean;
  allowAutoApprove: boolean;
  allowAutoMerge: boolean;
  allowRiskyFixes: boolean;
  openPrStrategy?: OpenPrStrategy;
}

export interface ProjectRefConfig {
  id: string;
  name: string;
  repoPath: string;
  baseBranch?: string;
  worktreeRoot?: string;
}

export interface LooperConfig {
  server: ServerConfig;
  storage: StorageConfig;
  scheduler: SchedulerConfig;
  agent: AgentConfig;
  logging: LoggingConfig;
  notifications: NotificationConfig;
  tools: ToolPathsConfig;
  daemon: DaemonConfig;
  package: PackageConfig;
  defaults: DefaultsConfig;
  projects: ProjectRefConfig[];
}

export interface LoadConfigMetadata {
  configPath: string;
  configFilePresent: boolean;
  cliOverrides: Record<string, unknown>;
  envOverrides: Record<string, unknown>;
  toolDetection: Record<
    keyof ToolPathsConfig,
    "configured" | "detected" | "missing"
  >;
}

export interface LoadedLooperConfig {
  config: LooperConfig;
  metadata: LoadConfigMetadata;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(
      `Invalid looper config (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
    );
    this.name = "ConfigValidationError";
  }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? U[]
    : T[K] extends Record<string, unknown>
      ? DeepPartial<T[K]>
      : T[K];
};

export interface LoadLooperConfigOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  defaultConfigPath?: string;
}
