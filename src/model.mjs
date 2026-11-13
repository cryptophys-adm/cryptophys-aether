// The model report (xauusd, owner 2026-11-13: "strengthen autonomous learning & knowledge looping";
// xauusd docs/RFC_CUSTOM_MODEL.md). xauusd's baseline model retrains itself every hour on its own
// decisions' outcomes (src/model-baseline.mjs there) and sends what it learned here
// (KnowledgeIngress.ingestModelReport): its walk-forward scores, its prospective record (predictions made
// before each decision, scored after) and the features each model leaned on. Scores and feature names
// only: never a price, level, weight table or size.
//
// Aether keeps the latest report as knowledge and shows it on its page (src/reader.mjs). It proposes
// nothing from it yet: a model only advises until xauusd's verdict and the owner promote it.
//
// Since 2026-11-13 (owner: "lanjutkan perluas model report gbm ke Aether") the report may also carry
// `gbm`: xauusd's daily decision model (LightGBM, trained by GitHub Actions; xauusd src/model-gbm.mjs),
// shadow only. Its walk-forward checks, its prospective record and the features it split on (by gain);
// never a tree, a threshold or a leaf value.

export const MODEL_REPORT_SCHEMA = "cryptophys.model-report.v1";
export const MODEL_IDS = Object.freeze(["tight_long", "tight_short", "wide_long", "wide_short"]);
const MAX_REPORT_BYTES = 64 * 1024;
const FEATURE = /^[a-z0-9_]{1,64}$/;
const SCORE_KEYS = Object.freeze(["n", "train", "hit_rate", "brier", "brier_base", "skill", "p_value", "auc", "picked", "picked_hit_rate", "picked_mean_r", "all_mean_r"]);
const PROMOTION_STATUS = Object.freeze(["promoted", "not_promoted"]);
const NOTE_STATUS = Object.freeze(["live", "retired"]);
const AGENT = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const iso = (v) => v === null || v === undefined || Number.isFinite(Date.parse(v));
const text = (v, max) => v === null || v === undefined || (typeof v === "string" && v.length <= max);
const FORBIDDEN = new Set(["entry", "entry_price", "stop", "stop_loss", "take_profit", "tp", "tp1", "tp2", "price", "prices", "level", "levels", "key_levels", "zones", "lots", "volume", "size_lots", "balance", "equity", "profit", "money", "weights", "scale", "bias"]);
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const score = (v) => v === null || (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e6);

function forbidden(value, path = "report") {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbidden(v, `${path}[${i}]`));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => [...(FORBIDDEN.has(k) ? [`${path}.${k}`] : []), ...forbidden(v, `${path}.${k}`)]);
}

function scoresProblems(scores, path, importance = "weight") {
  if (!isObject(scores)) return [`${path}_invalid`];
  const out = [];
  for (const [k, v] of Object.entries(scores)) {
    if (k === "top_features") {
      if (!Array.isArray(v) || v.length > 20 || v.some((f) => !isObject(f) || !FEATURE.test(String(f.feature)) || !score(f[importance]) || Object.keys(f).some((x) => x !== "feature" && x !== importance))) out.push(`${path}.top_features_invalid`);
    } else if (!SCORE_KEYS.includes(k) || !score(v)) out.push(`${path}.${k}_invalid`);
  }
  return out;
}

const GBM_STATUS = Object.freeze(["ok", "not_enough_rows"]);

/** Pure: the problems of a report's optional `gbm` block (the daily decision model, shadow only). */
function gbmProblems(g) {
  if (g == null) return [];
  if (!isObject(g)) return ["gbm_invalid"];
  const out = [];
  const allowed = new Set(["model_id", "trained_at", "rows", "features", "status", "walk_forward", "prospective", "connected"]);
  for (const k of Object.keys(g)) if (!allowed.has(k)) out.push(`gbm.${k}_unexpected`);
  if (typeof g.model_id !== "string" || !/^gbm@[0-9T:\-]{16,20}Z$/.test(g.model_id)) out.push("gbm.model_id_invalid");
  if (!Number.isFinite(Date.parse(g.trained_at))) out.push("gbm.trained_at_invalid");
  if (!Number.isInteger(g.rows) || g.rows < 0) out.push("gbm.rows_invalid");
  if (!Number.isInteger(g.features) || g.features < 0) out.push("gbm.features_invalid");
  if (!GBM_STATUS.includes(g.status)) out.push("gbm.status_invalid");
  if (g.connected !== false) out.push("gbm.connected_invalid");
  for (const part of ["walk_forward", "prospective"]) {
    const v = g[part];
    if (!isObject(v) || Object.keys(v).some((id) => !MODEL_IDS.includes(id))) { out.push(`gbm.${part}_invalid`); continue; }
    for (const [id, s] of Object.entries(v)) out.push(...scoresProblems(s, `gbm.${part}.${id}`, "gain"));
  }
  return out;
}

/** Pure: why a model report is refused (empty when it may be stored). */
export function modelReportProblems(report) {
  if (!isObject(report)) return ["not_an_object"];
  const out = [];
  if (report.schema !== MODEL_REPORT_SCHEMA) out.push("unsupported_schema");
  if (!Number.isFinite(Date.parse(report.generated_at))) out.push("generated_at_invalid");
  if (typeof report.model_id !== "string" || !/^baseline@[0-9T:\-]{16,20}Z$/.test(report.model_id)) out.push("model_id_invalid");
  if (!Number.isInteger(report.rows) || report.rows < 0) out.push("rows_invalid");
  for (const part of ["walk_forward", "prospective"]) {
    const v = report[part];
    if (!isObject(v) || Object.keys(v).some((id) => !MODEL_IDS.includes(id))) { out.push(`${part}_invalid`); continue; }
    for (const [id, s] of Object.entries(v)) out.push(...scoresProblems(s, `${part}.${id}`));
  }
  // Since 2026-11-13 (owner: "Pastikan Modul training ini punya visualisasi di cerebrum"): whether the model is
  // connected to the council, the gate's rules, and the learned notes xauusd put live by itself. Optional.
  const pr = report.promotion;
  if (pr != null && (!isObject(pr) || !PROMOTION_STATUS.includes(pr.status) || !(pr.set == null || ["tight", "wide"].includes(pr.set)) || !text(pr.reason, 400) || !iso(pr.since))) out.push("promotion_invalid");
  if (report.gate != null && (!isObject(report.gate) || Object.values(report.gate).some((v) => !score(v)))) out.push("gate_invalid");
  const notes = report.live_notes;
  if (notes != null && (!Array.isArray(notes) || notes.length > 20 || notes.some((n) => !isObject(n) || typeof n.item_id !== "string" || !/^[a-z0-9][a-z0-9_.:-]{2,95}$/.test(n.item_id)
    || !Number.isInteger(n.version) || !NOTE_STATUS.includes(n.status) || !Array.isArray(n.agents) || n.agents.length > 8 || n.agents.some((a) => !AGENT.test(String(a)))
    || !(n.chart == null || ["15", "60", "240", "1D"].includes(n.chart)) || !iso(n.promoted_at) || !iso(n.retired_at) || !text(n.reason, 300) || "text" in n))) out.push("live_notes_invalid");
  out.push(...gbmProblems(report.gbm));
  for (const k of forbidden(report)) out.push(`forbidden_key:${k}`);
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > MAX_REPORT_BYTES) out.push("too_large");
  return out;
}

export const MODEL_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS model_reports (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    report_json TEXT NOT NULL,
    model_id TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    received_at TEXT NOT NULL
  )`
]);
let ready = false;
export function resetModelSchemaCacheForTests() { ready = false; }
async function ensureSchema(db) {
  if (ready) return;
  for (const sql of MODEL_SCHEMA_SQL) await db.prepare(sql).run();
  ready = true;
}

/** KnowledgeIngress.ingestModelReport: keeps the latest valid report. */
export async function storeModelReport(db, report, { now = Date.now() } = {}) {
  const problems = modelReportProblems(report);
  if (problems.length) return { accepted: false, reason: problems.slice(0, 5).join(", ") };
  await ensureSchema(db);
  await db.prepare("INSERT INTO model_reports (id, report_json, model_id, generated_at, received_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET report_json = excluded.report_json, model_id = excluded.model_id, generated_at = excluded.generated_at, received_at = excluded.received_at")
    .bind(JSON.stringify(report), report.model_id, String(report.generated_at), new Date(now).toISOString()).run();
  return { accepted: true, models: Object.keys(report.walk_forward).length };
}

/** The latest stored report, or null. */
export async function latestModelReport(db) {
  await ensureSchema(db);
  const row = await db.prepare("SELECT report_json, received_at FROM model_reports WHERE id = 1").first();
  if (!row) return null;
  try { return { report: JSON.parse(row.report_json), received_at: row.received_at }; } catch { return null; }
}

/** Pure: per model id its walk-forward and prospective scores and its top features (names only). */
function modelRows(walkForward, prospective) {
  return MODEL_IDS.filter((id) => walkForward?.[id] || prospective?.[id]).map((id) => {
    const w = walkForward?.[id] || null, p = prospective?.[id] || null;
    return {
      id, walk_forward: w ? { n: w.n, skill: w.skill, auc: w.auc, picked: w.picked, picked_mean_r: w.picked_mean_r, all_mean_r: w.all_mean_r } : null,
      prospective: p ? { n: p.n, skill: p.skill, auc: p.auc, picked: p.picked, picked_mean_r: p.picked_mean_r, all_mean_r: p.all_mean_r, p_value: p.p_value ?? null } : null,
      top_features: (w?.top_features || []).slice(0, 6).map((f) => f.feature)
    };
  });
}

/** Pure: what the Aether page shows: per model its walk-forward and prospective skill and its top features. */
export function modelSummary(latest) {
  if (!latest?.report) return null;
  const r = latest.report;
  const g = r.gbm;
  const gbm = g ? { model_id: g.model_id, trained_at: g.trained_at, rows: g.rows, features: g.features, status: g.status, connected: false, models: modelRows(g.walk_forward, g.prospective) } : null;
  return { model_id: r.model_id, generated_at: r.generated_at, received_at: latest.received_at, rows: r.rows, models: modelRows(r.walk_forward, r.prospective), promotion: r.promotion ?? null, gate: r.gate ?? null, live_notes: r.live_notes ?? [], gbm };
}
