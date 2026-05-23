import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "../src/db/sqlite.js";
import { baseConfig } from "./fixtures.js";

describe("SqliteDatabase", () => {
  it("reads schemas, tables, columns, and query rows from a SQLite file", async () => {
    const dbPath = await createSqliteFile();
    const config = baseConfig({
      database: { type: "sqlite", path: dbPath },
      access: {
        schemas: {
          main: {
            allow_tables: ["users"],
            deny_tables: [],
            column_masks: {}
          }
        }
      }
    });
    const db = new SqliteDatabase(config);

    try {
      await expect(db.testConnection()).resolves.toBeUndefined();
      await expect(db.listSchemas(["main"])).resolves.toEqual(["main"]);
      await expect(db.listTables("main", ["users"])).resolves.toEqual(["users"]);
      await expect(db.describeTable("main", "users")).resolves.toMatchObject([
        { column_name: "id", data_type: "INTEGER" },
        { column_name: "email", data_type: "TEXT" }
      ]);
      await expect(db.runReadOnlyQuery("select id, email from users")).resolves.toEqual([
        { id: 1, email: "nora@example.com" }
      ]);
    } finally {
      await db.close();
    }
  });
});

async function createSqliteFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "safedb-sqlite-test-"));
  const dbPath = path.join(dir, "app.db");
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  try {
    db.run("create table users(id integer primary key, email text not null)");
    db.run("insert into users(id, email) values (1, 'nora@example.com')");
    await writeFile(dbPath, Buffer.from(db.export()));
  } finally {
    db.close();
  }

  return dbPath;
}
