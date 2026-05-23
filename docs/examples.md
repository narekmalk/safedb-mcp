# Examples

## Start the MCP Server

```bash
DATABASE_URL=postgres://readonly:password@localhost:5432/app safedb-mcp --config safedb.yaml
```

For MySQL or MariaDB, set `database.type` in `safedb.yaml` and use a MySQL-compatible URL:

```bash
DATABASE_URL=mysql://readonly:password@localhost:3306/app safedb-mcp --config safedb.yaml
```

## Initialize Config

```bash
safedb-mcp init --output safedb.yaml
```

## Validate Config

```bash
safedb-mcp validate-config --config safedb.yaml
```

## Test Connection

```bash
DATABASE_URL=postgres://readonly:password@localhost:5432/app safedb-mcp test-connection --config safedb.yaml
```

## Allowed Query

```sql
select id, email from public.users order by id desc
```

SafeDB executes it as:

```sql
SELECT * FROM (select id, email from public.users order by id desc) AS safedb_readonly_query LIMIT 100
```

## Blocked Query

```sql
delete from public.users where id = 1
```

SafeDB returns:

```json
{
  "ok": false,
  "error": {
    "code": "QUERY_BLOCKED",
    "message": "Statement type \"DELETE\" is not allowed in read-only queries."
  }
}
```

## Audit Event

```json
{
  "tool_name": "run_readonly_query",
  "allowed": true,
  "normalized_query": "select id, email from public.users",
  "tables_detected": ["public.users"],
  "row_count": 12,
  "duration_ms": 18,
  "timestamp": "2026-05-14T12:00:00.000Z"
}
```
