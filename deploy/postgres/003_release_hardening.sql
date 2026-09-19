-- v0.9 release hardening: durable agent write fencing.
-- Lease expiry itself remains stored as epoch milliseconds for compatibility,
-- but v0.9 lease operations derive those values from PostgreSQL clock_timestamp().
ALTER TABLE synth_agents
  ADD COLUMN IF NOT EXISTS fencing_token bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS synth_agents_fencing_token_idx
  ON synth_agents(fencing_token);
