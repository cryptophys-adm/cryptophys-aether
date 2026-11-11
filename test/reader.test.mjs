import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { aetherOverview, weightingSummary } from "../src/reader.mjs";
import { ingestCards, resetSchemaCacheForTests } from "../src/store.mjs";
import { resetKnowledgeSchemaCacheForTests } from "../src/knowledge.mjs";
import { resetWeightingSchemaCacheForTests } from "../src/weighting.mjs";
import { CANON } from "../src/canon.generated.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
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
const NOW = Date.parse("2026-11-09T12:00:00Z");
const card = (i, over = {}) => ({
  card_id: `d:60:${NOW - (i + 1) * 3_600_000}:0`, version: "cryptophys.decision-card.v1", kind: "room_conclusion", chart: "60",
  bar_open: new Date(NOW - (i + 1) * 3_600_000).toISOString(), bar_close: new Date(NOW - i * 3_600_000).toISOString(), session: "london",
  conclusion: { stance: "WAIT", bias: "BULLISH", confidence: 0.45, reconvened: false, summary: "Decision WAIT, bias bullish." },
  crowd: { weighted_bias: "BULLISH", disagreement: 0.4, disagreeing_families: [] },
  agents: [{ id: "prophet", stance: "WAIT", bias: "BULLISH", confidence: 0.3, claim: "No confirmation on this candle." }],
  h1: { decision: "WAIT", confidence: 0.3 }, confirmations: {}, stuck_open: [], compliance: [], outcomes: {},
  provenance: { scoring_version: "cryptophys.outcome-scoring.v3", kb_sha: "651a3f00", learned_pack_sha: null, parity: {} },
  ...over
});

test("the overview reads an empty database and carries the canon", async () => {
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests(); resetWeightingSchemaCacheForTests();
  const o = await aetherOverview({ AETHER_DB: d1(), AETHER_PHASE: "A6" }, { now: NOW });
  assert.equal(o.canon.version, CANON.version);
  assert.equal(o.canon.doctrine.length, CANON.doctrine.rules.length);
  assert.deepEqual(o.weighting, []);
  assert.equal(o.guardian.cards, 0);
  assert.deepEqual(o.knowledge.items, []);
  const none = await aetherOverview({}, { now: NOW });
  assert.equal(none.cards, null, "no database: still an answer");
});

test("the overview counts the last day's cards, the ingest and the guardian's compliance findings", async () => {
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests(); resetWeightingSchemaCacheForTests();
  const db = d1();
  const cards = [0, 1, 2, 3].map((i) => card(i, i === 0 ? { compliance: [{ agent: "prophet", check: "calibration_talk", detail: "parity" }] } : {}));
  const r = await ingestCards(db, cards, { now: NOW });
  assert.equal(r.accepted, 4);
  const o = await aetherOverview({ AETHER_DB: db }, { now: NOW });
  assert.equal(o.cards["60"].cards, 4);
  assert.equal(o.guardian.cards, 4);
  assert.deepEqual(o.guardian.findings[0], { agent: "prophet", check: "calibration_talk", breaks: 1, messages: 4, per_100: 25 });
  assert.equal(o.ingest.recent.length, 1);
  assert.doesNotMatch(JSON.stringify(o), /entry_price|stop_loss|take_profit/, "no price field");
});

test("a weighting report is summarised: better candidates first, the latest history first", () => {
  const s = weightingSummary("60", {
    mode: "auto", rooms: 320, regimes: { "high-trending": 40 },
    active: { id: "weighting@default", params: { prior: 10 }, activated_at: null, change: "none" },
    agents: [{ agent: "prophet", family: "trend", weight: 1.2, accuracy: 0.6, calibration: 0.1, decisive: 40, n: 60 }],
    candidates: [
      { id: "a", verdict: "not_better", discovery: { bars: 220, p_holm: 0.5 } },
      { id: "b", verdict: "better_than_active: ready", discovery: { bars: 220, p_holm: 0.03 }, holdout: { bars: 100, complete: true } },
      { id: "c", verdict: "running", discovery: { bars: 50, p_holm: null } }
    ],
    reverse: { previous_id: "weighting@x", since: "2026-11-01", rooms: 40, p_value: 0.4, previous_accuracy: 0.5, active_accuracy: 0.55 },
    history: [{ kind: "activated", at: "1" }, { kind: "rolled_back", at: "2" }]
  }, "2026-11-09T11:00:00Z");
  assert.deepEqual(s.candidates.map((c) => c.id), ["b", "c", "a"]);
  assert.equal(s.history[0].at, "2");
  assert.equal(s.reverse.rooms, 40);
  assert.equal(s.agents[0].weight, 1.2);
  assert.equal(weightingSummary("15", null).rooms, 0);
  const e = weightingSummary("engine", {
    mode: "auto", rooms: 380, active: { id: "ww:1", params: { D1: 0.16 }, source: "auto_tuned", activated_at: "2026-11-12T10:00:00Z", change: "News Daily up from 8% to 12%" },
    agents: [], control: { scored_rooms: 300, accuracy: 0.55, entries_taken: 40 }, replay_fidelity: { checks: 760, matched: 741, share: 0.975 },
    candidates: [{ id: "ww:2", changed: "NEWS", change: "News Daily up", params: { D1: 0.15 }, verdict: "collecting", same_rooms: 300, differing_decisions: 12, discovery: { bars: 200 } }]
  }, "2026-11-12T11:00:00Z");
  assert.equal(e.kind, "witness_weights");
  assert.equal(e.active.source, "auto_tuned");
  assert.equal(e.replay_fidelity.share, 0.975);
  assert.equal(e.control.accuracy, 0.55);
  assert.deepEqual([e.candidates[0].params, e.candidates[0].differing_decisions], [{ D1: 0.15 }, 12]);
  assert.equal(s.kind, undefined, "a room report keeps its shape");
});

test("the sync checks: fresh feeds are ok; a stale feed warns while the market was open and idles over the weekend", async () => {
  const { syncChecks, marketOpen } = await import("../src/reader.mjs");
  const MON = Date.parse("2026-11-09T12:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const base = { now: MON, lastIngestAt: iso(MON - 30 * 60_000), canonIndexedSha: "a".repeat(64), canonSha: "a".repeat(64), canonIndexedAt: iso(MON - 5 * 3_600_000), oldestPendingAt: iso(MON - 20 * 60_000), pending: 3, weighting: [{ timeframe: "15", received_at: iso(MON - 3_600_000) }, { timeframe: "1D", received_at: iso(MON - 20 * 3_600_000) }], aiUsed: 13, aiLimit: 60, kbSha: "k" };
  const ok = syncChecks(base);
  assert.equal(ok.overall, "ok");
  assert.deepEqual(Object.keys(ok.checks), ["ingest", "canon_index", "embed_backlog", "weighting_15", "weighting_1D", "ai_budget"]);
  assert.equal(ok.kb_content_sha256, "k");
  const stale = syncChecks({ ...base, lastIngestAt: iso(MON - 3 * 3_600_000) });
  assert.equal(stale.overall, "warn");
  assert.equal(stale.checks.ingest.status, "warn");
  assert.equal(syncChecks({ ...base, lastIngestAt: null }).checks.ingest.status, "warn", "never ingested while open");
  const SUN = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(marketOpen(SUN), false);
  assert.equal(marketOpen(Date.parse("2026-11-08T22:30:00Z")), true, "Sunday reopen");
  assert.equal(marketOpen(Date.parse("2026-11-07T08:00:00Z")), false, "Saturday");
  assert.equal(syncChecks({ ...base, now: SUN, lastIngestAt: iso(SUN - 30 * 3_600_000) }).checks.ingest.status, "idle", "the weekend is no outage");
  assert.equal(syncChecks({ ...base, canonIndexedSha: "b".repeat(64), canonIndexedAt: iso(MON - 30 * 60_000) }).checks.canon_index.status, "ok", "a new canon waits for the hourly run");
  assert.equal(syncChecks({ ...base, canonIndexedSha: "b".repeat(64), canonIndexedAt: iso(MON - 5 * 3_600_000) }).checks.canon_index.status, "warn");
  assert.equal(syncChecks({ ...base, oldestPendingAt: iso(MON - 3 * 3_600_000) }).checks.embed_backlog.status, "warn");
  assert.equal(syncChecks({ ...base, pending: 0, oldestPendingAt: null }).checks.embed_backlog.status, "ok");
  assert.equal(syncChecks({ ...base, weighting: [{ timeframe: "60", received_at: iso(MON - 4 * 3_600_000) }] }).checks.weighting_60.status, "warn");
  assert.equal(syncChecks({ ...base, aiUsed: 60 }).checks.ai_budget.status, "warn");
});

test("aetherSync reads D1 and never throws; the overview carries it", async () => {
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests(); resetWeightingSchemaCacheForTests();
  const { aetherSync } = await import("../src/reader.mjs");
  const db = d1();
  await ingestCards(db, [card(0)], { now: NOW });
  const s = await aetherSync({ AETHER_DB: db }, { now: NOW + 600_000 });
  assert.equal(s.checks.ingest.status, "ok");
  assert.equal(s.checks.canon_index.status, "warn", "never indexed");
  assert.equal(s.kb_content_sha256, CANON.indicator.kb_content_sha256);
  assert.equal((await aetherSync({}, { now: NOW })).checks.ingest.status, "warn", "no database: the check says so");
  assert.ok((await aetherOverview({ AETHER_DB: db }, { now: NOW })).sync.checks);
});

test("the overview carries the existing knowledge and the learning progress", async () => {
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests(); resetWeightingSchemaCacheForTests();
  const db = d1();
  await ingestCards(db, [0, 1, 2].map((i) => card(i)), { now: NOW });
  const o = await aetherOverview({ AETHER_DB: db }, { now: NOW });
  assert.deepEqual(o.canon.file_list.map((f) => f.path), CANON.files.map((f) => f.path));
  assert.equal(o.canon.roles.length, CANON.roles.agents.length);
  assert.equal(o.canon.kb.version, CANON.indicator.kb.version);
  assert.ok(o.canon.kb.input_lanes.includes("tradingview_webhook"));
  assert.equal(o.progress.curation.cards, 3);
  assert.equal(o.progress.curation.role_drift.agents[0].rooms, 3);
  assert.deepEqual(o.progress.weighting, []);
  assert.equal((await aetherOverview({}, { now: NOW })).progress.curation, null, "no database: no progress, still an answer");
});

test("weighting progress: the most-paired candidate's discovery and holdout against their minimums", async () => {
  const { weightingProgress, WEIGHTING_DISCOVERY_MIN } = await import("../src/reader.mjs");
  const p = weightingProgress("60", {
    mode: "auto", rooms: 59, window_days: 30, active: { id: "weighting@default" },
    candidates: [
      { id: "a", verdict: "collecting", discovery: { bars: 0 }, holdout: { bars: 40, required_bars: 100, complete: false } },
      { id: "b", verdict: "collecting", discovery: { bars: 0 }, holdout: { bars: 59, required_bars: 100, complete: false } }
    ]
  }, "2026-11-09T11:00:00Z");
  assert.deepEqual(p.discovery, { have: 0, need: WEIGHTING_DISCOVERY_MIN });
  assert.deepEqual(p.holdout, { have: 59, need: 100, complete: false });
  assert.deepEqual(p.verdicts, { collecting: 2 });
  assert.equal(p.rooms, 59);
  assert.equal(weightingProgress("15", null).discovery, null);
});
