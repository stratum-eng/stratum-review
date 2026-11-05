import type { DbEnv } from "./env";
import { queryRows } from "./client";
import { inJson } from "./sql";
import type { ClaimType } from "@codraoss/schema";

// Reads over findings a human has already judged: report only over the LABELLED subset, always with n. The absence of a label is not a signal.

export type RejectedExemplar = {
  title: string;
  body: string;
  claim_type: ClaimType | null;
  context_snippet: string | null;
  path: string;
};

// Findings a human rejected, injected as negative few-shot exemplars: retrieval measurably improves small models here (F1 36.35 -> 74.05 at 20 shots). Claim-type-keyed since there's no vector store.
export async function getRejectedExemplars(
  env: DbEnv,
  input: {
    repositoryId: number;
    claimTypes?: readonly ClaimType[];
    limit?: number;
  },
): Promise<RejectedExemplar[]> {
  const limit = Math.min(input.limit ?? 5, 20);

  return queryRows<RejectedExemplar>(
    env,
    `
      -- With a bare MAX(), SQLite takes the other columns from the row holding the maximum: the newest per fingerprint.
      SELECT rc.title, rc.body, rc.claim_type, rc.context_snippet, rc.path, MAX(rc.id) AS newest_id
      FROM comment_feedback cf
      JOIN review_comments rc
        ON rc.fingerprint = cf.fingerprint
        -- OR-matched, same as suppression: v1 dies the moment the model rewords a title.
        OR (rc.fingerprint_v2 IS NOT NULL AND rc.fingerprint_v2 = cf.fingerprint_v2)
      WHERE cf.repository_id = $1
        AND cf.outcome IN ('deleted', 'marked_wrong')
        AND rc.title IS NOT NULL
        AND ($2 IS NULL OR rc.claim_type ${inJson("$2")})
      GROUP BY rc.fingerprint
      ORDER BY rc.fingerprint
      LIMIT $3
    `,
    [
      input.repositoryId,
      input.claimTypes?.length ? [...input.claimTypes] : null,
      limit,
    ],
  );
}

// Exemplars are repository-scoped -- what one team rejects isn't evidence about another.
export async function getRepositoryIdForJob(
  env: DbEnv,
  jobId: string,
): Promise<number | null> {
  const [row] = await queryRows<{ repository_id: number }>(
    env,
    `SELECT repository_id FROM jobs WHERE id = $1`,
    [jobId],
  );
  return row?.repository_id ?? null;
}
