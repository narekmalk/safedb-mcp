import type { DetectedTable, MaskStrategy, SafeDbConfig } from "../types.js";

export interface PolicyCheck {
  allowed: boolean;
  reason?: string;
}

export class AccessPolicy {
  constructor(private readonly config: SafeDbConfig) {}

  checkTables(tables: DetectedTable[]): PolicyCheck {
    if (tables.length === 0) {
      return {
        allowed: false,
        reason: "No table could be detected. SafeDB blocks ambiguous queries by default."
      };
    }

    for (const detected of tables) {
      const schema = detected.schema ?? this.defaultSchemaForTable(detected.table);
      if (!schema) {
        return {
          allowed: false,
          reason: `Table "${detected.table}" is not in an allowed schema.`
        };
      }

      const schemaConfig = this.config.access.schemas[schema];
      if (!schemaConfig) {
        return {
          allowed: false,
          reason: `Schema "${schema}" is not configured for access.`
        };
      }

      if (schemaConfig.deny_tables?.includes(detected.table)) {
        return {
          allowed: false,
          reason: `Table "${schema}.${detected.table}" is explicitly denied.`
        };
      }

      const allowTables = schemaConfig.allow_tables ?? [];
      if (allowTables.length === 0 || !allowTables.includes(detected.table)) {
        return {
          allowed: false,
          reason: `Table "${schema}.${detected.table}" is not in the allowlist.`
        };
      }
    }

    return { allowed: true };
  }

  getMask(schema: string | undefined, table: string | undefined, column: string): MaskStrategy | undefined {
    const candidates: string[] = [];

    if (schema && table) {
      candidates.push(`${schema}.${table}.${column}`);
    }

    if (table) {
      candidates.push(`${table}.${column}`);
    }

    candidates.push(column);

    for (const schemaConfig of Object.values(this.config.access.schemas)) {
      for (const candidate of candidates) {
        const strategy = schemaConfig.column_masks?.[candidate];
        if (strategy) {
          return strategy;
        }
      }
    }

    return undefined;
  }

  hasGlobalMask(column: string): boolean {
    return Object.values(this.config.access.schemas).some(
      (schemaConfig) => schemaConfig.column_masks?.[column] !== undefined
    );
  }

  maskedColumnsForTable(schema: string | undefined, table: string): string[] {
    const resolvedSchema = schema ?? this.defaultSchemaForTable(table);
    const columns = new Set<string>();

    for (const [schemaName, schemaConfig] of Object.entries(this.config.access.schemas)) {
      for (const key of Object.keys(schemaConfig.column_masks ?? {})) {
        const parts = key.split(".");

        if (parts.length === 1) {
          columns.add(parts[0]);
        } else if (parts.length === 2 && parts[0] === table) {
          columns.add(parts[1]);
        } else if (parts.length === 3 && parts[0] === (resolvedSchema ?? schemaName) && parts[1] === table) {
          columns.add(parts[2]);
        }
      }
    }

    return [...columns];
  }

  resolveTableSchema(table: DetectedTable): string | undefined {
    return table.schema ?? this.defaultSchemaForTable(table.table);
  }

  allowedSchemas(): string[] {
    return Object.keys(this.config.access.schemas);
  }

  defaultSchema(): string {
    const schemas = this.allowedSchemas();
    if (schemas.includes("public")) {
      return "public";
    }

    return schemas.length === 1 ? schemas[0] : "public";
  }

  allowedTables(schema: string): string[] {
    const schemaConfig = this.config.access.schemas[schema];
    if (!schemaConfig) {
      return [];
    }

    const denied = new Set(schemaConfig.deny_tables ?? []);
    return (schemaConfig.allow_tables ?? []).filter((table) => !denied.has(table));
  }

  policySummary(): object {
    return {
      safety: this.config.safety,
      access: {
        schemas: Object.fromEntries(
          Object.entries(this.config.access.schemas).map(([schema, schemaConfig]) => [
            schema,
            {
              allow_tables: schemaConfig.allow_tables ?? [],
              deny_tables: schemaConfig.deny_tables ?? [],
              masked_columns: Object.keys(schemaConfig.column_masks ?? {})
            }
          ])
        )
      }
    };
  }

  private defaultSchemaForTable(table: string): string | undefined {
    const matches = Object.entries(this.config.access.schemas).filter(([, schemaConfig]) =>
      schemaConfig.allow_tables?.includes(table)
    );

    return matches.length === 1 ? matches[0][0] : undefined;
  }
}
