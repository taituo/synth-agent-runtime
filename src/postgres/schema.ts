import type { PgExecutor } from "./types.js";

/**
 * JSONB intentionally stores the canonical TypeScript record. Indexed columns
 * only cover identity/status fields needed for claims, recovery, and scans.
 */
export const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS synth_agents (
  id text PRIMARY KEY,
  body jsonb NOT NULL,
  fencing_token bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE synth_agents ADD COLUMN IF NOT EXISTS fencing_token bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS synth_agents_fencing_token_idx ON synth_agents(fencing_token);
CREATE TABLE IF NOT EXISTS synth_tasks (
  id text PRIMARY KEY,
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS synth_relations (
  from_id text NOT NULL,
  to_id text NOT NULL,
  kind text NOT NULL,
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE TABLE IF NOT EXISTS synth_events (
  seq bigserial PRIMARY KEY,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS synth_commands (
  id text PRIMARY KEY,
  status text NOT NULL,
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS synth_commands_status_idx ON synth_commands(status);
CREATE TABLE IF NOT EXISTS synth_workspace_checkpoints (
  workspace_id text PRIMARY KEY,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS synth_turns (
  id text PRIMARY KEY,
  status text NOT NULL,
  workspace_id text NOT NULL,
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS synth_turns_status_idx ON synth_turns(status);
CREATE INDEX IF NOT EXISTS synth_turns_workspace_idx ON synth_turns(workspace_id);
CREATE TABLE IF NOT EXISTS synth_effects (
  id text PRIMARY KEY,
  status text NOT NULL,
  kind text NOT NULL,
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS synth_effects_status_idx ON synth_effects(status);
CREATE TABLE IF NOT EXISTS synth_projects (
  id text PRIMARY KEY,
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS synth_artifacts (
  id text PRIMARY KEY,
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS synth_leases (
  resource_id text PRIMARY KEY, owner_id text NOT NULL, fencing_token bigint NOT NULL, acquired_at_ms bigint NOT NULL, updated_at_ms bigint NOT NULL, expires_at_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS synth_leases_expires_idx ON synth_leases(expires_at_ms);
CREATE SEQUENCE IF NOT EXISTS synth_mailbox_seq;
CREATE TABLE IF NOT EXISTS synth_mailbox (
  agent_id text NOT NULL, seq bigint NOT NULL DEFAULT nextval('synth_mailbox_seq'), message_id text NOT NULL, body jsonb NOT NULL, appended_at_ms bigint NOT NULL,
  PRIMARY KEY (agent_id, seq), UNIQUE (agent_id, message_id)
);
CREATE INDEX IF NOT EXISTS synth_mailbox_agent_seq_idx ON synth_mailbox(agent_id, seq);
CREATE TABLE IF NOT EXISTS synth_mailbox_cursors (
  agent_id text NOT NULL, consumer_id text NOT NULL, ack_seq bigint NOT NULL, updated_at_ms bigint NOT NULL, PRIMARY KEY (agent_id, consumer_id)
);
CREATE TABLE IF NOT EXISTS synth_continuations (
  id text PRIMARY KEY, tenant_id text, body jsonb NOT NULL, created_at_ms bigint NOT NULL, expires_at_ms bigint
);
CREATE INDEX IF NOT EXISTS synth_continuations_expiry_idx ON synth_continuations(expires_at_ms);
CREATE TABLE IF NOT EXISTS synth_route_health (route_key text PRIMARY KEY, body jsonb NOT NULL, updated_at_ms bigint NOT NULL);
CREATE TABLE IF NOT EXISTS synth_route_affinity (affinity_key text PRIMARY KEY, route_id text NOT NULL, expires_at_ms bigint, updated_at_ms bigint NOT NULL);
CREATE INDEX IF NOT EXISTS synth_route_affinity_expiry_idx ON synth_route_affinity(expires_at_ms);
`;

export async function installPostgresSchema(db: PgExecutor): Promise<void> {
  await db.query(POSTGRES_SCHEMA_SQL);
}
