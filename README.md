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

## Interfaces (phase A2)

- `GET /health`: status, the canon version and hash, and card counts. It never returns card content.
- `GET /canon`: the canon's version, its file hashes and the doctrine.
- `RPC KnowledgeIngress`, reached through a Service Binding from the xauusd AI Worker in phase A5:
  - `ingestCards(cards)`: stores `cryptophys.decision-card.v1` cards, at most 50 per call. Any card carrying a level or a price is refused.
  - `canonInfo()`: the canon's version and hashes.

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
