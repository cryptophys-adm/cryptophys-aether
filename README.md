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

- `GET /health`: status, the canon version and hash, card counts, index status, and AI budget use. It never returns card content.
- `GET /canon`: the canon's version, its file hashes and the doctrine.
- `RPC KnowledgeIngress`, reached through a Service Binding from the xauusd AI Worker in phase A5:
  - `ingestCards(cards)`: stores `cryptophys.decision-card.v1` cards, at most 50 per call. Any card carrying a level or a price is refused.
  - `canonInfo()`: the canon's version and hashes.

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

**Provisioning.** The build token needs **Vectorize: Edit**, and the Workers Builds build command is `npm run ensure:vectorize`. It runs before both the deploy command and the preview command.

**Previews.** Pull request builds run `wrangler preview`, which needs the `previews` block in `wrangler.jsonc`. A preview has no cron trigger and no service binding. It serves `/health` and `/canon` only and reads the same indexes; the cron loops are their only writers, and they never run in a preview.

## Phases

| Phase | Content |
|---|---|
| A2 (this) | Worker, D1 `aether-knowledge`, `KnowledgeIngress`, Canon v1, CI |
| A3 | Platform registers the `cryptophys-aether` host and its agents; the `AGENTS` binding |
| A4 | Vectorize `aether-canon` and `aether-market`, batched embeddings, the auditor and guardian loops |
| A5 | xauusd pushes its cards here |
| A6 | Curator and calibrator: tier 1 proposals and the approved learned pack |

## Deploy

Deploys run only by merging to `main`, through Cloudflare Workers Builds. The owner connects the repository once in the Cloudflare dashboard.

On the first deploy, Wrangler creates the D1 database `aether-knowledge` and links it to the Worker (automatic resource provisioning).
