// The H1 quorum weighting (owner decisions 2026-11-09 in xauusd: "nanti aether yang akan membuat tuning
// persamaan pembobotan berdasarkan hasil learning"; activation by approval in the Console; parameters
// AND components of the equation are tunable).
//
// xauusd replays its H1 quorum under every grid point next to the active weighting (xauusd
// src/weighting-replay.mjs) and sends the result here once an hour (KnowledgeIngress
// ingestWeightingReport). The calibrator proposes, at most one at a time, the candidate the replay rates
// better than the active point on discovery AND holdout, as a param_candidate of family "weighting".
// A person approves or rejects it in the Console; approval activates it in xauusd (its sweep checks the
// replay again and rolls it back automatically in reverse shadow). This is the one family where an
// approval activates rather than starts a shadow test, by the owner's decision.
//
// The report holds parameters, counts, accuracies and p-values only: a report with a price, level or
// size key is refused, like a decision card.
import { FORBIDDEN_KEYS } from "./card-guard.mjs";

export const WEIGHTING_REPORT_VERSION = "cryptophys.weighting-report.v1";
export const WEIGHTING_FAMILY = "weighting";
/** Mirrors xauusd src/weighting.mjs WEIGHTING_GRID. A change is a reviewed PR in both repositories. */
export const WEIGHTING_GRID = Object.freeze({
  prior: Object.freeze([5, 10, 20]),
  regime_prior: Object.freeze([null, 10, 30]),
  high_vol_quorum_bonus: Object.freeze([0, 0.05, 0.1]),
  weight_range: Object.freeze([Object.freeze([0.25, 2]), Object.freeze([0.5, 1.5]), Object.freeze([0.1, 3])]),
  days: Object.freeze([14, 30, 60]),
  half_life_days: Object.freeze([null, 7, 14]),
  calibration_beta: Object.freeze([0, 0.5, 1]),
  quorum_share: Object.freeze([0.5, 0.55, 0.6])
});
const KEYS = Object.keys(WEIGHTING_GRID);
const MAX_REPORT_BYTES = 64 * 1024;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Plain words for one changed parameter (no field names: the kernel refuses field talk). */
const PARAM_TEXT = Object.freeze({
  prior: (v) => `a track record needs ${v} decisive calls to move`,
  weight_range: (v) => `weights stay within ${v[0]} and ${v[1]}`,
  days: (v) => `the track record covers ${v} days`,
  half_life_days: (v) => (v == null ? "every call in the window counts the same" : `a call counts half after ${v} days`),
  calibration_beta: (v) => (v ? `confidence calibration counts with strength ${v}` : "confidence calibration does not count"),
  quorum_share: (v) => `an entry needs more than ${Math.round(v * 100)}% of the weight`,
  regime_prior: (v) => (v == null ? "the weight ignores the market regime" : `the weight follows the current regime with shrinkage ${v}`),
  high_vol_quorum_bonus: (v) => (v ? `high volatility adds ${Math.round(v * 100)} points to the quorum` : "the quorum ignores volatility")
});
/** A point of the first release had no regime keys: they take their defaults. */
const DEFAULTS = Object.freeze({ regime_prior: null, high_vol_quorum_bonus: 0 });
const complete = (p) => (p && typeof p === "object" && !Array.isArray(p) ? { ...DEFAULTS, ...p } : p);
export const WEIGHTING_TIMEFRAMES = Object.freeze(["15", "60", "240", "1D"]);

/**
 * The Decision Engine's witness weights (owner 2026-11-11 in xauusd: "harusnya bobot itu dinamis sesuai
 * dengan auto tune yang ada di aether"). xauusd src/witness-tuning.mjs replays its stored decisions under
 * the sets next to the active one and activates or rolls back by itself, like the rooms; its report comes
 * here under timeframe "engine" for the audit. Aether proposes nothing from it.
 */
export const WITNESS_REPORT_VERSION = "cryptophys.witness-weighting-report.v1";
export const WITNESS_TIMEFRAME = "engine";
/** Mirrors xauusd src/witness-tuning.mjs (WITNESS_KEYS, WITNESS_MIN, WITNESS_MAX); the doctrine caps a weight at 0.3. */
export const WITNESS_KEYS = Object.freeze(["D1", "H4", "H1", "M15", "NEWS", "MACRO", "STRATEGY", "KEY_LEVELS", "REGIME", "TREND_TF", "MACRO_DRIVERS", "SESSION"]);
const WITNESS_MIN = 0.02, WITNESS_MAX = 0.28;

/** Pure: why a witness weight set may not be stored (empty when all 12 witnesses sit inside their bounds and sum to 1). */
export function witnessWeightsProblems(w) {
  if (!isObject(w)) return ["not_an_object"];
  const out = [];
  for (const k of Object.keys(w)) if (!WITNESS_KEYS.includes(k)) out.push(`unknown_witness:${k}`);
  for (const k of WITNESS_KEYS) {
    const v = w[k];
    if (typeof v !== "number" || !Number.isFinite(v)) out.push(`missing:${k}`);
    else if (v < WITNESS_MIN - 1e-9 || v > WITNESS_MAX + 1e-9) out.push(`out_of_bounds:${k}`);
  }
  if (!out.length && Math.abs(WITNESS_KEYS.reduce((s, k) => s + w[k], 0) - 1) > 0.001) out.push("sum_not_1");
  return out;
}

/** Pure: why a grid point may not be proposed (empty when every key is on the reviewed grid). */
export function pointProblems(raw) {
  if (!isObject(raw)) return ["not_an_object"];
  const params = complete(raw);
  const out = [];
  for (const k of Object.keys(params)) if (!KEYS.includes(k)) out.push(`unknown_key:${k}`);
  for (const k of KEYS) if (!(k in params) || !WEIGHTING_GRID[k].some((v) => same(v, params[k]))) out.push(`off_grid:${k}`);
  return out;
}

function forbidden(value, path = "report") {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbidden(v, `${path}[${i}]`));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => [...(FORBIDDEN_KEYS.includes(k) ? [`${path}.${k}`] : []), ...forbidden(v, `${path}.${k}`)]);
}

/** Pure: why a weighting report is refused (empty when it may be stored). */
export function reportProblems(report) {
  if (!isObject(report)) return ["not_an_object"];
  const out = [];
  const witness = report.version === WITNESS_REPORT_VERSION;
  if (report.version !== WEIGHTING_REPORT_VERSION && !witness) out.push("unsupported_version");
  if (witness) {
    if (report.timeframe !== WITNESS_TIMEFRAME) out.push("timeframe_invalid");
    if (!isObject(report.active) || witnessWeightsProblems(report.active.params).length) out.push("active_invalid");
    if (Array.isArray(report.candidates) && report.candidates.some((c) => !isObject(c) || witnessWeightsProblems(c.params).length)) out.push("candidate_invalid");
  } else {
    if (!isObject(report.active) || pointProblems(complete(report.active.params)).length) out.push("active_invalid");
    if (report.timeframe !== undefined && !WEIGHTING_TIMEFRAMES.includes(report.timeframe)) out.push("timeframe_invalid");
  }
  if (!Array.isArray(report.candidates) || report.candidates.length > 30) out.push("candidates_invalid");
  if (!Array.isArray(report.agents) || report.agents.length > 40) out.push("agents_invalid");
  for (const k of forbidden(report)) out.push(`forbidden_key:${k}`);
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > MAX_REPORT_BYTES) out.push("too_large");
  return out;
}

export const WEIGHTING_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS weighting_reports (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    report_json TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    received_at TEXT NOT NULL
  )`,
  // Owner decisions 2026-11-09 (xauusd): one weighting per timeframe, tuned automatically; Aether keeps
  // the latest report of each timeframe as an audit.
  `CREATE TABLE IF NOT EXISTS weighting_reports_tf (
    timeframe TEXT PRIMARY KEY,
    report_json TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    received_at TEXT NOT NULL
  )`
]);
let ready = false;
export function resetWeightingSchemaCacheForTests() { ready = false; }
async function ensureSchema(db) {
  if (ready) return;
  for (const sql of WEIGHTING_SCHEMA_SQL) await db.prepare(sql).run();
  ready = true;
}

/** KnowledgeIngress.ingestWeightingReport: keeps the latest valid report. */
export async function storeWeightingReport(db, report, { now = Date.now() } = {}) {
  const problems = reportProblems(report);
  if (problems.length) return { accepted: false, reason: problems.slice(0, 5).join(", ") };
  await ensureSchema(db);
  const at = new Date(now).toISOString();
  await db.prepare("INSERT INTO weighting_reports_tf (timeframe, report_json, generated_at, received_at) VALUES (?, ?, ?, ?) ON CONFLICT(timeframe) DO UPDATE SET report_json = excluded.report_json, generated_at = excluded.generated_at, received_at = excluded.received_at")
    .bind(report.timeframe ?? "60", JSON.stringify(report), String(report.generated_at ?? at), at).run();
  return { accepted: true };
}

/** The latest stored report of a timeframe (the 1H one by default), or null. */
export async function latestWeightingReport(db, timeframe = "60") {
  await ensureSchema(db);
  let row = await db.prepare("SELECT report_json, received_at FROM weighting_reports_tf WHERE timeframe = ?").bind(timeframe).first();
  if (!row && timeframe === "60") row = await db.prepare("SELECT report_json, received_at FROM weighting_reports WHERE id = 1").first();
  if (!row) return null;
  try { return { report: JSON.parse(row.report_json), received_at: row.received_at }; } catch { return null; }
}

/** The latest report of every timeframe (for /health). */
export async function weightingReports(db) {
  await ensureSchema(db);
  const rows = (await db.prepare("SELECT timeframe, report_json, received_at FROM weighting_reports_tf ORDER BY timeframe").all()).results || [];
  return rows.map((r) => { try { return { timeframe: r.timeframe, report: JSON.parse(r.report_json), received_at: r.received_at }; } catch { return null; } }).filter(Boolean);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pct = (x) => Math.round(x * 100);

/**
 * Pure: the calibrator's weighting proposal from the latest report, or null. Only a candidate rated
 * better_than_active with a complete holdout, on the reviewed grid; the lowest Holm-adjusted p first,
 * then the larger gain. `pending` is true while a weighting proposal awaits review (one at a time);
 * `proposed` holds item ids already proposed. `cardIds` are the hourly decision cards it cites.
 */
export function weightingCandidate(report, { cardIds = [], pending = false, proposed = new Set(), canon } = {}) {
  // Owner decisions 2026-11-09: xauusd tunes and activates the weighting itself ("mode": "auto");
  // Aether audits the reports and proposes nothing.
  if (report?.mode === "auto") return null;
  if (pending || !report || cardIds.length < 10) return null;
  const ok = (report.candidates || []).filter((c) => String(c.verdict).startsWith("better_than_active") && c.holdout?.complete === true && !pointProblems(c.params).length && Number.isFinite(c.discovery?.accuracy) && Number.isFinite(c.discovery?.control_accuracy));
  ok.sort((a, b) => (a.discovery.p_holm ?? 1) - (b.discovery.p_holm ?? 1) || (b.discovery.accuracy - b.discovery.control_accuracy) - (a.discovery.accuracy - a.discovery.control_accuracy));
  for (const c of ok) {
    const value = c.params[c.changed];
    const item_id = ("k-weighting-" + slug(c.changed) + "-" + slug(JSON.stringify(value))).slice(0, 42).replace(/-$/, "");
    if (proposed.has(item_id)) continue;
    const change = PARAM_TEXT[c.changed] ? PARAM_TEXT[c.changed](value) : null;
    if (!change) continue;
    const acc = pct(c.discovery.accuracy), ctrl = pct(c.discovery.control_accuracy);
    const text = `Replayed over ${report.window_days} days, the hourly quorum was right in ${acc}% of its decided calls when ${change}, against ${ctrl}% with the active weighting, and it held on the newest rooms. Approving activates it for the hourly decision; it rolls back if it does worse.`;
    if (text.length > 300) continue;
    return {
      schema: "cryptophys.knowledge-item.v1", item_id, version: 1, kind: "param_candidate", claim_type: "measured_outcome", label: "learned",
      audience: { agents: ["moderator"], charts: ["60"] },
      situation: { family: WEIGHTING_FAMILY, changed: c.changed },
      text,
      evidence: {
        window_days: report.window_days, rooms: report.rooms, candidate: c.id, active: report.active?.id ?? null,
        accuracy: c.discovery.accuracy, control_accuracy: c.discovery.control_accuracy, p_holm: c.discovery.p_holm ?? null,
        discovery_rooms: c.discovery.bars, holdout_rooms: c.holdout.bars, holdout_accuracy: c.holdout.accuracy ?? null, holdout_control_accuracy: c.holdout.control_accuracy ?? null,
        proposed_value: value, active_value: report.active?.params?.[c.changed] ?? null
      },
      provenance: { card_ids: cardIds.slice(-40), canon_sha: canon.content_sha256, canon_version: canon.version, source: "aether" },
      params: {
        family: WEIGHTING_FAMILY, grid: `WEIGHTING_GRID.${c.changed}`, values: complete(c.params),
        hypothesis: "the replayed hourly quorum is right more often than with the active weighting, on discovery and on the holdout",
        metric: "paired sign test on decisive pairs, one-sided, alpha 0.05 (Holm-adjusted), 100-room holdout; approval activates; reverse shadow rollback"
      }
    };
  }
  return null;
}
