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
- `RPC AetherReader`, reached through Service Bindings from the Nexus Worker and the xauusd AI Worker. `sync()` returns the end-to-end sync checks (`cryptophys.aether-sync.v1`), each ok, warn or idle (idle = the market was closed during the check's window): card ingest within 2 hours, the canon indexed within 2 hours of a change, the embedding backlog under 2 hours, each timeframe's weighting report within its cadence (15m, 1H and the Decision Engine's witness weights 3 hours, 4H 9 hours, D1 50 hours), the AI budget, and the canon's KB hash so xauusd can detect drift; the AI Worker's health alerts read it every 15 minutes. `overview()` for the Aether page at `nexus.cryptophys.work/aether` (owner 2026-11-09; behind the same Cloudflare Access sign-in as Nexus). It is read-only and returns the canon and its doctrine, card counts and the ingest log, the index status, the AI budget, the knowledge proposals, the guardian's compliance findings of the last 24 hours, and each timeframe's weighting report (`src/reader.mjs`). It never returns a price.
- **The Knowledge Council** (owner 2026-11-11, `src/doctrine.mjs`, docs/DOCTRINE_PROTOCOL.md). `KnowledgeIngress.ingestDoctrineFacts` receives the hourly facts of the Nexus and Omega seats. At 03:52 UTC the council compares the doctrine (canon v2: constitutional and operational rules, anchored facts, templates) with them and proposes each difference that its seats agree on to the Cerebrum consensus as the `knowledge-council` agent (`amend_doctrine` inside hard bounds, `amend_constitution` for the owner). Every hour it applies only what Cerebrum executed (`doctrine.status`), re-renders the rule and re-indexes the canon. `KNOWLEDGE_COUNCIL` = propose, observe or off.
- `GET /v1/overview` (owner 2026-11-10): the same overview over HTTP for the Cerebrum Console's Knowledge page, reached only through the console's Service Binding. Besides the above it carries the existing knowledge (`canon.file_list`, `canon.kb` sections and input lanes, `canon.roles`, `canon.definitions`) and the learning progress (`progress.curation`, `cryptophys.aether-curation-progress.v1`: per curator and calibrator rule what the cards hold against its threshold, `ready` exactly when the rule drafts that item; `progress.weighting`: per timeframe the most-paired weighting candidate's discovery rooms against 200 and holdout rooms against the report's required size).
- `RPC KnowledgeIngress`, reached through a Service Binding from the xauusd AI Worker in phase A5:
  - `ingestCards(cards)`: stores `cryptophys.decision-card.v1` cards, at most 50 per call. Any card carrying a level or a price is refused.
  - `canonInfo()`: the canon's version and hashes.
  - `learnedPack()`: the learned pack (phase A6): the approved items and, since 2026-11-13 (owner: "buat agar autonomous", switch `KNOWLEDGE_AUTO_SHADOW`, on), the undecided text items (pending or expired, review `auto`), one version per item.
  - `omegaPolicy()` (B-12, owner 2026-11-11, xauusd issue #227): Omega's risk policy (`cryptophys.omega-policy.v1`), the values of the doctrine in force for `omega.risk_pct`, `omega.max_positions`, `omega.max_daily_loss_pct`, `omega.max_spread_points` and `omega.max_signal_age_min` (the canon plus the amendments Cerebrum executed), each within its fact's bound, with the doctrine's sha and the amendment behind each changed value. Aether invents no value; the xauusd Worker applies the pack only when the owner's `OMEGA_POLICY_AUTO` switch is on, within its own hard bounds.
  - `ingestExecutionReport(report)` (owner 2026-11-12: "kebijakan Omega di Signal Ledger sesuai dengan mode intraday, swing, dan scalping … inputan ke aether dan selanjutnya akan menjadi knowledge"): xauusd's Signal Ledger per trading mode (`cryptophys.execution-report.v1`): the plan (held to its chosen target) and the Omega policy (Omega's entry, the day's gates and its key-level management) on the same Decision Engine signals, per mode the summaries and per trade the quarter-hour bar, session, mode, side, R and exit. A price, level, size or money key, an R beyond 50, or an unknown trade field is refused; the latest valid report is kept in D1 `execution_reports`, shown in `overview().execution`, and read by the curator's execution pattern below.
  - `ingestModelReport(report)` (owner 2026-11-13: "strengthen autonomous learning & knowledge looping"): xauusd's self-trained baseline model (`cryptophys.model-report.v1`, hourly after each retraining): per model (tight or wide label set, long or short) its walk-forward scores (Brier skill against the base rate, AUC, the R of the rows it would pick) and its prospective record (predictions made before each decision, scored after), plus the features it leaned on. Scores and feature names only: a price, level, size, money, weights or scale key, an unknown model or score field, or a feature name outside `[a-z0-9_]` is refused; the latest valid report is kept in D1 `model_reports` and shown in `overview().model`, with (since 2026-11-13, for Cerebrum) the gate state (`promotion`: connected to the Decision Engine council or not, and why), its rules (`gate`) and the learned notes xauusd put live by itself (`live_notes`: ids, agents, chart, dates; never the text), and (since 2026-11-13, owner: "lanjutkan perluas model report gbm ke Aether") the optional `gbm` block: xauusd's daily decision model (LightGBM, shadow only, `connected` always `false`) with its `model_id` (`gbm@…Z`), `trained_at`, `rows`, feature count, `status`, walk-forward checks and prospective record per model id and its top features by `gain`; any other key in it (a tree, a threshold) is refused, and `overview().model.gbm` carries it (null without it). Aether proposes nothing from it yet: the model only advises until xauusd's verdict and the owner promote it.
  - `ingestWeightingReport(report)`: xauusd's room quorum weighting replay of one timeframe (`cryptophys.weighting-report.v1`, `mode: "auto"`), when it changed; the latest valid report of each timeframe is kept in D1 `weighting_reports_tf` as an audit. A report with a price, level or size key is refused. The Decision Engine's witness weights come the same way (owner 2026-11-11: "harusnya bobot itu dinamis sesuai dengan auto tune yang ada di aether"; `cryptophys.witness-weighting-report.v1`, timeframe `engine`): xauusd replays its stored decisions under the witness sets next to the active one and activates or rolls back by itself; Aether checks every set (the 12 witnesses, each 0.02 to 0.28, sum 1) and keeps the report as an audit (sync limit 3 hours). It proposes nothing from it.

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
| `aether-curator` | **Execution pattern** (owner 2026-11-12, `src/execution.mjs`): from xauusd's execution report, over 30 days, per trading mode (scalp, intraday, swing) and session: Omega's management lost more of the same signals than holding them to the plan (`k-exec-plan-<mode>-<session>`), or Omega lost more often in one session than in the mode's other sessions (`k-exec-session-<mode>-<session>`); one-sided exact binomial p < 0.05, 12 or more decisive trades on each side, cited by 10 or more of the quarter-hour cards of those trades | `caution` for `omega` and the moderator |
| `aether-calibrator` | **Engine pattern:** 3 or more stuck episodes of a tuning family on the hourly cards in 30 days | `param_candidate`: the next untested point of `TUNING_GRID`, one open proposal per family |
| `aether-calibrator` | **Weighting pattern**: retired the same day (owner decisions 2026-11-09): xauusd now tunes and activates its weighting automatically (`mode: "auto"`), so the calibrator proposes no weighting point; a report without that mode is still handled as before | none in auto mode |

How a candidate travels:

- **Proposed:** each candidate goes to the platform kernel with `knowledge.propose` (tier 1). The kernel validates it again (platform TP-028).
  - The text is plain words with no 3-digit number, so rates are said in percent and counts stay in the evidence.
  - The item cites 10 or more cards and the canon hash.
- **Reviewed:** a person approves it for shadow testing, or rejects it, on the Console Knowledge page. `knowledge.status` brings the decision back every hour.
- **Exported:** approved items, and the undecided text items (review `auto`), form the **learned pack**, the RPC `KnowledgeIngress.learnedPack()`. It is labelled learned and used for shadow testing; xauusd activates a text item by itself only on its own shadow verdict, for the agents and chart it was tested on, and retires it when it stops helping. A rejection removes an item at once; parameter and weighting items still need a person.
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
