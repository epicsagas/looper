import { createHash, randomUUID } from "node:crypto";

import type { AgentResult, AgentRunInput } from "../infra/agent";
import { CommandExecutionError, runCommand } from "../infra/command";
import type {
  GitHubPullRequestDetail,
  GitHubPullRequestSummary,
} from "../infra/github";
import type { SchedulerQueue } from "../scheduler/index";
import type { Store } from "../storage/store";
import type {
  LoopRecord,
  ProjectRecord,
  QueueFailureKind,
  QueueItemRecord,
  RunRecord,
} from "../storage/types";

const FIXER_STEP_SEQUENCE = [
  "discover-pr",
  "claim-pr",
  "collect-fixes",
  "repair",
  "validate",
  "push",
  "recheck",
] as const;

export type FixerStep = (typeof FIXER_STEP_SEQUENCE)[number];

export type FixItem =
  | { type: "comment"; id: string; summary: string }
  | { type: "check"; name: string; summary: string }
  | { type: "conflict"; files: string[] };

export interface FixerGitHubGateway {
  listOpenPullRequests(input: {
    repo: string;
    cwd?: string;
    limit?: number;
  }): Promise<GitHubPullRequestSummary[]>;
  viewPullRequest(input: {
    repo: string;
    prNumber: number;
    cwd?: string;
  }): Promise<GitHubPullRequestDetail>;
}

export interface FixerGitGateway {
  push(input: {
    worktreePath: string;
    branch: string;
    remote?: string;
    protectedBranches?: string[];
  }): Promise<void>;
}

export interface FixerAgentExecution {
  wait(): Promise<AgentResult>;
}

export interface FixerAgentExecutor {
  start(input: AgentRunInput): Promise<FixerAgentExecution>;
}

export interface FixerValidationResult {
  passed: boolean;
  summary?: string;
  output?: string;
}

export interface FixerLoopRunnerOptions {
  store: Store;
  scheduler: SchedulerQueue;
  github: FixerGitHubGateway;
  git: FixerGitGateway;
  agentExecutor: FixerAgentExecutor;
  now?: () => Date;
  agentTimeoutMs?: number;
  claimTtlMs?: number;
  validationCommands?: string[];
  validationRunner?: (input: {
    cwd: string;
    commands: string[];
  }) => Promise<FixerValidationResult>;
}

export interface FixerDiscoveryResult {
  queueItems: QueueItemRecord[];
  createdLoopIds: string[];
  skipped: number;
}

export interface FixerProcessResult {
  loopId: string;
  runId: string;
  queueItemId: string;
  status: "success" | "skipped" | "failed";
  summary: string;
  failureKind?: QueueFailureKind;
}

interface FixerCheckpoint {
  resumePolicy?:
    | "replay_step"
    | "advance_from_checkpoint"
    | "manual_intervention";
  detail?: {
    state?: string;
    isDraft?: boolean;
    headSha?: string;
    headRefName?: string;
    baseSha?: string;
    reviewDecision?: string;
    comments?: unknown[];
    checks?: unknown[];
    hasConflicts?: boolean;
  };
  claimedLockKey?: string;
  fixItems?: FixItem[];
  fixItemsHash?: string;
  repair?: {
    summary?: string;
    headSha?: string;
  };
  validation?: FixerValidationResult;
  push?: {
    pushed: boolean;
    branch: string;
    pushedAt: string;
  };
  recheck?: {
    remainingFixItems: FixItem[];
  };
  skipReason?: string;
}

interface ResumedRunContext {
  run: RunRecord;
  startStep: FixerStep;
  checkpoint: FixerCheckpoint;
  resumed: boolean;
}

class FixerLoopError extends Error {
  constructor(
    message: string,
    public readonly kind: QueueFailureKind,
  ) {
    super(message);
    this.name = "FixerLoopError";
  }
}

export class FixerLoopRunner {
  private readonly now: () => Date;
  private readonly agentTimeoutMs: number;
  private readonly claimTtlMs: number;
  private readonly validationCommands: string[];

  constructor(private readonly options: FixerLoopRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.agentTimeoutMs = options.agentTimeoutMs ?? 30 * 60_000;
    this.claimTtlMs = options.claimTtlMs ?? 5 * 60_000;
    this.validationCommands = options.validationCommands ?? [];
  }

  public async discoverPullRequests(input: {
    projectId: string;
    repo: string;
    limit?: number;
  }): Promise<FixerDiscoveryResult> {
    const project = this.getProject(input.projectId);
    const openPullRequests = await this.options.github.listOpenPullRequests({
      repo: input.repo,
      cwd: project.repoPath,
      limit: input.limit,
    });

    const queueItems: QueueItemRecord[] = [];
    const createdLoopIds: string[] = [];
    let skipped = 0;

    for (const pullRequest of openPullRequests) {
      if (
        pullRequest.isDraft ||
        normalizePrState(pullRequest.state) !== "open" ||
        this.hasActivePrLock(input.repo, pullRequest.number)
      ) {
        skipped += 1;
        continue;
      }

      const detail = await this.options.github.viewPullRequest({
        repo: input.repo,
        prNumber: pullRequest.number,
        cwd: project.repoPath,
      });
      const fixItems = collectFixItems(detail);
      if (fixItems.length === 0) {
        skipped += 1;
        continue;
      }

      const loop = this.ensureLoopForPullRequest({
        projectId: project.id,
        repo: input.repo,
        prNumber: pullRequest.number,
      });
      if (loop.created) {
        createdLoopIds.push(loop.record.id);
      }

      const headSha = detail.headSha ?? "unknown";
      const fixItemsHash = hashFixItems(fixItems);
      queueItems.push(
        this.options.scheduler.enqueue({
          projectId: project.id,
          loopId: loop.record.id,
          type: "fixer",
          targetType: "pull_request",
          targetId: buildPullRequestTargetId(input.repo, pullRequest.number),
          repo: input.repo,
          prNumber: pullRequest.number,
          dedupeKey: buildFixerDedupeKey(
            input.repo,
            pullRequest.number,
            headSha,
            fixItemsHash,
          ),
        }),
      );
    }

    return { queueItems, createdLoopIds, skipped };
  }

  public async processNext(
    claimedBy: string,
  ): Promise<FixerProcessResult | null> {
    const item = this.options.scheduler.claimNext(claimedBy);
    if (!item || item.type !== "fixer") {
      return null;
    }

    return this.processClaimedItem(item);
  }

  public async processClaimedItem(
    queueItem: QueueItemRecord,
  ): Promise<FixerProcessResult> {
    if (queueItem.type !== "fixer") {
      throw new Error(`Unsupported queue item type: ${queueItem.type}`);
    }
    if (!queueItem.loopId || !queueItem.repo || !queueItem.prNumber) {
      throw new Error("Fixer queue item requires loopId, repo, and prNumber");
    }

    const loop = this.getLoop(queueItem.loopId);
    const project = this.getProject(loop.projectId);
    const resumedRun = this.createRunContext(loop);
    let run = resumedRun.run;
    let checkpoint = resumedRun.checkpoint;
    let claimedLockKey: string | undefined;

    this.updateLoop(loop, {
      status: "running",
      lastRunAt: run.startedAt,
      nextRunAt: null,
    });

    try {
      for (const step of FIXER_STEP_SEQUENCE.slice(
        FIXER_STEP_SEQUENCE.indexOf(resumedRun.startStep),
      )) {
        run = this.persistStepStarted(run, step, checkpoint);
        checkpoint = await this.executeStep({
          step,
          checkpoint,
          project,
          loop,
          run,
          queueItem,
        });

        if (step === "claim-pr") {
          claimedLockKey = checkpoint.claimedLockKey;
        }

        run = this.persistStepCompleted(run, step, checkpoint);
        if (checkpoint.skipReason) {
          break;
        }
      }

      const summary = checkpoint.skipReason
        ? checkpoint.skipReason
        : `Applied fixer run for ${queueItem.repo}#${queueItem.prNumber}`;
      this.finalizeRun(run, {
        status: "success",
        summary,
        checkpoint,
      });
      this.options.scheduler.complete(queueItem.id);
      this.updateLoop(loop, {
        status: "completed",
        lastRunAt: this.nowIso(),
        nextRunAt: null,
      });

      return {
        loopId: loop.id,
        runId: run.id,
        queueItemId: queueItem.id,
        status: checkpoint.skipReason ? "skipped" : "success",
        summary,
      };
    } catch (error) {
      const failure = this.classifyFailure(error);
      this.finalizeRun(run, {
        status: "failed",
        summary: failure.message,
        checkpoint: {
          ...checkpoint,
          resumePolicy:
            failure.kind === "retryable_after_resume"
              ? "advance_from_checkpoint"
              : failure.kind === "manual_intervention"
                ? "manual_intervention"
                : (checkpoint.resumePolicy ?? "replay_step"),
        },
        errorMessage: failure.message,
      });

      const failedQueueItem = this.options.scheduler.fail(
        queueItem.id,
        failure.kind,
        failure.message,
      );

      if (failedQueueItem?.status === "queued") {
        this.updateLoop(loop, {
          status: "queued",
          lastRunAt: this.nowIso(),
          nextRunAt: failedQueueItem.availableAt,
        });
      } else {
        this.updateLoop(loop, {
          status: failure.kind === "manual_intervention" ? "paused" : "failed",
          lastRunAt: this.nowIso(),
          nextRunAt: null,
        });
      }

      return {
        loopId: loop.id,
        runId: run.id,
        queueItemId: queueItem.id,
        status: "failed",
        summary: failure.message,
        failureKind: failure.kind,
      };
    } finally {
      if (claimedLockKey) {
        this.options.scheduler.releaseBusinessLock(claimedLockKey);
      }
    }
  }

  private async executeStep(input: {
    step: FixerStep;
    checkpoint: FixerCheckpoint;
    project: ProjectRecord;
    loop: LoopRecord;
    run: RunRecord;
    queueItem: QueueItemRecord;
  }): Promise<FixerCheckpoint> {
    switch (input.step) {
      case "discover-pr":
        return this.runDiscoverPrStep(input);
      case "claim-pr":
        return this.runClaimPrStep(input);
      case "collect-fixes":
        return this.runCollectFixesStep(input);
      case "repair":
        return this.runRepairStep(input);
      case "validate":
        return this.runValidateStep(input);
      case "push":
        return this.runPushStep(input);
      case "recheck":
        return this.runRecheckStep(input);
    }
  }

  private async runDiscoverPrStep(input: {
    checkpoint: FixerCheckpoint;
    project: ProjectRecord;
    queueItem: QueueItemRecord;
  }): Promise<FixerCheckpoint> {
    const repo = requireString(input.queueItem.repo, "queueItem.repo");
    const prNumber = requireNumber(
      input.queueItem.prNumber,
      "queueItem.prNumber",
    );
    const detail = await this.options.github.viewPullRequest({
      repo,
      prNumber,
      cwd: input.project.repoPath,
    });

    return {
      ...input.checkpoint,
      detail: {
        state: detail.state,
        isDraft: detail.isDraft,
        headSha: detail.headSha,
        headRefName: detail.headRefName,
        baseSha: detail.baseSha,
        reviewDecision: detail.reviewDecision,
        comments: detail.comments,
        checks: detail.checks,
        hasConflicts: readBoolean(
          (detail as unknown as Record<string, unknown>).hasConflicts,
        ),
      },
      resumePolicy: "replay_step",
    };
  }

  private async runClaimPrStep(input: {
    checkpoint: FixerCheckpoint;
    queueItem: QueueItemRecord;
  }): Promise<FixerCheckpoint> {
    const lockKey =
      input.queueItem.lockKey ??
      `pr:${input.queueItem.repo}:${input.queueItem.prNumber}`;
    const acquired = this.options.scheduler.acquireBusinessLock({
      key: lockKey,
      owner: input.queueItem.id,
      reason: "fixer-claim",
      expiresAt: new Date(this.now().getTime() + this.claimTtlMs).toISOString(),
    });
    if (!acquired) {
      throw new FixerLoopError(
        `Pull request lock is already held for ${lockKey}`,
        "retryable_transient",
      );
    }

    return {
      ...input.checkpoint,
      claimedLockKey: lockKey,
    };
  }

  private async runCollectFixesStep(input: {
    checkpoint: FixerCheckpoint;
    queueItem: QueueItemRecord;
  }): Promise<FixerCheckpoint> {
    const detail = input.checkpoint.detail;
    if (!detail) {
      throw new FixerLoopError(
        "Missing PR detail checkpoint for collect-fixes step",
        "retryable_transient",
      );
    }

    if (detail.isDraft || normalizePrState(detail.state) !== "open") {
      return {
        ...input.checkpoint,
        skipReason: `Skipped pull request ${input.queueItem.repo}#${input.queueItem.prNumber} because it is not eligible`,
      };
    }

    const fixItems = collectFixItemsFromCheckpoint(input.checkpoint);
    if (fixItems.length === 0) {
      return {
        ...input.checkpoint,
        fixItems,
        fixItemsHash: hashFixItems(fixItems),
        skipReason: `Skipped ${input.queueItem.repo}#${input.queueItem.prNumber} because no fix items remain`,
      };
    }

    return {
      ...input.checkpoint,
      fixItems,
      fixItemsHash: hashFixItems(fixItems),
      resumePolicy: "advance_from_checkpoint",
      skipReason: undefined,
    };
  }

  private async runRepairStep(input: {
    checkpoint: FixerCheckpoint;
    project: ProjectRecord;
    loop: LoopRecord;
    run: RunRecord;
    queueItem: QueueItemRecord;
  }): Promise<FixerCheckpoint> {
    if (input.checkpoint.skipReason) {
      return input.checkpoint;
    }
    if (input.checkpoint.repair) {
      return input.checkpoint;
    }

    const fixItems = input.checkpoint.fixItems;
    if (!fixItems || fixItems.length === 0) {
      throw new FixerLoopError(
        "Missing fix items checkpoint for repair step",
        "retryable_transient",
      );
    }

    const detail = input.checkpoint.detail;
    const prompt = buildFixerPrompt({
      repo: requireString(input.queueItem.repo, "queueItem.repo"),
      prNumber: requireNumber(input.queueItem.prNumber, "queueItem.prNumber"),
      headSha: detail?.headSha,
      fixItems,
    });
    const execution = await this.options.agentExecutor.start({
      executionId: randomUUID(),
      projectId: input.project.id,
      loopId: input.loop.id,
      runId: input.run.id,
      prompt,
      workingDirectory: input.project.repoPath,
      timeoutMs: this.agentTimeoutMs,
      metadata: {
        loopType: "fixer",
        repo: input.queueItem.repo,
        prNumber: input.queueItem.prNumber,
        step: "repair",
      },
      idempotencyKey: `fixer:${input.loop.id}:${input.checkpoint.fixItemsHash ?? "unknown"}:${detail?.headSha ?? "unknown"}`,
    });
    const result = await execution.wait();
    if (result.status !== "completed") {
      throw new FixerLoopError(
        result.summary ?? `Fixer agent ${result.status}`,
        "retryable_transient",
      );
    }

    return {
      ...input.checkpoint,
      repair: {
        summary: result.summary,
        headSha: detail?.headSha,
      },
      resumePolicy: "advance_from_checkpoint",
    };
  }

  private async runValidateStep(input: {
    checkpoint: FixerCheckpoint;
    project: ProjectRecord;
  }): Promise<FixerCheckpoint> {
    if (input.checkpoint.skipReason) {
      return input.checkpoint;
    }

    const result = await this.runValidation({
      cwd: input.project.repoPath,
      commands: this.validationCommands,
    });
    if (!result.passed) {
      throw new FixerLoopError(
        result.summary ?? "Validation failed",
        "retryable_after_resume",
      );
    }

    return {
      ...input.checkpoint,
      validation: result,
      resumePolicy: "advance_from_checkpoint",
    };
  }

  private async runPushStep(input: {
    checkpoint: FixerCheckpoint;
    project: ProjectRecord;
    loop: LoopRecord;
    queueItem: QueueItemRecord;
  }): Promise<FixerCheckpoint> {
    if (input.checkpoint.skipReason) {
      return input.checkpoint;
    }
    if (input.checkpoint.push?.pushed) {
      return input.checkpoint;
    }

    const branch = input.checkpoint.detail?.headRefName;
    if (!branch) {
      throw new FixerLoopError(
        "Missing PR head branch for push step",
        "retryable_after_resume",
      );
    }

    try {
      await this.options.git.push({
        worktreePath: input.project.repoPath,
        branch,
      });
    } catch (error) {
      throw new FixerLoopError(
        error instanceof Error ? error.message : "Failed to push fixer updates",
        "retryable_after_resume",
      );
    }

    const metadata = parseJsonObject(input.loop.metadataJson);
    const pushedAt = this.nowIso();
    this.updateLoop(input.loop, {
      metadataJson: JSON.stringify({
        ...metadata,
        lastFixHeadSha: input.checkpoint.detail?.headSha ?? null,
        lastFixItemsHash: input.checkpoint.fixItemsHash ?? null,
        lastFixPushedAt: pushedAt,
      }),
    });

    return {
      ...input.checkpoint,
      push: {
        pushed: true,
        branch,
        pushedAt,
      },
      resumePolicy: "advance_from_checkpoint",
    };
  }

  private async runRecheckStep(input: {
    checkpoint: FixerCheckpoint;
    project: ProjectRecord;
    queueItem: QueueItemRecord;
  }): Promise<FixerCheckpoint> {
    if (input.checkpoint.skipReason) {
      return input.checkpoint;
    }

    const repo = requireString(input.queueItem.repo, "queueItem.repo");
    const prNumber = requireNumber(
      input.queueItem.prNumber,
      "queueItem.prNumber",
    );

    try {
      const detail = await this.options.github.viewPullRequest({
        repo,
        prNumber,
        cwd: input.project.repoPath,
      });
      return {
        ...input.checkpoint,
        recheck: {
          remainingFixItems: collectFixItems(detail),
        },
      };
    } catch (error) {
      throw new FixerLoopError(
        error instanceof Error
          ? error.message
          : "Failed to recheck pull request",
        "retryable_after_resume",
      );
    }
  }

  private createRunContext(loop: LoopRecord): ResumedRunContext {
    const latestRun = this.options.store.runs.listByLoop(loop.id)[0] ?? null;
    const nowIso = this.nowIso();
    const checkpoint = parseCheckpoint(latestRun?.checkpointJson);
    const lastCompletedStep = asFixerStep(latestRun?.lastCompletedStep);
    const startStep =
      latestRun &&
      (latestRun.status === "failed" || latestRun.status === "interrupted") &&
      lastCompletedStep
        ? (nextFixerStep(lastCompletedStep) ?? "discover-pr")
        : "discover-pr";
    const resumed =
      Boolean(latestRun) &&
      (latestRun?.status === "failed" || latestRun?.status === "interrupted") &&
      startStep !== "discover-pr";

    const run: RunRecord = {
      id: randomUUID(),
      loopId: loop.id,
      status: "running",
      currentStep: startStep,
      lastCompletedStep: resumed ? (lastCompletedStep ?? null) : null,
      checkpointJson: JSON.stringify(
        resumed
          ? { ...checkpoint, resumePolicy: "advance_from_checkpoint" }
          : { resumePolicy: "replay_step" },
      ),
      summary: null,
      errorMessage: null,
      startedAt: nowIso,
      lastHeartbeatAt: nowIso,
      endedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.options.store.runs.upsert(run);

    return {
      run,
      startStep,
      checkpoint: parseCheckpoint(run.checkpointJson),
      resumed,
    };
  }

  private persistStepStarted(
    run: RunRecord,
    step: FixerStep,
    checkpoint: FixerCheckpoint,
  ): RunRecord {
    const updated: RunRecord = {
      ...run,
      currentStep: step,
      checkpointJson: JSON.stringify(checkpoint),
      lastHeartbeatAt: this.nowIso(),
      updatedAt: this.nowIso(),
    };
    this.options.store.runs.upsert(updated);
    return updated;
  }

  private persistStepCompleted(
    run: RunRecord,
    step: FixerStep,
    checkpoint: FixerCheckpoint,
  ): RunRecord {
    if (checkpoint.skipReason) {
      return this.finalizeRun(run, {
        status: "success",
        summary: checkpoint.skipReason,
        checkpoint,
      });
    }

    const updated: RunRecord = {
      ...run,
      currentStep: nextFixerStep(step),
      lastCompletedStep: step,
      checkpointJson: JSON.stringify(checkpoint),
      lastHeartbeatAt: this.nowIso(),
      updatedAt: this.nowIso(),
    };
    this.options.store.runs.upsert(updated);
    return updated;
  }

  private finalizeRun(
    run: RunRecord,
    input: {
      status: RunRecord["status"];
      summary: string;
      checkpoint: FixerCheckpoint;
      errorMessage?: string;
    },
  ): RunRecord {
    const endedAt = this.nowIso();
    const updated: RunRecord = {
      ...run,
      status: input.status,
      summary: input.summary,
      errorMessage: input.errorMessage ?? null,
      checkpointJson: JSON.stringify(input.checkpoint),
      lastHeartbeatAt: endedAt,
      endedAt,
      updatedAt: endedAt,
    };
    this.options.store.runs.upsert(updated);
    return updated;
  }

  private ensureLoopForPullRequest(input: {
    projectId: string;
    repo: string;
    prNumber: number;
  }): { record: LoopRecord; created: boolean } {
    const existing = this.options.store.loops
      .list()
      .find(
        (loop) =>
          loop.type === "fixer" &&
          loop.projectId === input.projectId &&
          loop.repo === input.repo &&
          loop.prNumber === input.prNumber,
      );

    const nowIso = this.nowIso();
    if (existing) {
      const updated = {
        ...existing,
        status: existing.status === "running" ? existing.status : "queued",
        nextRunAt: nowIso,
        updatedAt: nowIso,
      };
      this.options.store.loops.upsert(updated);
      return { record: updated, created: false };
    }

    const loop: LoopRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      type: "fixer",
      targetType: "pull_request",
      targetId: buildPullRequestTargetId(input.repo, input.prNumber),
      repo: input.repo,
      prNumber: input.prNumber,
      status: "queued",
      configJson: null,
      metadataJson: null,
      lastRunAt: null,
      nextRunAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.options.store.loops.upsert(loop);
    return { record: loop, created: true };
  }

  private hasActivePrLock(repo: string, prNumber: number): boolean {
    const lock = this.options.store.locks.get(`pr:${repo}:${prNumber}`);
    if (!lock) {
      return false;
    }
    return new Date(lock.expiresAt).getTime() > this.now().getTime();
  }

  private updateLoop(
    loop: LoopRecord,
    updates: Partial<LoopRecord>,
  ): LoopRecord {
    const current = this.options.store.loops.getById(loop.id) ?? loop;
    const updated = {
      ...current,
      ...updates,
      updatedAt: updates.updatedAt ?? this.nowIso(),
    };
    this.options.store.loops.upsert(updated);
    return updated;
  }

  private getLoop(loopId: string): LoopRecord {
    const loop = this.options.store.loops.getById(loopId);
    if (!loop) {
      throw new Error(`Loop not found: ${loopId}`);
    }
    return loop;
  }

  private getProject(projectId: string): ProjectRecord {
    const project = this.options.store.projects.getById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return project;
  }

  private classifyFailure(error: unknown): FixerLoopError {
    if (error instanceof FixerLoopError) {
      return error;
    }
    if (error instanceof CommandExecutionError) {
      return new FixerLoopError(error.message, "retryable_transient");
    }
    return new FixerLoopError(
      error instanceof Error ? error.message : "Fixer loop failed",
      "non_retryable",
    );
  }

  private async runValidation(input: {
    cwd: string;
    commands: string[];
  }): Promise<FixerValidationResult> {
    if (this.options.validationRunner) {
      return this.options.validationRunner(input);
    }
    if (input.commands.length === 0) {
      return {
        passed: true,
        summary: "No validation commands configured",
        output: "",
      };
    }

    const outputs: string[] = [];
    for (const command of input.commands) {
      try {
        const result = await runCommand({
          command: "/bin/sh",
          args: ["-lc", command],
          cwd: input.cwd,
        });
        outputs.push(result.stdout.trim(), result.stderr.trim());
      } catch (error) {
        const output =
          error instanceof CommandExecutionError
            ? [error.result.stdout, error.result.stderr]
                .filter(Boolean)
                .join("\n")
            : error instanceof Error
              ? error.message
              : "Unknown validation failure";
        return {
          passed: false,
          summary: `Validation failed: ${command}`,
          output,
        };
      }
    }

    return {
      passed: true,
      summary: "Validation passed",
      output: outputs.filter(Boolean).join("\n"),
    };
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function collectFixItemsFromCheckpoint(checkpoint: FixerCheckpoint): FixItem[] {
  const detail = checkpoint.detail;
  if (!detail) {
    return [];
  }

  return normalizeFixItems(detail);
}

function collectFixItems(detail: GitHubPullRequestDetail): FixItem[] {
  return normalizeFixItems(detail as unknown as Record<string, unknown>);
}

function normalizeFixItems(detail: {
  comments?: unknown[];
  checks?: unknown[];
  hasConflicts?: boolean;
}): FixItem[] {
  const commentItems: FixItem[] = asArray(detail.comments)
    .filter((comment) => !isCommentResolved(comment))
    .map((comment, index) => {
      const id =
        readString((comment as Record<string, unknown>).id) ??
        `comment-${index}`;
      return {
        type: "comment",
        id,
        summary:
          readString((comment as Record<string, unknown>).body) ??
          readString((comment as Record<string, unknown>).state) ??
          "Unresolved review comment",
      };
    });

  const checkItems: FixItem[] = asArray(detail.checks)
    .filter((check) => isFailingCheck(check as Record<string, unknown>))
    .map((check) => {
      const row = check as Record<string, unknown>;
      return {
        type: "check",
        name: readString(row.name) ?? "unnamed-check",
        summary:
          readString(row.conclusion) ??
          readString(row.state) ??
          "Failing check",
      };
    });

  const conflictItem: FixItem[] = detail.hasConflicts
    ? [{ type: "conflict", files: [] }]
    : [];

  return [...commentItems, ...checkItems, ...conflictItem];
}

function isCommentResolved(comment: unknown): boolean {
  if (!comment || typeof comment !== "object") {
    return false;
  }
  const state = readString((comment as Record<string, unknown>).state);
  if (state?.toUpperCase() === "RESOLVED") {
    return true;
  }
  if ((comment as Record<string, unknown>).isResolved === true) {
    return true;
  }
  return false;
}

function isFailingCheck(check: Record<string, unknown>): boolean {
  const state =
    readString(check.conclusion)?.toUpperCase() ??
    readString(check.state)?.toUpperCase() ??
    "UNKNOWN";
  return [
    "FAILURE",
    "FAILED",
    "ERROR",
    "TIMED_OUT",
    "ACTION_REQUIRED",
  ].includes(state);
}

function buildPullRequestTargetId(repo: string, prNumber: number): string {
  return `pr:${repo}:${prNumber}`;
}

function buildFixerDedupeKey(
  repo: string,
  prNumber: number,
  headSha: string,
  fixItemsHash: string,
): string {
  return `fixer:${repo}:${prNumber}:${headSha}:${fixItemsHash}`;
}

function nextFixerStep(step: FixerStep): FixerStep | null {
  const index = FIXER_STEP_SEQUENCE.indexOf(step);
  return FIXER_STEP_SEQUENCE[index + 1] ?? null;
}

function asFixerStep(value: string | null | undefined): FixerStep | null {
  return FIXER_STEP_SEQUENCE.includes(value as FixerStep)
    ? (value as FixerStep)
    : null;
}

function parseCheckpoint(value?: string | null): FixerCheckpoint {
  if (!value) {
    return {};
  }
  return parseJsonObject(value) as FixerCheckpoint;
}

function parseJsonObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function hashFixItems(fixItems: FixItem[]): string {
  const normalized = fixItems
    .map((item) => JSON.stringify(item))
    .sort()
    .join("|");
  return createHash("sha1").update(normalized).digest("hex");
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function requireString(
  value: string | null | undefined,
  fieldName: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function requireNumber(
  value: number | null | undefined,
  fieldName: string,
): number {
  if (typeof value !== "number") {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function normalizePrState(value: string | undefined): "open" | "other" {
  return value?.toLowerCase() === "open" ? "open" : "other";
}

function buildFixerPrompt(input: {
  repo: string;
  prNumber: number;
  headSha?: string;
  fixItems: FixItem[];
}): string {
  return [
    `Fix pull request ${input.repo}#${input.prNumber}.`,
    input.headSha ? `Head SHA: ${input.headSha}` : null,
    `Fix items:\n${input.fixItems.map((item) => `- ${JSON.stringify(item)}`).join("\n")}`,
    "Only perform repair changes for the listed fix items.",
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}
