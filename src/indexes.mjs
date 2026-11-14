// The Aether Vectorize indexes (phase A4; RFC §0.3: separate from the kernel's agent memory, so the
// state market never mixes with the platform's state machine).
//   aether-canon   (CANON_INDEX)  master knowledge chunks only, one set per canon version
//   aether-market  (MARKET_INDEX) decision cards (namespace "decision"); findings and learned items later
// D1 stays the source of truth: every vector id is recorded there, so an index can be rebuilt.
import { CANON } from "./canon.generated.mjs";
import { canonChunks } from "./canon-chunks.mjs";
import { embedTexts, EMBED_BATCH } from "./embed.mjs";
import { ensureSchema } from "./store.mjs";
import { appliedAmendments, effectiveDoctrine, effectiveSha } from "./doctrine.mjs";

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
  // The doctrine in force: an amendment Cerebrum executed re-indexes the canon (owner 2026-11-11).
  const sha = await effectiveSha(db);
  if ((await meta(db, "canon_indexed_sha")) === sha) return { status: "current", canon: sha.slice(0, 8) };
  const doctrine = sha === CANON.content_sha256 ? null : effectiveDoctrine(await appliedAmendments(db));
  const chunks = canonChunks(CANON, { doctrine, sha });
  const vectors = await embedTexts(env, chunks.map((c) => c.text), { now });
  if (!vectors) return { status: "model_refused", chunks: chunks.length };
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

/**
 * How long one run may keep embedding (wall time). A Cron Trigger has 15 minutes and the steps after this
 * one (reviews, amendments, digest, curation, council) need time too. This is not a cap on learning: cards
 * not reached stay pending (embedded_at unset) and the next hourly run carries them; nothing is dropped.
 */
export const EMBED_RUN_WALL_MS = 8 * 60_000;
const PENDING = "(embedded_at IS NULL OR embedded_at < updated_at)";

/**
 * Embeds every card not embedded yet (or updated since) into aether-market, namespace "decision", one
 * Workers AI request per page of EMBED_BATCH cards (owner 2026-11-14: learning is never limited). Pages are
 * read in (bar_open, card_id) order with a cursor, so each card is embedded at most once per run. When the
 * run's wall time is spent, the rest is carried to the next run and reported as `carried`.
 */
export async function embedPendingCards(env, { now = Date.now(), clock = Date.now, wallMs = EMBED_RUN_WALL_MS } = {}) {
  const db = env.AETHER_DB;
  if (!db || !env.AI || !env.MARKET_INDEX) return { status: "unavailable" };
  await ensureIndexSchema(db);
  const started = clock();
  const at = new Date(now).toISOString();
  let cards = 0, batches = 0, cursor = null, refused = false;
  for (;;) {
    if (batches > 0 && clock() - started >= wallMs) break;
    const page = cursor
      ? await db.prepare(`SELECT card_id, bar_open, card_json FROM decision_cards WHERE ${PENDING} AND (bar_open > ? OR (bar_open = ? AND card_id > ?)) ORDER BY bar_open, card_id LIMIT ?`).bind(cursor.bar_open, cursor.bar_open, cursor.card_id, EMBED_BATCH).all()
      : await db.prepare(`SELECT card_id, bar_open, card_json FROM decision_cards WHERE ${PENDING} ORDER BY bar_open, card_id LIMIT ?`).bind(EMBED_BATCH).all();
    const rows = page.results || [];
    if (!rows.length) break;
    cursor = rows.at(-1);
    const list = rows.map((r) => JSON.parse(r.card_json));
    const vectors = await embedTexts(env, list.map(cardText), { now });
    batches += 1;
    if (!vectors) { refused = true; break; }
    await env.MARKET_INDEX.upsert(list.map((card, i) => ({
      id: card.card_id, namespace: "decision", values: vectors[i],
      metadata: { kind: "decision", chart: card.chart, session: card.session ?? "unknown", stance: card.conclusion?.stance ?? "?", day: dayOf(card.bar_open) }
    })));
    // One statement per page (at most EMBED_BATCH bound ids, within D1's 100 parameters).
    await db.prepare(`UPDATE decision_cards SET embedded_at = ? WHERE card_id IN (${rows.map(() => "?").join(", ")})`).bind(at, ...rows.map((r) => r.card_id)).run();
    cards += rows.length;
    if (rows.length < EMBED_BATCH) break;
  }
  const pending = Number((await db.prepare(`SELECT COUNT(*) AS n FROM decision_cards WHERE ${PENDING}`).first())?.n) || 0;
  if (refused) return { status: "model_refused", cards, batches, pending };
  if (!cards) return { status: "nothing_pending" };
  // `carried`: still pending after this run (the wall time was spent, or a card was updated during it).
  return { status: "embedded", cards, batches, carried: pending };
}

export async function indexStatus(env) {
  const db = env.AETHER_DB;
  await ensureIndexSchema(db);
  const canonSha = await meta(db, "canon_indexed_sha");
  const canonVectors = Number((await db.prepare("SELECT COUNT(*) AS n FROM canon_vectors").first())?.n) || 0;
  const pending = Number((await db.prepare("SELECT COUNT(*) AS n FROM decision_cards WHERE embedded_at IS NULL OR embedded_at < updated_at").first())?.n) || 0;
  return { canon: { indexed: canonSha === CANON.content_sha256, vectors: canonVectors }, market: { pending_cards: pending } };
}
