// xauusd's self-trained baseline model (owner 2026-11-13: "strengthen autonomous learning & knowledge
// looping"): its report is kept as knowledge and shown on the Aether page; never a price.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { modelReportProblems, storeModelReport, latestModelReport, modelSummary, resetModelSchemaCacheForTests, MODEL_REPORT_SCHEMA } from "../src/model.mjs";
import { aetherOverview } from "../src/reader.mjs";

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

/** A report as xauusd's modelReport (src/model-baseline.mjs) produces it. */
const REPORT = {"schema":"cryptophys.model-report.v1","generated_at":"2026-11-13T01:00:00.000Z","model_id":"baseline@2026-11-13T01:00Z","rows":300,"label_sets":["tight","wide"],"walk_forward":{"tight_long":{"train":210,"n":90,"hit_rate":0.5556,"brier":0.192,"brier_base":0.2486,"skill":0.2276,"auc":0.781,"picked":44,"picked_hit_rate":0.7727,"picked_mean_r":0.9318,"all_mean_r":0.3889,"top_features":[{"feature":"w_h1_lean","weight":1.2947},{"feature":"noise","weight":-0.2449}]},"tight_short":{"train":210,"n":90,"hit_rate":0.4444,"brier":0.192,"brier_base":0.2486,"skill":0.2276,"auc":0.781,"picked":46,"picked_hit_rate":0.6522,"picked_mean_r":0.6304,"all_mean_r":0.1111,"top_features":[{"feature":"w_h1_lean","weight":-1.2947},{"feature":"noise","weight":0.2449}]}},"prospective":{"tight_long":{"n":300,"brier":0.163,"brier_base":0.2493,"skill":0.3462,"auc":0.8387,"picked":158,"picked_mean_r":0.9778,"all_mean_r":0.3167},"tight_short":{"n":300,"brier":0.163,"brier_base":0.2493,"skill":0.3462,"auc":0.8387,"picked":142,"picked_mean_r":0.919,"all_mean_r":0.1833}}};

test("M1. a model report from xauusd is accepted; a price, a weights table or a bad shape is refused", () => {
  assert.equal(REPORT.schema, MODEL_REPORT_SCHEMA);
  assert.deepEqual(modelReportProblems(REPORT), []);
  const bad = (patch) => modelReportProblems({ ...structuredClone(REPORT), ...patch });
  assert.ok(bad({ schema: "x" }).includes("unsupported_schema"));
  assert.ok(bad({ model_id: "anything" }).includes("model_id_invalid"));
  assert.ok(bad({ walk_forward: { other_model: {} } }).includes("walk_forward_invalid"));
  const withPrice = structuredClone(REPORT); withPrice.walk_forward.tight_long.price = 3880;
  assert.ok(modelReportProblems(withPrice).some((p) => p.startsWith("forbidden_key") || p.includes("price")));
  const withWeights = structuredClone(REPORT); withWeights.weights = [1, 2];
  assert.ok(modelReportProblems(withWeights).some((p) => p.startsWith("forbidden_key")));
  const badFeature = structuredClone(REPORT); badFeature.walk_forward.tight_long.top_features = [{ feature: "Entry Price!", weight: 1 }];
  assert.ok(modelReportProblems(badFeature).some((p) => p.endsWith("top_features_invalid")));
  assert.deepEqual(modelReportProblems(null), ["not_an_object"]);
});

test("M2. the latest report is kept and the Aether page shows each model's skill and top features", async () => {
  resetModelSchemaCacheForTests();
  const db = d1();
  assert.deepEqual(await storeModelReport(db, { schema: "x" }), { accepted: false, reason: "unsupported_schema, generated_at_invalid, model_id_invalid, rows_invalid, walk_forward_invalid" });
  assert.deepEqual(await storeModelReport(db, REPORT, { now: Date.parse("2026-11-13T01:01:00Z") }), { accepted: true, models: 2 });
  const later = { ...structuredClone(REPORT), model_id: "baseline@2026-11-13T02:00Z", generated_at: "2026-11-13T02:00:00.000Z" };
  await storeModelReport(db, later);
  const latest = await latestModelReport(db);
  assert.equal(latest.report.model_id, "baseline@2026-11-13T02:00Z", "only the latest is kept");
  const s = modelSummary(latest);
  assert.equal(s.models[0].id, "tight_long");
  assert.ok(s.models[0].walk_forward.skill > 0 && s.models[0].prospective.n > 0);
  assert.deepEqual(s.models[0].top_features, ["w_h1_lean", "noise"]);
  assert.equal(modelSummary(null), null);
  const overview = await aetherOverview({ AETHER_DB: db });
  assert.equal(overview.model.model_id, "baseline@2026-11-13T02:00Z");
});

test("M3. the gate state, its rules and the live notes are kept for Cerebrum; a note's text or a bad state is refused", async () => {
  resetModelSchemaCacheForTests();
  const db = d1();
  const report = { ...structuredClone(REPORT), promotion: { status: "not_promoted", set: null, reason: "tight: long: 120 of 300 decisions", since: null }, gate: { min_n: 300, alpha: 0.05, min_auc: 0.55 },
    live_notes: [{ item_id: "k-role-risk-calibration-talk", version: 1, status: "live", agents: ["risk"], chart: "60", promoted_at: "2026-11-20T01:00:00.000Z", retired_at: null, reason: null }] };
  report.prospective.tight_long.p_value = 0.004;
  assert.deepEqual(modelReportProblems(report), []);
  assert.ok(modelReportProblems({ ...report, promotion: { status: "maybe" } }).includes("promotion_invalid"));
  assert.ok(modelReportProblems({ ...report, live_notes: [{ ...report.live_notes[0], text: "a note" }] }).includes("live_notes_invalid"));
  assert.ok(modelReportProblems({ ...report, live_notes: [{ ...report.live_notes[0], agents: ["Risk Manager"] }] }).includes("live_notes_invalid"));
  await storeModelReport(db, report);
  const s = modelSummary(await latestModelReport(db));
  assert.equal(s.promotion.status, "not_promoted");
  assert.equal(s.gate.min_n, 300);
  assert.equal(s.live_notes[0].agents[0], "risk");
  assert.equal(s.models[0].prospective.p_value, 0.004);
  // An older report without them still reads.
  await storeModelReport(db, structuredClone(REPORT));
  assert.deepEqual(modelSummary(await latestModelReport(db)).live_notes, []);
});
