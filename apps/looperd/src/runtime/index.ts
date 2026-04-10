import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LooperConfig } from "../config/index";
import type { Logger } from "../bootstrap/logger";
import { SqliteStore } from "../storage/sqlite/sqlite-store";
import type { EventLogRecord, LoopRecord, RunRecord } from "../storage/types";
import { createLooperdApiServer, type LooperdApiServer } from "../server/index";

export interface RecoverySummary {
  startedAt?: string;
  completedAt?: string;
  orphanAgentCleanup: {
    attempted: boolean;
    cleanedCount: number;
    warning?: string;
  };
  expiredLocksReleased: number;
  interruptedRunsMarked: number;
  loopsRequeued: number;
  eventsWritten: number;
}

export interface LooperdRuntime {
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  waitForShutdown(): Promise<void>;
  readonly startedAt?: Date;
}

export interface CreateLooperdRuntimeOptions {
  config: LooperConfig;
  logger: Logger;
}

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../storage/sqlite/migrations",
);

class BasicLooperdRuntime implements LooperdRuntime {
  public startedAt?: Date;

  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;
  private stopped = false;
  private store?: SqliteStore;
  private server?: LooperdApiServer;
  private recoverySummary: RecoverySummary = createEmptyRecoverySummary();

  constructor(private readonly options: CreateLooperdRuntimeOptions) {
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.resolveShutdown = resolve;
    });
  }

  public async start(): Promise<void> {
    if (this.startedAt) {
      return;
    }

    const store = new SqliteStore({
      dbPath: this.options.config.storage.dbPath,
      backupDir: this.options.config.storage.backupDir,
      migrationsDir: MIGRATIONS_DIR,
    });

    try {
      store.initialize({
        autoMigrate: this.options.config.package.autoMigrateOnStartup,
        requireBackup: this.options.config.package.requireBackupBeforeMigrate,
      });

      this.store = store;
      this.syncConfiguredProjects();
      this.recoverySummary = this.runRecoveryPipeline();

      this.server = createLooperdApiServer({
        config: this.options.config,
        logger: this.options.logger,
        store,
        getStartedAt: () => this.startedAt,
        getRecoverySummary: () => ({ ...this.recoverySummary }),
      });
      await this.server.start();
      this.options.config.server.port =
        this.server.getPort() ?? this.options.config.server.port;

      this.startedAt = new Date();
      this.appendEvent({
        id: randomUUID(),
        eventType: "looperd.started",
        entityType: "notification",
        entityId: "looperd",
        payloadJson: JSON.stringify({
          daemonMode: this.options.config.daemon.mode,
          host: this.options.config.server.host,
          port: this.server.getPort() ?? this.options.config.server.port,
          recovery: this.recoverySummary,
        }),
        createdAt: this.startedAt.toISOString(),
      });

      this.options.logger.info("looperd runtime started", {
        daemonMode: this.options.config.daemon.mode,
        host: this.options.config.server.host,
        port: this.server.getPort() ?? this.options.config.server.port,
        recoverySummary: this.recoverySummary,
      });
    } catch (error) {
      this.server = undefined;
      this.store?.close();
      this.store = undefined;
      throw error;
    }
  }

  public async stop(reason = "shutdown"): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.options.logger.info("looperd runtime stopping", { reason });

    const stoppedAt = new Date().toISOString();

    try {
      this.appendEvent({
        id: randomUUID(),
        eventType: "looperd.stopped",
        entityType: "notification",
        entityId: "looperd",
        payloadJson: JSON.stringify({ reason }),
        createdAt: stoppedAt,
      });
      await this.server?.stop();
    } finally {
      this.store?.close();
      this.server = undefined;
      this.store = undefined;
      this.resolveShutdown();
    }
  }

  public async waitForShutdown(): Promise<void> {
    await this.shutdownPromise;
  }

  private syncConfiguredProjects(): void {
    if (!this.store) {
      return;
    }

    const now = new Date().toISOString();

    for (const project of this.options.config.projects) {
      this.store.projects.upsert({
        id: project.id,
        name: project.name,
        repoPath: project.repoPath,
        baseBranch:
          project.baseBranch ?? this.options.config.defaults.baseBranch,
        archived: false,
        metadataJson: JSON.stringify({
          worktreeRoot: project.worktreeRoot ?? null,
          source: "config",
        }),
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  private runRecoveryPipeline(): RecoverySummary {
    if (!this.store) {
      return createEmptyRecoverySummary();
    }

    const now = new Date();
    const nowIso = now.toISOString();
    let eventsWritten = 0;

    const summary: RecoverySummary = {
      startedAt: nowIso,
      completedAt: undefined,
      orphanAgentCleanup: {
        attempted: true,
        cleanedCount: 0,
        warning:
          "No agent process registry is configured yet; skipping orphan cleanup",
      },
      expiredLocksReleased: 0,
      interruptedRunsMarked: 0,
      loopsRequeued: 0,
      eventsWritten: 0,
    };

    this.options.logger.warn("looperd recovery skipped orphan agent cleanup", {
      reason: summary.orphanAgentCleanup.warning,
    });

    const expiredLocks = this.store.locks.listExpired(nowIso);
    for (const lock of expiredLocks) {
      this.store.locks.release(lock.key);
      summary.expiredLocksReleased += 1;
      this.appendEvent({
        id: randomUUID(),
        eventType: "looperd.recovery.lock_released",
        entityType: "lock",
        entityId: lock.key,
        payloadJson: JSON.stringify({
          owner: lock.owner,
          expiredAt: lock.expiresAt,
          recoveredAt: nowIso,
        }),
        createdAt: nowIso,
      });
      eventsWritten += 1;
    }

    const loops = this.store.loops.list();
    for (const loop of loops) {
      const latestRun = this.store.runs.listByLoop(loop.id)[0];
      if (!latestRun) {
        continue;
      }

      if (latestRun.status === "running") {
        this.store.runs.upsert({
          ...latestRun,
          status: "interrupted",
          errorMessage:
            latestRun.errorMessage ?? "Interrupted during looperd recovery",
          endedAt: nowIso,
          updatedAt: nowIso,
        });
        summary.interruptedRunsMarked += 1;
        this.appendEvent({
          id: randomUUID(),
          eventType: "looperd.recovery.run_interrupted",
          loopId: loop.id,
          runId: latestRun.id,
          entityType: "run",
          entityId: latestRun.id,
          payloadJson: JSON.stringify({
            previousStatus: latestRun.status,
            recoveredStatus: "interrupted",
          }),
          createdAt: nowIso,
        });
        eventsWritten += 1;
      }

      if (shouldRequeueLoop(loop, latestRun)) {
        this.store.loops.upsert({
          ...loop,
          status: "queued",
          nextRunAt: nowIso,
          lastRunAt: latestRun.endedAt ?? latestRun.startedAt,
          updatedAt: nowIso,
        });
        summary.loopsRequeued += 1;
        this.appendEvent({
          id: randomUUID(),
          eventType: "looperd.recovery.loop_requeued",
          loopId: loop.id,
          entityType: "loop",
          entityId: loop.id,
          payloadJson: JSON.stringify({
            previousStatus: loop.status,
            nextRunAt: nowIso,
          }),
          createdAt: nowIso,
        });
        eventsWritten += 1;
      }
    }

    summary.completedAt = nowIso;

    this.appendEvent({
      id: randomUUID(),
      eventType: "looperd.recovery.completed",
      entityType: "notification",
      entityId: "looperd-recovery",
      payloadJson: JSON.stringify({
        expiredLocksReleased: summary.expiredLocksReleased,
        interruptedRunsMarked: summary.interruptedRunsMarked,
        loopsRequeued: summary.loopsRequeued,
        orphanAgentCleanup: summary.orphanAgentCleanup,
      }),
      createdAt: nowIso,
    });
    eventsWritten += 1;
    summary.eventsWritten = eventsWritten;

    return summary;
  }

  private appendEvent(record: EventLogRecord): void {
    this.store?.events.append({
      projectId: null,
      loopId: null,
      runId: null,
      correlationId: null,
      causationId: null,
      actorType: "system",
      actorId: "looperd",
      actorDisplayName: "looperd",
      ...record,
    });
  }
}

function createEmptyRecoverySummary(): RecoverySummary {
  return {
    orphanAgentCleanup: {
      attempted: false,
      cleanedCount: 0,
    },
    expiredLocksReleased: 0,
    interruptedRunsMarked: 0,
    loopsRequeued: 0,
    eventsWritten: 0,
  };
}

function shouldRequeueLoop(loop: LoopRecord, latestRun: RunRecord): boolean {
  if (loop.status === "paused") {
    return false;
  }

  if (loop.status === "completed" || loop.status === "failed") {
    return false;
  }

  return loop.status === "running" || latestRun.status === "interrupted";
}

export function createLooperdRuntime(
  options: CreateLooperdRuntimeOptions,
): LooperdRuntime {
  return new BasicLooperdRuntime(options);
}
