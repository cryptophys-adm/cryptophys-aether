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
    weighting
  };
}
