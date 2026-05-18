import type { ToolContext } from "./toolTypes.js";
import { ok } from "./toolTypes.js";

export async function getSafedbPolicy(context: ToolContext) {
  return ok(context.policy.policySummary());
}
