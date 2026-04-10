import type { Store } from "../store";
import type {
  EventLogRecord,
  LockRecord,
  LoopRecord,
  PullRequestSnapshotRecord,
  RunRecord,
  TaskItemRecord,
  TaskRecord,
} from "../types";
import { SqliteDbCoordinator } from "./db";

export interface SqliteStoreOptions {
  dbPath: string;
  backupDir?: string;
  migrationsDir?: string;
}

export class SqliteStore implements Store {
  private readonly coordinator: SqliteDbCoordinator;

  constructor(options: SqliteStoreOptions) {
    this.coordinator = new SqliteDbCoordinator(options);
  }

  public initialize(options?: {
    autoMigrate?: boolean;
    requireBackup?: boolean;
  }): void {
    this.coordinator.initialize(options);
  }

  public close(): void {
    this.coordinator.close();
  }

  public withTransaction<T>(fn: (store: Store) => T): T {
    return this.coordinator.withTransaction(() => fn(this));
  }

  public readonly loops = {
    upsert: (record: LoopRecord): void => {
      this.coordinator.db
        .query(`
          INSERT INTO loops (id, type, target_type, target_id, repo, pr_number, status, config_json, metadata_json, last_run_at, next_run_at, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
          ON CONFLICT(id) DO UPDATE SET
            type=excluded.type,
            target_type=excluded.target_type,
            target_id=excluded.target_id,
            repo=excluded.repo,
            pr_number=excluded.pr_number,
            status=excluded.status,
            config_json=excluded.config_json,
            metadata_json=excluded.metadata_json,
            last_run_at=excluded.last_run_at,
            next_run_at=excluded.next_run_at,
            updated_at=excluded.updated_at
        `)
        .run(
          record.id,
          record.type,
          record.targetType,
          record.targetId ?? null,
          record.repo ?? null,
          record.prNumber ?? null,
          record.status,
          record.configJson ?? null,
          record.metadataJson ?? null,
          record.lastRunAt ?? null,
          record.nextRunAt ?? null,
          record.createdAt,
          record.updatedAt,
        );
    },
    getById: (id: string): LoopRecord | null => {
      const row = this.coordinator.db
        .query("SELECT * FROM loops WHERE id = ?1")
        .get(id) as Record<string, unknown> | null;
      return row ? mapLoop(row) : null;
    },
    list: (): LoopRecord[] => {
      const rows = this.coordinator.db
        .query("SELECT * FROM loops ORDER BY updated_at DESC")
        .all() as Record<string, unknown>[];
      return rows.map(mapLoop);
    },
  };

  public readonly runs = {
    upsert: (record: RunRecord): void => {
      this.coordinator.db
        .query(`
          INSERT INTO runs (id, loop_id, status, current_step, last_completed_step, checkpoint_json, summary, error_message, started_at, last_heartbeat_at, ended_at, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
          ON CONFLICT(id) DO UPDATE SET
            status=excluded.status,
            current_step=excluded.current_step,
            last_completed_step=excluded.last_completed_step,
            checkpoint_json=excluded.checkpoint_json,
            summary=excluded.summary,
            error_message=excluded.error_message,
            started_at=excluded.started_at,
            last_heartbeat_at=excluded.last_heartbeat_at,
            ended_at=excluded.ended_at,
            updated_at=excluded.updated_at
        `)
        .run(
          record.id,
          record.loopId,
          record.status,
          record.currentStep ?? null,
          record.lastCompletedStep ?? null,
          record.checkpointJson ?? null,
          record.summary ?? null,
          record.errorMessage ?? null,
          record.startedAt,
          record.lastHeartbeatAt ?? null,
          record.endedAt ?? null,
          record.createdAt,
          record.updatedAt,
        );
    },
    getById: (id: string): RunRecord | null => {
      const row = this.coordinator.db
        .query("SELECT * FROM runs WHERE id = ?1")
        .get(id) as Record<string, unknown> | null;
      return row ? mapRun(row) : null;
    },
    listByLoop: (loopId: string): RunRecord[] => {
      const rows = this.coordinator.db
        .query("SELECT * FROM runs WHERE loop_id = ?1 ORDER BY started_at DESC")
        .all(loopId) as Record<string, unknown>[];
      return rows.map(mapRun);
    },
  };

  public readonly tasks = {
    upsert: (record: TaskRecord): void => {
      this.coordinator.db
        .query(`
          INSERT INTO tasks (id, title, description, status, loop_id, repo, pr_number, metadata_json, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
          ON CONFLICT(id) DO UPDATE SET
            title=excluded.title,
            description=excluded.description,
            status=excluded.status,
            loop_id=excluded.loop_id,
            repo=excluded.repo,
            pr_number=excluded.pr_number,
            metadata_json=excluded.metadata_json,
            updated_at=excluded.updated_at
        `)
        .run(
          record.id,
          record.title,
          record.description ?? null,
          record.status,
          record.loopId ?? null,
          record.repo ?? null,
          record.prNumber ?? null,
          record.metadataJson ?? null,
          record.createdAt,
          record.updatedAt,
        );
    },
    getById: (id: string): TaskRecord | null => {
      const row = this.coordinator.db
        .query("SELECT * FROM tasks WHERE id = ?1")
        .get(id) as Record<string, unknown> | null;
      return row ? mapTask(row) : null;
    },
    list: (): TaskRecord[] => {
      const rows = this.coordinator.db
        .query("SELECT * FROM tasks ORDER BY updated_at DESC")
        .all() as Record<string, unknown>[];
      return rows.map(mapTask);
    },
  };

  public readonly taskItems = {
    upsert: (record: TaskItemRecord): void => {
      this.coordinator.db
        .query(`
          INSERT INTO task_items (id, task_id, content, status, position, source, metadata_json, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
          ON CONFLICT(id) DO UPDATE SET
            task_id=excluded.task_id,
            content=excluded.content,
            status=excluded.status,
            position=excluded.position,
            source=excluded.source,
            metadata_json=excluded.metadata_json,
            updated_at=excluded.updated_at
        `)
        .run(
          record.id,
          record.taskId,
          record.content,
          record.status,
          record.position,
          record.source,
          record.metadataJson ?? null,
          record.createdAt,
          record.updatedAt,
        );
    },
    listByTask: (taskId: string): TaskItemRecord[] => {
      const rows = this.coordinator.db
        .query(
          "SELECT * FROM task_items WHERE task_id = ?1 ORDER BY position ASC",
        )
        .all(taskId) as Record<string, unknown>[];
      return rows.map(mapTaskItem);
    },
    getById: (id: string): TaskItemRecord | null => {
      const row = this.coordinator.db
        .query("SELECT * FROM task_items WHERE id = ?1")
        .get(id) as Record<string, unknown> | null;
      return row ? mapTaskItem(row) : null;
    },
  };

  public readonly pullRequestSnapshots = {
    upsert: (record: PullRequestSnapshotRecord): void => {
      this.coordinator.db
        .query(`
          INSERT INTO pull_request_snapshots (id, repo, pr_number, head_sha, payload_json, captured_at, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
          ON CONFLICT(id) DO UPDATE SET
            repo=excluded.repo,
            pr_number=excluded.pr_number,
            head_sha=excluded.head_sha,
            payload_json=excluded.payload_json,
            captured_at=excluded.captured_at,
            created_at=excluded.created_at
        `)
        .run(
          record.id,
          record.repo,
          record.prNumber,
          record.headSha,
          record.payloadJson,
          record.capturedAt,
          record.createdAt,
        );
    },
    getLatest: (
      repo: string,
      prNumber: number,
    ): PullRequestSnapshotRecord | null => {
      const row = this.coordinator.db
        .query(
          "SELECT * FROM pull_request_snapshots WHERE repo = ?1 AND pr_number = ?2 ORDER BY captured_at DESC LIMIT 1",
        )
        .get(repo, prNumber) as Record<string, unknown> | null;
      return row ? mapPullRequestSnapshot(row) : null;
    },
  };

  public readonly events = {
    append: (record: EventLogRecord): void => {
      this.coordinator.db
        .query(
          "INSERT INTO event_logs (id, event_type, entity_type, entity_id, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .run(
          record.id,
          record.eventType,
          record.entityType ?? null,
          record.entityId ?? null,
          record.payloadJson,
          record.createdAt,
        );
    },
    listByEntity: (entityType: string, entityId: string): EventLogRecord[] => {
      return this.coordinator.db
        .query(
          "SELECT * FROM event_logs WHERE entity_type = ?1 AND entity_id = ?2 ORDER BY created_at ASC",
        )
        .all(entityType, entityId)
        .map((row) => mapEvent(row as Record<string, unknown>));
    },
  };

  public readonly locks = {
    acquire: (record: LockRecord): boolean => {
      const now = new Date().toISOString();
      const result = this.coordinator.db
        .query(`
          INSERT INTO locks (key, owner, reason, expires_at, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(key) DO UPDATE SET
            owner=excluded.owner,
            reason=excluded.reason,
            expires_at=excluded.expires_at,
            updated_at=excluded.updated_at
          WHERE locks.expires_at <= ?7
        `)
        .run(
          record.key,
          record.owner,
          record.reason ?? null,
          record.expiresAt,
          record.createdAt,
          record.updatedAt,
          now,
        );
      return result.changes > 0;
    },
    release: (key: string): void => {
      this.coordinator.db.query("DELETE FROM locks WHERE key = ?1").run(key);
    },
    get: (key: string): LockRecord | null => {
      const row = this.coordinator.db
        .query("SELECT * FROM locks WHERE key = ?1")
        .get(key) as Record<string, unknown> | null;
      return row ? mapLock(row) : null;
    },
    listExpired: (nowIso: string): LockRecord[] => {
      return this.coordinator.db
        .query(
          "SELECT * FROM locks WHERE expires_at <= ?1 ORDER BY expires_at ASC",
        )
        .all(nowIso)
        .map((row) => mapLock(row as Record<string, unknown>));
    },
  };

  public readonly schema = {
    getMigrationStatus: () => this.coordinator.getMigrationStatus(),
    healthcheck: () => this.coordinator.healthcheck(),
    backup: () => this.coordinator.backup(),
  };
}

function mapLoop(row: Record<string, unknown>): LoopRecord {
  return {
    id: String(row.id),
    type: String(row.type),
    targetType: String(row.target_type),
    targetId: asNullableString(row.target_id),
    repo: asNullableString(row.repo),
    prNumber: asNullableNumber(row.pr_number),
    status: String(row.status),
    configJson: asNullableString(row.config_json),
    metadataJson: asNullableString(row.metadata_json),
    lastRunAt: asNullableString(row.last_run_at),
    nextRunAt: asNullableString(row.next_run_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    loopId: String(row.loop_id),
    status: String(row.status),
    currentStep: asNullableString(row.current_step),
    lastCompletedStep: asNullableString(row.last_completed_step),
    checkpointJson: asNullableString(row.checkpoint_json),
    summary: asNullableString(row.summary),
    errorMessage: asNullableString(row.error_message),
    startedAt: String(row.started_at),
    lastHeartbeatAt: asNullableString(row.last_heartbeat_at),
    endedAt: asNullableString(row.ended_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    description: asNullableString(row.description),
    status: String(row.status),
    loopId: asNullableString(row.loop_id),
    repo: asNullableString(row.repo),
    prNumber: asNullableNumber(row.pr_number),
    metadataJson: asNullableString(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTaskItem(row: Record<string, unknown>): TaskItemRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    content: String(row.content),
    status: String(row.status),
    position: Number(row.position),
    source: String(row.source),
    metadataJson: asNullableString(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapPullRequestSnapshot(
  row: Record<string, unknown>,
): PullRequestSnapshotRecord {
  return {
    id: String(row.id),
    repo: String(row.repo),
    prNumber: Number(row.pr_number),
    headSha: String(row.head_sha),
    payloadJson: String(row.payload_json),
    capturedAt: String(row.captured_at),
    createdAt: String(row.created_at),
  };
}

function mapEvent(row: Record<string, unknown>): EventLogRecord {
  return {
    id: String(row.id),
    eventType: String(row.event_type),
    entityType: asNullableString(row.entity_type),
    entityId: asNullableString(row.entity_id),
    payloadJson: String(row.payload_json),
    createdAt: String(row.created_at),
  };
}

function mapLock(row: Record<string, unknown>): LockRecord {
  return {
    key: String(row.key),
    owner: String(row.owner),
    reason: asNullableString(row.reason),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  return Number(value);
}
