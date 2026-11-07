// Idempotently provisions Aether's Vectorize indexes and their metadata indexes (phase A4), the way
// the platform's ensure-vectorize-index.sh does for its agent memory. Run by the deploy workflow
// (.github/workflows/deploy.yml) before `wrangler deploy`; it needs a token with Vectorize edit permission.
// Never deletes or changes an existing index; fails closed when dimensions, metric or a metadata
// index type differ. Metadata indexes are created before any vector is inserted (Vectorize filters
// only on metadata indexes that existed when the vectors were written).
import { execFileSync } from "node:child_process";

export const INDEXES = Object.freeze([
  { name: "aether-canon", dimensions: 384, metric: "cosine", metadata: [["part", "string"], ["canon", "string"]] },
  { name: "aether-market", dimensions: 384, metric: "cosine", metadata: [["kind", "string"], ["chart", "string"], ["session", "string"], ["stance", "string"], ["day", "number"]] }
]);

const wrangler = (args) => execFileSync("npx", ["--yes", "wrangler@4.45.0", "vectorize", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

/**
 * The JSON of a `wrangler vectorize ... --json` stdout. Wrangler 4.45 prints a progress line
 * ("📋 Listing Vectorize indexes...") before the JSON, and prints no JSON at all when the list is
 * empty (only a warning on stderr), so an empty list is []. Anything else that does not parse throws.
 */
export function parseWranglerJson(stdout) {
  const lines = String(stdout ?? "").split("\n");
  const start = lines.findIndex((l) => /^\s*[[{]/.test(l));
  if (start < 0) return [];
  return JSON.parse(lines.slice(start).join("\n"));
}
const json = (args) => parseWranglerJson(wrangler([...args, "--json"]));
const fail = (msg) => { console.error("ensure-vectorize: " + msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const metaList = (j) => (Array.isArray(j) ? j : j?.metadataIndexes ?? j?.metadata_indexes ?? j?.result?.metadataIndexes ?? []);

async function ensure(spec) {
  const existing = json(["list"]).find((i) => i.name === spec.name);
  if (existing) {
    const dims = existing.config?.dimensions ?? existing.dimensions, metric = existing.config?.metric ?? existing.metric;
    if (Number(dims) !== spec.dimensions || String(metric) !== spec.metric) fail(`${spec.name} exists with ${dims}d/${metric}, expected ${spec.dimensions}d/${spec.metric}; refusing to modify`);
    console.log(`${spec.name}: exists (${dims}d, ${metric})`);
  } else {
    wrangler(["create", spec.name, "--dimensions", String(spec.dimensions), "--metric", spec.metric]);
    console.log(`${spec.name}: created`);
  }
  for (const [prop, type] of spec.metadata) {
    const has = () => metaList(json(["list-metadata-index", spec.name])).find((m) => (m.propertyName ?? m.property_name) === prop);
    let entry = has();
    if (!entry) {
      wrangler(["create-metadata-index", spec.name, "--propertyName", prop, "--type", type]);
      for (let i = 0; i < 10 && !(entry = has()); i++) await sleep(3000);
      if (!entry) fail(`${spec.name}.${prop}: metadata index not visible after creation`);
    }
    const actual = String(entry.indexType ?? entry.index_type ?? "").toLowerCase();
    if (actual !== type) fail(`${spec.name}.${prop}: metadata index type ${actual}, expected ${type}; refusing to modify`);
    console.log(`${spec.name}.${prop}: ${type}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  for (const spec of INDEXES) await ensure(spec);
}
