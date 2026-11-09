// Post-deploy check (deploy.yml). Aether has no public URL since 2026-11-09 (workers_dev false), so the
// check reads the Cloudflare API instead of /health: the active deployment serves 100 % of traffic with
// the version this run deployed (created after the deploy step began; Wrangler 4.45's deploy takes no
// --tag, so a tag is compared only when one is set), and workers.dev stays off. The runtime view
// (canon, cards, weighting) is on the Nexus Aether page. Reads only; prints no secret.
//   env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, DEPLOY_STARTED_MS (when the deploy step started),
//        optional COMMIT_TAG (compared with the version's workers/tag annotation when both exist)

const SCRIPT = "cryptophys-aether";

/** Pure: the problems of the deployment the API reports (empty when it is this commit's). */
export function deploymentProblems({ deployment, version, subdomain, tag, startedMs }) {
  const out = [];
  const versions = deployment?.versions || [];
  if (!deployment) out.push("no active deployment");
  else if (versions.length !== 1 || versions[0].percentage !== 100) out.push(`traffic split ${JSON.stringify(versions.map((v) => [v.version_id, v.percentage]))}`);
  const versionTag = version?.annotations?.["workers/tag"] ?? version?.metadata?.annotations?.["workers/tag"] ?? null;
  if (tag && versionTag != null) {
    if (versionTag !== tag) out.push(`active version tag ${versionTag} != ${tag}`);
  } else {
    const created = Date.parse(deployment?.created_on ?? "");
    if (!(Number.isFinite(created) && Number.isFinite(startedMs) && created >= startedMs - 60_000)) out.push("active deployment is not from this run (no version tag to compare)");
  }
  if (subdomain?.enabled !== false) out.push(`workers.dev is ${subdomain?.enabled === true ? "on" : "unknown"}`);
  return out;
}

async function api(path) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${SCRIPT}${path}`, {
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(`${path}: HTTP ${res.status}`);
  return body.result;
}

async function main() {
  const tag = process.env.COMMIT_TAG;
  const startedMs = Number(process.env.DEPLOY_STARTED_MS);
  let last = "no answer";
  for (let i = 0; i < 6; i++) {
    try {
      const deployments = ((await api("/deployments"))?.deployments || []).slice().sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
      const deployment = deployments[0] ?? null;
      const versionId = deployment?.versions?.[0]?.version_id;
      const version = versionId ? await api(`/versions/${versionId}`) : null;
      const subdomain = await api("/subdomain");
      const problems = deploymentProblems({ deployment, version, subdomain, tag, startedMs });
      if (!problems.length) { console.log(`active: version ${versionId}, deployed ${deployment.created_on}, 100 % of traffic; workers.dev off`); return; }
      last = problems.join("; ");
    } catch (err) { last = String(err?.message ?? err); }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.error(`deployment check failed: ${last}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await main();
