/**
 * Client-side BM25 lexical search + Reciprocal Rank Fusion.
 *
 * The dense MiniLM-L6 embedder blurs rare technical terms, so exact-keyword
 * queries ("Moran's I", "choropleth", "geocode") can miss the right doc.
 * BM25 ranks by literal term overlap with IDF weighting, catching exactly
 * those cases. We fuse the BM25 ranking with the dense vector ranking via
 * RRF, which combines by RANK (not raw score), so the two scales don't need
 * normalising. Pure JS, no dependencies, runs fully in-browser.
 *
 * Research basis (2025-2026): hybrid BM25+dense reliably beats dense-only on
 * terminology-heavy corpora; for a tiny corpus the lexical signal is the
 * cheapest accuracy win on exact-keyword queries.
 */

const K1 = 1.5;
const B = 0.75;

/** Lowercase, split on non-alphanumerics, drop empties. */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 0);
}

interface Doc {
	id: string;
	len: number;
	tf: Map<string, number>;
}

export class BM25Index {
	private docs: Doc[] = [];
	private df = new Map<string, number>(); // document frequency per term
	private totalLen = 0;

	add(id: string, text: string): void {
		const tokens = tokenize(text);
		const tf = new Map<string, number>();
		for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
		for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
		this.docs.push({ id, len: tokens.length, tf });
		this.totalLen += tokens.length;
	}

	private idf(term: string): number {
		const n = this.docs.length;
		const df = this.df.get(term) ?? 0;
		// BM25 IDF with +1 to stay non-negative for terms present in all docs.
		return Math.log((n - df + 0.5) / (df + 0.5) + 1);
	}

	/** Return the top-k docs by BM25 score; only docs with a positive score. */
	search(query: string, k: number): Array<{ id: string; score: number }> {
		const qTerms = tokenize(query);
		if (qTerms.length === 0 || this.docs.length === 0) return [];
		const avgdl = this.totalLen / this.docs.length || 1;
		const scored: Array<{ id: string; score: number }> = [];
		for (const doc of this.docs) {
			let s = 0;
			for (const term of qTerms) {
				const tf = doc.tf.get(term);
				if (!tf) continue;
				const idf = this.idf(term);
				const denom = tf + K1 * (1 - B + (B * doc.len) / avgdl);
				s += idf * ((tf * (K1 + 1)) / denom);
			}
			if (s > 0) scored.push({ id: doc.id, score: s });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, k);
	}
}

/**
 * Reciprocal Rank Fusion. Each input is an ordered list of ids (best first).
 * Fused score for an id = Σ 1 / (rrfK + rank) across the lists it appears in.
 * Ids appearing high in multiple lists rise to the top. Returns ids ordered
 * by fused score (best first), deduped.
 */
export function reciprocalRankFusion(
	rankedLists: ReadonlyArray<ReadonlyArray<string>>,
	rrfK = 60,
): string[] {
	const score = new Map<string, number>();
	for (const list of rankedLists) {
		list.forEach((id, rank) => {
			score.set(id, (score.get(id) ?? 0) + 1 / (rrfK + rank));
		});
	}
	return [...score.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([id]) => id);
}
