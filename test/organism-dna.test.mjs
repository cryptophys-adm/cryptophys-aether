// Owner 2026-11-14: "ya, Aether perlu DNA, tes CI, dan file yang dilindungi sendiri lebih dulu sebelum boleh diubah
// oleh agen". organism.json is Aether's DNA (platform ADR-0013; the organ shape of xauusd's organism.json). These
// tests keep it equal to the code in both directions, so a new binding, cron, agent, AI model or entrypoint cannot
// ship without its line in the DNA, and the DNA cannot claim what the code does not have. They read files only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { CURATOR, CALIBRATOR } from "../src/knowledge.mjs";
import { COUNCIL_AGENT, COUNCIL_HOUR_UTC } from "../src/doctrine.mjs";
import { EMBED_MODEL, EMBED_DIMENSIONS, EMBED_BATCH } from "../src/embed.mjs";
import { DEFAULT_DAILY_LIMIT } from "../src/budget.mjs";
import { INDEXES } from "../scripts/ensure-vectorize.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const sorted = (xs) => [...xs].sort();
const SERVICE = "cryptophys-aether";
const ORGANISM_SCHEMA = "aether-organism.v1";

/** JSONC to JSON: drops // and /* *\/ comments outside strings (wrangler.jsonc has "https://..." in strings). */
function stripJsonc(text) {
  let out = "", inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === "\\") { out += n; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out;
}

/**
 * The platform's DNA validator, mirrored from cryptophys-cloud-platform workers/control-plane-shared/src/organism.ts
 * (parseDna, $schema_version 1). A change there is mirrored here by a reviewed PR; this copy never widens it.
 */
function parseDna(raw, where = "organ") {
  const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
  const SVC = /^(cryptophys|xauusd)-[a-z0-9-]{2,60}$/;
  const BINDING = /^[A-Z][A-Z0-9_]{1,62}$/;
  const CAPABILITY = /^[a-z]+\.[a-z_]+$/;
  const TASK = /^[a-z][a-z0-9_]{2,62}$/;
  const fail = (m) => { throw new Error(`${where}: ${m}`); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("not an object");
  if (raw.$schema_version !== 1) fail("$schema_version must be 1");
  if (typeof raw.service !== "string" || !SVC.test(raw.service)) fail("service");
  if (typeof raw.display_name !== "string" || !raw.display_name.trim() || raw.display_name.length > 80) fail("display_name");
  if (!["service", "portal", "build-stub"].includes(raw.kind)) fail("kind");
  if (raw.deploy_unit !== null && (typeof raw.deploy_unit !== "string" || !ID.test(raw.deploy_unit))) fail("deploy_unit");
  if (typeof raw.access !== "boolean" || typeof raw.rollback !== "boolean") fail("access/rollback");
  const d = raw.drift;
  if (d !== null && !(d && typeof d === "object" && (d.via === "self" || (d.via === "rpc" && BINDING.test(d.binding ?? ""))))) fail("drift");
  if (!Array.isArray(raw.agents) || !Array.isArray(raw.engines)) fail("agents/engines");
  const seen = new Set();
  for (const a of raw.agents) {
    if (!a || !ID.test(a.id) || seen.has(a.id)) fail(`agent ${a?.id}`);
    seen.add(a.id);
    if (typeof a.display_name !== "string" || !a.display_name.trim()) fail(`agent ${a.id}: display_name`);
    if (!Array.isArray(a.capabilities) || a.capabilities.some((c) => !CAPABILITY.test(c))) fail(`agent ${a.id}: capabilities`);
    if (!Number.isInteger(a.tier_max) || a.tier_max < 0 || a.tier_max > 2) fail(`agent ${a.id}: tier_max`);
    if (typeof a.voter !== "boolean") fail(`agent ${a.id}: voter`);
    if (a.vote_binding !== undefined && (!a.voter || !BINDING.test(a.vote_binding))) fail(`agent ${a.id}: vote_binding`);
  }
  if (raw.agents.filter((a) => a.voter && a.vote_binding).length > 1) fail("one vote per Worker");
  const tasks = new Set();
  for (const e of raw.engines) {
    if (!e || !TASK.test(e.task) || tasks.has(e.task)) fail(`engine ${e?.task}`);
    tasks.add(e.task);
  }
  if (raw.kind === "build-stub" && (raw.deploy_unit !== null || raw.access || raw.rollback || raw.agents.length || tasks.size)) fail("a build stub has no unit, Access, rollback, agents or engines");
  return raw;
}

const DNA = JSON.parse(read("organism.json"));
const WRANGLER = JSON.parse(stripJsonc(read("wrangler.jsonc")));
const organ = DNA.organs?.find((o) => o.service === SERVICE);
const anatomy = DNA.anatomy?.[SERVICE];
const SRC = readdirSync(new URL("src/", root)).filter((f) => f.endsWith(".mjs") && f !== "canon.generated.mjs").map((f) => ({ f: `src/${f}`, text: read(`src/${f}`) }));

/** The name of the function that encloses `index` in `text` (the last function declaration before it). */
function enclosingFunction(text, index) {
  const before = text.slice(0, index);
  const all = [...before.matchAll(/(?:^|\n)(?:export )?(?:async )?function (\w+)\(/g)];
  return all.at(-1)?.[1] ?? null;
}
const snake = (name) => name.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

test("D0. organism.json is schema-valid: aether-organism.v1, one organ per Worker in the platform's DNA shape", () => {
  assert.equal(DNA.schema, ORGANISM_SCHEMA);
  assert.ok(Array.isArray(DNA.organs) && DNA.organs.length >= 1);
  for (const [i, o] of DNA.organs.entries()) parseDna(o, `organs[${i}]`);
  assert.deepEqual(sorted(Object.keys(DNA)), ["$comment", "anatomy", "organs", "schema"]);
  assert.deepEqual(sorted(Object.keys(DNA.anatomy)), sorted(DNA.organs.map((o) => o.service)), "one anatomy per organ");
  // The validator mirror refuses what the platform's refuses.
  const bad = (patch, re) => assert.throws(() => parseDna({ ...organ, ...patch }), re);
  bad({ $schema_version: 2 }, /schema_version/);
  bad({ service: "aether" }, /service/);
  bad({ kind: "organ" }, /kind/);
  bad({ drift: { via: "rpc" } }, /drift/);
  bad({ agents: [{ ...organ.agents[0], capabilities: ["Trade.Execute!"] }] }, /capabilities/);
  bad({ agents: [organ.agents[0], organ.agents[0]] }, /agent/);
  bad({ engines: [{ task: "x" }] }, /engine/);
  for (const a of anatomy.agents) assert.deepEqual(sorted(Object.keys(a)), ["id", "module", "registered_by", "uses"], a.id);
});

test("D1. one organ per Worker of this repository, named as its wrangler config names it", () => {
  assert.deepEqual(DNA.organs.map((o) => o.service), [WRANGLER.name]);
  assert.equal(organ.$schema_version, 1);
  assert.equal(organ.kind, "service");
  assert.equal(organ.deploy_unit, null, "deployed by this repository (deploy.yml), not by a platform unit");
  assert.equal(organ.access, false, "no platform Access entry: Aether has no public URL");
  assert.equal(organ.rollback, false);
  assert.deepEqual(organ.drift, { via: "rpc", binding: "EXT_AETHER" }, "the Drift Detector probes Aether through EXT_AETHER");
  assert.equal(anatomy.wrangler, "wrangler.jsonc");
  assert.equal(anatomy.main, WRANGLER.main);
  assert.equal(anatomy.compatibility_date, WRANGLER.compatibility_date);
  assert.deepEqual(anatomy.surface, { workers_dev: WRANGLER.workers_dev, preview_urls: WRANGLER.preview_urls, routes: WRANGLER.routes ?? (WRANGLER.route ? [WRANGLER.route] : []), observability: WRANGLER.observability?.enabled === true });
  assert.equal(anatomy.surface.workers_dev, false, "owner 2026-11-09: no public workers.dev URL");
  assert.equal(anatomy.surface.preview_urls, false);
});

test("D2. the agents are exactly those the code acts as on the kernel, each using only capabilities its DNA declares", () => {
  // Every AgentRpc syscall goes through one of three wrappers; a fourth call site must be described here first.
  const sites = SRC.flatMap(({ f, text }) => [...text.matchAll(/\.syscall\(/g)].map((m) => `${f}:${enclosingFunction(text, m.index)}`));
  assert.deepEqual(sorted(sites), ["src/doctrine.mjs:syscall", "src/guardian.mjs:publish", "src/knowledge.mjs:syscall"], "every AGENTS.syscall call site");
  const src = Object.fromEntries(SRC.map(({ f, text }) => [f, text]));
  const caps = (text, re) => new Set([...text.matchAll(re)].map((m) => m[1]));
  const used = new Map();
  const add = (id, set) => used.set(id, new Set([...(used.get(id) ?? []), ...set]));
  // guardian.mjs: publish(env, "<agent>", report) sends reports.publish.
  assert.match(src["src/guardian.mjs"], /syscall\(agentId, "reports\.publish", report\)/);
  for (const m of src["src/guardian.mjs"].matchAll(/publish\(env, "([a-z0-9-]+)"/g)) add(m[1], ["reports.publish"]);
  // knowledge.mjs: syscall(env, agentId, "<capability>") with agentId the curator or the calibrator only.
  const k = src["src/knowledge.mjs"];
  const agentArgs = [...k.matchAll(/proposeAll\(env, ([A-Z_]+),/g)].map((m) => m[1]).concat([...k.matchAll(/for \(const agentId of \[([A-Z_, ]+)\]\)/g)].flatMap((m) => m[1].split(/,\s*/)));
  assert.deepEqual(sorted(new Set(agentArgs)), ["CALIBRATOR", "CURATOR"], "knowledge.mjs acts only as the curator and the calibrator");
  for (const id of [CURATOR, CALIBRATOR]) add(id, caps(k, /syscall\(env, agentId, "([a-z]+\.[a-z_]+)"/g));
  // doctrine.mjs: syscall(env, "<capability>") always as COUNCIL_AGENT.
  assert.match(src["src/doctrine.mjs"], /env\.AGENTS\.syscall\(COUNCIL_AGENT, capability, input\)/);
  add(COUNCIL_AGENT, caps(src["src/doctrine.mjs"], /syscall\(env, "([a-z]+\.[a-z_]+)"/g));

  assert.deepEqual(sorted(organ.agents.map((a) => a.id)), sorted(used.keys()), "organism.json agents = the agent ids the code uses");
  assert.deepEqual(anatomy.agents.map((a) => a.id), organ.agents.map((a) => a.id), "anatomy.agents in the organ's order");
  for (const a of organ.agents) {
    const codeUses = sorted(used.get(a.id));
    const anat = anatomy.agents.find((x) => x.id === a.id);
    assert.deepEqual(sorted(anat.uses), codeUses, `${a.id}: anatomy uses = the capabilities the code calls`);
    for (const c of codeUses) assert.ok(a.capabilities.includes(c), `${a.id}: calls ${c}, which its DNA does not declare`);
    assert.equal(a.voter, false, `${a.id}: Aether holds no council seat`);
    assert.equal(a.vote_binding, undefined, a.id);
    assert.equal(a.tier_max, 1, `${a.id}: tier 1 (as registered by the platform)`);
    assert.ok(src[anat.module]?.includes(a.id === CURATOR ? "CURATOR" : a.id === CALIBRATOR ? "CALIBRATOR" : a.id === COUNCIL_AGENT ? "COUNCIL_AGENT" : `"${a.id}"`), `${a.id}: acts in ${anat.module}`);
  }
});

test("D3. the AI engines and models are every Workers AI call in the code", () => {
  const runs = SRC.flatMap(({ f, text }) => [...text.matchAll(/env\.AI\.run\(([A-Za-z_"@/.\-0-9]+)/g)].map((m) => ({ f, fn: enclosingFunction(text, m.index), model: m[1] })));
  assert.ok(runs.length >= 1);
  assert.deepEqual(sorted(organ.engines.map((e) => e.task)), sorted(new Set(runs.map((r) => snake(r.fn)))), "one engine per function that calls Workers AI");
  assert.deepEqual(sorted(anatomy.models.map((m) => m.task)), sorted(organ.engines.map((e) => e.task)));
  for (const r of runs) {
    assert.equal(r.model, "EMBED_MODEL", `${r.f}:${r.fn} calls Workers AI with ${r.model}`);
    const m = anatomy.models.find((x) => x.task === snake(r.fn));
    assert.deepEqual({ binding: m.binding, model: m.model, dimensions: m.dimensions, batch: m.batch, budget: m.budget }, { binding: "AI", model: EMBED_MODEL, dimensions: EMBED_DIMENSIONS, batch: EMBED_BATCH, budget: { var: "AI_DAILY_LIMIT", default: DEFAULT_DAILY_LIMIT } });
    // The callers of the engine function.
    const callers = SRC.flatMap(({ text }) => [...text.matchAll(new RegExp(`await ${r.fn}\\(`, "g"))].map((x) => enclosingFunction(text, x.index)));
    assert.deepEqual(sorted(m.used_by), sorted(new Set(callers)), `${m.task}: used_by`);
  }
  assert.ok(!SRC.some(({ text }) => /\bAI\.(?!run\()\w+\(/.test(text.replace(/env\.AI\.run\(/g, ""))), "no other Workers AI method");
});

/** Wrangler's top-level keys this test knows; a new one (a new binding kind) fails until the DNA describes it. */
const NON_BINDING_KEYS = ["$schema", "name", "main", "compatibility_date", "compatibility_flags", "workers_dev", "preview_urls", "observability", "routes", "route", "triggers", "vars"];
function wranglerBindings(w) {
  const out = [];
  for (const d of w.d1_databases ?? []) out.push({ binding: d.binding, type: "d1", database_name: d.database_name, ...(d.database_id ? { database_id: d.database_id } : {}) });
  for (const v of w.vectorize ?? []) out.push({ binding: v.binding, type: "vectorize", index_name: v.index_name });
  if (w.ai) out.push({ binding: w.ai.binding, type: "ai" });
  for (const s of w.services ?? []) out.push({ binding: s.binding, type: "service", service: s.service, ...(s.entrypoint ? { entrypoint: s.entrypoint } : {}), ...(s.props ? { props: s.props } : {}) });
  for (const kv of w.kv_namespaces ?? []) out.push({ binding: kv.binding, type: "kv", id: kv.id });
  for (const r of w.r2_buckets ?? []) out.push({ binding: r.binding, type: "r2", bucket_name: r.bucket_name });
  for (const d of w.durable_objects?.bindings ?? []) out.push({ binding: d.name, type: "durable_object", class_name: d.class_name });
  for (const q of w.queues?.producers ?? []) out.push({ binding: q.binding, type: "queue_producer", queue: q.queue });
  for (const q of w.queues?.consumers ?? []) out.push({ binding: null, type: "queue_consumer", queue: q.queue });
  return out;
}
const MAPPED_KEYS = ["d1_databases", "vectorize", "ai", "services", "kv_namespaces", "r2_buckets", "durable_objects", "queues"];

test("D4. the bindings and vars are exactly wrangler.jsonc's, both directions, and the code reads only those", () => {
  for (const key of Object.keys(WRANGLER)) assert.ok(NON_BINDING_KEYS.includes(key) || MAPPED_KEYS.includes(key), `wrangler.jsonc key "${key}" is not described by organism.json (add it to the DNA and to this test)`);
  const key = (b) => `${b.type}:${b.binding}`;
  const w = wranglerBindings(WRANGLER).sort((a, b) => key(a).localeCompare(key(b)));
  const d = [...anatomy.bindings].sort((a, b) => key(a).localeCompare(key(b)));
  assert.deepEqual(d, w, "organism.json anatomy.bindings = wrangler.jsonc bindings");
  assert.deepEqual(anatomy.vars, WRANGLER.vars ?? {}, "organism.json anatomy.vars = wrangler.jsonc vars");
  // Storage: each kind is what wrangler binds, and the empty kinds are really absent.
  const s = anatomy.storage;
  assert.deepEqual(s.d1.map((x) => [x.binding, x.database_name]), w.filter((b) => b.type === "d1").map((b) => [b.binding, b.database_name]));
  assert.deepEqual(s.vectorize.map((x) => [x.binding, x.index_name]), w.filter((b) => b.type === "vectorize").map((b) => [b.binding, b.index_name]));
  assert.deepEqual(s.kv_namespaces, w.filter((b) => b.type === "kv").map((b) => b.binding));
  assert.deepEqual(s.r2_buckets, w.filter((b) => b.type === "r2").map((b) => b.binding));
  assert.deepEqual(s.durable_objects, w.filter((b) => b.type === "durable_object").map((b) => b.binding));
  assert.deepEqual(s.queues, w.filter((b) => b.type.startsWith("queue")).map((b) => b.queue));
  assert.deepEqual(anatomy.outbound.map((o) => [o.binding, o.service, o.entrypoint]), w.filter((b) => b.type === "service").map((b) => [b.binding, b.service, b.entrypoint]));
  // Code direction: every env name the Worker reads is a binding, a var, or a documented code default (unset in wrangler).
  const names = new Set(SRC.flatMap(({ text }) => [...text.matchAll(/\benv\??\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1])));
  const declared = new Set([...anatomy.bindings.map((b) => b.binding), ...Object.keys(anatomy.vars), ...Object.keys(anatomy.code_defaults)]);
  for (const n of names) assert.ok(declared.has(n), `src reads env.${n}, which organism.json does not declare`);
  for (const b of anatomy.bindings) assert.ok(names.has(b.binding), `binding ${b.binding} is never read by src/`);
  for (const v of Object.keys(anatomy.vars)) assert.ok(names.has(v), `var ${v} is never read by src/`);
  for (const v of Object.keys(anatomy.code_defaults)) {
    assert.ok(names.has(v), `code default ${v} is never read by src/`);
    assert.ok(!(v in (WRANGLER.vars ?? {})), `${v} is set in wrangler.jsonc: move it from code_defaults to vars`);
  }
});

test("D5. the storage details match the code: D1 tables, Vectorize indexes", () => {
  const tables = new Set(SRC.flatMap(({ text }) => [...text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1])));
  assert.deepEqual(sorted(anatomy.storage.d1[0].tables), sorted(tables), "aether-knowledge tables = every CREATE TABLE in src/");
  assert.equal(anatomy.storage.d1[0].database_name, "aether-knowledge");
  assert.deepEqual(anatomy.storage.vectorize.map(({ index_name, dimensions, metric, metadata }) => ({ name: index_name, dimensions, metric, metadata })), INDEXES.map((x) => ({ ...x })), "the Vectorize indexes = scripts/ensure-vectorize.mjs INDEXES");
  for (const v of anatomy.storage.vectorize) assert.equal(v.dimensions, EMBED_DIMENSIONS, `${v.index_name}: the embedding model's dimensions`);
});

test("D6. the crons are exactly wrangler.jsonc's, and the schedule is every step of the scheduled handler", () => {
  assert.deepEqual(anatomy.crons, WRANGLER.triggers?.crons ?? [], "organism.json anatomy.crons = wrangler.jsonc triggers.crons");
  assert.deepEqual(sorted(Object.keys(WRANGLER.triggers ?? {})), ["crons"]);
  const index = read("src/index.mjs");
  const body = index.slice(index.indexOf("async scheduled("));
  const hour = (h) => (h === "COUNCIL_HOUR_UTC" ? COUNCIL_HOUR_UTC : Number(h));
  const steps = [...body.matchAll(/(?:if \(new Date\(now\)\.getUTCHours\(\) === ([0-9]+|COUNCIL_HOUR_UTC)\) )?await step\("([a-z_]+)"/g)].map((m) => ({ step: m[2], utc_hour: m[1] === undefined ? null : hour(m[1]) }));
  assert.ok(steps.length >= 4);
  assert.deepEqual(anatomy.schedule, steps, "organism.json anatomy.schedule = the scheduled handler's steps, in order");
  // Every daily hour runs at the cron's minute (52), and the cron fires every hour.
  assert.match(anatomy.crons[0], /^52 \* \* \* \*$/);
});

test("D7. the entrypoints are exactly the Worker's exports and their methods", () => {
  const index = read("src/index.mjs");
  const classes = [...index.matchAll(/export class (\w+) extends WorkerEntrypoint \{([\s\S]*?)\n\}\n/g)].map((m) => ({ name: m[1], methods: [...m[2].matchAll(/^\s+async (\w+)\(/gm)].map((x) => x[1]) }));
  const rpc = anatomy.entrypoints.filter((e) => e.kind === "rpc").map(({ name, methods }) => ({ name, methods }));
  assert.deepEqual(rpc, classes, "organism.json RPC entrypoints = the WorkerEntrypoint classes of src/index.mjs");
  const def = index.slice(index.indexOf("export default {"));
  const handlers = [...def.matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]);
  assert.deepEqual(sorted(anatomy.entrypoints.filter((e) => e.name === "default").map((e) => e.kind)), sorted(handlers), "default export handlers");
  const fetch = anatomy.entrypoints.find((e) => e.kind === "fetch");
  const paths = new Set([...def.matchAll(/url\.pathname === "([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(sorted(fetch.paths), sorted(paths), "the fetch handler's paths");
  assert.match(def, /request\.method !== "GET" && request\.method !== "HEAD"/, "the fetch handler is read-only");
  assert.deepEqual(fetch.methods, ["GET", "HEAD"]);
  for (const e of anatomy.entrypoints) for (const c of e.callers ?? []) assert.match(c.service, /^(cryptophys|xauusd)-[a-z0-9-]+$/, `${e.name}: caller ${c.service}`);
});
