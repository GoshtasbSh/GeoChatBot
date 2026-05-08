import { describe, expect, it } from 'vitest';
import { substitute } from '../../src/agent/substitute.js';
import type { OutputRef } from '../../src/agent/types.js';

const refs = new Map<string, OutputRef>([
  ['x', { kind: 'layer', ref: 'view_x' }],
  ['y', { kind: 'table', ref: 'view_y' }],
  ['n', { kind: 'scalar', ref: 'scalar', value: 42 }],
]);

describe('substitute', () => {
  it('replaces a whole-string ${var}', () => {
    expect(substitute('${x}', refs)).toEqual({ kind: 'layer', ref: 'view_x' });
  });

  it('does NOT replace partial-string ${var}_suffix', () => {
    expect(substitute('${x}_suffix', refs)).toBe('${x}_suffix');
  });

  it('does NOT replace ${var} inside SQL strings', () => {
    expect(substitute('SELECT ${x} FROM t', refs)).toBe('SELECT ${x} FROM t');
  });

  it('returns the literal when var is unknown', () => {
    expect(substitute('${unknown}', refs)).toBe('${unknown}');
  });

  it('walks objects recursively', () => {
    const got = substitute({ a: '${x}', b: { c: '${y}' } }, refs) as any;
    expect(got.a.ref).toBe('view_x');
    expect(got.b.c.ref).toBe('view_y');
  });

  it('walks arrays recursively', () => {
    const got = substitute(['${x}', 'plain'], refs) as any[];
    expect(got[0].ref).toBe('view_x');
    expect(got[1]).toBe('plain');
  });

  it('passes through numbers and booleans unchanged', () => {
    expect(substitute(7, refs)).toBe(7);
    expect(substitute(true, refs)).toBe(true);
  });

  it('passes through null and undefined unchanged', () => {
    expect(substitute(null, refs)).toBeNull();
    expect(substitute(undefined, refs)).toBeUndefined();
  });

  it('does not mutate the input object', () => {
    const inp = { a: '${x}' };
    substitute(inp, refs);
    expect(inp).toEqual({ a: '${x}' });
  });

  it('substitutes a scalar ref by full OutputRef including value', () => {
    const got = substitute('${n}', refs) as OutputRef;
    expect(got.value).toBe(42);
  });

  describe('prototype pollution safety (M3)', () => {
    it('ignores a __proto__ key without polluting the returned object', () => {
      const evil = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}');
      const out = substitute(evil, refs) as Record<string, unknown>;
      // The dangerous key must NOT appear on the result.
      expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
      // And the global Object prototype must not have been polluted.
      const probe: Record<string, unknown> = {};
      expect((probe as { polluted?: boolean }).polluted).toBeUndefined();
    });

    it('ignores constructor and prototype keys', () => {
      const evil = { constructor: { x: 1 }, prototype: { y: 2 }, ok: 'ok' };
      const out = substitute(evil, refs) as Record<string, unknown>;
      expect(out.ok).toBe('ok');
      // Don't pass through the dangerous keys.
      expect(Object.prototype.hasOwnProperty.call(out, 'prototype')).toBe(false);
    });

    it('returns a null-prototype object so legitimate constructor checks fail safely', () => {
      const out = substitute({ a: 1 }, refs) as Record<string, unknown>;
      expect(Object.getPrototypeOf(out)).toBeNull();
    });
  });
});
