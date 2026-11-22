// HAIC H3g (platform docs/design/HAIC-H3.md §5.2, §7.3, §7.4): the owner's Nexus corrections become learned text
// items. Every shared fixture (test/fixtures/correction-v1, copied verbatim from the platform at 62e5167) becomes a
// valid note or a not_convertible with its reason; the hourly run reads by cursor, stores once, acknowledges in batch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { convertCorrection, runCorrections, correctionsView, resetCorrectionsSchemaForTests, CONVERSION_SCHEMA, CORRECTIONS_DENIAL_BACKOFF_MS } from "../src/corrections.mjs";
import { validateCorrection, correctionContentHash, correctionDedupHash } from "../src/correction-contract.mjs";
import { learnedPack, resetKnowledgeSchemaCacheForTests } from "../src/knowledge.mjs";

const fixture = (p) => JSON.parse(readFileSync(new URL(`./fixtures/correction-v1/${p}`, import.meta.url), "utf8"));
const index = fixture("index.json");

test("CV1 the contract port: every fixture's errors and both hashes, as on the platform", async () => {
  for (const f of index.files) {
    const errors = validateCorrection(fixture(f.file));
    if (!f.expect_errors.length) assert.deepEqual(errors, [], f.file);
    else for (const e of f.expect_errors) assert.ok(errors.includes(e), `${f.file}: ${errors}`);
  }
  for (const f of index.files.filter((x) => !x.expect_errors.length)) {
    const c = fixture(f.file);
    assert.equal(await correctionContentHash(c), c.content_sha256, f.file);
    assert.equal(await correctionDedupHash(c), c.dedup_sha256, f.file);
  }
});

test("CV2 every valid fixture becomes a valid note or a not_convertible with its expected reason; an invalid one never converts", () => {
  const expected = {
    "valid/chat-rating-down.json": "not_nexus",
    "valid/council-claim-correction.json": "not_nexus",
    "valid/typed-proposal-reject-reason.json": "not_nexus",
    "valid/nexus-card-non-owner.json": "category_good_call",
    "valid/masked-and-redacted.json": "not_nexus"
  };
  for (const f of index.files) {
    const out = convertCorrection(fixture(f.file), { chart: "15", session: "london" });
    if (f.expect_errors.length) { assert.equal(out.status, "not_convertible", f.file); assert.match(out.reason, /^invalid: /, f.file); continue; }
    assert.deepEqual(out, { status: "not_convertible", reason: expected[f.file] }, f.file);
  }
});

const NEXUS = (over = {}) => ({
  ...fixture("valid/nexus-card-non-owner.json"),
  correction_id: "cor_aaaaaaaaaaaaaaaa", actor: "owner:owner@example.com", weight: 3, rating: "down", category: "reading_wrong",
  text: "Called the break before the close confirmed it; the candle at [level] failed.",
  target: { ref: "ev:xauusd/card/d:15:1795211100000:0", subject: "seat:m15_room", as_of: "2026-11-20T21:45:00Z" },
  content_sha256: "0".repeat(64), dedup_sha256: "1".repeat(64),
  ...over
});

test("CV3 conversion: a reading or invalidation correction is a caution, rule_broken a role_reminder; never a parameter", () => {
  const out = convertCorrection(NEXUS(), { chart: "15", session: "late" });
  assert.equal(out.status, "converted");
  const it = out.item;
  assert.deepEqual([it.kind, it.label, it.origin, it.weight, it.correction_id], ["caution", "learned", "owner_correction", 3, "cor_aaaaaaaaaaaaaaaa"]);
  assert.deepEqual(it.audience, { agents: ["m15_room"], charts: ["15"] });
  assert.deepEqual(it.situation, { chart: "15", session: "late" });
  assert.match(it.text, /^Owner correction for m15 room on the quarter-hour chart, late session: the reading was wrong\. Called the break/);
  assert.ok(it.text.length <= 300);
  assert.equal(it.params, undefined, "never a parameter");
  assert.equal(convertCorrection(NEXUS({ category: "rule_broken" }), { chart: "60", session: null }).item.kind, "role_reminder");
  for (const [over, reason] of [[{ category: null }, "rating_only"], [{ category: "good_call" }, "category_good_call"], [{ category: "other" }, "category_other"], [{ target: { ref: "ev:xauusd/card/x", subject: "agent:moderator", as_of: null } }, "no_seat"]]) {
    assert.deepEqual(convertCorrection(NEXUS(over), { chart: "15", session: null }), { status: "not_convertible", reason }, reason);
  }
  assert.deepEqual(convertCorrection(NEXUS(), null), { status: "not_convertible", reason: "no_chart" });
  assert.equal(convertCorrection(NEXUS({ text: "x".repeat(500) }), { chart: "15", session: null }).item.text.length, 300, "the owner's text is cut to fit 300");
});

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
    },
    raw: db
  };
}
const NOW = Date.parse("2026-11-23T10:52:00Z");

test("CV4 the hourly run: reads by cursor, stores each correction once, the note in the pack, acknowledges in one report; a denial backs off", async () => {
  resetCorrectionsSchemaForTests(); resetKnowledgeSchemaCacheForTests();
  const db = d1();
  // The target card, as xauusd sends it (src/store.mjs creates decision_cards).
  db.raw.exec("CREATE TABLE IF NOT EXISTS decision_cards (card_id TEXT PRIMARY KEY, chart TEXT NOT NULL, kind TEXT NOT NULL, bar_open TEXT NOT NULL, card_json TEXT NOT NULL, canon_sha TEXT NOT NULL, received_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.raw.prepare("INSERT INTO decision_cards VALUES (?, '15', 'room_conclusion', '2026-11-20T21:45:00.000Z', ?, 'x', 'x', 'x')").run("d:15:1795211100000:0", JSON.stringify({ session: "late" }));
  const pages = [
    { corrections: [NEXUS(), NEXUS({ correction_id: "cor_bbbbbbbbbbbbbbbb", category: "good_call", rating: "up", text: null })], next_cursor: "2026-11-23T10:00:00Z|cor_bbbbbbbbbbbbbbbb" },
    { corrections: [], next_cursor: null }
  ];
  const calls = [], reports = [];
  let deny = false;
  const env = {
    AETHER_DB: db,
    AGENTS: {
      async syscall(agent, capability, input) {
        calls.push({ agent, capability, input });
        if (capability === "corrections.read") {
          if (deny) return { outcome: "denied", reason: "capability_not_granted" };
          return { outcome: "succeeded", result: input.cursor ? pages[1] : pages[0] };
        }
        if (capability === "reports.publish") { reports.push(input); return { outcome: "succeeded" }; }
        return { outcome: "denied" };
      }
    }
  };
  const r = await runCorrections(env, { now: NOW });
  assert.deepEqual([r.status, r.read, r.converted, r.not_convertible, r.acked], ["ok", 2, 1, 1, 2]);
  assert.ok(calls.every((c) => c.agent === "aether-curator"));
  assert.deepEqual(calls[0].input, { side: "nexus" });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].body.schema, CONVERSION_SCHEMA);
  assert.deepEqual(reports[0].body.conversions, [
    { correction_id: "cor_aaaaaaaaaaaaaaaa", status: "converted", item_id: "k-cor-aaaaaaaaaaaaaaaa" },
    { correction_id: "cor_bbbbbbbbbbbbbbbb", status: "not_convertible", reason: "category_good_call" }
  ]);
  // The pack carries the note for xauusd's shadow arm, label "learned", marked as the owner's correction.
  const pack = await learnedPack(env);
  const item = pack.items.find((x) => x.item_id === "k-cor-aaaaaaaaaaaaaaaa");
  assert.deepEqual([item.label, item.origin, item.weight, item.review, item.kind], ["learned", "owner_correction", 3, "owner", "caution"]);
  // The next run starts at the cursor; the same corrections are never stored or acknowledged twice.
  const again = await runCorrections(env, { now: NOW + 3_600_000 });
  assert.deepEqual([again.read, again.converted, again.acked], [0, 0, 0]);
  assert.deepEqual(calls.filter((c) => c.capability === "corrections.read").at(-1).input, { cursor: "2026-11-23T10:00:00Z|cor_bbbbbbbbbbbbbbbb", side: "nexus" });
  assert.equal(reports.length, 1);
  // A newer correction that supersedes the first retires its note.
  pages[1] = { corrections: [NEXUS({ correction_id: "cor_cccccccccccccccc", supersedes: "cor_aaaaaaaaaaaaaaaa", category: "invalidation_too_tight" })], next_cursor: "2026-11-23T11:00:00Z|cor_cccccccccccccccc" };
  await runCorrections(env, { now: NOW + 2 * 3_600_000 });
  const ids = (await learnedPack(env)).items.map((x) => x.item_id);
  assert.ok(ids.includes("k-cor-cccccccccccccccc") && !ids.includes("k-cor-aaaaaaaaaaaaaaaa"));
  // A denial (the capability not granted yet): the next reads wait.
  deny = true;
  pages[1] = { corrections: [], next_cursor: null };
  const denied = await runCorrections(env, { now: NOW + 3 * 3_600_000 });
  assert.match(denied.stopped, /^denied/);
  assert.equal((await runCorrections(env, { now: NOW + 3 * 3_600_000 + CORRECTIONS_DENIAL_BACKOFF_MS - 1 })).status, "backoff");
  const view = await correctionsView(env);
  assert.deepEqual(view.by_status, { converted: 2, not_convertible: 1 });
  assert.equal(view.unacked, 0);
});
