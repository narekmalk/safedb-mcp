import { describe, expect, it } from "vitest";
import { maskRows, maskValue } from "../src/masking/mask.js";
import { AccessPolicy } from "../src/safety/policy.js";
import { baseConfig } from "./fixtures.js";

describe("masking", () => {
  it("masks configured PII fields", () => {
    const config = baseConfig();
    const policy = new AccessPolicy(config);

    const rows = maskRows(
      [
        {
          email: "nora@example.com",
          phone: "1234567890",
          password_hash: "secret",
          id: 1
        }
      ],
      policy,
      config,
      { schema: "public", table: "users" }
    );

    expect(rows[0]).toMatchObject({
      email: "n***@example.com",
      phone: "12***90",
      password_hash: "[REDACTED]",
      id: 1
    });
  });

  it("creates deterministic hashes", () => {
    expect(maskValue("customer-1", "hash", "salt")).toBe(maskValue("customer-1", "hash", "salt"));
    expect(maskValue("customer-1", "hash", "salt")).not.toBe(
      maskValue("customer-1", "hash", "other")
    );
  });
});
