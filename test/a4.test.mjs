import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { canonChunks } from "../src/canon-chunks.mjs";
import { recordUsage, usageToday } from "../src/usage.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { embedTexts, EMBED_DIMENSIONS, EMBED_BATCH } from "../src/embed.mjs";
import { syncCanon, embedPendingCards, indexStatus, cardText, resetIndexSchemaCacheForTests, EMBED_RUN_WALL_MS } from "../src/indexes.mjs";
import { complianceFindings, missesOf, runDigest, COMPLIANCE_WARN_PER_100 } from "../src/guardian.mjs";
import { ingestCards, resetSchemaCacheForTests } from "../src/store.mjs";
import { INDEXES, parseWranglerJson } from "../scripts/ensure-vectorize.mjs";
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
  return { AETHER_DB: d1(), AI: fakeAi(), CANON_INDEX: fakeIndex(), MARKET_INDEX: fakeIndex(), ...over };
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

test("AI usage is metered in D1 per day and never refuses; embeddings are batched", async () => {
  const e = env();
  assert.equal(await recordUsage(e, 1, { now: NOW }), 1);
  assert.equal(await recordUsage(e, 2, { now: NOW }), 3);
  assert.equal(await usageToday(e, { now: NOW }), 3);
  assert.equal(await usageToday(e, { now: NOW + 86_400_000 }), 0, "a new day starts a new count");
  const e2 = env();
  const v = await embedTexts(e2, Array.from({ length: EMBED_BATCH + 1 }, (_, i) => "t" + i), { now: NOW });
  assert.equal(v.length, EMBED_BATCH + 1);
  assert.deepEqual(e2.AI.calls.map((c) => c.n), [EMBED_BATCH, 1], "one request per batch");
  assert.equal(await usageToday(e2, { now: NOW }), 2, "each request is recorded");
  assert.equal(await embedTexts({ ...e2, AI: { run: async () => ({ data: [[1, 2]] }) } }, ["x"], { now: NOW }), null, "a wrong shape is refused");
  assert.equal(await usageToday(e2, { now: NOW }), 3, "a refused answer is still metered");
});

test("owner 2026-11-14: learning past the old 60 requests a day is processed, and still metered", async () => {
  const e = env();
  const texts = Array.from({ length: 70 * EMBED_BATCH }, (_, i) => "text " + i);
  const v = await embedTexts(e, texts, { now: NOW });
  assert.equal(v.length, texts.length, "70 requests in one day: every text embedded");
  assert.equal(e.AI.calls.length, 70);
  assert.equal(await usageToday(e, { now: NOW }), 70, "ai_usage holds every request");
  // A canon re-index on top of that day: indexed, not deferred to the next day.
  const r = await syncCanon(e, { now: NOW });
  assert.equal(r.status, "indexed");
  assert.equal(await usageToday(e, { now: NOW }), 70 + Math.ceil(canonChunks().length / EMBED_BATCH));
  // Old limit variable set by mistake: ignored.
  const legacy = env({ AI_DAILY_LIMIT: "1" });
  assert.equal((await syncCanon(legacy, { now: NOW })).status, "indexed", "no budget variable can stop the canon index");
});

test("embedPendingCards embeds every pending card (well beyond 60 requests and 50 cards a run), one request per 50", async () => {
  const e = env();
  const N = 61 * EMBED_BATCH + 7; // 3057 cards: 62 requests, more than the old 60 a day and the old 50 cards a run
  for (let i = 0; i < N; i += 500) {
    await ingestCards(e.AETHER_DB, Array.from({ length: Math.min(500, N - i) }, (_, j) => card(0, { card_id: `d:15:${1794000000000 + (i + j) * 900000}:0`, chart: "15", bar_open: new Date(NOW - (N - i - j) * 900000).toISOString() })), { now: NOW - 60_000 });
  }
  const r = await embedPendingCards(e, { now: NOW });
  assert.deepEqual([r.status, r.cards, r.batches, r.carried], ["embedded", N, 62, 0]);
  assert.equal(e.MARKET_INDEX.store.size, N);
  assert.equal(e.AI.calls.length, 62);
  assert.ok(e.AI.calls.every((c) => c.n <= EMBED_BATCH));
  assert.equal(await usageToday(e, { now: NOW }), 62, "every request is recorded in ai_usage");
  assert.equal((await indexStatus(e)).market.pending_cards, 0);
  assert.equal((await embedPendingCards(e, { now: NOW })).status, "nothing_pending");
});

test("embedPendingCards carries what a run's wall time does not reach to the next run, never drops it", async () => {
  const e = env();
  await ingestCards(e.AETHER_DB, Array.from({ length: 120 }, (_, i) => card(0, { card_id: `d:15:${1794000000000 + i * 900000}:0`, chart: "15", bar_open: new Date(NOW - (120 - i) * 900000).toISOString() })), { now: NOW - 60_000 });
  let t = 0;
  const clock = () => (t += EMBED_RUN_WALL_MS); // the run's wall time is spent after the first page
  const first = await embedPendingCards(e, { now: NOW, clock });
  assert.deepEqual([first.status, first.cards, first.carried], ["embedded", 50, 70], "the rest is reported as carried");
  const second = await embedPendingCards(e, { now: NOW + 3_600_000 });
  assert.deepEqual([second.cards, second.carried], [70, 0], "the next run embeds the rest");
  assert.equal(e.MARKET_INDEX.store.size, 120);
});

test("no learning path refuses or skips for a budget or rate reason of Aether's own", () => {
  const files = readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".mjs") && f !== "canon.generated.mjs");
  for (const f of files) {
    const text = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
    for (const banned of [/AI_DAILY_LIMIT/, /takeBudget/, /budget_or_model_refused/, /DEFAULT_DAILY_LIMIT/, /MAX_PROPOSALS_PER_RUN/, /MAX_CARDS_PER_CALL/, /LIMIT \?"\)\.bind\(limit\)/]) {
      assert.doesNotMatch(text, banned, `src/${f}: ${banned}`);
    }
  }
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /"AI_DAILY_LIMIT"/, "no AI budget variable in wrangler.jsonc");
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
  const bad = env({ AI: { run: async () => ({ data: [] }) } });
  assert.equal((await syncCanon(bad, { now: NOW })).status, "model_refused", "a wrong model answer indexes nothing");
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

test("ensure-vectorize reads wrangler 4.45 --json output: a progress line first, and no JSON for an empty list", () => {
  assert.deepEqual(parseWranglerJson("📋 Listing Vectorize indexes...\n"), [], "an account with no index yet");
  assert.deepEqual(parseWranglerJson(""), []);
  const listed = parseWranglerJson('📋 Listing Vectorize indexes...\n[\n  {\n    "name": "aether-canon",\n    "config": { "dimensions": 384, "metric": "cosine" }\n  }\n]\n');
  assert.equal(listed[0].config.dimensions, 384);
  const meta = parseWranglerJson('📋 Fetching metadata indexes...\n[\n  { "propertyName": "part", "indexType": "String" }\n]\n');
  assert.equal(meta[0].propertyName, "part");
  assert.throws(() => parseWranglerJson("📋 Listing...\n[ not json"), "a broken JSON still fails closed");
});

test("the post-deploy health check wants ok, the commit's phase and canon, and readable indexes", async () => {
  const { healthProblems, configuredPhase } = await import("../scripts/check-health.mjs");
  assert.equal(configuredPhase(), "A6", "read from wrangler.jsonc");
  const want = { canonSha: "abc", phase: "A4" };
  const good = { service: "cryptophys-aether", status: "ok", phase: "A4", canon: { content_sha256: "abc" }, indexes: { canon: {} } };
  assert.deepEqual(healthProblems(good, want), []);
  assert.equal(healthProblems({ ...good, phase: "A2" }, want).length, 1, "the previous version still serving, same canon");
  assert.equal(healthProblems({ ...good, canon: { content_sha256: "old" } }, want).length, 1);
  assert.equal(healthProblems({ ...good, indexes: { error: "unavailable" } }, want).length, 1);
  assert.ok(healthProblems(null, want).length >= 4);
});

test("the deployment check: this commit's version at 100 %, workers.dev off", async () => {
  const { deploymentProblems } = await import("../scripts/check-deployment.mjs");
  const deployment = { created_on: "2026-11-09T12:00:00Z", versions: [{ version_id: "v1", percentage: 100 }] };
  const ok = { deployment, version: { annotations: { "workers/tag": "abc123def456" } }, subdomain: { enabled: false }, tag: "abc123def456", startedMs: Date.parse("2026-11-09T11:59:00Z") };
  assert.deepEqual(deploymentProblems(ok), []);
  assert.match(deploymentProblems({ ...ok, version: { annotations: { "workers/tag": "old" } } }).join(), /tag old/);
  assert.match(deploymentProblems({ ...ok, subdomain: { enabled: true } }).join(), /workers.dev is on/);
  assert.match(deploymentProblems({ ...ok, deployment: { ...deployment, versions: [{ version_id: "v1", percentage: 50 }, { version_id: "v0", percentage: 50 }] } }).join(), /traffic split/);
  assert.deepEqual(deploymentProblems({ ...ok, version: {} }), [], "no tag in the API: a deployment created in this run passes");
  assert.deepEqual(deploymentProblems({ ...ok, tag: undefined, version: { annotations: { "workers/tag": "anything" } } }), [], "no tag set (Wrangler 4.45 deploy): the creation time decides");
  assert.match(deploymentProblems({ ...ok, tag: undefined, startedMs: Date.parse("2026-11-09T13:00:00Z") }).join(), /not from this run/);
  assert.match(deploymentProblems({ ...ok, version: {}, startedMs: Date.parse("2026-11-09T13:00:00Z") }).join(), /not from this run/);
  assert.match(deploymentProblems({ ...ok, deployment: null }).join(), /no active deployment/);
});
