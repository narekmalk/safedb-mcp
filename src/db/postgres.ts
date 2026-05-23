import pg from "pg";
import type { QueryResultRow, SafeDbConfig } from "../types.js";
import type { ColumnDescription, DatabaseClient } from "./types.js";

const { Pool } = pg;

export class PostgresDatabase implements DatabaseClient {
  private readonly pool: pg.Pool;

  constructor(private readonly config: SafeDbConfig) {
    this.pool = new Pool(toPoolConfig(config));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async testConnection(): Promise<void> {
    await this.pool.query("select 1");
  }

  async listSchemas(allowedSchemas: string[]): Promise<string[]> {
    const result = await this.pool.query<{ schema_name: string }>(
      `select schema_name
       from information_schema.schemata
       where schema_name = any($1::text[])
       order by schema_name`,
      [allowedSchemas]
    );

    return result.rows.map((row) => row.schema_name);
  }

  async listTables(schema: string, allowedTables: string[]): Promise<string[]> {
    if (allowedTables.length === 0) {
      return [];
    }

    const result = await this.pool.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_type = 'BASE TABLE'
         and table_name = any($2::text[])
       order by table_name`,
      [schema, allowedTables]
    );

    return result.rows.map((row) => row.table_name);
  }

  async describeTable(schema: string, table: string): Promise<ColumnDescription[]> {
    const result = await this.pool.query<ColumnDescription>(
      `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
       where table_schema = $1 and table_name = $2
       order by ordinal_position`,
      [schema, table]
    );

    return result.rows;
  }

  async runReadOnlyQuery(query: string): Promise<QueryResultRow[]> {
    return this.withReadOnlyTransaction(async (client) => {
      const result = await client.query<QueryResultRow>(query);
      return result.rows;
    });
  }

  async explainQuery(query: string): Promise<QueryResultRow[]> {
    return this.withReadOnlyTransaction(async (client) => {
      const result = await client.query<QueryResultRow>(query);
      return result.rows;
    });
  }

  private async withReadOnlyTransaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      // Defense in depth: SQL is validated before this point, and Postgres still receives
      // every agent query inside a read-only transaction with a local timeout.
      await client.query("begin read only");
      await client.query("select set_config('statement_timeout', $1, true)", [
        String(this.config.safety.statement_timeout_ms)
      ]);
      const result = await callback(client);
      await client.query("rollback");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function toPoolConfig(config: SafeDbConfig): pg.PoolConfig {
  if (config.database.url) {
    return {
      connectionString: config.database.url,
      ssl: config.database.ssl
    };
  }

  return {
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    password: config.database.password,
    ssl: config.database.ssl
  };
}
