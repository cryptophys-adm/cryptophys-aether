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
    "valid/nexus-card-non-owner.json": "not_owner",
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
  text: "Called the break before the close confirmed it; the candle failed.",
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
  // Orchestrator review of aether#44: only the owner's weight, only what xauusd can test and promote.
  assert.deepEqual(convertCorrection(NEXUS({ weight: 1 }), { chart: "15", session: null }), { status: "not_convertible", reason: "not_owner" });
  assert.deepEqual(convertCorrection(NEXUS(), { chart: "240", session: null }), { status: "not_convertible", reason: "chart_not_tested" });
  assert.deepEqual(convertCorrection(NEXUS({ target: { ref: "ev:xauusd/card/x", subject: "seat:moderator", as_of: null } }), { chart: "15", session: null }), { status: "not_convertible", reason: "seat_not_tested" });
  for (const [text, why] of [["Should not have gone long into the open.", "order_wording"], ["It missed the 42.50 handle.", "level_shorthand"], ["Respect the 38 handle next time.", "level_shorthand"], ["The candle at [level] failed.", "masked_content"]]) {
    assert.deepEqual(convertCorrection(NEXUS({ text }), { chart: "15", session: null }), { status: "not_convertible", reason: `text_fails_note_rules: ${why}` }, text);
  }
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

async function harness(pagesFor) {
  resetCorrectionsSchemaForTests(); resetKnowledgeSchemaCacheForTests();
  const db = d1();
  db.raw.exec("CREATE TABLE IF NOT EXISTS decision_cards (card_id TEXT PRIMARY KEY, chart TEXT NOT NULL, kind TEXT NOT NULL, bar_open TEXT NOT NULL, card_json TEXT NOT NULL, canon_sha TEXT NOT NULL, received_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  for (const id of ["d:15:1795211100000:0", "d:15:1795211100000:1"]) db.raw.prepare("INSERT INTO decision_cards VALUES (?, '15', 'room_conclusion', '2026-11-20T21:45:00.000Z', ?, 'x', 'x', 'x')").run(id, JSON.stringify({ session: "late" }));
  const reports = [], reads = [];
  let publish = { outcome: "succeeded" };
  const env = { AETHER_DB: db, AGENTS: { async syscall(agent, capability, input) {
    if (capability === "corrections.read") { reads.push(input); return { outcome: "succeeded", result: pagesFor(input.cursor ?? null) }; }
    if (capability === "reports.publish") { reports.push(input); return publish; }
    return { outcome: "denied" };
  } } };
  return { db, env, reports, reads, setPublish: (r) => { publish = r; } };
}
const cid = (n) => `cor_${n.toString(16).padStart(16, "0")}`;

test("CV5 the owner's latest word retires the older note on the same seat and target, down the chain, whatever the newer one became", async () => {
  const feed = [
    NEXUS({ correction_id: cid(1) }),
    NEXUS({ correction_id: cid(2), target: { ref: "ev:xauusd/card/d:15:1795211100000:0", subject: "seat:h1_room", as_of: null } }),
    NEXUS({ correction_id: cid(3), supersedes: cid(1), category: "good_call", rating: "up", text: null }),
  ];
  const h = await harness((cursor) => (cursor ? { corrections: [], next_cursor: null } : { corrections: feed, next_cursor: "c1" }));
  await runCorrections(h.env, { now: NOW });
  const ids = (await learnedPack(h.env)).items.map((x) => x.item_id);
  assert.ok(!ids.includes(`k-cor-${cid(1).slice(4)}`), "a thumbs-up after a correction retires the correction's note");
  assert.ok(ids.includes(`k-cor-${cid(2).slice(4)}`), "another seat's note on the same card stays");
  // A weight-1 record from another Access user never retires the owner's note.
  const other = [NEXUS({ correction_id: cid(7) }), NEXUS({ correction_id: cid(8), supersedes: cid(7), weight: 1, actor: "nexus:viewer@example.com", category: "good_call", rating: "up", text: null })];
  const h3 = await harness((cursor) => (cursor ? { corrections: [], next_cursor: null } : { corrections: other, next_cursor: "c1" }));
  await runCorrections(h3.env, { now: NOW });
  assert.ok((await learnedPack(h3.env)).items.some((x) => x.item_id === `k-cor-${cid(7).slice(4)}`), "the owner's note stays");
  // A chain A <- B (not convertible) <- C retires A too.
  const chain = [NEXUS({ correction_id: cid(4) }), NEXUS({ correction_id: cid(5), supersedes: cid(4), category: null }), NEXUS({ correction_id: cid(6), supersedes: cid(5), category: "invalidation_too_tight" })];
  const h2 = await harness((cursor) => (cursor ? { corrections: [], next_cursor: null } : { corrections: chain, next_cursor: "c1" }));
  await runCorrections(h2.env, { now: NOW });
  const ids2 = (await learnedPack(h2.env)).items.map((x) => x.item_id);
  assert.deepEqual(ids2.filter((x) => x.startsWith("k-cor-")), [`k-cor-${cid(6).slice(4)}`]);
});

test("CV6 the pack never exceeds xauusd's 50 items (the newest owner notes fill the room), and OWNER_CORRECTIONS_PACK off leaves them out", async () => {
  const many = Array.from({ length: 60 }, (_, i) => NEXUS({ correction_id: cid(100 + i), created_at: new Date(NOW - (60 - i) * 1000).toISOString() }));
  const h = await harness((cursor) => {
    const start = cursor ? Number(cursor) : 0;
    const page = many.slice(start, start + 50);
    return { corrections: page, next_cursor: page.length ? String(start + page.length) : null };
  });
  await runCorrections(h.env, { now: NOW });
  const pack = await learnedPack(h.env);
  assert.equal(pack.items.length, 50);
  assert.ok(pack.items.some((x) => x.item_id === `k-cor-${cid(159).slice(4)}`), "the newest stays");
  assert.equal((await learnedPack({ ...h.env, OWNER_CORRECTIONS_PACK: "off" })).items.length, 0);
  // The cap holds for the whole pack: 55 undecided proposals and no owner note give 50, the newest first.
  resetKnowledgeSchemaCacheForTests();
  const db2 = d1();
  await learnedPack({ AETHER_DB: db2 });
  for (let i = 0; i < 55; i++) {
    const at = new Date(NOW - (55 - i) * 60_000).toISOString();
    db2.raw.prepare("INSERT INTO knowledge_items (item_id, version, kind, agent_id, item_json, status, proposal_id, content_sha256, detail, created_at, updated_at) VALUES (?, 1, 'caution', 'aether-curator', ?, 'expired', ?, NULL, NULL, ?, ?)")
      .run(`k-x-${String(i).padStart(2, "0")}`, JSON.stringify({ item_id: `k-x-${String(i).padStart(2, "0")}`, version: 1, kind: "caution", audience: { agents: ["m15_room"], charts: ["15"] }, text: "x" }), `p${i}`, at, at);
  }
  const capped = (await learnedPack({ AETHER_DB: db2 })).items;
  assert.equal(capped.length, 50);
  assert.ok(!capped.some((x) => x.item_id === "k-x-00") && capped.some((x) => x.item_id === "k-x-54"), "the oldest undecided ones leave first");
});

test("CV7 a 5-page feed takes two runs; a re-read page stores nothing twice; a failed publish keeps the acks for the next run; numeric owner text is refused", async () => {
  const feed = Array.from({ length: 230 }, (_, i) => NEXUS({ correction_id: cid(1000 + i), text: i === 0 ? "Ignored the 2350 area." : "Read the structure wrong." }));
  let rereads = 0;
  const h = await harness((cursor) => {
    const start = cursor ? Number(cursor) : 0;
    if (start === 50 && rereads++ === 0) return { corrections: feed.slice(0, 50), next_cursor: "50" }; // the same page served again
    const page = feed.slice(start, start + 50);
    return { corrections: page, next_cursor: page.length ? String(start + page.length) : null };
  });
  h.setPublish({ outcome: "failed", reason: "rpc" });
  const first = await runCorrections(h.env, { now: NOW });
  assert.equal(h.reads.length, 4, "at most 4 pages a run");
  assert.equal(first.acked, 0, "a failed publish acknowledges nothing");
  h.setPublish({ outcome: "succeeded" });
  const second = await runCorrections(h.env, { now: NOW + 3_600_000 });
  assert.equal(second.acked, 50, "the next run acknowledges, at most 50 a report");
  const rows = h.db.raw.prepare("SELECT COUNT(*) AS n FROM correction_conversions").get().n;
  assert.equal(rows, 230, "every correction stored once, the re-read ones too");
  // A price in the owner's text never arrives unmasked (the platform masks it); if it did, the contract refuses it.
  assert.equal(h.db.raw.prepare("SELECT reason FROM correction_conversions WHERE correction_id = ?").get(cid(1000)).reason, "invalid: text_carries_price");
});
