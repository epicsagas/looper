import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import type { StorageHealth } from "../types";
import {
  createMigrationRunner,
  type SqliteMigrationRunner,
  type SqliteMigrationRunnerOptions,
} from "./migrate";

export interface SqliteCoordinatorOptions extends SqliteMigrationRunnerOptions {
  dbPath: string;
  backupDir?: string;
}

export class SqliteDbCoordinator {
  public readonly db: Database;
  private readonly runner: SqliteMigrationRunner;

  constructor(private readonly options: SqliteCoordinatorOptions) {
    this.db = new Database(options.dbPath, { create: true });
    this.applyPragmas();
    this.runner = createMigrationRunner(this.db, {
      migrationsDir: options.migrationsDir,
      now: options.now,
      backupDir: options.backupDir,
      dbPath: options.dbPath,
    });
  }

  public initialize(
    config: { autoMigrate?: boolean; requireBackup?: boolean } = {},
  ): void {
    if (config.autoMigrate) {
      this.runner.runPending({ requireBackup: config.requireBackup });
    }
  }

  public withTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  public backup(): string {
    return this.runner.backup();
  }

  public getMigrationStatus() {
    return this.runner.status();
  }

  public healthcheck(): StorageHealth {
    try {
      this.db.query("SELECT 1").get();
      const status = this.runner.status();
      return {
        ok: true,
        mode: "sqlite",
        dbPath: this.options.dbPath,
        migration: {
          latestAvailableId: status.available.at(-1)?.id,
          latestAppliedId: status.applied.at(-1)?.id,
          pendingCount: status.pending.length,
        },
      };
    } catch (error) {
      return {
        ok: false,
        mode: "sqlite",
        dbPath: this.options.dbPath,
        migration: {
          pendingCount: 0,
        },
        details: (error as Error).message,
      };
    }
  }

  public close(): void {
    this.db.close(false);
  }

  private applyPragmas(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }
}

export async function ensureBackupDir(backupDir: string): Promise<void> {
  await mkdir(backupDir, { recursive: true });
}

export function buildBackupPath(
  backupDir: string,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replaceAll(":", "-");
  return join(backupDir, `looper-${stamp}.sqlite`);
}

export async function ensureDbParentDir(dbPath: string): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true });
}
