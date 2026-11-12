// The Signal Ledger's execution report (xauusd, owner 2026-11-12: "kebijakan Omega di Signal Ledger sesuai
// dengan mode intraday, swing, dan scalping ... inputan ke aether dan selanjutnya akan menjadi knowledge").
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  executionReportProblems, storeExecutionReport, latestExecutionReport, executionSummary, executionCandidates,
  resetExecutionSchemaCacheForTests, EXECUTION_REPORT_SCHEMA
} from "../src/execution.mjs";
import { ingestCards, resetSchemaCacheForTests } from "../src/store.mjs";
import { runCuration, resetKnowledgeSchemaCacheForTests } from "../src/knowledge.mjs";
import { aetherOverview } from "../src/reader.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}

const NOW = Date.parse("2026-12-10T12:00:00Z");
const M = 15 * 60_000;
const DAY = 86_400_000;
/** A London (09:00 UTC) quarter-hour bar `i` days before NOW. */
const london = (i) => Date.parse("2026-12-09T09:00:00Z") - i * DAY;
const asia = (i) => Date.parse("2026-12-09T03:00:00Z") - i * DAY;
const trade = (ms, over = {}) => ({ chart: "15", bar_open: new Date(ms).toISOString(), session: new Date(ms).getUTCHours() < 7 ? "asia" : "london", mode: "scalp", side: "SELL", plan_r: 1.2, plan_exit: "target", omega_r: 0.8, omega_exit: "power_reversal", omega_size: 1, ...over });
const report = (trades) => ({
  schema: EXECUTION_REPORT_SCHEMA, generated_at: new Date(NOW).toISOString(), window_days: 30, ledger_version: "cryptophys.signal-ledger.v1", omega_policy_version: "cryptophys.ledger-omega.v1",
  rules: { unit: "R" }, modes: { scalp: { signals: trades.length }, intraday: { signals: 0 }, swing: { signals: 0 } }, trades
});
// 20 London scalp signals: Omega lost 12 of them, the plan (held to its target) lost 3.
const LONDON = Array.from({ length: 20 }, (_, i) => trade(london(i), { omega_r: i < 12 ? -1 : 0.6, omega_exit: i < 12 ? "stop" : "sl_plus", plan_r: i < 3 ? -1 : 1.5 }));
// 20 Asia scalp signals: both lose 3.
const ASIA = Array.from({ length: 20 }, (_, i) => trade(asia(i), { omega_r: i < 3 ? -1 : 0.5, plan_r: i < 3 ? -1 : 1 }));
const cardsFor = (iso) => [`d:15:${Date.parse(iso)}:0`];

test("E1. a report carries R, times and exits only; a price, a level, a size or a malformed trade is refused", () => {
  assert.deepEqual(executionReportProblems(report(LONDON)), []);
  assert.ok(executionReportProblems({ ...report(LONDON), schema: "x" }).includes("unsupported_schema"));
  assert.ok(executionReportProblems(report([{ ...LONDON[0], entry: 4012.5 }])).some((p) => p.startsWith("trade_invalid") || p.startsWith("forbidden_key")));
  assert.ok(executionReportProblems({ ...report(LONDON), modes: { scalp: { tp1: 4000 } } }).includes("forbidden_key:report.modes.scalp.tp1"));
  assert.deepEqual(executionReportProblems(report([{ ...LONDON[0], omega_r: 4012.5 }])), ["trade_invalid:0"], "an R of 4012.5 is a price");
  assert.deepEqual(executionReportProblems(report([{ ...LONDON[0], mode: "hft" }])), ["trade_invalid:0"]);
  assert.deepEqual(executionReportProblems(report([{ ...LONDON[0], chart: "60" }])), ["trade_invalid:0"]);
});

test("E2. the curator cautions Omega where its management lost more of the same signals than the plan, and where one session lost more than the others", () => {
  const items = executionCandidates(report([...LONDON, ...ASIA]), { now: NOW, cardIdsFor: cardsFor });
  const ids = items.map((i) => i.item_id).sort();
  assert.deepEqual(ids, ["k-exec-plan-scalp-london", "k-exec-session-scalp-london"]);
  const a = items.find((i) => i.item_id === "k-exec-plan-scalp-london");
  assert.equal(a.kind, "caution");
  assert.equal(a.claim_type, "measured_outcome");
  assert.deepEqual(a.situation, { chart: "15", session: "london" });
  assert.deepEqual(a.audience, { agents: ["omega", "moderator"], charts: ["15"] });
  assert.deepEqual({ ...a.evidence, p_value: undefined }, { agent: "omega", chart: "15", session: "london", window_days: 30, decisive: 20, wrong: 12, wrong_pct: 60, baseline_wrong_pct: 15, baseline_decisive: 20, p_value: undefined });
  assert.ok(a.evidence.p_value < 0.05);
  assert.equal(a.text, "In scalp mode on the quarter-hour chart in the London session, Omega's management lost 60% of 20 decisive trades over 30 days, where holding the same signals to the plan lost 15%.");
  assert.equal(a.provenance.card_ids.length, 20);
  const b = items.find((i) => i.item_id === "k-exec-session-scalp-london");
  assert.deepEqual([b.evidence.wrong_pct, b.evidence.baseline_wrong_pct, b.evidence.baseline_decisive], [60, 15, 20]);
  // No knowledge text carries a price-like number, a level word or a field name.
  for (const it of items) {
    assert.ok(it.text.length <= 300);
    assert.ok(!/\d{3,}/.test(it.text) && !/\b(?:prices?|levels?|sizes?|entries?|targets?|support|resistance|zones?)\b/i.test(it.text) && !/\b[a-z]+_[a-z0-9_]+\b/.test(it.text), it.text);
  }
});

test("E3. no caution below the sample, without a gap, outside the window, or without ten cited cards", () => {
  assert.deepEqual(executionCandidates(report(LONDON.slice(0, 11)), { now: NOW, cardIdsFor: cardsFor }), [], "11 decisive trades are too few");
  assert.deepEqual(executionCandidates(report(ASIA), { now: NOW, cardIdsFor: cardsFor }), [], "the same loss rate is no caution");
  assert.deepEqual(executionCandidates(report([...LONDON, ...ASIA]), { now: NOW + 40 * DAY, cardIdsFor: cardsFor }), []);
  assert.deepEqual(executionCandidates(report([...LONDON, ...ASIA]), { now: NOW, cardIdsFor: () => [] }), [], "no card to cite");
  assert.deepEqual(executionCandidates({ ...report(LONDON), schema: "x" }, { now: NOW, cardIdsFor: cardsFor }), []);
});

test("E4. ingest, the overview and the daily curation: the report is kept, summarised, and its caution proposed with the cards Aether holds", async () => {
  resetExecutionSchemaCacheForTests(); resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests();
  const db = d1();
  assert.deepEqual(await storeExecutionReport(db, { ...report(LONDON), trades: [{ bad: true }] }, { now: NOW }), { accepted: false, reason: "trade_invalid:0" });
  assert.deepEqual(await storeExecutionReport(db, report([...LONDON, ...ASIA]), { now: NOW }), { accepted: true, trades: 40 });
  const latest = await latestExecutionReport(db);
  assert.equal(latest.report.trades.length, 40);
  assert.deepEqual(executionSummary(latest).trades, 40);
  // The quarter-hour cards of those bars, as xauusd pushes them.
  const card = (ms) => ({ card_id: `d:15:${ms}:0`, version: "cryptophys.decision-card.v1", kind: "room_conclusion", chart: "15", bar_open: new Date(ms).toISOString(), bar_close: new Date(ms + M).toISOString(), session: new Date(ms).getUTCHours() < 7 ? "asia" : "london", agents: [{ id: "moderator", stance: "SELL" }], compliance: [], outcomes: {}, stuck_open: [], canon_sha: "x" });
  const ingested = await ingestCards(db, Array.from({ length: 20 }, (_, i) => card(london(i))), { now: NOW });
  assert.equal(ingested.accepted, 20, JSON.stringify(ingested.rejected?.[0]));
  const proposals = [];
  const AGENTS = { async syscall(agentId, capability, input) {
    if (capability === "knowledge.propose") { const p = { proposal_id: `knw_${String(proposals.length).padStart(8, "0")}-0000-4000-8000-000000000000`, status: "pending", content_sha256: "a".repeat(64) }; proposals.push({ agentId, item: input.item }); return { outcome: "succeeded", result: { proposal: p } }; }
    return { outcome: "succeeded", result: { proposals: [] } };
  } };
  const run = await runCuration({ AETHER_DB: db, AGENTS }, { now: NOW });
  assert.equal(run.status, "ok");
  const exec = proposals.filter((p) => p.item.item_id.startsWith("k-exec-"));
  assert.deepEqual(exec.map((p) => [p.agentId, p.item.item_id]).sort(), [["aether-curator", "k-exec-plan-scalp-london"], ["aether-curator", "k-exec-session-scalp-london"]]);
  const overview = await aetherOverview({ AETHER_DB: db }, { now: NOW });
  assert.equal(overview.execution.trades, 40);
  assert.equal(overview.execution.modes.scalp.signals, 40);
});
