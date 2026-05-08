/**
 * SELECT/WITH-only SQL validator (Layer 5 of the validation pipeline).
 * Tokenizes the input, strips comments, enforces a single statement,
 * and rejects any presence of forbidden top-level keywords.
 *
 * Designed to be paranoid, not parse-perfect. False-positives (rejecting
 * a benign query) are acceptable; false-negatives (admitting a dangerous
 * query) are not.
 */
export class SqlValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SqlValidationError';
  }
}

const BLOCKED = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'RENAME',
  'ATTACH', 'DETACH', 'COPY', 'EXPORT', 'IMPORT',
  'INSTALL', 'LOAD', 'PRAGMA', 'SET', 'RESET',
  'TRUNCATE', 'GRANT', 'REVOKE', 'VACUUM',
  'CALL', 'EXEC', 'EXECUTE', 'REPLACE',
]);

const ALLOWED_LEADING = new Set(['SELECT', 'WITH']);

function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql.charAt(i);
    const c2 = sql.charAt(i + 1);
    if (c === "'") {
      const end = findStringEnd(sql, i, "'");
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const end = findStringEnd(sql, i, '"');
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '-' && c2 === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      out += ' ';
      continue;
    }
    if (c === '/' && c2 === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) throw new SqlValidationError('unterminated block comment');
      i = close + 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function findStringEnd(s: string, start: number, q: string): number {
  let i = start + 1;
  while (i < s.length) {
    if (s.charAt(i) === q && s.charAt(i + 1) === q) { i += 2; continue; }
    if (s.charAt(i) === q) return i;
    i++;
  }
  throw new SqlValidationError('unterminated string literal');
}

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql.charAt(i);
    if (c === "'" || c === '"') {
      const end = findStringEnd(sql, i, c);
      buf += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === ';') {
      const trimmed = buf.trim();
      if (trimmed.length) out.push(trimmed);
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail.length) out.push(tail);
  return out;
}

function tokenize(sql: string): string[] {
  return Array.from(sql.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)).map((m) => m[0].toUpperCase());
}

export function validateSql(sql: string): void {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new SqlValidationError('empty SQL');
  }
  const stripped = stripComments(sql);
  const statements = splitStatements(stripped);
  if (statements.length === 0) {
    throw new SqlValidationError('empty SQL after comment stripping');
  }
  if (statements.length > 1) {
    throw new SqlValidationError('only a single statement is allowed');
  }
  const stmt = statements[0]!;
  const tokens = tokenize(stmt);
  if (tokens.length === 0) {
    throw new SqlValidationError('no tokens found');
  }
  const head = tokens[0]!;
  if (!ALLOWED_LEADING.has(head)) {
    throw new SqlValidationError(`statement must start with SELECT or WITH (got ${head})`);
  }
  for (const t of tokens) {
    if (BLOCKED.has(t)) {
      throw new SqlValidationError(`forbidden keyword: ${t}`);
    }
  }
}
