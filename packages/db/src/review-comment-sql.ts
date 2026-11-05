import type { ParsedReviewComment } from "@codraoss/schema";
import { chunkRowsByBytes, rowField } from "./sql";
import type { SqlStatement } from "./client";

// Shared review_comments field list. Update bulkInheritFileReviews if changed.
const REVIEW_COMMENT_INSERT_COLUMNS = [
  "path",
  "line",
  "position",
  "severity",
  "category",
  "title",
  "body",
  "code_suggestion",
  "confidence_score",
  "evidence",
  "fingerprint",
  "anchor_hash",
  "claim_type",
  "context_snippet",
  "disposition",
  "fingerprint_v2",
  "source",
  "rule_id",
  "reviewer_model",
] as const;

function commentRow(filePath: string, c: ParsedReviewComment) {
  return {
    review_file_path: filePath,
    path: c.path,
    line: c.line ?? null,
    position: c.position ?? null,
    severity: c.severity,
    category: c.category,
    title: c.title,
    body: c.body,
    code_suggestion: c.codeSuggestion ?? null,
    confidence_score: c.confidenceScore ?? null,
    evidence: c.evidence ?? null,
    fingerprint: c.fingerprint ?? null,
    anchor_hash: c.anchorHash ?? null,
    claim_type: c.claimType ?? null,
    context_snippet: c.contextSnippet ?? null,
    disposition: c.disposition ?? null,
    fingerprint_v2: c.fingerprintV2 ?? null,
    source: c.source ?? "llm",
    rule_id: c.ruleId ?? null,
    reviewer_model: c.reviewerModel ?? null,
  };
}

// Attaches comments to their file_reviews rows by (job, path), since a batch statement cannot read the ids an earlier upsert returned.
export function insertReviewCommentStatements(
  jobId: string,
  files: Array<{ filePath: string; comments: ParsedReviewComment[] }>,
): SqlStatement[] {
  const rows = files.flatMap((f) =>
    f.comments.map((c) => commentRow(f.filePath, c)),
  );
  return chunkRowsByBytes(rows).map((chunk) => ({
    sql: `
      INSERT INTO review_comments (file_review_id, ${REVIEW_COMMENT_INSERT_COLUMNS.join(", ")})
      SELECT
        (SELECT fr.id FROM file_reviews fr WHERE fr.job_id = $1 AND fr.file_path = ${rowField("review_file_path")}),
        ${REVIEW_COMMENT_INSERT_COLUMNS.map(rowField).join(", ")}
      FROM json_each($2) u
      ORDER BY u.key
    `,
    params: [jobId, chunk],
  }));
}

// The json_object body used to project comments back out, keyed to the `rc` alias.
// `extraFields` is appended verbatim for projections that need more -- the job-detail query adds a
// correlated `humanLabel` lookup, which the file-review query has no use for.
export function reviewCommentJsonObject(extraFields = "") {
  const fields = [
    `'path', rc.path`,
    `'line', rc.line`,
    `'position', rc.position`,
    `'severity', rc.severity`,
    `'category', rc.category`,
    `'title', rc.title`,
    `'body', rc.body`,
    `'codeSuggestion', rc.code_suggestion`,
    `'confidenceScore', rc.confidence_score`,
    `'evidence', rc.evidence`,
    `'fingerprint', rc.fingerprint`,
    `'fingerprintV2', rc.fingerprint_v2`,
    `'anchorHash', rc.anchor_hash`,
    // SQLite has no boolean type; without this the schema would see 0/1.
    `'posted', json(CASE WHEN rc.posted THEN 'true' ELSE 'false' END)`,
    `'claimType', rc.claim_type`,
    `'contextSnippet', rc.context_snippet`,
    `'disposition', rc.disposition`,
    `'verifyReason', rc.verify_reason`,
    `'source', rc.source`,
    `'ruleId', rc.rule_id`,
    `'reviewerModel', rc.reviewer_model`,
  ].join(",\n        ");

  return `json_object(\n        ${fields}${extraFields ? `,\n        ${extraFields}` : ""}\n      )`;
}

// The full aggregate. Ordered through a subquery because aggregate ORDER BY needs a newer SQLite; json() keeps each element from being re-escaped as a string.
export function reviewCommentsAggregate(extraFields = "") {
  return `(
        SELECT json_group_array(json(comment)) FROM (
          SELECT ${reviewCommentJsonObject(extraFields)} AS comment
          FROM review_comments rc WHERE rc.file_review_id = fr.id
          ORDER BY rc.id ASC
        )
      )`;
}
