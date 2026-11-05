-- Fresh D1 schema: the end state of upstream's four Postgres migrations (001-004).
-- Timestamps are ISO-8601 UTC text with millisecond precision, which sorts chronologically as text.
-- Commit SHAs are lowercase hex text. JSON columns hold JSON text. Booleans are 0/1.

CREATE TABLE repositories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- TEXT: every caller and schema treats the GitHub installation id as an opaque string.
  installation_id TEXT    NOT NULL,
  owner           TEXT    NOT NULL,
  repo            TEXT    NOT NULL,
  UNIQUE (owner, repo)
);
CREATE INDEX repositories_owner_idx ON repositories (owner);

CREATE TABLE jobs (
  id                       TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  retry_of_job_id          TEXT    REFERENCES jobs(id) ON DELETE SET NULL,
  workflow_instance_id     TEXT,
  check_run_id             INTEGER,
  check_run_completed_at   TEXT,
  review_id                INTEGER,
  created_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at               TEXT,
  finished_at              TEXT,
  repository_id            INTEGER NOT NULL REFERENCES repositories(id),
  pr_number                INTEGER NOT NULL,
  total_input_tokens       INTEGER DEFAULT 0,
  total_output_tokens      INTEGER DEFAULT 0,
  file_count               INTEGER DEFAULT 0,
  comment_count            INTEGER DEFAULT 0,
  overall_confidence_score REAL,
  commit_sha               TEXT    NOT NULL,
  base_sha                 TEXT    NOT NULL,
  trigger                  TEXT    NOT NULL CHECK (trigger IN ('auto', 'mention', 'retry')),
  status                   TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'superseded', 'cancelled', 'stopped')),
  verdict                  TEXT    CHECK (verdict IN ('approve', 'comment')),
  pr_title                 TEXT,
  pr_author                TEXT,
  head_ref                 TEXT,
  base_ref                 TEXT,
  summary_model            TEXT,
  overall_correctness      TEXT,
  error_msg                TEXT,
  summary_markdown         TEXT,
  config_snapshot          TEXT,
  steps                    TEXT    DEFAULT '[]',
  lease_owner              TEXT,
  lease_expires_at         TEXT,
  heartbeat_at             TEXT,
  recovery_count           INTEGER NOT NULL DEFAULT 0,
  continuation_count       INTEGER NOT NULL DEFAULT 0,
  last_queue_message_at    TEXT
);
CREATE INDEX jobs_repo_idx ON jobs (repository_id, pr_number);
CREATE INDEX jobs_active_idx ON jobs (status) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_created_idx ON jobs (created_at);
CREATE INDEX jobs_head_sha_idx ON jobs (repository_id, pr_number, commit_sha, trigger);
CREATE INDEX jobs_correctness_idx ON jobs (overall_correctness);
CREATE INDEX jobs_lease_expiry_idx ON jobs (lease_expires_at) WHERE status = 'running' AND lease_expires_at IS NOT NULL;
CREATE INDEX jobs_terminal_check_idx ON jobs (status, check_run_completed_at) WHERE check_run_id IS NOT NULL AND check_run_completed_at IS NULL;
CREATE INDEX jobs_unleased_running_idx ON jobs (last_queue_message_at, heartbeat_at) WHERE status = 'running' AND lease_expires_at IS NULL;
CREATE INDEX idx_jobs_workflow_instance_id ON jobs (workflow_instance_id);

CREATE TABLE file_reviews (
  id                    TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  job_id                TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  diff_line_count       INTEGER,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  duration_ms           INTEGER,
  confidence_score      REAL,
  file_status           TEXT    NOT NULL CHECK (file_status IN ('pending', 'done', 'skipped', 'failed')),
  verdict               TEXT    CHECK (verdict IN ('approve', 'comment')),
  file_path             TEXT    NOT NULL,
  model_used            TEXT    NOT NULL,
  model_provider        TEXT,
  overall_correctness   TEXT,
  file_summary          TEXT,
  error_msg             TEXT,
  diff_input            TEXT,
  raw_ai_output         TEXT,
  transient_error_count INTEGER NOT NULL DEFAULT 0,
  async_request_id      TEXT,
  async_model           TEXT,
  withheld_counts       TEXT,
  batch_size            INTEGER,
  degraded              TEXT
);
CREATE UNIQUE INDEX file_reviews_job_file_path_key ON file_reviews (job_id, file_path);
CREATE INDEX file_reviews_correctness_idx ON file_reviews (overall_correctness);
CREATE INDEX file_reviews_provider_idx ON file_reviews (model_provider);
CREATE INDEX file_reviews_created_idx ON file_reviews (created_at);
CREATE INDEX file_reviews_batch_size_idx ON file_reviews (batch_size) WHERE batch_size > 1;
CREATE INDEX file_reviews_degraded_idx ON file_reviews (degraded) WHERE degraded IS NOT NULL;

CREATE TABLE review_comments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  file_review_id   TEXT    NOT NULL REFERENCES file_reviews(id) ON DELETE CASCADE,
  line             INTEGER,
  position         INTEGER,
  path             TEXT    NOT NULL,
  severity         TEXT    NOT NULL,
  category         TEXT    NOT NULL DEFAULT 'quality',
  title            TEXT    NOT NULL,
  body             TEXT    NOT NULL,
  code_suggestion  TEXT,
  confidence_score REAL,
  evidence         TEXT,
  fingerprint      TEXT,
  anchor_hash      TEXT,
  posted           INTEGER NOT NULL DEFAULT 0,
  claim_type       TEXT,
  context_snippet  TEXT,
  disposition      TEXT,
  verify_reason    TEXT,
  fingerprint_v2   TEXT,
  source           TEXT    NOT NULL DEFAULT 'llm',
  rule_id          TEXT,
  reviewer_model   TEXT
);
CREATE INDEX review_comments_file_idx ON review_comments (file_review_id);
CREATE INDEX review_comments_fingerprint_idx ON review_comments (fingerprint);
CREATE INDEX review_comments_posted_fingerprint_idx ON review_comments (file_review_id, fingerprint) WHERE posted AND fingerprint IS NOT NULL;
CREATE INDEX review_comments_posted_fingerprint_v2_idx ON review_comments (file_review_id, fingerprint_v2) WHERE posted AND fingerprint_v2 IS NOT NULL;
CREATE INDEX review_comments_claim_type_idx ON review_comments (claim_type) WHERE claim_type IS NOT NULL;
CREATE INDEX review_comments_source_idx ON review_comments (source) WHERE source <> 'llm';

CREATE TABLE repo_configs (
  id              TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  repository_id   INTEGER NOT NULL UNIQUE REFERENCES repositories(id),
  enabled         INTEGER NOT NULL DEFAULT 1,
  main_model      TEXT,
  parsed_json     TEXT,
  fallback_models TEXT    DEFAULT '[]',
  size_overrides  TEXT
);

CREATE TABLE webhook_deliveries (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  received_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  repository_id INTEGER REFERENCES repositories(id),
  delivery_id   TEXT NOT NULL UNIQUE,
  event_name    TEXT NOT NULL,
  payload       TEXT NOT NULL
);
CREATE INDEX webhook_deliveries_repo_idx ON webhook_deliveries (repository_id, received_at DESC);

CREATE TABLE llm_providers (
  id                TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  name              TEXT    NOT NULL UNIQUE,
  api_format        TEXT    NOT NULL CHECK (api_format IN ('openai', 'anthropic', 'gemini', 'cloudflare-workers-ai', 'vertex')),
  base_url          TEXT,
  encrypted_api_key TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE model_configs (
  model_id    TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES llm_providers(id),
  model_name  TEXT NOT NULL,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX model_configs_provider_id_idx ON model_configs (provider_id);

CREATE TABLE global_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE account_settings (
  id              TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  github_user_id  INTEGER NOT NULL UNIQUE,
  github_username TEXT    NOT NULL,
  account_name    TEXT,
  account_email   TEXT,
  timezone        TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE comment_feedback (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id     INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pr_number         INTEGER,
  fingerprint       TEXT    NOT NULL,
  anchor_hash       TEXT,
  github_comment_id INTEGER,
  outcome           TEXT    NOT NULL,
  source            TEXT    NOT NULL DEFAULT 'github_webhook',
  job_id            TEXT    REFERENCES jobs(id) ON DELETE SET NULL,
  labelled_by       INTEGER,
  fingerprint_v2    TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX comment_feedback_unique_idx ON comment_feedback (repository_id, github_comment_id, outcome);
CREATE UNIQUE INDEX comment_feedback_dashboard_unique_idx ON comment_feedback (repository_id, fingerprint) WHERE source = 'dashboard';
CREATE INDEX comment_feedback_repo_outcome_idx ON comment_feedback (repository_id, outcome);
CREATE INDEX comment_feedback_repo_fingerprint_idx ON comment_feedback (repository_id, fingerprint);
CREATE INDEX comment_feedback_repo_fingerprint_v2_idx ON comment_feedback (repository_id, fingerprint_v2) WHERE fingerprint_v2 IS NOT NULL;

INSERT INTO global_settings (key, value) VALUES
  ('review_concurrency_level', 'medium'),
  ('review_max_comments', '10'),
  ('review_max_files', '200');

INSERT INTO llm_providers (name, api_format, base_url, enabled) VALUES
  ('Cloudflare', 'cloudflare-workers-ai', NULL, 1),
  ('Google', 'gemini', 'https://generativelanguage.googleapis.com/v1beta', 0),
  ('OpenAI', 'openai', 'https://api.openai.com/v1', 0),
  ('Anthropic', 'anthropic', 'https://api.anthropic.com/v1', 0),
  ('OpenRouter', 'openai', 'https://openrouter.ai/api/v1', 0),
  ('xAI', 'openai', 'https://api.x.ai/v1', 0),
  ('NVIDIA', 'openai', 'https://integrate.api.nvidia.com/v1', 0),
  ('Vertex AI', 'vertex', NULL, 0);

INSERT INTO model_configs (model_id, provider, provider_id, model_name)
SELECT '@cf/moonshotai/kimi-k2.6', 'cloudflare', id, '@cf/moonshotai/kimi-k2.6' FROM llm_providers WHERE name = 'Cloudflare';
INSERT INTO model_configs (model_id, provider, provider_id, model_name)
SELECT '@cf/zai-org/glm-4.7-flash', 'cloudflare', id, '@cf/zai-org/glm-4.7-flash' FROM llm_providers WHERE name = 'Cloudflare';
