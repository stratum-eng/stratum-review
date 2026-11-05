import type { AppBindings } from "../env";
import type {
  LearningStore,
  ModelConfigReader,
  RepoConfigLoader,
  ReviewSettingsReader,
  WebhookDeliveryReader,
} from "@codraoss/core/ports";
import {
  makeLearningStore as makeDbLearningStore,
  makeModelConfigReader as makeDbModelConfigReader,
  makeReviewSettingsReader as makeDbReviewSettingsReader,
  makeWebhookDeliveryReader as makeDbWebhookDeliveryReader,
} from "@codraoss/db/repositories";
import type { DbEnv } from "@codraoss/db/env";
import { normalizeGitHubWebhook } from "@codraoss/provider-github";
import { loadRepoConfig } from "../core/config";

function toDbEnv(env: AppBindings): DbEnv {
  return {
    DB: env.DB,
    BLOBS: env.BLOBS,
    APP_KV: env.APP_KV,
  };
}

export function makeReviewSettingsReader(
  env: AppBindings,
): ReviewSettingsReader {
  return makeDbReviewSettingsReader(toDbEnv(env));
}

export function makeModelConfigReader(env: AppBindings): ModelConfigReader {
  return makeDbModelConfigReader(toDbEnv(env));
}

// Deliveries are stored as GitHub sent them, but the engine only understands normalized events.
export function makeWebhookDeliveryReader(
  env: AppBindings,
): WebhookDeliveryReader {
  const reader = makeDbWebhookDeliveryReader(toDbEnv(env));
  return {
    getWebhookDelivery: async (deliveryId) => {
      const delivery = await reader.getWebhookDelivery(deliveryId);
      if (!delivery) return null;
      const normalized = normalizeGitHubWebhook(
        delivery.event_name,
        delivery.payload,
      );
      return normalized
        ? {
            ...delivery,
            event_name: normalized.eventName,
            payload: normalized.payload,
          }
        : delivery;
    },
  };
}

export function makeLearningStore(env: AppBindings): LearningStore {
  return makeDbLearningStore(toDbEnv(env));
}

export function makeRepoConfigLoader(env: AppBindings): RepoConfigLoader {
  return {
    loadRepoConfig: (input) => loadRepoConfig(env.APP_KV, toDbEnv(env), input),
  };
}
