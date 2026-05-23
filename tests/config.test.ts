import { describe, expect, it } from "vitest";
import { expandEnv, parseConfig } from "../src/config/loadConfig.js";
import { validateConfig } from "../src/config/schema.js";
import { EXAMPLE_CONFIG } from "../src/config/example.js";
import { baseConfig } from "./fixtures.js";

describe("config", () => {
  it("validates the example config after env expansion", () => {
    const raw = expandEnv(EXAMPLE_CONFIG, {
      DATABASE_URL: "postgres://user:pass@example.test:5432/app"
    });

    expect(() => validateConfig(parseConfig(raw, "safedb.yaml"))).not.toThrow();
  });

  it("catches bad limit configs", () => {
    const config = baseConfig({
      safety: {
        default_limit: 1000,
        max_limit: 100,
        statement_timeout_ms: 5000,
        allow_explain: true
      }
    });

    expect(() => validateConfig(config)).toThrow(/default_limit/);
  });

  it("accepts mysql and mariadb database types", () => {
    expect(validateConfig(baseConfig({ database: { type: "mysql", url: "mysql://user:pass@example.test/app" } })).database.type).toBe(
      "mysql"
    );
    expect(
      validateConfig(baseConfig({ database: { type: "mariadb", url: "mysql://user:pass@example.test/app" } }))
        .database.type
    ).toBe("mariadb");
  });

  it("accepts sqlite database paths", () => {
    expect(validateConfig(baseConfig({ database: { type: "sqlite", path: "app.db" } })).database.type).toBe(
      "sqlite"
    );
  });

  it("requires an access schema", () => {
    const config = baseConfig({
      access: {
        schemas: {}
      }
    });

    expect(() => validateConfig(config)).toThrow(/at least one access schema/);
  });
});
