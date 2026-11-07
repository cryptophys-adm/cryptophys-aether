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
  assert.equal(c.indicator.kb_content_sha256, "651a3f0092424a95e0481a0b02783b7daa3cd1ac50fdd02d0b1d3f100d357ea1", "KB v4 is imported as is, pinned by its hash");
});

test("the doctrine carries the owner rules the guardian checks, each with a source", () => {
  const ids = CANON.doctrine.rules.map((r) => r.id);
  for (const id of ["advisory_only", "no_levels_to_kernel", "no_confirmation_no_entry", "calibration_status_once", "own_data_only", "promotion_by_owner", "learned_is_not_canon", "kernel_rules"]) assert.ok(ids.includes(id), id);
  assert.ok(CANON.doctrine.rules.every((r) => r.rule && r.source && r.since));
  assert.equal(new Set(ids).size, ids.length);
});

test("roles and definitions: every room agent has a role; the yardsticks are fixed", () => {
  const agents = CANON.roles.agents;
  for (const id of ["prophet", "decision_matrix", "grid_bot_protocol", "supertrend", "order_blocks", "h1", "htf", "news", "technical", "risk", "moderator"]) assert.ok(agents.some((a) => a.id === id), id);
  assert.equal(CANON.definitions.outcome_scoring.horizon_candles, 4);
  assert.equal(CANON.definitions.shadow_promotion.alpha, 0.05);
  assert.equal(CANON.definitions.parity.consecutive_matches, 24);
  assert.ok(CANON.definitions.decision_card.never_present.includes("entry_price"));
});
