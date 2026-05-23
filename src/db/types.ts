import type { QueryResultRow } from "../types.js";

export interface ColumnDescription {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

export interface DatabaseClient {
  close(): Promise<void>;
  testConnection(): Promise<void>;
  listSchemas(allowedSchemas: string[]): Promise<string[]>;
  listTables(schema: string, allowedTables: string[]): Promise<string[]>;
  describeTable(schema: string, table: string): Promise<ColumnDescription[]>;
  runReadOnlyQuery(query: string): Promise<QueryResultRow[]>;
  explainQuery(query: string): Promise<QueryResultRow[]>;
}
