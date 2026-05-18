import { createHash } from "node:crypto";
import type { QueryResultRow, SafeDbConfig } from "../types.js";
import { AccessPolicy } from "../safety/policy.js";

export function maskRows(
  rows: QueryResultRow[],
  policy: AccessPolicy,
  config: SafeDbConfig,
  tableHint?: { schema?: string; table?: string }
): QueryResultRow[] {
  return rows.map((row) => {
    const masked: QueryResultRow = {};

    for (const [column, value] of Object.entries(row)) {
      const strategy = policy.getMask(tableHint?.schema, tableHint?.table, column);
      masked[column] = strategy ? maskValue(value, strategy, config.masking?.hash_salt) : value;
    }

    return masked;
  });
}

export function maskValue(value: unknown, strategy: string, salt = ""): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  const text = String(value);

  switch (strategy) {
    case "redact":
      return "[REDACTED]";
    case "email":
      return maskEmail(text);
    case "partial":
      return maskPartial(text);
    case "hash":
      return createHash("sha256").update(`${salt}:${text}`).digest("hex");
    default:
      return "[REDACTED]";
  }
}

export function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!local || !domain) {
    return "[REDACTED]";
  }

  return `${local[0]}***@${domain}`;
}

export function maskPartial(value: string): string {
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}
