import type { Store } from "../store";
import type {
  EventLogRecord,
  LockRecord,
  LoopRecord,
  ProjectRecord,
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
  now?: () => Date;
}

export class SqliteStore implements Store {
  private readonly coordinator: SqliteDbCoordinator;
  private readonly now: () => Date;

  constructor(options: SqliteStoreOptions) {
    this.now = options.now ?? (() => new Date());
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

  public readonly projects = {
    upsert: (record: ProjectRecord): void => {
      this.coordinator.db
        .query(`
          INSERT INTO projects (id, name, repo_path, base_branch, archived, metadata_json, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            repo_path=excluded.repo_path,
            base_branch=excluded.base_branch,
            archived=excluded.archived,
            metadata_json=excluded.metadata_json,
            updated_at=excluded.updated_at
        `)
        .run(
          record.id,
          record.name,
          record.repoPath,
          record.baseBranch ?? null,
          record.archived ? 1 : 0,
          record.metadataJson ?? null,
          record.createdAt,
          record.updatedAt,
        );
    },
    getById: (id: string): ProjectRecord | null => {
      const row = this.coordinator.db
        .query("SELECT * FROM projects WHERE id = ?1")
        .get(id) as Record<string, unknown> | null;
      return row ? mapProject(row) : null;
    },
    list: (): ProjectRecord[] => {
      const rows = this.coordinator.db
        .query("SELECT * FROM projects ORDER BY updated_at DESC")
        .all() as Record<string, unknown>[];
      return rows.map(mapProject);
    },
  };

  public readonly loops = {
    upsert: (record: LoopRecord): void => {
      this.coordinator.db
        .query(`
          INSERT INTO loops (id, project_id, type, target_type, target_id, repo, pr_number, status, config_json, metadata_json, last_run_at, next_run_at, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
          ON CONFLICT(id) DO UPDATE SET
            project_id=excluded.project_id,
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
          record.projectId,
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
    list: (): RunRecord[] => {
      const rows = this.coordinator.db
        .query("SELECT * FROM runs ORDER BY started_at DESC")
        .all() as Record<string, unknown>[];
      return rows.map(mapRun);
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
          INSERT INTO tasks (id, project_id, title, description, status, loop_id, repo, pr_number, metadata_json, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
          ON CONFLICT(id) DO UPDATE SET
            project_id=excluded.project_id,
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
          record.projectId,
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
          INSERT INTO pull_request_snapshots (id, project_id, repo, pr_number, head_sha, base_sha, title, body, author, diff_ref, checks_summary, unresolved_thread_count, review_state, payload_json, captured_at, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
          ON CONFLICT(id) DO UPDATE SET
            project_id=excluded.project_id,
            repo=excluded.repo,
            pr_number=excluded.pr_number,
            head_sha=excluded.head_sha,
            base_sha=excluded.base_sha,
            title=excluded.title,
            body=excluded.body,
            author=excluded.author,
            diff_ref=excluded.diff_ref,
            checks_summary=excluded.checks_summary,
            unresolved_thread_count=excluded.unresolved_thread_count,
            review_state=excluded.review_state,
            payload_json=excluded.payload_json,
            captured_at=excluded.captured_at
        `)
        .run(
          record.id,
          record.projectId,
          record.repo,
          record.prNumber,
          record.headSha,
          record.baseSha ?? null,
          record.title ?? null,
          record.body ?? null,
          record.author ?? null,
          record.diffRef ?? null,
          record.checksSummary ?? null,
          record.unresolvedThreadCount ?? null,
          record.reviewState ?? null,
          record.payloadJson ?? null,
          record.capturedAt,
          record.createdAt,
        );
    },
    list: (): PullRequestSnapshotRecord[] => {
      return this.coordinator.db
        .query(
          "SELECT * FROM pull_request_snapshots ORDER BY captured_at DESC, created_at DESC",
        )
        .all()
        .map((row) => mapPullRequestSnapshot(row as Record<string, unknown>));
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
          "INSERT INTO event_logs (id, event_type, project_id, loop_id, run_id, entity_type, entity_id, correlation_id, causation_id, actor_type, actor_id, actor_display_name, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )
        .run(
          record.id,
          record.eventType,
          record.projectId ?? null,
          record.loopId ?? null,
          record.runId ?? null,
          record.entityType ?? null,
          record.entityId ?? null,
          record.correlationId ?? null,
          record.causationId ?? null,
          record.actorType ?? null,
          record.actorId ?? null,
          record.actorDisplayName ?? null,
          record.payloadJson,
          record.createdAt,
        );
    },
    list: (limit = 100): EventLogRecord[] => {
      return this.coordinator.db
        .query("SELECT * FROM event_logs ORDER BY created_at DESC LIMIT ?1")
        .all(limit)
        .map((row) => mapEvent(row as Record<string, unknown>));
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
      const now = this.now().toISOString();
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

function mapProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    repoPath: String(row.repo_path),
    baseBranch: asNullableString(row.base_branch),
    archived: asBoolean(row.archived),
    metadataJson: asNullableString(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapLoop(row: Record<string, unknown>): LoopRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
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
    projectId: String(row.project_id),
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
    projectId: String(row.project_id),
    repo: String(row.repo),
    prNumber: Number(row.pr_number),
    headSha: String(row.head_sha),
    baseSha: asNullableString(row.base_sha),
    title: asNullableString(row.title),
    body: asNullableString(row.body),
    author: asNullableString(row.author),
    diffRef: asNullableString(row.diff_ref),
    checksSummary: asNullableString(row.checks_summary),
    unresolvedThreadCount: asNullableNumber(row.unresolved_thread_count),
    reviewState: asNullableString(row.review_state),
    payloadJson: asNullableString(row.payload_json),
    capturedAt: String(row.captured_at),
    createdAt: String(row.created_at),
  };
}

function mapEvent(row: Record<string, unknown>): EventLogRecord {
  return {
    id: String(row.id),
    eventType: String(row.event_type),
    projectId: asNullableString(row.project_id),
    loopId: asNullableString(row.loop_id),
    runId: asNullableString(row.run_id),
    entityType: asNullableString(row.entity_type),
    entityId: asNullableString(row.entity_id),
    correlationId: asNullableString(row.correlation_id),
    causationId: asNullableString(row.causation_id),
    actorType: asNullableString(row.actor_type),
    actorId: asNullableString(row.actor_id),
    actorDisplayName: asNullableString(row.actor_display_name),
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

function asBoolean(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}
