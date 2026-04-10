import { randomUUID } from "node:crypto";

import type { PullRequestSnapshotRecord } from "../storage/types";
import { CommandExecutionError, runCommand } from "./command";

export interface GitHubGatewayOptions {
  ghPath: string;
  cwd?: string;
  now?: () => Date;
}

export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  url?: string;
  state?: string;
  isDraft: boolean;
  reviewDecision?: string;
  headRefName?: string;
  baseRefName?: string;
  author?: string;
}

export interface GitHubPullRequestDetail extends GitHubPullRequestSummary {
  body?: string;
  headSha?: string;
  baseSha?: string;
  comments: unknown[];
  reviews: unknown[];
  checks: unknown[];
}

export interface SubmitReviewInput {
  repo: string;
  prNumber: number;
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  body?: string;
  cwd?: string;
}

export interface CreatePullRequestInput {
  repo: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body?: string;
  cwd?: string;
}

export interface CreatePullRequestResult {
  number?: number;
  url: string;
}

export class GhCliGitHubGateway {
  private readonly now: () => Date;

  constructor(private readonly options: GitHubGatewayOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async listOpenPullRequests(input: {
    repo: string;
    cwd?: string;
    limit?: number;
  }): Promise<GitHubPullRequestSummary[]> {
    const result = await this.runGh(
      [
        "pr",
        "list",
        "--repo",
        input.repo,
        "--state",
        "open",
        "--limit",
        String(input.limit ?? 30),
        "--json",
        [
          "number",
          "title",
          "url",
          "state",
          "isDraft",
          "reviewDecision",
          "headRefName",
          "baseRefName",
          "author",
        ].join(","),
      ],
      input.cwd,
    );

    return asArray(result.stdout).map((item) => ({
      number: Number(item.number),
      title: String(item.title),
      url: asOptionalString(item.url),
      state: asOptionalString(item.state),
      isDraft: Boolean(item.isDraft),
      reviewDecision: asOptionalString(item.reviewDecision),
      headRefName: asOptionalString(item.headRefName),
      baseRefName: asOptionalString(item.baseRefName),
      author: extractAuthor(item.author),
    }));
  }

  public async viewPullRequest(input: {
    repo: string;
    prNumber: number;
    cwd?: string;
  }): Promise<GitHubPullRequestDetail> {
    const result = await this.runGh(
      [
        "pr",
        "view",
        String(input.prNumber),
        "--repo",
        input.repo,
        "--json",
        [
          "number",
          "title",
          "body",
          "url",
          "state",
          "isDraft",
          "reviewDecision",
          "headRefName",
          "baseRefName",
          "headRefOid",
          "baseRefOid",
          "author",
          "comments",
          "reviews",
          "statusCheckRollup",
        ].join(","),
      ],
      input.cwd,
    );
    const parsed = asObject(result.stdout);

    return {
      number: Number(parsed.number),
      title: String(parsed.title),
      body: asOptionalString(parsed.body),
      url: asOptionalString(parsed.url),
      state: asOptionalString(parsed.state),
      isDraft: Boolean(parsed.isDraft),
      reviewDecision: asOptionalString(parsed.reviewDecision),
      headRefName: asOptionalString(parsed.headRefName),
      baseRefName: asOptionalString(parsed.baseRefName),
      headSha: asOptionalString(parsed.headRefOid),
      baseSha: asOptionalString(parsed.baseRefOid),
      author: extractAuthor(parsed.author),
      comments: asArrayValue(parsed.comments),
      reviews: asArrayValue(parsed.reviews),
      checks: asArrayValue(parsed.statusCheckRollup),
    };
  }

  public async getPullRequestDiff(input: {
    repo: string;
    prNumber: number;
    cwd?: string;
  }): Promise<string> {
    const result = await this.runGh(
      ["pr", "diff", String(input.prNumber), "--repo", input.repo],
      input.cwd,
    );
    return result.stdout;
  }

  public async submitReview(input: SubmitReviewInput): Promise<void> {
    const args = [
      "pr",
      "review",
      String(input.prNumber),
      "--repo",
      input.repo,
      `--${input.event.toLowerCase().replace("_", "-")}`,
    ];

    if (input.body) {
      args.push("--body", input.body);
    }

    await this.runGh(args, input.cwd);
  }

  public async createPullRequest(
    input: CreatePullRequestInput,
  ): Promise<CreatePullRequestResult> {
    const result = await this.runGh(
      [
        "pr",
        "create",
        "--repo",
        input.repo,
        "--head",
        input.headBranch,
        "--base",
        input.baseBranch,
        "--title",
        input.title,
        "--body",
        input.body ?? "",
      ],
      input.cwd,
    );

    const url = result.stdout.trim();
    if (!url) {
      throw new CommandExecutionError("gh pr create returned an empty URL", {
        ...result,
      });
    }

    return {
      url,
      number: parsePrNumberFromUrl(url),
    };
  }

  public async capturePullRequestSnapshot(input: {
    projectId: string;
    repo: string;
    prNumber: number;
    cwd?: string;
    capturedAt?: string;
  }): Promise<PullRequestSnapshotRecord> {
    const [detail, diff] = await Promise.all([
      this.viewPullRequest(input),
      this.getPullRequestDiff(input),
    ]);
    const capturedAt = input.capturedAt ?? this.now().toISOString();

    return {
      id: randomUUID(),
      projectId: input.projectId,
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: detail.headSha ?? "unknown",
      baseSha: detail.baseSha ?? null,
      title: detail.title,
      body: detail.body ?? null,
      author: detail.author ?? null,
      diffRef: `gh:pr-diff:${input.repo}:${input.prNumber}`,
      checksSummary: summarizeChecks(detail.checks),
      unresolvedThreadCount: countUnresolvedThreads(detail.comments),
      reviewState: detail.reviewDecision ?? null,
      payloadJson: JSON.stringify({ detail, diff }),
      capturedAt,
      createdAt: capturedAt,
    };
  }

  private async runGh(args: string[], cwd?: string) {
    return runCommand({
      command: this.options.ghPath,
      args,
      cwd: cwd ?? this.options.cwd,
    });
  }
}

function summarizeChecks(checks: unknown[]): string | null {
  if (checks.length === 0) {
    return null;
  }

  const states = checks
    .map(
      (check) =>
        asOptionalString((check as Record<string, unknown>).conclusion) ??
        asOptionalString((check as Record<string, unknown>).state) ??
        "unknown",
    )
    .join(", ");

  return states;
}

function countUnresolvedThreads(comments: unknown[]): number {
  return comments.filter((comment) => {
    const state = asOptionalString(
      (comment as Record<string, unknown>).state ??
        (comment as Record<string, unknown>).isResolved,
    );
    return state !== "RESOLVED" && state !== "true";
  }).length;
}

function asObject(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch (error) {
    throw new CommandExecutionError("Invalid gh JSON payload", {
      exitCode: 0,
      stdout: value,
      stderr: error instanceof Error ? error.message : "Unknown parse error",
      durationMs: 0,
    });
  }
}

function asArray(value: string): Record<string, unknown>[] {
  const parsed = asObjectArray(value);
  return parsed;
}

function asObjectArray(value: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch (error) {
    throw new CommandExecutionError("Invalid gh JSON payload", {
      exitCode: 0,
      stdout: value,
      stderr: error instanceof Error ? error.message : "Unknown parse error",
      durationMs: 0,
    });
  }
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
}

function asArrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractAuthor(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const author = value as Record<string, unknown>;
  return asOptionalString(author.login) ?? asOptionalString(author.name);
}

function parsePrNumberFromUrl(url: string): number | undefined {
  const match = url.match(/\/pull\/(\d+)(?:\/|$)/);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
