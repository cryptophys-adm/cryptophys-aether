import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ingestCards, resetSchemaCacheForTests } from "../src/store.mjs";
import {
  binomialTail, roleDriftCandidates, cautionCandidates, stuckEpisodes, paramCandidates, runCuration, syncReviews, learnedPack, knowledgeCounts,
  resetKnowledgeSchemaCacheForTests, TUNING_GRID, ITEM_SCHEMA, MAX_PROPOSALS_PER_RUN
} from "../src/knowledge.mjs";
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

const NOW = Date.parse("2026-12-10T12:00:00Z");
const H = 3_600_000;
const sessionOf = (ms) => { const h = new Date(ms).getUTCHours(); return h < 7 ? "asia" : h < 13 ? "london" : h < 21 ? "new_york" : "late"; };
const card = (chart, ms, extra = {}) => ({
  card_id: `d:${chart}:${ms}:0`, version: "cryptophys.decision-card.v1", kind: "room_conclusion", chart, bar_open: new Date(ms).toISOString(), session: sessionOf(ms),
  agents: [{ id: "r37_funnel", stance: "WAIT" }, { id: "prophet", stance: "SELL" }, { id: "moderator", stance: "WAIT" }],
  compliance: [], outcomes: {}, stuck_open: [], ...extra
});
/** Hourly cards for `days` days, ending one hour before NOW. */
const hourly = (days, fn = () => ({})) => Array.from({ length: days * 24 }, (_, i) => { const ms = NOW - (days * 24 - i) * H; return card("60", ms, fn(i, ms)); });

// The platform kernel's knowledge.propose / knowledge.status, as far as Aether sees them.
function kernel({ deny = false, refuse = [] } = {}) {
  const proposals = [];
  return {
    proposals,
    async syscall(agentId, capability, input) {
      if (capability === "knowledge.propose") {
        if (deny) return { outcome: "denied", capability, reason: "failed: rate_limit" };
        if (refuse.includes(input.item.item_id)) return { outcome: "failed", capability, reason: "invalid_knowledge_item: text_price_like_number" };
        const p = { proposal_id: `knw_${String(proposals.length).padStart(8, "0")}-0000-4000-8000-000000000000`, agent: agentId, item_id: input.item.item_id, item_version: input.item.version, status: "pending", content_sha256: "a".repeat(64) };
        proposals.push(p);
        return { outcome: "succeeded", capability, result: { proposal: p } };
      }
      if (capability === "knowledge.status") return { outcome: "succeeded", capability, result: { proposals: proposals.filter((p) => p.agent === agentId) } };
      return { outcome: "denied", capability, reason: "not granted" };
    }
  };
}

test("binomial tail: exact one-sided probabilities", () => {
  assert.equal(binomialTail(0, 10, 0.3), 1);
  assert.ok(Math.abs(binomialTail(10, 10, 0.5) - 1 / 1024) < 1e-12);
  assert.ok(Math.abs(binomialTail(9, 14, 0.3) - 0.0082) < 0.0005);
});

test("curator, role drift: an agent that breaks one check in more than 5% of 20+ rooms over 7 days, cited by 10+ cards", () => {
  const cards = hourly(7, (i) => (i % 8 === 0 ? { compliance: [{ agent: "r37_funnel", check: "calibration_talk", detail: "parity" }, { agent: "r37_funnel", check: "calibration_talk", detail: "verified by" }] } : {}));
  const [item, ...rest] = roleDriftCandidates(cards, { now: NOW });
  assert.equal(rest.length, 0);
  assert.equal(item.schema, ITEM_SCHEMA);
  assert.equal(item.kind, "role_reminder");
  assert.equal(item.item_id, "k-role-r37-funnel-calibration-talk");
  assert.deepEqual(item.audience.agents, ["r37_funnel", "moderator"]);
  assert.equal(item.evidence.rooms, 168);
  assert.equal(item.evidence.rooms_with_break, 21, "a room counts once however many breaks it holds");
  assert.match(item.text, /^In the last 7 days the r37 funnel agent spoke of calibration, parity or verification in 13% of the rooms it spoke in\./);
  assert.doesNotMatch(item.text, /\b\d{3,}\b/, "no 3-digit count in the text: the kernel's price guard would refuse it");
  assert.ok(item.text.length <= 300);
  assert.equal(item.provenance.canon_sha, CANON.content_sha256);
  assert.ok(item.provenance.card_ids.length >= 10);
  assert.equal(roleDriftCandidates(hourly(3, () => ({ compliance: [{ agent: "prophet", check: "calibration_talk" }] })), { now: NOW }).length, 0, "less than 6 days of cards is not 7 days of drift");
});

test("curator, agent pattern: wrong far more often in one situation than in the agent's other situations (p < 0.05, 12+ decisive)", () => {
  const cards = hourly(30, (i, ms) => {
    const s = sessionOf(ms);
    const result = s === "london" ? (i % 3 === 0 ? "hit" : "miss") : (i % 10 === 0 ? "miss" : "hit");
    return { outcomes: { "agent:prophet": { result, direction: -1 }, "agent:r37_funnel": { result: "missed_opportunity" } } };
  });
  const items = cautionCandidates(cards, { now: NOW });
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.kind, "caution");
  assert.equal(item.claim_type, "measured_outcome");
  assert.deepEqual(item.situation, { chart: "60", session: "london" });
  assert.ok(item.evidence.p_value < 0.05);
  assert.match(item.text, /^On the hourly chart in the London session, the prophet agent was wrong in \d+% of its decisive calls over 30 days, against \d+% in its other situations\.$/);
  for (const n of item.text.match(/\d+/g)) assert.ok(JSON.stringify(item.evidence).includes(n), `number ${n} comes from the evidence`);
  assert.equal(cautionCandidates(hourly(30, () => ({ outcomes: { "agent:prophet": { result: "hit" } } })), { now: NOW }).length, 0, "no pattern, no candidate");
});

test("calibrator, engine pattern: 3+ stuck episodes in 30 days -> the next untested grid point of that family only", () => {
  const cards = hourly(30, (i) => ((i % 100) < 12 ? { stuck_open: [{ field: "gmi_v12_70.verdict", candles: (i % 100) + 8 }] } : {}));
  const e = stuckEpisodes(cards, { now: NOW });
  assert.equal(e.gmi_v12_70.episodes, 8);
  assert.equal(e.gmi_v12_70.longest_candles, 19);
  assert.equal(e.prophet_r37.episodes, 0);
  const [item, ...rest] = paramCandidates(cards, { now: NOW });
  assert.equal(rest.length, 0);
  assert.equal(item.kind, "param_candidate");
  assert.deepEqual(item.params.values, { stateMaxAge: 16 }, "8 and 12 were tested in xauusd");
  assert.equal(item.params.grid, "TUNING_GRID.gmi_v12_70.stateMaxAge");
  assert.match(item.text, /^The GMI structure stayed stuck in 8 separate episodes over 30 days, the longest for 19 hourly candles\. Test in shadow a latch that expires after 16 hourly candles instead of 50\.$/);
  assert.deepEqual(paramCandidates(cards, { now: NOW, proposed: new Set(["gmi_v12_70:16"]) })[0].params.values, { stateMaxAge: 24 });
  assert.equal(paramCandidates(cards, { now: NOW, proposed: new Set(["gmi_v12_70:16", "gmi_v12_70:24"]) }).length, 0, "the grid is finite");
  assert.equal(paramCandidates(cards, { now: NOW, pendingFamilies: new Set(["gmi_v12_70"]) }).length, 0, "one open proposal per family");
  assert.deepEqual(TUNING_GRID.prophet_r37.tested, [8, 12]);
});

test("runCuration proposes through the kernel, never twice, records refusals, and stops on a denial", async () => {
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests();
  const db = d1();
  const cards = hourly(7, (i) => ({
    compliance: i % 8 === 0 ? [{ agent: "r37_funnel", check: "calibration_talk" }] : i % 9 === 0 ? [{ agent: "prophet", check: "data_scope" }] : [],
    stuck_open: (i % 40) < 6 ? [{ field: "prophet_r37.structure_subtype", candles: 9 }] : []
  }));
  for (let i = 0; i < cards.length; i += 50) await ingestCards(db, cards.slice(i, i + 50), { now: NOW });
  const k = kernel({ refuse: ["k-role-prophet-data-scope"] });
  const env = { AETHER_DB: db, AGENTS: k };
  const first = await runCuration(env, { now: NOW });
  assert.equal(first.status, "ok");
  assert.deepEqual([first.curator.proposed, first.curator.refused], [1, 1]);
  assert.equal(first.calibrator.proposed, 1);
  assert.deepEqual(k.proposals.map((p) => [p.agent, p.item_id]).sort(), [["aether-calibrator", "k-param-prophet-r37-statemaxage-16"], ["aether-curator", "k-role-r37-funnel-calibration-talk"]]);

  const again = await runCuration(env, { now: NOW + 86_400_000 });
  assert.equal(again.curator.proposed + again.calibrator.proposed, 0, "nothing is proposed while a version is pending");
  assert.equal(k.proposals.length, 2);
  assert.deepEqual(await knowledgeCounts(db), { pending: 2, refused: 1 });

  resetKnowledgeSchemaCacheForTests();
  const fresh = d1();
  resetSchemaCacheForTests();
  for (let i = 0; i < cards.length; i += 50) await ingestCards(fresh, cards.slice(i, i + 50), { now: NOW });
  const denied = await runCuration({ AETHER_DB: fresh, AGENTS: kernel({ deny: true }) }, { now: NOW });
  assert.match(String(denied.curator.stopped), /^denied/, "a denial is final for the run");
  assert.ok(MAX_PROPOSALS_PER_RUN <= 6);
});

test("reviews come back through knowledge.status; approved items form the learned pack, labelled and shadow-only", async () => {
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests();
  const db = d1();
  const cards = hourly(7, (i) => ({ compliance: i % 8 === 0 ? [{ agent: "r37_funnel", check: "calibration_talk" }] : [], stuck_open: (i % 40) < 6 ? [{ field: "prophet_r37.structure_subtype", candles: 9 }] : [] }));
  for (let i = 0; i < cards.length; i += 50) await ingestCards(db, cards.slice(i, i + 50), { now: NOW });
  const k = kernel();
  const env = { AETHER_DB: db, AGENTS: k };
  await runCuration(env, { now: NOW });
  assert.equal((await learnedPack(env)).items.length, 0, "nothing is in the pack before a person approves");
  k.proposals[0].status = "approved"; k.proposals[0].decided_by = "owner@example.com";
  k.proposals[1].status = "rejected"; k.proposals[1].reason = "too early";
  assert.deepEqual(await syncReviews(env, { now: NOW + H }), { status: "ok", approved: 1, rejected: 1, expired: 0 });
  assert.deepEqual(await syncReviews(env, { now: NOW + 2 * H }), { status: "ok", approved: 0, rejected: 0, expired: 0 }, "idempotent");
  const pack = await learnedPack(env);
  assert.equal(pack.version, "cryptophys.learned-pack.v1");
  assert.match(pack.sha256, /^[0-9a-f]{64}$/);
  assert.equal(pack.use, "shadow testing only; never a live prompt");
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].label, "learned");
  assert.equal(pack.items[0].item_id, k.proposals[0].item_id);
  assert.equal(JSON.stringify(pack).includes("card_ids"), false, "the pack carries the item, not the evidence trail");
});

test("without the kernel binding nothing is proposed and nothing throws", async () => {
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests();
  const db = d1();
  const cards = hourly(7, (i) => ({ compliance: i % 8 === 0 ? [{ agent: "r37_funnel", check: "calibration_talk" }] : [] }));
  for (let i = 0; i < cards.length; i += 50) await ingestCards(db, cards.slice(i, i + 50), { now: NOW });
  const r = await runCuration({ AETHER_DB: db }, { now: NOW });
  assert.equal(r.curator.proposed, 0);
  assert.equal(r.curator.stopped, "unavailable");
  assert.deepEqual(await syncReviews({ AETHER_DB: db }, { now: NOW }), { status: "ok", approved: 0, rejected: 0, expired: 0 });
});

test("curation progress: each rule's have-versus-need, and ready exactly when the rule itself drafts the item", async () => {
  const { curationProgress, ROLE_DRIFT, CAUTION, ENGINE } = await import("../src/knowledge.mjs");
  // Three days of cards: role drift is short of its 6-day span, so nothing is ready yet.
  const young = curationProgress(hourly(3, (i) => (i % 8 === 0 ? { compliance: [{ agent: "r37_funnel", check: "calibration_talk" }] } : {})), { now: NOW });
  assert.equal(young.version, "cryptophys.aether-curation-progress.v1");
  assert.equal(young.role_drift.need.span_days, ROLE_DRIFT.min_span_days);
  assert.ok(young.role_drift.span_days < ROLE_DRIFT.min_span_days);
  const funnel = young.role_drift.agents.find((a) => a.agent === "r37_funnel");
  assert.deepEqual([funnel.rooms, funnel.check, funnel.rooms_with_break, funnel.ready], [72, "calibration_talk", 9, false]);
  assert.equal(young.role_drift.ready, 0);
  assert.equal(young.caution.need.decisive, CAUTION.min_decisive);
  assert.deepEqual(young.engine.need, { episodes: ENGINE.min_episodes, cards: ENGINE.min_cards });

  // Seven days with the same breaks: the rule drafts the item, and the progress says ready.
  const week = hourly(7, (i) => (i % 8 === 0 ? { compliance: [{ agent: "r37_funnel", check: "calibration_talk" }] } : {}));
  const p = curationProgress(week, { now: NOW });
  assert.equal(p.role_drift.ready, roleDriftCandidates(week, { now: NOW }).length);
  assert.equal(p.role_drift.agents[0].agent, "r37_funnel");
  assert.equal(p.role_drift.agents[0].ready, true);

  // Caution: the London pattern is ready; the counts are the measured decisive outcomes.
  const month = hourly(30, (i, ms) => ({ outcomes: { "agent:prophet": { result: sessionOf(ms) === "london" ? (i % 3 === 0 ? "hit" : "miss") : (i % 10 === 0 ? "miss" : "hit") } } }));
  const c = curationProgress(month, { now: NOW }).caution;
  assert.equal(c.ready, cautionCandidates(month, { now: NOW }).length);
  assert.equal(c.situations[0].session, "london");
  assert.equal(c.situations[0].ready, true);
  assert.equal(c.decisive_outcomes, 30 * 24);

  // Engine: the stuck episodes per tuning family, with the next untested grid value.
  const stuck = hourly(30, (i) => ((i % 100) < 12 ? { stuck_open: [{ field: "gmi_v12_70.verdict", candles: 9 }] } : {}));
  const e = curationProgress(stuck, { now: NOW }).engine;
  const gmi = e.families.find((f) => f.family === "gmi_v12_70");
  assert.equal(gmi.episodes, stuckEpisodes(stuck, { now: NOW }).gmi_v12_70.episodes);
  assert.equal(gmi.next_value, 16);
  assert.equal(gmi.ready, true);
  assert.equal(e.families.find((f) => f.family === "prophet_r37").ready, false);
  assert.doesNotMatch(JSON.stringify(p), /entry_price|stop_loss|take_profit/);
});
