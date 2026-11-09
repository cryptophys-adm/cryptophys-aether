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
});
