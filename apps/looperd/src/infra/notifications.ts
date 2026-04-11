import { randomUUID } from "node:crypto";

import type { NotificationConfig } from "../config/index";
import type { Store } from "../storage/store";
import type { EventLogRecord, NotificationRecord } from "../storage/types";
import { escapeAppleScriptString, runCommand } from "./command";

export interface NotificationGatewayOptions {
  config: NotificationConfig;
  osascriptPath?: string;
  logFilePath?: string;
  store: Store;
  now?: () => Date;
}

export interface SystemNotificationPayload {
  id?: string;
  projectId?: string;
  loopId?: string;
  runId?: string;
  level: "info" | "warning" | "action_required" | "success" | "failure";
  title: string;
  subtitle?: string;
  body: string;
  sound?: string;
  group?: "reviewer" | "worker" | "fixer" | "system";
  entityType?: string;
  entityId?: string;
  dedupeKey?: string;
}

export class NotificationGateway {
  private readonly now: () => Date;

  constructor(private readonly options: NotificationGatewayOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async notify(
    payload: SystemNotificationPayload,
  ): Promise<NotificationRecord[]> {
    const records: NotificationRecord[] = [];

    try {
      records.push(this.recordInApp(payload));
    } catch {
      // Keep channel failures isolated so osascript delivery can still proceed.
    }

    try {
      records.push(await this.recordOsascript(payload));
    } catch {
      // Keep channel failures isolated so in-app persistence can still proceed.
    }

    return records;
  }

  private recordInApp(payload: SystemNotificationPayload): NotificationRecord {
    const nowIso = this.now().toISOString();
    const record: NotificationRecord = {
      id: payload.id ?? randomUUID(),
      projectId: payload.projectId ?? null,
      loopId: payload.loopId ?? null,
      runId: payload.runId ?? null,
      entityType: payload.entityType ?? null,
      entityId: payload.entityId ?? null,
      channel: "in_app",
      level: payload.level,
      title: payload.title,
      subtitle: payload.subtitle ?? null,
      body: payload.body,
      status: this.options.config.inApp ? "success" : "skipped",
      dedupeKey: payload.dedupeKey ?? null,
      errorMessage: this.options.config.inApp ? null : "disabled",
      payloadJson: JSON.stringify(payload),
      sentAt: this.options.config.inApp ? nowIso : null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.persistNotification(record);
    return record;
  }

  private async recordOsascript(
    payload: SystemNotificationPayload,
  ): Promise<NotificationRecord> {
    const nowIso = this.now().toISOString();
    const id = randomUUID();
    const dedupeRecord = payload.dedupeKey
      ? this.options.store.notifications.getLatestByDedupe(
          "osascript",
          payload.dedupeKey,
        )
      : null;

    const throttleWindowMs =
      this.options.config.osascript.throttleWindowSeconds * 1_000;
    if (
      payload.dedupeKey &&
      dedupeRecord?.createdAt &&
      Date.parse(nowIso) - Date.parse(dedupeRecord.createdAt) < throttleWindowMs
    ) {
      const record: NotificationRecord = {
        id,
        projectId: payload.projectId ?? null,
        loopId: payload.loopId ?? null,
        runId: payload.runId ?? null,
        entityType: payload.entityType ?? null,
        entityId: payload.entityId ?? null,
        channel: "osascript",
        level: payload.level,
        title: payload.title,
        subtitle: payload.subtitle ?? null,
        body: payload.body,
        status: "skipped",
        dedupeKey: payload.dedupeKey,
        errorMessage: "deduped",
        payloadJson: JSON.stringify(payload),
        sentAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.persistNotification(record);
      return record;
    }

    if (!this.options.config.osascript.enabled || !this.options.osascriptPath) {
      const record: NotificationRecord = {
        id,
        projectId: payload.projectId ?? null,
        loopId: payload.loopId ?? null,
        runId: payload.runId ?? null,
        entityType: payload.entityType ?? null,
        entityId: payload.entityId ?? null,
        channel: "osascript",
        level: payload.level,
        title: payload.title,
        subtitle: payload.subtitle ?? null,
        body: payload.body,
        status: "skipped",
        dedupeKey: payload.dedupeKey ?? null,
        errorMessage: "disabled",
        payloadJson: JSON.stringify(payload),
        sentAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.persistNotification(record);
      return record;
    }

    try {
      await runCommand({
        command: this.options.osascriptPath,
        args: [
          "-e",
          buildAppleScript(
            payload,
            this.options.config,
            this.options.logFilePath,
          ),
        ],
        timeoutMs: 35_000,
      });

      const record: NotificationRecord = {
        id,
        projectId: payload.projectId ?? null,
        loopId: payload.loopId ?? null,
        runId: payload.runId ?? null,
        entityType: payload.entityType ?? null,
        entityId: payload.entityId ?? null,
        channel: "osascript",
        level: payload.level,
        title: payload.title,
        subtitle: payload.subtitle ?? null,
        body: payload.body,
        status: "success",
        dedupeKey: payload.dedupeKey ?? null,
        errorMessage: null,
        payloadJson: JSON.stringify(payload),
        sentAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.persistNotification(record);
      return record;
    } catch (error) {
      const record: NotificationRecord = {
        id,
        projectId: payload.projectId ?? null,
        loopId: payload.loopId ?? null,
        runId: payload.runId ?? null,
        entityType: payload.entityType ?? null,
        entityId: payload.entityId ?? null,
        channel: "osascript",
        level: payload.level,
        title: payload.title,
        subtitle: payload.subtitle ?? null,
        body: payload.body,
        status: "failed",
        dedupeKey: payload.dedupeKey ?? null,
        errorMessage: error instanceof Error ? error.message : "unknown error",
        payloadJson: JSON.stringify(payload),
        sentAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.persistNotification(record);
      return record;
    }
  }

  private persistNotification(record: NotificationRecord): void {
    this.options.store.notifications.upsert(record);
    const event: EventLogRecord = {
      id: randomUUID(),
      eventType: "notification.sent",
      projectId: record.projectId ?? null,
      loopId: record.loopId ?? null,
      runId: record.runId ?? null,
      entityType: record.entityType ?? "notification",
      entityId: record.entityId ?? record.id,
      payloadJson: JSON.stringify({
        channel: record.channel,
        level: record.level,
        status: record.status,
        dedupeKey: record.dedupeKey,
        title: record.title,
      }),
      createdAt: record.createdAt,
    };
    this.options.store.events.append(event);
  }
}

function buildAppleScript(
  payload: SystemNotificationPayload,
  config: NotificationConfig,
  logFilePath?: string,
): string {
  const body = escapeAppleScriptString(payload.body);
  const title = escapeAppleScriptString(payload.title);

  if (payload.level === "failure" && logFilePath) {
    const openLogPath = escapeAppleScriptString(logFilePath);
    return `set dialogResult to display dialog "${body}" with title "${title}" buttons {"Open Log", "Dismiss"} default button "Dismiss" cancel button "Dismiss" giving up after 30\nif gave up of dialogResult is false and button returned of dialogResult is "Open Log" then\n  do shell script "open " & quoted form of "${openLogPath}"\nend if`;
  }

  const subtitle = payload.subtitle
    ? ` subtitle "${escapeAppleScriptString(payload.subtitle)}"`
    : "";
  const sound =
    payload.sound && isSoundEnabledForLevel(config, payload.level)
      ? ` sound name "${escapeAppleScriptString(payload.sound)}"`
      : "";

  return `display notification "${body}" with title "${title}"${subtitle}${sound}`;
}

function isSoundEnabledForLevel(
  config: NotificationConfig,
  level: SystemNotificationPayload["level"],
): boolean {
  return (config.osascript.soundForLevels ?? []).some(
    (candidate) => candidate === level,
  );
}
