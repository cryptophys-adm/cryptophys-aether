import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { validateCard, cardLeaks } from "../src/card-guard.mjs";
import { ingestCards, cardCounts, resetSchemaCacheForTests, MAX_CARDS_PER_CALL } from "../src/store.mjs";
import { CANON } from "../src/canon.generated.mjs";

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

const card = (over = {}) => ({
  card_id: "d:60:1793998800000:0", version: "cryptophys.decision-card.v1", kind: "room_conclusion", chart: "60",
  bar_open: "2026-11-06T21:00:00.000Z", bar_close: "2026-11-06T22:00:00.000Z", session: "late",
  conclusion: { stance: "WAIT", bias: "BULLISH", confidence: 0.45, reconvened: false, summary: "Decision WAIT, bias bullish: twice rejected at [level]." },
  crowd: { weighted_bias: "BULLISH", disagreement: 0.91, disagreeing_families: ["macro"] },
  agents: [{ id: "prophet", stance: "WAIT", bias: "BULLISH", confidence: 0.3, claim: "No confirmation on this candle." }],
  h1: { decision: "WAIT", confidence: 0.3 }, confirmations: { "chart_prophet_r38.buy_confirmed": false },
  stuck_open: [], compliance: [], outcomes: {},
  provenance: { scoring_version: "cryptophys.outcome-scoring.v3", kb_sha: "651a3f00", learned_pack_sha: null, parity: { prophet: "approved" } },
  ...over
});

test("the guard accepts a clean card and refuses levels, prices, plans and malformed cards", () => {
  assert.deepEqual(validateCard(card()), []);
  assert.ok(validateCard(card({ h1: { decision: "SELL", entry_price: 4051.2 } })).some((e) => e.includes("entry_price")));
  assert.ok(validateCard(card({ agents: [{ id: "prophet", claim: "Sell below 4051 with a stop at $4,060." }] })).some((e) => e.startsWith("leak:")));
  assert.ok(validateCard(card({ trade_plan: {} })).length);
  assert.deepEqual(validateCard(card({ version: "x" })), ["unsupported_version"]);
  assert.ok(validateCard(card({ chart: "5" })).includes("chart_invalid"));
  assert.ok(validateCard(card({ card_id: "../etc" })).includes("card_id_invalid"));
  assert.deepEqual(validateCard(null), ["not_an_object"]);
  assert.deepEqual(cardLeaks(card()), [], "dates, ids and the KB hash are not prices");
});

test("ingestCards stores accepted cards once, updates them in place and reports refusals", async () => {
  resetSchemaCacheForTests();
  const db = d1();
  const r = await ingestCards(db, [card(), card({ card_id: "d:60:1793995200000:0", agents: [{ id: "x", claim: "Buy at 4050." }] })], { now: Date.parse("2026-11-07T12:00:00Z") });
  assert.equal(r.accepted, 1);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].card_id, "d:60:1793995200000:0");
  assert.equal(r.canon.content_sha256, CANON.content_sha256);
  const again = await ingestCards(db, [card({ outcomes: { "agent:prophet": { result: "hit", direction: 1 } } })]);
  assert.equal(again.accepted, 1);
  const row = db.raw.prepare("SELECT COUNT(*) AS n, card_json FROM decision_cards").get();
  assert.equal(row.n, 1, "one row per card");
  assert.equal(JSON.parse(row.card_json).outcomes["agent:prophet"].result, "hit", "outcomes arrive later and update the card");
  assert.deepEqual(await cardCounts(db), { "60": { cards: 1, latest_bar: "2026-11-06T21:00:00.000Z" } });
  const many = await ingestCards(db, Array.from({ length: MAX_CARDS_PER_CALL + 3 }, (_, i) => card({ card_id: `d:15:${1793998800000 + i}:0`, chart: "15" })));
  assert.equal(many.accepted, MAX_CARDS_PER_CALL);
  assert.equal(many.truncated, 3);
  assert.equal((await ingestCards(db, "nope")).accepted, 0);
});
