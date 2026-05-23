export type MaskStrategy = "redact" | "email" | "partial" | "hash";
export type DatabaseDriver = "postgres" | "mysql" | "mariadb";

export type ColumnMasks = Record<string, MaskStrategy>;

export interface SchemaAccessConfig {
  allow_tables?: string[];
  deny_tables?: string[];
  column_masks?: ColumnMasks;
}

export interface SafeDbConfig {
  database: {
    type?: DatabaseDriver;
    url?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    ssl?: boolean;
  };
  safety: {
    default_limit: number;
    max_limit: number;
    statement_timeout_ms: number;
    allow_explain: boolean;
  };
  access: {
    schemas: Record<string, SchemaAccessConfig>;
  };
  audit?: {
    path?: string;
  };
  masking?: {
    hash_salt?: string;
  };
}

export interface StructuredError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: StructuredError;
}

export interface DetectedTable {
  schema?: string;
  table: string;
}

export interface GuardResult {
  allowed: boolean;
  reason?: string;
  normalizedQuery: string;
  executableQuery?: string;
  detectedTables: DetectedTable[];
  limit: number;
  isExplain: boolean;
}

export interface QueryResultRow {
  [column: string]: unknown;
}

export function databaseDriver(config: SafeDbConfig): DatabaseDriver {
  return config.database.type ?? "postgres";
}
