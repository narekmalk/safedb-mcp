import type { SafeDbConfig } from "../src/types.js";

export function baseConfig(overrides: Partial<SafeDbConfig> = {}): SafeDbConfig {
  return {
    database: {
      url: "postgres://user:pass@example.test:5432/app"
    },
    safety: {
      default_limit: 100,
      max_limit: 1000,
      statement_timeout_ms: 5000,
      allow_explain: true
    },
    access: {
      schemas: {
        public: {
          allow_tables: ["users", "orders", "products"],
          deny_tables: ["secrets"],
          column_masks: {
            "users.email": "email",
            "users.phone": "partial",
            "users.password_hash": "redact",
            "users.ssn": "redact",
            "users.customer_id": "hash"
          }
        }
      }
    },
    audit: {
      path: "safedb-audit.jsonl"
    },
    masking: {
      hash_salt: "test-salt"
    },
    ...overrides
  };
}
