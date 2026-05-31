/**
 * High-level retrieval API. Owns three vector stores:
 *
 *   1. corpus      — built-in spatial-analysis docs (corpus.ts), embedded
 *                    on first init, never mutated thereafter.
 *   2. examples    — the 22 (q, plan) few-shot exemplars from prompts/
 *                    examples.ts. Embedded on first init.
 *   3. memory      — user-accepted (q, plan) pairs. Written by the planner
 *                    after `approvePlan` so similar future questions retrieve
 *                    similar past-successful plans as few-shots.
 *
 * `retrieve(question)` runs all three searches, dedupes by id, and returns
 * a flat top-K list with provenance tags so the caller can split into
 * "examples block" vs "knowledge block" when assembling the prompt.
 */

import type { Plan } from "../types.js";
import { BM25Index, reciprocalRankFusion } from "./bm25.js";
import { SPATIAL_DOCS } from "./corpus.js";
import { taskMatchBoost } from "./example-reranker.js";
import { embedManyWithOverride, embedWithOverride } from "./embedder.js";
import { VectorStore } from "./store.js";

export interface RetrievedExample {
	question: string;
	plan: Plan;
	source: "static-example" | "user-memory";
	score: number;
}

export interface RetrievedDoc {
	title: string;
	body: string;
	score: number;
}

export interface RetrievalResult {
	examples: RetrievedExample[];
	docs: RetrievedDoc[];
}

// Index signatures here let these meta shapes satisfy
// `Record<string, unknown>`, the constraint on `VectorStore`'s generic.
// We need them to round-trip through idb-keyval (which serializes to
// JSON-compatible records anyway).
interface CorpusMeta extends Record<string, unknown> {
	kind: "doc";
	title: string;
}
interface ExampleMeta extends Record<string, unknown> {
	kind: "example";
	plan: Plan;
}
interface MemoryMeta extends Record<string, unknown> {
	kind: "memory";
	plan: Plan;
	ts: number;
}

type AnyMeta = CorpusMeta | ExampleMeta | MemoryMeta;

const VERSION_TAG = "minilm-v1";

let initPromise: Promise<void> | null = null;

const corpusStore = new VectorStore<CorpusMeta>(`corpus:${VERSION_TAG}`);
const examplesStore = new VectorStore<ExampleMeta>(`examples:${VERSION_TAG}`);
const memoryStore = new VectorStore<MemoryMeta>(`memory:${VERSION_TAG}`);

// ── Hybrid (lexical) layer ──────────────────────────────────────────────────
// BM25 indexes live in memory (cheap to (re)build from the static source each
// page load) and run alongside the dense vector search. They catch exact
// technical terms the MiniLM-L6 embedder blurs ("Moran's I", "choropleth",
// "geocode"). id→source maps let a BM25-only hit (high lexical, low dense)
// resolve back to its doc/example even when the vector search missed it.
let corpusBm25 = new BM25Index();
let examplesBm25 = new BM25Index();
const corpusById = new Map<string, { title: string; text: string }>();
const exampleById = new Map<string, { question: string; plan: Plan }>();
let bm25Built = false;

async function buildBm25(): Promise<void> {
	if (bm25Built) return;
	for (const d of SPATIAL_DOCS) {
		const text = `${d.title}. ${d.body}`;
		corpusBm25.add(d.id, text);
		corpusById.set(d.id, { title: d.title, text });
	}
	const { EXAMPLES } = await import("../prompts/examples.js");
	EXAMPLES.forEach((e, i) => {
		const id = `ex:${i}`;
		examplesBm25.add(id, e.question);
		exampleById.set(id, { question: e.question, plan: e.plan });
	});
	bm25Built = true;
}

/**
 * Lazily embed and persist the static corpus + examples on first call.
 * Subsequent calls are no-ops (the on-disk store already has them).
 */
export async function initRetriever(): Promise<void> {
	if (initPromise) return initPromise;
	const p = (async () => {
		await Promise.all([indexCorpus(), indexExamples(), buildBm25()]);
	})();
	// On failure, clear the latch so subsequent calls can retry. Without this,
	// a one-time error (CSP block, network drop during model download) would
	// permanently break retrieval for the page lifetime.
	p.catch(() => {
		if (initPromise === p) initPromise = null;
	});
	initPromise = p;
	return initPromise;
}

async function indexCorpus(): Promise<void> {
	const have = await corpusStore.size();
	if (have >= SPATIAL_DOCS.length) return;
	const texts = SPATIAL_DOCS.map((d) => `${d.title}. ${d.body}`);
	const vecs = await embedManyWithOverride(texts);
	await corpusStore.upsertMany(
		SPATIAL_DOCS.map((d, i) => {
			const text = texts[i];
			const vec = vecs[i];
			if (text === undefined || vec === undefined) {
				throw new Error(`corpus embed mismatch at index ${i}`);
			}
			return {
				id: d.id,
				text,
				vec,
				meta: { kind: "doc", title: d.title },
			};
		}),
	);
}

async function indexExamples(): Promise<void> {
	// Lazy-import the examples module so test code can mock it.
	const { EXAMPLES } = await import("../prompts/examples.js");
	const have = await examplesStore.size();
	if (have >= EXAMPLES.length) return;
	// Use the question text alone (not the plan) as the embedding input —
	// we want to match new user questions to similar past questions, not
	// similar plan structures.
	const vecs = await embedManyWithOverride(EXAMPLES.map((e) => e.question));
	await examplesStore.upsertMany(
		EXAMPLES.map((e, i) => {
			const vec = vecs[i];
			if (vec === undefined) {
				throw new Error(`examples embed mismatch at index ${i}`);
			}
			return {
				id: `ex:${i}`,
				text: e.question,
				vec,
				meta: { kind: "example", plan: e.plan },
			};
		}),
	);
}

/**
 * Persist a user-accepted (question, plan) pair into the memory store
 * so future similar questions retrieve it as a few-shot.
 *
 * Capped at 200 entries (FIFO eviction) — same cap as the saves store —
 * so a runaway dialog can't fill IndexedDB indefinitely.
 */
const MEMORY_CAP = 200;

export async function rememberPlan(
	question: string,
	plan: Plan,
): Promise<void> {
	const q = question.trim();
	if (!q) return;
	const vec = await embedWithOverride(q);
	const id = `mem:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
	// Read first to enforce FIFO cap.
	const list = await memoryStore.load();
	const next = [...list];
	if (next.length >= MEMORY_CAP) {
		// Drop the oldest by id timestamp.
		next.sort((a, b) => a.id.localeCompare(b.id));
		next.shift();
	}
	next.push({
		id,
		text: q,
		vec,
		meta: { kind: "memory", plan, ts: Date.now() },
	});
	// Atomic replace — writes the entire list in one IDB transaction. The
	// earlier `clear()` + `upsertMany(next)` pattern left a small window
	// where a parallel `retrieve()` would see an empty memory store.
	await memoryStore.replaceAll(next);
}

export interface RetrieveOpts {
	/** Max examples in the result (static + memory combined). */
	maxExamples?: number;
	/** Max docs in the result. */
	maxDocs?: number;
	/** Minimum cosine similarity to include a hit. */
	minScore?: number;
	/**
	 * Whether to query the user-memory store. When false, only the static
	 * corpus + example stores are searched and any past user-approved plans
	 * are ignored. Privacy-sensitive: this should mirror the host's
	 * `memoryEnabled` flag so that toggling memory off retroactively hides
	 * previously-stored entries from few-shot retrieval. Default: true
	 * (legacy behaviour, preserved for tests that don't care).
	 */
	includeMemory?: boolean;
}

const DEFAULT_OPTS: Required<RetrieveOpts> = {
	maxExamples: 5,
	maxDocs: 5,
	minScore: 0.25,
	includeMemory: true,
};

/**
 * Retrieve the most question-relevant docs and examples for the planner.
 */
export async function retrieve(
	question: string,
	opts: RetrieveOpts = {},
): Promise<RetrievalResult> {
	const merged = { ...DEFAULT_OPTS, ...opts };
	await initRetriever();
	const q = question.trim();
	if (!q) return { examples: [], docs: [] };
	const qvec = await embedWithOverride(q);
	const [docHits, exHits, memHits] = await Promise.all([
		corpusStore.search(qvec, merged.maxDocs * 2),
		examplesStore.search(qvec, merged.maxExamples * 2),
		// SEC-008: when the host has memory disabled, skip the memory store
		// entirely so stale entries from a previous memory-on session don't
		// resurface as few-shots. The write path is already gated; this
		// closes the read-side leak.
		merged.includeMemory
			? memoryStore.search(qvec, merged.maxExamples)
			: Promise.resolve([]),
	]);
	// ── Hybrid fusion (docs): combine the dense ranking with a BM25 lexical
	// ranking via RRF so an exact-keyword match the embedder blurred can still
	// surface, then resolve the fused order back to docs. A BM25-only hit
	// (absent from the dense top-k) resolves through corpusById. ────────────
	const bm25DocHits = corpusBm25.search(q, merged.maxDocs * 2);
	const vecDocById = new Map(docHits.map((h) => [h.id, h]));
	const bm25DocIds = new Set(bm25DocHits.map((h) => h.id));
	const fusedDocIds = reciprocalRankFusion([
		docHits.map((h) => h.id),
		bm25DocHits.map((h) => h.id),
	]);
	const docs: RetrievedDoc[] = [];
	for (const id of fusedDocIds) {
		if (docs.length >= merged.maxDocs) break;
		const vh = vecDocById.get(id);
		const passedDense = !!vh && vh.score >= merged.minScore;
		const lexical = bm25DocIds.has(id);
		if (!passedDense && !lexical) continue; // weak on both → drop
		const meta = corpusById.get(id);
		if (!meta) continue;
		docs.push({
			title: meta.title,
			body: vh?.text ?? meta.text,
			// keep a positive score; dense score when we have it, else a
			// mid-confidence value for a lexical-only hit.
			score: vh?.score ?? 0.5,
		});
	}
	// ── Hybrid fusion (examples): a BM25 lexical ranking over the static
	// example questions contributes a bounded, rank-based boost so a question
	// that shares exact terms with a worked example rises — and a lexical-only
	// match the dense search missed gets seeded into the pool. User-memory is
	// dynamic (not in the BM25 index) and keeps its existing +0.05 bonus. ──
	const bm25ExHits = examplesBm25.search(q, merged.maxExamples * 2);
	const bm25BoostByQuestion = new Map<string, number>();
	bm25ExHits.forEach((h, rank) => {
		const ex = exampleById.get(h.id);
		if (ex) bm25BoostByQuestion.set(ex.question, 0.1 / (1 + rank));
	});

	// Merge static-example and user-memory hits, dedupe by question text,
	// and prefer user-memory when both have similar scores (memory reflects
	// what the user actually approves, so it's higher signal).
	const examples: RetrievedExample[] = [];
	const seen = new Set<string>();
	const all: Array<RetrievedExample> = [];
	for (const h of memHits) {
		if (h.score < merged.minScore) continue;
		all.push({
			question: h.text,
			plan: (h.meta as MemoryMeta).plan,
			source: "user-memory",
			// +0.05 keeps memory ahead of a same-question static example; the
			// lexical + task-type boosts are applied equally so the tie holds.
			score:
				h.score +
				0.05 +
				(bm25BoostByQuestion.get(h.text) ?? 0) +
				taskMatchBoost(q, (h.meta as MemoryMeta).plan),
		});
	}
	const denseExQuestions = new Set<string>();
	for (const h of exHits) {
		denseExQuestions.add(h.text);
		if (h.score < merged.minScore) continue;
		all.push({
			question: h.text,
			plan: (h.meta as ExampleMeta).plan,
			source: "static-example",
			score:
				h.score +
				(bm25BoostByQuestion.get(h.text) ?? 0) +
				taskMatchBoost(q, (h.meta as ExampleMeta).plan),
		});
	}
	// Seed lexical-only example hits the dense search ranked below its cutoff,
	// so an exact-keyword example match still reaches the planner.
	for (const h of bm25ExHits) {
		const ex = exampleById.get(h.id);
		if (!ex || denseExQuestions.has(ex.question)) continue;
		all.push({
			question: ex.question,
			plan: ex.plan,
			source: "static-example",
			score:
				(bm25BoostByQuestion.get(ex.question) ?? 0.05) +
				taskMatchBoost(q, ex.plan),
		});
	}
	all.sort((a, b) => b.score - a.score);
	for (const e of all) {
		const key = e.question;
		if (seen.has(key)) continue;
		seen.add(key);
		examples.push(e);
		if (examples.length >= merged.maxExamples) break;
	}
	return { examples, docs };
}

/** Test-only: drop all stores. */
export async function __resetRetrieverForTests(): Promise<void> {
	initPromise = null;
	// Reset the in-memory BM25 layer too so a test that mocks the examples
	// module rebuilds the lexical index from the mock (not a stale real build).
	bm25Built = false;
	corpusBm25 = new BM25Index();
	examplesBm25 = new BM25Index();
	corpusById.clear();
	exampleById.clear();
	await Promise.all([
		corpusStore.clear(),
		examplesStore.clear(),
		memoryStore.clear(),
	]);
}

/**
 * Public: drop only the user-memory store (questions + plans the user has
 * approved in past sessions). The static corpus and example store stay
 * intact so RAG continues to work. Use from the host element's
 * `clearMemory()` method or a settings-drawer "Forget my history" button.
 */
export async function clearUserMemory(): Promise<void> {
	await memoryStore.clear();
}

/** Re-export the meta types so callers can narrow without poking internals. */
export type { AnyMeta };
