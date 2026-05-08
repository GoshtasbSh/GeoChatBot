import { describe, expect, it } from 'vitest';
import { validateSql, SqlValidationError } from '../../src/agent/validate-sql.js';

describe('validateSql — allowed', () => {
  for (const q of [
    'SELECT 1',
    'SELECT * FROM t',
    'select * from t',
    'WITH a AS (SELECT 1) SELECT * FROM a',
    'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<5) SELECT * FROM r',
    'SELECT * FROM a JOIN b ON a.id = b.id',
    'SELECT * FROM a UNION SELECT * FROM b',
    'SELECT a, count(*) FROM t GROUP BY a HAVING count(*) > 1 ORDER BY a LIMIT 10',
    'SELECT * /* a comment */ FROM t',
    '-- a leading comment\nSELECT 1',
    'SELECT 1;',
    '  SELECT 1  ',
  ]) {
    it(`accepts: ${q.slice(0, 40)}`, () => {
      expect(() => validateSql(q)).not.toThrow();
    });
  }
});

describe('validateSql — blocked keywords', () => {
  for (const q of [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'DROP TABLE t',
    'CREATE TABLE t (a INT)',
    'ALTER TABLE t ADD COLUMN b INT',
    'TRUNCATE t',
    'ATTACH DATABASE "x"',
    'DETACH DATABASE x',
    'COPY t TO "f.csv"',
    'PRAGMA foreign_keys = ON',
    'INSTALL spatial',
    'LOAD spatial',
    'SET memory_limit = "1GB"',
    'GRANT SELECT ON t TO u',
    'REVOKE SELECT ON t FROM u',
    'VACUUM',
    'EXPORT DATABASE "x"',
  ]) {
    it(`rejects: ${q}`, () => {
      expect(() => validateSql(q)).toThrow(SqlValidationError);
    });
  }
});

describe('validateSql — blocked DuckDB table-valued read functions', () => {
  // SELECT-prefixed queries that would otherwise pass the leading-token
  // check but invoke filesystem / network read functions. All must be
  // rejected — these are the SQL bypasses surfaced by the Phase 4
  // security review.
  for (const q of [
    "SELECT * FROM read_csv_auto('http://attacker.com/data.csv')",
    "SELECT * FROM read_csv('s3://bucket/key', AUTO_DETECT=true)",
    "SELECT * FROM read_parquet('http://x/y.parquet')",
    "SELECT * FROM read_json_auto('http://x/y.json')",
    "SELECT * FROM read_ndjson('http://x/y.ndjson')",
    "SELECT * FROM read_text('/etc/passwd')",
    "SELECT * FROM read_blob('/foo/bar')",
    "SELECT * FROM glob('/**/*.csv')",
    "SELECT * FROM query_table('foo')",
    'WITH x AS (SELECT * FROM read_parquet(\'h\')) SELECT * FROM x',
    "SELECT count(*) FROM read_csv_auto('http://x')",
  ]) {
    it(`rejects: ${q.slice(0, 60)}`, () => {
      expect(() => validateSql(q)).toThrow(SqlValidationError);
    });
  }

  // Mixed-case must still be caught (tokenizer upper-cases).
  it('rejects mixed-case Read_Csv_Auto', () => {
    expect(() => validateSql("SELECT * FROM Read_Csv_Auto('h')")).toThrow();
  });

  // Comment-stripped variant.
  it('rejects read_csv hidden after a leading line comment', () => {
    expect(() => validateSql("-- harmless\nSELECT * FROM read_csv('h')")).toThrow();
  });
});

describe('validateSql — extended SSRF / catalog blocklist', () => {
  // Functions and aliases not covered by the original blocklist that
  // would otherwise pass the leading-token check. Each must be rejected.
  for (const q of [
    // Parquet alias for read_parquet.
    "SELECT * FROM parquet_scan('http://x/y.parquet')",
    // Newer lakehouse readers.
    "SELECT * FROM delta_scan('s3://b/k')",
    "SELECT * FROM iceberg_scan('s3://b/k')",
    // Foreign-database scanners.
    "SELECT * FROM sqlite_scan('/tmp/x.db', 't')",
    "SELECT * FROM postgres_scan('host=x', 'public', 't')",
    "SELECT postgres_query('host=x', 'SELECT 1')",
    "SELECT * FROM mysql_scan('host=x', 'db', 't')",
    "SELECT mysql_query('host=x', 'SELECT 1')",
    // Engine catalog metadata.
    'SELECT * FROM duckdb_extensions()',
    'SELECT * FROM duckdb_settings()',
    'SELECT * FROM duckdb_tables()',
    'SELECT * FROM duckdb_functions()',
    'SELECT * FROM duckdb_databases()',
    'SELECT * FROM duckdb_views()',
    'SELECT * FROM information_schema.tables',
    'SELECT table_name FROM information_schema.columns',
    // Environment variable read.
    "SELECT getenv('HOME')",
    // SELECT ... INTO is DuckDB's CTAS shorthand — DDL via SELECT.
    'SELECT * INTO sink FROM t',
    'SELECT 1 AS a INTO TEMP tmp',
    // Mixed-case must still trip the upper-cased token check.
    "SELECT * FROM Parquet_Scan('h')",
    "SELECT * FROM SQLite_Scan('x', 't')",
  ]) {
    it(`rejects: ${q.slice(0, 60)}`, () => {
      expect(() => validateSql(q)).toThrow(SqlValidationError);
    });
  }
});

describe('validateSql — anti-injection', () => {
  it('rejects multiple statements', () => {
    expect(() => validateSql('SELECT 1; SELECT 2')).toThrow(/single/i);
  });

  it('rejects statement after a trailing semicolon + content', () => {
    expect(() => validateSql('SELECT 1; DROP TABLE t')).toThrow();
  });

  it('rejects DROP hidden inside a block comment', () => {
    expect(() => validateSql('SELECT * /* DROP TABLE t */ FROM x')).not.toThrow();
    expect(() => validateSql('/* SELECT */ DROP TABLE t')).toThrow();
  });

  it('rejects mixed-case blocked keyword', () => {
    expect(() => validateSql('DrOp TaBlE t')).toThrow();
  });

  it('rejects when first non-comment token is not SELECT or WITH', () => {
    expect(() => validateSql('FROM t SELECT *')).toThrow(/SELECT|WITH/);
  });

  it('allows semicolon at end with trailing whitespace', () => {
    expect(() => validateSql('SELECT 1;   ')).not.toThrow();
  });
});
