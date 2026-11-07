// The guardian and the auditor (phase A4): deterministic findings over the decision cards of the
// last day, published to the platform kernel as advisory knowledge_audit reports. No AI decides a
// finding; the reports carry counts and agent ids, never a price level, and never "critical".
export const ADVISORY = "advisory only; not an order";
export const COMPLIANCE_WARN_PER_100 = 20;
export const REPEAT_NEIGHBOURS = 5;
export const REPEAT_MIN_MISSES = 3;

const lastDay = async (db, now) => ((await db.prepare("SELECT card_json FROM decision_cards WHERE bar_open >= ? ORDER BY bar_open").bind(new Date(now - 86_400_000).toISOString()).all()).results || []).map((r) => JSON.parse(r.card_json));

/** Pure: compliance findings per agent and check over `cards` (each card lists its rule breaks). */
export function complianceFindings(cards) {
  const messages = new Map(), breaks = new Map();
  for (const card of cards) {
    for (const a of card.agents || []) messages.set(a.id, (messages.get(a.id) || 0) + 1);
    for (const v of card.compliance || []) {
      const k = `${v.agent}|${v.check}`;
      breaks.set(k, (breaks.get(k) || 0) + 1);
    }
  }
  const out = [];
  for (const [k, n] of breaks) {
    const [agent, check] = k.split("|");
    const m = messages.get(agent) || n;
    out.push({ agent, check, breaks: n, messages: m, per_100: Math.round((n / m) * 1000) / 10 });
  }
  return out.sort((a, b) => b.per_100 - a.per_100);
}

/** Pure: agents with a scored miss in `cards` (outcomes keyed "agent:<id>"). */
export function missesOf(card) {
  return Object.entries(card.outcomes || {}).filter(([, o]) => o?.result === "miss" || o?.result === "missed_opportunity").map(([s]) => s.replace(/^agent:/, ""));
}

/** Repeated failures: for each missed card, how many of its nearest past situations were misses too. */
export async function repeatedFailures(env, cards, { neighbours = REPEAT_NEIGHBOURS } = {}) {
  if (!env.MARKET_INDEX) return [];
  const out = [];
  for (const card of cards) {
    const missed = missesOf(card);
    if (!missed.length) continue;
    let matches = [];
    try { matches = (await env.MARKET_INDEX.queryById(card.card_id, { topK: neighbours + 1, namespace: "decision", filter: { chart: card.chart } }))?.matches || []; } catch { matches = []; }
    const ids = matches.map((m) => m.id).filter((id) => id !== card.card_id).slice(0, neighbours);
    if (!ids.length) continue;
    const placeholders = ids.map(() => "?").join(",");
    const rows = (await env.AETHER_DB.prepare(`SELECT card_json FROM decision_cards WHERE card_id IN (${placeholders})`).bind(...ids).all()).results || [];
    for (const agent of missed) {
      const alsoMissed = rows.map((r) => JSON.parse(r.card_json)).filter((c) => missesOf(c).includes(agent)).length;
      if (alsoMissed >= REPEAT_MIN_MISSES) out.push({ agent, card_id: card.card_id, chart: card.chart, similar: ids.length, also_missed: alsoMissed });
    }
  }
  return out;
}

async function publish(env, agentId, report) {
  if (typeof env.AGENTS?.syscall !== "function") return { outcome: "unavailable" };
  try { return await env.AGENTS.syscall(agentId, "reports.publish", report); }
  catch (e) { return { outcome: "failed", reason: String(e?.message ?? e).slice(0, 120) }; }
}

/** The daily digest: guardian compliance and auditor repeated failures, one report each. */
export async function runDigest(env, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  if (!db) return { status: "unavailable" };
  let cards = [];
  try { cards = await lastDay(db, now); } catch { cards = []; }
  const compliance = complianceFindings(cards);
  const worst = compliance.filter((f) => f.per_100 >= COMPLIANCE_WARN_PER_100);
  const guardian = await publish(env, "aether-guardian", {
    kind: "knowledge_audit", severity: worst.length ? "warning" : "info",
    subject: worst.length ? `Agent compliance: ${worst.length} agent rule${worst.length === 1 ? "" : "s"} broken at ${COMPLIANCE_WARN_PER_100}+ per 100 messages` : `Agent compliance: ${cards.length} room conclusions checked`,
    ai_status: "deterministic",
    body: { advisory: ADVISORY, window_hours: 24, cards: cards.length, findings: compliance.slice(0, 20), threshold_per_100: COMPLIANCE_WARN_PER_100 }
  });
  const repeats = await repeatedFailures(env, cards);
  const auditor = await publish(env, "aether-auditor", {
    kind: "knowledge_audit", severity: "info",
    subject: repeats.length ? `Decision audit: ${repeats.length} repeated failure pattern${repeats.length === 1 ? "" : "s"}` : `Decision audit: ${cards.length} room conclusions, no repeated failure pattern`,
    ai_status: "deterministic",
    body: { advisory: ADVISORY, window_hours: 24, cards: cards.length, repeated_failures: repeats.slice(0, 20), rule: `a miss whose ${REPEAT_NEIGHBOURS} most similar past situations hold ${REPEAT_MIN_MISSES}+ misses of the same agent` }
  });
  return { status: "ok", cards: cards.length, compliance_findings: compliance.length, repeated_failures: repeats.length, guardian: guardian?.outcome ?? null, auditor: auditor?.outcome ?? null };
}
