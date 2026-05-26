import nodeSqlParser from "node-sql-parser";
import { parse } from "pgsql-ast-parser";
import type { Parser as NodeSqlParser } from "node-sql-parser";
import type { Statement } from "pgsql-ast-parser";
import { databaseDriver, type DatabaseDriver, type DetectedTable, type GuardResult, type SafeDbConfig } from "../types.js";
import { AccessPolicy } from "./policy.js";

const { Parser } = nodeSqlParser as unknown as { Parser: new () => NodeSqlParser };
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

  const projectionCheck = checkMaskedProjectionAliases(
    parseResult.statement,
    parseResult.driver,
    detectedTables,
    policy
  );
  if (!projectionCheck.allowed) {
    return {
      ...baseResult,
      isExplain,
      detectedTables,
      reason: projectionCheck.reason
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

interface ProjectionCheck {
  allowed: boolean;
  reason?: string;
}

interface ColumnLineage {
  masked: boolean;
  sourceColumn: string;
}

interface ProjectionSource {
  columns?: Map<string, ColumnLineage>;
  maskedColumns?: Set<string>;
}

function checkMaskedProjectionAliases(
  statement: unknown,
  driver: DatabaseDriver,
  detectedTables: DetectedTable[],
  policy: AccessPolicy
): ProjectionCheck {
  const context = {
    canMaskOutput: (column: string) => detectedTables.length === 1 || policy.hasGlobalMask(column),
    policy
  };

  const result =
    driver === "postgres"
      ? analyzePostgresProjection(statement, new Map(), context)
      : analyzeMySqlProjection(statement, new Map(), context);

  return result.reason ? { allowed: false, reason: result.reason } : { allowed: true };
}

function analyzePostgresProjection(
  statement: unknown,
  ctes: Map<string, Map<string, ColumnLineage>>,
  context: { canMaskOutput: (column: string) => boolean; policy: AccessPolicy }
): { columns: Map<string, ColumnLineage>; reason?: string } {
  if (!isAstNode(statement)) {
    return { columns: new Map() };
  }

  if (statement.type === "with") {
    const scoped = new Map(ctes);
    for (const binding of arrayValue(statement.bind)) {
      const analyzed = analyzePostgresProjection(binding.statement, scoped, context);
      if (analyzed.reason) {
        return analyzed;
      }

      const alias = readName(binding.alias);
      if (alias) {
        scoped.set(alias.toLowerCase(), analyzed.columns);
      }
    }

    return analyzePostgresProjection(statement.in, scoped, context);
  }

  if (statement.type === "with recursive") {
    const analyzed = analyzePostgresProjection(statement.bind, ctes, context);
    if (analyzed.reason) {
      return analyzed;
    }

    const scoped = new Map(ctes);
    const alias = readName(statement.alias);
    if (alias) {
      scoped.set(alias.toLowerCase(), analyzed.columns);
    }

    return analyzePostgresProjection(statement.in, scoped, context);
  }

  if (statement.type === "union" || statement.type === "union all") {
    const left = analyzePostgresProjection(statement.left, ctes, context);
    if (left.reason) {
      return left;
    }
    return analyzePostgresProjection(statement.right, ctes, context);
  }

  if (statement.type !== "select") {
    return { columns: new Map() };
  }

  const sources = buildPostgresProjectionSources(statement, ctes, context);
  if (sources.reason) {
    return { columns: new Map(), reason: sources.reason };
  }

  return analyzeProjectionColumns(arrayValue(statement.columns), sources.sources, context);
}

function buildPostgresProjectionSources(
  statement: Record<string, unknown>,
  ctes: Map<string, Map<string, ColumnLineage>>,
  context: { canMaskOutput: (column: string) => boolean; policy: AccessPolicy }
): { sources: Map<string, ProjectionSource>; reason?: string } {
  const sources = new Map<string, ProjectionSource>();

  for (const from of arrayValue(statement.from)) {
    if (from.type === "statement") {
      const analyzed = analyzePostgresProjection(from.statement, ctes, context);
      if (analyzed.reason) {
        return { sources, reason: analyzed.reason };
      }
      sources.set(String(from.alias).toLowerCase(), { columns: analyzed.columns });
      continue;
    }

    if (from.type !== "table") {
      continue;
    }

    const table = parseTableName(from.name);
    if (!table) {
      continue;
    }

    const cte = !table.schema ? ctes.get(table.table.toLowerCase()) : undefined;
    if (cte) {
      sources.set(table.table.toLowerCase(), { columns: cte });
      continue;
    }

    const schema = context.policy.resolveTableSchema(table);
    const maskedColumns = new Set(context.policy.maskedColumnsForTable(schema, table.table));
    sources.set(table.table.toLowerCase(), { maskedColumns });
    const alias = isRecord(from.name) ? readName(from.name.alias) : undefined;
    if (alias) {
      sources.set(alias.toLowerCase(), { maskedColumns });
    }
  }

  return { sources };
}

function analyzeMySqlProjection(
  statement: unknown,
  ctes: Map<string, Map<string, ColumnLineage>>,
  context: { canMaskOutput: (column: string) => boolean; policy: AccessPolicy }
): { columns: Map<string, ColumnLineage>; reason?: string } {
  if (!isRecord(statement) || statement.type !== "select") {
    return { columns: new Map() };
  }

  const scoped = new Map(ctes);
  for (const binding of arrayValue(statement.with)) {
    const analyzed = analyzeMySqlProjection(readStatementAst(binding.stmt), scoped, context);
    if (analyzed.reason) {
      return analyzed;
    }

    const alias = readMySqlCteName(binding.name);
    if (alias) {
      scoped.set(alias.toLowerCase(), analyzed.columns);
    }
  }

  const sources = buildMySqlProjectionSources(statement, scoped, context);
  if (sources.reason) {
    return { columns: new Map(), reason: sources.reason };
  }

  const analyzed = analyzeProjectionColumns(arrayValue(statement.columns), sources.sources, context);
  if (analyzed.reason) {
    return analyzed;
  }

  if (statement._next) {
    const next = analyzeMySqlProjection(statement._next, scoped, context);
    if (next.reason) {
      return next;
    }
  }

  return analyzed;
}

function buildMySqlProjectionSources(
  statement: Record<string, unknown>,
  ctes: Map<string, Map<string, ColumnLineage>>,
  context: { canMaskOutput: (column: string) => boolean; policy: AccessPolicy }
): { sources: Map<string, ProjectionSource>; reason?: string } {
  const sources = new Map<string, ProjectionSource>();

  for (const from of arrayValue(statement.from)) {
    if (isRecord(from.expr)) {
      const analyzed = analyzeMySqlProjection(readStatementAst(from.expr), ctes, context);
      if (analyzed.reason) {
        return { sources, reason: analyzed.reason };
      }
      if (typeof from.as === "string") {
        sources.set(from.as.toLowerCase(), { columns: analyzed.columns });
      }
      continue;
    }

    const table = parseMySqlTableName(from);
    if (!table) {
      continue;
    }

    const cte = !table.schema ? ctes.get(table.table.toLowerCase()) : undefined;
    if (cte) {
      sources.set(table.table.toLowerCase(), { columns: cte });
      continue;
    }

    const schema = context.policy.resolveTableSchema(table);
    const maskedColumns = new Set(context.policy.maskedColumnsForTable(schema, table.table));
    sources.set(table.table.toLowerCase(), { maskedColumns });
    if (typeof from.as === "string") {
      sources.set(from.as.toLowerCase(), { maskedColumns });
    }
  }

  return { sources };
}

function analyzeProjectionColumns(
  columns: Record<string, unknown>[],
  sources: Map<string, ProjectionSource>,
  context: { canMaskOutput: (column: string) => boolean }
): { columns: Map<string, ColumnLineage>; reason?: string } {
  const output = new Map<string, ColumnLineage>();

  for (const column of columns) {
    const expr = column.expr;
    const alias = readName(column.alias) ?? readName(column.as);

    if (isStarRef(expr)) {
      for (const [name, lineage] of expandStarLineage(expr, sources)) {
        if (lineage.masked && !context.canMaskOutput(lineage.sourceColumn)) {
          return {
            columns: output,
            reason: `Masked column "${lineage.sourceColumn}" cannot be projected from multi-table queries without a global mask.`
          };
        }
        output.set(name, lineage);
      }
      continue;
    }

    if (isColumnRef(expr)) {
      const lineage = resolveColumnLineage(expr, sources);
      const outputName = alias ?? columnRefName(expr);
      if (lineage?.masked) {
        const reason = validateMaskedOutput(lineage, outputName, context.canMaskOutput);
        if (reason) {
          return { columns: output, reason };
        }
      }

      if (outputName && lineage) {
        output.set(outputName, lineage);
      }
      continue;
    }

    const maskedRefs = collectMaskedColumnRefs(expr, sources);
    if (maskedRefs.length > 0) {
      return {
        columns: output,
        reason: `Masked column "${maskedRefs[0].sourceColumn}" cannot be selected inside expressions.`
      };
    }
  }

  return { columns: output };
}

function validateMaskedOutput(
  lineage: ColumnLineage,
  outputName: string | undefined,
  canMaskOutput: (column: string) => boolean
): string | undefined {
  if (!canMaskOutput(lineage.sourceColumn)) {
    return `Masked column "${lineage.sourceColumn}" cannot be projected from multi-table queries without a global mask.`;
  }

  if (outputName !== lineage.sourceColumn) {
    return `Masked column "${lineage.sourceColumn}" cannot be selected through alias "${outputName ?? "unknown"}".`;
  }

  return undefined;
}

function collectMaskedColumnRefs(expr: unknown, sources: Map<string, ProjectionSource>): ColumnLineage[] {
  if (!expr) {
    return [];
  }

  if (Array.isArray(expr)) {
    return expr.flatMap((item) => collectMaskedColumnRefs(item, sources));
  }

  if (!isRecord(expr)) {
    return [];
  }

  const lineage = isColumnRef(expr) ? resolveColumnLineage(expr, sources) : undefined;
  const own = lineage?.masked ? [lineage] : [];
  return own.concat(Object.values(expr).flatMap((value) => collectMaskedColumnRefs(value, sources)));
}

function resolveColumnLineage(expr: unknown, sources: Map<string, ProjectionSource>): ColumnLineage | undefined {
  const column = columnRefName(expr);
  if (!column || column === "*") {
    return undefined;
  }

  const table = columnRefTable(expr);
  if (table) {
    return lineageFromSource(sources.get(table.toLowerCase()), column);
  }

  if (sources.size === 1) {
    const [source] = sources.values();
    return lineageFromSource(source, column);
  }

  return undefined;
}

function lineageFromSource(source: ProjectionSource | undefined, column: string): ColumnLineage | undefined {
  if (!source) {
    return undefined;
  }

  const derived = source.columns?.get(column);
  if (derived) {
    return derived;
  }

  return {
    masked: source.maskedColumns?.has(column) ?? false,
    sourceColumn: column
  };
}

function expandStarLineage(
  expr: unknown,
  sources: Map<string, ProjectionSource>
): Array<[string, ColumnLineage]> {
  const table = columnRefTable(expr);
  const selectedSources = table
    ? [sources.get(table.toLowerCase())].filter((source): source is ProjectionSource => Boolean(source))
    : [...sources.values()];
  const output: Array<[string, ColumnLineage]> = [];

  for (const source of selectedSources) {
    if (source.columns) {
      output.push(...source.columns.entries());
    }

    for (const column of source.maskedColumns ?? []) {
      output.push([column, { masked: true, sourceColumn: column }]);
    }
  }

  return output;
}

function isStarRef(expr: unknown): boolean {
  return isColumnRef(expr) && columnRefName(expr) === "*";
}

function isColumnRef(expr: unknown): boolean {
  return isRecord(expr) && (expr.type === "ref" || expr.type === "column_ref");
}

function columnRefName(expr: unknown): string | undefined {
  if (!isRecord(expr)) {
    return undefined;
  }

  return readName(expr.name) ?? readName(expr.column);
}

function columnRefTable(expr: unknown): string | undefined {
  if (!isRecord(expr)) {
    return undefined;
  }

  return readName(expr.table);
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
