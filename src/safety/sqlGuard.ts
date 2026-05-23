import { Parser } from "node-sql-parser";
import { parse } from "pgsql-ast-parser";
import type { Statement } from "pgsql-ast-parser";
import { databaseDriver, type DatabaseDriver, type DetectedTable, type GuardResult, type SafeDbConfig } from "../types.js";
import { AccessPolicy } from "./policy.js";

const mySqlParser = new Parser();

export interface GuardOptions {
  allowExplain?: boolean;
}

export function validateReadonlyQuery(
  query: string,
  config: SafeDbConfig,
  policy = new AccessPolicy(config),
  options: GuardOptions = {}
): GuardResult {
  const normalizedQuery = normalizeQuery(query);
  const baseResult: GuardResult = {
    allowed: false,
    normalizedQuery,
    detectedTables: [],
    limit: config.safety.default_limit,
    isExplain: false
  };

  if (!normalizedQuery) {
    return { ...baseResult, reason: "Query is empty." };
  }

  const strippedQuery = stripTrailingSemicolon(normalizedQuery);
  const lowerQuery = strippedQuery.toLowerCase();
  const isExplain = lowerQuery.startsWith("explain ");
  const explainAllowed = options.allowExplain ?? config.safety.allow_explain;
  if (isExplain && !explainAllowed) {
    return { ...baseResult, isExplain, reason: "EXPLAIN is disabled by policy." };
  }

  const queryForAnalysis = isExplain ? removeExplainPrefix(strippedQuery) : strippedQuery;
  const parseResult = parseReadonlyStatement(queryForAnalysis, config);
  if (!parseResult.allowed || !parseResult.statement) {
    return {
      ...baseResult,
      isExplain,
      reason: parseResult.reason
    };
  }

  const detectedTables = detectTablesFromStatement(parseResult.statement, parseResult.driver);
  const tableCheck = policy.checkTables(detectedTables);
  if (!tableCheck.allowed) {
    return {
      ...baseResult,
      isExplain,
      detectedTables,
      reason: tableCheck.reason
    };
  }

  if (isExplain) {
    return {
      allowed: true,
      normalizedQuery,
      executableQuery: strippedQuery,
      detectedTables,
      limit: 0,
      isExplain
    };
  }

  const requestedLimit = extractStatementLimit(parseResult.statement, parseResult.driver);
  const limit =
    requestedLimit === undefined
      ? config.safety.default_limit
      : Math.min(requestedLimit, config.safety.max_limit);

  return {
    allowed: true,
    normalizedQuery,
    // The outer SELECT caps rows even when a model supplied a larger inner LIMIT.
    executableQuery: wrapWithLimit(strippedQuery, limit),
    detectedTables,
    limit,
    isExplain
  };
}

export function normalizeQuery(query: string): string {
  return query.trim();
}

export function stripTrailingSemicolon(query: string): string {
  return query.replace(/;\s*$/, "").trim();
}

export function hasMultipleStatements(query: string): boolean {
  try {
    return parsePostgresSql(stripTrailingSemicolon(query)).length > 1;
  } catch {
    return false;
  }
}

export function startsWithAllowedRead(lowerQuery: string, isExplain: boolean): boolean {
  const query = isExplain ? removeExplainPrefix(lowerQuery).trim() : lowerQuery;
  const result = parseReadonlyStatement(query);
  return result.allowed;
}

function removeExplainPrefix(query: string): string {
  return query.replace(/^explain\s*(?:\([^)]*\)\s*)?/i, "");
}

export function extractFirstLimit(query: string): number | undefined {
  const match = /\blimit\s+(\d+)\b/i.exec(query);
  if (!match) {
    return undefined;
  }

  return Number(match[1]);
}

export function wrapWithLimit(query: string, limit: number): string {
  return `SELECT * FROM (${query}) AS safedb_readonly_query LIMIT ${limit}`;
}

export function detectTables(query: string, config?: SafeDbConfig): DetectedTable[] {
  const result = parseReadonlyStatement(query, config);
  if (!result.statement) {
    return [];
  }

  return detectTablesFromStatement(result.statement, result.driver);
}

function parseReadonlyStatement(query: string, config?: SafeDbConfig): {
  allowed: boolean;
  reason?: string;
  statement?: unknown;
  driver: DatabaseDriver;
};
function parseReadonlyStatement(
  query: string,
  config?: SafeDbConfig
): {
  allowed: boolean;
  reason?: string;
  statement?: unknown;
  driver: DatabaseDriver;
} {
  const driver = config ? databaseDriver(config) : "postgres";
  let statements: unknown[];
  try {
    statements = parseSql(query, driver);
  } catch (error) {
    return {
      allowed: false,
      reason: `SQL could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      driver
    };
  }

  if (statements.length !== 1) {
    return {
      allowed: false,
      reason: "Multiple SQL statements are not allowed.",
      driver
    };
  }

  const [statement] = statements;
  if (!isReadonlyStatement(statement, driver)) {
    return {
      allowed: false,
      reason: `Statement type "${statementType(statement).toUpperCase()}" is not allowed in read-only queries.`,
      driver
    };
  }

  return {
    allowed: true,
    statement,
    driver
  };
}

function parseSql(query: string, driver: DatabaseDriver): unknown[] {
  if (driver === "postgres") {
    return parsePostgresSql(query);
  }

  const ast = mySqlParser.astify(stripTrailingSemicolon(query), {
    database: driver === "sqlite" ? "sqlite" : "mysql"
  });
  return Array.isArray(ast) ? ast : [ast];
}

function parsePostgresSql(query: string): Statement[] {
  return parse(stripTrailingSemicolon(query)) as Statement[];
}

function isReadonlyStatement(statement: unknown, driver: DatabaseDriver): boolean {
  return driver === "postgres" ? isReadonlyPostgresStatement(statement) : isReadonlyMySqlStatement(statement);
}

function isReadonlyPostgresStatement(statement: unknown): boolean {
  if (!isAstNode(statement)) {
    return false;
  }

  switch (statement.type) {
    case "select":
      return statement.for === undefined;
    case "union":
    case "union all":
      return isReadonlyPostgresStatement(statement.left) && isReadonlyPostgresStatement(statement.right);
    case "with":
      return (
        Array.isArray(statement.bind) &&
        statement.bind.every((binding) => isReadonlyPostgresStatement(binding.statement)) &&
        isReadonlyPostgresStatement(statement.in)
      );
    case "with recursive":
      return isReadonlyPostgresStatement(statement.bind) && isReadonlyPostgresStatement(statement.in);
    default:
      return false;
  }
}

function isReadonlyMySqlStatement(statement: unknown): boolean {
  if (!isAstNode(statement) || statement.type !== "select") {
    return false;
  }

  if (statement.locking_read || hasUnsafeMySqlInto(statement.into)) {
    return false;
  }

  const withBindings = arrayValue(statement.with);
  if (!withBindings.every((binding) => isReadonlyMySqlStatement(readStatementAst(binding.stmt)))) {
    return false;
  }

  return (
    mysqlNestedStatementsAreReadonly(statement) &&
    (statement._next === undefined || isReadonlyMySqlStatement(statement._next))
  );
}

function detectTablesFromStatement(statement: unknown, driver: DatabaseDriver): DetectedTable[] {
  const tables = new Map<string, DetectedTable>();
  if (driver === "postgres") {
    collectPostgresTables(statement, new Set(), tables);
  } else {
    collectMySqlTables(statement, new Set(), tables);
  }
  return [...tables.values()];
}

function collectPostgresTables(
  node: unknown,
  cteNames: Set<string>,
  tables: Map<string, DetectedTable>
): void {
  if (!node) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectPostgresTables(item, cteNames, tables);
    }
    return;
  }

  if (!isAstNode(node)) {
    return;
  }

  if (node.type === "with") {
    const scopedCtes = new Set(cteNames);
    for (const binding of arrayValue(node.bind)) {
      collectPostgresTables(binding.statement, scopedCtes, tables);
      const alias = readName(binding.alias);
      if (alias) {
        scopedCtes.add(alias.toLowerCase());
      }
    }

    collectPostgresTables(node.in, scopedCtes, tables);
    return;
  }

  if (node.type === "with recursive") {
    const scopedCtes = new Set(cteNames);
    const alias = readName(node.alias);
    if (alias) {
      scopedCtes.add(alias.toLowerCase());
    }

    collectPostgresTables(node.bind, scopedCtes, tables);
    collectPostgresTables(node.in, scopedCtes, tables);
    return;
  }

  if (node.type === "table") {
    const parsed = parseTableName(node.name);
    if (parsed && (parsed.schema || !cteNames.has(parsed.table.toLowerCase()))) {
      tables.set(`${parsed.schema ?? ""}.${parsed.table}`, parsed);
    }
    collectPostgresTables(node.join, cteNames, tables);
    return;
  }

  for (const value of Object.values(node)) {
    collectPostgresTables(value, cteNames, tables);
  }
}

function collectMySqlTables(
  node: unknown,
  cteNames: Set<string>,
  tables: Map<string, DetectedTable>
): void {
  if (!node) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectMySqlTables(item, cteNames, tables);
    }
    return;
  }

  if (!isRecord(node)) {
    return;
  }

  if (node.type === "select") {
    const scopedCtes = new Set(cteNames);
    for (const binding of arrayValue(node.with)) {
      collectMySqlTables(readStatementAst(binding.stmt), scopedCtes, tables);
      const alias = readMySqlCteName(binding.name);
      if (alias) {
        scopedCtes.add(alias.toLowerCase());
      }
    }

    for (const from of arrayValue(node.from)) {
      if (isRecord(from.expr)) {
        collectMySqlTables(readStatementAst(from.expr), scopedCtes, tables);
        continue;
      }

      const parsed = parseMySqlTableName(from);
      if (parsed && (parsed.schema || !scopedCtes.has(parsed.table.toLowerCase()))) {
        tables.set(`${parsed.schema ?? ""}.${parsed.table}`, parsed);
      }
    }

    collectMySqlTables(node.where, scopedCtes, tables);
    collectMySqlTables(node.having, scopedCtes, tables);
    collectMySqlTables(node._next, scopedCtes, tables);
    return;
  }

  for (const value of Object.values(node)) {
    collectMySqlTables(value, cteNames, tables);
  }
}

function extractStatementLimit(statement: unknown, driver: DatabaseDriver): number | undefined {
  return driver === "postgres" ? extractPostgresStatementLimit(statement) : extractMySqlStatementLimit(statement);
}

function extractPostgresStatementLimit(statement: unknown): number | undefined {
  if (!isAstNode(statement)) {
    return undefined;
  }

  if (statement.type === "with") {
    return extractPostgresStatementLimit(statement.in);
  }

  if (statement.type === "with recursive") {
    return extractPostgresStatementLimit(statement.in);
  }

  if (statement.type === "select") {
    const limit = statement.limit;
    if (isRecord(limit) && isAstNode(limit.limit) && limit.limit.type === "integer") {
      return Number(limit.limit.value);
    }
  }

  return undefined;
}

function extractMySqlStatementLimit(statement: unknown): number | undefined {
  if (!isRecord(statement)) {
    return undefined;
  }

  const limit = statement.limit;
  if (!isRecord(limit)) {
    return undefined;
  }

  const values = Array.isArray(limit.value) ? limit.value : [];
  const last = values[values.length - 1];
  if (isAstNode(last) && last.type === "number") {
    return Number(last.value);
  }

  return undefined;
}

function parseTableName(raw: unknown): DetectedTable | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const schema = readName(raw.schema);
  const table = readName(raw.name);

  if (table && schema) {
    return { schema, table };
  }

  if (table) {
    return { table };
  }

  return undefined;
}

function readName(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value) && typeof value.name === "string") {
    return value.name;
  }

  return undefined;
}

function readMySqlCteName(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value) && typeof value.value === "string") {
    return value.value;
  }

  return undefined;
}

function readStatementAst(value: unknown): unknown {
  return isRecord(value) && "ast" in value ? value.ast : value;
}

function parseMySqlTableName(raw: unknown): DetectedTable | undefined {
  if (!isRecord(raw) || typeof raw.table !== "string") {
    return undefined;
  }

  if (typeof raw.db === "string" && raw.db) {
    return { schema: raw.db, table: raw.table };
  }

  return { table: raw.table };
}

function hasUnsafeMySqlInto(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(([, fieldValue]) => fieldValue !== null && fieldValue !== undefined);
}

function mysqlNestedStatementsAreReadonly(value: unknown): boolean {
  if (!value) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(mysqlNestedStatementsAreReadonly);
  }

  if (!isRecord(value)) {
    return true;
  }

  if ("ast" in value && !isReadonlyMySqlStatement(value.ast)) {
    return false;
  }

  return Object.values(value).every(mysqlNestedStatementsAreReadonly);
}

function isAstNode(value: unknown): value is Record<string, unknown> & { type: string } {
  return isRecord(value) && typeof value.type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function statementType(statement: unknown): string {
  return isAstNode(statement) ? statement.type : "unknown";
}
