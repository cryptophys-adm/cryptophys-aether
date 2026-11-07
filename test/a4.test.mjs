import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { canonChunks } from "../src/canon-chunks.mjs";
import { takeBudget, budgetUsed } from "../src/budget.mjs";
import { embedTexts, EMBED_DIMENSIONS, EMBED_BATCH } from "../src/embed.mjs";
import { syncCanon, embedPendingCards, indexStatus, cardText, resetIndexSchemaCacheForTests } from "../src/indexes.mjs";
import { complianceFindings, missesOf, runDigest, COMPLIANCE_WARN_PER_100 } from "../src/guardian.mjs";
import { ingestCards, resetSchemaCacheForTests } from "../src/store.mjs";
import { INDEXES } from "../scripts/ensure-vectorize.mjs";
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
function fakeAi() {
  const calls = [];
  return { calls, async run(model, { text }) { calls.push({ model, n: text.length }); return { data: text.map((t, i) => Array.from({ length: EMBED_DIMENSIONS }, (_, k) => ((t.length + i + k) % 7) / 7)) }; } };
}
function fakeIndex() {
  const store = new Map(), deleted = [];
  return {
    store, deleted,
    async upsert(vs) { for (const v of vs) { assert.equal(v.values.length, EMBED_DIMENSIONS); assert.ok(Buffer.byteLength(v.id) <= 64); store.set(v.id, v); } return { count: vs.length }; },
    async deleteByIds(ids) { for (const id of ids) { store.delete(id); deleted.push(id); } },
    async queryById(id, { topK, namespace, filter }) { return { matches: [...store.values()].filter((v) => v.namespace === namespace && v.metadata.chart === filter.chart).slice(0, topK).map((v) => ({ id: v.id, score: 0.9 })) }; }
  };
}
function env(over = {}) {
  resetSchemaCacheForTests(); resetIndexSchemaCacheForTests();
  return { AETHER_DB: d1(), AI: fakeAi(), CANON_INDEX: fakeIndex(), MARKET_INDEX: fakeIndex(), AI_DAILY_LIMIT: "60", ...over };
}
const NOW = Date.parse("2026-11-08T01:52:00Z");
const card = (i, over = {}) => ({
  card_id: `d:60:${1794000000000 + i * 3600000}:0`, version: "cryptophys.decision-card.v1", kind: "room_conclusion", chart: "60",
  bar_open: new Date(NOW - (20 - i) * 3600000).toISOString(), session: "london",
  conclusion: { stance: "WAIT", bias: "BEARISH", confidence: 0.5, summary: "Decision WAIT, bias bearish." },
  agents: [{ id: "prophet", stance: "WAIT", bias: "BEARISH", confidence: 0.5, claim: "No confirmation." }, { id: "risk", stance: "WAIT", bias: "NEUTRAL", confidence: 0.4, claim: "Volatility is high." }],
  compliance: [], outcomes: {}, provenance: { scoring_version: "v3" }, ...over
});

test("canon chunks: every part is covered, ids are stable and at most 64 bytes, texts are bounded", () => {
  const a = canonChunks(), b = canonChunks();
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id));
  const parts = new Set(a.map((c) => c.metadata.part));
  for (const p of ["doctrine", "role", "definition", "indicator", "policy"]) assert.ok(parts.has(p), p);
  assert.equal(a.filter((c) => c.metadata.part === "doctrine").length, CANON.doctrine.rules.length);
  assert.ok(a.every((c) => Buffer.byteLength(c.id) <= 64 && c.text.length > 10 && c.text.length <= 1500 && c.metadata.canon === CANON.content_sha256.slice(0, 8)));
});

test("the AI budget is shared in D1 and refuses past the daily limit; embeddings are batched", async () => {
  const e = env({ AI_DAILY_LIMIT: "2" });
  assert.equal(await takeBudget(e, 1, { now: NOW }), true);
  assert.equal(await takeBudget(e, 1, { now: NOW }), true);
  assert.equal(await takeBudget(e, 1, { now: NOW }), false);
  assert.equal(await budgetUsed(e, { now: NOW }), 2);
  assert.equal(await takeBudget(e, 1, { now: NOW + 86_400_000 }), true, "a new day starts a new budget");
  const e2 = env();
  const v = await embedTexts(e2, Array.from({ length: EMBED_BATCH + 1 }, (_, i) => "t" + i), { now: NOW });
  assert.equal(v.length, EMBED_BATCH + 1);
  assert.deepEqual(e2.AI.calls.map((c) => c.n), [EMBED_BATCH, 1], "one request per batch");
  assert.equal(await embedTexts({ ...e2, AI: { run: async () => ({ data: [[1, 2]] }) } }, ["x"], { now: NOW }), null, "a wrong shape is refused");
});

test("syncCanon embeds the canon once per version and is a no-op after; missing bindings are reported", async () => {
  const e = env();
  const first = await syncCanon(e, { now: NOW });
  assert.equal(first.status, "indexed");
  assert.equal(e.CANON_INDEX.store.size, canonChunks().length);
  assert.equal((await syncCanon(e, { now: NOW })).status, "current");
  assert.equal(e.AI.calls.length, Math.ceil(canonChunks().length / EMBED_BATCH), "no second embedding");
  assert.equal((await indexStatus(e)).canon.indexed, true);
  assert.equal((await syncCanon({ AETHER_DB: e.AETHER_DB }, { now: NOW })).status, "unavailable");
  const poor = env({ AI_DAILY_LIMIT: "1" });
  assert.equal((await syncCanon(poor, { now: NOW })).status, "budget_or_model_refused", "a canon larger than the budget waits for the next day");
});

test("cards are embedded into aether-market once, and again after an update; the text has no levels", async () => {
  const e = env();
  await ingestCards(e.AETHER_DB, [card(1), card(2)], { now: NOW });
  const r = await embedPendingCards(e, { now: NOW });
  assert.equal(r.cards, 2);
  const v = e.MARKET_INDEX.store.get(card(1).card_id);
  assert.equal(v.namespace, "decision");
  assert.deepEqual([v.metadata.kind, v.metadata.chart, v.metadata.session, v.metadata.stance], ["decision", "60", "london", "WAIT"]);
  assert.equal((await embedPendingCards(e, { now: NOW })).status, "nothing_pending");
  await ingestCards(e.AETHER_DB, [card(1, { outcomes: { "agent:prophet": { result: "miss" } } })], { now: NOW + 60_000 });
  assert.equal((await embedPendingCards(e, { now: NOW + 120_000 })).cards, 1, "an updated card is embedded again");
  assert.doesNotMatch(cardText(card(1)), /\b\d{4}\.\d+\b/);
});

test("guardian and auditor: deterministic findings, advisory reports, warning only over the threshold, never critical", async () => {
  const breaks = Array.from({ length: 5 }, (_, i) => card(i, { compliance: [{ agent: "risk", check: "calibration_talk", detail: "parity" }] }));
  const f = complianceFindings(breaks);
  assert.deepEqual([f[0].agent, f[0].check, f[0].breaks, f[0].messages, f[0].per_100], ["risk", "calibration_talk", 5, 5, 100]);
  assert.ok(f[0].per_100 >= COMPLIANCE_WARN_PER_100);
  assert.deepEqual(missesOf(card(0, { outcomes: { "agent:prophet": { result: "miss" }, "agent:risk": { result: "hit" } } })), ["prophet"]);

  const reports = [];
  const e = env({ AGENTS: { syscall: async (agent, cap, input) => { reports.push({ agent, cap, input }); return { outcome: "succeeded" }; } } });
  const missed = Array.from({ length: 6 }, (_, i) => card(i, { outcomes: { "agent:prophet": { result: "miss" } }, compliance: [{ agent: "risk", check: "calibration_talk", detail: "parity" }] }));
  await ingestCards(e.AETHER_DB, missed, { now: NOW });
  await embedPendingCards(e, { now: NOW });
  const d = await runDigest(e, { now: NOW });
  assert.equal(d.status, "ok");
  assert.equal(d.cards, 6);
  assert.ok(d.repeated_failures >= 1, "prophet missed in the most similar situations too");
  assert.deepEqual(reports.map((r) => [r.agent, r.cap, r.input.kind]), [["aether-guardian", "reports.publish", "knowledge_audit"], ["aether-auditor", "reports.publish", "knowledge_audit"]]);
  assert.equal(reports[0].input.severity, "warning");
  assert.ok(reports.every((r) => r.input.severity !== "critical" && r.input.body.advisory === "advisory only; not an order"));
  assert.doesNotMatch(JSON.stringify(reports), /entry_price|stop_loss|take_profit|\b\d{4}\.\d+\b/);

  const quiet = await runDigest(env({ AGENTS: { syscall: async () => { throw new Error("kernel down"); } } }), { now: NOW });
  assert.equal(quiet.guardian, "failed", "a kernel failure never throws");
});

test("ensure-vectorize declares both indexes at 384 dimensions, cosine, with the metadata indexes the code filters on", () => {
  const byName = Object.fromEntries(INDEXES.map((i) => [i.name, i]));
  assert.deepEqual(Object.keys(byName), ["aether-canon", "aether-market"]);
  for (const i of INDEXES) assert.deepEqual([i.dimensions, i.metric], [384, "cosine"]);
  const market = Object.fromEntries(byName["aether-market"].metadata);
  for (const k of ["kind", "chart", "session", "stance"]) assert.equal(market[k], "string");
  assert.equal(market.day, "number");
});
