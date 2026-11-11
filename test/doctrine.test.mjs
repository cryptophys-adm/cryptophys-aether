import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CANON } from "../src/canon.generated.mjs";
import {
  councilReview, effectiveDoctrine, effectiveSha, renderRule, runCouncil, storeFacts, syncAmendments, doctrineView, validateFacts,
  resetDoctrineSchemaCacheForTests, sessionIdAt, canonShort, FACTS_SCHEMA, MAX_PROPOSALS_PER_SESSION
} from "../src/doctrine.mjs";

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

const NOW = Date.parse("2026-11-12T03:52:00Z");
const H = 3_600_000;
/** The facts the running system would report when it matches the canon exactly. */
function canonFacts() {
  const nexus = {}, omega = {};
  for (const r of CANON.doctrine.rules) for (const a of r.anchors) (a.fact.startsWith("omega.") ? omega : nexus)[a.fact] = structuredClone(a.value);
  return { nexus, omega };
}
const report = (at, { nexus = {}, omega = {}, version = "v-1", omegaVersion = "v-1" } = {}) => {
  const base = canonFacts();
  return { schema: FACTS_SCHEMA, measured_at: new Date(at).toISOString(), seats: { nexus: { version_id: version, facts: { ...base.nexus, ...nexus } }, omega: { version_id: omegaVersion, facts: { ...base.omega, ...omega } } } };
};
const asRules = (applied = []) => effectiveDoctrine(applied).map((r) => ({ ...r, template: CANON.doctrine.rules.find((c) => c.id === r.id).template, anchors: r.anchors.map((a) => ({ fact: a.fact, format: a.format, value: a.value })) }));
const seatsOf = (p) => ({ received_at: p.measured_at, measured_at: p.measured_at, seats: validateFacts(p, { now: NOW }).seats });

function kernel({ execute = false, deny = false } = {}) {
  const proposals = [], reports = [], amendments = [];
  return {
    proposals, reports, amendments,
    async syscall(agent, capability, input) {
      assert.equal(agent, "knowledge-council", "the council speaks as its own agent");
      if (capability === "consensus.propose") {
        if (deny) return { outcome: "denied", reason: "failed: rate_limit" };
        const id = `cns_${String(proposals.length).padStart(8, "0")}-0000-4000-8000-000000000000`;
        proposals.push({ id, ...input });
        if (execute && input.action === "amend_doctrine") amendments.push({ amendment_id: id, rule: input.params.rule, action: input.action, values: input.params.values, previous: input.params.previous, canon: input.params.canon, session: input.params.session, executed_by: `consensus:${id}`, executed_at: new Date(NOW + amendments.length).toISOString() });
        return { outcome: "succeeded", result: { proposal: { proposal_id: id, status: execute && input.action === "amend_doctrine" ? "executed" : "pending_owner" } } };
      }
      if (capability === "doctrine.status") return { outcome: "succeeded", result: { amendments: amendments.filter((a) => !input.since || a.executed_at > input.since) } };
      if (capability === "reports.publish") { reports.push(input); return { outcome: "succeeded" }; }
      return { outcome: "denied", reason: "not granted" };
    }
  };
}

test("the facts report: two seats, each fact in its own seat, never in the future", () => {
  const v = validateFacts(report(NOW), { now: NOW });
  assert.deepEqual(Object.keys(v.seats).sort(), ["nexus", "omega"]);
  assert.ok(Object.keys(v.seats.omega.facts).every((f) => f.startsWith("omega.")));
  assert.throws(() => validateFacts({ ...report(NOW), schema: "x" }), /schema/);
  assert.throws(() => validateFacts({ schema: FACTS_SCHEMA, measured_at: new Date(NOW).toISOString(), seats: { nexus: { facts: { "omega.risk_pct": 1 } } } }, { now: NOW }), /belongs to the omega seat/);
  assert.throws(() => validateFacts(report(NOW + 3600_000), { now: NOW }), /future/);
});

test("in sync: the council proposes nothing when the system matches the doctrine", () => {
  const review = councilReview({ rules: asRules(), latest: seatsOf(report(NOW)), previous: seatsOf(report(NOW - H)), session: "kc_20261112-0352" });
  assert.ok(review.length > 0);
  assert.ok(review.every((r) => r.status === "in_sync"), JSON.stringify(review.filter((r) => r.status !== "in_sync")));
});

test("a drift measured twice from the same version, inside its bound: every seat agrees and a routine amendment is proposed", () => {
  const changed = { "decision.quorum_min": 0.55, "decision.min_rrr": 1.2 };
  const review = councilReview({ rules: asRules(), latest: seatsOf(report(NOW, { nexus: changed })), previous: seatsOf(report(NOW - H, { nexus: changed })), session: "kc_20261112-0352" });
  const item = review.find((r) => r.rule === "engine_thresholds");
  assert.equal(item.status, "propose");
  assert.equal(item.action, "amend_doctrine");
  assert.deepEqual(item.seats, { aether: "agree", nexus: "agree" });
  assert.deepEqual(item.proposal.params.values, changed);
  assert.deepEqual(item.proposal.params.previous, { "decision.quorum_min": 0.5, "decision.min_rrr": 1.5 });
  assert.equal(item.proposal.target, "engine-thresholds");
  assert.equal(item.proposal.params.canon, canonShort());
  assert.match(item.text, /more than 55% of the witnesses' weight/);
  assert.match(item.text, /at least 1\.2R/);
  assert.ok(JSON.stringify(item.proposal).length < 2000, "fits the kernel's params limit");
});

test("measured once, or changed between the reports: the seat keeps observing; the same value across a redeploy counts", () => {
  const changed = { "omega.risk_pct": 1 };
  const once = councilReview({ rules: asRules(), latest: seatsOf(report(NOW, { omega: changed })), previous: seatsOf(report(NOW - H)), session: "kc_x-1" }).find((r) => r.rule === "omega_execution_gates");
  assert.equal(once.status, "observing");
  assert.equal(once.seats.omega, "observing");
  const moving = councilReview({ rules: asRules(), latest: seatsOf(report(NOW, { omega: changed })), previous: seatsOf(report(NOW - H, { omega: { "omega.risk_pct": 1.5 } })), session: "kc_x-1" }).find((r) => r.rule === "omega_execution_gates");
  assert.equal(moving.status, "observing", "a value still moving is not proposed");
  // Owner 2026-11-11: xauusd redeploys several times a day; the same value from two versions counts.
  const redeployed = councilReview({ rules: asRules(), latest: seatsOf(report(NOW, { omega: changed, omegaVersion: "v-2" })), previous: seatsOf(report(NOW - H, { omega: changed })), session: "kc_x-1" }).find((r) => r.rule === "omega_execution_gates");
  assert.equal(redeployed.status, "propose");
  assert.deepEqual(redeployed.drifts[0].versions, ["v-1", "v-2"], "both versions are kept as evidence");
});

test("out of bounds: the Aether seat refuses; a constitutional or unbounded fact goes to the owner as amend_constitution", () => {
  const wild = { "decision.quorum_min": 0.9 };
  const refused = councilReview({ rules: asRules(), latest: seatsOf(report(NOW, { nexus: wild })), previous: seatsOf(report(NOW - H, { nexus: wild })), session: "kc_x-1" }).find((r) => r.rule === "engine_thresholds");
  assert.equal(refused.status, "refused");
  assert.match(refused.reasons.join(" "), /outside 0.45-0.7/);
  const parity = { "parity.approval_candles": 30 };
  const owner = councilReview({ rules: asRules(), latest: seatsOf(report(NOW, { nexus: parity })), previous: seatsOf(report(NOW - H, { nexus: parity })), session: "kc_x-1" }).find((r) => r.rule === "parity_trust_only");
  assert.equal(owner.status, "propose");
  assert.equal(owner.action, "amend_constitution");
  const guards = { "decision.guardrails": ["market_open", "quorum"] };
  const unbounded = councilReview({ rules: asRules(), latest: seatsOf(report(NOW, { nexus: guards })), previous: seatsOf(report(NOW - H, { nexus: guards })), session: "kc_x-1" }).find((r) => r.rule === "decision_engine_ssot");
  assert.equal(unbounded.action, "amend_constitution", "removing a guardrail is never routine");
});

test("a fact the system stopped reporting is unreported: an owner PR, never an amendment", () => {
  const r = report(NOW);
  delete r.seats.nexus.facts["decision.lean"];
  const p = report(NOW - H);
  delete p.seats.nexus.facts["decision.lean"];
  const item = councilReview({ rules: asRules(), latest: seatsOf(r), previous: seatsOf(p), session: "kc_x-1" }).find((x) => x.rule === "engine_thresholds");
  assert.equal(item.status, "unreported");
  assert.equal(item.proposal, undefined);
});

test("runCouncil: proposes to Cerebrum, applies only what Cerebrum executed, re-renders the rule and changes the index hash", async () => {
  resetDoctrineSchemaCacheForTests();
  const db = d1();
  const changed = { "decision.quorum_min": 0.55 };
  await storeFacts(db, report(NOW - 2 * H, { nexus: changed }), { now: NOW - 2 * H });
  await storeFacts(db, report(NOW - 10 * 60_000, { nexus: changed }), { now: NOW - 10 * 60_000 });
  const k = kernel({ execute: true });
  const env = { AETHER_DB: db, AGENTS: k };
  const r = await runCouncil(env, { now: NOW });
  assert.equal(r.status, "ok");
  assert.equal(r.session, sessionIdAt(NOW));
  assert.deepEqual(k.proposals.map((p) => [p.action, p.target]), [["amend_doctrine", "engine-thresholds"]]);
  assert.equal(k.reports.length, 1);
  assert.equal(k.reports[0].kind, "knowledge_audit");
  // The next hourly sync applies the executed amendment.
  const s = await syncAmendments(env, { now: NOW + H });
  assert.equal(s.applied, 1);
  const view = await doctrineView(env, { now: NOW + H });
  const rule = view.rules.find((x) => x.id === "engine_thresholds");
  assert.match(rule.rule, /more than 55% of the witnesses' weight/);
  assert.equal(rule.amended.action, "amend_doctrine");
  assert.equal(view.council.last_session.proposals[0].status, "executed");
  assert.notEqual(await effectiveSha(db), CANON.content_sha256, "the index re-embeds the doctrine in force");
  // The next session: in sync with the amended doctrine, and the same amendment is never proposed twice.
  const again = await runCouncil(env, { now: NOW + 24 * H - 10 * 60_000 });
  assert.equal(again.facts, false, "the facts are older than 3 hours by then");
  await storeFacts(db, report(NOW + 22 * H, { nexus: changed }), { now: NOW + 22 * H });
  await storeFacts(db, report(NOW + 24 * H - 5 * 60_000, { nexus: changed }), { now: NOW + 24 * H - 5 * 60_000 });
  const third = await runCouncil(env, { now: NOW + 24 * H });
  assert.equal(third.proposals.length, 0);
  assert.equal(third.open, 0);
});

test("observe mode records the review and proposes nothing; a denial ends the session; an amendment against another canon is not applied", async () => {
  resetDoctrineSchemaCacheForTests();
  const db = d1();
  const changed = { "decision.quorum_min": 0.55, "decision.lean": 0.1 };
  const omega = { "omega.max_spread_points": 80 };
  const weighting = { "weighting.activation_min_days": 14 };
  await storeFacts(db, report(NOW - 2 * H, { nexus: { ...changed, ...weighting }, omega }), { now: NOW - 2 * H });
  await storeFacts(db, report(NOW - 10 * 60_000, { nexus: { ...changed, ...weighting }, omega }), { now: NOW - 10 * 60_000 });
  const observe = kernel();
  const o = await runCouncil({ AETHER_DB: db, AGENTS: observe, KNOWLEDGE_COUNCIL: "observe" }, { now: NOW });
  assert.equal(o.mode, "observe");
  assert.equal(observe.proposals.length, 0);
  assert.equal(o.open, 3);
  const denied = kernel({ deny: true });
  const d = await runCouncil({ AETHER_DB: db, AGENTS: denied }, { now: NOW + 60_000 });
  assert.equal(d.proposals.length, 1, "a denial is final for the session");
  assert.ok(MAX_PROPOSALS_PER_SESSION >= 3);
  assert.equal((await runCouncil({ AETHER_DB: db, KNOWLEDGE_COUNCIL: "off" }, { now: NOW })).status, "off");
  const foreign = effectiveDoctrine([{ amendment_id: "cns_x", rule: "engine_thresholds", action: "amend_doctrine", values: { "decision.quorum_min": 0.6 }, canon: "000000000000", executed_at: "2026-11-12T00:00:00Z" }]);
  assert.match(foreign.find((r) => r.id === "engine_thresholds").rule, /more than 50%/, "an amendment made against another canon is folded in by the canon PR, not applied");
});

test("the template renderer keeps unknown tokens and formats each kind", () => {
  assert.equal(renderRule("{a.b} and {c.d}", [{ fact: "a.b", value: 0.5, format: "pct" }]), "50% and {c.d}");
  assert.equal(renderRule("{x.y}", [{ fact: "x.y", value: { D1: 0.5, SESSION: 0.5 }, format: "weights" }]), "D1 room 0.5, session 0.5");
  assert.equal(renderRule("{x.y}", [{ fact: "x.y", value: true, format: "bool" }]), "on");
});
