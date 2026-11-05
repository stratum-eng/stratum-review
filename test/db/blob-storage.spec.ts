import { describe, expect, it } from "vitest";
import {
  bulkUpsertFileReviews,
  getAiOutputForJob,
  getFileReviewsForJobs,
  upsertFileReview,
  type BulkFileReviewInput,
} from "@codraoss/db/file-reviews";
import { insertJob } from "@codraoss/db/jobs";
import {
  getWebhookDelivery,
  recordWebhookDelivery,
} from "@codraoss/db/webhook-deliveries";
import { createTestEnv, sha, uniqueName } from "../helpers";

const env = createTestEnv();

async function newJob() {
  return insertJob(env, {
    installationId: "123",
    owner: "blob-owner",
    repo: uniqueName("blob"),
    prNumber: 1,
    prTitle: null,
    prAuthor: null,
    commitSha: sha("a"),
    baseSha: sha("b"),
    trigger: "auto",
    headRef: null,
    baseRef: null,
  });
}

function fileReview(path: string) {
  return {
    filePath: path,
    fileStatus: "done" as const,
    modelUsed: "@cf/test",
    diffLineCount: 1,
    diffInput: null,
    rawAiOutput: null,
    parsedComments: [],
    inputTokens: 10,
    outputTokens: 5,
    durationMs: 1,
    verdict: "comment" as const,
    fileSummary: null,
    errorMessage: null,
  };
}

describe("R2 blob storage", () => {
  it("stores a large AI response in R2 whole and serves it only for its own job", async () => {
    const job = await newJob();
    const other = await newJob();
    const output = "x".repeat(3_000_000);
    await upsertFileReview(env, job.id, {
      ...fileReview("a.ts"),
      rawAiOutput: output,
    });
    const [review] = await getFileReviewsForJobs(env, [job.id]);
    expect(review.raw_ai_output).toBeNull();
    const key = review.raw_ai_output_key!;
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    expect(await getAiOutputForJob(env, job.id, key)).toBe(output);
    expect(await getAiOutputForJob(env, other.id, key)).toBeNull();
  });

  it("stores a shared batch response once, and a failed R2 write does not fail the review", async () => {
    const job = await newJob();
    const shared = { rawAiOutput: "shared response", batchSize: 2 };
    const base = {
      fileStatus: "done",
      modelUsed: "@cf/test",
      diffLineCount: 1,
      parsedComments: [],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: "approve",
      fileSummary: null,
      errorMessage: null,
    };
    const puts: string[] = [];
    const counting = {
      ...env,
      BLOBS: {
        get: (key: string) => env.BLOBS.get(key),
        put: (key: string, value: string) => {
          puts.push(key);
          return env.BLOBS.put(key, value);
        },
      },
    } as unknown as typeof env;
    await bulkUpsertFileReviews(counting, job.id, [
      { ...base, ...shared, filePath: "a.ts" },
      { ...base, ...shared, filePath: "b.ts" },
    ] as BulkFileReviewInput[]);
    expect(puts).toHaveLength(1);
    const reviews = await getFileReviewsForJobs(env, [job.id]);
    expect(new Set(reviews.map((r) => r.raw_ai_output_key)).size).toBe(1);

    const failing = {
      ...env,
      BLOBS: {
        get: (key: string) => env.BLOBS.get(key),
        put: () => Promise.reject(new Error("R2 down")),
      },
    } as unknown as typeof env;
    await upsertFileReview(failing, job.id, {
      ...fileReview("c.ts"),
      rawAiOutput: "unsaved",
    });
    const after = await getFileReviewsForJobs(env, [job.id]);
    const failed = after.find((r) => r.file_path === "c.ts");
    expect(failed?.file_status).toBe("done");
    expect(failed?.raw_ai_output_key).toBeNull();
  });

  it("keeps an oversized webhook payload in R2 and reads it back", async () => {
    const deliveryId = uniqueName("delivery");
    const payload = { body: "y".repeat(1_500_000) };
    await recordWebhookDelivery(env, {
      deliveryId,
      eventName: "pull_request",
      owner: null,
      repo: null,
      payload,
    });
    const delivery = await getWebhookDelivery(env, deliveryId);
    expect(delivery?.payload).toEqual(payload);
  });
});
