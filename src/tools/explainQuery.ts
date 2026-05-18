import { validateReadonlyQuery } from "../safety/sqlGuard.js";
import type { ToolContext } from "./toolTypes.js";
import { fail, ok, tableNamesForAudit } from "./toolTypes.js";

export async function explainQuery(context: ToolContext, input: { query?: string }) {
  const started = Date.now();
  const guard = validateReadonlyQuery(input.query ?? "", context.config, context.policy, {
    allowExplain: context.config.safety.allow_explain
  });

  if (!guard.allowed || !guard.executableQuery || !guard.isExplain) {
    await context.audit.log({
      tool_name: "explain_query",
      allowed: false,
      reason: guard.reason ?? "EXPLAIN query is required.",
      normalized_query: guard.normalizedQuery,
      tables_detected: tableNamesForAudit(guard.detectedTables),
      duration_ms: Date.now() - started
    });

    return fail("QUERY_BLOCKED", guard.reason ?? "Only EXPLAIN SELECT queries are allowed.", {
      tables: guard.detectedTables
    });
  }

  try {
    const plan = await context.db.explainQuery(guard.executableQuery);
    await context.audit.log({
      tool_name: "explain_query",
      allowed: true,
      normalized_query: guard.normalizedQuery,
      tables_detected: tableNamesForAudit(guard.detectedTables),
      row_count: plan.length,
      duration_ms: Date.now() - started
    });

    return ok({ plan, tables: guard.detectedTables });
  } catch (error) {
    await context.audit.log({
      tool_name: "explain_query",
      allowed: false,
      reason: error instanceof Error ? error.message : "Unknown database error",
      normalized_query: guard.normalizedQuery,
      tables_detected: tableNamesForAudit(guard.detectedTables),
      duration_ms: Date.now() - started
    });

    return fail("DATABASE_ERROR", "Database explain failed.", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
