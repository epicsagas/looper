import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultLooperConfig } from "../config/index";
import { createLogger } from "../bootstrap/logger";
import { SqliteStore } from "../storage/sqlite/sqlite-store";
import { createLooperdApi } from "./index";

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "looperd-api-"));
  const config = createDefaultLooperConfig(rootDir);
  config.storage.dbPath = `${rootDir}/state/looper.sqlite`;
  config.storage.backupDir = `${rootDir}/backups`;
  config.daemon.logDir = `${rootDir}/logs`;
  config.daemon.workingDirectory = rootDir;
  config.server.authMode = "none";

  const logger = await createLogger(config.logging, config.daemon.logDir);
  const store = new SqliteStore({
    dbPath: config.storage.dbPath,
    backupDir: config.storage.backupDir,
  });
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
  store.loops.upsert({
    id: "loop_1",
    projectId: "project_1",
    type: "reviewer",
    targetType: "pull_request",
    targetId: "pr:acme/looper:42",
    repo: "acme/looper",
    prNumber: 42,
    status: "running",
    configJson: null,
    metadataJson: null,
    lastRunAt: now,
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
  });
  store.runs.upsert({
    id: "run_1",
    loopId: "loop_1",
    status: "running",
    currentStep: "review",
    lastCompletedStep: "snapshot",
    checkpointJson: null,
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
    title: "Wire runtime",
    description: null,
    status: "in_progress",
    loopId: null,
    repo: "acme/looper",
    prNumber: 42,
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
    title: "Runtime foundation",
    body: "Adds recovery and API",
    author: "octocat",
    diffRef: null,
    checksSummary: "green",
    unresolvedThreadCount: 1,
    reviewState: "changes_requested",
    payloadJson: JSON.stringify({ title: "Runtime foundation" }),
    capturedAt: now,
    createdAt: now,
  });
  store.events.append({
    id: "event_1",
    eventType: "loop.created",
    projectId: "project_1",
    loopId: "loop_1",
    runId: null,
    entityType: "loop",
    entityId: "loop_1",
    correlationId: null,
    causationId: null,
    actorType: "system",
    actorId: "looperd",
    actorDisplayName: "looperd",
    payloadJson: JSON.stringify({ status: "running" }),
    createdAt: now,
  });

  const api = createLooperdApi({
    config,
    logger,
    store,
    getStartedAt: () => new Date(now),
    getRecoverySummary: () => ({ expiredLocksReleased: 1 }),
  });

  return { api, store, rootDir };
}

describe("createLooperdApi", () => {
  test("returns status and config envelopes", async () => {
    const { api, store, rootDir } = await createFixture();

    const statusResponse = await api.handle(
      new Request("http://localhost/api/v1/status"),
    );
    const statusBody = (await statusResponse.json()) as {
      ok: boolean;
      data: { storage: { schemaVersion: string } };
    };

    expect(statusResponse.status).toBe(200);
    expect(statusBody.ok).toBe(true);
    expect(statusBody.data.storage.schemaVersion).toBe("0001_init");

    const configResponse = await api.handle(
      new Request("http://localhost/api/v1/config"),
    );
    const configBody = (await configResponse.json()) as {
      data: { server: { localTokenConfigured: boolean } };
    };
    expect(configBody.data.server.localTokenConfigured).toBe(false);

    store.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  test("returns events and pull request detail routes", async () => {
    const { api, store, rootDir } = await createFixture();

    const eventsResponse = await api.handle(
      new Request("http://localhost/api/v1/events/loop/loop_1"),
    );
    const eventsBody = (await eventsResponse.json()) as {
      data: { items: Array<{ eventType: string }> };
    };
    expect(eventsBody.data.items).toHaveLength(1);
    expect(eventsBody.data.items[0]?.eventType).toBe("loop.created");

    const prResponse = await api.handle(
      new Request("http://localhost/api/v1/pull-requests/acme%2Flooper/42"),
    );
    const prBody = (await prResponse.json()) as {
      data: { repo: string; prNumber: number; task: { id: string } | null };
    };
    expect(prBody.data.repo).toBe("acme/looper");
    expect(prBody.data.prNumber).toBe(42);
    expect(prBody.data.task?.id).toBe("task_1");

    const prStatusResponse = await api.handle(
      new Request(
        "http://localhost/api/v1/pull-requests/acme%2Flooper/42/status",
      ),
    );
    const prStatusBody = (await prStatusResponse.json()) as {
      data: { loopStatus: { latestRunStatus: string } };
    };
    expect(prStatusBody.data.loopStatus.latestRunStatus).toBe("running");

    store.close();
    await rm(rootDir, { recursive: true, force: true });
  });
});
