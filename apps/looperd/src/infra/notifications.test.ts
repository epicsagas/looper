import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteStore } from "../storage/sqlite/sqlite-store";
import { NotificationGateway } from "./notifications";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

describe("NotificationGateway", () => {
  test("persists in-app notifications and dedupes osascript delivery", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "looper-notify-"));
    cleanupPaths.push(rootDir);

    const capturePath = join(rootDir, "osascript.log");
    const scriptPath = join(rootDir, "osascript");
    await writeFile(
      scriptPath,
      `#!/bin/sh\nprintf '%s\n' "$*" >> "${capturePath}"\n`,
    );
    await chmod(scriptPath, 0o755);

    const store = new SqliteStore({
      dbPath: join(rootDir, "state", "looper.sqlite"),
    });
    store.initialize({ autoMigrate: true });

    const gateway = new NotificationGateway({
      config: {
        inApp: true,
        osascript: {
          enabled: true,
          soundForLevels: ["failure", "action_required"],
          throttleWindowSeconds: 60,
        },
      },
      osascriptPath: scriptPath,
      logFilePath: join(rootDir, "logs", "looperd.log"),
      store,
      now: () => new Date("2026-04-11T12:00:00.000Z"),
    });

    const first = await gateway.notify({
      level: "failure",
      title: "Worker blocked",
      subtitle: "task_1",
      body: "Needs attention",
      sound: "Funk",
      entityType: "task",
      entityId: "task_1",
      dedupeKey: "worker.blocked:task:task_1",
    });
    const second = await gateway.notify({
      level: "failure",
      title: "Worker blocked",
      subtitle: "task_1",
      body: "Needs attention",
      sound: "Funk",
      entityType: "task",
      entityId: "task_1",
      dedupeKey: "worker.blocked:task:task_1",
    });

    expect(first.find((record) => record.channel === "osascript")?.status).toBe(
      "success",
    );
    expect(
      second.find((record) => record.channel === "osascript")?.status,
    ).toBe("skipped");
    expect(store.notifications.list()).toHaveLength(4);
    expect(store.events.listByEntity("task", "task_1")).toHaveLength(4);

    const osascriptCalls = await readFile(capturePath, "utf8");
    expect(osascriptCalls).toContain("display dialog");
    expect(osascriptCalls).toContain("Open Log");
    expect(osascriptCalls).toContain("open ");
    expect(osascriptCalls).toContain(join(rootDir, "logs", "looperd.log"));

    store.close();
  });

  test("uses lightweight osascript notification for non-failure levels", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "looper-notify-"));
    cleanupPaths.push(rootDir);

    const capturePath = join(rootDir, "osascript.log");
    const scriptPath = join(rootDir, "osascript");
    await writeFile(
      scriptPath,
      `#!/bin/sh\nprintf '%s\n' "$*" >> "${capturePath}"\n`,
    );
    await chmod(scriptPath, 0o755);

    const store = new SqliteStore({
      dbPath: join(rootDir, "state", "looper.sqlite"),
    });
    store.initialize({ autoMigrate: true });

    const gateway = new NotificationGateway({
      config: {
        inApp: true,
        osascript: {
          enabled: true,
          soundForLevels: ["failure", "action_required"],
          throttleWindowSeconds: 60,
        },
      },
      osascriptPath: scriptPath,
      store,
    });

    await gateway.notify({
      level: "success",
      title: "Loop completed",
      subtitle: "loop_1",
      body: "All good",
      sound: "Funk",
    });

    const osascriptCalls = await readFile(capturePath, "utf8");
    expect(osascriptCalls).toContain("display notification");
    expect(osascriptCalls).not.toContain("display dialog");
    store.close();
  });
});
