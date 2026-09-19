-- v0.8 distributed control-plane primitives.
CREATE TABLE IF NOT EXISTS synth_leases (
  resource_id text PRIMARY KEY,
  owner_id text NOT NULL,
  fencing_token bigint NOT NULL,
  acquired_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS synth_leases_expires_idx ON synth_leases(expires_at_ms);

CREATE SEQUENCE IF NOT EXISTS synth_mailbox_seq;
CREATE TABLE IF NOT EXISTS synth_mailbox (
  agent_id text NOT NULL,
  seq bigint NOT NULL DEFAULT nextval('synth_mailbox_seq'),
  message_id text NOT NULL,
  body jsonb NOT NULL,
  appended_at_ms bigint NOT NULL,
  PRIMARY KEY (agent_id, seq),
  UNIQUE (agent_id, message_id)
);
CREATE INDEX IF NOT EXISTS synth_mailbox_agent_seq_idx ON synth_mailbox(agent_id, seq);
CREATE TABLE IF NOT EXISTS synth_mailbox_cursors (
  agent_id text NOT NULL,
  consumer_id text NOT NULL,
  ack_seq bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  PRIMARY KEY (agent_id, consumer_id)
);

CREATE TABLE IF NOT EXISTS synth_continuations (
  id text PRIMARY KEY,
  tenant_id text,
  body jsonb NOT NULL,
  created_at_ms bigint NOT NULL,
  expires_at_ms bigint
);
CREATE INDEX IF NOT EXISTS synth_continuations_expiry_idx ON synth_continuations(expires_at_ms);

CREATE TABLE IF NOT EXISTS synth_route_health (
  route_key text PRIMARY KEY,
  body jsonb NOT NULL,
  updated_at_ms bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS synth_route_affinity (
  affinity_key text PRIMARY KEY,
  route_id text NOT NULL,
  expires_at_ms bigint,
  updated_at_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS synth_route_affinity_expiry_idx ON synth_route_affinity(expires_at_ms);
