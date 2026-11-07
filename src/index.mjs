// cryptophys-aether: the Knowledge Guardian cluster (RFC_AETHER_KNOWLEDGE_GUARDIAN, phase A2).
//   GET /health   status, the canon version and hash, and card counts (no card content)
//   GET /canon    the canon's version, file hashes and the doctrine (public reference)
//   RPC KnowledgeIngress (Service Binding from the xauusd AI Worker, phase A5): ingestCards, canonInfo
// No secret anywhere: callers reach the RPC only through a Service Binding in this account.
// Advisory only. Aether never writes to the xauusd repository or its data.
import { WorkerEntrypoint } from "cloudflare:workers";
import { CANON } from "./canon.generated.mjs";
import { ingestCards, cardCounts } from "./store.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const canonInfo = () => ({ version: CANON.version, content_sha256: CANON.content_sha256, files: CANON.files, kb_version: CANON.indicator.kb_version, kb_content_sha256: CANON.indicator.kb_content_sha256 });

export class KnowledgeIngress extends WorkerEntrypoint {
  /** Decision cards (cryptophys.decision-card.v1), at most 50 per call. */
  async ingestCards(cards) { return ingestCards(this.env.AETHER_DB, cards); }
  async canonInfo() { return canonInfo(); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "read-only" }, 405);
    if (url.pathname === "/" || url.pathname === "/health") {
      let cards = null;
      try { cards = env.AETHER_DB ? await cardCounts(env.AETHER_DB) : null; } catch { cards = { error: "unavailable" }; }
      return json({ service: "cryptophys-aether", status: "ok", phase: "A2", canon: { version: CANON.version, content_sha256: CANON.content_sha256 }, cards });
    }
    if (url.pathname === "/canon") return json({ ...canonInfo(), doctrine: CANON.doctrine.rules });
    return json({ error: "not_found", endpoints: ["GET /health", "GET /canon", "RPC KnowledgeIngress"] }, 404);
  }
};
