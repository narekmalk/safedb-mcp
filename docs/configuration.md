# Configuration

SafeDB MCP accepts YAML or JSON config files. YAML is recommended because it is easier to read and supports the examples below.

Environment variables can be referenced with `${NAME}` or `${NAME:-fallback}`.

## Database

```yaml
database:
  type: postgres
  url: ${DATABASE_URL}
```

or:

```yaml
database:
  type: postgres
  host: localhost
  port: 5432
  database: app
  user: readonly
  password: ${PGPASSWORD}
  ssl: false
```

- `type`: `postgres`, `mysql`, `mariadb`, or `sqlite`. Defaults to `postgres`.

For MySQL or MariaDB, use the database name as the access schema:

```yaml
database:
  type: mysql
  url: ${DATABASE_URL}

access:
  schemas:
    app:
      allow_tables:
        - users
        - orders
```

SafeDB never intentionally logs database passwords or connection URLs. You should still use a dedicated database role with read-only grants.

For SQLite, use `database.path` and configure the `main` schema:

```yaml
database:
  type: sqlite
  path: ./app.db

access:
  schemas:
    main:
      allow_tables:
        - users
        - orders
```

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
- `statement_timeout_ms`: used as Postgres `statement_timeout` and as the MySQL/MariaDB query timeout.
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

Every queried table must be in an allowed schema and allowlisted table set. `deny_tables` wins over `allow_tables`. In MySQL and MariaDB, “schema” means the database name. In SQLite, use the `main` schema.

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
