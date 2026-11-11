import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCanon, renderModule, CANON_FILES, GENERATED_PATH } from "../scripts/build-canon.mjs";
import { CANON } from "../src/canon.generated.mjs";

test("the canon bundle is up to date with canon/*.json", () => {
  assert.equal(readFileSync(new URL("../" + GENERATED_PATH, import.meta.url), "utf8"), renderModule(), "stale: run node scripts/build-canon.mjs --write");
});

test("the canon has its four parts and a content hash over every file", () => {
  const c = buildCanon();
  assert.deepEqual(c.files.map((f) => f.path), [...CANON_FILES]);
  assert.match(c.content_sha256, /^[a-f0-9]{64}$/);
  assert.equal(CANON.content_sha256, c.content_sha256);
  assert.equal(c.indicator.kb_version, 4);
  assert.equal(c.indicator.kb_content_sha256, "0e23c15b9c1d044638441aca1c82af119b46f0fbd43cca194c75a07f907e245e", "KB v4 is imported as is (xauusd 2026-11-09: the room quorum, its automatic weighting per timeframe and regime), pinned by its hash");
});

test("the doctrine carries the owner rules the guardian checks, each with a source", () => {
  const ids = CANON.doctrine.rules.map((r) => r.id);
  for (const id of ["execution_boundary", "no_levels_to_kernel", "decision_engine_ssot", "engine_thresholds", "confirmation_required", "h1_quorum", "calibration_status_once", "own_data_only", "promotion_by_owner", "weighting_auto", "independent_rooms", "learned_is_not_canon", "kernel_rules", "doctrine_protocol", "event_caution", "omega_execution_gates"]) assert.ok(ids.includes(id), id);
  assert.ok(CANON.doctrine.rules.every((r) => r.rule && r.source && r.since));
  assert.equal(new Set(ids).size, ids.length);
});

test("doctrine v2 (audit 2026-11-11): classes, anchors, templates that render the rule, retired rules out of force", async () => {
  const { renderRule, boundProblem, DOCTRINE_BOUNDS } = await import("../src/doctrine.mjs");
  assert.equal(CANON.doctrine.version, "aether.canon.doctrine.v2");
  for (const r of CANON.doctrine.rules) {
    assert.ok(["constitutional", "operational"].includes(r.class), r.id);
    assert.equal(renderRule(r.template, r.anchors), r.rule, `${r.id}: the rule is its template with the anchored values`);
    for (const a of r.anchors) {
      assert.match(a.fact, /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, a.fact);
      if (Object.hasOwn(DOCTRINE_BOUNDS, a.fact)) assert.equal(boundProblem(a.fact, a.value), null, `${r.id}: ${a.fact} sits inside its hard bound`);
    }
    // The Policy Engine refuses consensus resources that look like trading: a rule id must never.
    assert.doesNotMatch(r.id, /trad(e|ing)|order|wallet|withdraw|transfer|swap/, r.id);
  }
  const retired = CANON.doctrine.retired.map((r) => r.id);
  assert.deepEqual(retired.sort(), ["advisory_only", "no_confirmation_no_entry"]);
  for (const id of retired) assert.ok(!CANON.doctrine.rules.some((r) => r.id === id), `${id} is out of force`);
  for (const r of CANON.doctrine.retired) assert.ok(CANON.doctrine.rules.some((x) => x.id === r.superseded_by), `${r.id} is superseded by a rule in force`);
  const text = CANON.doctrine.rules.map((r) => r.rule).join(" ");
  assert.doesNotMatch(text, /Retired for the rooms|may execute the H1 decision/, "the obsolete wording is gone");
});

test("roles and definitions: every room agent has a role; the yardsticks are fixed", () => {
  const agents = CANON.roles.agents;
  for (const id of ["prophet", "decision_matrix", "grid_bot_protocol", "supertrend", "order_blocks", "h1", "htf", "news", "technical", "risk", "moderator"]) assert.ok(agents.some((a) => a.id === id), id);
  assert.equal(CANON.definitions.outcome_scoring.horizon_candles, 4);
  assert.equal(CANON.definitions.shadow_promotion.alpha, 0.05);
  assert.equal(CANON.definitions.parity.consecutive_matches, 24);
  assert.ok(CANON.definitions.decision_card.never_present.includes("entry_price"));
});
