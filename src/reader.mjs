// Read-only view of Aether for its page in Nexus (owner 2026-11-09: nexus.cryptophys.work/aether, behind
// the same Cloudflare Access sign-in as Nexus). Served by the RPC entrypoint AetherReader; the Nexus
// Worker is its only caller, over a Service Binding. Nothing here writes, and nothing carries a price:
// decision cards never hold one (src/card-guard.mjs), knowledge items cite counts and agent ids.

import { CANON } from "./canon.generated.mjs";
import { cardCounts } from "./store.mjs";
import { indexStatus } from "./indexes.mjs";
import { budgetUsed } from "./budget.mjs";
import { knowledgeCounts } from "./knowledge.mjs";
import { weightingReports } from "./weighting.mjs";
import { complianceFindings, COMPLIANCE_WARN_PER_100 } from "./guardian.mjs";

const DAY_MS = 86_400_000;
const safe = async (fn, fallback = null) => { try { return await fn(); } catch { return fallback; } };
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Pure: a weighting report reduced to what the page shows. */
export function weightingSummary(timeframe, report, receivedAt) {
  const r = report || {};
  const candidates = (r.candidates || []).map((c) => ({
    id: c.id, changed: c.changed ?? null, change: c.change ?? null, verdict: c.verdict ?? null,
    discovery: c.discovery ? { bars: c.discovery.bars ?? null, accuracy: c.discovery.accuracy ?? null, control_accuracy: c.discovery.control_accuracy ?? null, p_holm: c.discovery.p_holm ?? null } : null,
    holdout: c.holdout ? { bars: c.holdout.bars ?? null, complete: Boolean(c.holdout.complete), accuracy: c.holdout.accuracy ?? null, control_accuracy: c.holdout.control_accuracy ?? null } : null
  }));
  const rank = (v) => (String(v).startsWith("better_than_active") ? 0 : String(v).startsWith("running") ? 1 : 2);
  candidates.sort((a, b) => rank(a.verdict) - rank(b.verdict) || (a.discovery?.p_holm ?? 1) - (b.discovery?.p_holm ?? 1));
  return {
    timeframe, received_at: receivedAt ?? null, generated_at: r.generated_at ?? null, mode: r.mode ?? null, equation: r.equation ?? null,
    rooms: r.rooms ?? 0, window_days: r.window_days ?? null, regimes: r.regimes ?? null,
    active: r.active ? { id: r.active.id ?? null, params: r.active.params ?? null, activated_at: r.active.activated_at ?? null, change: r.active.change ?? null } : null,
    agents: (r.agents || []).map((a) => ({ agent: a.agent, weight: a.weight ?? null, accuracy: a.accuracy ?? null, calibration: a.calibration ?? null, decisive: a.decisive ?? null })),
    candidates: candidates.slice(0, 16),
    reverse: r.reverse ? { previous_id: r.reverse.previous_id ?? null, since: r.reverse.since ?? null, rooms: r.reverse.rooms ?? 0, p_value: r.reverse.p_value ?? null, previous_accuracy: r.reverse.previous_accuracy ?? null, active_accuracy: r.reverse.active_accuracy ?? null } : null,
    history: (r.history || []).slice(-12).reverse()
  };
}

// ---------------------------------------------------------------- end-to-end sync (hardening 2026-11-09)

const HOUR = 3_600_000;
/** How old each feed may be while the market is open before the sync check warns. */
export const SYNC_LIMITS = Object.freeze({
  ingest_ms: 2 * HOUR,          // xauusd pushes cards every hour (the first sweep after the H1 close)
  embed_backlog_ms: 2 * HOUR,   // the cron at :52 embeds up to 50 cards an hour
  canon_index_ms: 2 * HOUR,     // the cron re-indexes a new canon within the hour
  weighting_ms: Object.freeze({ "15": 3 * HOUR, "60": 3 * HOUR, "240": 9 * HOUR, "1D": 50 * HOUR })
});

/** Pure: whether XAUUSD trades at `now` (closed from Friday 22:00 to Sunday 22:00 UTC). */
export function marketOpen(now) {
  const d = new Date(now), day = d.getUTCDay(), h = d.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && h >= 22) return false;
  if (day === 0 && h < 22) return false;
  return true;
}
/** Pure: true when the market was open for the whole window [now - span, now] sampled hourly. */
function openThroughout(now, span) {
  for (let t = now - span; t <= now; t += HOUR) if (!marketOpen(t)) return false;
  return true;
}

/**
 * Pure: the end-to-end sync checks from the raw facts. Each check is ok, warn or idle (the market was
 * closed during its window, so silence is expected). `overall` is warn when any check warns.
 */
export function syncChecks({ now, lastIngestAt, canonIndexedSha, canonSha, canonIndexedAt, oldestPendingAt, pending, weighting, aiUsed, aiLimit, kbSha }) {
  const age = (iso) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? now - t : null; };
  const checks = {};
  const fresh = (key, ageMs, limit, detail) => {
    const status = ageMs != null && ageMs <= limit ? "ok" : openThroughout(now, limit) ? "warn" : "idle";
    checks[key] = { status, age_minutes: ageMs == null ? null : Math.round(ageMs / 60_000), limit_minutes: Math.round(limit / 60_000), ...detail };
  };
  fresh("ingest", age(lastIngestAt), SYNC_LIMITS.ingest_ms, { last_at: lastIngestAt ?? null });
  const indexed = canonIndexedSha === canonSha;
  const indexAge = age(canonIndexedAt);
  checks.canon_index = { status: indexed ? "ok" : indexAge != null && indexAge <= SYNC_LIMITS.canon_index_ms ? "ok" : "warn", indexed, canon: String(canonSha).slice(0, 12), indexed_canon: canonIndexedSha ? String(canonIndexedSha).slice(0, 12) : null };
  if (!indexed && checks.canon_index.status === "ok") checks.canon_index.note = "a new canon waits for the next hourly index run";
  const backlogAge = pending ? age(oldestPendingAt) : 0;
  checks.embed_backlog = { status: !pending || (backlogAge != null && backlogAge <= SYNC_LIMITS.embed_backlog_ms) ? "ok" : "warn", pending: pending ?? 0, oldest_minutes: pending ? (backlogAge == null ? null : Math.round(backlogAge / 60_000)) : 0 };
  for (const w of weighting || []) {
    const limit = SYNC_LIMITS.weighting_ms[w.timeframe];
    if (!limit) continue;
    fresh(`weighting_${w.timeframe}`, age(w.received_at), limit, { last_at: w.received_at ?? null });
  }
  checks.ai_budget = { status: Number(aiUsed) < Number(aiLimit) ? "ok" : "warn", used: Number(aiUsed) || 0, limit: Number(aiLimit) || 0 };
  const overall = Object.values(checks).some((c) => c.status === "warn") ? "warn" : "ok";
  return { version: "cryptophys.aether-sync.v1", overall, market_open: marketOpen(now), kb_content_sha256: kbSha ?? null, canon_sha256: canonSha, checks };
}

/** The end-to-end sync status, read from D1. Never throws. */
export async function aetherSync(env, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  const one = async (sql, ...p) => (db ? await safe(async () => await db.prepare(sql).bind(...p).first(), null) : null);
  const lastIngest = await one("SELECT MAX(received_at) AS at FROM ingest_log");
  const canonMeta = await one("SELECT value, updated_at FROM aether_meta WHERE key = 'canon_indexed_sha'");
  const backlog = await one("SELECT COUNT(*) AS n, MIN(updated_at) AS oldest FROM decision_cards WHERE embedded_at IS NULL OR embedded_at < updated_at");
  const weighting = db ? await safe(async () => (await weightingReports(db)).map((w) => ({ timeframe: w.timeframe, received_at: w.received_at })), []) : [];
  const aiUsed = db ? await safe(() => budgetUsed(env, { now }), 0) : 0;
  return syncChecks({
    now, lastIngestAt: lastIngest?.at ?? null, canonIndexedSha: canonMeta?.value ?? null, canonSha: CANON.content_sha256, canonIndexedAt: canonMeta?.updated_at ?? null,
    oldestPendingAt: backlog?.oldest ?? null, pending: Number(backlog?.n) || 0, weighting, aiUsed, aiLimit: Number(env.AI_DAILY_LIMIT) || 60,
    kbSha: CANON.indicator?.kb_content_sha256 ?? null
  });
}

/** Everything the Aether page shows, in one read. Never throws. */
export async function aetherOverview(env, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  const since = new Date(now - DAY_MS).toISOString();
  const cards = db ? await safe(() => cardCounts(db), null) : null;
  const ingest = db ? await safe(async () => ((await db.prepare("SELECT received_at, accepted, rejected FROM ingest_log ORDER BY id DESC LIMIT 24").all()).results || []), []) : [];
  const ingest24 = db ? await safe(async () => (await db.prepare("SELECT COALESCE(SUM(accepted), 0) AS accepted, COALESCE(SUM(rejected), 0) AS rejected, COUNT(*) AS calls FROM ingest_log WHERE received_at >= ?").bind(since).first()), null) : null;
  const lastDay = db ? await safe(async () => ((await db.prepare("SELECT card_json FROM decision_cards WHERE bar_open >= ? ORDER BY bar_open").bind(since).all()).results || []).map((r) => parse(r.card_json)).filter(Boolean), []) : [];
  const knowledgeItems = db ? await safe(async () => ((await db.prepare("SELECT item_id, version, kind, agent_id, item_json, status, detail, created_at, updated_at FROM knowledge_items ORDER BY updated_at DESC LIMIT 40").all()).results || []).map((r) => {
    const it = parse(r.item_json) || {};
    return { item_id: r.item_id, version: r.version, kind: r.kind, agent: r.agent_id, status: r.status, text: it.text ?? null, situation: it.situation ?? null, params: it.params ?? null, evidence: it.evidence ?? null, detail: parse(r.detail) ?? r.detail ?? null, created_at: r.created_at, updated_at: r.updated_at };
  }), []) : [];
  const weighting = db ? await safe(async () => (await weightingReports(db)).map((w) => weightingSummary(w.timeframe, w.report, w.received_at)), []) : [];
  return {
    service: "cryptophys-aether", phase: env.AETHER_PHASE ?? null, generated_at: new Date(now).toISOString(),
    canon: {
      version: CANON.version, content_sha256: CANON.content_sha256, files: Object.keys(CANON.files || {}).length,
      kb_version: CANON.indicator?.kb_version ?? null, kb_content_sha256: CANON.indicator?.kb_content_sha256 ?? null,
      doctrine: (CANON.doctrine?.rules || []).map((r) => ({ id: r.id, rule: r.rule, since: r.since ?? null, status: r.status ?? null }))
    },
    cards, ingest: { last_24h: ingest24, recent: ingest },
    indexes: db ? await safe(() => indexStatus(env), null) : null,
    ai: db ? await safe(async () => ({ used_today: await budgetUsed(env, { now }), daily_limit: Number(env.AI_DAILY_LIMIT) || 60 }), null) : null,
    knowledge: { counts: db ? await safe(() => knowledgeCounts(db), {}) : {}, items: knowledgeItems },
    guardian: { window_hours: 24, cards: lastDay.length, threshold_per_100: COMPLIANCE_WARN_PER_100, findings: complianceFindings(lastDay).slice(0, 30) },
    weighting,
    sync: await aetherSync(env, { now })
  };
}
