# SafeDB MCP

SafeDB MCP is a secure Model Context Protocol server that lets AI agents inspect and query Postgres with strict read-only guardrails. It is designed for teams that want useful database access without handing an agent unrestricted production credentials.

Direct database credentials are dangerous for agents because a single bad prompt, tool call, or generated SQL statement can mutate data, exfiltrate sensitive columns, or run expensive queries. SafeDB MCP puts a policy layer between the agent and Postgres: only configured schemas and tables are visible, SQL is conservatively validated, row counts are capped, results are masked, and every query attempt is audited.

This project is an MVP. It prefers false positives and blocked queries over unsafe access, and it does not claim perfect SQL security.

## Features

- MCP tools: `list_schemas`, `list_tables`, `describe_table`, `run_readonly_query`, `explain_query`, `get_safedb_policy`
- Postgres support through `pg`
- YAML or JSON config with environment expansion
- Read-only SQL guardrails for `SELECT`, `WITH ... SELECT`, and `EXPLAIN SELECT`
- Configurable table allowlists, denylists, row limits, and statement timeout
- PII masking: `redact`, `email`, `partial`, and deterministic `hash`
- JSONL audit log with no raw result data
- CLI binary: `safedb-mcp`
- TypeScript, Vitest, ESLint, Prettier

## Quickstart

```bash
npm install
npm run build
npx safedb-mcp init --output safedb.yaml
DATABASE_URL=postgres://readonly:password@localhost:5432/app npx safedb-mcp validate-config --config safedb.yaml
DATABASE_URL=postgres://readonly:password@localhost:5432/app npx safedb-mcp test-connection --config safedb.yaml
DATABASE_URL=postgres://readonly:password@localhost:5432/app npx safedb-mcp --config safedb.yaml
```

Use a dedicated Postgres role with database-level read-only permissions. SafeDB MCP is a defense-in-depth layer, not a replacement for least-privilege database credentials.

## Example Config

```yaml
database:
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
- Mutating SQL keywords and multiple statements are blocked before execution.
- Query execution happens inside a read-only transaction with a local `statement_timeout`.
- Returned rows are capped by an outer `LIMIT`.
- Configured PII fields are masked before tool responses are returned.
- Audit logs record attempts, decisions, detected tables, row counts, and duration without logging raw result rows.
- Passwords and secrets are not intentionally logged.

## Non-Goals

- Perfect SQL parsing or formal proof of query safety.
- Support for every valid Postgres read-only construct.
- Write operations, migrations, stored procedure execution, or `COPY`.
- Cross-database support in the first version.

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

## Roadmap

- Integrate a mature Postgres AST parser for more accurate table and CTE analysis.
- Column-level projection enforcement so masked fields cannot be bypassed with aliases.
- Per-tool and per-table rate limits.
- Optional OpenTelemetry traces.
- MySQL and SQLite adapters.
- Signed audit logs.
- Docker image and Helm chart.

## License

MIT
