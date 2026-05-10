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
import { SPATIAL_DOCS } from "./corpus.js";
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

/**
 * Lazily embed and persist the static corpus + examples on first call.
 * Subsequent calls are no-ops (the on-disk store already has them).
 */
export async function initRetriever(): Promise<void> {
	if (initPromise) return initPromise;
	const p = (async () => {
		await Promise.all([indexCorpus(), indexExamples()]);
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
}

const DEFAULT_OPTS: Required<RetrieveOpts> = {
	maxExamples: 5,
	maxDocs: 5,
	minScore: 0.25,
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
		memoryStore.search(qvec, merged.maxExamples),
	]);
	const docs: RetrievedDoc[] = docHits
		.filter((h) => h.score >= merged.minScore)
		.slice(0, merged.maxDocs)
		.map((h) => ({
			title: (h.meta as CorpusMeta).title,
			body: h.text,
			score: h.score,
		}));
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
			score: h.score + 0.05, // small bonus to break ties in memory's favour
		});
	}
	for (const h of exHits) {
		if (h.score < merged.minScore) continue;
		all.push({
			question: h.text,
			plan: (h.meta as ExampleMeta).plan,
			source: "static-example",
			score: h.score,
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
	await Promise.all([
		corpusStore.clear(),
		examplesStore.clear(),
		memoryStore.clear(),
	]);
}

/** Re-export the meta types so callers can narrow without poking internals. */
export type { AnyMeta };
