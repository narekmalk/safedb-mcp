import type { SafeDbConfig } from "../types.js";
import { databaseDriver } from "../types.js";
import type { DatabaseClient } from "./types.js";
import { MySqlDatabase } from "./mysql.js";
import { PostgresDatabase } from "./postgres.js";
import { SqliteDatabase } from "./sqlite.js";

export function createDatabaseClient(config: SafeDbConfig): DatabaseClient {
  const driver = databaseDriver(config);

  switch (driver) {
    case "postgres":
      return new PostgresDatabase(config);
    case "mysql":
    case "mariadb":
      return new MySqlDatabase(config);
    case "sqlite":
      return new SqliteDatabase(config);
  }
}
