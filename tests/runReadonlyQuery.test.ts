import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLogger } from "../src/audit/auditLogger.js";
import { AccessPolicy } from "../src/safety/policy.js";
import { runReadonlyQuery } from "../src/tools/runReadonlyQuery.js";
import type { ToolContext } from "../src/tools/toolTypes.js";
import { baseConfig } from "./fixtures.js";

describe("runReadonlyQuery tool", () => {
  it("audits blocked attempts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "safedb-test-"));
    const config = baseConfig({ audit: { path: path.join(dir, "audit.jsonl") } });
    const context: ToolContext = {
      config,
      policy: new AccessPolicy(config),
      audit: new AuditLogger(config.audit?.path),
      db: {
        runReadOnlyQuery: async () => {
          throw new Error("should not execute");
        }
      } as never
    };

    const result = await runReadonlyQuery(context, { query: "delete from users" });

    expect(result.ok).toBe(false);
    const [line] = (await readFile(config.audit?.path ?? "", "utf8")).trim().split("\n");
    const event = JSON.parse(line);
    expect(event.allowed).toBe(false);
    expect(event.reason).toContain("DELETE");
  });

  it("executes allowed rewritten SQL and masks rows", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "safedb-test-"));
    const config = baseConfig({ audit: { path: path.join(dir, "audit.jsonl") } });
    let executed = "";
    const context: ToolContext = {
      config,
      policy: new AccessPolicy(config),
      audit: new AuditLogger(config.audit?.path),
      db: {
        runReadOnlyQuery: async (query: string) => {
          executed = query;
          return [{ id: 1, email: "nora@example.com" }];
        }
      } as never
    };

    const result = await runReadonlyQuery(context, { query: "select id, email from users" });

    expect(result.ok).toBe(true);
    expect(executed).toContain("AS safedb_readonly_query LIMIT 100");
    expect(result.data).toMatchObject({
      rows: [{ id: 1, email: "n***@example.com" }],
      row_count: 1
    });
  });
});
