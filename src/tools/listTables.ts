import type { ToolContext } from "./toolTypes.js";
import { fail, ok } from "./toolTypes.js";

export async function listTables(context: ToolContext, input: { schema?: string }) {
  const schema = input.schema ?? context.policy.defaultSchema();
  if (!context.policy.allowedSchemas().includes(schema)) {
    return fail("SCHEMA_NOT_ALLOWED", `Schema "${schema}" is not allowed.`);
  }

  const tables = await context.db.listTables(schema, context.policy.allowedTables(schema));
  return ok({ schema, tables });
}
