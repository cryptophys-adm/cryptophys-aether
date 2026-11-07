// Post-deploy check (deploy.yml): /health answers ok with the phase and canon this commit carries. Retries while
// the new version propagates. Reads only; prints the health body without any secret.
import { readFileSync } from "node:fs";
import { CANON } from "../src/canon.generated.mjs";

/** The AETHER_PHASE this commit deploys (wrangler.jsonc vars; its comments sit on their own lines). */
export function configuredPhase(text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) {
  return JSON.parse(text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")).vars.AETHER_PHASE;
}

/** Pure: the problems of one /health body against the expected canon (empty when healthy). */
export function healthProblems(body, { canonSha = CANON.content_sha256, phase = configuredPhase() } = {}) {
  const out = [];
  if (body?.phase !== phase) out.push(`phase ${body?.phase} != ${phase}`);
  if (body?.service !== "cryptophys-aether") out.push(`service ${body?.service}`);
  if (body?.status !== "ok") out.push(`status ${body?.status}`);
  if (body?.canon?.content_sha256 !== canonSha) out.push(`canon ${body?.canon?.content_sha256} != ${canonSha}`);
  if (body?.indexes?.error) out.push(`indexes ${body.indexes.error}`);
  return out;
}

async function main(url) {
  let last = "no response";
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
      const body = await res.json();
      const problems = res.ok ? healthProblems(body) : [`http ${res.status}`];
      if (!problems.length) { console.log(JSON.stringify(body, null, 2)); return; }
      last = problems.join("; ");
    } catch (err) { last = String(err?.message ?? err); }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.error(`health check failed: ${last}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await main(process.argv[2]);
