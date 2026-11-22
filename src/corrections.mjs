// HAIC H3g (platform docs/design/HAIC-H3.md §5.2, §7.3; owner "Setuju semua rekomendasi", 2026-11-19): the owner's
// Nexus corrections become learned text items. Hourly, aether-curator reads the platform's corrections ledger
// (corrections.read, tier 0, its cursor, oldest first, at most 50 a page, side nexus), turns each convertible
// correction into a note and acknowledges every one with correction_conversion.v1 (reports.publish, batched).
//
// - A convertible correction (a seat, a chart, a category that names a reading, an invalidation or a broken rule)
//   becomes kind caution (reading or invalidation) or role_reminder (rule_broken), weight as recorded (3 for the
//   owner), audience the corrected seat, situation the target's chart and session, the owner's text masked and at
//   most 300 characters. Stored in knowledge_items with status 'owner' (it is the owner's word, not a proposal that
//   waits for review) and carried in the learned pack for xauusd's shadow arm, which promotes only on its own verdict.
// - Never param_candidate, never a weighting item; a correction never moves a parameter (§5.2).
// - Anything else is recorded not_convertible with its reason; it still counts in the platform's teaching record.
// - The pack keeps label "learned" (xauusd's pack reader refuses any other label, src/aether-pack.mjs) and marks these
//   items with origin "owner_correction", weight and correction_id.
import { CANON } from "./canon.generated.mjs";
import { validateCorrection, parseRef, CORRECTION_TEXT_MAX } from "./correction-contract.mjs";
import { readCorrectionsPage, publishCorrectionConversions, ITEM_SCHEMA, CURATOR, KNOWLEDGE_SCHEMA_SQL } from "./knowledge.mjs";

export const CONVERSION_SCHEMA = "correction_conversion.v1";
export const CORRECTIONS_PAGE_MAX = 50;
/** Pages read per hourly run (at most 200 corrections an hour); the cursor carries the rest to the next hour. */
export const CORRECTIONS_PAGES_PER_RUN = 4;
/** Acknowledgements per report; one report per run, inside the curator's 4 reports an hour. */
export const CONVERSIONS_PER_REPORT = 50;
/** After a denial (the capability not granted yet, a kill switch), the next read waits this long. */
export const CORRECTIONS_DENIAL_BACKOFF_MS = 6 * 3_600_000;
export const NOTE_TEXT_MAX = 300;

const CAUTION_CATEGORIES = Object.freeze({
  reading_wrong: "the reading was wrong",
  invalidation_too_tight: "the invalidation was too tight",
  invalidation_too_loose: "the invalidation was too loose",
  evidence_wrong: "the evidence cited was wrong",
  evidence_missing: "evidence was missing",
  overconfident: "the call was overconfident",
  underconfident: "the call was underconfident"
});
const CHART_WORD = Object.freeze({ "15": "quarter-hour", "60": "hourly", "240": "four-hour", "1D": "daily" });
const SESSIONS = new Set(["asia", "london", "new_york", "late"]);
const SEAT = /^seat:([a-z0-9][a-z0-9_-]{1,39})$/;
const NUMBER3 = /\d{3,}/;

const SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS correction_conversions (
    correction_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    item_id TEXT,
    reason TEXT,
    weight INTEGER,
    created_at TEXT NOT NULL,
    converted_at TEXT NOT NULL,
    acked_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_correction_conversions_ack ON correction_conversions(acked_at, converted_at)"
]);
let ready = false;
export function resetCorrectionsSchemaForTests() { ready = false; }
async function ensureSchema(db) {
  if (ready) return;
  // knowledge_items and aether_meta (src/knowledge.mjs) hold the notes and the cursor.
  for (const sql of [...KNOWLEDGE_SCHEMA_SQL, ...SCHEMA_SQL]) await db.prepare(sql).run();
  ready = true;
}

const sha256Hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The chart and session of a correction's target: a decision card's own (ev:xauusd/card/<card_id>), else null. */
export async function targetSituation(db, ref) {
  const p = parseRef(ref);
  if (!p || p.side !== "xauusd" || p.source !== "card") return null;
  const row = await db.prepare("SELECT chart, card_json FROM decision_cards WHERE card_id = ?").bind(p.id).first();
  if (!row) return null;
  let session = null;
  try { session = JSON.parse(row.card_json)?.session ?? null; } catch { session = null; }
  return { chart: String(row.chart), session: SESSIONS.has(session) ? session : null };
}

/**
 * Pure: a correction into a note, or the reason it cannot be one. `situation` is the target's { chart, session } or null.
 * Returns { status: "converted", item } or { status: "not_convertible", reason }.
 */
export function convertCorrection(c, situation) {
  const errors = validateCorrection(c);
  if (errors.length) return { status: "not_convertible", reason: `invalid: ${errors[0]}` };
  if (c.side !== "nexus") return { status: "not_convertible", reason: "not_nexus" };
  const seat = SEAT.exec(c.target.subject)?.[1];
  if (!seat) return { status: "not_convertible", reason: "no_seat" };
  const kind = c.category === "rule_broken" ? "role_reminder" : CAUTION_CATEGORIES[c.category] ? "caution" : null;
  if (!kind) return { status: "not_convertible", reason: c.category === null ? "rating_only" : `category_${c.category}` };
  if (!situation || !CHART_WORD[situation.chart]) return { status: "not_convertible", reason: "no_chart" };
  const what = kind === "role_reminder" ? "a rule of the role was broken" : CAUTION_CATEGORIES[c.category];
  const where = `${CHART_WORD[situation.chart]} chart${situation.session ? `, ${situation.session.replace("_", " ")} session` : ""}`;
  const head = `Owner correction for ${seat.replace(/_/g, " ")} on the ${where}: ${what}.`;
  const owner = typeof c.text === "string" ? c.text.trim() : "";
  const text = (owner ? `${head} ${owner}` : head).slice(0, NOTE_TEXT_MAX).trim();
  if (NUMBER3.test(text) || text.includes("[redacted]")) return { status: "not_convertible", reason: "text_fails_note_rules" };
  const hex = c.correction_id.slice(4);
  const item = {
    schema: ITEM_SCHEMA, item_id: `k-cor-${hex}`, version: 1, kind, claim_type: "owner_correction", label: "learned",
    origin: "owner_correction", weight: c.weight, correction_id: c.correction_id,
    audience: { agents: [seat], charts: [situation.chart] },
    situation: { chart: situation.chart, session: situation.session },
    text,
    evidence: { correction_id: c.correction_id, target_ref: c.target.ref, category: c.category, rating: c.rating, as_of: c.target.as_of, evidence_refs: c.evidence_refs },
    provenance: { source: "owner_correction", correction_id: c.correction_id, supersedes: c.supersedes, canon_sha: CANON.content_sha256, canon_version: CANON.version, card_ids: [] }
  };
  return { status: "converted", item };
}

async function meta(db, key) { return (await db.prepare("SELECT value FROM aether_meta WHERE key = ?").bind(key).first())?.value ?? null; }
async function setMeta(db, key, value, now) {
  await db.prepare("INSERT INTO aether_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(key, String(value), new Date(now).toISOString()).run();
}

/** Store one correction's outcome; a converted one becomes an 'owner' item (a newer correction supersedes its note). */
async function storeOutcome(db, c, out, now) {
  const at = new Date(now).toISOString();
  const seen = await db.prepare("SELECT correction_id FROM correction_conversions WHERE correction_id = ?").bind(c.correction_id).first();
  if (seen) return false;
  if (out.status === "converted") {
    const item = out.item;
    const sha = await sha256Hex(JSON.stringify(item));
    await db.prepare("INSERT OR IGNORE INTO knowledge_items (item_id, version, kind, agent_id, item_json, status, proposal_id, content_sha256, detail, created_at, updated_at) VALUES (?, 1, ?, ?, ?, 'owner', NULL, ?, ?, ?, ?)")
      .bind(item.item_id, item.kind, CURATOR, JSON.stringify(item), sha, `owner_correction weight ${item.weight}`, at, at).run();
    if (c.supersedes) await db.prepare("UPDATE knowledge_items SET status = 'superseded', updated_at = ? WHERE item_id = ? AND status = 'owner'").bind(at, `k-cor-${c.supersedes.slice(4)}`).run();
  }
  await db.prepare("INSERT INTO correction_conversions (correction_id, status, item_id, reason, weight, created_at, converted_at, acked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
    .bind(c.correction_id, out.status, out.item?.item_id ?? null, out.reason ?? null, Number(c.weight) || null, String(c.created_at ?? at), at).run();
  return true;
}

/**
 * Hourly: read the corrections after the cursor (side nexus), convert and store each, then acknowledge what is not yet
 * acknowledged in one correction_conversion.v1 report. A denial waits CORRECTIONS_DENIAL_BACKOFF_MS; a failure stops
 * the run and the cursor keeps its place. Never throws.
 */
export async function runCorrections(env, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  if (!db) return { status: "unavailable" };
  try {
    await ensureSchema(db);
    const until = Number(await meta(db, "corrections_backoff_until")) || 0;
    if (until > now) return { status: "backoff", until: new Date(until).toISOString() };
    let cursor = await meta(db, "corrections_cursor");
    let read = 0, converted = 0, notConvertible = 0, stopped = null;
    for (let page = 0; page < CORRECTIONS_PAGES_PER_RUN; page++) {
      const r = await readCorrectionsPage(env, { ...(cursor ? { cursor } : {}), side: "nexus" });
      if (r?.outcome === "denied") { await setMeta(db, "corrections_backoff_until", now + CORRECTIONS_DENIAL_BACKOFF_MS, now); stopped = `denied: ${String(r.reason ?? "").slice(0, 120)}`; break; }
      if (r?.outcome !== "succeeded") { stopped = r?.outcome ?? "failed"; break; }
      const list = Array.isArray(r.result?.corrections) ? r.result.corrections.slice(0, CORRECTIONS_PAGE_MAX) : [];
      for (const c of list) {
        read += 1;
        if (typeof c?.correction_id !== "string") continue;
        const situation = await targetSituation(db, c?.target?.ref);
        const out = convertCorrection(c, situation);
        if (await storeOutcome(db, c, out, now)) out.status === "converted" ? (converted += 1) : (notConvertible += 1);
      }
      const next = typeof r.result?.next_cursor === "string" && r.result.next_cursor ? r.result.next_cursor : null;
      if (next) { cursor = next; await setMeta(db, "corrections_cursor", next, now); }
      if (!next || list.length < CORRECTIONS_PAGE_MAX) break;
    }
    const acked = await acknowledge(env, db, now);
    return { status: stopped ? "stopped" : "ok", read, converted, not_convertible: notConvertible, acked, stopped };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/** One correction_conversion.v1 report with up to CONVERSIONS_PER_REPORT unacknowledged outcomes. */
async function acknowledge(env, db, now) {
  const rows = (await db.prepare("SELECT correction_id, status, item_id, reason FROM correction_conversions WHERE acked_at IS NULL ORDER BY converted_at LIMIT ?").bind(CONVERSIONS_PER_REPORT).all()).results || [];
  if (!rows.length) return 0;
  const conversions = rows.map((r) => ({ correction_id: r.correction_id, status: r.status, ...(r.item_id ? { item_id: r.item_id } : {}), ...(r.reason ? { reason: r.reason } : {}) }));
  const converted = conversions.filter((x) => x.status === "converted").length;
  const r = await publishCorrectionConversions(env, {
    kind: "knowledge_audit", severity: "info",
    subject: `Corrections: ${converted} converted, ${conversions.length - converted} not convertible`,
    ai_status: "deterministic",
    body: { schema: CONVERSION_SCHEMA, at: new Date(now).toISOString(), conversions }
  });
  if (r?.outcome !== "succeeded") return 0;
  const at = new Date(now).toISOString();
  for (const x of conversions) await db.prepare("UPDATE correction_conversions SET acked_at = ? WHERE correction_id = ?").bind(at, x.correction_id).run();
  return conversions.length;
}

/** For the overview: counts by outcome and the cursor's place. Never throws. */
export async function correctionsView(env) {
  const db = env.AETHER_DB;
  if (!db) return null;
  try {
    await ensureSchema(db);
    const rows = (await db.prepare("SELECT status, COUNT(*) AS n, SUM(CASE WHEN acked_at IS NULL THEN 1 ELSE 0 END) AS unacked FROM correction_conversions GROUP BY status").all()).results || [];
    return { by_status: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])), unacked: rows.reduce((s, r) => s + Number(r.unacked || 0), 0), cursor: await meta(db, "corrections_cursor") };
  } catch { return null; }
}

export { CORRECTION_TEXT_MAX };
