import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLogger, redactSecrets } from "../src/audit/auditLogger.js";

describe("AuditLogger", () => {
  it("writes JSONL events without result data", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "safedb-test-"));
    const auditPath = path.join(dir, "audit.jsonl");
    const logger = new AuditLogger(auditPath);

    await logger.log({
      tool_name: "run_readonly_query",
      allowed: true,
      normalized_query: "select * from users",
      tables_detected: ["public.users"],
      row_count: 2,
      duration_ms: 12
    });

    const [line] = (await readFile(auditPath, "utf8")).trim().split("\n");
    const event = JSON.parse(line);

    expect(event.tool_name).toBe("run_readonly_query");
    expect(event.allowed).toBe(true);
    expect(event.row_count).toBe(2);
    expect(event.rows).toBeUndefined();
    expect(event.timestamp).toBeTruthy();
  });

  it("redacts secrets in logged query text", () => {
    expect(redactSecrets("postgres://user:secret@example.test/db")).toBe(
      "postgres://user:[REDACTED]@example.test/db"
    );
    expect(redactSecrets("password=abc123")).toBe("password=[REDACTED]");
  });
});
