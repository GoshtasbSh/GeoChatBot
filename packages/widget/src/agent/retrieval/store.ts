/**
 * In-browser vector store backed by IndexedDB.
 *
 * Design choices:
 *   - Flat (brute-force) cosine search. With <2 000 entries (our corpus is
 *     ~50 docs + accepted-plan memory) and 384-dim vectors, a single query
 *     is ~1 ms on commodity hardware — building/maintaining an HNSW or
 *     IVFFlat index would be more code than it saves.
 *   - Vectors stored as raw Float32Array bytes via a single IndexedDB key
 *     per namespace. Read once on first query, cached in memory.
 *   - Namespaces let us isolate "static-corpus" (built-in docs, never
 *     modified after first index) from "user-memory" (accepted plans,
 *     written every approval) so wiping the user store doesn't lose docs.
 */

import * as idb from 'idb-keyval';
import { EMBEDDING_DIM } from './embedder.js';

export interface VectorRecord<M = Record<string, unknown>> {
  /** Stable id; used for upserts so re-embedding the same doc is idempotent. */
  id: string;
  /** Source text used to generate the vector — kept for debugging + display. */
  text: string;
  /** Embedding (length must equal {@link EMBEDDING_DIM}). */
  vec: Float32Array;
  /** Caller-defined metadata — passed back unmodified at search time. */
  meta: M;
}

export interface SearchHit<M = Record<string, unknown>> {
  id: string;
  score: number; // cosine similarity, [-1, 1]
  text: string;
  meta: M;
}

interface StoreShape {
  /** Bumped when the on-disk schema changes; keeps stale caches from being read as new. */
  schemaVersion: number;
  records: Array<{
    id: string;
    text: string;
    /** Plain number[] for JSON-serializable round-trip through idb-keyval. */
    vec: number[];
    meta: Record<string, unknown>;
  }>;
}

const SCHEMA_VERSION = 1;

export class VectorStore<M extends Record<string, unknown> = Record<string, unknown>> {
  private readonly key: string;
  private cache: VectorRecord<M>[] | null = null;
  private loadPromise: Promise<VectorRecord<M>[]> | null = null;

  constructor(namespace: string) {
    if (!/^[A-Za-z0-9_:-]+$/.test(namespace)) {
      throw new Error(`VectorStore: invalid namespace "${namespace}"`);
    }
    this.key = `geochatbot:vec:${namespace}`;
  }

  /** Eagerly load from IndexedDB. Idempotent. */
  async load(): Promise<VectorRecord<M>[]> {
    if (this.cache) return this.cache;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const raw = (await idb.get(this.key)) as StoreShape | undefined;
        if (!raw || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.records)) {
          this.cache = [];
          return this.cache;
        }
        this.cache = raw.records.map((r) => ({
          id: r.id,
          text: r.text,
          vec: Float32Array.from(r.vec),
          meta: r.meta as M,
        }));
        return this.cache;
      })();
    }
    return this.loadPromise;
  }

  /** Upsert a record by id (replaces an existing entry with the same id). */
  async upsert(rec: VectorRecord<M>): Promise<void> {
    if (rec.vec.length !== EMBEDDING_DIM) {
      throw new Error(
        `VectorStore.upsert: vec length ${rec.vec.length} != ${EMBEDDING_DIM}`,
      );
    }
    const list = await this.load();
    const idx = list.findIndex((r) => r.id === rec.id);
    if (idx >= 0) list[idx] = rec;
    else list.push(rec);
    await this.flush();
  }

  /** Bulk upsert — single IndexedDB write, much faster than N upserts. */
  async upsertMany(recs: ReadonlyArray<VectorRecord<M>>): Promise<void> {
    for (const r of recs) {
      if (r.vec.length !== EMBEDDING_DIM) {
        throw new Error(`VectorStore.upsertMany: vec length ${r.vec.length} != ${EMBEDDING_DIM}`);
      }
    }
    const list = await this.load();
    const byId = new Map(list.map((r) => [r.id, r]));
    for (const r of recs) byId.set(r.id, r);
    this.cache = [...byId.values()];
    await this.flush();
  }

  /** Top-K cosine search. Vectors are assumed L2-normalised. */
  async search(query: Float32Array, k: number): Promise<SearchHit<M>[]> {
    if (query.length !== EMBEDDING_DIM) {
      throw new Error(`VectorStore.search: query length ${query.length} != ${EMBEDDING_DIM}`);
    }
    const list = await this.load();
    if (list.length === 0) return [];
    const scores: SearchHit<M>[] = [];
    for (const r of list) {
      let s = 0;
      const a = query;
      const b = r.vec;
      // Both vectors are unit-length so dot-product == cosine similarity.
      for (let i = 0; i < EMBEDDING_DIM; i++) s += a[i]! * b[i]!;
      scores.push({ id: r.id, score: s, text: r.text, meta: r.meta });
    }
    scores.sort((x, y) => y.score - x.score);
    return scores.slice(0, k);
  }

  /** Total number of records (post-load). */
  async size(): Promise<number> {
    const list = await this.load();
    return list.length;
  }

  /** Test-only: replace the entire store. */
  async clear(): Promise<void> {
    this.cache = [];
    await this.flush();
  }

  /**
   * Atomic replace-all. Writes the entire list of records in a single
   * IDB transaction. Use this instead of clear() + upsertMany() when you
   * need to shrink the store (e.g. FIFO eviction) — the two-step pattern
   * leaves a window where a parallel `search()` would observe an empty
   * cache.
   */
  async replaceAll(recs: ReadonlyArray<VectorRecord<M>>): Promise<void> {
    for (const r of recs) {
      if (r.vec.length !== EMBEDDING_DIM) {
        throw new Error(`VectorStore.replaceAll: vec length ${r.vec.length} != ${EMBEDDING_DIM}`);
      }
    }
    this.cache = recs.slice();
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.cache) this.cache = [];
    const payload: StoreShape = {
      schemaVersion: SCHEMA_VERSION,
      records: this.cache.map((r) => ({
        id: r.id,
        text: r.text,
        vec: Array.from(r.vec),
        meta: r.meta,
      })),
    };
    await idb.set(this.key, payload);
  }
}
