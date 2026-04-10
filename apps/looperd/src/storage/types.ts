export type StorageMode = "sqlite";

export interface StorageHealth {
  ok: boolean;
  mode: StorageMode;
  dbPath: string;
  migration: {
    latestAvailableId?: string;
    latestAppliedId?: string;
    pendingCount: number;
  };
  details?: string;
}

export interface StorageMigration {
  id: string;
  fileName: string;
}

export interface AppliedMigration {
  id: string;
  appliedAt: string;
}

export interface MigrationStatus {
  available: StorageMigration[];
  applied: AppliedMigration[];
  pending: StorageMigration[];
}

export interface MigrationRunResult {
  appliedIds: string[];
  skippedIds: string[];
  backupPath?: string;
}

export interface MigrationRunner {
  status(): MigrationStatus;
  runPending(): MigrationRunResult;
}

export interface StorageDriver {
  initialize(options?: {
    autoMigrate?: boolean;
    requireBackup?: boolean;
  }): void;
  backup(): string;
  healthcheck(): StorageHealth;
  close(): void;
}

export interface LoopRecord {
  id: string;
  type: string;
  targetType: string;
  targetId?: string | null;
  repo?: string | null;
  prNumber?: number | null;
  status: string;
  configJson?: string | null;
  metadataJson?: string | null;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  loopId: string;
  status: string;
  currentStep?: string | null;
  lastCompletedStep?: string | null;
  checkpointJson?: string | null;
  summary?: string | null;
  errorMessage?: string | null;
  startedAt: string;
  lastHeartbeatAt?: string | null;
  endedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  loopId?: string | null;
  repo?: string | null;
  prNumber?: number | null;
  metadataJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskItemRecord {
  id: string;
  taskId: string;
  content: string;
  status: string;
  position: number;
  source: string;
  metadataJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestSnapshotRecord {
  id: string;
  repo: string;
  prNumber: number;
  headSha: string;
  payloadJson: string;
  capturedAt: string;
  createdAt: string;
}

export interface EventLogRecord {
  id: string;
  eventType: string;
  entityType?: string | null;
  entityId?: string | null;
  payloadJson: string;
  createdAt: string;
}

export interface LockRecord {
  key: string;
  owner: string;
  reason?: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
