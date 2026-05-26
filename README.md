# SafeDB MCP

[![CI](https://github.com/narekmalk/safedb-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/narekmalk/safedb-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40safedb%2Fsafedb-mcp)](https://www.npmjs.com/package/@safedb/safedb-mcp)
[![safedb-mcp MCP server](https://glama.ai/mcp/servers/narekmalk/safedb-mcp/badges/score.svg)](https://glama.ai/mcp/servers/narekmalk/safedb-mcp)

SafeDB MCP is a secure Model Context Protocol server that lets AI agents inspect and query Postgres, MySQL, MariaDB, and SQLite with strict read-only guardrails. It is designed for teams that want useful database access without handing an agent unrestricted production credentials.

Direct database credentials are dangerous for agents because a single bad prompt, tool call, or generated SQL statement can mutate data, exfiltrate sensitive columns, or run expensive queries. SafeDB MCP puts a policy layer between the agent and your database: only configured schemas and tables are visible, SQL is parsed and validated before execution, row counts are capped, results are masked, and every query attempt is audited.

This project is an MVP. It prefers false positives and blocked queries over unsafe access, and it does not claim perfect SQL security.

## Features

- MCP tools: `list_schemas`, `list_tables`, `describe_table`, `run_readonly_query`, `explain_query`, `get_safedb_policy`
- Postgres support through `pg`
- MySQL and MariaDB support through `mysql2`
- SQLite file support through `sql.js`
- YAML or JSON config with environment expansion
- AST-backed read-only SQL guardrails for `SELECT`, `WITH ... SELECT`, `UNION`, and `EXPLAIN SELECT`
- Table detection through joins, CTEs, nested subqueries, aliases, and unions
- Column projection checks that block masked fields selected through aliases or expressions
- Configurable table allowlists, denylists, row limits, and statement timeout
- PII masking: `redact`, `email`, `partial`, and deterministic `hash`
- JSONL audit log with no raw result data
- CLI binary: `safedb-mcp`
- TypeScript, Vitest, ESLint, Prettier

## Quickstart

```bash
npx @safedb/safedb-mcp init --output safedb.yaml
DATABASE_URL=postgres://readonly:password@localhost:5432/app npx @safedb/safedb-mcp validate-config --config safedb.yaml
DATABASE_URL=postgres://readonly:password@localhost:5432/app npx @safedb/safedb-mcp test-connection --config safedb.yaml
DATABASE_URL=postgres://readonly:password@localhost:5432/app npx @safedb/safedb-mcp --config safedb.yaml
```

Use a dedicated database role with read-only permissions. SafeDB MCP is a defense-in-depth layer, not a replacement for least-privilege database credentials.

## Docker

A Docker image packages SafeDB MCP with Node.js and its production dependencies so it can run the same way on any host with Docker.

Build the image locally:

```bash
docker build -t safedb-mcp .
```

Run the MCP server with a mounted config file:

```bash
docker run --rm -i \
  -e DATABASE_URL=postgres://readonly:password@host.docker.internal:5432/app \
  -v "$PWD/safedb.yaml:/config/safedb.yaml:ro" \
  safedb-mcp
```

Pass CLI commands after the image name:

```bash
docker run --rm \
  -e DATABASE_URL=postgres://readonly:password@host.docker.internal:5432/app \
  -v "$PWD/safedb.yaml:/config/safedb.yaml:ro" \
  safedb-mcp --config /config/safedb.yaml validate-config
```

## Example Config

```yaml
database:
  type: postgres
  url: ${DATABASE_URL}

safety:
  default_limit: 100
  max_limit: 1000
  statement_timeout_ms: 5000
  allow_explain: true

access:
  schemas:
    public:
      allow_tables:
        - users
        - orders
        - products
      deny_tables:
        - secrets
      column_masks:
        users.email: email
        users.phone: partial
        users.password_hash: redact
        users.ssn: redact

audit:
  path: safedb-audit.jsonl
```

For MySQL or MariaDB, set `database.type` and use the database name as the access schema:

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
      deny_tables:
        - secrets
```

For SQLite, set `database.type` to `sqlite`, point `database.path` at the `.db` file, and use `main` as the access schema:

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
      deny_tables:
        - secrets
```

## MCP Client Config

Claude Desktop:

```json
{
  "mcpServers": {
    "safedb": {
      "command": "safedb-mcp",
      "args": ["--config", "/absolute/path/to/safedb.yaml"],
      "env": {
        "DATABASE_URL": "postgres://readonly:password@localhost:5432/app"
      }
    }
  }
}
```

Cursor or Hermes-style MCP config:

```json
{
  "servers": {
    "safedb": {
      "command": "safedb-mcp",
      "args": ["--config", "/absolute/path/to/safedb.yaml"],
      "env": {
        "DATABASE_URL": "postgres://readonly:password@localhost:5432/app"
      }
    }
  }
}
```

## Security Guarantees

SafeDB MCP aims to guarantee that:

- Only configured schemas and tables are inspectable or queryable through the MCP tools.
- SQL is parsed before execution, and mutating statement types or multiple statements are blocked.
- Table access policy is checked against real tables found through joins, CTEs, nested subqueries, aliases, and unions.
- Masked columns cannot be selected through aliases or expressions that would bypass response masking.
- Query execution happens inside a read-only transaction with a local statement timeout where the driver supports it.
- Returned rows are capped by an outer `LIMIT`.
- Configured PII fields are masked before tool responses are returned.
- Audit logs record attempts, decisions, detected tables, row counts, and duration without logging raw result rows.
- Passwords and secrets are not intentionally logged.

## Non-Goals

- Formal proof of query safety.
- Support for every valid dialect-specific read-only SQL construct.
- Write operations, migrations, stored procedure execution, or `COPY`.

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

## Roadmap

- Per-tool and per-table rate limits.
- Optional OpenTelemetry traces.
- Signed audit logs.
- Published Docker image and Helm chart.

## License

MIT
