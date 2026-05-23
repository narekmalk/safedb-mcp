import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AuditLogger } from "../audit/auditLogger.js";
import type { SafeDbConfig, ToolResult } from "../types.js";
import { createDatabaseClient } from "../db/factory.js";
import { AccessPolicy } from "../safety/policy.js";
import { describeTable } from "../tools/describeTable.js";
import { explainQuery } from "../tools/explainQuery.js";
import { getSafedbPolicy } from "../tools/getSafedbPolicy.js";
import { listSchemas } from "../tools/listSchemas.js";
import { listTables } from "../tools/listTables.js";
import { runReadonlyQuery } from "../tools/runReadonlyQuery.js";
import type { ToolContext } from "../tools/toolTypes.js";

const TOOL_DEFINITIONS = [
  {
    name: "list_schemas",
    description: "List database schemas allowed by the SafeDB policy.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "list_tables",
    description: "List allowed tables in an allowed schema.",
    inputSchema: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Schema name. Defaults to public." }
      },
      additionalProperties: false
    }
  },
  {
    name: "describe_table",
    description: "Describe columns for an allowed table and show configured masks.",
    inputSchema: {
      type: "object",
      required: ["table"],
      properties: {
        schema: { type: "string", description: "Schema name. Defaults to public." },
        table: { type: "string", description: "Table name." }
      },
      additionalProperties: false
    }
  },
  {
    name: "run_readonly_query",
    description: "Run a guarded read-only SELECT query against allowed tables.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "SELECT or WITH ... SELECT query." }
      },
      additionalProperties: false
    }
  },
  {
    name: "explain_query",
    description: "Run a guarded EXPLAIN SELECT query against allowed tables.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "EXPLAIN SELECT query." }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_safedb_policy",
    description: "Return the effective SafeDB safety policy without secrets.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

export function createToolContext(config: SafeDbConfig): ToolContext {
  return {
    config,
    db: createDatabaseClient(config),
    policy: new AccessPolicy(config),
    audit: new AuditLogger(config.audit?.path)
  };
}

export function createMcpServer(context: ToolContext): Server {
  const server = new Server(
    {
      name: "safedb-mcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS as any
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await callTool(context, name, args);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ],
      isError: !result.ok
    };
  });

  return server;
}

export async function callTool(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (name) {
    case "list_schemas":
      return listSchemas(context);
    case "list_tables":
      return listTables(context, { schema: stringArg(args.schema) });
    case "describe_table":
      return describeTable(context, { schema: stringArg(args.schema), table: stringArg(args.table) });
    case "run_readonly_query":
      return runReadonlyQuery(context, { query: stringArg(args.query) });
    case "explain_query":
      return explainQuery(context, { query: stringArg(args.query) });
    case "get_safedb_policy":
      return getSafedbPolicy(context);
    default:
      return {
        ok: false,
        error: {
          code: "UNKNOWN_TOOL",
          message: `Unknown tool "${name}".`
        }
      };
  }
}

export async function startMcpServer(config: SafeDbConfig): Promise<void> {
  const context = createToolContext(config);
  const server = createMcpServer(context);
  const transport = new StdioServerTransport();

  process.on("SIGINT", () => {
    void context.db.close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void context.db.close().finally(() => process.exit(0));
  });

  await server.connect(transport);
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
