# Rules for every coding agent (Claude, Codex, Copilot, …)

Aether is the Knowledge Guardian cluster of the Cryptophys AI Mesh. Design: RFC_AETHER_KNOWLEDGE_GUARDIAN in `cryptophys-adm/xauusd-ai-trading-assistant` (`docs/`).

1. **Advisory only.** No broker, no orders, no position size, and no price level in anything Aether stores, embeds or reports. Decision cards are refused when they carry one (`src/card-guard.mjs`).
2. **Deploy only by merging to `main`** (GitHub Actions, `.github/workflows/deploy.yml`; the token is the repository secret `CLOUDFLARE_API_TOKEN`). Never run `wrangler deploy`, `wrangler delete` or `wrangler secret put` by hand, and never write to production D1 or Vectorize by hand.
3. **No secrets.** Inter-Worker calls use RPC Service Bindings only. Never commit a credential.
4. **The canon changes only by a reviewed PR.** Edit `canon/*.json`, run `npm run canon:build`, and commit both. KB v4 (`canon/indicator/kb-v4.json`) is imported from xauusd as is and never edited here.
5. **Learned is not canon.** Learned knowledge is labelled as learned, cites its evidence and never redefines a canon field or rule. Promotion follows the owner's decision of 2026-11-13 ("buat agar autonomous"): an undecided text proposal (caution, role reminder) is shadow-tested in xauusd without waiting for a person (`KNOWLEDGE_AUTO_SHADOW`), and xauusd activates a text item by itself only on its own shadow verdict (better than active, Holm-adjusted, holdout no worse), for exactly the agents and chart it was tested on, and retires it by itself when it stops helping; a person's rejection removes it at once. Parameter and weighting items still need a person, and nothing ever becomes canon. The other exception, by the owner's decisions of 2026-11-09, is the room quorum weighting (canon rule `weighting_auto`): xauusd tunes and activates it automatically per timeframe and regime; Aether only audits its reports and proposes no weighting point. The grid (`src/weighting.mjs`) mirrors xauusd's and changes only by a reviewed PR in both repositories.
6. **Platform kernel rules.** Reports are `info` or `warning`, never `critical`. A denial is final: no retry, no switching agent ids. Never change `host_worker`.
7. **Aether never writes to xauusd** (its repository, D1, KV or Workers).

## How agents may change Aether
Owner 2026-11-14: "ya, Aether perlu DNA, tes CI, dan file yang dilindungi sendiri lebih dulu sebelum boleh diubah oleh agen".
- **Read-only until the bootstrap is merged.** Until the owner merges the PR that adds `organism.json`, `guard-paths.json` and their tests, agents only read Aether: no commit, branch or PR here by an agent other than that bootstrap PR itself.
- **Only through this repository's CI.** Every change is a PR whose `ci` workflow passes, the DNA tests included (`test/organism-dna.test.mjs`: `organism.json` equals `wrangler.jsonc` and `src/`). A new binding, cron, agent, AI model or entrypoint needs its line in `organism.json` in the same PR.
- **Guard paths need the owner.** A change that touches a path in `guard-paths.json` (the doctrine and canon, the DNA and this list, the CI workflows and test config, the entrypoints in `src/index.mjs`, `wrangler.jsonc`, the deploy scripts, these rules) is merged only by the owner's click or merge, never by an agent or by consensus alone.
- **No fund movement.** Nothing in Aether moves funds, places orders or reaches a broker (rule 1).
- **Doctrine changes go through the Knowledge Council.** An operational doctrine value changes only by the council's proposal and Cerebrum's execution (`docs/DOCTRINE_PROTOCOL.md`), folded into the canon by a reviewed PR (rule 4); no agent edits a doctrine rule directly.

## Before opening a PR
- `npm test` (it includes the canon staleness check).
- `npx wrangler@4.45.0 deploy --dry-run` (CI runs it too).
