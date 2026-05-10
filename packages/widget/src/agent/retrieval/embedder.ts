/**
 * Lazy-loaded sentence embedder backed by transformers.js (MiniLM-L6-v2).
 *
 * Why this exists:
 *   - The planner emits worse plans the further the user's question drifts
 *     from the 22 hardcoded few-shot examples. RAG over a richer corpus
 *     (examples + spatial-analysis micro-docs + accepted-plan memory) gives
 *     the planner *similar* examples per question, which the LLM mimics.
 *   - We embed locally (no API key, no server) using a 384-dim sentence
 *     encoder. The MiniLM-L6-v2 quantized weights are ~22 MB and lazy-load
 *     on first call, so the widget's initial bundle stays lean.
 *
 * Why MiniLM:
 *   - It's the most common sentence-transformers baseline; quality is good
 *     enough for short-query retrieval against a small (<500-doc) corpus.
 *   - Better-quality models like bge-small or jina-v2 can be swapped in
 *     by changing the `MODEL_ID` constant — the rest of the pipeline is
 *     model-agnostic since it just consumes Float32Array vectors.
 *
 * Cost model:
 *   - First call: ~2 s download + cache (browser caches the 22 MB blob).
 *   - Subsequent calls: ~5–20 ms / sentence on CPU; vectors are reused.
 */

export const EMBEDDING_DIM = 384;
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

type FeatureExtractor = (
	text: string | string[],
	opts?: { pooling?: "mean" | "cls"; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

let pipelinePromise: Promise<FeatureExtractor> | null = null;

async function getPipeline(): Promise<FeatureExtractor> {
	if (!pipelinePromise) {
		pipelinePromise = (async () => {
			// Vite tree-shakes this dynamic import into its own chunk so the
			// 22 MB weights+wasm are not in the entry bundle.
			const transformers: typeof import("@xenova/transformers") = await import(
				/* @vite-ignore */ "@xenova/transformers"
			);
			// Use the WASM backend (no WebGL/WebGPU dependence) for the broadest
			// device support. The Xenova CDN serves quantized weights by default.
			// Workers are disabled to keep the call site simple — embedding latency
			// is dominated by model load, not encode.
			// @ts-ignore — env shape varies between transformers.js minor versions
			transformers.env.allowLocalModels = false;
			// @ts-ignore
			transformers.env.useBrowserCache = true;
			// Quantized weights → ~5× smaller, ~10% quality drop, perfectly fine
			// for short-text retrieval at our corpus size.
			const ext = (await transformers.pipeline("feature-extraction", MODEL_ID, {
				quantized: true,
			})) as unknown as FeatureExtractor;
			return ext;
		})();
	}
	return pipelinePromise;
}

/**
 * Encode a single string into a Float32Array of length {@link EMBEDDING_DIM}.
 * Vectors are L2-normalised, so cosine similarity reduces to a dot product.
 */
export async function embed(text: string): Promise<Float32Array> {
	const ext = await getPipeline();
	const out = await ext(text, { pooling: "mean", normalize: true });
	// transformers.js can return either Float32Array (typed-array tensor data)
	// or a plain number[]; normalise to Float32Array so the store contract
	// sees one type.
	if (out.data instanceof Float32Array) return out.data;
	return Float32Array.from(out.data as number[]);
}

/**
 * Batched encode — falls back to sequential single-encode if the underlying
 * pipeline rejects array input. Used at startup to embed the static corpus.
 */
export async function embedMany(texts: string[]): Promise<Float32Array[]> {
	if (texts.length === 0) return [];
	const ext = await getPipeline();
	try {
		const out = await ext(texts, { pooling: "mean", normalize: true });
		// Multi-input output is a single flat tensor of shape [N, dim].
		const dims = out.dims;
		if (
			dims &&
			dims.length === 2 &&
			dims[0] === texts.length &&
			dims[1] === EMBEDDING_DIM
		) {
			const data =
				out.data instanceof Float32Array
					? out.data
					: Float32Array.from(out.data as number[]);
			const result: Float32Array[] = [];
			for (let i = 0; i < texts.length; i++) {
				result.push(data.slice(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM));
			}
			return result;
		}
	} catch {
		/* fall through to sequential encode */
	}
	const out: Float32Array[] = [];
	for (const t of texts) out.push(await embed(t));
	return out;
}

/**
 * Test-only override. Lets vitest install a deterministic embedder so the
 * suite doesn't need to download 22 MB of weights to run retrieval tests.
 * Reset by calling with `null`.
 */
let testOverride: ((text: string) => Float32Array) | null = null;

export function __setTestEmbedder(
	fn: ((text: string) => Float32Array) | null,
): void {
	testOverride = fn;
	if (fn !== null) {
		// Wipe any in-flight pipeline so the next call uses the override.
		pipelinePromise = null;
	}
}

export async function embedWithOverride(text: string): Promise<Float32Array> {
	if (testOverride) return testOverride(text);
	return embed(text);
}

export async function embedManyWithOverride(
	texts: string[],
): Promise<Float32Array[]> {
	if (testOverride) {
		const fn = testOverride;
		return texts.map((t) => fn(t));
	}
	return embedMany(texts);
}
