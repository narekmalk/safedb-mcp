import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AuditEvent {
  timestamp?: string;
  tool_name: string;
  allowed: boolean;
  reason?: string;
  normalized_query?: string;
  tables_detected?: string[];
  row_count?: number;
  duration_ms: number;
}

export class AuditLogger {
  constructor(private readonly auditPath = "safedb-audit.jsonl") {}

  async log(event: AuditEvent): Promise<void> {
    const output = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
      reason: event.reason ? redactSecrets(event.reason) : event.reason,
      normalized_query: event.normalized_query
        ? redactSecrets(event.normalized_query)
        : event.normalized_query
    };

    const absolutePath = path.resolve(this.auditPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await appendFile(absolutePath, `${JSON.stringify(output)}\n`, "utf8");
  }
}

export function redactSecrets(input: string): string {
  return input
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)([^@\s]+)(@)/gi, "$1[REDACTED]$3")
    .replace(/((?:password|api[_-]?key|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
