import { z } from "zod";
import type { SafeDbConfig } from "../types.js";

const maskStrategySchema = z.enum(["redact", "email", "partial", "hash"]);
const databaseDriverSchema = z.enum(["postgres", "mysql", "mariadb"]);

const schemaAccessSchema = z
  .object({
    allow_tables: z.array(z.string().min(1)).optional().default([]),
    deny_tables: z.array(z.string().min(1)).optional().default([]),
    column_masks: z.record(maskStrategySchema).optional().default({})
  })
  .strict();

export const safeDbConfigSchema = z
  .object({
    database: z
      .object({
        type: databaseDriverSchema.optional().default("postgres"),
        url: z.string().min(1).optional(),
        host: z.string().min(1).optional(),
        port: z.coerce.number().int().positive().max(65535).optional(),
        database: z.string().min(1).optional(),
        user: z.string().min(1).optional(),
        password: z.string().optional(),
        ssl: z.boolean().optional()
      })
      .strict()
      .refine((value) => value.url || (value.host && value.database && value.user), {
        message: "database.url or database.host/database/user must be configured"
      }),
    safety: z
      .object({
        default_limit: z.coerce.number().int().positive().max(100000).default(100),
        max_limit: z.coerce.number().int().positive().max(100000).default(1000),
        statement_timeout_ms: z.coerce.number().int().positive().max(600000).default(5000),
        allow_explain: z.boolean().default(true)
      })
      .strict()
      .refine((value) => value.default_limit <= value.max_limit, {
        message: "safety.default_limit must be less than or equal to safety.max_limit"
      }),
    access: z
      .object({
        schemas: z.record(schemaAccessSchema).refine((schemas) => Object.keys(schemas).length > 0, {
          message: "at least one access schema must be configured"
        })
      })
      .strict(),
    audit: z
      .object({
        path: z.string().min(1).optional()
      })
      .strict()
      .optional(),
    masking: z
      .object({
        hash_salt: z.string().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export function validateConfig(input: unknown): SafeDbConfig {
  return safeDbConfigSchema.parse(input) as SafeDbConfig;
}
