import { readFile } from "node:fs/promises";
import initSqlJs from "sql.js";
import type { SqlValue } from "sql.js";
import type { QueryResultRow, SafeDbConfig } from "../types.js";
import type { ColumnDescription, DatabaseClient } from "./types.js";

type SqlJsDatabase = Awaited<ReturnType<typeof initSqlJs>>["Database"]["prototype"];

export class SqliteDatabase implements DatabaseClient {
  private db?: SqlJsDatabase;

  constructor(private readonly config: SafeDbConfig) {}

  close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
    return Promise.resolve();
  }

  async testConnection(): Promise<void> {
    await this.queryRows("select 1");
  }

  async listSchemas(allowedSchemas: string[]): Promise<string[]> {
    return allowedSchemas.includes("main") ? ["main"] : [];
  }

  async listTables(schema: string, allowedTables: string[]): Promise<string[]> {
    if (schema !== "main" || allowedTables.length === 0) {
      return [];
    }

    const placeholders = allowedTables.map(() => "?").join(", ");
    const rows = await this.queryRows(
      `select name as table_name
       from sqlite_master
       where type = 'table'
         and name not like 'sqlite_%'
         and name in (${placeholders})
       order by name`,
      allowedTables
    );

    return rows.map((row) => String(row.table_name));
  }

  async describeTable(schema: string, table: string): Promise<ColumnDescription[]> {
    if (schema !== "main") {
      return [];
    }

    const rows = await this.queryRows(`pragma table_info(${quoteIdentifier(table)})`);
    return rows.map((row) => ({
      column_name: String(row.name),
      data_type: String(row.type),
      is_nullable: row.notnull ? "NO" : "YES",
      column_default: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value)
    }));
  }

  async runReadOnlyQuery(query: string): Promise<QueryResultRow[]> {
    return this.queryRows(query);
  }

  async explainQuery(query: string): Promise<QueryResultRow[]> {
    return this.queryRows(query);
  }

  private async getDatabase(): Promise<SqlJsDatabase> {
    if (this.db) {
      return this.db;
    }

    const SQL = await initSqlJs();
    const dbPath = sqlitePath(this.config);
    const bytes = await readFile(dbPath);
    this.db = new SQL.Database(bytes);
    this.db.run("pragma query_only = ON");
    return this.db;
  }

  private async queryRows(query: string, params: SqlValue[] = []): Promise<QueryResultRow[]> {
    const db = await this.getDatabase();
    const statement = db.prepare(query, params);
    const rows: QueryResultRow[] = [];

    try {
      while (statement.step()) {
        rows.push(statement.getAsObject() as QueryResultRow);
      }
    } finally {
      statement.free();
    }

    return rows;
  }
}

export function sqlitePath(config: SafeDbConfig): string {
  const source = config.database.path ?? config.database.url;
  if (!source) {
    throw new Error("SQLite requires database.path or database.url.");
  }

  return source.startsWith("file:") ? source.slice("file:".length) : source;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
