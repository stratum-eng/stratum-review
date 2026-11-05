import type { DbEnv } from "./env";
import { readWebhookPayload, storeWebhookPayload } from "./blobs";
import { parseJsonColumn, queryRows } from "./client";

// Well under D1's 2MB row cap; GitHub allows payloads up to 25MB.
const MAX_INLINE_PAYLOAD_CHARS = 1_000_000;

export async function recordWebhookDelivery(
  env: DbEnv,
  input: {
    deliveryId: string;
    eventName: string;
    owner: string | null;
    repo: string | null;
    payload: unknown;
  },
) {
  let repositoryId: number | null = null;

  if (input.owner && input.repo) {
    const [repoRow] = await queryRows<{ id: number }>(
      env,
      "SELECT id FROM repositories WHERE owner = $1 AND repo = $2",
      [input.owner, input.repo],
    );
    if (repoRow) {
      repositoryId = repoRow.id;
    }
  }

  const payloadJson = JSON.stringify(input.payload);
  const oversized = payloadJson.length > MAX_INLINE_PAYLOAD_CHARS;
  const payloadKey = oversized
    ? await storeWebhookPayload(env, input.deliveryId, payloadJson)
    : null;

  const rows = await queryRows<{ id: string }>(
    env,
    `
      INSERT INTO webhook_deliveries (delivery_id, event_name, repository_id, payload, payload_key)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING id
    `,
    [
      input.deliveryId,
      input.eventName,
      repositoryId,
      oversized ? "null" : payloadJson,
      payloadKey,
    ],
  );

  // Returned rather than discarded so callers that need it (the feedback handler) don't pay for a second identical lookup.
  return { inserted: rows.length > 0, repositoryId };
}

export async function getWebhookDelivery(env: DbEnv, deliveryId: string) {
  const [row] = await queryRows<{
    delivery_id: string;
    event_name: string;
    payload: unknown;
    payload_key: string | null;
  }>(
    env,
    `
      SELECT delivery_id, event_name, payload, payload_key
      FROM webhook_deliveries
      WHERE delivery_id = $1
      LIMIT 1
    `,
    [deliveryId],
  );

  if (!row) return null;
  if (!row.payload_key) {
    return { ...row, payload: parseJsonColumn(row.payload, null) };
  }
  const payload = await readWebhookPayload(env, row.payload_key);
  if (payload === null) {
    console.warn("Webhook payload missing from R2", { deliveryId });
    return null;
  }
  return { ...row, payload };
}
