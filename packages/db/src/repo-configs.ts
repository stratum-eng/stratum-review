import type { DbEnv } from "./env";

import { parseJsonColumn, queryRows } from "./client";
import {
  defaultRepoConfig,
  normalizeRepoConfig,
  repoConfigRecordSchema,
  repoConfigSchema,
  type RepoConfig,
} from "@codraoss/schema";
import { getOrCreateRepository } from "./repositories";
import { NOW, inJson } from "./sql";

type RepoConfigRow = {
  installation_id: string;
  owner: string;
  repo: string;
  parsed_json: RepoConfig | string | null;
  updated_at: string;
  main_model: string | null;
  fallback_models: string[] | string | null;
  size_overrides: any | string | null;
  enabled: number;
  last_job_created_at: string | null;
  last_job_verdict: "approve" | "comment" | null;
};

function mapRepo(row: RepoConfigRow) {
  const parsedJson = normalizeRepoConfig(
    repoConfigSchema.parse(parseJsonColumn(row.parsed_json, defaultRepoConfig)),
  );
  return repoConfigRecordSchema.parse({
    installationId: row.installation_id,
    owner: row.owner,
    repo: row.repo,
    parsedJson,
    updatedAt: row.updated_at,
    lastJobCreatedAt: row.last_job_created_at,
    lastJobVerdict: row.last_job_verdict,
    mainModel: row.main_model,
    fallbackModels: parseJsonColumn(row.fallback_models, null),
    sizeOverrides: parseJsonColumn(row.size_overrides, null),
    enabled: Boolean(row.enabled),
  });
}

export async function upsertRepoConfig(
  env: DbEnv,
  input: {
    installationId: string;
    owner: string;
    repo: string;
    parsedJson: RepoConfig;
    enabled?: boolean;
  },
) {
  const repositoryId = await getOrCreateRepository(env, {
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
  });

  const parsedJson = normalizeRepoConfig(input.parsedJson);
  const model = parsedJson.model;
  await queryRows(
    env,
    `
      INSERT INTO repo_configs (repository_id, parsed_json, updated_at, main_model, fallback_models, size_overrides, enabled)
      VALUES ($1, $2, ${NOW}, $3, $4, $5, COALESCE($6, TRUE))
      ON CONFLICT (repository_id)
      DO UPDATE
      SET parsed_json = EXCLUDED.parsed_json,
          updated_at = EXCLUDED.updated_at,
          main_model = EXCLUDED.main_model,
          fallback_models = EXCLUDED.fallback_models,
          size_overrides = EXCLUDED.size_overrides,
          enabled = COALESCE($6, repo_configs.enabled)
    `,
    [
      repositoryId,
      JSON.stringify(parsedJson),
      model?.main ?? null,
      model?.fallbacks ? JSON.stringify(model.fallbacks) : null,
      model?.size_overrides ? JSON.stringify(model.size_overrides) : null,
      input.enabled ?? null,
    ],
  );
}

// Creates record if missing; preserves model overrides.
export async function syncRepoConfig(
  env: DbEnv,
  input: {
    installationId: string;
    owner: string;
    repo: string;
  },
) {
  const repositoryId = await getOrCreateRepository(env, {
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
  });

  await queryRows(
    env,
    `
      INSERT INTO repo_configs (repository_id, parsed_json, updated_at, main_model, fallback_models, size_overrides, enabled)
      VALUES ($1, $2, ${NOW}, NULL, NULL, NULL, TRUE)
      ON CONFLICT (repository_id) DO NOTHING
    `,
    [repositoryId, JSON.stringify(defaultRepoConfig)],
  );
}

export async function deleteStaleRepoConfigs(
  env: DbEnv,
  installationId: string,
  activeRepoFullNames: string[],
) {
  if (activeRepoFullNames.length === 0) {
    await queryRows(
      env,
      `
        DELETE FROM repo_configs
        WHERE repository_id IN (
          SELECT id FROM repositories WHERE installation_id = $1
        )
      `,
      [installationId],
    );
    return;
  }

  await queryRows(
    env,
    `
      DELETE FROM repo_configs
      WHERE repository_id IN (
        SELECT id FROM repositories 
        WHERE installation_id = $1 
          AND owner || '/' || repo NOT ${inJson("$2")}
      )
    `,
    [installationId, activeRepoFullNames],
  );
}

export async function updateRepoConfigEnabled(
  env: DbEnv,
  input: {
    owner: string;
    repo: string;
    enabled: boolean;
  },
) {
  await queryRows(
    env,
    `
      UPDATE repo_configs
      SET enabled = $3,
          updated_at = ${NOW}
      WHERE repository_id IN (
        SELECT r.id FROM repositories r WHERE r.owner = $1 AND r.repo = $2
      )
    `,
    [input.owner, input.repo, input.enabled],
  );
}

// Shared by the list and single-record queries, which differ only in their WHERE/ORDER BY.
const REPO_CONFIG_SELECT = `
      SELECT
        r.installation_id,
        r.owner,
        r.repo,
        rc.parsed_json,
        rc.updated_at,
        rc.main_model,
        rc.fallback_models,
        rc.size_overrides,
        rc.enabled,
        (SELECT j.created_at FROM jobs j WHERE j.repository_id = r.id ORDER BY j.created_at DESC LIMIT 1) AS last_job_created_at,
        (SELECT j.verdict FROM jobs j WHERE j.repository_id = r.id ORDER BY j.created_at DESC LIMIT 1) AS last_job_verdict
      FROM repo_configs rc
      JOIN repositories r ON rc.repository_id = r.id
`;

export async function listRepoConfigs(env: DbEnv) {
  const rows = await queryRows<RepoConfigRow>(
    env,
    `
      ${REPO_CONFIG_SELECT}
      ORDER BY r.owner ASC, r.repo ASC
    `,
  );

  return rows.map(mapRepo);
}

export async function getRepoConfigRecord(
  env: DbEnv,
  owner: string,
  repo: string,
) {
  const [row] = await queryRows<RepoConfigRow>(
    env,
    `
      ${REPO_CONFIG_SELECT}
      WHERE r.owner = $1 AND r.repo = $2
      LIMIT 1
    `,
    [owner, repo],
  );

  return row ? mapRepo(row) : null;
}
