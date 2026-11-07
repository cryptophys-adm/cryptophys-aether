// D1 aether-knowledge (binding AETHER_DB, provisioned by Wrangler on the first deploy): the source of
// truth for what Aether has received. Vectorize indexes (phase A4) are rebuilt from it.
import { validateCard } from "./card-guard.mjs";
import { CANON } from "./canon.generated.mjs";

export const SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS decision_cards (
    card_id TEXT PRIMARY KEY,
    chart TEXT NOT NULL,
    kind TEXT NOT NULL,
    bar_open TEXT NOT NULL,
    card_json TEXT NOT NULL,
    canon_sha TEXT NOT NULL,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_decision_cards_bar ON decision_cards(chart, bar_open)",
  `CREATE TABLE IF NOT EXISTS ingest_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL,
    accepted INTEGER NOT NULL,
    rejected INTEGER NOT NULL,
    detail TEXT
  )`
]);

let ready = false;
export function resetSchemaCacheForTests() { ready = false; }
export async function ensureSchema(db) {
  if (ready) return;
  for (const sql of SCHEMA_SQL) await db.prepare(sql).run();
  ready = true;
}

export const MAX_CARDS_PER_CALL = 50;

/**
 * Stores decision cards. A card is refused when it fails the guard (version, shape, any level or
 * price). A known card is updated in place (its outcomes arrive after its horizon closes).
 */
export async function ingestCards(db, cards, { now = Date.now() } = {}) {
  await ensureSchema(db);
  const list = Array.isArray(cards) ? cards.slice(0, MAX_CARDS_PER_CALL) : [];
  const at = new Date(now).toISOString();
  let accepted = 0;
  const rejected = [];
  for (const card of list) {
    const errors = validateCard(card);
    if (errors.length) { rejected.push({ card_id: typeof card?.card_id === "string" ? card.card_id.slice(0, 64) : null, errors: errors.slice(0, 10) }); continue; }
    await db.prepare("INSERT INTO decision_cards (card_id, chart, kind, bar_open, card_json, canon_sha, received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET card_json = excluded.card_json, canon_sha = excluded.canon_sha, updated_at = excluded.updated_at")
      .bind(card.card_id, card.chart, card.kind, card.bar_open, JSON.stringify(card), CANON.content_sha256, at, at).run();
    accepted += 1;
  }
  const truncated = Array.isArray(cards) && cards.length > MAX_CARDS_PER_CALL ? cards.length - MAX_CARDS_PER_CALL : 0;
  await db.prepare("INSERT INTO ingest_log (received_at, accepted, rejected, detail) VALUES (?, ?, ?, ?)").bind(at, accepted, rejected.length, JSON.stringify({ rejected: rejected.slice(0, 10), truncated })).run();
  return { accepted, rejected, truncated, canon: { version: CANON.version, content_sha256: CANON.content_sha256 } };
}

/** Counts per chart, for the health endpoint. */
export async function cardCounts(db) {
  await ensureSchema(db);
  const rows = (await db.prepare("SELECT chart, COUNT(*) AS n, MAX(bar_open) AS latest FROM decision_cards GROUP BY chart").all()).results || [];
  return Object.fromEntries(rows.map((r) => [r.chart, { cards: Number(r.n) || 0, latest_bar: r.latest ?? null }]));
}
