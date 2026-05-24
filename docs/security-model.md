# Security Model

SafeDB MCP is a conservative policy gateway for AI database access. It reduces risk by combining least-privilege credentials, AST-backed SQL validation, table allowlists, result limits, masking, and audit logs.

## Request Flow

1. The MCP client calls a SafeDB tool.
2. For query tools, SafeDB parses SQL using the configured database dialect.
3. SafeDB accepts only read-only `SELECT`, `WITH ... SELECT`, `UNION`, or `EXPLAIN SELECT` shapes.
4. SafeDB detects real tables through joins, CTEs, aliases, nested subqueries, and unions.
5. The access policy checks schemas, allowlists, and denylists.
6. SafeDB checks projected columns so configured masks cannot be bypassed with aliases or expressions.
7. `run_readonly_query` wraps the query in an outer `LIMIT`.
8. The database executes inside a read-only transaction with a local timeout where the driver supports it.
9. Result rows are masked.
10. The query attempt is written to JSONL audit logs.

## Guardrails

SafeDB blocks:

- Mutating statement types such as `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, and `CREATE`
- Multiple SQL statements
- Locking reads such as `SELECT ... FOR UPDATE`
- Tables outside the configured allowlist
- Explicitly denied tables
- Ambiguous queries where no table can be detected
- Masked columns selected through aliases, expressions, or multi-table projections that cannot be safely masked

## Limitations

SafeDB uses dialect parsers, but it is still a policy gateway rather than a formal SQL sandbox. Dialect edge cases, parser gaps, views, functions, permissions, and database-specific behavior still matter. SafeDB should be paired with:

- A dedicated read-only database role
- No access to sensitive tables unless intentionally allowlisted
- Database-level statement timeout defaults
- Separate credentials for production and development
- Regular review of audit logs

Do not treat SafeDB MCP as a sandbox for untrusted SQL. Treat it as a defense-in-depth layer for trusted teams using AI agents.

## Sensitive Data

Masking is applied to returned rows after execution. Masking is based on returned column names and optional single-table hints. The SQL guard also blocks masked columns when they are projected through aliases, expressions, or multi-table outputs that SafeDB cannot reliably tie back to a mask.
