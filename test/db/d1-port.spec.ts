import { describe, expect, it } from "vitest";
import { queryBatch, queryRows } from "@codraoss/db/client";
import {
  bulkUpsertFileReviews,
  getFileReviewsForJobs,
  getSuppressedFindings,
  markCommentDispositions,
  markCommentsPosted,
  upsertFileReview,
  type BulkFileReviewInput,
} from "@codraoss/db/file-reviews";
import {
  cancelJob,
  completeJob,
  deleteJob,
  getJobDetail,
  hasPendingMaintenanceWork,
  insertJob,
  listJobs,
  updateJobStep,
} from "@codraoss/db/jobs";
import { getRejectedExemplars } from "@codraoss/db/learning";
import {
  createLlmProvider,
  getResolvedModelConfig,
  listLlmProviders,
  updateModelConfig,
  upsertDiscoveredModelConfigs,
} from "@codraoss/db/model-configs";
import {
  deleteStaleRepoConfigs,
  getRepoConfigRecord,
  syncRepoConfig,
  updateRepoConfigEnabled,
} from "@codraoss/db/repo-configs";
import { getStats } from "@codraoss/db/stats";
import type { ParsedReviewComment } from "@codraoss/schema";
import { createTestEnv, sha, uniqueName } from "../helpers";

// Queries whose SQL could not be carried over from Postgres and that no other spec reaches.
const env = createTestEnv();

async function newJob(repo = uniqueName("d1"), prNumber = 1) {
  return insertJob(env, {
    installationId: "123",
    owner: "d1-owner",
    repo,
    prNumber,
    prTitle: "D1 Port",
    prAuthor: "author",
    commitSha: sha("a"),
    baseSha: sha("b"),
    trigger: "auto",
    headRef: "feature",
    baseRef: "main",
  });
}

function comment(fingerprint: string, title = "A title"): ParsedReviewComment {
  return {
    path: "a.ts",
    line: 1,
    position: 1,
    severity: "P2",
    category: "quality",
    title,
    body: "body",
    fingerprint,
    posted: false,
    source: "llm",
  } as ParsedReviewComment;
}

function fileReview(path: string, comments: ParsedReviewComment[]) {
  return {
    filePath: path,
    fileStatus: "done" as const,
    modelUsed: "@cf/test",
    diffLineCount: 1,
    diffInput: null,
    rawAiOutput: null,
    parsedComments: comments,
    inputTokens: 10,
    outputTokens: 5,
    durationMs: 1,
    verdict: "comment" as const,
    fileSummary: null,
    errorMessage: null,
  };
}

describe("D1 persistence", () => {
  it("returns job detail with nested JSON decoded and booleans as booleans", async () => {
    const job = await newJob();
    await upsertFileReview(env, job.id, {
      ...fileReview("a.ts", [comment("fp-posted"), comment("fp-other")]),
      withheldCounts: { evidence: 2, claimDenied: 0 },
    });
    await markCommentsPosted(env, job.id, ["fp-posted"]);

    const detail = await getJobDetail(env, job.id);
    expect(detail?.files).toHaveLength(1);
    const [file] = detail!.files as Array<{
      withheldCounts: { evidence: number };
      parsedComments: Array<{ fingerprint: string; posted: boolean }>;
    }>;
    expect(file.withheldCounts.evidence).toBe(2);
    expect(file.parsedComments.map((c) => [c.fingerprint, c.posted])).toEqual([
      ["fp-posted", true],
      ["fp-other", false],
    ]);
  });

  it("returns an empty file list for a job with no reviews", async () => {
    const job = await newJob();
    const detail = await getJobDetail(env, job.id);
    expect(detail?.files).toEqual([]);
  });

  it("never rewrites the disposition of a posted finding", async () => {
    const job = await newJob();
    await upsertFileReview(
      env,
      job.id,
      fileReview("a.ts", [comment("fp-posted"), comment("fp-gated")]),
    );
    await markCommentsPosted(env, job.id, ["fp-posted"]);
    await markCommentDispositions(
      env,
      job.id,
      new Map([
        ["fp-posted", { disposition: "suppression", reason: "r1" }],
        ["fp-gated", { disposition: "severity", reason: "r2" }],
      ]),
    );

    const [review] = await getFileReviewsForJobs(env, [job.id]);
    const byFingerprint = new Map(
      (
        review.parsed_comments as unknown as Array<{
          fingerprint: string;
          disposition: string;
          verifyReason: string;
        }>
      ).map((c) => [c.fingerprint, c]),
    );
    expect(byFingerprint.get("fp-posted")?.disposition).toBe("posted");
    expect(byFingerprint.get("fp-posted")?.verifyReason).toBe("r1");
    expect(byFingerprint.get("fp-gated")?.disposition).toBe("severity");
  });

  it("marks suppressions as real booleans", async () => {
    const repo = uniqueName("d1-suppress");
    const first = await newJob(repo);
    await upsertFileReview(env, first.id, fileReview("a.ts", [comment("fp-1")]));
    await markCommentsPosted(env, first.id, ["fp-1"]);
    const second = await insertJob(env, {
      installationId: "123",
      owner: "d1-owner",
      repo,
      prNumber: 1,
      prTitle: null,
      prAuthor: null,
      commitSha: sha("c"),
      baseSha: sha("b"),
      trigger: "auto",
      headRef: null,
      baseRef: null,
    });

    const suppressed = await getSuppressedFindings(env, second.id);
    expect(suppressed).toEqual([
      expect.objectContaining({ fingerprint: "fp-1", anchored: true }),
    ]);
  });

  it("splits a rowset too large for one bound value across statements", async () => {
    const job = await newJob();
    const big = "x".repeat(400_000);
    const inputs: BulkFileReviewInput[] = Array.from({ length: 8 }, (_, i) => ({
      filePath: `big-${i}.ts`,
      fileStatus: "done",
      modelUsed: "@cf/test",
      diffLineCount: 1,
      rawAiOutput: big,
      parsedComments: [comment(`fp-${i}`)],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: "comment",
      fileSummary: null,
      errorMessage: null,
      batchSize: 8,
    })) as BulkFileReviewInput[];

    await bulkUpsertFileReviews(env, job.id, inputs);

    const reviews = await getFileReviewsForJobs(env, [job.id]);
    expect(reviews).toHaveLength(8);
    expect(
      reviews.every((r) => (r.parsed_comments as unknown[]).length === 1),
    ).toBe(true);
  });

  it("rolls back a whole batch when one statement fails", async () => {
    const job = await newJob();
    await expect(
      queryBatch(env, [
        {
          sql: `UPDATE jobs SET pr_title = 'changed' WHERE id = $1`,
          params: [job.id],
        },
        { sql: "INSERT INTO no_such_table (x) VALUES (1)" },
      ]),
    ).rejects.toThrow();
    const [row] = await queryRows<{ pr_title: string }>(
      env,
      "SELECT pr_title FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(row.pr_title).toBe("D1 Port");
  });

  it("appends, updates, and preserves job steps in order", async () => {
    const job = await newJob();
    await updateJobStep(env, job.id, "One", { status: "running" });
    await updateJobStep(env, job.id, "Two", { status: "running" });
    await updateJobStep(env, job.id, "One", { status: "done" });
    await completeJob(env, job.id, {
      verdict: "approve",
      fileCount: 0,
      commentCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      summaryMarkdown: "",
      reviewId: null,
      summaryModel: null,
    });
    const detail = await getJobDetail(env, job.id);
    const steps = detail!.steps as Array<{
      name: string;
      status: string;
      finishedAt: string | null;
    }>;
    expect(steps.map((s) => s.name)).toEqual(["One", "Two", "Completing"]);
    expect(steps[0].status).toBe("done");
    expect(steps[0].finishedAt).toEqual(expect.any(String));
    expect(steps[1].status).toBe("running");
  });

  it("fails running steps when a job is cancelled, and only once", async () => {
    const job = await newJob();
    await updateJobStep(env, job.id, "One", { status: "running" });
    expect(await cancelJob(env, job.id)).toBe(true);
    expect(await cancelJob(env, job.id)).toBe(false);
    const detail = await getJobDetail(env, job.id);
    expect(detail?.status).toBe("cancelled");
    expect((detail!.steps as Array<{ status: string }>)[0].status).toBe(
      "failed",
    );
  });

  it("reports pending maintenance work as a boolean", async () => {
    await newJob();
    expect(await hasPendingMaintenanceWork(env)).toBe(true);
  });

  it("cascades deletes through reviews and comments", async () => {
    const job = await newJob();
    await upsertFileReview(env, job.id, fileReview("a.ts", [comment("fp-x")]));
    expect(await deleteJob(env, job.id)).toBe(true);
    const rows = await queryRows(
      env,
      `SELECT rc.id FROM review_comments rc
       JOIN file_reviews fr ON fr.id = rc.file_review_id
       WHERE fr.job_id = $1`,
      [job.id],
    );
    expect(rows).toEqual([]);
    const reviews = await getFileReviewsForJobs(env, [job.id]);
    expect(reviews).toEqual([]);
  });

  it("searches job titles case-insensitively", async () => {
    const repo = uniqueName("d1-search");
    await newJob(repo);
    const { jobs, total } = await listJobs(env, {
      owner: "d1-owner",
      repo,
      search: "d1 port",
      limit: 10,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(jobs).toHaveLength(1);
  });

  it("returns the newest rejected exemplar per fingerprint", async () => {
    const repo = uniqueName("d1-exemplars");
    const job = await newJob(repo);
    await upsertFileReview(
      env,
      job.id,
      fileReview("a.ts", [comment("fp-rej", "old title")]),
    );
    const later = await insertJob(env, {
      installationId: "123",
      owner: "d1-owner",
      repo,
      prNumber: 2,
      prTitle: null,
      prAuthor: null,
      commitSha: sha("c"),
      baseSha: sha("b"),
      trigger: "auto",
      headRef: null,
      baseRef: null,
    });
    await upsertFileReview(
      env,
      later.id,
      fileReview("a.ts", [comment("fp-rej", "new title")]),
    );
    const [{ repository_id: repositoryId }] = await queryRows<{
      repository_id: number;
    }>(env, "SELECT repository_id FROM jobs WHERE id = $1", [job.id]);
    await queryRows(
      env,
      `INSERT INTO comment_feedback (repository_id, fingerprint, github_comment_id, outcome)
       VALUES ($1, 'fp-rej', 1, 'deleted')`,
      [repositoryId],
    );

    const exemplars = await getRejectedExemplars(env, { repositoryId });
    expect(exemplars).toHaveLength(1);
    expect(exemplars[0].title).toBe("new title");
  });

  it("handles repo configs: booleans, last job, and stale removal", async () => {
    const repo = uniqueName("d1-config");
    const input = { installationId: "777", owner: "d1-owner", repo };
    await syncRepoConfig(env, input);
    let record = await getRepoConfigRecord(env, "d1-owner", repo);
    expect(record?.enabled).toBe(true);
    expect(record?.lastJobVerdict).toBeNull();

    await updateRepoConfigEnabled(env, {
      owner: "d1-owner",
      repo,
      enabled: false,
    });
    record = await getRepoConfigRecord(env, "d1-owner", repo);
    expect(record?.enabled).toBe(false);

    await deleteStaleRepoConfigs(env, "777", [`d1-owner/${repo}`]);
    expect(await getRepoConfigRecord(env, "d1-owner", repo)).not.toBeNull();
    await deleteStaleRepoConfigs(env, "777", ["d1-owner/other"]);
    expect(await getRepoConfigRecord(env, "d1-owner", repo)).toBeNull();
  });

  it("creates and resolves providers and models", async () => {
    const providers = await listLlmProviders(env);
    expect(providers.find((p) => p.name === "Cloudflare")?.enabled).toBe(true);
    expect(providers.find((p) => p.name === "OpenAI")?.enabled).toBe(false);

    const provider = await createLlmProvider(env, {
      name: uniqueName("Provider"),
      apiFormat: "openai",
      baseUrl: "https://example.com",
      encryptedApiKey: null,
      enabled: true,
    });
    const discovered = await upsertDiscoveredModelConfigs(env, {
      providerId: provider.id,
      providerName: provider.name,
      apiFormat: "openai",
      modelNames: ["b-model", "a-model"],
    });
    expect(discovered.map((m) => m.modelName)).toEqual(["a-model", "b-model"]);
    expect(discovered[0].providerName).toBe(provider.name);

    const updated = await updateModelConfig(env, {
      modelId: discovered[0].modelId,
      providerId: provider.id,
      modelName: "renamed",
    });
    expect(updated?.modelName).toBe("renamed");
    const resolved = await getResolvedModelConfig(env, discovered[0].modelId);
    expect(resolved?.providerEnabled).toBe(true);
  });

  it("buckets stats by the requested time zone with explicit zero days", async () => {
    const repo = uniqueName("d1-stats");
    const job = await newJob(repo);
    const startedAt = new Date(Date.now() - 4000).toISOString();
    const finishedAt = new Date().toISOString();
    await queryRows(
      env,
      `UPDATE jobs SET started_at = $2, finished_at = $3, total_input_tokens = 100,
         total_output_tokens = 50, comment_count = 2, overall_confidence_score = 0.5, status = 'done'
       WHERE id = $1`,
      [job.id, startedAt, finishedAt],
    );

    const stats = await getStats(env, 7, "Asia/Kolkata");
    expect(stats.trendBucketDays).toBe(1);
    expect(stats.trend.length).toBeGreaterThanOrEqual(8);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
    }).format(Date.now());
    const point = stats.trend.find((t) => t.day === today);
    expect(point?.jobs).toBeGreaterThanOrEqual(1);
    expect(point?.inputTokens).toBeGreaterThanOrEqual(100);
    expect(stats.trend[0].jobs).toBe(0);
    expect(stats.totals.jobs).toBeGreaterThanOrEqual(1);
    expect(stats.performance.avgDurationMs).toBeGreaterThan(0);
    expect(stats.performance.p95DurationMs).toBeGreaterThan(0);
    expect(stats.topRepos.length).toBeGreaterThan(0);

    // Served from the KV cache: a job added now must not appear until the entry expires.
    await newJob(uniqueName("d1-stats-later"));
    const cached = await getStats(env, 7, "Asia/Kolkata");
    expect(cached.totals.jobs).toBe(stats.totals.jobs);
  });
});
