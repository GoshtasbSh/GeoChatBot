/**
 * Install a synthetic embedder for all tests.
 *
 * Why: the planner now optionally retrieves examples + docs from a
 * MiniLM-backed RAG store before each LLM call. Loading transformers.js
 * in tests would download 22 MB of weights — way too slow, and Node's
 * default fetch can't reach the Hugging Face CDN in CI. The synthetic
 * embedder maps each unique word to a fixed slot, producing
 * deterministic 384-dim L2-normalised vectors. That keeps retrieval
 * functional in tests while staying instant.
 *
 * Individual tests can override with their own embedder via
 * __setTestEmbedder; the override is read on each call so installing
 * here doesn't conflict.
 */

import {
	EMBEDDING_DIM,
	__setTestEmbedder,
} from "../../src/agent/retrieval/embedder.js";

const slots = new Map<string, number>();

__setTestEmbedder((text: string) => {
	const v = new Float32Array(EMBEDDING_DIM);
	const tokens =
		(text ?? "")
			.toString()
			.toLowerCase()
			.match(/[a-z0-9]+/g) ?? [];
	for (const t of tokens) {
		let slot = slots.get(t);
		if (slot === undefined) {
			slot = slots.size % EMBEDDING_DIM;
			slots.set(t, slot);
		}
		v[slot] += 1;
	}
	let norm = 0;
	for (let i = 0; i < EMBEDDING_DIM; i++) {
		const vi = v[i];
		norm += vi * vi;
	}
	const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
	for (let i = 0; i < EMBEDDING_DIM; i++) {
		v[i] *= inv;
	}
	return v;
});
