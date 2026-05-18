import { maskRows } from "../masking/mask.js";
import { validateReadonlyQuery } from "../safety/sqlGuard.js";
import type { ToolContext } from "./toolTypes.js";
import { fail, ok, tableNamesForAudit } from "./toolTypes.js";

export async function runReadonlyQuery(context: ToolContext, input: { query?: string }) {
  const started = Date.now();
  const guard = validateReadonlyQuery(input.query ?? "", context.config, context.policy, {
    allowExplain: false
  });

  if (!guard.allowed || !guard.executableQuery) {
    await context.audit.log({
      tool_name: "run_readonly_query",
      allowed: false,
      reason: guard.reason,
      normalized_query: guard.normalizedQuery,
      tables_detected: tableNamesForAudit(guard.detectedTables),
      duration_ms: Date.now() - started
    });

    return fail("QUERY_BLOCKED", guard.reason ?? "Query blocked by SafeDB policy.", {
      tables: guard.detectedTables
    });
  }

  try {
    const rows = await context.db.runReadOnlyQuery(guard.executableQuery);
    const tableHint = guard.detectedTables.length === 1 ? guard.detectedTables[0] : undefined;
    const maskedRows = maskRows(rows, context.policy, context.config, tableHint);

    await context.audit.log({
      tool_name: "run_readonly_query",
      allowed: true,
      normalized_query: guard.normalizedQuery,
      tables_detected: tableNamesForAudit(guard.detectedTables),
      row_count: maskedRows.length,
      duration_ms: Date.now() - started
    });

    return ok({
      rows: maskedRows,
      row_count: maskedRows.length,
      limit: guard.limit,
      tables: guard.detectedTables
    });
  } catch (error) {
    await context.audit.log({
      tool_name: "run_readonly_query",
      allowed: false,
      reason: error instanceof Error ? error.message : "Unknown database error",
      normalized_query: guard.normalizedQuery,
      tables_detected: tableNamesForAudit(guard.detectedTables),
      duration_ms: Date.now() - started
    });

    return fail("DATABASE_ERROR", "Database query failed.", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
