import type { DbEnv } from "./env";
import type { BulkFileReviewInput } from "@codraoss/core/ports";
import { queryBatch, queryRows, type SqlStatement } from "./client";
import { insertReviewCommentStatements } from "./review-comment-sql";
import { storeAiOutput } from "./blobs";
import { chunkRowsByBytes, inJson, rowField } from "./sql";

function deleteCommentsForFiles(jobId: string, filePaths: string[]): SqlStatement {
  return {
    sql: `
      DELETE FROM review_comments
      WHERE file_review_id IN (
        SELECT id FROM file_reviews WHERE job_id = $1 AND file_path ${inJson("$2")}
      )
    `,
    params: [jobId, filePaths],
  };
}

// `filePaths` must already be filtered to inheritable files with no row yet in the target job.
export async function bulkInheritFileReviews(
  env: DbEnv,
  input: { jobId: string; parentJobId: string; filePaths: string[] },
): Promise<string[]> {
  if (input.filePaths.length === 0) return [];

  // Ids are chosen here so the comment copy can target exactly the rows this insert created: a batch statement cannot read the RETURNING of an earlier one, and a row that lost the ON CONFLICT race keeps its own id and so is left alone.
  const newRows = input.filePaths.map((path) => ({
    id: crypto.randomUUID(),
    path,
  }));

  const [inserted] = await queryBatch(env, [
    {
      sql: `
        INSERT INTO file_reviews (
          id, job_id, file_path, file_status, model_used, diff_line_count, diff_input,
          raw_ai_output_key, input_tokens, output_tokens, duration_ms, verdict,
          file_summary, overall_correctness, confidence_score, error_msg, model_provider,
          -- Carried, not defaulted: an inheriting job reading 0 here approves the PR silently.
          withheld_counts,
          -- Carried too, or every inherited row looks pre-batching.
          batch_size,
          -- An inherited row is the SAME review; hiding that it ran degraded would be a fresh lie.
          degraded
        )
        SELECT ${rowField("id")}, $1, pf.file_path, pf.file_status, pf.model_used, pf.diff_line_count, pf.diff_input,
          pf.raw_ai_output_key, pf.input_tokens, pf.output_tokens, pf.duration_ms, pf.verdict,
          pf.file_summary, pf.overall_correctness, pf.confidence_score, pf.error_msg, pf.model_provider,
          pf.withheld_counts, pf.batch_size, pf.degraded
        FROM json_each($3) u
        JOIN file_reviews pf
          ON pf.job_id = $2 AND pf.file_status = 'done' AND pf.file_path = ${rowField("path")}
        WHERE true
        ON CONFLICT (job_id, file_path) DO NOTHING
        RETURNING file_path
      `,
      params: [input.jobId, input.parentJobId, newRows],
    },
    {
      // Re-attach the comments by path; `posted` resets since an inheriting job hasn't shown it on GitHub.
      sql: `
        INSERT INTO review_comments (
          file_review_id, path, line, position, severity, category, title, body, code_suggestion, confidence_score,
          evidence, fingerprint, anchor_hash, posted, claim_type, context_snippet, disposition, fingerprint_v2,
          source, rule_id, reviewer_model
        )
        SELECT nw.id, rc.path, rc.line, rc.position, rc.severity, rc.category, rc.title, rc.body, rc.code_suggestion, rc.confidence_score,
               rc.evidence, rc.fingerprint, rc.anchor_hash, FALSE, rc.claim_type, rc.context_snippet, NULL, rc.fingerprint_v2,
               -- Carried, or a retried job's rule findings become LLM findings.
               rc.source, rc.rule_id, rc.reviewer_model
        FROM file_reviews nw
        JOIN file_reviews pf ON pf.job_id = $1 AND pf.file_path = nw.file_path
        JOIN review_comments rc ON rc.file_review_id = pf.id
        WHERE nw.id ${inJson("$2")}
        ORDER BY rc.id ASC
      `,
      params: [input.parentJobId, newRows.map((r) => r.id)],
    },
  ]);

  return (inserted as Array<{ file_path: string }>).map((r) => r.file_path);
}

export type { BulkFileReviewInput } from "@codraoss/core/ports";

// One batch: per-file upserts would spend the saved model calls back on DB subrequests. `diff_input` is not written (upstream migration 003 nulled it).
export async function bulkUpsertFileReviews(
  env: DbEnv,
  jobId: string,
  inputs: BulkFileReviewInput[],
): Promise<void> {
  if (inputs.length === 0) return;

  // A bin's files share one response, so it is written once.
  const keyByOutput = new Map<string, string | null>();
  for (const output of new Set(inputs.map((i) => i.rawAiOutput))) {
    if (output) keyByOutput.set(output, await storeAiOutput(env, output));
  }

  const rows = inputs.map((i) => ({
    file_path: i.filePath,
    file_status: i.fileStatus,
    model_used: i.modelUsed,
    diff_line_count: i.diffLineCount,
    raw_ai_output_key: i.rawAiOutput
      ? (keyByOutput.get(i.rawAiOutput) ?? null)
      : null,
    input_tokens: i.inputTokens,
    output_tokens: i.outputTokens,
    duration_ms: i.durationMs,
    verdict: i.verdict,
    file_summary: i.fileSummary,
    overall_correctness: i.overallCorrectness ?? null,
    confidence_score: i.confidenceScore ?? null,
    error_msg: i.errorMessage,
    model_provider: i.modelProvider ?? null,
    withheld_counts: i.withheldCounts ? JSON.stringify(i.withheldCounts) : null,
    degraded: i.degraded ?? null,
    batch_size: i.batchSize,
  }));

  const upserts: SqlStatement[] = chunkRowsByBytes(rows).map((chunk) => ({
    sql: `
      INSERT INTO file_reviews (
        job_id, file_path, file_status, model_used, diff_line_count, diff_input,
        raw_ai_output_key, input_tokens, output_tokens, duration_ms, verdict,
        file_summary, overall_correctness, confidence_score, error_msg, model_provider,
        withheld_counts, degraded, batch_size
      )
      SELECT $1, ${rowField("file_path")}, ${rowField("file_status")}, ${rowField("model_used")}, ${rowField("diff_line_count")}, NULL,
        ${rowField("raw_ai_output_key")}, ${rowField("input_tokens")}, ${rowField("output_tokens")}, ${rowField("duration_ms")}, ${rowField("verdict")},
        ${rowField("file_summary")}, ${rowField("overall_correctness")}, ${rowField("confidence_score")}, ${rowField("error_msg")}, ${rowField("model_provider")},
        ${rowField("withheld_counts")}, ${rowField("degraded")}, ${rowField("batch_size")}
      FROM json_each($2) u
      WHERE true
      ON CONFLICT (job_id, file_path) DO UPDATE SET
        file_status = EXCLUDED.file_status,
        model_used = EXCLUDED.model_used,
        diff_line_count = EXCLUDED.diff_line_count,
        diff_input = EXCLUDED.diff_input,
        raw_ai_output_key = EXCLUDED.raw_ai_output_key,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        duration_ms = EXCLUDED.duration_ms,
        verdict = EXCLUDED.verdict,
        file_summary = EXCLUDED.file_summary,
        overall_correctness = EXCLUDED.overall_correctness,
        confidence_score = EXCLUDED.confidence_score,
        error_msg = EXCLUDED.error_msg,
        model_provider = EXCLUDED.model_provider,
        withheld_counts = EXCLUDED.withheld_counts,
        degraded = EXCLUDED.degraded,
        batch_size = EXCLUDED.batch_size,
        -- A terminal review supersedes any in-flight async submission, matching upsertFileReview.
        async_request_id = NULL,
        async_model = NULL,
        transient_error_count = 0
    `,
    params: [jobId, chunk],
  }));

  await queryBatch(env, [
    ...upserts,
    deleteCommentsForFiles(
      jobId,
      inputs.map((i) => i.filePath),
    ),
    ...insertReviewCommentStatements(
      jobId,
      inputs.map((i) => ({ filePath: i.filePath, comments: i.parsedComments })),
    ),
  ]);
}

// One batch, returning each file's new attempt count so the caller can fail exhausted ones.
export async function bulkRecordRetryableFileReviewFailures(
  env: DbEnv,
  jobId: string,
  inputs: Array<{
    filePath: string;
    modelUsed: string;
    diffLineCount: number;
    errorMessage: string;
  }>,
  // False when the model chain advanced: the retry resumes at the next model, so this deferral is
  // progress rather than a repeated outage and must not spend one of the three allowed attempts.
  // Bin-wide because a bin shares one chain walk. See model-chain-progress.ts.
  opts: { countsAsAttempt?: boolean } = {},
): Promise<Array<{ filePath: string; transientErrorCount: number }>> {
  if (inputs.length === 0) return [];

  const attempts = opts.countsAsAttempt === false ? 0 : 1;
  const rows = inputs.map((i) => ({
    file_path: i.filePath,
    model_used: i.modelUsed,
    diff_line_count: i.diffLineCount,
    error_msg: i.errorMessage,
  }));

  const [upserted] = await queryBatch(env, [
    {
      sql: `
        INSERT INTO file_reviews (
          job_id, file_path, file_status, model_used, diff_line_count, diff_input, error_msg,
          duration_ms, transient_error_count
        )
        SELECT $1, ${rowField("file_path")}, 'failed', ${rowField("model_used")}, ${rowField("diff_line_count")}, NULL, ${rowField("error_msg")}, 0, $3
        FROM json_each($2) u
        WHERE true
        ON CONFLICT (job_id, file_path) DO UPDATE SET
          file_status = 'failed',
          model_used = EXCLUDED.model_used,
          diff_line_count = EXCLUDED.diff_line_count,
          -- Cleared to parity with recordRetryableFileReviewFailure.
          raw_ai_output_key = NULL,
          input_tokens = NULL,
          output_tokens = NULL,
          verdict = NULL,
          file_summary = NULL,
          overall_correctness = NULL,
          confidence_score = NULL,
          -- Also cleared, unlike the single-file version: gate-pipeline sums this unfiltered.
          withheld_counts = NULL,
          degraded = NULL,
          error_msg = EXCLUDED.error_msg,
          transient_error_count = file_reviews.transient_error_count + $3
        RETURNING file_path, transient_error_count
      `,
      params: [jobId, rows, attempts],
    },
    // Stale comments would let finalize post findings from a review since marked failed.
    deleteCommentsForFiles(
      jobId,
      inputs.map((i) => i.filePath),
    ),
  ]);

  return (
    upserted as Array<{ file_path: string; transient_error_count: number }>
  ).map((r) => ({
    filePath: r.file_path,
    transientErrorCount: Number(r.transient_error_count),
  }));
}

// One INSERT, so finalize's backfill cannot blow the subrequest budget right before posting; `ON CONFLICT DO NOTHING` so it never clobbers a real review.
export async function bulkMarkFilesFailed(
  env: DbEnv,
  jobId: string,
  files: Array<{ filePath: string; diffLineCount: number }>,
  opts: { modelUsed: string; errorMessage: string },
): Promise<void> {
  if (files.length === 0) return;
  await queryRows(
    env,
    `
      INSERT INTO file_reviews (job_id, file_path, file_status, model_used, diff_line_count, diff_input, error_msg, duration_ms)
      SELECT $1, ${rowField("file_path")}, 'failed', $2, ${rowField("diff_line_count")}, NULL, $3, 0
      FROM json_each($4) u
      WHERE true
      ON CONFLICT (job_id, file_path) DO NOTHING
    `,
    [
      jobId,
      opts.modelUsed,
      opts.errorMessage,
      files.map((f) => ({
        file_path: f.filePath,
        diff_line_count: f.diffLineCount,
      })),
    ],
  );
}
