# Rules for every coding agent (Claude, Codex, Copilot, …)

Aether is the Knowledge Guardian cluster of the Cryptophys AI Mesh. Design: RFC_AETHER_KNOWLEDGE_GUARDIAN in `cryptophys-adm/xauusd-ai-trading-assistant` (`docs/`).

1. **Advisory only.** No broker, no orders, no position size, and no price level in anything Aether stores, embeds or reports. Decision cards are refused when they carry one (`src/card-guard.mjs`).
2. **Deploy only by merging to `main`** (Cloudflare Workers Builds). Never run `wrangler deploy`, `wrangler delete` or `wrangler secret put` by hand, and never write to production D1 or Vectorize by hand.
3. **No secrets.** Inter-Worker calls use RPC Service Bindings only. Never commit a credential.
4. **The canon changes only by a reviewed PR.** Edit `canon/*.json`, run `npm run canon:build`, and commit both. KB v4 (`canon/indicator/kb-v4.json`) is imported from xauusd as is and never edited here.
5. **Learned is not canon.** Learned knowledge is labelled as learned, cites its evidence and never redefines a canon field or rule. Nothing is promoted automatically: the owner promotes by PR in xauusd.
6. **Platform kernel rules.** Reports are `info` or `warning`, never `critical`. A denial is final: no retry, no switching agent ids. Never change `host_worker`.
7. **Aether never writes to xauusd** (its repository, D1, KV or Workers).

## Before opening a PR
- `npm test` (it includes the canon staleness check).
- `npx wrangler@4.45.0 deploy --dry-run` (CI runs it too).
