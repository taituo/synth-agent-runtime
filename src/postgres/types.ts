export interface PgQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

/** Structural subset implemented by pg.Client, pg.PoolClient, and many proxies. */
export interface PgExecutor {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PgQueryResult<Row>>;
}

export interface PgPoolLike extends PgExecutor {
  connect(): Promise<PgExecutor & { release(): void }>;
}
