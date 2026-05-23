import mysql from "mysql2/promise";
import type { QueryResultRow, SafeDbConfig } from "../types.js";
import type { ColumnDescription, DatabaseClient } from "./types.js";

export class MySqlDatabase implements DatabaseClient {
  private readonly pool: mysql.Pool;

  constructor(private readonly config: SafeDbConfig) {
    this.pool = mysql.createPool(toPoolConfig(config));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async testConnection(): Promise<void> {
    await this.pool.query("select 1");
  }

  async listSchemas(allowedSchemas: string[]): Promise<string[]> {
    if (allowedSchemas.length === 0) {
      return [];
    }

    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `select schema_name
       from information_schema.schemata
       where schema_name in (?)
       order by schema_name`,
      [allowedSchemas]
    );

    return rows.map((row) => String(row.schema_name));
  }

  async listTables(schema: string, allowedTables: string[]): Promise<string[]> {
    if (allowedTables.length === 0) {
      return [];
    }

    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `select table_name
       from information_schema.tables
       where table_schema = ?
         and table_type = 'BASE TABLE'
         and table_name in (?)
       order by table_name`,
      [schema, allowedTables]
    );

    return rows.map((row) => String(row.table_name));
  }

  async describeTable(schema: string, table: string): Promise<ColumnDescription[]> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
       where table_schema = ? and table_name = ?
       order by ordinal_position`,
      [schema, table]
    );

    return rows.map((row) => ({
      column_name: String(row.column_name),
      data_type: String(row.data_type),
      is_nullable: String(row.is_nullable),
      column_default: row.column_default === null ? null : String(row.column_default)
    }));
  }

  async runReadOnlyQuery(query: string): Promise<QueryResultRow[]> {
    return this.withReadOnlyTransaction(async (connection) => {
      const [rows] = await connection.query<mysql.RowDataPacket[]>({
        sql: query,
        timeout: this.config.safety.statement_timeout_ms
      });
      return rows as QueryResultRow[];
    });
  }

  async explainQuery(query: string): Promise<QueryResultRow[]> {
    return this.withReadOnlyTransaction(async (connection) => {
      const [rows] = await connection.query<mysql.RowDataPacket[]>({
        sql: query,
        timeout: this.config.safety.statement_timeout_ms
      });
      return rows as QueryResultRow[];
    });
  }

  private async withReadOnlyTransaction<T>(
    callback: (connection: mysql.PoolConnection) => Promise<T>
  ): Promise<T> {
    const connection = await this.pool.getConnection();

    try {
      await connection.query("start transaction read only");
      const result = await callback(connection);
      await connection.query("rollback");
      return result;
    } catch (error) {
      await connection.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}

export function toPoolConfig(config: SafeDbConfig): mysql.PoolOptions {
  if (config.database.url) {
    return {
      uri: config.database.url,
      waitForConnections: true,
      connectionLimit: 10,
      ssl: config.database.ssl ? {} : undefined
    };
  }

  return {
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    password: config.database.password,
    waitForConnections: true,
    connectionLimit: 10,
    ssl: config.database.ssl ? {} : undefined
  };
}
