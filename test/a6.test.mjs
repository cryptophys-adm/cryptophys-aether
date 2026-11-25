import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ingestCards, ensureSchema, resetSchemaCacheForTests } from "../src/store.mjs";
import {
  binomialTail, roleDriftCandidates, cautionCandidates, stuckEpisodes, paramCandidates, runCuration, syncReviews, learnedPack, knowledgeCounts,
  resetKnowledgeSchemaCacheForTests, TUNING_GRID, ITEM_SCHEMA, KERNEL_PROPOSE_QUOTA, curationCarried
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
function kernel({ deny = false, refuse = [], denyReports = false } = {}) {
  const proposals = [], reports = [];
  return {
    proposals, reports,
    async syscall(agentId, capability, input) {
      if (capability === "reports.publish") {
        reports.push({ agent: agentId, ...input });
        if (denyReports) return { outcome: "denied", capability, reason: "failed: kill_switch" };
        return { outcome: "succeeded", capability, result: { report_id: `rpt_${reports.length}`, agent_id: agentId } };
      }
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
  assert.ok(denied.curator.carried >= 1, "the denied candidates are not dropped: the next daily run draws them again");
  assert.equal(await curationCarried({ AETHER_DB: fresh }), false, "after a denial nothing is retried in the next hour (rule 6)");
  assert.deepEqual({ ...KERNEL_PROPOSE_QUOTA }, { per_hour: 6, per_day: 20 }, "the kernel's quota, mirrored");
});

test("owner 2026-11-14: every candidate is proposed (beyond the old 3 a run), paced to the kernel's quota, the rest carried to the next hour", async () => {
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests();
  const db = d1();
  const checks = ["calibration_talk", "data_scope", "natural_language"];
  // Three non-moderator agents: a moderator-only reminder is not proposed (xauusd cannot shadow-test it, isUntestableShape).
  const speakers = [{ id: "r37_funnel", stance: "WAIT" }, { id: "prophet", stance: "SELL" }, { id: "gmi", stance: "WAIT" }, { id: "moderator", stance: "WAIT" }];
  const cards = hourly(7, (i) => ({ agents: speakers, compliance: i % 8 === 0 ? ["r37_funnel", "prophet", "gmi"].flatMap((agent) => checks.map((check) => ({ agent, check }))) : [] }));
  for (let i = 0; i < cards.length; i += 50) await ingestCards(db, cards.slice(i, i + 50), { now: NOW });
  const k = kernel();
  const env = { AETHER_DB: db, AGENTS: k };
  const first = await runCuration(env, { now: NOW });
  assert.equal(first.candidates.curator, 9);
  assert.deepEqual([first.curator.proposed, first.curator.carried, first.curator.stopped], [KERNEL_PROPOSE_QUOTA.per_hour, 3, null], "6 proposed (the kernel's hourly quota, not 3), 3 carried");
  assert.equal(await curationCarried(env), true, "the next hour runs again");
  const sameHour = await runCuration(env, { now: NOW + 10 * 60_000 });
  assert.deepEqual([sameHour.curator.proposed, sameHour.curator.carried], [0, 3], "within the hour the quota is spent: carried, no denial asked for");
  assert.equal(k.proposals.length, 6);
  // At the next :52 the kernel's one-hour window (real time) can still hold the first six: no call is risked.
  assert.equal((await runCuration(env, { now: NOW + 3_600_000 })).curator.carried, 3);
  const next = await runCuration(env, { now: NOW + 2 * 3_600_000 });
  assert.deepEqual([next.curator.proposed, next.curator.carried, next.curator.skipped], [3, 0, 6], "once the window has passed, the rest is proposed");
  assert.equal(await curationCarried(env), false);
  assert.equal(new Set(k.proposals.map((p) => p.item_id)).size, 9, "all nine proposed, none twice, none dropped");
});

test("owner 2026-11-14: the curator and the calibrator each leave one recorded report per daily run, with or without a candidate; none on the carry runs", async () => {
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests();
  const db = d1();
  // Curator candidates only (role drift): the calibrator has nothing to propose.
  const cards = hourly(7, (i) => ({ compliance: i % 8 === 0 ? [{ agent: "r37_funnel", check: "calibration_talk" }] : [] }));
  for (let i = 0; i < cards.length; i += 50) await ingestCards(db, cards.slice(i, i + 50), { now: NOW });
  const k = kernel();
  const env = { AETHER_DB: db, AGENTS: k };
  const run = await runCuration(env, { now: NOW, daily: true });
  assert.equal(run.candidates.calibrator, 0);
  assert.equal(run.curator.proposed, 1);
  assert.deepEqual([run.curator_report, run.calibrator_report], ["succeeded", "succeeded"]);
  assert.equal(k.reports.length, 2, "exactly one report per agent");
  assert.deepEqual(k.reports, [{
    agent: "aether-curator", kind: "knowledge_audit", severity: "info", subject: "Curator run: 1 candidate, 1 proposed, 0 carried", ai_status: "deterministic",
    body: { advisory: "advisory only; not an order", run_at: new Date(NOW).toISOString(), cards: cards.length, candidates: 1, proposed: 1, carried: 0, skipped: 0, refused: 0, untestable: 0, already_failed: 0, stopped: null }
  }, {
    agent: "aether-calibrator", kind: "knowledge_audit", severity: "info", subject: `Calibrator run: no candidate in ${cards.length} cards`, ai_status: "deterministic",
    body: { advisory: "advisory only; not an order", run_at: new Date(NOW).toISOString(), cards: cards.length, candidates: 0, proposed: 0, carried: 0, skipped: 0, refused: 0, untestable: 0, already_failed: 0, stopped: null }
  }]);
  // A carry run (not daily) reports nothing; the next daily run reports once again.
  const carry = await runCuration(env, { now: NOW + H });
  assert.equal(carry.curator_report, undefined);
  assert.equal(carry.calibrator_report, undefined);
  assert.equal(k.reports.length, 2);
  await runCuration(env, { now: NOW + 24 * H, daily: true });
  assert.equal(k.reports.length, 4, "one report per agent per daily run");
  assert.deepEqual(k.reports.map((r) => r.agent), ["aether-curator", "aether-calibrator", "aether-curator", "aether-calibrator"]);
  assert.deepEqual(k.reports.slice(2).map((r) => [r.severity, r.body.run_at, r.body.proposed]), [["info", new Date(NOW + 24 * H).toISOString(), 0], ["info", new Date(NOW + 24 * H).toISOString(), 0]]);

  // With no card at all, and with a candidate: still exactly one report, counts only.
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests();
  const empty = kernel(), emptyDb = d1();
  await ensureSchema(emptyDb);
  const none = await runCuration({ AETHER_DB: emptyDb, AGENTS: empty }, { now: NOW, daily: true });
  assert.equal(none.cards, 0);
  assert.deepEqual(empty.reports.map((r) => [r.agent, r.severity, r.subject, r.body.cards, r.body.candidates]), [["aether-curator", "info", "Curator run: no candidate in 0 cards", 0, 0], ["aether-calibrator", "info", "Calibrator run: no candidate in 0 cards", 0, 0]], "the curator reports a run with no candidate too");
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests();
  const withCandidate = d1();
  const stuck = hourly(7, (i) => ({ stuck_open: (i % 40) < 6 ? [{ field: "prophet_r37.structure_subtype", candles: 9 }] : [] }));
  for (let i = 0; i < stuck.length; i += 50) await ingestCards(withCandidate, stuck.slice(i, i + 50), { now: NOW });
  const k2 = kernel();
  await runCuration({ AETHER_DB: withCandidate, AGENTS: k2 }, { now: NOW, daily: true });
  assert.deepEqual(k2.reports.map((r) => r.subject), ["Curator run: no candidate in " + stuck.length + " cards", "Calibrator run: 1 candidate, 1 proposed, 0 carried"]);
  assert.deepEqual([k2.reports[1].body.candidates, k2.reports[1].body.proposed, k2.reports[1].body.carried], [1, 1, 0]);
  assert.doesNotMatch(JSON.stringify(k2.reports), /[0-9]{4}\.[0-9]|price|level|lot/i, "counts only, never a price");

  // A denial is final (AGENTS.md rule 6): sent once, never retried.
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests();
  const denied = kernel({ denyReports: true }), deniedDb = d1();
  await ensureSchema(deniedDb);
  const r = await runCuration({ AETHER_DB: deniedDb, AGENTS: denied }, { now: NOW, daily: true });
  assert.deepEqual([r.curator_report, r.calibrator_report], ["denied", "denied"]);
  assert.deepEqual(denied.reports.map((x) => x.agent), ["aether-curator", "aether-calibrator"], "each sent once, no retry");
  // Without the kernel binding nothing throws.
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests();
  const unbound = d1();
  await ensureSchema(unbound);
  const u = await runCuration({ AETHER_DB: unbound }, { now: NOW, daily: true });
  assert.deepEqual([u.curator_report, u.calibrator_report], ["unavailable", "unavailable"]);
});

test("reviews come back through knowledge.status; approved items form the learned pack, labelled and shadow-only", async () => {
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests();
  const db = d1();
  const cards = hourly(7, (i) => ({ compliance: i % 8 === 0 ? [{ agent: "r37_funnel", check: "calibration_talk" }] : [], stuck_open: (i % 40) < 6 ? [{ field: "prophet_r37.structure_subtype", candles: 9 }] : [] }));
  for (let i = 0; i < cards.length; i += 50) await ingestCards(db, cards.slice(i, i + 50), { now: NOW });
  const k = kernel();
  const env = { AETHER_DB: db, AGENTS: k };
  await runCuration(env, { now: NOW });
  assert.equal((await learnedPack({ ...env, KNOWLEDGE_AUTO_SHADOW: "off" })).items.length, 0, "with autonomous shadow testing off, nothing is in the pack before a person approves");
  // Owner 2026-11-13 ("buat agar autonomous"): an undecided text proposal is shadow-tested by itself; a parameter is not.
  const auto = await learnedPack(env);
  assert.deepEqual(auto.items.map((it) => [it.kind, it.review]), [["role_reminder", "auto"]]);
  k.proposals[0].status = "approved"; k.proposals[0].decided_by = "owner@example.com";
  k.proposals[1].status = "rejected"; k.proposals[1].reason = "too early";
  assert.deepEqual(await syncReviews(env, { now: NOW + H }), { status: "ok", approved: 1, rejected: 1, expired: 0, verdicts: 0 });
  assert.deepEqual(await syncReviews(env, { now: NOW + 2 * H }), { status: "ok", approved: 0, rejected: 0, expired: 0, verdicts: 0 }, "idempotent");
  const pack = await learnedPack(env);
  assert.equal(pack.version, "cryptophys.learned-pack.v1");
  assert.match(pack.sha256, /^[0-9a-f]{64}$/);
  assert.match(pack.use, /^shadow testing; xauusd promotes an item only on its own shadow verdict/);
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].review, "approved");
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
  assert.deepEqual(await syncReviews({ AETHER_DB: db }, { now: NOW }), { status: "ok", approved: 0, rejected: 0, expired: 0, verdicts: 0 });
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

test("autonomous shadow testing: an undecided text item stays in the pack, a rejection removes it, one version per item", async () => {
  resetKnowledgeSchemaCacheForTests();
  const db = d1();
  const env = { AETHER_DB: db };
  await learnedPack(env); // creates the schema
  const put = (id, version, kind, status) => db.raw.prepare("INSERT INTO knowledge_items (item_id, version, kind, agent_id, item_json, status, proposal_id, content_sha256, detail, created_at, updated_at) VALUES (?, ?, ?, 'aether-curator', ?, ?, ?, NULL, NULL, '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z')")
    .run(id, version, kind, JSON.stringify({ item_id: id, version, kind, audience: { agents: ["risk"], charts: ["60"] }, text: `${id} v${version}` }), status, `p-${id}-${version}`);
  put("k-a", 1, "caution", "expired"); put("k-a", 2, "caution", "pending");
  put("k-b", 1, "role_reminder", "rejected");
  put("k-c", 1, "caution", "approved"); put("k-c", 2, "caution", "pending");
  put("k-p", 1, "param_candidate", "pending");
  const pack = await learnedPack(env);
  assert.deepEqual(pack.items.map((it) => [it.item_id, it.version, it.review]), [["k-a", 2, "auto"], ["k-c", 1, "approved"]]);
});

// ---------------------------------------------------------------- the shadow verdicts' feedback loop (owner 2026-11-25)

test("feedback loop: isUntestableShape names the audiences xauusd cannot shadow-test (moderator only, the 240 chart only, Omega)", async () => {
  const { isUntestableShape } = await import("../src/knowledge.mjs");
  const shape = (agents, charts) => ({ audience: { agents, charts } });
  assert.equal(isUntestableShape(shape(["moderator"], [])), true, "moderator only");
  assert.equal(isUntestableShape(shape(["moderator"], ["60"])), true, "moderator only, on a testable chart");
  assert.equal(isUntestableShape(shape(["prophet", "moderator"], ["240"])), true, "the four-hour chart only");
  assert.equal(isUntestableShape(shape(["omega", "moderator"], ["15"])), true, "an Omega audience");
  assert.equal(isUntestableShape(shape(["prophet", "moderator"], ["60"])), false);
  assert.equal(isUntestableShape(shape(["r37_funnel", "moderator"], [])), false, "a role reminder for a room agent, every chart");
  assert.equal(isUntestableShape(shape(["prophet", "moderator"], ["60", "240"])), false, "the 240 chart among others");
  assert.equal(isUntestableShape(shape(["prophet", "moderator"], ["1D"])), false);
  // The curator's own rules: a caution on the 240 chart and a role reminder for the moderator are drawn, and untestable.
  const four = Array.from({ length: 400 }, (_, i) => card(i < 200 ? "240" : "60", NOW - (400 - i) * H, { session: "london", outcomes: { "agent:prophet": { result: i < 200 ? (i % 4 ? "miss" : "hit") : (i % 4 ? "hit" : "miss") } } }));
  const cautions = cautionCandidates(four, { now: NOW });
  assert.ok(cautions.some((c) => c.audience.charts[0] === "240"), "a four-hour caution is drawn");
  assert.ok(cautions.filter((c) => c.audience.charts[0] === "240").every(isUntestableShape));
  const drift = roleDriftCandidates(hourly(7, (i) => ({ compliance: i % 8 === 0 ? [{ agent: "moderator", check: "natural_language" }, { agent: "r37_funnel", check: "calibration_talk" }] : [] })), { now: NOW });
  assert.deepEqual(drift.map((c) => [c.item_id, isUntestableShape(c)]).sort(), [["k-role-moderator-natural-language", true], ["k-role-r37-funnel-calibration-talk", false]]);
});

test("feedback loop: verdictSkip on xauusd's verdicts; live, collecting, inconclusive, a testable not_tested or none change nothing", async () => {
  const { verdictSkip, verdictIndex, NEGATIVE_TERMINAL_VERDICTS } = await import("../src/knowledge.mjs");
  const item = { item_id: "k-a", audience: { agents: ["prophet", "moderator"], charts: ["60"] } };
  const row = (item_id, version, v, audience = item.audience) => ({ item_id, version, item_json: JSON.stringify({ item_id, version, audience }), detail: JSON.stringify({ latest_verdict: v }) });
  const v = (verdict, terminal, rule) => ({ verdict, terminal, reason: verdict, evidence: rule ? { rule } : {}, created_at: "2026-11-24T00:00:00Z" });
  assert.deepEqual([...NEGATIVE_TERMINAL_VERDICTS], ["not_better", "worse", "holdout_failed"]);
  for (const bad of NEGATIVE_TERMINAL_VERDICTS) assert.equal(verdictSkip(item, verdictIndex([row("k-a", 1, v(bad, true))])), "already_failed", bad);
  for (const [verdict, terminal] of [["live", true], ["retired", true], ["collecting", false], ["inconclusive", false]]) {
    assert.equal(verdictSkip(item, verdictIndex([row("k-a", 1, v(verdict, terminal))])), null, verdict);
  }
  assert.equal(verdictSkip(item, verdictIndex([row("k-a", 1, v("not_tested", false, "budget.later"))])), null, "a not_tested without an untestable rule");
  assert.equal(verdictSkip(item, verdictIndex([row("k-a", 1, null)])), null, "no verdict");
  assert.equal(verdictSkip(item, verdictIndex([])), null, "no record");
  assert.equal(verdictSkip(item, null), null);
  // The item's latest verdict is that of its newest version with one.
  assert.equal(verdictSkip(item, verdictIndex([row("k-a", 1, v("collecting", false)), row("k-a", 2, v("worse", true))])), "already_failed");
  assert.equal(verdictSkip(item, verdictIndex([row("k-a", 2, v("collecting", false)), row("k-a", 1, v("worse", true))])), null);
  // not_tested with an untestable.* rule: that item, and any item of the same audience.
  const untestable = verdictIndex([row("k-b", 1, v("not_tested", false, "untestable.agent_inactive"))]);
  assert.equal(verdictSkip({ item_id: "k-b", audience: { agents: ["gmi"], charts: [] } }, untestable), "untestable", "the same item id");
  assert.equal(verdictSkip({ item_id: "k-c", audience: { agents: ["moderator", "prophet"], charts: ["60"] } }, untestable), "untestable", "the same shape, in any order");
  assert.equal(verdictSkip({ item_id: "k-d", audience: { agents: ["prophet", "moderator"], charts: ["15"] } }, untestable), null, "another shape");
});

/** Role drift cards: the r37 funnel breaks `checks` in one room in eight over 7 days (one candidate per check). */
async function driftDb(checks) {
  resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests();
  const db = d1();
  const cards = hourly(7, (i) => ({ compliance: i % 8 === 0 ? checks.map((check) => ({ agent: "r37_funnel", check })) : [] }));
  for (let i = 0; i < cards.length; i += 50) await ingestCards(db, cards.slice(i, i + 50), { now: NOW });
  return db;
}

test("feedback loop: knowledge.status brings each proposal's latest verdict back into its D1 record, expired items included", async () => {
  const db = await driftDb(["calibration_talk"]);
  const k = kernel();
  const env = { AETHER_DB: db, AGENTS: k };
  await runCuration(env, { now: NOW });
  const p = k.proposals[0];
  p.latest_verdict = null;
  assert.deepEqual(await syncReviews(env, { now: NOW + H }), { status: "ok", approved: 0, rejected: 0, expired: 0, verdicts: 0 }, "a null verdict on a pending item records nothing new");
  p.latest_verdict = { verdict: "collecting", terminal: false, reason: "collecting rooms", evidence: { rule: "collecting.min_rooms", rooms: 12 }, created_at: "2026-12-10T13:00:00Z" };
  assert.deepEqual(await syncReviews(env, { now: NOW + H }), { status: "ok", approved: 0, rejected: 0, expired: 0, verdicts: 1 });
  const read = () => db.raw.prepare("SELECT status, detail, updated_at FROM knowledge_items WHERE proposal_id = ?").get(p.proposal_id);
  const before = read();
  assert.equal(before.status, "pending");
  assert.equal(before.updated_at, new Date(NOW).toISOString(), "a verdict alone changes neither status nor updated_at");
  assert.deepEqual(JSON.parse(before.detail), { latest_verdict: { verdict: "collecting", terminal: false, reason: "collecting rooms", evidence: { rule: "collecting.min_rooms" }, created_at: "2026-12-10T13:00:00Z" } }, "of the evidence only its rule token");
  // Expired, then a terminal verdict: both kept in the one record; the expired item is still followed.
  p.status = "expired"; p.decided_at = "2026-12-11T00:00:00Z";
  assert.deepEqual(await syncReviews(env, { now: NOW + 2 * H }), { status: "ok", approved: 0, rejected: 0, expired: 1, verdicts: 0 });
  p.latest_verdict = { verdict: "not_better", terminal: true, reason: "no better than active", evidence: {}, created_at: "2026-12-12T00:00:00Z" };
  assert.deepEqual(await syncReviews(env, { now: NOW + 3 * H }), { status: "ok", approved: 0, rejected: 0, expired: 0, verdicts: 1 });
  assert.deepEqual(JSON.parse(read().detail), { latest_verdict: { verdict: "not_better", terminal: true, reason: "no better than active", evidence: null, created_at: "2026-12-12T00:00:00Z" }, decided_by: null, reason: null, decided_at: "2026-12-11T00:00:00Z" });
  assert.deepEqual(await syncReviews(env, { now: NOW + 4 * H }), { status: "ok", approved: 0, rejected: 0, expired: 0, verdicts: 0 }, "idempotent");
});

test("feedback loop: an item whose latest verdict is a terminal not_better, worse or holdout_failed is not proposed again", async () => {
  for (const verdict of ["not_better", "worse", "holdout_failed"]) {
    const db = await driftDb(["calibration_talk"]);
    const k = kernel();
    const env = { AETHER_DB: db, AGENTS: k };
    assert.equal((await runCuration(env, { now: NOW })).curator.proposed, 1);
    Object.assign(k.proposals[0], { status: "expired", latest_verdict: { verdict, terminal: true, reason: verdict, evidence: {}, created_at: "2026-12-10T13:00:00Z" } });
    await syncReviews(env, { now: NOW + H });
    const run = await runCuration(env, { now: NOW + 2 * H, daily: true });
    assert.deepEqual([run.candidates.curator, run.curator.proposed, run.curator.already_failed, run.curator.untestable], [1, 0, 1, 0], verdict);
    assert.equal(k.proposals.length, 1, `${verdict}: no version 2`);
    assert.deepEqual([k.reports[0].body.candidates, k.reports[0].body.already_failed], [1, 1], "the run report counts it");
  }
});

test("feedback loop: a not_tested verdict with an untestable rule stops that item and its shape; other items go on", async () => {
  const db = await driftDb(["calibration_talk", "data_scope"]);
  const k = kernel();
  const env = { AETHER_DB: db, AGENTS: k };
  assert.equal((await runCuration(env, { now: NOW })).curator.proposed, 2);
  const first = k.proposals.find((p) => p.item_id === "k-role-r37-funnel-calibration-talk");
  Object.assign(first, { status: "expired", latest_verdict: { verdict: "not_tested", terminal: false, reason: "agent inactive", evidence: { rule: "untestable.agent_inactive" }, created_at: "2026-12-10T13:00:00Z" } });
  const other = k.proposals.find((p) => p.item_id === "k-role-r37-funnel-data-scope");
  other.status = "expired";
  await syncReviews(env, { now: NOW + H });
  // Both items have the same audience (the r37 funnel and the moderator, every chart): neither is proposed again.
  const run = await runCuration(env, { now: NOW + 2 * H });
  assert.deepEqual([run.curator.proposed, run.curator.untestable, run.curator.already_failed], [0, 2, 0]);
  assert.equal(k.proposals.length, 2);
});

test("feedback loop: with a live or collecting verdict, or none, a candidate is proposed as before", async () => {
  for (const latest of [undefined, null, { verdict: "collecting", terminal: false }, { verdict: "live", terminal: true }, { verdict: "inconclusive", terminal: false }]) {
    const db = await driftDb(["calibration_talk"]);
    const k = kernel();
    const env = { AETHER_DB: db, AGENTS: k };
    await runCuration(env, { now: NOW });
    k.proposals[0].status = "expired";
    if (latest !== undefined) k.proposals[0].latest_verdict = latest && { ...latest, reason: "x", evidence: {}, created_at: "2026-12-10T13:00:00Z" };
    await syncReviews(env, { now: NOW + H });
    const run = await runCuration(env, { now: NOW + 2 * H });
    assert.deepEqual([run.curator.proposed, run.curator.untestable, run.curator.already_failed], [1, 0, 0], JSON.stringify(latest));
    assert.deepEqual(k.proposals.map((p) => [p.item_id, p.item_version]), [["k-role-r37-funnel-calibration-talk", 1], ["k-role-r37-funnel-calibration-talk", 2]]);
  }
});
