// The execution report (owner 2026-11-12, xauusd: "ya kerjakan kebijakan Omega di Signal Ledger sesuai
// dengan mode intraday, swing, dan scalping. Ini digunakan untuk inputan ke aether dan selanjutnya akan
// menjadi knowledge"). xauusd's Signal Ledger follows every Decision Engine signal under the plan (held to
// its chosen target) and under the Omega policy (Omega's entry, gates and key-level management), per
// trading mode, and sends the result here (KnowledgeIngress.ingestExecutionReport): R multiples, times,
// sessions and exits, never a price, level or size.
//
// Aether keeps the latest report and its curator turns a measured gap into a caution for the Omega seat
// (kind "caution", claim "measured_outcome", the kernel's contract: chart, session, decisive, wrong,
// baseline and an exact one-sided binomial p-value under 0.05), cited by the quarter-hour decision cards
// of the trades it counts:
//   omega_vs_plan  in one mode and session, Omega's management lost more of the same signals than
//                  holding them to the plan did;
//   omega_session  in one mode, Omega's trades in one session lost more often than in its other sessions.
// A person reviews each proposal; nothing here changes Omega, a setting or a decision.
import { baseItem, binomialTail, CAUTION } from "./knowledge.mjs";

export const EXECUTION_REPORT_SCHEMA = "cryptophys.execution-report.v1";
export const EXECUTION_MODES = Object.freeze(["scalp", "intraday", "swing"]);
export const EXECUTION_AGENT = "omega";
const SESSIONS = Object.freeze(["asia", "london", "new_york", "late"]);
const SESSION_WORD = Object.freeze({ asia: "Asia", london: "London", new_york: "New York", late: "late" });
const MAX_TRADES = 500;
const MAX_REPORT_BYTES = 256 * 1024;
const TRADE_KEYS = Object.freeze(["chart", "bar_open", "session", "mode", "side", "plan_r", "plan_exit", "omega_r", "omega_exit", "omega_size"]);
const EXIT = /^[a-z_]{1,24}$/;
const FORBIDDEN = new Set(["entry", "entry_price", "stop", "stop_loss", "take_profit", "tp", "tp1", "tp2", "price", "prices", "exit_price", "level", "levels", "key_levels", "zones", "lots", "volume", "size_lots", "balance", "equity", "profit", "money"]);
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isR = (v) => v === null || (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 50);

function forbidden(value, path = "report") {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbidden(v, `${path}[${i}]`));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => [...(FORBIDDEN.has(k) ? [`${path}.${k}`] : []), ...forbidden(v, `${path}.${k}`)]);
}

/** Pure: why an execution report is refused (empty when it may be stored). */
export function executionReportProblems(report) {
  if (!isObject(report)) return ["not_an_object"];
  const out = [];
  if (report.schema !== EXECUTION_REPORT_SCHEMA) out.push("unsupported_schema");
  if (!Number.isFinite(Date.parse(report.generated_at))) out.push("generated_at_invalid");
  if (!Number.isInteger(report.window_days) || report.window_days < 1 || report.window_days > 90) out.push("window_days_invalid");
  if (!isObject(report.modes) || Object.keys(report.modes).some((m) => !EXECUTION_MODES.includes(m))) out.push("modes_invalid");
  if (!Array.isArray(report.trades) || report.trades.length > MAX_TRADES) out.push("trades_invalid");
  else {
    const bad = report.trades.findIndex((t) => !isObject(t) || Object.keys(t).some((k) => !TRADE_KEYS.includes(k)) || t.chart !== "15" || !Number.isFinite(Date.parse(t.bar_open))
      || !SESSIONS.includes(t.session) || !EXECUTION_MODES.includes(t.mode) || (t.side !== "BUY" && t.side !== "SELL")
      || !isR(t.plan_r) || !isR(t.omega_r) || !(t.omega_size === null || (typeof t.omega_size === "number" && t.omega_size >= 0 && t.omega_size <= 1))
      || ![t.plan_exit, t.omega_exit].every((e) => e === null || (typeof e === "string" && EXIT.test(e))));
    if (bad >= 0) out.push(`trade_invalid:${bad}`);
  }
  for (const k of forbidden(report)) out.push(`forbidden_key:${k}`);
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > MAX_REPORT_BYTES) out.push("too_large");
  return out;
}

export const EXECUTION_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS execution_reports (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    report_json TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    received_at TEXT NOT NULL
  )`
]);
let ready = false;
export function resetExecutionSchemaCacheForTests() { ready = false; }
async function ensureSchema(db) {
  if (ready) return;
  for (const sql of EXECUTION_SCHEMA_SQL) await db.prepare(sql).run();
  ready = true;
}

/** KnowledgeIngress.ingestExecutionReport: keeps the latest valid report. */
export async function storeExecutionReport(db, report, { now = Date.now() } = {}) {
  const problems = executionReportProblems(report);
  if (problems.length) return { accepted: false, reason: problems.slice(0, 5).join(", ") };
  await ensureSchema(db);
  const at = new Date(now).toISOString();
  await db.prepare("INSERT INTO execution_reports (id, report_json, generated_at, received_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET report_json = excluded.report_json, generated_at = excluded.generated_at, received_at = excluded.received_at")
    .bind(JSON.stringify(report), String(report.generated_at), at).run();
  return { accepted: true, trades: report.trades.length };
}

/** The latest stored report, or null. */
export async function latestExecutionReport(db) {
  await ensureSchema(db);
  const row = await db.prepare("SELECT report_json, received_at FROM execution_reports WHERE id = 1").first();
  if (!row) return null;
  try { return { report: JSON.parse(row.report_json), received_at: row.received_at }; } catch { return null; }
}

/** Pure: the latest report reduced to what the Aether page shows (per mode; no trade list). */
export function executionSummary(latest) {
  if (!latest?.report) return null;
  const r = latest.report;
  return { generated_at: r.generated_at, received_at: latest.received_at, window_days: r.window_days, trades: (r.trades || []).length, modes: r.modes };
}

const pct = (x) => Math.round(x * 100);
const decisive = (r) => typeof r === "number" && Math.abs(r) > 1e-9;
const loss = (r) => typeof r === "number" && r < -1e-9;

function caution({ itemId, session, n, miss, baseN, baseMiss, text, cardIds }) {
  if (n < CAUTION.min_decisive || baseN < CAUTION.min_decisive || miss < 1) return null;
  const p0 = Math.max(0.01, baseMiss / baseN);
  if (miss / n <= p0) return null;
  const p = binomialTail(miss, n, p0);
  if (p >= CAUTION.alpha) return null;
  const ids = [...new Set(cardIds)].slice(-40);
  if (ids.length < 10) return null;
  const evidence = { agent: EXECUTION_AGENT, chart: "15", session, window_days: CAUTION.window_days, decisive: n, wrong: miss, wrong_pct: pct(miss / n), baseline_wrong_pct: pct(p0), baseline_decisive: baseN, p_value: Math.round(p * 1000) / 1000 };
  return baseItem({
    item_id: itemId, kind: "caution", claim_type: "measured_outcome",
    agents: [EXECUTION_AGENT, "moderator"], charts: ["15"], situation: { chart: "15", session },
    text: text(evidence), evidence, card_ids: ids
  });
}

/**
 * Pure: the curator's execution cautions from a report. `cardIdsFor(barOpenIso)` gives the quarter-hour
 * decision cards Aether holds for a trade's bar ([] when none). Only the last CAUTION.window_days count.
 */
export function executionCandidates(report, { now = Date.now(), cardIdsFor = () => [] } = {}) {
  if (!report || executionReportProblems(report).length) return [];
  const since = now - CAUTION.window_days * 86_400_000;
  const trades = report.trades.filter((t) => Date.parse(t.bar_open) >= since);
  const cites = (list) => list.flatMap((t) => cardIdsFor(t.bar_open));
  const pctText = (p) => (p >= 100 ? "every one" : `${p}%`);
  const out = [];
  for (const mode of EXECUTION_MODES) {
    const inMode = trades.filter((t) => t.mode === mode);
    for (const session of SESSIONS) {
      // Omega against the plan, on the same signals of this mode and session.
      const paired = inMode.filter((t) => t.session === session && decisive(t.omega_r) && decisive(t.plan_r));
      const a = caution({
        itemId: `k-exec-plan-${mode}-${session.replace("_", "-")}`, session,
        n: paired.length, miss: paired.filter((t) => loss(t.omega_r)).length,
        baseN: paired.length, baseMiss: paired.filter((t) => loss(t.plan_r)).length,
        cardIds: cites(paired),
        text: (e) => `In ${mode} mode on the quarter-hour chart in the ${SESSION_WORD[session]} session, Omega's management lost ${pctText(e.wrong_pct)} of ${e.decisive} decisive trades over ${e.window_days} days, where holding the same signals to the plan lost ${pctText(e.baseline_wrong_pct)}.`
      });
      if (a) out.push(a);
      // Omega in this session against its other sessions, in the same mode.
      const here = inMode.filter((t) => t.session === session && decisive(t.omega_r));
      const others = inMode.filter((t) => t.session !== session && decisive(t.omega_r));
      const b = caution({
        itemId: `k-exec-session-${mode}-${session.replace("_", "-")}`, session,
        n: here.length, miss: here.filter((t) => loss(t.omega_r)).length,
        baseN: others.length, baseMiss: others.filter((t) => loss(t.omega_r)).length,
        cardIds: cites(here),
        text: (e) => `In ${mode} mode on the quarter-hour chart, Omega's trades in the ${SESSION_WORD[session]} session lost ${pctText(e.wrong_pct)} of ${e.decisive} decisive trades over ${e.window_days} days, against ${pctText(e.baseline_wrong_pct)} in its other sessions.`
      });
      if (b) out.push(b);
    }
  }
  return out.sort((x, y) => x.evidence.p_value - y.evidence.p_value);
}

/** The curator's execution cautions from the latest stored report, cited by the cards Aether holds. */
export async function executionCuratorCandidates(db, { now = Date.now() } = {}) {
  const latest = await latestExecutionReport(db);
  if (!latest?.report) return [];
  const since = new Date(now - CAUTION.window_days * 86_400_000).toISOString();
  const rows = (await db.prepare("SELECT card_id, bar_open FROM decision_cards WHERE chart = '15' AND bar_open >= ?").bind(since).all()).results || [];
  const byOpen = new Map();
  for (const r of rows) byOpen.set(r.bar_open, [...(byOpen.get(r.bar_open) || []), r.card_id]);
  return executionCandidates(latest.report, { now, cardIdsFor: (iso) => byOpen.get(new Date(iso).toISOString()) || [] });
}
