// The Positioning & Liquidity analyst (xauusd docs/RFC_POSITIONING_LIQUIDITY.md, owner breakglass 2026-11-20): the
// knobs' hard bounds, the canon rule that anchors them, KnowledgeIngress.lensPolicy() and ingestLensReport().
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CANON } from "../src/canon.generated.mjs";
import { LENS_BOUNDS, DOCTRINE_BOUNDS, LENS_POLICY_VERSION, lensPolicy, lensPolicyOf, boundProblem, effectiveDoctrine } from "../src/doctrine.mjs";
import { LENS_REPORT_SCHEMA, lensReportProblems, storeLensReport, latestLensReport, resetLensSchemaCacheForTests } from "../src/lens.mjs";

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
// A report as xauusd's lensReport() builds it (src/lens-policy.mjs, generated there; one lens at its floor).
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures-lens-report.json", import.meta.url), "utf8"));
const MODES = ["scalp", "intraday", "swing", "range"];

test("LB1. 48 lens knobs, each a doctrine bound; the canon rule anchors every one inside its bound", () => {
  const facts = Object.keys(LENS_BOUNDS);
  assert.equal(facts.length, 48);
  assert.equal(facts.filter((f) => MODES.some((m) => f.endsWith(`_${m}`))).length, 44);
  for (const f of facts) assert.deepEqual(DOCTRINE_BOUNDS[f], LENS_BOUNDS[f], f);
  assert.deepEqual([DOCTRINE_BOUNDS["positioning.de_weight_swing"], DOCTRINE_BOUNDS["liquidity.council_weight_scalp"], DOCTRINE_BOUNDS["liquidity.profile_window_min_swing"]],
    [{ kind: "number", min: 0.02, max: 0.1 }, { kind: "number", min: 0, max: 0.8 }, { kind: "integer", min: 2880, max: 14400 }]);
  // Every bound sits under the doctrine's 0.30 for one witness.
  for (const m of MODES) assert.ok(LENS_BOUNDS[`positioning.de_weight_${m}`].max <= 0.3);
  const rule = CANON.doctrine.rules.find((r) => r.id === "lens_positioning_liquidity");
  assert.ok(rule && rule.class === "operational");
  assert.deepEqual(rule.anchors.map((a) => a.fact).sort(), [...facts].sort(), "one anchor per knob");
  for (const a of rule.anchors) assert.equal(boundProblem(a.fact, a.value), null, a.fact);
  assert.doesNotMatch(facts.join(" "), /trad(e|ing)\b|order|wallet|withdraw|transfer|swap/, "the platform's prohibited filter");
  assert.doesNotMatch(rule.rule, /\d{4}\.\d|price level/i, "no price in the rule");
});

test("LB2. lensPolicy(): the anchors in force by fact name and the doctrine's sha; an executed amendment moves one, an out-of-bound value is left out", async () => {
  const pack = await lensPolicy({});
  assert.equal(pack.version, LENS_POLICY_VERSION);
  assert.equal(pack.doctrine_sha, CANON.content_sha256);
  assert.equal(Object.keys(pack.values).length, 48);
  assert.deepEqual([pack.values["positioning.de_weight_scalp"], pack.values["positioning.de_weight_swing"], pack.values["liquidity.council_weight_scalp"], pack.values["liquidity.score_window"]], [0.02, 0.05, 0.4, 100]);
  assert.deepEqual(pack.amended, {});
  // An amendment Cerebrum executed: the value moves and says so.
  const applied = [{ amendment_id: "am-1", rule: "lens_positioning_liquidity", canon: String(CANON.content_sha256).slice(0, 12), values: { "positioning.de_weight_swing": 0.07 }, executed_at: "2026-11-21T03:00:00.000Z" }];
  const moved = lensPolicyOf(effectiveDoctrine(applied));
  assert.equal(moved.values["positioning.de_weight_swing"], 0.07);
  assert.deepEqual(moved.amended["positioning.de_weight_swing"], { from: 0.05, amendment_id: "am-1", executed_at: "2026-11-21T03:00:00.000Z" });
  assert.equal(moved.values["positioning.de_weight_scalp"], 0.02, "the others stay at their anchors");
  // A value outside its bound never leaves Aether.
  const bad = lensPolicyOf([{ anchors: [{ fact: "positioning.de_weight_swing", value: 0.3 }, { fact: "liquidity.thin_pctl_scalp", value: 0.1 }, { fact: "omega.risk_pct", value: 0.5 }] }]);
  assert.deepEqual(bad.values, { "liquidity.thin_pctl_scalp": 0.1 }, "out of bound and non-lens facts are left out");
});

test("LR1. ingestLensReport: xauusd's report is stored and read back; the latest wins", async () => {
  resetLensSchemaCacheForTests();
  const db = d1();
  assert.equal(FIXTURE.schema, LENS_REPORT_SCHEMA);
  assert.deepEqual(lensReportProblems(FIXTURE), []);
  assert.deepEqual(await storeLensReport(db, FIXTURE, { now: Date.parse("2026-11-20T11:00:05Z") }), { accepted: true });
  const later = { ...FIXTURE, generated_at: "2026-11-21T11:00:00.000Z" };
  await storeLensReport(db, later, { now: Date.parse("2026-11-21T11:00:05Z") });
  // A delayed retry of an older report must not replace newer state.
  await storeLensReport(db, FIXTURE, { now: Date.parse("2026-11-21T11:05:00Z") });
  const got = await latestLensReport(db);
  assert.equal(got.report.generated_at, later.generated_at);
  assert.equal(got.received_at, "2026-11-21T11:00:05.000Z");
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM lens_reports").get().n, 1);
  assert.deepEqual(await storeLensReport(null, FIXTURE), { accepted: false, reason: "unavailable" });
});

test("LR2. refused: a wrong schema, a price-like key at any depth, a weight outside 0-1, an unknown lens or mode, too large", () => {
  const clone = () => JSON.parse(JSON.stringify(FIXTURE));
  assert.deepEqual(lensReportProblems(null), ["not_an_object"]);
  assert.ok(lensReportProblems({ ...clone(), schema: "x" }).includes("unsupported_schema"));
  const priced = clone(); priced.lenses.liquidity.price = 4101.25;
  assert.ok(lensReportProblems(priced).includes("forbidden_key:report.lenses.liquidity.price"));
  const deep = clone(); deep.lenses.positioning.score.kinds = { reading_4h: { hits: 1, misses: 0, level: 3 } };
  assert.ok(lensReportProblems(deep).some((p) => p.startsWith("forbidden_key:") && p.endsWith(".level")));
  const heavy = clone(); heavy.lenses.positioning.weights.swing.weight = 1.5;
  assert.ok(lensReportProblems(heavy).includes("weights_invalid:positioning"));
  const mode = clone(); mode.lenses.positioning.weights.weekly = { weight: 0.1, source: "anchor" };
  assert.ok(lensReportProblems(mode).includes("weights_invalid:positioning"));
  const missingMode = clone(); delete missingMode.lenses.positioning.weights.swing;
  assert.ok(lensReportProblems(missingMode).includes("weights_invalid:positioning"));
  const missingLens = clone(); delete missingLens.lenses.liquidity;
  assert.ok(lensReportProblems(missingLens).includes("lens_invalid:liquidity"));
  const lens = clone(); lens.lenses.sentiment = lens.lenses.positioning;
  assert.ok(lensReportProblems(lens).includes("lenses_invalid"));
  const big = clone(); big.lenses.positioning.note = "x".repeat(40_000);
  assert.ok(lensReportProblems(big).includes("too_large"));
  // A fair key with a price-like substring is not refused here (exact names; xauusd refuses on the wider rule).
  const slope = clone(); slope.lenses.positioning.slope_weeks = 3;
  assert.deepEqual(lensReportProblems(slope), []);
});
