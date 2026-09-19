import { Pool, type PoolConfig } from "pg";
import { installPostgresSchema, PostgresDistributedControlStore, PostgresPersistence, type PgExecutor } from "../../src/index.js";

export interface OpenPostgresPersistenceOptions {
  connectionString?: string;
  pool?: PoolConfig;
  migrate?: boolean;
}

/** Thin node-postgres binding; core persistence stays driver-agnostic. */
export async function openPostgresPersistence(options: OpenPostgresPersistenceOptions = {}) {
  const pool = new Pool({
    ...(options.pool ?? {}),
    ...(options.connectionString ? { connectionString: options.connectionString } : {}),
  });
  const db = pool as unknown as PgExecutor;
  if (options.migrate !== false) await installPostgresSchema(db);
  return {
    pool,
    persistence: new PostgresPersistence(db),
    distributed: new PostgresDistributedControlStore(db),
    async close() { await pool.end(); },
  };
}
