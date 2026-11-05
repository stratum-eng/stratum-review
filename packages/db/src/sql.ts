// SQL fragments for what Postgres had built in. ISO-8601 UTC with milliseconds sorts correctly as text.
const ISO_FORMAT = "'%Y-%m-%dT%H:%M:%fZ'";

export const NOW = `strftime(${ISO_FORMAT}, 'now')`;

// `seconds` is a SQL expression, negative to go backwards.
export function nowPlusSeconds(seconds: string) {
  return `strftime(${ISO_FORMAT}, 'now', (${seconds}) || ' seconds')`;
}

export function daysAgo(days: string) {
  return `strftime(${ISO_FORMAT}, 'now', '-' || (${days}) || ' days')`;
}

// Membership in a JSON array bound as a parameter: `x ${inJson("$1")}`.
export function inJson(param: string) {
  return `IN (SELECT value FROM json_each(${param}))`;
}

/**
 * Rewrites the `steps` JSON array, keeping its order. `updates` are json_set path/value arguments
 * applied to each step matching `where`; both can read the current step through `s.value`.
 */
export function mapSteps(column: string, where: string, updates: string) {
  return `(
    SELECT json_group_array(json(step)) FROM (
      SELECT CASE WHEN ${where} THEN json_set(s.value, ${updates}) ELSE s.value END AS step
      FROM json_each(${column}) s
      ORDER BY s.key
    )
  )`;
}

export function stepField(name: string) {
  return `json_extract(s.value, '$.${name}')`;
}

// A row field of a JSON array of objects bound as a parameter and aliased `u`.
export function rowField(name: string) {
  return `json_extract(u.value, '$.${name}')`;
}

// D1 caps a bound value at 2MB, so large JSON rowsets are split across statements in one batch.
const MAX_JSON_PARAM_BYTES = 1_500_000;

export function chunkRowsByBytes<T>(rows: T[]): T[][] {
  const encoder = new TextEncoder();
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const row of rows) {
    const bytes = encoder.encode(JSON.stringify(row)).length;
    if (current.length > 0 && currentBytes + bytes > MAX_JSON_PARAM_BYTES) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// D1 also caps a row at 2MB. A truncated copy of a stored diff beats failing the review.
const MAX_INSPECTION_TEXT_CHARS = 500_000;

export function clampInspectionText(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  return value.length > MAX_INSPECTION_TEXT_CHARS
    ? `${value.slice(0, MAX_INSPECTION_TEXT_CHARS)}\n[truncated: exceeded D1 row limit]`
    : value;
}
