import { describe, expect, it } from "vitest";
import { AccessPolicy } from "../src/safety/policy.js";
import { detectTables, validateReadonlyQuery } from "../src/safety/sqlGuard.js";
import { baseConfig } from "./fixtures.js";

describe("sqlGuard", () => {
  it("blocks dangerous statements", () => {
    const config = baseConfig();
    const result = validateReadonlyQuery("drop table users", config);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("DROP");
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
});
