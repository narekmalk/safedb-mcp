# Security Model

SafeDB MCP is a conservative policy gateway for AI database access. It reduces risk by combining least-privilege credentials, SQL validation, table allowlists, result limits, masking, and audit logs.

## Request Flow

1. The MCP client calls a SafeDB tool.
2. For query tools, SafeDB normalizes SQL and blocks comments, multiple statements, and dangerous keywords.
3. SafeDB accepts only `SELECT`, `WITH ... SELECT`, or `EXPLAIN SELECT` shapes.
4. SafeDB detects tables from `FROM` and `JOIN` clauses.
5. The access policy checks schemas, allowlists, and denylists.
6. `run_readonly_query` wraps the query in an outer `LIMIT`.
7. Postgres executes inside a read-only transaction with a local statement timeout.
8. Result rows are masked.
9. The query attempt is written to JSONL audit logs.

## Guardrails

SafeDB blocks:

- `INSERT`, `UPDATE`, `DELETE`
- `DROP`, `ALTER`, `TRUNCATE`, `CREATE`
- `GRANT`, `REVOKE`
- `COPY`, `CALL`, `DO`
- `MERGE`, `VACUUM`, `ANALYZE`, `REFRESH`, `REINDEX`, `EXECUTE`
- Multiple SQL statements
- SQL comments
- Tables outside the configured allowlist
- Explicitly denied tables
- Ambiguous queries where no table can be detected

## Limitations

The MVP uses conservative lexical validation and table detection instead of a complete Postgres AST. This means it can block safe queries that contain suspicious tokens in strings, complex CTEs, unusual quoting, functions, or nested constructs.

It can also miss semantic details that a real parser would understand. For that reason, SafeDB should be paired with:

- A dedicated read-only database role
- No access to sensitive tables unless intentionally allowlisted
- Database-level statement timeout defaults
- Separate credentials for production and development
- Regular review of audit logs

Do not treat SafeDB MCP as a sandbox for untrusted SQL. Treat it as a defense-in-depth layer for trusted teams using AI agents.

## Sensitive Data

Masking is applied to returned rows after execution. For the MVP, masking is based on returned column names and optional single-table hints. Agents should not be allowed to query sensitive columns unless a mask is configured and tested.

Future versions should add AST-backed projection enforcement and alias tracking.
