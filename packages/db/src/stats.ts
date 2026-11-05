import type { DbEnv } from "./env";
import { isSupportedTimeZone } from "@codraoss/schema/timezone";
import { queryRows } from "./client";
import {
  statsSchema,
  jobStatuses,
  reviewTriggers,
  reviewSeverities,
  reviewCategories,
} from "@codraoss/schema";
import { getModelUsageStats } from "./file-reviews";
import { daysAgo } from "./sql";

// Guard the zone before it reaches SQL, so an unknown name can't error the query.
const jobStatusSet = new Set<string>(jobStatuses);
const reviewTriggerSet = new Set<string>(reviewTriggers);
const reviewSeveritySet = new Set<string>(reviewSeverities);
const reviewCategorySet = new Set<string>(reviewCategories);

/**
 * Days rolled up into a single trend point. A 90-day range plotted daily is unreadable (and the
 * x-axis drops most labels anyway), so wider ranges are combined into multi-day buckets, keeping
 * every range at roughly a dozen-and-a-half points.
 */
export function trendBucketDays(days: number) {
  if (days <= 14) return 1;
  if (days <= 45) return 3;
  if (days <= 120) return 7;
  return 14;
}

// Every current UTC offset is a multiple of 15 minutes, so these buckets never straddle a local midnight
// and any zone's days can be rebuilt from them. That caps a year at about 35,000 rows however many jobs ran.
const BUCKET_15M = `substr(created_at, 1, 14) || printf('%02d', CAST(substr(created_at, 15, 2) AS INTEGER) / 15 * 15)`;

const STATS_CACHE_TTL_SECONDS = 300;

function zonedDayFormatter(zone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function addDays(day: string, days: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

type TrendBucketRow = {
  bucket: string;
  jobs: number;
  input_tokens: number;
  output_tokens: number;
  comments: number;
};

// Days are generated first, so quiet stretches come back as explicit zeros instead of gaps -- the chart
// then shows a continuous, evenly spaced series for every range. Zones are applied here because SQLite has none.
function buildTrend(
  rows: TrendBucketRow[],
  days: number,
  bucketDays: number,
  zone: string,
) {
  const formatter = zonedDayFormatter(zone);
  const now = Date.now();
  const startDay = formatter.format(now - days * 86_400_000);
  const endDay = formatter.format(now);
  const buckets: Array<
    Omit<TrendBucketRow, "bucket"> & { day: string; end_day: string }
  > = [];
  for (let day = startDay; day <= endDay; day = addDays(day, bucketDays)) {
    const last = addDays(day, bucketDays - 1);
    buckets.push({
      day,
      end_day: last < endDay ? last : endDay,
      jobs: 0,
      input_tokens: 0,
      output_tokens: 0,
      comments: 0,
    });
  }
  const startMs = new Date(`${startDay}T00:00:00Z`).getTime();
  for (const row of rows) {
    const day = formatter.format(new Date(`${row.bucket}:00Z`));
    const offsetDays = Math.round(
      (new Date(`${day}T00:00:00Z`).getTime() - startMs) / 86_400_000,
    );
    const bucket = buckets[Math.floor(offsetDays / bucketDays)];
    if (!bucket) continue;
    bucket.jobs += row.jobs;
    bucket.input_tokens += row.input_tokens;
    bucket.output_tokens += row.output_tokens;
    bucket.comments += row.comments;
  }
  return buckets;
}

const DURATION_MS = `(julianday(finished_at) - julianday(started_at)) * 86400000`;

// Exact p95 by linear interpolation, matching the PERCENTILE_CONT this replaces, without loading every duration.
async function getPerformance(env: DbEnv, days: number) {
  const window = `finished_at IS NOT NULL AND started_at IS NOT NULL AND created_at >= ${daysAgo("$1")}`;
  const [summary] = await queryRows<{
    finished: number;
    avg_duration_ms: number | null;
    avg_confidence: number | null;
  }>(
    env,
    `
      SELECT COUNT(*) AS finished,
             AVG(${DURATION_MS}) AS avg_duration_ms,
             AVG(overall_confidence_score) AS avg_confidence
      FROM jobs
      WHERE ${window}
    `,
    [days],
  );
  if (!summary?.finished) {
    return {
      avg_duration_ms: null,
      p95_duration_ms: null,
      avg_confidence: null,
    };
  }
  const position = (summary.finished - 1) * 0.95;
  const lower = Math.floor(position);
  const neighbours = await queryRows<{ duration_ms: number }>(
    env,
    `
      SELECT ${DURATION_MS} AS duration_ms
      FROM jobs
      WHERE ${window}
      ORDER BY duration_ms ASC
      LIMIT 2 OFFSET $2
    `,
    [days, lower],
  );
  const low = neighbours[0]?.duration_ms ?? null;
  const high = neighbours[1]?.duration_ms ?? low;
  return {
    avg_duration_ms: summary.avg_duration_ms,
    p95_duration_ms:
      low === null || high === null
        ? null
        : low + (high - low) * (position - lower),
    avg_confidence: summary.avg_confidence,
  };
}

export async function getStats(env: DbEnv, days = 30, timeZone = "UTC") {
  const parsedDays = Number(days);
  const safeDays = Number.isFinite(parsedDays) ? Math.trunc(parsedDays) : 30;
  const clampedDays = Math.min(Math.max(safeDays, 1), 365);
  const zone = isSupportedTimeZone(timeZone) ? timeZone : "UTC";
  const bucketDays = trendBucketDays(clampedDays);
  const cacheKey = `stats:v1:${clampedDays}:${zone}`;
  try {
    const cached = await env.APP_KV.get(cacheKey);
    if (cached) return statsSchema.parse(JSON.parse(cached));
  } catch (error) {
    console.warn("Ignoring unreadable stats cache entry", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const [
    trendBuckets,
    performanceRow,
    verdictRows,
    topRepos,
    modelRows,
    statusRows,
    triggerRows,
    severityRows,
    categoryRows,
  ] = await Promise.all([
    queryRows<TrendBucketRow>(
      env,
      `
        SELECT ${BUCKET_15M} AS bucket,
               COUNT(*) AS jobs,
               COALESCE(SUM(total_input_tokens), 0) AS input_tokens,
               COALESCE(SUM(total_output_tokens), 0) AS output_tokens,
               COALESCE(SUM(comment_count), 0) AS comments
        FROM jobs
        WHERE created_at >= ${daysAgo("$1")}
        GROUP BY bucket
      `,
      [clampedDays],
    ),
    getPerformance(env, clampedDays),
    queryRows<{ verdict: "approve" | "comment" | null; count: number }>(
      env,
      `
        SELECT verdict, COUNT(*) AS count
        FROM jobs
        GROUP BY verdict
        ORDER BY count DESC
      `,
    ),
    queryRows<{ owner: string; repo: string; jobs: number }>(
      env,
      `
        SELECT r.owner, r.repo, COUNT(*) AS jobs
        FROM jobs j
        JOIN repositories r ON j.repository_id = r.id
        WHERE j.created_at >= ${daysAgo("$1")}
        GROUP BY r.owner, r.repo
        ORDER BY jobs DESC, r.owner ASC, r.repo ASC
        LIMIT 10
      `,
      [clampedDays],
    ),
    getModelUsageStats(env, clampedDays),
    queryRows<{ status: string; count: number }>(
      env,
      `
        SELECT status, COUNT(*) AS count
        FROM jobs
        WHERE created_at >= ${daysAgo("$1")}
        GROUP BY status
        ORDER BY count DESC
      `,
      [clampedDays],
    ),
    queryRows<{ trigger: string; count: number }>(
      env,
      `
        SELECT trigger, COUNT(*) AS count
        FROM jobs
        WHERE created_at >= ${daysAgo("$1")}
        GROUP BY trigger
        ORDER BY count DESC
      `,
      [clampedDays],
    ),
    queryRows<{ severity: string; count: number }>(
      env,
      `
        SELECT rc.severity, COUNT(*) AS count
        FROM review_comments rc
        JOIN file_reviews fr ON fr.id = rc.file_review_id
        WHERE fr.created_at >= ${daysAgo("$1")}
        GROUP BY rc.severity
        ORDER BY count DESC
      `,
      [clampedDays],
    ),
    queryRows<{ category: string; count: number }>(
      env,
      `
        SELECT rc.category, COUNT(*) AS count
        FROM review_comments rc
        JOIN file_reviews fr ON fr.id = rc.file_review_id
        WHERE fr.created_at >= ${daysAgo("$1")}
        GROUP BY rc.category
        ORDER BY count DESC
      `,
      [clampedDays],
    ),
  ]);

  const dailyRows = buildTrend(trendBuckets, clampedDays, bucketDays, zone);
  const sum = (field: "jobs" | "input_tokens" | "output_tokens" | "comments") =>
    trendBuckets.reduce((total, row) => total + row[field], 0);

  const stats = statsSchema.parse({
    totals: {
      jobs: sum("jobs"),
      inputTokens: sum("input_tokens"),
      outputTokens: sum("output_tokens"),
      comments: sum("comments"),
    },
    trend: dailyRows.map((row) => ({
      day: row.day,
      endDay: row.end_day,
      jobs: row.jobs,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      comments: row.comments,
    })),
    trendBucketDays: bucketDays,
    verdicts: verdictRows.map((row) => ({
      verdict: row.verdict,
      count: row.count,
    })),
    models: modelRows.map((row) => ({
      modelUsed: row.model_used,
      provider: row.model_provider ?? undefined,
      calls: row.calls,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
    })),
    topRepos: topRepos.map((row) => ({
      owner: row.owner,
      repo: row.repo,
      jobs: row.jobs,
    })),
    // Drop rows whose enum-typed column holds an unexpected value (e.g. legacy rows with no DB CHECK constraint) -- keeping them would fail statsSchema.parse and 500 the endpoint.
    statuses: statusRows.flatMap((row) =>
      jobStatusSet.has(row.status)
        ? [
            {
              status: row.status as (typeof jobStatuses)[number],
              count: row.count,
            },
          ]
        : [],
    ),
    triggers: triggerRows.flatMap((row) =>
      reviewTriggerSet.has(row.trigger)
        ? [
            {
              trigger: row.trigger as (typeof reviewTriggers)[number],
              count: row.count,
            },
          ]
        : [],
    ),
    severities: severityRows.flatMap((row) =>
      reviewSeveritySet.has(row.severity)
        ? [
            {
              severity: row.severity as (typeof reviewSeverities)[number],
              count: row.count,
            },
          ]
        : [],
    ),
    categories: categoryRows.flatMap((row) =>
      reviewCategorySet.has(row.category)
        ? [
            {
              category: row.category as (typeof reviewCategories)[number],
              count: row.count,
            },
          ]
        : [],
    ),
    performance: {
      avgDurationMs:
        performanceRow.avg_duration_ms != null
          ? Math.round(performanceRow.avg_duration_ms)
          : null,
      p95DurationMs:
        performanceRow.p95_duration_ms != null
          ? Math.round(performanceRow.p95_duration_ms)
          : null,
      avgConfidence: performanceRow.avg_confidence,
    },
  });

  try {
    await env.APP_KV.put(cacheKey, JSON.stringify(stats), {
      expirationTtl: STATS_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    console.warn("Failed to cache stats", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return stats;
}
