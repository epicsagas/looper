import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteStore } from "./sqlite-store";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

async function createStoreFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "looper-store-"));
  cleanupPaths.push(rootDir);

  return {
    rootDir,
    dbPath: join(rootDir, "state", "looper.sqlite"),
    backupDir: join(rootDir, "backups"),
  };
}

describe("SqliteStore", () => {
  test("initializes schema, writes records, and reports health", async () => {
    const fixture = await createStoreFixture();
    const store = new SqliteStore({
      dbPath: fixture.dbPath,
      backupDir: fixture.backupDir,
    });

    store.initialize({ autoMigrate: true, requireBackup: true });

    const now = "2026-04-11T12:00:00.000Z";

    store.projects.upsert({
      id: "project_1",
      name: "Looper",
      repoPath: "/tmp/looper",
      baseBranch: "main",
      archived: false,
      metadataJson: '{"tier":"mvp"}',
      createdAt: now,
      updatedAt: now,
    });
    store.loops.upsert({
      id: "loop_1",
      projectId: "project_1",
      type: "reviewer",
      targetType: "pull_request",
      targetId: "pr:42",
      repo: "acme/looper",
      prNumber: 42,
      status: "idle",
      configJson: '{"priority":"normal"}',
      metadataJson: null,
      lastRunAt: null,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    });
    store.runs.upsert({
      id: "run_1",
      loopId: "loop_1",
      status: "running",
      currentStep: "snapshot",
      lastCompletedStep: null,
      checkpointJson: '{"cursor":1}',
      summary: null,
      errorMessage: null,
      startedAt: now,
      lastHeartbeatAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    store.tasks.upsert({
      id: "task_1",
      projectId: "project_1",
      title: "Implement persistence",
      description: "Finish SQLite foundation",
      status: "in_progress",
      loopId: "loop_1",
      repo: "acme/looper",
      prNumber: 42,
      metadataJson: '{"source":"spec"}',
      createdAt: now,
      updatedAt: now,
    });
    store.taskItems.upsert({
      id: "item_1",
      taskId: "task_1",
      content: "Write migrations",
      status: "done",
      position: 1,
      source: "spec",
      metadataJson: null,
      createdAt: now,
      updatedAt: now,
    });
    store.pullRequestSnapshots.upsert({
      id: "snapshot_1",
      projectId: "project_1",
      repo: "acme/looper",
      prNumber: 42,
      headSha: "abc123",
      baseSha: "base123",
      title: "Persistence",
      body: "This adds storage",
      author: "octocat",
      diffRef: "refs/pull/42/head",
      checksSummary: "all-green",
      unresolvedThreadCount: 2,
      reviewState: "changes_requested",
      payloadJson: '{"title":"Persistence"}',
      capturedAt: now,
      createdAt: now,
    });
    store.events.append({
      id: "event_1",
      eventType: "loop.created",
      projectId: "project_1",
      loopId: "loop_1",
      runId: "run_1",
      entityType: "loop",
      entityId: "loop_1",
      correlationId: "corr_1",
      causationId: "cause_1",
      actorType: "agent",
      actorId: "reviewer_1",
      actorDisplayName: "Reviewer",
      payloadJson: '{"status":"idle"}',
      createdAt: now,
    });

    expect(
      store.locks.acquire({
        key: "pr:acme/looper:42",
        owner: "reviewer-loop",
        reason: "claim",
        expiresAt: "2026-04-11T12:05:00.000Z",
        createdAt: now,
        updatedAt: now,
      }),
    ).toBe(true);

    expect(store.projects.getById("project_1")).toEqual({
      id: "project_1",
      name: "Looper",
      repoPath: "/tmp/looper",
      baseBranch: "main",
      archived: false,
      metadataJson: '{"tier":"mvp"}',
      createdAt: now,
      updatedAt: now,
    });
    expect(store.loops.getById("loop_1")?.repo).toBe("acme/looper");
    expect(store.loops.getById("loop_1")?.projectId).toBe("project_1");
    expect(store.runs.listByLoop("loop_1")).toHaveLength(1);
    expect(store.tasks.list()).toHaveLength(1);
    expect(store.tasks.getById("task_1")?.projectId).toBe("project_1");
    expect(store.taskItems.listByTask("task_1")[0]?.content).toBe(
      "Write migrations",
    );
    expect(
      store.pullRequestSnapshots.getLatest("acme/looper", 42)?.headSha,
    ).toBe("abc123");
    expect(
      store.pullRequestSnapshots.getLatest("acme/looper", 42)?.projectId,
    ).toBe("project_1");
    expect(
      store.pullRequestSnapshots.getLatest("acme/looper", 42)?.baseSha,
    ).toBe("base123");
    expect(store.events.listByEntity("loop", "loop_1")).toHaveLength(1);
    expect(store.events.listByEntity("loop", "loop_1")[0]?.actorId).toBe(
      "reviewer_1",
    );
    expect(store.locks.get("pr:acme/looper:42")?.owner).toBe("reviewer-loop");

    const health = store.schema.healthcheck();
    expect(health.ok).toBe(true);
    expect(health.migration.latestAppliedId).toBe("0001_init");
    expect(health.lastUpdatedAt).toBeString();

    const backupPath = store.schema.backup();
    await access(backupPath);

    store.close();
  });

  test("rolls back transactional writes on failure", async () => {
    const fixture = await createStoreFixture();
    const store = new SqliteStore({ dbPath: fixture.dbPath });
    store.initialize({ autoMigrate: true });

    const now = "2026-04-11T12:00:00.000Z";

    store.projects.upsert({
      id: "project_1",
      name: "Looper",
      repoPath: "/tmp/looper",
      baseBranch: "main",
      archived: false,
      metadataJson: null,
      createdAt: now,
      updatedAt: now,
    });

    expect(() =>
      store.withTransaction((tx) => {
        tx.tasks.upsert({
          id: "task_rollback",
          projectId: "project_1",
          title: "Temporary",
          description: null,
          status: "pending",
          loopId: null,
          repo: null,
          prNumber: null,
          metadataJson: null,
          createdAt: now,
          updatedAt: now,
        });
        tx.events.append({
          id: "event_rollback",
          eventType: "task.created",
          projectId: "project_1",
          entityType: "task",
          entityId: "task_rollback",
          payloadJson: "{}",
          createdAt: now,
        });

        throw new Error("abort transaction");
      }),
    ).toThrow("abort transaction");

    expect(store.tasks.getById("task_rollback")).toBeNull();
    expect(store.events.listByEntity("task", "task_rollback")).toHaveLength(0);

    store.close();
  });

  test("re-acquires an expired lock using the injected clock", async () => {
    const fixture = await createStoreFixture();
    const store = new SqliteStore({
      dbPath: fixture.dbPath,
      now: () => new Date("2026-04-11T12:10:00.000Z"),
    });
    store.initialize({ autoMigrate: true });

    expect(
      store.locks.acquire({
        key: "task:123",
        owner: "worker-a",
        reason: "initial",
        expiresAt: "2026-04-11T12:00:00.000Z",
        createdAt: "2026-04-11T11:50:00.000Z",
        updatedAt: "2026-04-11T11:50:00.000Z",
      }),
    ).toBe(true);

    expect(
      store.locks.acquire({
        key: "task:123",
        owner: "worker-b",
        reason: "takeover",
        expiresAt: "2026-04-11T12:20:00.000Z",
        createdAt: "2026-04-11T12:10:00.000Z",
        updatedAt: "2026-04-11T12:10:00.000Z",
      }),
    ).toBe(true);
    expect(store.locks.get("task:123")?.owner).toBe("worker-b");

    store.close();
  });
});
