#!/usr/bin/env node
import { access, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { EXAMPLE_CONFIG } from "./config/example.js";
import { loadConfig } from "./config/loadConfig.js";
import { validateConfig } from "./config/schema.js";
import { PostgresDatabase } from "./db/postgres.js";
import { startMcpServer } from "./mcp/server.js";

const program = new Command();

program
  .name("safedb-mcp")
  .description("Secure MCP server for guarded read-only Postgres access.")
  .version("0.1.0")
  .option("-c, --config <path>", "Path to SafeDB config file", "safedb.yaml")
  .action(async (options: { config: string }) => {
    const config = await loadConfig(options.config);
    await startMcpServer(config);
  });

program
  .command("init")
  .description("Create an example SafeDB config file.")
  .option("-o, --output <path>", "Output config path", "safedb.yaml")
  .option("--force", "Overwrite an existing file", false)
  .action(async (options: { output: string; force: boolean }) => {
    const outputPath = path.resolve(options.output);
    if (!options.force && (await exists(outputPath))) {
      throw new Error(`Refusing to overwrite existing file: ${outputPath}`);
    }

    await writeFile(outputPath, EXAMPLE_CONFIG, "utf8");
    console.error(`Created ${outputPath}`);
  });

program
  .command("validate-config")
  .description("Validate a SafeDB YAML or JSON config file.")
  .action(async (_options: unknown, command: Command) => {
    const config = await loadConfig(configPath(command));
    validateConfig(config);
    console.error("Config is valid.");
  });

program
  .command("test-connection")
  .description("Validate config and test the Postgres connection.")
  .action(async (_options: unknown, command: Command) => {
    const config = await loadConfig(configPath(command));
    const db = new PostgresDatabase(config);

    try {
      await db.testConnection();
      console.error("Connection succeeded.");
    } finally {
      await db.close();
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`SafeDB MCP error: ${message}`);
  process.exitCode = 1;
});

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function configPath(command: Command): string {
  const options = command.optsWithGlobals() as { config?: string };
  return options.config ?? "safedb.yaml";
}
