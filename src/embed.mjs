// Batched embeddings with the model the platform already uses (bge-small-en-v1.5, 384 dimensions).
// One Workers AI request embeds up to EMBED_BATCH texts (a request-size bound, not a cap: every text is
// embedded, one request per batch). Each request is metered in ai_usage (src/usage.mjs) and never refused
// for a budget or rate reason (owner 2026-11-14: "learning tidak boleh dibatasi siapa pun, itu adalah
// mandat tertinggi").
import { recordUsage } from "./usage.mjs";

export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
export const EMBED_DIMENSIONS = 384;
export const EMBED_BATCH = 50;

/** Vectors for `texts` (same order), or null when the model returns a wrong shape. */
export async function embedTexts(env, texts, { now = Date.now() } = {}) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    await recordUsage(env, 1, { now });
    const res = await env.AI.run(EMBED_MODEL, { text: batch });
    const data = Array.isArray(res?.data) ? res.data : null;
    if (!data || data.length !== batch.length || data.some((v) => !Array.isArray(v) || v.length !== EMBED_DIMENSIONS)) return null;
    out.push(...data);
  }
  return out;
}
