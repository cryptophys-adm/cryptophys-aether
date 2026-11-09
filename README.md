# Aether

Aether is the Knowledge Guardian cluster of the Cryptophys AI Mesh (Worker `cryptophys-aether`). It covers decision audit, agent compliance, the Aether Canon (master knowledge) and learned knowledge for the XAUUSD advisory system.

- **Design:** [RFC_AETHER_KNOWLEDGE_GUARDIAN](https://github.com/cryptophys-adm/xauusd-ai-trading-assistant/blob/main/docs/RFC_AETHER_KNOWLEDGE_GUARDIAN.md).
- **Rules:** [AGENTS.md](AGENTS.md).
- **Advisory only:** no broker, no orders, no position size, no price levels.

## State machine vs state market

| | State machine | State market |
|---|---|---|
| What it is | The platform itself: Workers, deployments, drift, agents, approvals, the audit chain | The market and the system's judgements: room conclusions, decisions, outcomes, knowledge |
| Who owns it | The platform kernel and control plane | xauusd (live data) and Aether (memory and knowledge) |

Aether keeps its own D1 and, from phase A4, its own Vectorize indexes (`aether-canon`, `aether-market`). They are separate from the kernel's agent memory.

## Aether Canon (master knowledge)

The canon changes only by a reviewed PR. It has four parts:

| File | Content |
|---|---|
| `canon/indicator/kb-v4.json` | KB v4, imported from xauusd as is and pinned by its hash |
| `canon/doctrine.json` | The owner's rules in force, each with its source |
| `canon/roles.json` | Each agent's role, from the xauusd manifests |
| `canon/definitions.json` | The fixed yardsticks: scoring v3, stuck states, reputation, shadow promotion, parity, compliance checks, decision-card fields |

`npm run canon:build` bundles the canon into `src/canon.generated.mjs`, with a content hash over every file.

## Interfaces

- `GET /health`: status, the canon version and hash, card counts, index status, and AI budget use. It never returns card content. Since 2026-11-09 Aether has no public URL (`workers_dev` and `preview_urls` false), so `/health` is not reachable from outside; the same data is on the Nexus Aether page (`AetherReader`).
- `GET /canon`: the canon's version, its file hashes and the doctrine.
- `RPC AetherReader`, reached through a Service Binding from the Nexus Worker: `overview()` for the Aether page at `nexus.cryptophys.work/aether` (owner 2026-11-09; behind the same Cloudflare Access sign-in as Nexus). It is read-only and returns the canon and its doctrine, card counts and the ingest log, the index status, the AI budget, the knowledge proposals, the guardian's compliance findings of the last 24 hours, and each timeframe's weighting report (`src/reader.mjs`). It never returns a price.
- `RPC KnowledgeIngress`, reached through a Service Binding from the xauusd AI Worker in phase A5:
  - `ingestCards(cards)`: stores `cryptophys.decision-card.v1` cards, at most 50 per call. Any card carrying a level or a price is refused.
  - `canonInfo()`: the canon's version and hashes.
  - `learnedPack()`: the approved learned pack (phase A6).
  - `ingestWeightingReport(report)`: xauusd's room quorum weighting replay of one timeframe (`cryptophys.weighting-report.v1`, `mode: "auto"`), when it changed; the latest valid report of each timeframe is kept in D1 `weighting_reports_tf` as an audit. A report with a price, level or size key is refused.

## Phase A4: indexes, guardian and auditor

**Vectorize indexes.** Both are owned by Aether, use 384 dimensions and cosine distance, and are provisioned by `scripts/ensure-vectorize.mjs`.

| Index | Binding | Holds | Metadata indexes |
|---|---|---|---|
| `aether-canon` | `CANON_INDEX` | Canon chunks, one set per canon version | `part`, `canon` |
| `aether-market` | `MARKET_INDEX` | Decision cards, namespace `decision` | `kind`, `chart`, `session`, `stance`, `day` |

**Embeddings.** `@cf/baai/bge-small-en-v1.5`, in batches of 50. Each batch counts as one request against `AI_DAILY_LIMIT` (60 a day), and the count is kept in D1.

**Cron, every hour at :52:**
- Sync the canon. This embeds the canon only when its version changes.
- Embed new or updated cards.
- At 01:52 UTC, publish two daily reports to the kernel as `knowledge_audit`, through `AGENTS` (AgentRpc, host `cryptophys-aether`):
  - **Guardian:** compliance per agent and check. It is a `warning` from 20 rule breaks per 100 messages.
  - **Auditor:** repeated failures, meaning a missed call whose 5 most similar past situations hold 3 or more misses by the same agent.

Findings are deterministic; no AI decides them. Reports are advisory and never `critical`.

**Provisioning.** The deploy workflow runs `npm run ensure:vectorize` before `wrangler deploy`. It creates both indexes and their metadata indexes when they are missing, never deletes or changes one, and fails closed when an existing index differs.

## Phase A6: learned knowledge (curator and calibrator)

`src/knowledge.mjs` runs deterministic rules over the stored decision cards (RFC §9.2). No AI decides a candidate.

| Agent | Rule | Item |
|---|---|---|
| `aether-curator` | **Role drift:** over 7 days of cards (at least 6 days apart), an agent breaks one check in more than 5% of 20 or more rooms it spoke in, in 10 or more rooms | `role_reminder` |
| `aether-curator` | **Agent pattern:** over 30 days, an agent is wrong more often in one chart and session than in its other situations (one-sided exact binomial p < 0.05, 12 or more decisive calls) | `caution` |
| `aether-calibrator` | **Engine pattern:** 3 or more stuck episodes of a tuning family on the hourly cards in 30 days | `param_candidate`: the next untested point of `TUNING_GRID`, one open proposal per family |
| `aether-calibrator` | **Weighting pattern**: retired the same day (owner decisions 2026-11-09): xauusd now tunes and activates its weighting automatically (`mode: "auto"`), so the calibrator proposes no weighting point; a report without that mode is still handled as before | none in auto mode |

How a candidate travels:

- **Proposed:** each candidate goes to the platform kernel with `knowledge.propose` (tier 1). The kernel validates it again (platform TP-028).
  - The text is plain words with no 3-digit number, so rates are said in percent and counts stay in the evidence.
  - The item cites 10 or more cards and the canon hash.
- **Reviewed:** a person approves it for shadow testing, or rejects it, on the Console Knowledge page. `knowledge.status` brings the decision back every hour.
- **Exported:** approved items form the **learned pack**, the RPC `KnowledgeIngress.learnedPack()`. It is labelled learned, is used for shadow testing only, and never appears in a live prompt.
- **Promoted:** only by an owner PR in xauusd (A7 to A9). The room quorum weighting is the exception: xauusd tunes it automatically per timeframe and regime (owner decisions 2026-11-09), and Aether audits it.

Limits:
- At most 3 proposals per agent per run, once a day at 02:52 UTC.
- A rejected or refused item is not proposed again for 14 days.
- A denial ends the run, with no retry.

`/health` shows the ledger counts under `knowledge`, and the latest weighting report of each timeframe under `weighting` (when it arrived, its mode, the active point, the regimes, the candidates rated better, the last change).

## Phases

| Phase | Content |
|---|---|
| A2 | Worker, D1 `aether-knowledge`, `KnowledgeIngress`, Canon v1, CI |
| A3 | Platform registers the `cryptophys-aether` host and its agents; the `AGENTS` binding |
| A4 | Vectorize `aether-canon` and `aether-market`, batched embeddings, the auditor and guardian loops |
| A5 | xauusd pushes its cards here |
| A6 (live) | Curator and calibrator: tier 1 proposals and the approved learned pack |
| A8 weighting | xauusd's H1 quorum weighting report; the calibrator's weighting proposals (approval activates) |

## Deploy

Deploys run only by merging to `main`, through GitHub Actions (`.github/workflows/deploy.yml`): tests, the canon check, `ensure:vectorize`, `wrangler deploy` (4.45.0), then `scripts/check-deployment.mjs`: through the Cloudflare API, the active deployment was created by this run and serves 100 % of traffic, and workers.dev stays off. (Aether has no public URL since 2026-11-09, so the former `/health` check no longer applies; `scripts/check-health.mjs` stays for a check through `wrangler dev`.) Pull requests run `ci.yml` only (tests and a dry run) and never see the token. The owner sets the repository secret `CLOUDFLARE_API_TOKEN` once; it needs Workers Scripts, D1 and Vectorize edit rights on the account (Workers Scripts read covers the deployment check).

On the first deploy, Wrangler creates the D1 database `aether-knowledge` and links it to the Worker (automatic resource provisioning).
