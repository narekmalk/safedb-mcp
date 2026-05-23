import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { validateConfig } from "./schema.js";
import type { SafeDbConfig } from "../types.js";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)(?::-(.*?))?\}/gi;

export async function loadConfig(configPath: string): Promise<SafeDbConfig> {
  const absolutePath = path.resolve(configPath);
  const raw = await readFile(absolutePath, "utf8");
  const expanded = expandEnv(raw);
  const parsed = parseConfig(expanded, absolutePath);
  return validateConfig(parsed);
}

export function parseConfig(raw: string, sourcePath = "config"): unknown {
  if (sourcePath.endsWith(".json")) {
    return JSON.parse(raw);
  }

  return YAML.parse(raw);
}

export function expandEnv(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  return raw.replace(ENV_PATTERN, (_match, key: string, fallback: string | undefined) => {
    const value = env[key];
    if (value !== undefined) {
      return value;
    }

    if (fallback !== undefined) {
      return fallback;
    }

    return "";
  });
}

export function configFromEnv(): SafeDbConfig {
  return validateConfig({
    database: {
      type: process.env.SAFEDB_DATABASE_TYPE,
      url: process.env.DATABASE_URL,
      path: process.env.SQLITE_PATH,
      host: process.env.PGHOST,
      port: process.env.PGPORT,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: process.env.PGSSL === "true" ? true : undefined
    },
    safety: {
      default_limit: Number(process.env.SAFEDB_DEFAULT_LIMIT ?? 100),
      max_limit: Number(process.env.SAFEDB_MAX_LIMIT ?? 1000),
      statement_timeout_ms: Number(process.env.SAFEDB_STATEMENT_TIMEOUT_MS ?? 5000),
      allow_explain: process.env.SAFEDB_ALLOW_EXPLAIN !== "false"
    },
    access: {
      schemas: {
        public: {
          allow_tables: (process.env.SAFEDB_ALLOW_TABLES ?? "")
            .split(",")
            .map((table) => table.trim())
            .filter(Boolean),
          deny_tables: (process.env.SAFEDB_DENY_TABLES ?? "")
            .split(",")
            .map((table) => table.trim())
            .filter(Boolean),
          column_masks: {}
        }
      }
    },
    audit: {
      path: process.env.SAFEDB_AUDIT_PATH
    }
  });
}
