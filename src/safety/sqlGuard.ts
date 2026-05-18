import type { DetectedTable, GuardResult, SafeDbConfig } from "../types.js";
import { AccessPolicy } from "./policy.js";

const COMMENT_PATTERN = /--|\/\*|\*\//;
const DANGEROUS_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "truncate",
  "create",
  "grant",
  "revoke",
  "copy",
  "call",
  "do",
  "merge",
  "vacuum",
  "analyze",
  "refresh",
  "reindex",
  "execute",
  "set",
  "reset"
];

const TABLE_PATTERNS = [
  /\bfrom\s+((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[a-zA-Z_][\w$]*))?)/gi,
  /\bjoin\s+((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[a-zA-Z_][\w$]*))?)/gi
];

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

  if (COMMENT_PATTERN.test(normalizedQuery)) {
    return {
      ...baseResult,
      reason: "SQL comments are blocked because they can make validation ambiguous."
    };
  }

  if (hasMultipleStatements(normalizedQuery)) {
    return { ...baseResult, reason: "Multiple SQL statements are not allowed." };
  }

  const strippedQuery = stripTrailingSemicolon(normalizedQuery);
  const lowerQuery = strippedQuery.toLowerCase();
  // This lexical denylist is intentionally broad. Until SafeDB has full Postgres AST
  // validation, false positives are safer than allowing a mutating statement through.
  const dangerousKeyword = DANGEROUS_KEYWORDS.find((keyword) =>
    new RegExp(`\\b${keyword}\\b`, "i").test(strippedQuery)
  );

  if (dangerousKeyword) {
    return {
      ...baseResult,
      reason: `Keyword "${dangerousKeyword.toUpperCase()}" is not allowed in read-only queries.`
    };
  }

  const isExplain = lowerQuery.startsWith("explain ");
  const explainAllowed = options.allowExplain ?? config.safety.allow_explain;
  if (isExplain && !explainAllowed) {
    return { ...baseResult, isExplain, reason: "EXPLAIN is disabled by policy." };
  }

  if (!startsWithAllowedRead(lowerQuery, isExplain)) {
    return {
      ...baseResult,
      isExplain,
      reason: "Only SELECT, WITH ... SELECT, and EXPLAIN SELECT statements are allowed."
    };
  }

  const queryForTableDetection = isExplain ? removeExplainPrefix(strippedQuery) : strippedQuery;
  const cteNames = extractCteNames(queryForTableDetection);
  const detectedTables = detectTables(queryForTableDetection).filter(
    (table) => table.schema || !cteNames.has(table.table.toLowerCase())
  );
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

  const requestedLimit = extractFirstLimit(strippedQuery);
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
  return query.trim().replace(/\s+/g, " ");
}

export function stripTrailingSemicolon(query: string): string {
  return query.replace(/;\s*$/, "").trim();
}

export function hasMultipleStatements(query: string): boolean {
  const semicolons = [...query.matchAll(/;/g)];
  if (semicolons.length === 0) {
    return false;
  }

  return semicolons.some((match) => match.index !== undefined && match.index < query.trim().length - 1);
}

export function startsWithAllowedRead(lowerQuery: string, isExplain: boolean): boolean {
  if (isExplain) {
    const explained = removeExplainPrefix(lowerQuery).trim();
    return explained.startsWith("select ") || startsWithReadOnlyCte(explained);
  }

  return lowerQuery.startsWith("select ") || startsWithReadOnlyCte(lowerQuery);
}

function startsWithReadOnlyCte(lowerQuery: string): boolean {
  if (!lowerQuery.startsWith("with ")) {
    return false;
  }

  return /\)\s*select\s/.test(lowerQuery);
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
  const tables = new Map<string, DetectedTable>();

  for (const pattern of TABLE_PATTERNS) {
    for (const match of query.matchAll(pattern)) {
      const parsed = parseTableName(match[1]);
      if (!parsed) {
        continue;
      }

      tables.set(`${parsed.schema ?? ""}.${parsed.table}`, parsed);
    }
  }

  return [...tables.values()];
}

function extractCteNames(query: string): Set<string> {
  const names = new Set<string>();
  if (!query.trim().toLowerCase().startsWith("with ")) {
    return names;
  }

  for (const match of query.matchAll(/\bwith\s+(?:recursive\s+)?("[^"]+"|[a-zA-Z_][\w$]*)\s+as\s*\(/gi)) {
    names.add(match[1].replaceAll('"', "").toLowerCase());
  }

  for (const match of query.matchAll(/\)\s*,\s*("[^"]+"|[a-zA-Z_][\w$]*)\s+as\s*\(/gi)) {
    names.add(match[1].replaceAll('"', "").toLowerCase());
  }

  return names;
}

function parseTableName(raw: string): DetectedTable | undefined {
  const cleaned = raw
    .split(/\s+/)[0]
    .replaceAll('"', "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);

  if (cleaned.length === 1) {
    return { table: cleaned[0] };
  }

  if (cleaned.length === 2) {
    return { schema: cleaned[0], table: cleaned[1] };
  }

  return undefined;
}
