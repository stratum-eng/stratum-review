import type { DbEnv } from "./env";
import { queryRows } from "./client";
import type { JobRow } from "./jobs-mapping";
import { markSystemActive } from "./jobs-activity";
import { NOW, mapSteps, stepField } from "./sql";

export async function updateJobCheckRun(
  env: DbEnv,
  jobId: string,
  checkRunId: number,
) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET check_run_id = $2
      WHERE id = $1
    `,
    [jobId, checkRunId],
  );
}

export async function completeJob(
  env: DbEnv,
  jobId: string,
  input: {
    verdict: "approve" | "comment";
    fileCount: number;
    commentCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    summaryMarkdown: string;
    reviewId: number | null;
    summaryModel: string | null;
    overallConfidenceScore?: number | null;
    errorMessage?: string | null;
  },
) {
  const now = new Date().toISOString();
  await queryRows(
    env,
    `
      UPDATE jobs
      SET status = 'done',
          finished_at = ${NOW},
          -- check_run_completed_at is intentionally NOT set here -- only once markJobCheckRunCompleted confirms GitHub's check run actually updated; otherwise completeTerminalCheckRuns reconciles it later.
          lease_owner = NULL,
          lease_expires_at = NULL,
          verdict = $2,
          file_count = $3,
          comment_count = $4,
          total_input_tokens = $5,
          total_output_tokens = $6,
          summary_markdown = $7,
          review_id = $8,
          summary_model = $9,
          overall_confidence_score = $10,
          error_msg = $11,
          steps = CASE
            WHEN EXISTS (SELECT 1 FROM json_each(COALESCE(steps, '[]')) s WHERE ${stepField("name")} = 'Completing')
            THEN ${mapSteps(
              "COALESCE(steps, '[]')",
              `${stepField("name")} = 'Completing'`,
              `'$.status', 'done', '$.finishedAt', $12, '$.error', NULL`,
            )}
            ELSE json_insert(
              COALESCE(steps, '[]'),
              '$[#]',
              json_object(
                'name', 'Completing',
                'status', 'done',
                'startedAt', $12,
                'finishedAt', $12,
                'error', NULL
              )
            )
          END
      WHERE id = $1
    `,
    [
      jobId,
      input.verdict,
      input.fileCount,
      input.commentCount,
      input.totalInputTokens,
      input.totalOutputTokens,
      input.summaryMarkdown,
      input.reviewId,
      input.summaryModel,
      input.overallConfidenceScore ?? null,
      input.errorMessage ?? null,
      now,
    ],
  );
}

export async function failJob(
  env: DbEnv,
  jobId: string,
  errorMessage: string,
) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET status = 'failed',
          finished_at = ${NOW},
          lease_owner = NULL,
          lease_expires_at = NULL,
          error_msg = $2,
          steps = CASE
            WHEN steps IS NOT NULL THEN ${mapSteps(
              "steps",
              `${stepField("status")} = 'running'`,
              `'$.status', 'failed', '$.finishedAt', ${NOW}, '$.error', $2`,
            )}
            ELSE steps
          END
      WHERE id = $1
    `,
    [jobId, errorMessage],
  );
  await markSystemActive(env);
}

// Clears lease. Returns false if terminal (caller must terminate Workflow).
export async function cancelJob(
  env: DbEnv,
  jobId: string,
): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(
    env,
    `
      UPDATE jobs
      SET status = 'cancelled',
          finished_at = ${NOW},
          lease_owner = NULL,
          lease_expires_at = NULL,
          error_msg = COALESCE(error_msg, 'Stopped by user.'),
          steps = CASE
            WHEN steps IS NOT NULL THEN ${mapSteps(
              "steps",
              `${stepField("status")} = 'running'`,
              `'$.status', 'failed', '$.finishedAt', ${NOW}, '$.error', 'Stopped by user.'`,
            )}
            ELSE steps
          END
      WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING id
    `,
    [jobId],
  );
  // Keep the maintenance flag set so the cron completes the GitHub check run for the cancelled job.
  if (rows.length > 0) await markSystemActive(env);
  return rows.length > 0;
}

// review_comments cascade; child retries have retry_of_job_id nulled.
export async function deleteJob(env: DbEnv, jobId: string): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(
    env,
    `DELETE FROM jobs WHERE id = $1 RETURNING id`,
    [jobId],
  );
  return rows.length > 0;
}

export async function markJobCheckRunCompleted(env: DbEnv, jobId: string) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET check_run_completed_at = ${NOW}
      WHERE id = $1
    `,
    [jobId],
  );
}

export async function updateJobFileCount(
  env: DbEnv,
  jobId: string,
  fileCount: number,
) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET file_count = $2
      WHERE id = $1
    `,
    [jobId, fileCount],
  );
}

export async function completePreparationStep(
  env: DbEnv,
  jobId: string,
  fileCount: number,
) {
  const now = new Date().toISOString();
  await queryRows(
    env,
    `
      UPDATE jobs
      SET file_count = $2,
          steps = ${mapSteps(
            "steps",
            `${stepField("name")} = 'Preparation'`,
            `'$.status', 'done', '$.finishedAt', $3`,
          )}
      WHERE id = $1
    `,
    [jobId, fileCount, now],
  );
}

export async function updateJobStep(
  env: DbEnv,
  jobId: string,
  stepName: string,
  update: {
    status: "pending" | "running" | "done" | "failed";
    startedAt?: string | null;
    finishedAt?: string | null;
    error?: string | null;
  },
) {
  const now = new Date().toISOString();
  const startedAt =
    update.status === "running" ? now : (update.startedAt ?? null);
  const finishedAt =
    update.status === "done" || update.status === "failed"
      ? now
      : (update.finishedAt ?? null);
  const error = update.error ?? null;

  await queryRows(
    env,
    `
      UPDATE jobs
      SET heartbeat_at = ${NOW},
          steps = CASE
        WHEN EXISTS (SELECT 1 FROM json_each(COALESCE(steps, '[]')) s WHERE ${stepField("name")} = $2)
        THEN ${mapSteps(
          "COALESCE(steps, '[]')",
          `${stepField("name")} = $2`,
          // Preserve the FIRST start time: a phase re-enters 'running' once per hibernated chunk, so seed it only when absent to keep the true multi-minute wall-clock.
          // 'running' clears any stale finish; otherwise keep the FIRST finish so re-marking 'done' doesn't inflate the displayed duration.
          `'$.status', $3,
           '$.startedAt', COALESCE(${stepField("startedAt")}, $4),
           '$.finishedAt', CASE WHEN $3 = 'running' THEN NULL ELSE COALESCE(${stepField("finishedAt")}, $5) END,
           '$.error', COALESCE($6, ${stepField("error")})`,
        )}
        ELSE json_insert(
          COALESCE(steps, '[]'),
          '$[#]',
          json_object(
            'name', $2,
            'status', $3,
            'startedAt', $4,
            'finishedAt', $5,
            'error', $6
          )
        )
      END
      WHERE id = $1
    `,
    [jobId, stepName, update.status, startedAt, finishedAt, error],
  );
}

export async function getTerminalJobsNeedingCheckRunCompletion(
  env: DbEnv,
  limit = 25,
) {
  return queryRows<JobRow>(
    env,
    `
      SELECT j.*, r.owner, r.repo, r.installation_id
      FROM jobs j
      JOIN repositories r ON j.repository_id = r.id
      WHERE j.status IN ('done', 'failed', 'superseded', 'cancelled')
        AND j.check_run_id IS NOT NULL
        AND j.check_run_completed_at IS NULL
      ORDER BY COALESCE(j.finished_at, j.started_at, j.created_at) ASC
      LIMIT $1
    `,
    [limit],
  );
}

export async function supersedeOlderJobs(
  env: DbEnv,
  input: {
    installationId: string;
    owner: string;
    repo: string;
    prNumber: number;
    newJobId: string;
  },
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    env,
    `
      UPDATE jobs
      SET status = 'superseded',
          finished_at = ${NOW},
          lease_owner = NULL,
          lease_expires_at = NULL,
          error_msg = 'Superseded by a newer commit or job.'
      WHERE repository_id IN (
          SELECT r.id FROM repositories r
          WHERE r.installation_id = $1 AND r.owner = $2 AND r.repo = $3
        )
        AND pr_number = $4
        AND id != $5
        AND status IN ('queued', 'running')
      RETURNING id
    `,
    [
      input.installationId,
      input.owner,
      input.repo,
      input.prNumber,
      input.newJobId,
    ],
  );

  return rows.length;
}
