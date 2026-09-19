-- synth-agent-runtime v0.5 baseline Postgres schema.
-- Runtime source of truth is src/postgres/schema.ts; keep this file deployable with psql.
CREATE TABLE IF NOT EXISTS synth_agents (id text PRIMARY KEY, body jsonb NOT NULL, fencing_token bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS synth_tasks (id text PRIMARY KEY, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS synth_relations (from_id text NOT NULL, to_id text NOT NULL, kind text NOT NULL, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (from_id,to_id,kind));
CREATE TABLE IF NOT EXISTS synth_events (seq bigserial PRIMARY KEY, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS synth_commands (id text PRIMARY KEY, status text NOT NULL, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS synth_commands_status_idx ON synth_commands(status);
CREATE TABLE IF NOT EXISTS synth_workspace_checkpoints (workspace_id text PRIMARY KEY, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS synth_turns (id text PRIMARY KEY, status text NOT NULL, workspace_id text NOT NULL, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS synth_turns_status_idx ON synth_turns(status);
CREATE INDEX IF NOT EXISTS synth_turns_workspace_idx ON synth_turns(workspace_id);
CREATE TABLE IF NOT EXISTS synth_effects (id text PRIMARY KEY, status text NOT NULL, kind text NOT NULL, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS synth_effects_status_idx ON synth_effects(status);
CREATE TABLE IF NOT EXISTS synth_projects (id text PRIMARY KEY, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS synth_artifacts (id text PRIMARY KEY, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
