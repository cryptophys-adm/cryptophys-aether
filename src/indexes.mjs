// The Aether Vectorize indexes (phase A4; RFC §0.3: separate from the kernel's agent memory, so the
// state market never mixes with the platform's state machine).
//   aether-canon   (CANON_INDEX)  master knowledge chunks only, one set per canon version
//   aether-market  (MARKET_INDEX) decision cards (namespace "decision"); findings and learned items later
// D1 stays the source of truth: every vector id is recorded there, so an index can be rebuilt.
import { CANON } from "./canon.generated.mjs";
import { canonChunks } from "./canon-chunks.mjs";
import { embedTexts } from "./embed.mjs";
import { ensureSchema } from "./store.mjs";

export const INDEX_SCHEMA_SQL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS aether_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS canon_vectors (vector_id TEXT PRIMARY KEY, canon_sha TEXT NOT NULL, part TEXT NOT NULL, ref TEXT NOT NULL)"
]);
let ready = false;
export function resetIndexSchemaCacheForTests() { ready = false; }
async function ensureIndexSchema(db) {
  if (ready) return;
  await ensureSchema(db);
  for (const sql of INDEX_SCHEMA_SQL) await db.prepare(sql).run();
  try { await db.prepare("ALTER TABLE decision_cards ADD COLUMN embedded_at TEXT").run(); } catch { /* already added */ }
  ready = true;
}
const meta = async (db, key) => (await db.prepare("SELECT value FROM aether_meta WHERE key = ?").bind(key).first())?.value ?? null;
const setMeta = (db, key, value, at) => db.prepare("INSERT INTO aether_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(key, value, at).run();

/**
 * Embeds the canon into aether-canon once per canon version. A new version is upserted first; the
 * previous version's vectors are deleted only after that succeeds.
 */
export async function syncCanon(env, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  if (!db || !env.AI || !env.CANON_INDEX) return { status: "unavailable" };
  await ensureIndexSchema(db);
  const sha = CANON.content_sha256;
  if ((await meta(db, "canon_indexed_sha")) === sha) return { status: "current", canon: sha.slice(0, 8) };
  const chunks = canonChunks();
  const vectors = await embedTexts(env, chunks.map((c) => c.text), { now });
  if (!vectors) return { status: "budget_or_model_refused", chunks: chunks.length };
  for (let i = 0; i < chunks.length; i += 100) {
    await env.CANON_INDEX.upsert(chunks.slice(i, i + 100).map((c, j) => ({ id: c.id, values: vectors[i + j], metadata: c.metadata })));
  }
  const at = new Date(now).toISOString();
  const old = ((await db.prepare("SELECT vector_id FROM canon_vectors WHERE canon_sha <> ?").bind(sha).all()).results || []).map((r) => r.vector_id);
  for (const c of chunks) await db.prepare("INSERT OR IGNORE INTO canon_vectors (vector_id, canon_sha, part, ref) VALUES (?, ?, ?, ?)").bind(c.id, sha, c.metadata.part, c.metadata.ref).run();
  for (let i = 0; i < old.length; i += 100) await env.CANON_INDEX.deleteByIds(old.slice(i, i + 100));
  if (old.length) await db.prepare("DELETE FROM canon_vectors WHERE canon_sha <> ?").bind(sha).run();
  await setMeta(db, "canon_indexed_sha", sha, at);
  return { status: "indexed", canon: sha.slice(0, 8), chunks: chunks.length, removed: old.length };
}

/** Plain text of a card for embedding (cards carry no levels; Aether's guard refused any that did). */
export function cardText(card) {
  const c = card.conclusion || {};
  const parts = [
    `${card.chart === "15" ? "15-minute" : card.chart === "60" ? "1-hour" : card.chart === "240" ? "4-hour" : "daily"} room, ${card.session ?? "unknown"} session.`,
    `Conclusion ${c.stance ?? "?"}, bias ${String(c.bias ?? "?").toLowerCase()}, confidence ${c.confidence ?? "?"}.`,
    card.crowd ? `Crowd leans ${String(card.crowd.weighted_bias ?? "?").toLowerCase()}, disagreement ${card.crowd.disagreement ?? "?"}.` : "",
    card.h1 ? `H1 decision ${card.h1.decision ?? "?"}.` : "",
    (card.stuck_open || []).length ? `Stuck: ${card.stuck_open.map((s) => `${s.field} for ${s.candles} candles`).join("; ")}.` : "",
    (card.agents || []).map((a) => `${a.id}: ${a.stance}/${String(a.bias ?? "").toLowerCase()} ${a.claim ?? ""}`).join(" | "),
    c.summary ?? ""
  ];
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 1500);
}
const dayOf = (iso) => Number(String(iso).slice(0, 10).replaceAll("-", ""));

/** Embeds up to `limit` cards not embedded yet (or updated since) into aether-market, namespace "decision". */
export async function embedPendingCards(env, { now = Date.now(), limit = 50 } = {}) {
  const db = env.AETHER_DB;
  if (!db || !env.AI || !env.MARKET_INDEX) return { status: "unavailable" };
  await ensureIndexSchema(db);
  const rows = (await db.prepare("SELECT card_id, card_json FROM decision_cards WHERE embedded_at IS NULL OR embedded_at < updated_at ORDER BY bar_open LIMIT ?").bind(limit).all()).results || [];
  if (!rows.length) return { status: "nothing_pending" };
  const cards = rows.map((r) => JSON.parse(r.card_json));
  const vectors = await embedTexts(env, cards.map(cardText), { now });
  if (!vectors) return { status: "budget_or_model_refused", pending: rows.length };
  await env.MARKET_INDEX.upsert(cards.map((card, i) => ({
    id: card.card_id, namespace: "decision", values: vectors[i],
    metadata: { kind: "decision", chart: card.chart, session: card.session ?? "unknown", stance: card.conclusion?.stance ?? "?", day: dayOf(card.bar_open) }
  })));
  const at = new Date(now).toISOString();
  for (const r of rows) await db.prepare("UPDATE decision_cards SET embedded_at = ? WHERE card_id = ?").bind(at, r.card_id).run();
  return { status: "embedded", cards: rows.length };
}

export async function indexStatus(env) {
  const db = env.AETHER_DB;
  await ensureIndexSchema(db);
  const canonSha = await meta(db, "canon_indexed_sha");
  const canonVectors = Number((await db.prepare("SELECT COUNT(*) AS n FROM canon_vectors").first())?.n) || 0;
  const pending = Number((await db.prepare("SELECT COUNT(*) AS n FROM decision_cards WHERE embedded_at IS NULL OR embedded_at < updated_at").first())?.n) || 0;
  return { canon: { indexed: canonSha === CANON.content_sha256, vectors: canonVectors }, market: { pending_cards: pending } };
}
