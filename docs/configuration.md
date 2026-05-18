# Configuration

SafeDB MCP accepts YAML or JSON config files. YAML is recommended because it is easier to read and supports the examples below.

Environment variables can be referenced with `${NAME}` or `${NAME:-fallback}`.

## Database

```yaml
database:
  url: ${DATABASE_URL}
```

or:

```yaml
database:
  host: localhost
  port: 5432
  database: app
  user: readonly
  password: ${PGPASSWORD}
  ssl: false
```

SafeDB never intentionally logs database passwords or connection URLs. You should still use a dedicated Postgres role with read-only grants.

## Safety

```yaml
safety:
  default_limit: 100
  max_limit: 1000
  statement_timeout_ms: 5000
  allow_explain: true
```

- `default_limit`: used when a query has no numeric `LIMIT`.
- `max_limit`: upper bound for returned rows.
- `statement_timeout_ms`: set with `set_config('statement_timeout', ..., true)` inside the read-only transaction.
- `allow_explain`: enables or disables the `explain_query` tool.

## Access

```yaml
access:
  schemas:
    public:
      allow_tables:
        - users
        - orders
      deny_tables:
        - secrets
      column_masks:
        users.email: email
        users.phone: partial
        users.password_hash: redact
```

Every queried table must be in an allowed schema and allowlisted table set. `deny_tables` wins over `allow_tables`.

Column masks can be configured as:

- `table.column`
- `schema.table.column`

## Audit

```yaml
audit:
  path: safedb-audit.jsonl
```

Audit events are JSONL and include timestamp, tool name, allow/block decision, normalized query, detected tables, row count, duration, and block reason when relevant. Raw result rows are never logged.

## Masking

```yaml
masking:
  hash_salt: change-me
```

Masking strategies:

- `redact`: `[REDACTED]`
- `email`: `n***@example.com`
- `partial`: first 2 and last 2 characters
- `hash`: deterministic SHA-256 with optional salt
