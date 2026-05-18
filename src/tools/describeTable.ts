import type { ToolContext } from "./toolTypes.js";
import { fail, ok } from "./toolTypes.js";

export async function describeTable(
  context: ToolContext,
  input: { schema?: string; table?: string }
) {
  const schema = input.schema ?? "public";
  const table = input.table;

  if (!table) {
    return fail("INVALID_INPUT", "table is required.");
  }

  const allowed = context.policy.checkTables([{ schema, table }]);
  if (!allowed.allowed) {
    return fail("TABLE_NOT_ALLOWED", allowed.reason ?? "Table is not allowed.", { schema, table });
  }

  const columns = await context.db.describeTable(schema, table);
  const safeColumns = columns.map((column) => ({
    ...column,
    mask: context.policy.getMask(schema, table, column.column_name)
  }));

  return ok({ schema, table, columns: safeColumns });
}
