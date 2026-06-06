// e5-base-v2 text embeddings, generated in-process via Transformers.js (ONNX) so
// no Python runtime is needed. mutu.dev's Elasticsearch `jobs_v2` index stores a
// 768-dim `embedding` (cosine) produced by intfloat/e5-base-v2 — to land in the
// same vector space, jobsync must use the same model and the same recipe:
//
//   - documents are prefixed "passage: ", queries "query: "
//   - mean pooling + L2 normalize ({ pooling: "mean", normalize: true })
//
// The model is loaded lazily (mirrors lib/gcs.ts) and cached for the process.
// Any failure returns null so indexing can still proceed without an embedding.

const MODEL_ID = "Xenova/e5-base-v2";
export const EMBEDDING_DIMS = 768;

// Minimal structural type for the Transformers.js feature-extraction pipeline,
// so we don't hard-depend on its types at compile time (it's an optional dep).
type FeatureExtractor = (
  texts: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const pipe = (await pipeline("feature-extraction", MODEL_ID)) as unknown as FeatureExtractor;
      return pipe;
    })();
  }
  return extractorPromise;
}

async function embedWithPrefix(prefix: "passage: " | "query: ", texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  try {
    const extractor = await getExtractor();
    const inputs = texts.map((t) => prefix + (t ?? "").replace(/\s+/g, " ").trim());
    const output = await extractor(inputs, { pooling: "mean", normalize: true });
    return output.tolist();
  } catch (err) {
    console.error("e5 embedding failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Embed documents (e5 "passage: " prefix). Returns null on failure. */
export async function embedPassages(texts: string[]): Promise<number[][] | null> {
  return embedWithPrefix("passage: ", texts);
}

/** Embed a single search query (e5 "query: " prefix). Returns null on failure. */
export async function embedQuery(text: string): Promise<number[] | null> {
  const result = await embedWithPrefix("query: ", [text]);
  return result?.[0] ?? null;
}
