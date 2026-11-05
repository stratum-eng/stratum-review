import type { DbEnv } from "./env";

const AI_OUTPUT_PREFIX = "ai-output/";
const WEBHOOK_PREFIX = "webhook/";

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// Kept for inspection only, so a storage failure is logged and costs the logs view, never the review.
export async function storeAiOutput(
  env: Pick<DbEnv, "BLOBS">,
  text: string | null | undefined,
): Promise<string | null> {
  if (!text) return null;
  try {
    const key = await sha256Hex(text);
    await env.BLOBS.put(`${AI_OUTPUT_PREFIX}${key}`, text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    return key;
  } catch (error) {
    console.error("Failed to store AI output in R2", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function readAiOutput(env: Pick<DbEnv, "BLOBS">, key: string) {
  const object = await env.BLOBS.get(`${AI_OUTPUT_PREFIX}${key}`);
  return object ? await object.text() : null;
}

// Unlike AI output, the review depends on this payload, so a failed write must fail the delivery.
export async function storeWebhookPayload(
  env: Pick<DbEnv, "BLOBS">,
  deliveryId: string,
  json: string,
) {
  const key = `${WEBHOOK_PREFIX}${deliveryId}`;
  await env.BLOBS.put(key, json, {
    httpMetadata: { contentType: "application/json" },
  });
  return key;
}

export async function readWebhookPayload(
  env: Pick<DbEnv, "BLOBS">,
  key: string,
): Promise<unknown | null> {
  const object = await env.BLOBS.get(key);
  return object ? JSON.parse(await object.text()) : null;
}
