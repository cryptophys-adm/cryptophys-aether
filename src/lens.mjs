// The Positioning & Liquidity analyst's daily lens report (xauusd docs/RFC_POSITIONING_LIQUIDITY.md §10; owner
// breakglass 2026-11-20). xauusd sends cryptophys.lens-report.v1 through KnowledgeIngress.ingestLensReport: per lens
// the weight in force per trading mode with its source (anchor, aether, floor_rollback, switch_off, ...), the outcome
// score, whether the lens sits at its floor, lens B's baseline and lens A's report age. Shares, counts and times only;
// never a price, level or size. Aether keeps the latest valid report for the overview and the Knowledge Council; it
// changes nothing in xauusd (the knobs move only through the doctrine protocol, src/doctrine.mjs lensPolicy).

export const LENS_REPORT_SCHEMA = "cryptophys.lens-report.v1";
export const LENS_REPORT_LENSES = Object.freeze(["positioning", "liquidity"]);
const MODES = Object.freeze(["scalp", "intraday", "swing", "range"]);
const MAX_REPORT_BYTES = 32 * 1024;
const SOURCE = /^[a-z][a-z_]{0,40}$/;
// Exact key names, as the execution report (src/execution.mjs): a substring rule would refuse a fair key such as
// "slope". xauusd refuses on the wider substring rule before it sends.
const FORBIDDEN = new Set(["entry", "entry_price", "stop", "stop_loss", "sl", "take_profit", "tp", "tp1", "tp2", "price", "prices", "exit_price", "level", "levels", "key_levels", "zone", "zones", "target", "bid", "ask", "lots", "volume", "size_lots", "balance", "equity", "profit", "money", "account", "login"]);
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const share = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function forbidden(value, path = "report") {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbidden(v, `${path}[${i}]`));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => [...(FORBIDDEN.has(k) ? [`${path}.${k}`] : []), ...forbidden(v, `${path}.${k}`)]);
}

/** Pure: why a lens report is refused (empty when it may be stored). */
export function lensReportProblems(report) {
  if (!isObject(report)) return ["not_an_object"];
  const out = [];
  if (report.schema !== LENS_REPORT_SCHEMA) out.push("unsupported_schema");
  if (!Number.isFinite(Date.parse(report.generated_at))) out.push("generated_at_invalid");
  if (report.doctrine_sha != null && !(typeof report.doctrine_sha === "string" && /^[0-9a-f]{8,64}$/.test(report.doctrine_sha))) out.push("doctrine_sha_invalid");
  if (!isObject(report.lenses) || Object.keys(report.lenses).some((k) => !LENS_REPORT_LENSES.includes(k))) out.push("lenses_invalid");
  else {
    for (const name of LENS_REPORT_LENSES) {
      const l = report.lenses[name];
      if (!isObject(l) || typeof l.enabled !== "boolean" || typeof l.floored !== "boolean" || !isObject(l.weights)) { out.push(`lens_invalid:${name}`); continue; }
      const modes = Object.keys(l.weights);
      const badMode = modes.length !== MODES.length || MODES.some((m) => {
        const w = l.weights[m];
        return !isObject(w) || !share(w.weight) || !(typeof w.source === "string" && SOURCE.test(w.source));
      }) || modes.some((m) => !MODES.includes(m));
      if (badMode) out.push(`weights_invalid:${name}`);
    }
    if (!LENS_REPORT_LENSES.some((n) => report.lenses[n] != null)) out.push("lenses_invalid");
  }
  for (const k of forbidden(report)) out.push(`forbidden_key:${k}`);
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > MAX_REPORT_BYTES) out.push("too_large");
  return out;
}

export const LENS_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS lens_reports (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    report_json TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    received_at TEXT NOT NULL
  )`
]);
let ready = false;
export function resetLensSchemaCacheForTests() { ready = false; }
async function ensureSchema(db) {
  if (ready) return;
  for (const sql of LENS_SCHEMA_SQL) await db.prepare(sql).run();
  ready = true;
}

/** KnowledgeIngress.ingestLensReport: keeps the latest valid report. */
export async function storeLensReport(db, report, { now = Date.now() } = {}) {
  const problems = lensReportProblems(report);
  if (problems.length) return { accepted: false, reason: problems.slice(0, 5).join(", ") };
  if (!db) return { accepted: false, reason: "unavailable" };
  await ensureSchema(db);
  await db.prepare("INSERT INTO lens_reports (id, report_json, generated_at, received_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET report_json = excluded.report_json, generated_at = excluded.generated_at, received_at = excluded.received_at WHERE excluded.generated_at >= lens_reports.generated_at")
    .bind(JSON.stringify(report), String(report.generated_at), new Date(now).toISOString()).run();
  return { accepted: true };
}

/** The latest stored report, or null. */
export async function latestLensReport(db) {
  if (!db) return null;
  await ensureSchema(db);
  const row = await db.prepare("SELECT report_json, received_at FROM lens_reports WHERE id = 1").first();
  if (!row) return null;
  try { return { report: JSON.parse(row.report_json), received_at: row.received_at }; } catch { return null; }
}
