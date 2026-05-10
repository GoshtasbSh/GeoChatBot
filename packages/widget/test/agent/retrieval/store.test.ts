/**
 * VectorStore unit tests — fake-indexeddb backed.
 *
 * These tests do NOT load transformers.js — they exercise the store with
 * synthetic Float32Array vectors so we can assert ranking behaviour
 * without a 22 MB model download.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { VectorStore } from '../../../src/agent/retrieval/store.js';
import { EMBEDDING_DIM } from '../../../src/agent/retrieval/embedder.js';

function unitVec(seed: number): Float32Array {
  // Deterministic pseudo-random unit vector — distinct seeds give
  // distinguishable directions, so we can assert which is closest to a
  // given query.
  const v = new Float32Array(EMBEDDING_DIM);
  let x = seed;
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    v[i] = ((x % 1000) / 1000) - 0.5;
    norm += v[i]! * v[i]!;
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i]! *= inv;
  return v;
}

let nsCounter = 0;
function freshStore() {
  // Use a fresh namespace per test so stale fake-indexeddb state from a
  // prior run can't leak in.
  nsCounter++;
  return new VectorStore(`unit_test_${nsCounter}`);
}

describe('VectorStore', () => {
  beforeEach(() => {
    nsCounter++;
  });

  it('upserts and retrieves a single record', async () => {
    const s = freshStore();
    const vec = unitVec(1);
    await s.upsert({ id: 'a', text: 'hello', vec, meta: {} });
    expect(await s.size()).toBe(1);
    const hits = await s.search(vec, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('a');
    expect(hits[0]!.score).toBeGreaterThan(0.99); // self-similarity ≈ 1
  });

  it('ranks by cosine similarity', async () => {
    const s = freshStore();
    const recs = [
      { id: 'a', text: 'a', vec: unitVec(1), meta: {} },
      { id: 'b', text: 'b', vec: unitVec(2), meta: {} },
      { id: 'c', text: 'c', vec: unitVec(3), meta: {} },
    ];
    await s.upsertMany(recs);
    const hits = await s.search(unitVec(1), 3);
    expect(hits[0]!.id).toBe('a'); // identical to query → highest score
    // Scores are sorted descending.
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
    expect(hits[1]!.score).toBeGreaterThanOrEqual(hits[2]!.score);
  });

  it('upsert is idempotent on the same id', async () => {
    const s = freshStore();
    await s.upsert({ id: 'x', text: 'v1', vec: unitVec(7), meta: {} });
    await s.upsert({ id: 'x', text: 'v2', vec: unitVec(7), meta: {} });
    expect(await s.size()).toBe(1);
    const hits = await s.search(unitVec(7), 1);
    expect(hits[0]!.text).toBe('v2');
  });

  it('rejects non-conforming vector lengths', async () => {
    const s = freshStore();
    const bad = new Float32Array(10);
    await expect(s.upsert({ id: 'x', text: 't', vec: bad, meta: {} })).rejects.toThrow();
  });

  it('survives a round-trip through IndexedDB', async () => {
    const ns = `roundtrip_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const s1 = new VectorStore(ns);
    await s1.upsert({ id: 'a', text: 'hi', vec: unitVec(42), meta: { tag: 'one' } });
    // New instance against the same namespace should re-read from idb.
    const s2 = new VectorStore(ns);
    expect(await s2.size()).toBe(1);
    const hits = await s2.search(unitVec(42), 1);
    expect(hits[0]!.meta).toEqual({ tag: 'one' });
  });

  it('clear() empties the store', async () => {
    const s = freshStore();
    await s.upsert({ id: 'a', text: 't', vec: unitVec(1), meta: {} });
    expect(await s.size()).toBe(1);
    await s.clear();
    expect(await s.size()).toBe(0);
  });

  it('rejects search queries of wrong length', async () => {
    const s = freshStore();
    await s.upsert({ id: 'a', text: 't', vec: unitVec(1), meta: {} });
    await expect(s.search(new Float32Array(10), 1)).rejects.toThrow();
  });
});
