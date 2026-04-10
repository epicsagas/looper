import { randomUUID } from "node:crypto";

import type { LooperConfig } from "../config/index";
import type { Logger } from "../bootstrap/logger";
import type {
  EventLogRecord,
  PullRequestSnapshotRecord,
  RunRecord,
} from "../storage/types";
import type { Store } from "../storage/store";

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
}

export interface LooperdApiContext {
  config: LooperConfig;
  logger: Logger;
  store: Store;
  getStartedAt(): Date | undefined;
  getRecoverySummary(): Record<string, unknown>;
}

export interface LooperdApi {
  handle(request: Request): Promise<Response>;
}

export interface LooperdApiServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPort(): number | undefined;
}

class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function createLooperdApi(context: LooperdApiContext): LooperdApi {
  return {
    async handle(request: Request): Promise<Response> {
      const requestId =
        request.headers.get("x-request-id")?.trim() || randomUUID();

      try {
        authorizeRequest(request, context.config);

        const url = new URL(request.url);
        const pathname = normalizePathname(url.pathname);

        if (request.method !== "GET") {
          throw new ApiError(
            "METHOD_NOT_ALLOWED",
            405,
            `Unsupported method for ${pathname}`,
          );
        }

        if (!pathname.startsWith("/api/v1")) {
          throw new ApiError(
            "ROUTE_NOT_FOUND",
            404,
            `Unknown route: ${pathname}`,
          );
        }

        let data: unknown;

        switch (true) {
          case pathname === "/api/v1/healthz":
            data = buildHealthResponse(context);
            break;
          case pathname === "/api/v1/status":
            data = buildStatusResponse(context);
            break;
          case pathname === "/api/v1/config":
            data = buildConfigResponse(context.config);
            break;
          case pathname === "/api/v1/events":
            data = buildEventsResponse(context, url.searchParams);
            break;
          case pathname.startsWith("/api/v1/events/"):
            data = buildEntityEventsResponse(context, pathname);
            break;
          case pathname === "/api/v1/pull-requests":
            data = buildPullRequestsResponse(context);
            break;
          case pathname.startsWith("/api/v1/pull-requests/"):
            data = buildPullRequestRouteResponse(context, pathname);
            break;
          default:
            throw new ApiError(
              "ROUTE_NOT_FOUND",
              404,
              `Unknown route: ${pathname}`,
            );
        }

        return jsonResponse(200, { ok: true, data, requestId });
      } catch (error) {
        const apiError = toApiError(error);
        context.logger.warn("looperd api request failed", {
          requestId,
          method: request.method,
          url: request.url,
          code: apiError.code,
          status: apiError.status,
          message: apiError.message,
        });

        return jsonResponse(apiError.status, {
          ok: false,
          error: {
            code: apiError.code,
            message: apiError.message,
            details: apiError.details,
          },
          requestId,
        });
      }
    },
  };
}

export function createLooperdApiServer(
  context: LooperdApiContext,
): LooperdApiServer {
  const api = createLooperdApi(context);
  let server: Bun.Server<unknown> | undefined;

  return {
    async start(): Promise<void> {
      if (server) {
        return;
      }

      server = Bun.serve({
        hostname: context.config.server.host,
        port: context.config.server.port,
        fetch: (request) => api.handle(request),
        idleTimeout: 30,
      });

      context.logger.info("looperd http server listening", {
        host: server.hostname,
        port: server.port,
      });
    },
    async stop(): Promise<void> {
      if (!server) {
        return;
      }

      server.stop(true);
      server = undefined;
    },
    getPort(): number | undefined {
      return server?.port;
    },
  };
}

function authorizeRequest(request: Request, config: LooperConfig): void {
  if (config.server.authMode !== "local-token") {
    return;
  }

  const authorization = request.headers.get("authorization");
  const expectedToken = config.server.localToken;

  if (!expectedToken) {
    throw new ApiError(
      "AUTH_MISCONFIGURED",
      500,
      "Local token auth is enabled but no token is configured",
    );
  }

  if (authorization !== `Bearer ${expectedToken}`) {
    throw new ApiError("UNAUTHORIZED", 401, "Authorization token is required");
  }
}

function normalizePathname(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function buildHealthResponse(context: LooperdApiContext) {
  const storage = context.store.schema.healthcheck();

  return {
    healthy: storage.ok,
    startedAt: context.getStartedAt()?.toISOString(),
    storage,
  };
}

function buildStatusResponse(context: LooperdApiContext) {
  const loops = context.store.loops.list();
  const runs = context.store.runs.list();
  const storage = context.store.schema.healthcheck();

  return {
    service: {
      healthy: storage.ok,
      version: "0.1.0",
      daemonMode: context.config.daemon.mode,
      startedAt: context.getStartedAt()?.toISOString(),
      recovery: context.getRecoverySummary(),
    },
    storage: {
      mode: storage.mode,
      dbPath: storage.dbPath,
      schemaVersion: storage.migration.latestAppliedId ?? "uninitialized",
      pendingMigrations: context.store.schema
        .getMigrationStatus()
        .pending.map((migration) => migration.id),
      healthy: storage.ok,
    },
    scheduler: {
      healthy: true,
      queuedItems: runs.filter((run) => run.status === "queued").length,
      runningItems: runs.filter((run) => run.status === "running").length,
    },
    loops: {
      reviewer: summarizeLoopType(loops, "reviewer"),
      worker: summarizeLoopType(loops, "worker"),
      fixer: summarizeLoopType(loops, "fixer"),
    },
    notifications: {
      osascriptEnabled: context.config.notifications.osascript.enabled,
    },
    tools: {
      bun: Boolean(context.config.tools.bunPath),
      git: Boolean(context.config.tools.gitPath),
      gh: Boolean(context.config.tools.ghPath),
      osascript: Boolean(context.config.tools.osascriptPath),
    },
  };
}

function summarizeLoopType(
  loops: ReturnType<Store["loops"]["list"]>,
  type: string,
) {
  const filtered = loops.filter((loop) => loop.type === type);

  return {
    running: filtered.filter((loop) => loop.status === "running").length,
    paused: filtered.filter((loop) => loop.status === "paused").length,
    failed: filtered.filter((loop) => loop.status === "failed").length,
  };
}

function buildConfigResponse(config: LooperConfig) {
  return {
    server: {
      host: config.server.host,
      port: config.server.port,
      baseUrl: config.server.baseUrl,
      authMode: config.server.authMode,
      localTokenConfigured: Boolean(config.server.localToken),
    },
    storage: config.storage,
    scheduler: config.scheduler,
    agent: config.agent,
    logging: config.logging,
    notifications: config.notifications,
    tools: config.tools,
    daemon: config.daemon,
    package: config.package,
    defaults: config.defaults,
    projects: config.projects,
  };
}

function buildEventsResponse(
  context: LooperdApiContext,
  searchParams: URLSearchParams,
) {
  const limitValue = searchParams.get("limit");
  const limit = limitValue ? Number(limitValue) : 100;

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      "limit must be a positive integer",
    );
  }

  return {
    items: context.store.events.list(limit).map(serializeEvent),
  };
}

function buildEntityEventsResponse(
  context: LooperdApiContext,
  pathname: string,
) {
  const parts = pathname.split("/").filter(Boolean);
  const entityType = parts[3];
  const entityId = parts[4];

  if (!entityType || !entityId) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      "entityType and entityId are required",
    );
  }

  return {
    entityType,
    entityId,
    items: context.store.events
      .listByEntity(
        decodeURIComponent(entityType),
        decodeURIComponent(entityId),
      )
      .map(serializeEvent),
  };
}

function buildPullRequestsResponse(context: LooperdApiContext) {
  const latestSnapshots = dedupeLatestSnapshots(
    context.store.pullRequestSnapshots.list(),
  );

  return {
    items: latestSnapshots.map((snapshot) =>
      serializePullRequest(context, snapshot),
    ),
  };
}

function buildPullRequestRouteResponse(
  context: LooperdApiContext,
  pathname: string,
) {
  const parts = pathname.split("/").filter(Boolean);
  const encodedRepo = parts[3];
  const maybePrNumber = parts[4];
  const subresource = parts[5];

  if (!encodedRepo || !maybePrNumber) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      "repo and prNumber are required",
    );
  }

  const repo = decodeURIComponent(encodedRepo);
  const prNumber = Number(maybePrNumber);

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      "prNumber must be a positive integer",
    );
  }

  const snapshot = context.store.pullRequestSnapshots.getLatest(repo, prNumber);

  if (!snapshot) {
    throw new ApiError(
      "PR_NOT_FOUND",
      404,
      `Pull request not found: ${repo}#${prNumber}`,
    );
  }

  if (subresource === "status") {
    return buildPullRequestStatusResponse(context, snapshot);
  }

  if (subresource) {
    throw new ApiError("ROUTE_NOT_FOUND", 404, `Unknown route: ${pathname}`);
  }

  return serializePullRequest(context, snapshot);
}

function buildPullRequestStatusResponse(
  context: LooperdApiContext,
  snapshot: PullRequestSnapshotRecord,
) {
  const loopMatches = context.store.loops
    .list()
    .filter(
      (loop) =>
        loop.repo === snapshot.repo && loop.prNumber === snapshot.prNumber,
    );
  const runMatches = loopMatches.flatMap((loop) =>
    context.store.runs.listByLoop(loop.id),
  );
  const taskMatch = context.store.tasks
    .list()
    .find(
      (task) =>
        task.repo === snapshot.repo && task.prNumber === snapshot.prNumber,
    );

  return {
    repo: snapshot.repo,
    prNumber: snapshot.prNumber,
    reviewState: snapshot.reviewState,
    checksSummary: snapshot.checksSummary,
    unresolvedThreadCount: snapshot.unresolvedThreadCount ?? 0,
    capturedAt: snapshot.capturedAt,
    loopStatus: summarizeRunAndLoopState(loopMatches, runMatches),
    task: taskMatch
      ? {
          id: taskMatch.id,
          title: taskMatch.title,
          status: taskMatch.status,
        }
      : null,
  };
}

function summarizeRunAndLoopState(
  loopMatches: { status: string }[],
  runs: RunRecord[],
) {
  return {
    loops: loopMatches.map((loop) => loop.status),
    latestRunStatus: runs[0]?.status,
    runningRunCount: runs.filter((run) => run.status === "running").length,
  };
}

function dedupeLatestSnapshots(
  snapshots: PullRequestSnapshotRecord[],
): PullRequestSnapshotRecord[] {
  const seen = new Set<string>();
  const deduped: PullRequestSnapshotRecord[] = [];

  for (const snapshot of snapshots) {
    const key = `${snapshot.repo}#${snapshot.prNumber}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(snapshot);
  }

  return deduped;
}

function serializePullRequest(
  context: LooperdApiContext,
  snapshot: PullRequestSnapshotRecord,
) {
  const task = context.store.tasks
    .list()
    .find(
      (candidate) =>
        candidate.repo === snapshot.repo &&
        candidate.prNumber === snapshot.prNumber,
    );

  return {
    repo: snapshot.repo,
    prNumber: snapshot.prNumber,
    projectId: snapshot.projectId,
    headSha: snapshot.headSha,
    baseSha: snapshot.baseSha,
    title: snapshot.title,
    body: snapshot.body,
    author: snapshot.author,
    diffRef: snapshot.diffRef,
    checksSummary: snapshot.checksSummary,
    unresolvedThreadCount: snapshot.unresolvedThreadCount ?? 0,
    reviewState: snapshot.reviewState,
    capturedAt: snapshot.capturedAt,
    task: task
      ? {
          id: task.id,
          title: task.title,
          status: task.status,
        }
      : null,
  };
}

function serializeEvent(event: EventLogRecord) {
  return {
    ...event,
    payload: parsePayloadJson(event.payloadJson),
  };
}

function parsePayloadJson(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson);
  } catch {
    return payloadJson;
  }
}

function jsonResponse<T>(status: number, payload: ApiResponse<T>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  return new ApiError(
    "INTERNAL_ERROR",
    500,
    error instanceof Error ? error.message : "Unknown error",
  );
}
