import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ingestCards, resetSchemaCacheForTests } from "../src/store.mjs";
import { runCuration, learnedPack, syncReviews, resetKnowledgeSchemaCacheForTests } from "../src/knowledge.mjs";
import {
  WEIGHTING_REPORT_VERSION, pointProblems, reportProblems, storeWeightingReport, latestWeightingReport, weightingCandidate, resetWeightingSchemaCacheForTests
} from "../src/weighting.mjs";
import { CANON } from "../src/canon.generated.mjs";

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

const NOW = Date.parse("2026-12-10T12:00:00Z");
const H = 3_600_000;
const DEFAULT = { prior: 10, weight_range: [0.25, 2], days: 30, half_life_days: null, calibration_beta: 0, quorum_share: 0.5, regime_prior: null, high_vol_quorum_bonus: 0 };
const candidate = (changed, value, verdict, extra = {}) => ({
  id: `weighting@${changed}${value}`, changed, change: "x", params: { ...DEFAULT, [changed]: value }, verdict,
  discovery: { bars: 220, accuracy: 0.62, control_accuracy: 0.54, p_value: 0.004, p_holm: 0.03 }, holdout: { bars: 100, complete: true, accuracy: 0.6, control_accuracy: 0.55 }, ...extra
});
const report = (candidates) => ({
  version: WEIGHTING_REPORT_VERSION, equation: "cryptophys.weighting.v2", generated_at: new Date(NOW).toISOString(), window_days: 30, rooms: 320,
  active: { id: "weighting@default", params: DEFAULT, activated_at: null, change: "none" },
  agents: [{ agent: "prophet", family: "trend", weight: 1.2, accuracy: 0.6, calibration: 0.1, decisive: 40, n: 60 }],
  candidates, reverse: null, history: []
});

/** The kernel's knowledge-item text checks (cryptophys-cloud-platform workers/ai-kernel/src/knowledge.ts). */
function kernelTextErrors(item) {
  const errors = [];
  const PRICE = /\b(?:\d{1,2},\d{3}|\d{3,5})(?:\.\d+)?\b/;
  const ORDER = /\b(?:buy|sell)\s+(?:limit|stop)\b|\b(?:place|open|enter)\s+(?:an?\s+|the\s+)?(?:order|position)\b|\blots?\b|\blot size\b|\bposition siz(?:e|ing)\b|\b(?:stop[- ]loss|take[- ]profit|entry|target)\s+(?:at|of|to|near)\b/i;
  const FIELD_TALK = /\b[a-z]+_[a-z0-9_]+\b|\w+\s*=\s*\S|\bmeans\b|\bcode\s+\d+\s+is\b/i;
  const FORBIDDEN = ["entry", "entry_price", "stop", "stop_loss", "take_profit", "tp1", "tp2", "trade_plan", "plan", "key_levels", "zones", "levels", "close", "price", "atr", "position_size_pct", "lots", "size"];
  if (!item.text || item.text.length > 300) errors.push("text_length");
  if (PRICE.test(item.text)) errors.push("price");
  if (ORDER.test(item.text)) errors.push("order");
  if (FIELD_TALK.test(item.text)) errors.push("field_talk");
  const known = new Set();
  const walk = (v) => { if (typeof v === "number") { known.add(String(v)); if (v > 0 && v < 1) { known.add(String(Math.round(v * 100))); known.add(String(Math.round(v * 1000) / 10)); } } else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(item.evidence);
  const nums = item.text.match(/\d+(?:\.\d+)?/g) || [];
  for (const n of nums) if (!known.has(n)) errors.push(`number:${n}`);
  const keys = (v) => (Array.isArray(v) ? v.flatMap(keys) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
  for (const k of keys(item)) if (FORBIDDEN.includes(k)) errors.push(`key:${k}`);
  if (!/^k-[a-z0-9-]{1,40}$/.test(item.item_id)) errors.push("item_id");
  if (new Set(item.provenance.card_ids).size < 10) errors.push("cards");
  return errors;
}

test.beforeEach(() => { resetSchemaCacheForTests(); resetKnowledgeSchemaCacheForTests(); resetWeightingSchemaCacheForTests(); });

test("the report is checked like a card: version, a grid point as the active weighting, no price, level or size key", async () => {
  assert.deepEqual(pointProblems(DEFAULT), []);
  assert.ok(pointProblems({ ...DEFAULT, quorum_share: 0.9 }).includes("off_grid:quorum_share"));
  assert.deepEqual(reportProblems(report([])), []);
  assert.ok(reportProblems({ ...report([]), version: "x" }).includes("unsupported_version"));
  assert.ok(reportProblems({ ...report([]), agents: [{ agent: "a", price: 1 }] }).some((p) => p.startsWith("forbidden_key")));
  const db = d1();
  assert.equal((await storeWeightingReport(db, { ...report([]), version: "x" })).accepted, false);
  assert.equal((await storeWeightingReport(db, report([]), { now: NOW })).accepted, true);
  assert.equal((await latestWeightingReport(db)).report.rooms, 320);
});

test("the calibrator proposes the best better_than_active point with a complete holdout, in words the kernel accepts", () => {
  const cardIds = Array.from({ length: 24 }, (_, i) => `d:60:${NOW - i * H}:0`);
  const r = report([
    candidate("prior", 20, "not_better"),
    candidate("quorum_share", 0.6, "better_than_active: ready for approval in the Console", { discovery: { bars: 220, accuracy: 0.64, control_accuracy: 0.54, p_value: 0.001, p_holm: 0.01 } }),
    candidate("half_life_days", 7, "better_than_active: ready for approval in the Console"),
    candidate("calibration_beta", 1, "better_than_active: ready for approval in the Console", { holdout: { bars: 60, complete: false } })
  ]);
  const item = weightingCandidate(r, { cardIds, canon: CANON });
  assert.equal(item.kind, "param_candidate");
  assert.equal(item.params.family, "weighting");
  assert.deepEqual(item.params.values, { ...DEFAULT, quorum_share: 0.6 });
  assert.equal(item.item_id, "k-weighting-quorum-share-0-6");
  assert.match(item.text, /^Replayed over 30 days, the hourly quorum was right in 64% of its decided calls when an entry needs more than 60% of the weight, against 54% with the active weighting/);
  assert.match(item.text, /Approving activates it for the hourly decision; it rolls back if it does worse\.$/);
  assert.deepEqual(kernelTextErrors(item), []);
  for (const c of [candidate("weight_range", [0.5, 1.5], "better_than_active"), candidate("prior", 5, "better_than_active"), candidate("half_life_days", 14, "better_than_active"), candidate("days", 60, "better_than_active"), candidate("calibration_beta", 0.5, "better_than_active")]) {
    const it = weightingCandidate(report([c]), { cardIds, canon: CANON });
    assert.deepEqual(kernelTextErrors(it), [], c.id);
  }
  assert.equal(weightingCandidate(r, { cardIds, canon: CANON, pending: true }), null, "one open weighting proposal at a time");
  assert.equal(weightingCandidate(r, { cardIds: cardIds.slice(0, 5), canon: CANON }), null, "the kernel needs 10 cited cards");
  assert.equal(weightingCandidate(r, { cardIds, canon: CANON, proposed: new Set(["k-weighting-quorum-share-0-6"]) }).item_id, "k-weighting-half-life-days-7", "the next best");
  assert.equal(weightingCandidate(report([candidate("quorum_share", 0.9, "better_than_active")]), { cardIds, canon: CANON }), null, "off the grid");
});

function kernel() {
  const proposals = [];
  return {
    proposals,
    async syscall(agentId, capability, input) {
      if (capability === "knowledge.propose") {
        const p = { proposal_id: `knw_${String(proposals.length).padStart(8, "0")}-0000-4000-8000-000000000000`, agent: agentId, item_id: input.item.item_id, item_version: input.item.version, status: "pending", content_sha256: "a".repeat(64) };
        proposals.push(p);
        return { outcome: "succeeded", capability, result: { proposal: p } };
      }
      if (capability === "knowledge.status") return { outcome: "succeeded", capability, result: { proposals: proposals.filter((p) => p.agent === agentId) } };
      return { outcome: "denied", capability, reason: "not granted" };
    }
  };
}

test("runCuration proposes the weighting point once; once approved it is in the learned pack xauusd activates", async () => {
  const db = d1();
  const AGENTS = kernel();
  const env = { AETHER_DB: db, AGENTS };
  const cards = Array.from({ length: 30 }, (_, i) => ({ card_id: `d:60:${NOW - (30 - i) * H}:0`, version: "cryptophys.decision-card.v1", kind: "room_conclusion", chart: "60", bar_open: new Date(NOW - (30 - i) * H).toISOString(), session: "london", agents: [{ id: "prophet", stance: "WAIT" }, { id: "moderator", stance: "WAIT" }], compliance: [], outcomes: {}, stuck_open: [] }));
  await ingestCards(db, cards);
  await storeWeightingReport(db, report([candidate("quorum_share", 0.6, "better_than_active: ready for approval in the Console")]), { now: NOW });
  const first = await runCuration(env, { now: NOW });
  assert.equal(first.calibrator.proposed, 1);
  assert.equal(AGENTS.proposals[0].item_id, "k-weighting-quorum-share-0-6");
  const again = await runCuration(env, { now: NOW + 86_400_000 });
  assert.equal(again.calibrator.proposed, 0, "pending: not proposed twice");
  AGENTS.proposals[0].status = "approved";
  await syncReviews(env, { now: NOW + 2 * 86_400_000 });
  const pack = await learnedPack(env);
  const it = pack.items.find((x) => x.item_id === "k-weighting-quorum-share-0-6");
  assert.equal(it.params.family, "weighting");
  assert.deepEqual(it.params.values, { ...DEFAULT, quorum_share: 0.6 });
});

test("auto mode (owner decisions 2026-11-09): reports are kept per timeframe as an audit; the calibrator proposes nothing", async () => {
  const db = d1();
  const auto = (tf) => ({ ...report([candidate("quorum_share", 0.6, "better_than_active: activated automatically")]), mode: "auto", timeframe: tf, active: { id: "w", params: { prior: 10, weight_range: [0.25, 2], days: 30, half_life_days: null, calibration_beta: 0, quorum_share: 0.5, regime_prior: 10, high_vol_quorum_bonus: 0.05 } } });
  assert.equal((await storeWeightingReport(db, auto("240"), { now: NOW })).accepted, true, "regime keys on the reviewed grid");
  assert.equal((await storeWeightingReport(db, auto("60"), { now: NOW })).accepted, true);
  assert.equal((await storeWeightingReport(db, { ...auto("5"), timeframe: "5" })).accepted, false, "an unknown timeframe is refused");
  assert.equal((await latestWeightingReport(db, "240")).report.timeframe, "240");
  assert.equal(weightingCandidate(auto("60"), { cardIds: Array.from({ length: 12 }, (_, i) => `d:60:${NOW - i * H}:0`), canon: CANON }), null, "xauusd activates by itself");
});
