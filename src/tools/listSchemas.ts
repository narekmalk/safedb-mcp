import type { ToolContext } from "./toolTypes.js";
import { ok } from "./toolTypes.js";

export async function listSchemas(context: ToolContext) {
  const schemas = await context.db.listSchemas(context.policy.allowedSchemas());
  return ok({ schemas });
}
