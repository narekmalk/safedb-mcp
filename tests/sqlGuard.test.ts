import { describe, expect, it } from "vitest";
import { AccessPolicy } from "../src/safety/policy.js";
import { detectTables, validateReadonlyQuery } from "../src/safety/sqlGuard.js";
import { baseConfig } from "./fixtures.js";

describe("sqlGuard", () => {
  it("blocks dangerous statements", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery("drop table users", config);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("DROP TABLE");
  });

  it("blocks multiple statements", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery("select * from users; select * from orders", config);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Multiple SQL statements");
  });

  it("allows SELECT queries against allowed tables", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery("select id, email from public.users", config);

    expect(result.allowed).toBe(true);
    expect(result.executableQuery).toBe(
      "SELECT * FROM (select id, email from public.users) AS safedb_readonly_query LIMIT 100"
    );
  });

  it("allows simple read-only CTEs against allowed tables", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery(
      "with recent as (select * from users) select * from recent",
      config
    );

    expect(result.allowed).toBe(true);
    expect(result.detectedTables).toEqual([{ table: "users" }]);
  });

  it("tracks chained CTEs and aliases back to real tables", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery(
      "with u as (select * from users), recent as (select * from u join orders o on true) select * from recent",
      config
    );

    expect(result.allowed).toBe(true);
    expect(result.detectedTables).toEqual([{ table: "users" }, { table: "orders" }]);
  });

  it("allows blocked keywords inside string literals", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery("select * from users where note = 'drop table users'", config);

    expect(result.allowed).toBe(true);
    expect(result.detectedTables).toEqual([{ table: "users" }]);
  });

  it("allows semicolons inside string literals", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery("select * from users where note = 'first; second'", config);

    expect(result.allowed).toBe(true);
  });

  it("wraps queries with a safe max limit", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery("select * from users limit 5000", config);

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(1000);
    expect(result.executableQuery).toContain("LIMIT 1000");
  });

  it("honors lower requested limits", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery("select * from users limit 10", config);

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(10);
    expect(result.executableQuery).toContain("LIMIT 10");
  });

  it("blocks denied tables", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery("select * from public.secrets", config);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("explicitly denied");
  });

  it("blocks tables outside the allowlist", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery("select * from public.payments", config);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not in the allowlist");
  });

  it("detects denied tables inside nested subqueries", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery(
      "select * from users where exists (select 1 from public.secrets where secrets.id = users.id)",
      config
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("explicitly denied");
    expect(result.detectedTables).toEqual([{ table: "users" }, { schema: "public", table: "secrets" }]);
  });

  it("blocks SELECT FOR UPDATE locking clauses", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery("select * from users for update", config);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SELECT");
  });

  it("blocks ambiguous unqualified tables when more than one schema matches", () => {
    const config = baseConfig({
      access: {
        schemas: {
          public: { allow_tables: ["users"], deny_tables: [], column_masks: {} },
          analytics: { allow_tables: ["users"], deny_tables: [], column_masks: {} }
        }
      }
    });

    const result = validateReadonlyQuery("select * from users", config, new AccessPolicy(config));
    expect(result.allowed).toBe(false);
  });

  it("detects tables from FROM and JOIN clauses", () => {
    expect(detectTables("select * from public.users u join orders o on o.user_id = u.id")).toEqual([
      { schema: "public", table: "users" },
      { table: "orders" }
    ]);
  });

  it("detects tables through subqueries and unions", () => {
    expect(
      detectTables("select * from (select * from users) u union select * from orders")
    ).toEqual([{ table: "users" }, { table: "orders" }]);
  });

  it("validates MySQL queries with the MySQL dialect parser", () => {
    const config = baseConfig({
      database: { type: "mysql", url: "mysql://user:pass@example.test/app" },
      access: {
        schemas: {
          app: {
            allow_tables: ["users", "orders"],
            deny_tables: [],
            column_masks: {}
          }
        }
      }
    });

    const result = validateReadonlyQuery(
      "with u as (select * from app.users), recent as (select * from u join app.orders o on true) select * from recent limit 10",
      config
    );

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(10);
    expect(result.detectedTables).toEqual([
      { schema: "app", table: "users" },
      { schema: "app", table: "orders" }
    ]);
  });

  it("blocks MySQL locking reads", () => {
    const config = baseConfig({
      database: { type: "mysql", url: "mysql://user:pass@example.test/app" }
    });
    const result = validateReadonlyQuery("select * from users for update", config);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SELECT");
  });

  it("blocks MySQL locking reads inside nested subqueries", () => {
    const config = baseConfig({
      database: { type: "mysql", url: "mysql://user:pass@example.test/app" }
    });
    const result = validateReadonlyQuery(
      "select * from users where exists (select * from orders for update)",
      config
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SELECT");
  });

  it("detects MySQL tables through subqueries and unions", () => {
    const config = baseConfig({
      database: { type: "mariadb", url: "mysql://user:pass@example.test/app" }
    });

    expect(
      detectTables("select * from (select * from users) u union select * from orders", config)
    ).toEqual([{ table: "users" }, { table: "orders" }]);
  });
});
