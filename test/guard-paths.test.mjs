// Owner 2026-11-14: Aether's own protected files, before agents may change it. guard-paths.json lists the paths whose
// change needs the owner's click or merge (AGENTS.md, "How agents may change Aether"), in the style of the platform's
// CRITICAL_PATHS. These tests keep the list real: every pattern matches files that exist, the files the owner named
// are guarded, and routine code stays routine.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const GUARD = JSON.parse(read("guard-paths.json"));
const REASONS = ["doctrine_canon", "advisory_boundary", "dna", "ci_workflows", "test_config", "auth_access", "wrangler_config", "deploy", "secrets", "agent_rules"];
const PATHS = GUARD.paths.map((p) => [new RegExp(p.pattern), p.reason]);

/** The guard-path reason of one repository path, or null for a routine path (the first match wins). */
const guardReason = (path) => { for (const [re, reason] of PATHS) if (re.test(path)) return reason; return null; };

/** Every file of the repository, relative and with "/" separators; no VCS, dependencies or build output. */
const SKIP = new Set([".git", "node_modules", ".wrangler", "dist"]);
function files(dir = "") {
  return readdirSync(new URL(dir || ".", root), { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const p = dir + e.name;
    return e.isDirectory() ? files(p + "/") : [p];
  });
}
const FILES = files();

test("G1. guard-paths.json is well formed: anchored patterns, known reasons, no duplicates", () => {
  assert.equal(GUARD.schema, "aether-guard-paths.v1");
  assert.deepEqual(Object.keys(GUARD).sort(), ["$comment", "paths", "schema"]);
  assert.ok(GUARD.paths.length >= 10);
  const seen = new Set();
  for (const p of GUARD.paths) {
    assert.deepEqual(Object.keys(p).sort(), ["pattern", "reason"], JSON.stringify(p));
    assert.ok(p.pattern.startsWith("^"), `${p.pattern}: anchored at the repository root`);
    assert.ok(REASONS.includes(p.reason), `${p.pattern}: reason ${p.reason}`);
    assert.ok(!seen.has(p.pattern), `${p.pattern} listed twice`);
    seen.add(p.pattern);
  }
});

test("G2. every pattern matches at least one real file", () => {
  assert.ok(FILES.includes("wrangler.jsonc") && FILES.includes("src/index.mjs"), "the file walk sees the repository");
  for (const [re] of PATHS) assert.ok(FILES.some((f) => re.test(f)), `${re} matches no file`);
  // Patterns with alternatives match every alternative, so a renamed file cannot leave a dead branch.
  for (const p of GUARD.paths) {
    const alt = /\(([a-z0-9|-]+)\)/i.exec(p.pattern);
    if (!alt) continue;
    for (const a of alt[1].split("|")) {
      const re = new RegExp(p.pattern.replace(alt[0], a));
      assert.ok(FILES.some((f) => re.test(f)), `${p.pattern}: the alternative "${a}" matches no file`);
    }
  }
});

test("G3. the owner's protected files are guarded, each for its reason", () => {
  const expected = {
    "canon/doctrine.json": "doctrine_canon",
    "canon/roles.json": "doctrine_canon",
    "canon/definitions.json": "doctrine_canon",
    "canon/indicator/kb-v4.json": "doctrine_canon",
    "src/canon.generated.mjs": "doctrine_canon",
    "src/doctrine.mjs": "doctrine_canon",
    "scripts/build-canon.mjs": "doctrine_canon",
    "scripts/sync-canon-kb.mjs": "doctrine_canon",
    "docs/DOCTRINE_PROTOCOL.md": "doctrine_canon",
    "src/card-guard.mjs": "advisory_boundary",
    "organism.json": "dna",
    "guard-paths.json": "dna",
    ".github/workflows/ci.yml": "ci_workflows",
    ".github/workflows/deploy.yml": "ci_workflows",
    "package.json": "test_config",
    "test/organism-dna.test.mjs": "test_config",
    "test/guard-paths.test.mjs": "test_config",
    "test/canon.test.mjs": "test_config",
    "src/index.mjs": "auth_access",
    "wrangler.jsonc": "wrangler_config",
    "scripts/check-deployment.mjs": "deploy",
    "scripts/ensure-vectorize.mjs": "deploy",
    ".gitignore": "secrets",
    "AGENTS.md": "agent_rules",
    "CLAUDE.md": "agent_rules"
  };
  for (const [path, reason] of Object.entries(expected)) {
    assert.ok(FILES.includes(path), `${path} exists`);
    assert.equal(guardReason(path), reason, path);
  }
  // Every canon file and every workflow, present and future.
  for (const f of FILES.filter((f) => f.startsWith("canon/") || f.startsWith(".github/workflows/"))) assert.ok(guardReason(f), f);
  // The DNA names the Worker's entry module and config; both are guarded.
  const dna = JSON.parse(read("organism.json"));
  for (const a of Object.values(dna.anatomy)) for (const p of [a.main, a.wrangler]) assert.ok(guardReason(p), `${p} (organism.json) is guarded`);
});

test("G4. routine code stays routine: features, their tests and the README need no owner click", () => {
  for (const path of ["src/reader.mjs", "src/knowledge.mjs", "src/weighting.mjs", "src/store.mjs", "test/a6.test.mjs", "README.md", "scripts/check-health.mjs"]) {
    assert.ok(FILES.includes(path), `${path} exists`);
    assert.equal(guardReason(path), null, path);
  }
  // No pattern guards a whole code directory: each keeps routine files.
  for (const dir of ["src/", "test/", "scripts/"]) assert.ok(FILES.some((f) => f.startsWith(dir) && !guardReason(f)), `${dir} keeps routine files`);
});

test("G5. AGENTS.md states how agents may change Aether and points to this list", () => {
  const agents = read("AGENTS.md");
  const i = agents.indexOf("## How agents may change Aether");
  assert.ok(i >= 0, "AGENTS.md has the section");
  const section = agents.slice(i).split(/\n## /)[0];
  for (const word of ["guard-paths.json", "organism.json", "read-only", "Knowledge Council", "fund"]) assert.ok(section.toLowerCase().includes(word.toLowerCase()), `the section mentions ${word}`);
});
