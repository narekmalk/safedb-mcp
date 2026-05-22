import { parse } from "pgsql-ast-parser";
import type { Statement } from "pgsql-ast-parser";
import type { DetectedTable, GuardResult, SafeDbConfig } from "../types.js";
import { AccessPolicy } from "./policy.js";

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
  const parseResult = parseReadonlyStatement(queryForAnalysis);
  if (!parseResult.allowed || !parseResult.statement) {
    return {
      ...baseResult,
      isExplain,
      reason: parseResult.reason
    };
  }

  const detectedTables = detectTablesFromStatement(parseResult.statement);
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

  const requestedLimit = extractStatementLimit(parseResult.statement);
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
    return parseSql(stripTrailingSemicolon(query)).length > 1;
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

export function detectTables(query: string): DetectedTable[] {
  const result = parseReadonlyStatement(query);
  if (!result.statement) {
    return [];
  }

  return detectTablesFromStatement(result.statement);
}

function parseReadonlyStatement(query: string): {
  allowed: boolean;
  reason?: string;
  statement?: Statement;
} {
  let statements: Statement[];
  try {
    statements = parseSql(query);
  } catch (error) {
    return {
      allowed: false,
      reason: `SQL could not be parsed: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (statements.length !== 1) {
    return {
      allowed: false,
      reason: "Multiple SQL statements are not allowed."
    };
  }

  const [statement] = statements;
  if (!isReadonlyStatement(statement)) {
    return {
      allowed: false,
      reason: `Statement type "${statementType(statement).toUpperCase()}" is not allowed in read-only queries.`
    };
  }

  return {
    allowed: true,
    statement
  };
}

function parseSql(query: string): Statement[] {
  return parse(stripTrailingSemicolon(query)) as Statement[];
}

function isReadonlyStatement(statement: unknown): boolean {
  if (!isAstNode(statement)) {
    return false;
  }

  switch (statement.type) {
    case "select":
      return statement.for === undefined;
    case "union":
    case "union all":
      return isReadonlyStatement(statement.left) && isReadonlyStatement(statement.right);
    case "with":
      return (
        Array.isArray(statement.bind) &&
        statement.bind.every((binding) => isReadonlyStatement(binding.statement)) &&
        isReadonlyStatement(statement.in)
      );
    case "with recursive":
      return isReadonlyStatement(statement.bind) && isReadonlyStatement(statement.in);
    default:
      return false;
  }
}

function detectTablesFromStatement(statement: Statement): DetectedTable[] {
  const tables = new Map<string, DetectedTable>();
  collectTables(statement, new Set(), tables);
  return [...tables.values()];
}

function collectTables(node: unknown, cteNames: Set<string>, tables: Map<string, DetectedTable>): void {
  if (!node) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectTables(item, cteNames, tables);
    }
    return;
  }

  if (!isAstNode(node)) {
    return;
  }

  if (node.type === "with") {
    const scopedCtes = new Set(cteNames);
    for (const binding of arrayValue(node.bind)) {
      collectTables(binding.statement, scopedCtes, tables);
      const alias = readName(binding.alias);
      if (alias) {
        scopedCtes.add(alias.toLowerCase());
      }
    }

    collectTables(node.in, scopedCtes, tables);
    return;
  }

  if (node.type === "with recursive") {
    const scopedCtes = new Set(cteNames);
    const alias = readName(node.alias);
    if (alias) {
      scopedCtes.add(alias.toLowerCase());
    }

    collectTables(node.bind, scopedCtes, tables);
    collectTables(node.in, scopedCtes, tables);
    return;
  }

  if (node.type === "table") {
    const parsed = parseTableName(node.name);
    if (parsed && (parsed.schema || !cteNames.has(parsed.table.toLowerCase()))) {
      tables.set(`${parsed.schema ?? ""}.${parsed.table}`, parsed);
    }
    collectTables(node.join, cteNames, tables);
    return;
  }

  for (const value of Object.values(node)) {
    collectTables(value, cteNames, tables);
  }
}

function extractStatementLimit(statement: unknown): number | undefined {
  if (!isAstNode(statement)) {
    return undefined;
  }

  if (statement.type === "with") {
    return extractStatementLimit(statement.in);
  }

  if (statement.type === "with recursive") {
    return extractStatementLimit(statement.in);
  }

  if (statement.type === "select") {
    const limit = statement.limit;
    if (isRecord(limit) && isAstNode(limit.limit) && limit.limit.type === "integer") {
      return Number(limit.limit.value);
    }
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
