import type {
  EventLogRecord,
  LockRecord,
  LoopRecord,
  MigrationStatus,
  ProjectRecord,
  PullRequestSnapshotRecord,
  RunRecord,
  StorageHealth,
  TaskItemRecord,
  TaskRecord,
} from "./types";

export interface Store {
  withTransaction<T>(fn: (store: Store) => T): T;

  projects: {
    upsert(record: ProjectRecord): void;
    getById(id: string): ProjectRecord | null;
    list(): ProjectRecord[];
  };

  loops: {
    upsert(record: LoopRecord): void;
    getById(id: string): LoopRecord | null;
    list(): LoopRecord[];
  };

  runs: {
    upsert(record: RunRecord): void;
    getById(id: string): RunRecord | null;
    list(): RunRecord[];
    listByLoop(loopId: string): RunRecord[];
  };

  tasks: {
    upsert(record: TaskRecord): void;
    getById(id: string): TaskRecord | null;
    list(): TaskRecord[];
  };

  taskItems: {
    upsert(record: TaskItemRecord): void;
    listByTask(taskId: string): TaskItemRecord[];
    getById(id: string): TaskItemRecord | null;
  };

  pullRequestSnapshots: {
    upsert(record: PullRequestSnapshotRecord): void;
    list(): PullRequestSnapshotRecord[];
    getLatest(repo: string, prNumber: number): PullRequestSnapshotRecord | null;
  };

  events: {
    append(record: EventLogRecord): void;
    list(limit?: number): EventLogRecord[];
    listByEntity(entityType: string, entityId: string): EventLogRecord[];
  };

  locks: {
    acquire(record: LockRecord): boolean;
    release(key: string): void;
    get(key: string): LockRecord | null;
    listExpired(nowIso: string): LockRecord[];
  };

  schema: {
    getMigrationStatus(): MigrationStatus;
    healthcheck(): StorageHealth;
    backup(): string;
  };
}
