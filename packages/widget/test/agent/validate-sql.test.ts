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
