// cryptophys-aether: the Knowledge Guardian cluster (RFC_AETHER_KNOWLEDGE_GUARDIAN, phase A2).
//   GET /health   status, the canon version and hash, and card counts (no card content)
//   GET /canon    the canon's version, file hashes and the doctrine (public reference)
//   RPC KnowledgeIngress (Service Binding from the xauusd AI Worker, phase A5): ingestCards, canonInfo
//   cron :52 every hour (phase A4): canon sync into aether-canon (once per canon version), card
//   embedding into aether-market; at 01:52 UTC the guardian and auditor digest to the kernel.
// No secret anywhere: callers reach the RPC only through a Service Binding in this account.
// Advisory only. Aether never writes to the xauusd repository or its data.
import { WorkerEntrypoint } from "cloudflare:workers";
import { CANON } from "./canon.generated.mjs";
import { ingestCards, cardCounts } from "./store.mjs";
import { syncCanon, embedPendingCards, indexStatus } from "./indexes.mjs";
import { runDigest } from "./guardian.mjs";
import { budgetUsed } from "./budget.mjs";

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
      let cards = null, indexes = null, ai = null;
      try { cards = env.AETHER_DB ? await cardCounts(env.AETHER_DB) : null; } catch { cards = { error: "unavailable" }; }
      try { indexes = env.AETHER_DB ? await indexStatus(env) : null; } catch { indexes = { error: "unavailable" }; }
      try { ai = env.AETHER_DB ? { used_today: await budgetUsed(env), daily_limit: Number(env.AI_DAILY_LIMIT) || 60 } : null; } catch { ai = { error: "unavailable" }; }
      return json({ service: "cryptophys-aether", status: "ok", phase: env.AETHER_PHASE ?? "A4", canon: { version: CANON.version, content_sha256: CANON.content_sha256 }, cards, indexes, ai });
    }
    if (url.pathname === "/canon") return json({ ...canonInfo(), doctrine: CANON.doctrine.rules });
    return json({ error: "not_found", endpoints: ["GET /health", "GET /canon", "RPC KnowledgeIngress"] }, 404);
  },

  /** Hourly at :52. Every step is non-fatal and bounded by the AI budget. */
  async scheduled(controller, env, ctx) {
    const now = controller?.scheduledTime ?? Date.now();
    const step = async (name, fn) => { try { console.log("aether_" + name, JSON.stringify(await fn())); } catch (e) { console.error("aether_" + name + "_failed", String(e?.message ?? e).slice(0, 200)); } };
    ctx.waitUntil((async () => {
      await step("canon_sync", () => syncCanon(env, { now }));
      await step("embed_cards", () => embedPendingCards(env, { now }));
      if (new Date(now).getUTCHours() === 1) await step("digest", () => runDigest(env, { now }));
    })());
  }
};
