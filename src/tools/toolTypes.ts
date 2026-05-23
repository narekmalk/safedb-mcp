import type { AuditLogger } from "../audit/auditLogger.js";
import type { DatabaseClient } from "../db/types.js";
import type { AccessPolicy } from "../safety/policy.js";
import type { SafeDbConfig, StructuredError, ToolResult } from "../types.js";

export interface ToolContext {
  config: SafeDbConfig;
  db: DatabaseClient;
  policy: AccessPolicy;
  audit: AuditLogger;
}

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function fail(code: string, message: string, details?: Record<string, unknown>): ToolResult {
  const error: StructuredError = { code, message };
  if (details) {
    error.details = details;
  }

  return { ok: false, error };
}

export function tableNamesForAudit(tables: { schema?: string; table: string }[]): string[] {
  return tables.map((table) => (table.schema ? `${table.schema}.${table.table}` : table.table));
}
