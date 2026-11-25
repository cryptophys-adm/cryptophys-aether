// AE2 (owner 2026-11-23, relayed by the coordinator: "Setuju ketiganya", "Versi netral", "Sebelum parity", "Council naik,
// auto mati"): the canon rule mizan_witness, its bounds mirrored from the platform's PF2, and the text of the
// parity_trust_only exception, which stays off until the owner's amend_constitution click.
import test from "node:test";
import assert from "node:assert/strict";
import { CANON } from "../src/canon.generated.mjs";
import { MIZAN_BOUNDS, OWNER_RAISED_FACTS, DOCTRINE_BOUNDS, boundProblem, councilReview, effectiveDoctrine, validateFacts, FACTS_SCHEMA, canonShort } from "../src/doctrine.mjs";

const NOW = Date.parse("2026-12-15T03:52:00Z");
const H = 3_600_000;
const MODES = ["scalp", "intraday", "swing", "range"];
const ruleOf = (id) => CANON.doctrine.rules.find((r) => r.id === id);

function canonFacts() {
  const nexus = {}, omega = {};
  for (const r of CANON.doctrine.rules) for (const a of r.anchors) (a.fact.startsWith("omega.") ? omega : nexus)[a.fact] = structuredClone(a.value);
  return { nexus, omega };
}
const report = (at, nexus = {}, drop = []) => {
  const base = canonFacts();
  const facts = { ...base.nexus, ...nexus };
  for (const f of drop) delete facts[f];
  return { schema: FACTS_SCHEMA, measured_at: new Date(at).toISOString(), seats: { nexus: { version_id: "v-1", facts }, omega: { version_id: "v-1", facts: base.omega } } };
};
const seatsOf = (p) => ({ received_at: p.measured_at, measured_at: p.measured_at, seats: validateFacts(p, { now: NOW }).seats });
const asRules = (applied = []) => effectiveDoctrine(applied).map((r) => ({ ...r, template: ruleOf(r.id).template, anchors: r.anchors.map((a) => ({ fact: a.fact, format: a.format, value: a.value })) }));
const review = (nexus, drop = []) => councilReview({ rules: asRules(), latest: seatsOf(report(NOW, nexus, drop)), previous: seatsOf(report(NOW - H, nexus, drop)), session: "kc_x-1" });

test("MW1. the mizan.* bounds are the platform's PF2 bounds, each a doctrine bound", () => {
  const expected = {
    ...Object.fromEntries(MODES.map((m) => [`mizan.de_weight_${m}`, { kind: "number", min: 0, max: 0.04 }])),
    "mizan.score_floor": { kind: "number", min: 0.4, max: 0.6 },
    "mizan.score_window": { kind: "integer", min: 50, max: 200 },
    "mizan.min_readings": { kind: "integer", min: 20, max: 100 }
  };
  assert.deepEqual(MIZAN_BOUNDS, expected);
  for (const [f, b] of Object.entries(expected)) assert.deepEqual(DOCTRINE_BOUNDS[f], b, f);
  assert.ok(!Object.hasOwn(DOCTRINE_BOUNDS, "parity.mizan_before_parity"), "the parity exception has no bound: only the owner moves it");
});

test("MW2. the canon rule mizan_witness: operational, one anchor per bound, each at its start inside its bound, no price", () => {
  const rule = ruleOf("mizan_witness");
  assert.ok(rule && rule.class === "operational");
  assert.deepEqual(rule.anchors.map((a) => a.fact).sort(), Object.keys(MIZAN_BOUNDS).sort());
  const start = Object.fromEntries(rule.anchors.map((a) => [a.fact, a.value]));
  for (const m of MODES) assert.equal(start[`mizan.de_weight_${m}`], 0.02, m);
  assert.deepEqual([start["mizan.score_floor"], start["mizan.score_window"], start["mizan.min_readings"]], [0.45, 100, 40]);
  for (const a of rule.anchors) assert.equal(boundProblem(a.fact, a.value), null, a.fact);
  assert.match(rule.rule, /never reads the action label/);
  assert.match(rule.rule, /Markov and dollar dials neutral/);
  assert.match(rule.rule, /drops its weight to 0 in every mode at once/);
  assert.doesNotMatch(rule.rule, /\d{4}\.\d|price level/i, "no price in the rule");
  assert.doesNotMatch(Object.keys(MIZAN_BOUNDS).join(" "), /trad(e|ing)\b|order|wallet|withdraw|transfer|swap/, "the platform's prohibited filter");
});

test("MW3. the Knowledge Council amends a Mizan weight inside 0-0.04 as routine; outside it the Aether seat refuses", () => {
  const raised = review({ "mizan.de_weight_swing": 0.04 }).find((r) => r.rule === "mizan_witness");
  assert.equal(raised.status, "propose");
  assert.equal(raised.action, "amend_doctrine");
  assert.deepEqual(raised.proposal.params.values, { "mizan.de_weight_swing": 0.04 });
  const floored = review({ "mizan.de_weight_scalp": 0 }).find((r) => r.rule === "mizan_witness");
  assert.equal(floored.status, "propose", "0 is the floor the witness drops to");
  const wild = review({ "mizan.de_weight_intraday": 0.05, "mizan.score_window": 250 }).find((r) => r.rule === "mizan_witness");
  assert.equal(wild.status, "refused");
  assert.match(wild.reasons.join(" "), /outside 0-0.04/);
  assert.match(wild.reasons.join(" "), /outside 50-200/);
});

test("MW4. the parity exception is canon text that stays off; a report never raises the owner's click", () => {
  const rule = ruleOf("parity_trust_only");
  assert.equal(rule.class, "constitutional");
  const a = rule.anchors.find((x) => x.fact === "parity.mizan_before_parity");
  assert.deepEqual(a, { fact: "parity.mizan_before_parity", value: false, format: "bool" }, "not applied: off in the canon");
  assert.match(rule.rule, /Mizan witness voting before its parity \(off\): when on, it votes while its parity group runs alongside, and a mismatch freezes its weight at 0 until 24 consecutive candles match again\./);
  assert.ok(rule.rule.startsWith("Local engine trust comes only from the autonomous parity registry (24 consecutive candles"), "the rule itself is unchanged");
  assert.deepEqual(OWNER_RAISED_FACTS, ["parity.mizan_before_parity"]);
  // xauusd reports false until the amendment is in force: in sync, nothing proposed.
  assert.equal(review({ "parity.mizan_before_parity": false }).find((r) => r.rule === "parity_trust_only").status, "in_sync");
  // A report of true without the amendment is the code acting ahead of the owner: refused, never a proposal.
  const ahead = review({ "parity.mizan_before_parity": true }).find((r) => r.rule === "parity_trust_only");
  assert.equal(ahead.status, "refused");
  assert.equal(ahead.proposal, undefined);
  assert.match(ahead.reasons.join(" "), /raised only on the owner's request/);
  // Once Cerebrum executed the owner's amend_constitution, the doctrine in force says on, and a true report is in sync.
  const applied = [{ amendment_id: "cns_x", rule: "parity_trust_only", action: "amend_constitution", canon: canonShort(), values: { "parity.mizan_before_parity": true }, executed_at: "2026-12-15T04:00:00.000Z" }];
  const live = effectiveDoctrine(applied).find((r) => r.id === "parity_trust_only");
  assert.match(live.rule, /before its parity \(on\)/);
  assert.equal(live.amended.action, "amend_constitution");
  const rules = effectiveDoctrine(applied).map((r) => ({ ...r, template: ruleOf(r.id).template, anchors: r.anchors.map((x) => ({ fact: x.fact, format: x.format, value: x.value })) }));
  const on = { "parity.mizan_before_parity": true };
  const after = councilReview({ rules, latest: seatsOf(report(NOW, on)), previous: seatsOf(report(NOW - H, on)), session: "kc_x-1" }).find((r) => r.rule === "parity_trust_only");
  assert.equal(after.status, "in_sync");
});

test("MW5. until xauusd MZ1 reports the Mizan facts, both rules read unreported (AE2 merges with MZ1)", () => {
  const items = review({}, [...Object.keys(MIZAN_BOUNDS), "parity.mizan_before_parity"]);
  assert.equal(items.find((r) => r.rule === "mizan_witness").status, "unreported");
  assert.equal(items.find((r) => r.rule === "parity_trust_only").status, "unreported");
  const synced = review({});
  assert.equal(synced.find((r) => r.rule === "mizan_witness").status, "in_sync");
  assert.equal(synced.find((r) => r.rule === "parity_trust_only").status, "in_sync");
});
