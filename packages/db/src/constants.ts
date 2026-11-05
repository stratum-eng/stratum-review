import {
  reviewConcurrencyLevels,
  reviewMaxCommentsOptions,
} from "@codraoss/schema";

// accounts.ts
export const ACCOUNT_COLUMNS =
  "id, github_user_id, github_username, account_name, account_email, timezone";

// app-settings.ts
export const CONCURRENCY_KEY = "review_concurrency_level";
export const MAX_COMMENTS_KEY = "review_max_comments";
export const MAX_FILES_KEY = "review_max_files";
export const CONCURRENCY_LEVELS = new Set<string>(reviewConcurrencyLevels);
export const MAX_COMMENTS_OPTIONS = new Set<number>(reviewMaxCommentsOptions);

// jobs-activity.ts
export const SYSTEM_ACTIVE_JOBS_KEY = "system:active_jobs";

// model-configs.ts
export const PROVIDER_COLUMNS =
  "id, name, api_format, base_url, encrypted_api_key, enabled, created_at, updated_at";
export const MODEL_SELECT = `
  SELECT
    mc.model_id,
    mc.provider_id,
    p.name AS provider_name,
    p.api_format,
    mc.model_name,
    mc.updated_at
  FROM model_configs mc
  JOIN llm_providers p ON mc.provider_id = p.id
`;

// instance-id-repository.ts
export const INSTANCE_ID_KEY = "codra:instance_id";
