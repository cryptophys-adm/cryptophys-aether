// cryptophys-aether: the Knowledge Guardian cluster (RFC_AETHER_KNOWLEDGE_GUARDIAN, phases A2 to A6).
//   GET /health   status, the canon version and hash, and card counts (no card content)
//   GET /canon    the canon's version, file hashes and the doctrine (public reference)
//   GET /v1/overview  the AetherReader overview over HTTP, for the Cerebrum Console (Service Binding only)
//   RPC AetherReader (Service Binding from the Nexus Worker): overview, read-only, for the Aether page
//     at nexus.cryptophys.work/aether (src/reader.mjs)
//   RPC KnowledgeIngress (Service Binding from the xauusd AI Worker, phase A5): ingestCards, canonInfo,
//     learnedPack (phase A6: the items a person approved, and since 2026-11-13 the undecided text items, for
//     xauusd's shadow testing; xauusd activates one only on its own shadow verdict; a
//     weighting item activates the H1 quorum weighting in xauusd, owner decision 2026-11-09),
//     ingestWeightingReport (the H1 quorum replay, src/weighting.mjs), ingestExecutionReport (the Signal
//     Ledger's plan and Omega policy per trading mode, src/execution.mjs), ingestModelReport (xauusd's
//     self-trained baseline model, src/model.mjs)
//   cron :52 every hour (phase A4): canon sync into aether-canon (once per canon version), card
//   embedding into aether-market, the review status of open knowledge proposals; at 01:52 UTC the
//   guardian and auditor digest to the kernel; at 02:52 UTC the curator and calibrator propose (A6).
// No secret anywhere: callers reach the RPC only through a Service Binding in this account.
// Advisory only. Aether never writes to the xauusd repository or its data.
import { WorkerEntrypoint } from "cloudflare:workers";
import { CANON } from "./canon.generated.mjs";
import { ingestCards, cardCounts } from "./store.mjs";
import { syncCanon, embedPendingCards, indexStatus } from "./indexes.mjs";
import { runDigest } from "./guardian.mjs";
import { budgetUsed } from "./budget.mjs";
import { runCuration, syncReviews, learnedPack, knowledgeCounts } from "./knowledge.mjs";
import { storeWeightingReport, weightingReports } from "./weighting.mjs";
import { storeExecutionReport } from "./execution.mjs";
import { storeModelReport } from "./model.mjs";
import { aetherOverview, aetherSync } from "./reader.mjs";
import { storeFacts, syncAmendments, runCouncil, COUNCIL_HOUR_UTC, omegaPolicy } from "./doctrine.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const canonInfo = () => ({ version: CANON.version, content_sha256: CANON.content_sha256, files: CANON.files, kb_version: CANON.indicator.kb_version, kb_content_sha256: CANON.indicator.kb_content_sha256 });

export class KnowledgeIngress extends WorkerEntrypoint {
  /** Decision cards (cryptophys.decision-card.v1), at most 50 per call. */
  async ingestCards(cards) { return ingestCards(this.env.AETHER_DB, cards); }
  async canonInfo() { return canonInfo(); }
  /** The approved learned pack (phase A6): for xauusd's shadow arm, and the weighting items it activates. */
  async learnedPack() { return learnedPack(this.env); }
  /** Omega's risk policy from the doctrine in force (B-12): pulled hourly by the xauusd Worker. */
  async omegaPolicy() { return omegaPolicy(this.env); }
  /** xauusd's H1 quorum weighting report (cryptophys.weighting-report.v1), hourly; the latest is kept. */
  async ingestWeightingReport(report) { return storeWeightingReport(this.env.AETHER_DB, report); }
  /** The doctrine facts (cryptophys.doctrine-facts.v1), hourly: the Nexus and Omega seats of the Knowledge Council. */
  async ingestDoctrineFacts(facts) { return storeFacts(this.env.AETHER_DB, facts); }
  // The Signal Ledger's execution report (owner 2026-11-12): R per mode and per trade, never a price.
  async ingestExecutionReport(report) { return storeExecutionReport(this.env.AETHER_DB, report); }
  // xauusd's self-trained baseline model (owner 2026-11-13): its scores and features, never a price.
  async ingestModelReport(report) { return storeModelReport(this.env.AETHER_DB, report); }
}

/**
 * Read-only view for the Aether page in Nexus (nexus.cryptophys.work/aether, owner 2026-11-09): the
 * canon, the cards and their ingest, the indexes, the AI budget, the knowledge proposals, the
 * guardian's compliance findings and the weighting reports per timeframe (src/reader.mjs). The Nexus
 * Worker is the only caller, over a Service Binding; nothing here writes or carries a price.
 */
export class AetherReader extends WorkerEntrypoint {
  async overview() { return aetherOverview(this.env); }
  /** The end-to-end sync checks only (cheap): read by the xauusd AI Worker's health alerts every 15 minutes. */
  async sync() { return aetherSync(this.env); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "read-only" }, 405);
    if (url.pathname === "/" || url.pathname === "/health") {
      let cards = null, indexes = null, ai = null, knowledge = null;
      try { cards = env.AETHER_DB ? await cardCounts(env.AETHER_DB) : null; } catch { cards = { error: "unavailable" }; }
      try { indexes = env.AETHER_DB ? await indexStatus(env) : null; } catch { indexes = { error: "unavailable" }; }
      try { ai = env.AETHER_DB ? { used_today: await budgetUsed(env), daily_limit: Number(env.AI_DAILY_LIMIT) || 60 } : null; } catch { ai = { error: "unavailable" }; }
      try { knowledge = env.AETHER_DB ? await knowledgeCounts(env.AETHER_DB) : null; } catch { knowledge = { error: "unavailable" }; }
      let weighting = null;
      try {
        const all = env.AETHER_DB ? await weightingReports(env.AETHER_DB) : [];
        weighting = all.length ? Object.fromEntries(all.map((w) => [w.timeframe, { received_at: w.received_at, mode: w.report.mode ?? null, active: w.report.active?.id ?? null, rooms: w.report.rooms ?? 0, regimes: w.report.regimes ?? null, better: (w.report.candidates || []).filter((c) => String(c.verdict).startsWith("better_than_active")).map((c) => c.id), last_change: (w.report.history || []).filter((h) => h.kind === "activated" || h.kind === "rolled_back").at(-1) ?? null }])) : null;
      } catch { weighting = { error: "unavailable" }; }
      return json({ service: "cryptophys-aether", status: "ok", phase: env.AETHER_PHASE ?? "A6", canon: { version: CANON.version, content_sha256: CANON.content_sha256 }, cards, indexes, ai, knowledge, weighting });
    }
    if (url.pathname === "/canon") return json({ ...canonInfo(), doctrine: CANON.doctrine.rules });
    // The same read-only overview as AetherReader.overview(), for the Cerebrum Console's Knowledge page
    // (owner 2026-11-10). workers_dev is off and there is no route, so only a Service Binding reaches it.
    if (url.pathname === "/v1/overview") return json(await aetherOverview(env));
    return json({ error: "not_found", endpoints: ["GET /health", "GET /canon", "GET /v1/overview", "RPC KnowledgeIngress", "RPC AetherReader"] }, 404);
  },

  /** Hourly at :52. Every step is non-fatal and bounded by the AI budget. */
  async scheduled(controller, env, ctx) {
    const now = controller?.scheduledTime ?? Date.now();
    const step = async (name, fn) => { try { console.log("aether_" + name, JSON.stringify(await fn())); } catch (e) { console.error("aether_" + name + "_failed", String(e?.message ?? e).slice(0, 200)); } };
    ctx.waitUntil((async () => {
      await step("canon_sync", () => syncCanon(env, { now }));
      await step("embed_cards", () => embedPendingCards(env, { now }));
      await step("knowledge_reviews", () => syncReviews(env, { now }));
      // Owner 2026-11-11: the doctrine amendments Cerebrum executed, every hour; the council once a day.
      await step("doctrine_amendments", () => syncAmendments(env, { now }));
      if (new Date(now).getUTCHours() === 1) await step("digest", () => runDigest(env, { now }));
      if (new Date(now).getUTCHours() === 2) await step("curation", () => runCuration(env, { now }));
      if (new Date(now).getUTCHours() === COUNCIL_HOUR_UTC) await step("knowledge_council", () => runCouncil(env, { now }));
    })());
  }
};
