// The Knowledge Council and the doctrine protocol (owner 2026-11-11: "autonomous doctrine protocol harus
// dilakukan oleh knowledge council, dilakukan harian dan di propose ke cerebrum untuk eksekusinya").
//
// Every rule of the canon doctrine (canon/doctrine.json v2) may anchor facts: values the running system
// reports. The AI Worker reports them every hour for two seats (KnowledgeIngress.ingestDoctrineFacts):
//   nexus  the decision side (Decision Engine, rooms, weighting, calendar, parity, lanes);
//   omega  the execution side (the Omega engine's settings in force and its fixed gates).
// Once a day the council meets (runCouncil): for every rule whose anchored facts differ from the
// effective doctrine, the reporting seat agrees only when it measured the same new value in two reports
// at least 45 minutes apart (their deployed versions are kept as evidence), and the Aether seat agrees only when the rule
// is in force, the text renders and an operational value sits inside its hard bound. When every seat
// involved agrees, the council proposes the amendment to the Cerebrum consensus (consensus.propose as
// the knowledge-council agent); Cerebrum votes and executes it. Aether applies only the amendments
// Cerebrum executed (doctrine.status, hourly) and folds them into the canon by a reviewed PR.
// Nothing here writes doctrine text with a model: the text is the reviewed template with the values.
import { CANON } from "./canon.generated.mjs";

export const FACTS_SCHEMA = "cryptophys.doctrine-facts.v1";
export const COUNCIL_AGENT = "knowledge-council";
/** The UTC hour of the daily session (an hour after the curator, at :52 like every Aether cron step). */
export const COUNCIL_HOUR_UTC = 3;
/** A drift counts only when measured twice: the earlier report is at least this much older. */
export const STABLE_GAP_MS = 45 * 60_000;
/** Facts older than this are not read (the AI Worker reports every hour). */
export const FACTS_MAX_AGE_MS = 3 * 3_600_000;
/** The same amendment (rule and values) is not proposed again within this window. */
export const PROPOSAL_COOLDOWN_MS = 7 * 86_400_000;
/** consensus.status reads at most this many of the council's own proposal ids a call (platform, 2026-11-22). */
export const STATUS_BATCH_MAX = 50;
/**
 * A denied consensus.status (the capability not granted yet) waits this long before the next read. On the daily
 * schedule it never skips a session; it is kept for the pattern corrections.read follows (and any run off schedule).
 */
export const STATUS_DENIAL_BACKOFF_MS = 6 * 3_600_000;
/**
 * What consensus.status may store on a row: the owner's refusal or a closed window. consensus.status never writes
 * executed; only the propose answer (a routine amendment executed at the vote) or markExecutedProposals (once the
 * amendment is in doctrine_applied) does, so a transient doctrine.status failure cannot lift the cooldown while the drift
 * is still open (orchestrator review of aether#45).
 */
const STATUS_FINAL = Object.freeze(["rejected", "expired"]);
/** The kernel's proposal id shape (`LIKE 'cns_%'` alone takes `_` as a wildcard). */
const PROPOSAL_ID = /^cns_[0-9a-f-]{36}$/;
/** consensus.propose allows 4 an hour; the council leaves one for the next hour's retry. */
export const MAX_PROPOSALS_PER_SESSION = 3;
const FACTS_KEEP_MS = 7 * 86_400_000;
const MAX_FACTS_BYTES = 16_384;

/**
 * The hard bounds of the operational facts, mirrored from the platform's reviewed
 * control-plane-shared/src/doctrine.ts (DOCTRINE_BOUNDS): the Aether seat refuses what Cerebrum would.
 * A change there is a platform PR; a change here alone never widens anything Cerebrum executes.
 */
const LENS_MODES = Object.freeze(["scalp", "intraday", "swing", "range"]);
const perMode = (base, kind, bounds) => Object.fromEntries(LENS_MODES.map((m, i) => [`${base}_${m}`, { kind, min: bounds[i][0], max: bounds[i][1] }]));
const same = (lo, hi) => [[lo, hi], [lo, hi], [lo, hi], [lo, hi]];
/** The lens knobs' hard bounds, per mode in the order scalp, intraday, swing, range. */
export const LENS_BOUNDS = Object.freeze({
  ...perMode("positioning.de_weight", "number", [[0.02, 0.04], [0.02, 0.06], [0.02, 0.1], [0.02, 0.05]]),
  ...perMode("positioning.crowd_pctl", "number", same(0.8, 0.95)),
  ...perMode("positioning.flow_z", "number", same(0.5, 2)),
  ...perMode("liquidity.council_weight", "number", [[0, 0.8], [0, 0.6], [0, 0.4], [0, 0.6]]),
  ...perMode("liquidity.spike_pctl", "number", same(0.9, 0.99)),
  ...perMode("liquidity.thin_pctl", "number", same(0.05, 0.3)),
  ...perMode("liquidity.spread_widen", "number", same(1.5, 4)),
  ...perMode("liquidity.sweep_lookback_min", "integer", [[30, 120], [60, 360], [240, 1440], [60, 360]]),
  ...perMode("liquidity.pool_tol_atr", "number", same(0.02, 0.15)),
  ...perMode("liquidity.hvn_pctl", "number", same(0.8, 0.95)),
  ...perMode("liquidity.profile_window_min", "integer", [[120, 480], [480, 2880], [2880, 14400], [480, 2880]]),
  "positioning.score_floor": { kind: "number", min: 0.4, max: 0.5 },
  "positioning.score_window": { kind: "integer", min: 40, max: 200 },
  "liquidity.score_floor": { kind: "number", min: 0.4, max: 0.5 },
  "liquidity.score_window": { kind: "integer", min: 50, max: 300 }
});

export const DOCTRINE_BOUNDS = Object.freeze({
  "decision.trading_mode": { kind: "text", in: ["scalp", "intraday", "swing"] },
  "decision.min_confidence": { kind: "number", min: 0.3, max: 0.7 },
  // The Decision Engine's thresholds per trading mode (xauusd, owner 2026-11-19: "mau"), today's single bounds each. The
  // single facts (decision.quorum_min, lean, min_rrr: the mode in force) are information now, unbounded as on the
  // platform, so the council amends these only under the per-mode names.
  "decision.quorum_min_scalp": { kind: "number", min: 0.45, max: 0.7 },
  "decision.quorum_min_intraday": { kind: "number", min: 0.45, max: 0.7 },
  "decision.quorum_min_swing": { kind: "number", min: 0.45, max: 0.7 },
  "decision.quorum_min_range": { kind: "number", min: 0.45, max: 0.7 },
  "decision.lean_scalp": { kind: "number", min: 0.05, max: 0.3 },
  "decision.lean_intraday": { kind: "number", min: 0.05, max: 0.3 },
  "decision.lean_swing": { kind: "number", min: 0.05, max: 0.3 },
  "decision.lean_range": { kind: "number", min: 0.05, max: 0.3 },
  "decision.min_rrr_intraday": { kind: "number", min: 1, max: 3 },
  "decision.min_rrr_swing": { kind: "number", min: 1, max: 3 },
  "decision.min_rrr_range": { kind: "number", min: 1, max: 3 },
  // The room guardrail in 1H average ranges, one fact per trading mode so a mode switch alone is no drift (xauusd
  // src/room-tuning.mjs, owner 2026-11-19: bounds 0.5 to 1.5).
  "decision.room_min_atr_scalp": { kind: "number", min: 0.5, max: 1.5 },
  "decision.room_min_atr_intraday": { kind: "number", min: 0.5, max: 1.5 },
  "decision.room_min_atr_swing": { kind: "number", min: 0.5, max: 1.5 },
  "decision.room_min_atr_range": { kind: "number", min: 0.5, max: 1.5 },
  "decision.witness_weights": { kind: "weights", max_each: 0.3 },
  "rooms.quorum_share_default": { kind: "number", min: 0.5, max: 0.6 },
  "room.m15_unverified_confidence_cap": { kind: "number", min: 0.3, max: 0.5 },
  "weighting.activation_min_days": { kind: "integer", min: 7, max: 30 },
  "weighting.rollback_min_rooms": { kind: "integer", min: 50, max: 200 },
  "calendar.blackout_before_min": { kind: "integer", min: 60, max: 240 },
  "calendar.blackout_after_min": { kind: "integer", min: 15, max: 120 },
  "omega.max_signal_age_min": { kind: "number", min: 5, max: 15 },
  "omega.max_spread_points": { kind: "integer", min: 20, max: 100 },
  // Omega's risk per account profile (platform ADR-0020 Amendment 10, canonical main e3bb6538e017; owner 2026-11-21:
  // "Ya, Custom = Aggressive"). The single omega.risk_pct, omega.max_daily_loss_pct and omega.max_positions (the
  // settings in force) are information now, unbounded as on the platform, so the council amends risk only under the
  // per-profile names. omega.profile and omega.effective_* are derived facts, never amended.
  "omega.risk_pct_safe": { kind: "number", min: 0.1, max: 2 },
  "omega.risk_pct_conservative": { kind: "number", min: 0.1, max: 5 },
  "omega.risk_pct_aggressive": { kind: "number", min: 0.1, max: 10 },
  "omega.risk_pct_custom": { kind: "number", min: 0.1, max: 10 },
  "omega.max_daily_loss_pct_safe": { kind: "number", min: 0.1, max: 3 },
  "omega.max_daily_loss_pct_conservative": { kind: "number", min: 0.1, max: 6 },
  "omega.max_daily_loss_pct_aggressive": { kind: "number", min: 0.1, max: 10 },
  "omega.max_daily_loss_pct_custom": { kind: "number", min: 0.1, max: 10 },
  "omega.max_positions_safe": { kind: "integer", min: 1, max: 1 },
  "omega.max_positions_conservative": { kind: "integer", min: 1, max: 2 },
  "omega.max_positions_aggressive": { kind: "integer", min: 1, max: 3 },
  "omega.max_positions_custom": { kind: "integer", min: 1, max: 3 },
  // The Positioning & Liquidity analyst's knobs (xauusd docs/RFC_POSITIONING_LIQUIDITY.md §8, owner breakglass
  // 2026-11-20): 44 per-mode facts and 4 score facts, the platform's bounds (canonical main a879288).
  ...LENS_BOUNDS
});

const WITNESS_WORD = Object.freeze({
  D1: "D1 room", H4: "4H room", H1: "1H room", M15: "15m room", NEWS: "News Daily", MACRO: "Macro War Room", STRATEGY: "strategy engine",
  KEY_LEVELS: "key levels", REGIME: "regime", TREND_TF: "cross-timeframe trend", MACRO_DRIVERS: "macro drivers", SESSION: "session",
  CALENDAR: "economic calendar inside a release's horizon", STRATEGY_AGENTS: "strategy agents' consensus"
});
const TOKEN = /\{([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\}/g;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Pure: a fact value in words, as the template shows it (the same as the canon build). */
export function formatValue(value, format = "num") {
  if (format === "pct") return `${Math.round(Number(value) * 100)}%`;
  if (format === "weights") return Object.entries(value || {}).map(([k, w]) => `${WITNESS_WORD[k] ?? k} ${w}`).join(", ");
  if (format === "list") return (Array.isArray(value) ? value : []).map(String).join(", ");
  if (format === "bool" || typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

/** Pure: the template with its anchors' values. */
export function renderRule(template, anchors, values = {}) {
  const byFact = new Map((anchors || []).map((a) => [a.fact, a]));
  return String(template).replace(TOKEN, (m, fact) => {
    const a = byFact.get(fact);
    if (!a) return m;
    return formatValue(Object.hasOwn(values, fact) ? values[fact] : a.value, a.format);
  });
}

/** Pure: equal values (numbers to 1e-9, lists in order, objects by key). */
export function sameValue(a, b) {
  if (isNum(a) && isNum(b)) return Math.abs(a - b) <= 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return sameValue(ka, kb) && ka.every((k) => sameValue(a[k], b[k]));
  }
  return a === b;
}

/** Pure: null when the value sits inside the operational fact's bound; else the reason. */
export function boundProblem(fact, value) {
  const b = DOCTRINE_BOUNDS[fact];
  if (!b) return `${fact} has no hard bound`;
  if (b.kind === "number" || b.kind === "integer") {
    if (!isNum(value) || (b.kind === "integer" && !Number.isInteger(value))) return `${fact} must be ${b.kind === "integer" ? "an integer" : "a number"}`;
    return value >= b.min && value <= b.max ? null : `${fact} ${value} is outside ${b.min}-${b.max}`;
  }
  if (b.kind === "text") return b.in.includes(value) ? null : `${fact} must be one of ${b.in.join(", ")}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${fact} must be an object of weights`;
  const ws = Object.entries(value);
  if (!ws.length || ws.some(([k, w]) => !WITNESS_WORD[k] || !isNum(w) || w < 0 || w > b.max_each)) return `${fact} has an unknown witness or a weight outside 0-${b.max_each}`;
  const sum = ws.reduce((s, [, w]) => s + w, 0);
  return Math.abs(sum - 1) <= 0.001 ? null : `${fact} must sum to 1`;
}

export const seatOf = (fact) => (String(fact).startsWith("omega.") ? "omega" : "nexus");
export const canonShort = (canon = CANON) => String(canon.content_sha256).slice(0, 12);

/**
 * Pure: the doctrine in force. Canon rules with the amendments Cerebrum executed against this canon
 * (an amendment made against an earlier canon is folded in or superseded by the canon PR), each with
 * its rendered text, its values and the last amendment that changed it.
 */
export function effectiveDoctrine(applied = [], canon = CANON) {
  const sha12 = canonShort(canon);
  const live = applied.filter((a) => a.canon === sha12).sort((a, b) => String(a.executed_at).localeCompare(String(b.executed_at)));
  return (canon.doctrine?.rules || []).map((r) => {
    const anchors = r.anchors || [];
    const values = Object.fromEntries(anchors.map((a) => [a.fact, a.value]));
    let amended = null;
    for (const a of live) {
      if (a.rule !== r.id) continue;
      for (const [fact, v] of Object.entries(a.values || {})) if (Object.hasOwn(values, fact)) values[fact] = v;
      amended = { amendment_id: a.amendment_id, action: a.action, executed_at: a.executed_at, executed_by: a.executed_by ?? null };
    }
    const text = r.template ? renderRule(r.template, anchors, values) : r.rule;
    return { id: r.id, class: r.class ?? "operational", rule: text, canon_rule: r.rule, anchors: anchors.map((a) => ({ fact: a.fact, format: a.format ?? "num", value: values[a.fact], canon_value: a.value })), source: r.source, since: r.since, updated: r.updated ?? null, amended };
  });
}

/** Pure: a facts report checked and reduced to its two seats. Throws on a malformed one. */
export function validateFacts(payload, { now = Date.now() } = {}) {
  if (!payload || typeof payload !== "object" || payload.schema !== FACTS_SCHEMA) throw new Error("schema must be " + FACTS_SCHEMA);
  if (JSON.stringify(payload).length > MAX_FACTS_BYTES) throw new Error("facts_too_large");
  const at = Date.parse(payload.measured_at);
  if (!Number.isFinite(at) || at > now + 5 * 60_000) throw new Error("measured_at must be an ISO time, not in the future");
  const seats = {};
  for (const seat of ["nexus", "omega"]) {
    const s = payload.seats?.[seat];
    if (s == null) continue;
    if (typeof s !== "object" || typeof s.facts !== "object" || Array.isArray(s.facts)) throw new Error(`${seat}.facts must be an object`);
    const facts = {};
    for (const [k, v] of Object.entries(s.facts)) {
      if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(k)) throw new Error(`bad fact name ${k}`);
      if (seatOf(k) !== seat) throw new Error(`${k} belongs to the ${seatOf(k)} seat`);
      facts[k] = v;
    }
    seats[seat] = { version_id: typeof s.version_id === "string" ? s.version_id.slice(0, 64) : null, facts };
  }
  if (!Object.keys(seats).length) throw new Error("no seat reported");
  return { measured_at: new Date(at).toISOString(), seats };
}

const actionFor = (rule, facts) => (rule.class !== "constitutional" && facts.every((f) => Object.hasOwn(DOCTRINE_BOUNDS, f)) ? "amend_doctrine" : "amend_constitution");

/**
 * Pure: the council's review of every rule. `latest` and `previous` are validated facts reports
 * (previous at least STABLE_GAP_MS older). Each rule gets a status:
 *   in_sync      every anchored fact equals the doctrine in force;
 *   unreported   a seat did not report one of its facts (the code changed shape: an owner PR);
 *   observing    a difference not yet measured twice from the same deployed version;
 *   refused      the Aether seat refuses it (out of bounds for an operational fact);
 *   propose      every seat involved agrees: the amendment goes to Cerebrum.
 */
export function councilReview({ rules, latest, previous, session, canon = CANON }) {
  const out = [];
  for (const r of rules) {
    if (!r.anchors?.length) continue;
    const drifts = [], unreported = [];
    for (const a of r.anchors) {
      const seat = seatOf(a.fact);
      const facts = latest?.seats?.[seat]?.facts;
      if (!facts || !Object.hasOwn(facts, a.fact)) { unreported.push({ fact: a.fact, seat }); continue; }
      if (!sameValue(facts[a.fact], a.value)) drifts.push({ fact: a.fact, seat, doctrine: a.value, observed: facts[a.fact] });
    }
    if (unreported.length) { out.push({ rule: r.id, class: r.class, status: "unreported", unreported, drifts }); continue; }
    if (!drifts.length) { out.push({ rule: r.id, class: r.class, status: "in_sync" }); continue; }
    const seats = { aether: "agree" };
    const why = [];
    for (const d of drifts) {
      const before = previous?.seats?.[d.seat];
      const now = latest.seats[d.seat];
      // Owner 2026-11-11 (first live reports): xauusd deploys several times a day, so the same value
      // measured twice across a redeploy counts; the versions stay in the evidence.
      const stable = Boolean(before) && Object.hasOwn(before.facts, d.fact) && sameValue(before.facts[d.fact], d.observed);
      d.stable = stable;
      d.versions = [before?.version_id ?? null, now?.version_id ?? null];
      if (!stable) { seats[d.seat] = "observing"; why.push(`${d.fact} measured once`); }
      else if (seats[d.seat] !== "observing") seats[d.seat] = "agree";
    }
    const facts = drifts.map((d) => d.fact);
    const action = actionFor(r, facts);
    if (action === "amend_doctrine") {
      for (const d of drifts) {
        const problem = boundProblem(d.fact, d.observed);
        if (problem) { seats.aether = "refuse"; why.push(problem); }
      }
    }
    const values = Object.fromEntries(drifts.map((d) => [d.fact, d.observed]));
    const previousValues = Object.fromEntries(drifts.map((d) => [d.fact, d.doctrine]));
    const rendered = renderRule(r.template ?? r.rule, r.anchors, { ...Object.fromEntries(r.anchors.map((a) => [a.fact, a.value])), ...values });
    const status = seats.aether === "refuse" ? "refused" : Object.values(seats).every((v) => v === "agree") ? "propose" : "observing";
    const item = { rule: r.id, class: r.class, status, action, drifts, seats, reasons: why, text: rendered };
    if (status === "propose") {
      item.proposal = {
        action, target: r.id.replaceAll("_", "-"),
        params: { rule: r.id, values, previous: previousValues, canon: canonShort(canon), session, seats }
      };
    }
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------- storage

export const DOCTRINE_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS doctrine_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL,
    measured_at TEXT NOT NULL,
    seats_json TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_doctrine_facts_received ON doctrine_facts(received_at)",
  `CREATE TABLE IF NOT EXISTS doctrine_applied (
    amendment_id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    action TEXT NOT NULL,
    values_json TEXT NOT NULL,
    previous_json TEXT NOT NULL,
    canon TEXT NOT NULL,
    session_id TEXT NOT NULL,
    executed_by TEXT,
    executed_at TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS council_sessions (
    session_id TEXT PRIMARY KEY,
    held_at TEXT NOT NULL,
    mode TEXT NOT NULL,
    facts_at TEXT,
    review_json TEXT NOT NULL,
    proposals_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS council_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    action TEXT NOT NULL,
    values_json TEXT NOT NULL,
    proposal_id TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_council_proposals_rule ON council_proposals(rule_id, created_at)",
  "CREATE TABLE IF NOT EXISTS aether_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
]);
let ready = false;
export function resetDoctrineSchemaCacheForTests() { ready = false; }
async function ensureSchema(db) {
  if (ready) return;
  for (const sql of DOCTRINE_SCHEMA_SQL) await db.prepare(sql).run();
  ready = true;
}
const parse = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };

/** RPC: the AI Worker's hourly facts report. Stored as is; the council reads it at its session. */
export async function storeFacts(db, payload, { now = Date.now() } = {}) {
  const v = validateFacts(payload, { now });
  await ensureSchema(db);
  const at = new Date(now).toISOString();
  await db.prepare("INSERT INTO doctrine_facts (received_at, measured_at, seats_json) VALUES (?, ?, ?)").bind(at, v.measured_at, JSON.stringify(v.seats)).run();
  await db.prepare("DELETE FROM doctrine_facts WHERE received_at < ?").bind(new Date(now - FACTS_KEEP_MS).toISOString()).run();
  return { accepted: true, seats: Object.keys(v.seats), facts: Object.values(v.seats).reduce((n, s) => n + Object.keys(s.facts).length, 0) };
}

/** The latest facts report (fresh) and the newest one at least STABLE_GAP_MS older. */
export async function factsPair(db, { now = Date.now() } = {}) {
  await ensureSchema(db);
  const row = await db.prepare("SELECT received_at, measured_at, seats_json FROM doctrine_facts ORDER BY received_at DESC, id DESC LIMIT 1").first();
  if (!row || now - Date.parse(row.received_at) > FACTS_MAX_AGE_MS) return { latest: null, previous: null };
  const before = new Date(Date.parse(row.received_at) - STABLE_GAP_MS).toISOString();
  const prev = await db.prepare("SELECT received_at, measured_at, seats_json FROM doctrine_facts WHERE received_at <= ? ORDER BY received_at DESC, id DESC LIMIT 1").bind(before).first();
  const asReport = (r) => (r ? { received_at: r.received_at, measured_at: r.measured_at, seats: parse(r.seats_json, {}) } : null);
  return { latest: asReport(row), previous: asReport(prev) };
}

/** The amendments Cerebrum executed, as Aether applied them. */
export async function appliedAmendments(db) {
  await ensureSchema(db);
  const rows = (await db.prepare("SELECT * FROM doctrine_applied ORDER BY executed_at, amendment_id").all()).results || [];
  return rows.map((r) => ({ amendment_id: r.amendment_id, rule: r.rule_id, action: r.action, values: parse(r.values_json, {}), previous: parse(r.previous_json, {}), canon: r.canon, session: r.session_id, executed_by: r.executed_by, executed_at: r.executed_at, applied_at: r.applied_at }));
}

/** sha256 hex of the doctrine in force (the canon, plus the amendments applied to it). */
export async function effectiveSha(db, canon = CANON) {
  const applied = db ? await appliedAmendments(db).catch(() => []) : [];
  const live = applied.filter((a) => a.canon === canonShort(canon)).map((a) => a.amendment_id);
  if (!live.length) return canon.content_sha256;
  const data = new TextEncoder().encode(`${canon.content_sha256}|${live.join(",")}`);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function syscall(env, capability, input) {
  if (typeof env.AGENTS?.syscall !== "function") return { outcome: "unavailable" };
  try { return await env.AGENTS.syscall(COUNCIL_AGENT, capability, input); }
  catch (e) { return { outcome: "failed", reason: String(e?.message ?? e).slice(0, 200) }; }
}

/** Hourly: reads the amendments Cerebrum executed since the last one applied, and applies them. */
export async function syncAmendments(env, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  if (!db) return { status: "unavailable" };
  await ensureSchema(db);
  const last = await db.prepare("SELECT MAX(executed_at) AS at FROM doctrine_applied").first();
  const r = await syscall(env, "doctrine.status", last?.at ? { since: last.at } : {});
  if (r?.outcome !== "succeeded") return { status: r?.outcome ?? "failed", reason: r?.reason ?? null };
  let applied = 0;
  for (const a of r.result?.amendments || []) {
    if (!a?.amendment_id || !a.rule || !a.executed_at) continue;
    const res = await db.prepare("INSERT OR IGNORE INTO doctrine_applied (amendment_id, rule_id, action, values_json, previous_json, canon, session_id, executed_by, executed_at, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(a.amendment_id, a.rule, a.action, JSON.stringify(a.values ?? {}), JSON.stringify(a.previous ?? {}), String(a.canon ?? ""), String(a.session ?? ""), a.executed_by ?? null, a.executed_at, new Date(now).toISOString()).run();
    if (Number(res?.meta?.changes)) applied += 1;
  }
  // A proposal Cerebrum executed is marked executed (it stayed pending_owner after the owner's click,
  // since the propose answer is the only status the council saw; production 2026-11-19 to 11-22).
  const marked = await markExecutedProposals(db);
  return { status: "ok", applied, marked };
}

/** Every council proposal whose amendment Cerebrum executed (doctrine_applied) reads executed. Idempotent. */
export async function markExecutedProposals(db) {
  try {
    const r = await db.prepare("UPDATE council_proposals SET status = 'executed' WHERE status <> 'executed' AND proposal_id IN (SELECT amendment_id FROM doctrine_applied)").run();
    return Number(r?.meta?.changes) || 0;
  } catch { return 0; }
}

/**
 * The council's own proposals still open within the cooldown window (no final status stored, created within
 * PROPOSAL_COOLDOWN_MS: nothing older can hold the cooldown) are read back through consensus.status, STATUS_BATCH_MAX
 * ids a call: one that reads rejected or expired is stored so (a final row is never overwritten). Both keep the 7-day
 * cooldown, as a pending one does; only executed lifts it, and that comes from markExecutedProposals. not_found (not
 * the council's, or unknown), executed and pending_owner leave the row as it is (fail closed). A pending_owner whose
 * expires_at is past still counts as pending until the platform's sweep makes it read expired. A denial (the
 * capability not granted yet) waits STATUS_DENIAL_BACKOFF_MS and changes nothing. Never throws.
 */
export async function syncProposalStatuses(env, db, { now = Date.now() } = {}) {
  try {
    const until = Number((await db.prepare("SELECT value FROM aether_meta WHERE key = 'council_status_backoff_until'").first())?.value) || 0;
    if (until > now) return { status: "backoff", until: new Date(until).toISOString() };
    const open = ((await db.prepare("SELECT DISTINCT proposal_id FROM council_proposals WHERE proposal_id LIKE 'cns_%' AND status NOT IN ('executed', 'rejected', 'expired', 'failed', 'unavailable', 'denied') AND created_at >= ? ORDER BY proposal_id").bind(new Date(now - PROPOSAL_COOLDOWN_MS).toISOString()).all()).results || [])
      .map((r) => r.proposal_id).filter((id) => typeof id === "string" && PROPOSAL_ID.test(id));
    let read = 0, updated = 0;
    for (let i = 0; i < open.length; i += STATUS_BATCH_MAX) {
      const ids = open.slice(i, i + STATUS_BATCH_MAX);
      const r = await syscall(env, "consensus.status", { proposal_ids: ids });
      if (r?.outcome === "denied") {
        await db.prepare("INSERT INTO aether_meta (key, value, updated_at) VALUES ('council_status_backoff_until', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(String(now + STATUS_DENIAL_BACKOFF_MS), new Date(now).toISOString()).run();
        return { status: "denied", reason: String(r.reason ?? "").slice(0, 160), read, updated };
      }
      if (r?.outcome !== "succeeded") return { status: r?.outcome ?? "failed", reason: String(r?.reason ?? "").slice(0, 160), read, updated };
      for (const p of Array.isArray(r.result?.proposals) ? r.result.proposals : []) {
        if (!ids.includes(p?.proposal_id)) continue;
        read += 1;
        if (!STATUS_FINAL.includes(p.status)) continue;
        const res = await db.prepare("UPDATE council_proposals SET status = ? WHERE proposal_id = ? AND status NOT IN ('executed', 'rejected', 'expired')").bind(p.status, p.proposal_id).run();
        updated += Number(res?.meta?.changes) || 0;
      }
    }
    return { status: "ok", open: open.length, read, updated };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 160) };
  }
}

export const sessionIdAt = (now) => "kc_" + new Date(now).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-").toLowerCase();

/** Daily: the Knowledge Council's session. Never throws past its own steps. */
export async function runCouncil(env, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  if (!db) return { status: "unavailable" };
  await ensureSchema(db);
  const mode = ["off", "observe", "propose"].includes(String(env.KNOWLEDGE_COUNCIL ?? "").trim()) ? String(env.KNOWLEDGE_COUNCIL).trim() : "propose";
  if (mode === "off") return { status: "off" };
  const sync = await syncAmendments(env, { now });
  // The owner's decisions on the council's own proposals (consensus.status), before the cooldown reads them.
  const statuses = await syncProposalStatuses(env, db, { now });
  const session = sessionIdAt(now);
  const rules = effectiveDoctrine(await appliedAmendments(db)).map((r) => ({ ...r, template: (CANON.doctrine.rules.find((c) => c.id === r.id) || {}).template, anchors: r.anchors.map((a) => ({ fact: a.fact, format: a.format, value: a.value })) }));
  const { latest, previous } = await factsPair(db, { now });
  const review = latest ? councilReview({ rules, latest, previous, session }) : [];
  const at = new Date(now).toISOString();
  const proposals = [];
  if (mode === "propose") {
    for (const item of review.filter((x) => x.status === "propose")) {
      if (proposals.filter((p) => p.status !== "skipped").length >= MAX_PROPOSALS_PER_SESSION) break;
      const valuesJson = JSON.stringify(item.proposal.params.values);
      // The same values for the same rule are not asked again within 7 days while the owner has not decided
      // or has refused. An executed one does not count: its drift is back only because the canon moved on
      // and dropped it (a canon change drops every live amendment), so it is proposed again. A rejected or an
      // expired one (read through consensus.status) keeps the cooldown: an ignored proposal re-asked every ~48 h
      // would ask the owner about 15 times a month per rule (owner: "tidak perlu notif cerebrum terlalu sering").
      const recent = await db.prepare("SELECT status FROM council_proposals WHERE rule_id = ? AND values_json = ? AND created_at >= ? AND status NOT IN ('failed', 'unavailable', 'executed') ORDER BY created_at DESC LIMIT 1")
        .bind(item.rule, valuesJson, new Date(now - PROPOSAL_COOLDOWN_MS).toISOString()).first();
      if (recent) { proposals.push({ rule: item.rule, action: item.action, status: "skipped", detail: `proposed within 7 days (${recent.status})` }); continue; }
      const r = await syscall(env, "consensus.propose", item.proposal);
      const status = r?.outcome === "succeeded" ? String(r.result?.proposal?.status ?? "proposed") : String(r?.outcome ?? "failed");
      const proposalId = r?.result?.proposal?.proposal_id ?? null;
      const detail = r?.outcome === "succeeded" ? null : String(r?.reason ?? "").slice(0, 200);
      await db.prepare("INSERT INTO council_proposals (session_id, rule_id, action, values_json, proposal_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(session, item.rule, item.action, valuesJson, proposalId, status, detail, at).run();
      proposals.push({ rule: item.rule, action: item.action, proposal_id: proposalId, status, detail });
      if (r?.outcome === "denied") break; // a denial (rate limit, kill switch) is final for this session
    }
  }
  // An amendment Cerebrum executed during this session is applied now, not at the next hourly sync
  // (production 2026-11-11: both proposals executed at 03:52 and waited an hour to apply).
  const applied = proposals.some((p) => p.status === "executed") ? await syncAmendments(env, { now }) : null;
  const slim = review.map(({ rule, class: cls, status, action, drifts, seats, reasons, unreported }) => ({ rule, class: cls, status, action: action ?? null, drifts: drifts ?? [], seats: seats ?? null, reasons: reasons ?? [], unreported: unreported ?? [] }));
  await db.prepare("INSERT OR REPLACE INTO council_sessions (session_id, held_at, mode, facts_at, review_json, proposals_json) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(session, at, mode, latest?.received_at ?? null, JSON.stringify(slim), JSON.stringify(proposals)).run();
  const open = slim.filter((x) => x.status !== "in_sync");
  const report = await syscall(env, "reports.publish", {
    kind: "knowledge_audit", severity: open.some((x) => x.status === "refused" || x.status === "unreported") ? "warning" : "info",
    subject: !latest ? "Knowledge Council: no fresh facts from the AI Worker" : open.length ? `Knowledge Council: ${open.length} doctrine rule${open.length === 1 ? "" : "s"} differ from the measured system, ${proposals.filter((p) => p.proposal_id).length} proposed to Cerebrum` : "Knowledge Council: the doctrine matches the measured system",
    ai_status: "deterministic",
    body: { advisory: "Doctrine review; Cerebrum decides and executes every amendment.", session, mode, facts_at: latest?.received_at ?? null, open: open.slice(0, 20), proposals }
  });
  return { status: "ok", session, mode, facts: Boolean(latest), reviewed: slim.length, open: open.length, proposals, sync, statuses, applied, report: report?.outcome ?? null };
}

/** The doctrine for the overview: in force, retired, the last session, the facts' freshness. Never throws. */
export async function doctrineView(env, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  let applied = [], session = null, latest = null, recent = [];
  if (db) {
    try { applied = await appliedAmendments(db); } catch { applied = []; }
    try {
      const s = await db.prepare("SELECT * FROM council_sessions ORDER BY held_at DESC LIMIT 1").first();
      if (s) session = { session_id: s.session_id, held_at: s.held_at, mode: s.mode, facts_at: s.facts_at, review: parse(s.review_json, []), proposals: parse(s.proposals_json, []) };
    } catch { session = null; }
    try { latest = (await factsPair(db, { now })).latest; } catch { latest = null; }
    try { recent = ((await db.prepare("SELECT session_id, rule_id, action, values_json, proposal_id, status, detail, created_at FROM council_proposals ORDER BY created_at DESC LIMIT 20").all()).results || []).map((r) => ({ ...r, values: parse(r.values_json, {}), values_json: undefined })); } catch { recent = []; }
  }
  return {
    version: CANON.doctrine?.version ?? null, audited: CANON.doctrine?.audited ?? null,
    rules: effectiveDoctrine(applied),
    retired: (CANON.doctrine?.retired || []).map((r) => ({ id: r.id, retired: r.retired, superseded_by: r.superseded_by, reason: r.reason })),
    applied: applied.slice(-20).reverse(),
    council: { agent: COUNCIL_AGENT, schedule_utc: `daily ${String(COUNCIL_HOUR_UTC).padStart(2, "0")}:52`, mode: ["off", "observe", "propose"].includes(String(env.KNOWLEDGE_COUNCIL ?? "").trim()) ? String(env.KNOWLEDGE_COUNCIL).trim() : "propose", last_session: session, proposals: recent },
    facts: latest ? { received_at: latest.received_at, measured_at: latest.measured_at, seats: Object.fromEntries(Object.entries(latest.seats || {}).map(([k, s]) => [k, { version_id: s.version_id ?? null, facts: Object.keys(s.facts || {}).length }])) } : null
  };
}

// ---------------------------------------------------------------- Omega's policy (B-12, issue #227)
// Owner 2026-11-11 ("All": the deferred plans, B-12 among them; docs/PROPOSAL_AETHER_OMEGA_POLICY.md in
// xauusd): Aether is the source of Omega's risk policy. The values are the doctrine in force (the canon
// plus the amendments Cerebrum executed after the Knowledge Council and the owner approved them), never
// a value Aether invents. The xauusd Worker pulls this pack hourly and applies it only when the owner's
// switch OMEGA_POLICY_AUTO is on, within its own hard bounds.
export const OMEGA_POLICY_VERSION = "cryptophys.omega-policy.v1";
// Since ADR-0020 Amendment 10 the risk is per profile (`risk_pct_<profile>` and so on): xauusd's policy applies the
// single settings only (risk_pct, max_positions, max_daily_loss_pct), so the pack no longer carries them and the
// per-profile values are information for it until xauusd reads them.
const PROFILES = ["safe", "conservative", "aggressive", "custom"];
const OMEGA_POLICY_FACTS = Object.freeze({
  "omega.max_spread_points": "max_spread_points", "omega.max_signal_age_min": "max_signal_age_min",
  ...Object.fromEntries(PROFILES.flatMap((p) => ["risk_pct", "max_daily_loss_pct", "max_positions"].map((k) => [`omega.${k}_${p}`, `${k}_${p}`])))
});

/** Pure: Omega's policy from the doctrine in force; each value within the fact's bounds, else left out. */
export function omegaPolicyOf(rules) {
  const values = {}, amended = {};
  for (const r of rules || []) {
    for (const a of r.anchors || []) {
      const key = OMEGA_POLICY_FACTS[a.fact];
      if (!key || boundProblem(a.fact, a.value)) continue;
      values[key] = a.value;
      if (r.amended && !sameValue(a.value, a.canon_value)) amended[key] = { from: a.canon_value, amendment_id: r.amended.amendment_id, executed_at: r.amended.executed_at };
    }
  }
  return { values, amended };
}

/** The pack the xauusd Worker pulls: the values in force, the doctrine's sha and the amendments behind them. */
export async function omegaPolicy(env) {
  const db = env?.AETHER_DB;
  let applied = [];
  try { applied = db ? await appliedAmendments(db) : []; } catch { applied = []; }
  const { values, amended } = omegaPolicyOf(effectiveDoctrine(applied));
  return { version: OMEGA_POLICY_VERSION, doctrine_sha: await effectiveSha(db).catch(() => CANON.content_sha256), values, amended, advisory: "Applied by Omega only when its owner's switch is on, within its own hard bounds." };
}

// ---------------------------------------------------------------- the Positioning & Liquidity analyst's knobs
// xauusd docs/RFC_POSITIONING_LIQUIDITY.md §7.1: KnowledgeIngress.lensPolicy(), read by the hourly pull beside
// omegaPolicy(). The values are the doctrine in force (the canon rule lens_positioning_liquidity plus the amendments
// Cerebrum executed), each inside its hard bound, else left out; xauusd clamps again and falls back to its anchor.
export const LENS_POLICY_VERSION = "cryptophys.lens-policy.v1";

/** Pure: the lens knobs from the doctrine in force, by their flat fact names; each within its bound, else left out. */
export function lensPolicyOf(rules) {
  const values = {}, amended = {};
  for (const r of rules || []) {
    for (const a of r.anchors || []) {
      if (!Object.hasOwn(LENS_BOUNDS, a.fact) || boundProblem(a.fact, a.value)) continue;
      values[a.fact] = a.value;
      if (r.amended && !sameValue(a.value, a.canon_value)) amended[a.fact] = { from: a.canon_value, amendment_id: r.amended.amendment_id, executed_at: r.amended.executed_at };
    }
  }
  return { values, amended };
}

/** The pack xauusd pulls for the lens knobs: the values in force, the doctrine's sha and the amendments behind them. */
export async function lensPolicy(env) {
  const db = env?.AETHER_DB;
  let applied = [];
  try { applied = db ? await appliedAmendments(db) : []; } catch { applied = []; }
  const { values, amended } = lensPolicyOf(effectiveDoctrine(applied));
  return { version: LENS_POLICY_VERSION, doctrine_sha: await effectiveSha(db).catch(() => CANON.content_sha256), values, amended, advisory: "Read by the Positioning & Liquidity analyst within its own hard bounds; the owner's switches turn a lens off." };
}
