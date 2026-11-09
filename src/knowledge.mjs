// Learned knowledge (phase A6, RFC_AETHER_KNOWLEDGE_GUARDIAN §0.4, §6.2, §8, §9.2): the curator and the
// calibrator draft candidate items from the decision cards with deterministic rules, propose them to
// the platform kernel (knowledge.propose, tier 1), and follow each proposal's review (knowledge.status).
// A person approves an item for shadow testing or rejects it; approved items form the learned pack that
// xauusd pulls for its shadow arm (phase A7). Nothing here changes a live agent, a prompt or a
// parameter, and nothing is promoted: promotion is an owner PR in the xauusd repository. The one
// exception is the `weighting` family (src/weighting.mjs, owner decision 2026-11-09): approving it
// activates that H1 quorum weighting in xauusd.
//
// Learned is not canon (AGENTS.md rule 5): every item is labelled learned, cites its decision cards and
// the canon it was measured against, states only measured outcomes or role reminders, and never carries
// a price, level, size or order wording. The kernel validates every item again before storing it.
import { CANON } from "./canon.generated.mjs";
import { latestWeightingReport, weightingCandidate, WEIGHTING_FAMILY } from "./weighting.mjs";

export const ITEM_SCHEMA = "cryptophys.knowledge-item.v1";
export const PACK_VERSION = "cryptophys.learned-pack.v1";
export const CURATOR = "aether-curator";
export const CALIBRATOR = "aether-calibrator";
/** At most this many proposals per agent per run (the kernel allows 6 an hour and 20 a day). */
export const MAX_PROPOSALS_PER_RUN = 3;
/** A rejected item is not proposed again for this long. */
export const REJECTED_COOLDOWN_MS = 14 * 86_400_000;

// Rule thresholds (RFC §9.2).
export const ROLE_DRIFT = Object.freeze({ window_days: 7, min_rooms: 20, min_rate_pct: 5, min_rooms_with_break: 10, min_span_days: 6 });
export const CAUTION = Object.freeze({ window_days: 30, min_decisive: 12, alpha: 0.05 });
export const ENGINE = Object.freeze({ window_days: 30, min_episodes: 3, min_cards: 10 });

/**
 * The reviewed tuning grid the calibrator may draw from (RFC §9.1). Mirrors the xauusd shadow
 * candidates (src/shadow-versions.mjs): `tested` lists the points already run or retired there, so the
 * calibrator proposes only the next untested point. A change here is a reviewed PR.
 */
export const TUNING_GRID = Object.freeze({
  prophet_r37: Object.freeze({ name: "Prophet", param: "stateMaxAge", default: 50, values: Object.freeze([8, 12, 16, 24]), tested: Object.freeze([8, 12]) }),
  gmi_v12_70: Object.freeze({ name: "GMI", param: "stateMaxAge", default: 50, values: Object.freeze([8, 12, 16, 24]), tested: Object.freeze([8, 12]) })
});
const METRIC = "paired sign test on decisive pairs, one-sided, alpha 0.05 (Holm-adjusted)";

const CHECK_PHRASE = Object.freeze({
  order_wording: "used order or size wording",
  stance_bias_conflict: "took a stance against its own bias",
  calibration_talk: "spoke of calibration, parity or verification",
  natural_language: "used field names instead of plain words",
  data_scope: "named another agent's indicator"
});
const CHART_WORD = Object.freeze({ "15": "quarter-hour", "60": "hourly", "240": "four-hour", "1D": "daily" });
const SESSION_WORD = Object.freeze({ asia: "Asia", london: "London", new_york: "New York", late: "late" });

export const KNOWLEDGE_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS knowledge_items (
    item_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    item_json TEXT NOT NULL,
    status TEXT NOT NULL,
    proposal_id TEXT,
    content_sha256 TEXT,
    detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (item_id, version)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_knowledge_items_status ON knowledge_items(status, updated_at)"
]);
let ready = false;
export function resetKnowledgeSchemaCacheForTests() { ready = false; }
async function ensureSchema(db) {
  if (ready) return;
  for (const sql of KNOWLEDGE_SCHEMA_SQL) await db.prepare(sql).run();
  ready = true;
}

const nameOf = (id) => String(id).replace(/_/g, " ");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const itemIdOf = (...parts) => ("k-" + parts.map(slug).join("-")).slice(0, 42).replace(/-$/, "");
const pct = (x) => Math.round(x * 100);
/** Text never carries a number of 3+ digits (the price guard): rates are said in percent, counts stay in the evidence. */
const pctText = (p) => (p >= 100 ? "every one" : `${p}%`);

/** One-sided exact binomial tail P(X >= k) for X ~ Bin(n, p). */
export function binomialTail(k, n, p) {
  if (k <= 0) return 1;
  if (p <= 0) return k > 0 ? 0 : 1;
  if (p >= 1) return 1;
  let term = Math.pow(1 - p, n), sum = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= k) sum += term;
    term = term * ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.min(1, sum);
}

function baseItem({ item_id, kind, claim_type, agents, charts, situation, text, evidence, card_ids }) {
  return {
    schema: ITEM_SCHEMA, item_id, version: 1, kind, claim_type, label: "learned",
    audience: { agents, charts }, situation, text, evidence,
    provenance: { card_ids, canon_sha: CANON.content_sha256, canon_version: CANON.version, source: "aether" }
  };
}

/** Curator rule "role drift" (RFC §9.2): an agent keeps breaking one check in the rooms it speaks in. */
export function roleDriftCandidates(cards, { now = Date.now() } = {}) {
  const since = now - ROLE_DRIFT.window_days * 86_400_000;
  const recent = cards.filter((c) => Date.parse(c.bar_open) >= since);
  if (!recent.length) return [];
  const opens = recent.map((c) => Date.parse(c.bar_open));
  if ((Math.max(...opens) - Math.min(...opens)) / 86_400_000 < ROLE_DRIFT.min_span_days) return [];
  const rooms = new Map(), broke = new Map();
  for (const c of recent) {
    for (const a of c.agents || []) rooms.set(a.id, (rooms.get(a.id) || 0) + 1);
    const seen = new Set();
    for (const v of c.compliance || []) {
      const k = `${v.agent}|${v.check}`;
      if (seen.has(k) || !CHECK_PHRASE[v.check]) continue;
      seen.add(k);
      broke.set(k, [...(broke.get(k) || []), c.card_id]);
    }
  }
  const out = [];
  for (const [k, ids] of broke) {
    const [agent, check] = k.split("|");
    const n = rooms.get(agent) || 0;
    if (n < ROLE_DRIFT.min_rooms || ids.length < ROLE_DRIFT.min_rooms_with_break) continue;
    const rate = pct(ids.length / n);
    if (rate <= ROLE_DRIFT.min_rate_pct) continue;
    out.push(baseItem({
      item_id: itemIdOf("role", agent, check), kind: "role_reminder", claim_type: "role_reminder",
      agents: [agent, "moderator"].filter((x, i, a) => a.indexOf(x) === i), charts: [],
      situation: { check },
      text: `In the last ${ROLE_DRIFT.window_days} days the ${nameOf(agent)} agent ${CHECK_PHRASE[check]} in ${pctText(rate)} of the rooms it spoke in. Its role and the owner rules forbid this.`,
      evidence: { agent, check, window_days: ROLE_DRIFT.window_days, rooms_with_break: ids.length, rooms: n, rate_pct: rate },
      card_ids: ids.slice(-40)
    }));
  }
  return out.sort((a, b) => b.evidence.rate_pct - a.evidence.rate_pct);
}

/** Curator rule "agent pattern" (RFC §9.2): an agent's misses in one situation exceed its own baseline. */
export function cautionCandidates(cards, { now = Date.now() } = {}) {
  const since = now - CAUTION.window_days * 86_400_000;
  const recent = cards.filter((c) => Date.parse(c.bar_open) >= since);
  const all = new Map(), by = new Map();
  for (const c of recent) {
    for (const [subject, o] of Object.entries(c.outcomes || {})) {
      if (!subject.startsWith("agent:") || (o?.result !== "hit" && o?.result !== "miss")) continue;
      const agent = subject.slice(6);
      const miss = o.result === "miss" ? 1 : 0;
      const a = all.get(agent) || { n: 0, miss: 0 };
      all.set(agent, { n: a.n + 1, miss: a.miss + miss });
      const k = `${agent}|${c.chart}|${c.session}`;
      const s = by.get(k) || { n: 0, miss: 0, ids: [] };
      by.set(k, { n: s.n + 1, miss: s.miss + miss, ids: [...s.ids, c.card_id] });
    }
  }
  const out = [];
  for (const [k, s] of by) {
    const [agent, chart, session] = k.split("|");
    const base = all.get(agent);
    if (!base || s.n < CAUTION.min_decisive || !CHART_WORD[chart] || !SESSION_WORD[session]) continue;
    const others = { n: base.n - s.n, miss: base.miss - s.miss };
    if (others.n < CAUTION.min_decisive) continue;
    const p0 = Math.max(0.01, others.miss / others.n);
    if (s.miss / s.n <= p0) continue;
    const p = binomialTail(s.miss, s.n, p0);
    if (p >= CAUTION.alpha) continue;
    const pValue = Math.round(p * 1000) / 1000;
    out.push(baseItem({
      item_id: itemIdOf("caution", agent, chart, session), kind: "caution", claim_type: "measured_outcome",
      agents: [agent, "moderator"].filter((x, i, a) => a.indexOf(x) === i), charts: [chart],
      situation: { chart, session },
      text: `On the ${CHART_WORD[chart]} chart in the ${SESSION_WORD[session]} session, the ${nameOf(agent)} agent was wrong in ${pctText(pct(s.miss / s.n))} of its decisive calls over ${CAUTION.window_days} days, against ${pctText(pct(p0))} in its other situations.`,
      evidence: { agent, chart, session, window_days: CAUTION.window_days, decisive: s.n, wrong: s.miss, wrong_pct: pct(s.miss / s.n), baseline_wrong_pct: pct(p0), baseline_decisive: others.n, p_value: pValue },
      card_ids: s.ids.slice(-40)
    }));
  }
  return out.sort((a, b) => a.evidence.p_value - b.evidence.p_value);
}

/** Pure: the open stuck episodes of each tuning family in the hourly cards (a run of cards with it open). */
export function stuckEpisodes(cards, { now = Date.now() } = {}) {
  const since = now - ENGINE.window_days * 86_400_000;
  const hourly = cards.filter((c) => c.chart === "60" && Date.parse(c.bar_open) >= since).sort((a, b) => Date.parse(a.bar_open) - Date.parse(b.bar_open));
  const out = {};
  for (const family of Object.keys(TUNING_GRID)) {
    let episodes = 0, open = false, longest = 0;
    const ids = [];
    for (const c of hourly) {
      const hits = (c.stuck_open || []).filter((s) => String(s.field).startsWith(family + "."));
      if (hits.length) {
        if (!open) episodes += 1;
        open = true;
        ids.push(c.card_id);
        longest = Math.max(longest, ...hits.map((h) => Number(h.candles) || 0));
      } else open = false;
    }
    out[family] = { episodes, longest_candles: longest, card_ids: ids };
  }
  return out;
}

/** Calibrator rule "engine pattern" (RFC §9.2): recurring stuck episodes -> the next untested grid point. */
export function paramCandidates(cards, { now = Date.now(), proposed = new Set(), pendingFamilies = new Set() } = {}) {
  const episodes = stuckEpisodes(cards, { now });
  const out = [];
  for (const [family, grid] of Object.entries(TUNING_GRID)) {
    if (pendingFamilies.has(family)) continue; // one open proposal per family at a time
    const e = episodes[family];
    if (e.episodes < ENGINE.min_episodes || e.card_ids.length < ENGINE.min_cards) continue;
    const value = grid.values.find((v) => !grid.tested.includes(v) && !proposed.has(`${family}:${v}`));
    if (value === undefined) continue;
    out.push({
      ...baseItem({
        item_id: itemIdOf("param", family, grid.param, value), kind: "param_candidate", claim_type: "measured_outcome",
        agents: ["moderator"], charts: ["60"],
        situation: { family, stuck: "structure latch" },
        text: `The ${grid.name} structure stayed stuck in ${e.episodes} separate episodes over ${ENGINE.window_days} days, the longest for ${e.longest_candles} hourly candles. Test in shadow a latch that expires after ${value} hourly candles instead of ${grid.default}.`,
        evidence: { family, window_days: ENGINE.window_days, episodes: e.episodes, longest_candles: e.longest_candles, proposed_value: value, default_value: grid.default, tested_values: [...grid.tested] },
        card_ids: e.card_ids.slice(-40)
      }),
      params: { family, grid: `TUNING_GRID.${family}.${grid.param}`, values: { [grid.param]: value }, hypothesis: "fewer and shorter stuck structure episodes without a worse decisive accuracy", metric: METRIC }
    });
  }
  return out;
}

// ---------------------------------------------------------------- ledger, proposals and review status

async function loadCards(db, now, days) {
  const rows = (await db.prepare("SELECT card_json FROM decision_cards WHERE bar_open >= ? ORDER BY bar_open").bind(new Date(now - days * 86_400_000).toISOString()).all()).results || [];
  return rows.map((r) => { try { return JSON.parse(r.card_json); } catch { return null; } }).filter(Boolean);
}

async function syscall(env, agentId, capability, input) {
  if (typeof env.AGENTS?.syscall !== "function") return { outcome: "unavailable" };
  try { return await env.AGENTS.syscall(agentId, capability, input); }
  catch (e) { return { outcome: "failed", reason: String(e?.message ?? e).slice(0, 200) }; }
}

/** Whether an item id may be proposed now: never while one is open or approved; after a rejection, after the cooldown. */
async function mayPropose(db, itemId, now) {
  const last = await db.prepare("SELECT version, status, updated_at FROM knowledge_items WHERE item_id = ? ORDER BY version DESC LIMIT 1").bind(itemId).first();
  if (!last) return { ok: true, version: 1 };
  if (last.status === "pending" || last.status === "approved") return { ok: false };
  if ((last.status === "rejected" || last.status === "refused") && now - Date.parse(last.updated_at) < REJECTED_COOLDOWN_MS) return { ok: false };
  return { ok: true, version: Number(last.version) + 1 };
}

async function proposeAll(env, agentId, candidates, now) {
  const db = env.AETHER_DB;
  const at = new Date(now).toISOString();
  const results = { proposed: 0, refused: 0, skipped: 0, stopped: null };
  for (const candidate of candidates) {
    if (results.proposed + results.refused >= MAX_PROPOSALS_PER_RUN) break;
    const gate = await mayPropose(db, candidate.item_id, now);
    if (!gate.ok) { results.skipped += 1; continue; }
    const item = { ...candidate, version: gate.version };
    const r = await syscall(env, agentId, "knowledge.propose", { item });
    if (r?.outcome === "succeeded") {
      const p = r.result?.proposal || {};
      await db.prepare("INSERT INTO knowledge_items (item_id, version, kind, agent_id, item_json, status, proposal_id, content_sha256, detail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?)")
        .bind(item.item_id, item.version, item.kind, agentId, JSON.stringify(item), p.proposal_id ?? null, p.content_sha256 ?? null, at, at).run();
      results.proposed += 1;
    } else if (r?.outcome === "failed" && /invalid_knowledge_item|knowledge_item_version_exists/.test(String(r.reason))) {
      // The kernel refused this content: kept so the same version is never sent again.
      await db.prepare("INSERT OR REPLACE INTO knowledge_items (item_id, version, kind, agent_id, item_json, status, proposal_id, content_sha256, detail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'refused', NULL, NULL, ?, ?, ?)")
        .bind(item.item_id, item.version, item.kind, agentId, JSON.stringify(item), String(r.reason).slice(0, 300), at, at).run();
      results.refused += 1;
    } else {
      // A denial (rate limit, kill switch, suspension) or a transport failure: final for this run, no retry.
      results.stopped = r?.outcome === "denied" ? `denied: ${String(r.reason ?? "").slice(0, 120)}` : (r?.outcome ?? "failed");
      break;
    }
  }
  return results;
}

/** Follows the review of every open proposal (knowledge.status, tier 0) and records the decisions. */
export async function syncReviews(env, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  if (!db) return { status: "unavailable" };
  await ensureSchema(db);
  const changed = { approved: 0, rejected: 0, expired: 0 };
  for (const agentId of [CURATOR, CALIBRATOR]) {
    const open = await db.prepare("SELECT COUNT(*) AS n FROM knowledge_items WHERE agent_id = ? AND status IN ('pending', 'approved')").bind(agentId).first();
    if (!Number(open?.n)) continue;
    const r = await syscall(env, agentId, "knowledge.status", {});
    if (r?.outcome !== "succeeded") continue;
    for (const p of r.result?.proposals || []) {
      if (!["approved", "rejected", "expired"].includes(p.status) || !p.proposal_id) continue;
      const res = await db.prepare("UPDATE knowledge_items SET status = ?, detail = ?, updated_at = ? WHERE proposal_id = ? AND status <> ?")
        .bind(p.status, JSON.stringify({ decided_by: p.decided_by ?? null, reason: p.reason ?? null, decided_at: p.decided_at ?? null }), new Date(now).toISOString(), p.proposal_id, p.status).run();
      if (Number(res?.meta?.changes)) changed[p.status] += 1;
    }
  }
  return { status: "ok", ...changed };
}

/** Daily: the curator's and the calibrator's candidates, proposed for review. */
export async function runCuration(env, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  if (!db) return { status: "unavailable" };
  await ensureSchema(db);
  const cards = await loadCards(db, now, Math.max(ROLE_DRIFT.window_days, CAUTION.window_days, ENGINE.window_days));
  const curatorCandidates = [...roleDriftCandidates(cards, { now }), ...cautionCandidates(cards, { now })];
  const proposedRows = (await db.prepare("SELECT item_json, status FROM knowledge_items WHERE kind = 'param_candidate'").all()).results || [];
  const proposed = new Set(), pendingFamilies = new Set(), proposedIds = new Set();
  for (const r of proposedRows) {
    try {
      const it = JSON.parse(r.item_json), p = it.params;
      proposedIds.add(it.item_id);
      if (p.family !== WEIGHTING_FAMILY) proposed.add(`${p.family}:${Object.values(p.values)[0]}`);
      if (r.status === "pending") pendingFamilies.add(p.family);
    } catch { /* a malformed row proposes nothing */ }
  }
  const calibratorCandidates = paramCandidates(cards, { now, proposed, pendingFamilies });
  // The H1 quorum weighting (owner decisions 2026-11-09): the best candidate of xauusd's latest replay
  // report, one open proposal at a time. Approval activates it in xauusd (src/weighting.mjs there).
  let weighting = null;
  try {
    const latest = await latestWeightingReport(db);
    const hourly = cards.filter((c) => c.chart === "60" && Date.parse(c.bar_open) >= now - 30 * 86_400_000).map((c) => c.card_id);
    weighting = weightingCandidate(latest?.report, { cardIds: hourly, pending: pendingFamilies.has(WEIGHTING_FAMILY), proposed: proposedIds, canon: CANON });
  } catch { weighting = null; }
  if (weighting) calibratorCandidates.unshift(weighting);
  const curator = await proposeAll(env, CURATOR, curatorCandidates, now);
  const calibrator = await proposeAll(env, CALIBRATOR, calibratorCandidates, now);
  return { status: "ok", cards: cards.length, candidates: { curator: curatorCandidates.length, calibrator: calibratorCandidates.length }, curator, calibrator };
}

/** The approved learned pack (RFC §7.3): what xauusd may test in shadow. Never live, never canon. */
export async function learnedPack(env) {
  const db = env.AETHER_DB;
  await ensureSchema(db);
  const rows = (await db.prepare("SELECT item_json, content_sha256, proposal_id FROM knowledge_items WHERE status = 'approved' ORDER BY item_id, version").all()).results || [];
  const items = rows.map((r) => {
    const it = JSON.parse(r.item_json);
    return { item_id: it.item_id, version: it.version, kind: it.kind, label: "learned", audience: it.audience, situation: it.situation, text: it.text, params: it.params ?? null, content_sha256: r.content_sha256, proposal_id: r.proposal_id };
  });
  const body = JSON.stringify(items);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { version: PACK_VERSION, sha256: sha, canon: { version: CANON.version, content_sha256: CANON.content_sha256 }, use: "shadow testing only; never a live prompt", items };
}

/** Counts per status, for /health. */
export async function knowledgeCounts(db) {
  await ensureSchema(db);
  const rows = (await db.prepare("SELECT status, COUNT(*) AS n FROM knowledge_items GROUP BY status").all()).results || [];
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n) || 0]));
}
