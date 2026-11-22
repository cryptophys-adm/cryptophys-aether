import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CANON } from "../src/canon.generated.mjs";
import {
  councilReview, effectiveDoctrine, effectiveSha, renderRule, runCouncil, storeFacts, syncAmendments, doctrineView, validateFacts,
  resetDoctrineSchemaCacheForTests, sessionIdAt, canonShort, FACTS_SCHEMA, MAX_PROPOSALS_PER_SESSION, omegaPolicy, omegaPolicyOf, OMEGA_POLICY_VERSION, DOCTRINE_BOUNDS,
  syncProposalStatuses, STATUS_BATCH_MAX, STATUS_DENIAL_BACKOFF_MS
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

function kernel({ execute = false, deny = false, statuses = null } = {}) {
  const proposals = [], reports = [], amendments = [], statusCalls = [];
  return {
    proposals, reports, amendments, statusCalls, statuses,
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
      // consensus.status (platform 2026-11-22): tier 0, the caller's own proposals, at most 50 ids. Denied until
      // the census grants it (statuses: null), as in production today.
      if (capability === "consensus.status" && this.statuses) {
        statusCalls.push(input.proposal_ids);
        assert.ok(input.proposal_ids.length >= 1 && input.proposal_ids.length <= 50, "at most 50 ids a call");
        return { outcome: "succeeded", result: { proposals: input.proposal_ids.map((id) => this.statuses[id] ? { proposal_id: id, action: "amend_doctrine", target: "doctrine", status: this.statuses[id], owner_decision: null, decided_at: null, expires_at: null } : { proposal_id: id, status: "not_found" }) } };
      }
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
  const changed = { "decision.quorum_min_intraday": 0.55, "decision.min_rrr_intraday": 1.2 };
  const review = councilReview({ rules: asRules(), latest: seatsOf(report(NOW, { nexus: changed })), previous: seatsOf(report(NOW - H, { nexus: changed })), session: "kc_20261112-0352" });
  const item = review.find((r) => r.rule === "engine_thresholds");
  assert.equal(item.status, "propose");
  assert.equal(item.action, "amend_doctrine");
  assert.deepEqual(item.seats, { aether: "agree", nexus: "agree" });
  assert.deepEqual(item.proposal.params.values, changed);
  assert.deepEqual(item.proposal.params.previous, { "decision.quorum_min_intraday": 0.5, "decision.min_rrr_intraday": 1.5 });
  assert.equal(item.proposal.target, "engine-thresholds");
  assert.equal(item.proposal.params.canon, canonShort());
  assert.match(item.text, /intraday 55%/);
  assert.match(item.text, /intraday 1\.2R/);
  assert.ok(JSON.stringify(item.proposal).length < 2000, "fits the kernel's params limit");
});

test("measured once, or changed between the reports: the seat keeps observing; the same value across a redeploy counts", () => {
  const changed = { "omega.risk_pct_aggressive": 1 };
  const once = councilReview({ rules: asRules(), latest: seatsOf(report(NOW, { omega: changed })), previous: seatsOf(report(NOW - H)), session: "kc_x-1" }).find((r) => r.rule === "omega_execution_gates");
  assert.equal(once.status, "observing");
  assert.equal(once.seats.omega, "observing");
  const moving = councilReview({ rules: asRules(), latest: seatsOf(report(NOW, { omega: changed })), previous: seatsOf(report(NOW - H, { omega: { "omega.risk_pct_aggressive": 1.5 } })), session: "kc_x-1" }).find((r) => r.rule === "omega_execution_gates");
  assert.equal(moving.status, "observing", "a value still moving is not proposed");
  // Owner 2026-11-11: xauusd redeploys several times a day; the same value from two versions counts.
  const redeployed = councilReview({ rules: asRules(), latest: seatsOf(report(NOW, { omega: changed, omegaVersion: "v-2" })), previous: seatsOf(report(NOW - H, { omega: changed })), session: "kc_x-1" }).find((r) => r.rule === "omega_execution_gates");
  assert.equal(redeployed.status, "propose");
  assert.deepEqual(redeployed.drifts[0].versions, ["v-1", "v-2"], "both versions are kept as evidence");
});

test("out of bounds: the Aether seat refuses; a constitutional or unbounded fact goes to the owner as amend_constitution", () => {
  const wild = { "decision.quorum_min_intraday": 0.9 };
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
  delete r.seats.nexus.facts["decision.lean_intraday"];
  const p = report(NOW - H);
  delete p.seats.nexus.facts["decision.lean_intraday"];
  const item = councilReview({ rules: asRules(), latest: seatsOf(r), previous: seatsOf(p), session: "kc_x-1" }).find((x) => x.rule === "engine_thresholds");
  assert.equal(item.status, "unreported");
  assert.equal(item.proposal, undefined);
});

test("runCouncil: proposes to Cerebrum, applies only what Cerebrum executed, re-renders the rule and changes the index hash", async () => {
  resetDoctrineSchemaCacheForTests();
  const db = d1();
  const changed = { "decision.quorum_min_intraday": 0.55 };
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
  // The session applies what Cerebrum executed right away; the next hourly sync finds nothing new.
  assert.equal(r.applied.applied, 1);
  const s = await syncAmendments(env, { now: NOW + H });
  assert.equal(s.applied, 0);
  const view = await doctrineView(env, { now: NOW + H });
  const rule = view.rules.find((x) => x.id === "engine_thresholds");
  assert.match(rule.rule, /intraday 55%/);
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
  const changed = { "decision.quorum_min_intraday": 0.55, "decision.lean_intraday": 0.1 };
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
  const foreign = effectiveDoctrine([{ amendment_id: "cns_x", rule: "engine_thresholds", action: "amend_doctrine", values: { "decision.quorum_min_intraday": 0.6 }, canon: "000000000000", executed_at: "2026-11-12T00:00:00Z" }]);
  assert.match(foreign.find((r) => r.id === "engine_thresholds").rule, /intraday 50%/, "an amendment made against another canon is folded in by the canon PR, not applied");
});

test("the template renderer keeps unknown tokens and formats each kind", () => {
  assert.equal(renderRule("{a.b} and {c.d}", [{ fact: "a.b", value: 0.5, format: "pct" }]), "50% and {c.d}");
  assert.equal(renderRule("{x.y}", [{ fact: "x.y", value: { D1: 0.5, SESSION: 0.5 }, format: "weights" }]), "D1 room 0.5, session 0.5");
  assert.equal(renderRule("{x.y}", [{ fact: "x.y", value: true, format: "bool" }]), "on");
});


test("B-12: Omega's policy is the doctrine in force, an amended value marked with its amendment; out-of-bound values are left out", async () => {
  const canon = omegaPolicyOf(effectiveDoctrine([]));
  const canonValue = (fact) => CANON.doctrine.rules.flatMap((r) => r.anchors).find((a) => a.fact === fact).value;
  // ADR-0020 Amendment 10: the risk is per profile; the single risk settings are no longer in the pack.
  const profiles = ["safe", "conservative", "aggressive", "custom"];
  assert.deepEqual(canon.values, {
    max_spread_points: canonValue("omega.max_spread_points"), max_signal_age_min: canonValue("omega.max_signal_age_min"),
    ...Object.fromEntries(profiles.flatMap((p) => ["risk_pct", "max_daily_loss_pct", "max_positions"].map((k) => [`${k}_${p}`, canonValue(`omega.${k}_${p}`)])))
  });
  assert.deepEqual([canon.values.risk_pct, canon.values.max_positions, canon.values.max_daily_loss_pct], [undefined, undefined, undefined]);
  assert.deepEqual(profiles.map((p) => [canon.values[`risk_pct_${p}`], canon.values[`max_daily_loss_pct_${p}`], canon.values[`max_positions_${p}`]]),
    [[1, 3, 1], [2, 6, 2], [3, 6, 2], [3, 6, 2]], "anchored at the limits in force on 2026-11-21 (owner: \"Nilai yang berjalan sekarang\")");
  assert.deepEqual(canon.amended, {});
  const rule = CANON.doctrine.rules.find((r) => r.anchors.some((a) => a.fact === "omega.risk_pct_aggressive"));
  const amendment = { amendment_id: "cns_1", rule: rule.id, action: "amend_doctrine", values: { "omega.risk_pct_aggressive": 2 }, canon: canonShort(), executed_at: "2026-11-12T04:00:00Z" };
  const amended = omegaPolicyOf(effectiveDoctrine([amendment]));
  assert.equal(amended.values.risk_pct_aggressive, 2);
  assert.deepEqual(amended.amended.risk_pct_aggressive, { from: 3, amendment_id: "cns_1", executed_at: "2026-11-12T04:00:00Z" });
  const outOfBound = omegaPolicyOf(effectiveDoctrine([{ ...amendment, values: { "omega.risk_pct_aggressive": 12 } }]));
  assert.equal(outOfBound.values.risk_pct_aggressive, undefined, "a value out of the fact's bounds is never sent");
  // The single facts are information: no bound, so an amendment naming one is constitutional (the owner's click).
  for (const f of ["omega.risk_pct", "omega.max_positions", "omega.max_daily_loss_pct"]) assert.equal(Object.hasOwn(DOCTRINE_BOUNDS, f), false, f);
  assert.deepEqual(DOCTRINE_BOUNDS["omega.risk_pct_conservative"], { kind: "number", min: 0.1, max: 5 });
  assert.deepEqual(DOCTRINE_BOUNDS["omega.max_positions_safe"], { kind: "integer", min: 1, max: 1 });
  const pack = await omegaPolicy({});
  assert.equal(pack.version, OMEGA_POLICY_VERSION);
  assert.equal(pack.doctrine_sha, CANON.content_sha256);
  assert.deepEqual(pack.values, canon.values);
  assert.doesNotMatch(JSON.stringify(pack), /\d{4}\.\d/, "no price");
});

test("an executed proposal reads executed and no longer holds the 7-day cooldown; one still pending or refused does", async () => {
  resetDoctrineSchemaCacheForTests();
  const db = d1();
  const changed = { "decision.quorum_min_intraday": 0.55 };
  const facts = async (at) => {
    await storeFacts(db, report(at - 2 * H, { nexus: changed }), { now: at - 2 * H });
    await storeFacts(db, report(at - 10 * 60_000, { nexus: changed }), { now: at - 10 * 60_000 });
  };
  const k = kernel();
  const env = { AETHER_DB: db, AGENTS: k };
  await facts(NOW);
  const first = await runCouncil(env, { now: NOW });
  assert.deepEqual(first.proposals.map((p) => p.status), ["pending_owner"]);
  // The next day, the owner has not decided: the same values are not asked again.
  await facts(NOW + 24 * H);
  const waiting = await runCouncil(env, { now: NOW + 24 * H });
  assert.deepEqual(waiting.proposals.map((p) => [p.status, p.detail]), [["skipped", "proposed within 7 days (pending_owner)"]]);
  assert.equal(k.proposals.length, 1);
  // The owner executes it in Cerebrum, but against a canon the doctrine has since moved past (a canon
  // change drops every live amendment): the hourly sync marks the proposal executed all the same.
  const id = k.proposals[0].id;
  k.amendments.push({ amendment_id: id, rule: "engine_thresholds", action: "amend_doctrine", values: changed, previous: {}, canon: "000000000000", session: first.session, executed_by: `owner via consensus:${id}`, executed_at: new Date(NOW + 25 * H).toISOString() });
  const s = await syncAmendments(env, { now: NOW + 26 * H });
  assert.deepEqual([s.applied, s.marked], [1, 1]);
  assert.equal((await db.prepare("SELECT status FROM council_proposals WHERE proposal_id = ?").bind(id).first()).status, "executed");
  assert.equal((await syncAmendments(env, { now: NOW + 27 * H })).marked, 0, "idempotent");
  // The drift is still there (the amendment is not in force on this canon): the council asks again.
  await facts(NOW + 48 * H);
  const again = await runCouncil(env, { now: NOW + 48 * H });
  assert.deepEqual(again.proposals.map((p) => p.status), ["pending_owner"]);
  assert.equal(k.proposals.length, 2);
  // Refused stays in the cooldown.
  await db.prepare("UPDATE council_proposals SET status = 'rejected' WHERE proposal_id = ?").bind(k.proposals[1].id).run();
  await facts(NOW + 72 * H);
  const refused = await runCouncil(env, { now: NOW + 72 * H });
  assert.deepEqual(refused.proposals.map((p) => p.detail), ["proposed within 7 days (rejected)"]);
});

test("consensus.status: rejected, expired and executed are stored; not_found and pending_owner change nothing; expired lifts the cooldown, rejected keeps it", async () => {
  resetDoctrineSchemaCacheForTests();
  const db = d1();
  const changed = { "decision.quorum_min_intraday": 0.55 };
  const facts = async (at) => {
    await storeFacts(db, report(at - 2 * H, { nexus: changed }), { now: at - 2 * H });
    await storeFacts(db, report(at - 10 * 60_000, { nexus: changed }), { now: at - 10 * 60_000 });
  };
  const k = kernel({ statuses: {} });
  const env = { AETHER_DB: db, AGENTS: k };
  await facts(NOW);
  const first = await runCouncil(env, { now: NOW });
  const id = first.proposals[0].proposal_id;
  assert.deepEqual(first.statuses, { status: "ok", open: 0, read: 0, updated: 0 }, "nothing open yet: no call");
  assert.equal(k.statusCalls.length, 0);
  const rowStatus = async (pid = id) => (await db.prepare("SELECT status FROM council_proposals WHERE proposal_id = ?").bind(pid).first()).status;
  // Unknown to the platform (not_found): fail closed, the row and its cooldown stay.
  await facts(NOW + 24 * H);
  const unknown = await runCouncil(env, { now: NOW + 24 * H });
  assert.deepEqual(unknown.statuses, { status: "ok", open: 1, read: 1, updated: 0 });
  assert.deepEqual(unknown.proposals.map((p) => p.detail), ["proposed within 7 days (pending_owner)"]);
  // Still pending_owner, even past its expires_at: nothing changes until the platform's sweep says expired.
  k.statuses[id] = "pending_owner";
  await facts(NOW + 48 * H);
  assert.deepEqual((await runCouncil(env, { now: NOW + 48 * H })).proposals.map((p) => p.detail), ["proposed within 7 days (pending_owner)"]);
  assert.equal(await rowStatus(), "pending_owner");
  // The owner's window closed without a decision: expired is stored and the same values are asked again.
  k.statuses[id] = "expired";
  await facts(NOW + 72 * H);
  const asked = await runCouncil(env, { now: NOW + 72 * H });
  assert.deepEqual(asked.statuses, { status: "ok", open: 1, read: 1, updated: 1 });
  assert.equal(await rowStatus(), "expired");
  assert.deepEqual(asked.proposals.map((p) => p.status), ["pending_owner"], "expired does not hold the cooldown");
  assert.equal(k.proposals.length, 2);
  // The owner refuses the second one: rejected is stored and holds the cooldown.
  const second = asked.proposals[0].proposal_id;
  k.statuses[second] = "rejected";
  await facts(NOW + 96 * H);
  const refused = await runCouncil(env, { now: NOW + 96 * H });
  assert.equal(await rowStatus(second), "rejected");
  assert.deepEqual(refused.proposals.map((p) => p.detail), ["proposed within 7 days (rejected)"]);
  // A final row is never read again, and never overwritten.
  k.statuses[id] = "pending_owner";
  k.statuses[second] = "executed";
  const again = await syncProposalStatuses(env, db, { now: NOW + 97 * H });
  assert.deepEqual(again, { status: "ok", open: 0, read: 0, updated: 0 });
  assert.deepEqual([await rowStatus(), await rowStatus(second)], ["expired", "rejected"]);
  // executed through consensus.status is stored too (the hourly doctrine sync still applies the amendment).
  await db.prepare("INSERT INTO council_proposals (session_id, rule_id, action, values_json, proposal_id, status, detail, created_at) VALUES ('kc_x', 'r', 'amend_doctrine', '{}', 'cns_x', 'pending_owner', NULL, ?)").bind(new Date(NOW).toISOString()).run();
  k.statuses.cns_x = "executed";
  assert.equal((await syncProposalStatuses(env, db, { now: NOW + 98 * H })).updated, 1);
  assert.equal(await rowStatus("cns_x"), "executed");
});

test("consensus.status reads at most 50 ids a call; an answer for an id not asked is ignored", async () => {
  resetDoctrineSchemaCacheForTests();
  const db = d1();
  const k = kernel({ statuses: {} });
  const env = { AETHER_DB: db, AGENTS: k };
  await runCouncil({ AETHER_DB: db, KNOWLEDGE_COUNCIL: "off" }, { now: NOW });
  await syncAmendments(env, { now: NOW }); // the schema
  const ids = Array.from({ length: 2 * STATUS_BATCH_MAX + 3 }, (_, i) => `cns_${String(i).padStart(4, "0")}`);
  for (const pid of ids) await db.prepare("INSERT INTO council_proposals (session_id, rule_id, action, values_json, proposal_id, status, detail, created_at) VALUES ('kc_x', 'r', 'amend_doctrine', '{}', ?, 'pending_owner', NULL, ?)").bind(pid, new Date(NOW).toISOString()).run();
  // Rows that never reached the platform (no id) or are already final are not read.
  await db.prepare("INSERT INTO council_proposals (session_id, rule_id, action, values_json, proposal_id, status, detail, created_at) VALUES ('kc_x', 'r', 'amend_doctrine', '{}', NULL, 'denied', 'x', ?)").bind(new Date(NOW).toISOString()).run();
  for (const pid of ids.filter((_, i) => i % 2 === 0)) k.statuses[pid] = "expired";
  const r = await syncProposalStatuses(env, db, { now: NOW });
  assert.equal(STATUS_BATCH_MAX, 50);
  assert.deepEqual(k.statusCalls.map((c) => c.length), [50, 50, 3]);
  assert.deepEqual(k.statusCalls.flat(), ids, "each open id once, in order");
  assert.deepEqual(r, { status: "ok", open: 103, read: 103, updated: 52 });
  // A reply that names an id this call did not ask for changes nothing.
  const rogue = { AETHER_DB: db, AGENTS: { async syscall() { return { outcome: "succeeded", result: { proposals: [{ proposal_id: "cns_other", status: "rejected" }, { proposal_id: ids[1], status: "bogus" }] } }; } } };
  assert.deepEqual(await syncProposalStatuses(rogue, db, { now: NOW }), { status: "ok", open: 51, read: 1, updated: 0 });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM council_proposals WHERE status = 'pending_owner'").first()).n, 51);
});

test("consensus.status denied (not granted yet): no change to any row or the cooldown, and a 6-hour backoff like corrections.read", async () => {
  resetDoctrineSchemaCacheForTests();
  const db = d1();
  const changed = { "decision.quorum_min_intraday": 0.55 };
  const facts = async (at) => {
    await storeFacts(db, report(at - 2 * H, { nexus: changed }), { now: at - 2 * H });
    await storeFacts(db, report(at - 10 * 60_000, { nexus: changed }), { now: at - 10 * 60_000 });
  };
  let calls = 0;
  const k = kernel(); // consensus.status is denied, as before the census grants it
  const counting = { async syscall(a, c, i) { if (c === "consensus.status") calls++; return k.syscall(a, c, i); } };
  const env = { AETHER_DB: db, AGENTS: counting };
  await facts(NOW);
  await runCouncil(env, { now: NOW });
  await facts(NOW + 24 * H);
  const denied = await runCouncil(env, { now: NOW + 24 * H });
  assert.deepEqual([denied.statuses.status, denied.statuses.reason, denied.statuses.updated], ["denied", "not granted", 0]);
  assert.deepEqual(denied.proposals.map((p) => p.detail), ["proposed within 7 days (pending_owner)"], "the cooldown is unchanged");
  assert.equal(calls, 1);
  const until = Number((await db.prepare("SELECT value FROM aether_meta WHERE key = 'council_status_backoff_until'").first()).value);
  assert.equal(until, NOW + 24 * H + STATUS_DENIAL_BACKOFF_MS);
  assert.equal(STATUS_DENIAL_BACKOFF_MS, 6 * H);
  // Inside the backoff: no call.
  const held = await syncProposalStatuses(env, db, { now: NOW + 25 * H });
  assert.deepEqual([held.status, calls], ["backoff", 1]);
  // After it, once granted: read again.
  const pid = (await db.prepare("SELECT proposal_id FROM council_proposals WHERE proposal_id IS NOT NULL").first()).proposal_id;
  k.statuses = { [pid]: "rejected" };
  const back = await syncProposalStatuses(env, db, { now: NOW + 31 * H });
  assert.deepEqual([back.status, back.updated, calls], ["ok", 1, 2]);
  // A failure (not a denial) writes no backoff and changes nothing.
  const db2 = d1();
  resetDoctrineSchemaCacheForTests();
  await syncAmendments({ AETHER_DB: db2 }, { now: NOW });
  await db2.prepare("INSERT INTO council_proposals (session_id, rule_id, action, values_json, proposal_id, status, detail, created_at) VALUES ('kc_x', 'r', 'amend_doctrine', '{}', 'cns_y', 'pending_owner', NULL, ?)").bind(new Date(NOW).toISOString()).run();
  const boom = await syncProposalStatuses({ AGENTS: { async syscall() { throw new Error("kernel down"); } } }, db2, { now: NOW });
  assert.deepEqual([boom.status, boom.updated], ["failed", 0]);
  assert.equal(await db2.prepare("SELECT value FROM aether_meta WHERE key = 'council_status_backoff_until'").first(), null);
  assert.equal((await syncProposalStatuses({}, db2, { now: NOW })).status, "unavailable", "no kernel binding");
});
