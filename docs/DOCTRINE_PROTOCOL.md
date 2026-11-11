# Doctrine protocol: the Knowledge Council and Cerebrum (owner 2026-11-11)

Owner: "autonomous doctrine protocol harus dilakukan oleh knowledge council, dilakukan harian dan di
propose ke cerebrum untuk eksekusinya."

The doctrine (`canon/doctrine.json`, v2) is what Aether checks the agents against and what the canon
index serves. A doctrine that no longer describes the running system biases every check and every
retrieval. The protocol keeps it current. No single seat can change it, and it never writes doctrine
text with a model.

## The doctrine v2

- **Two classes.**
  - `constitutional`: the execution boundary, no levels to the kernel, the kernel rules, parity trust,
    fail-closed WAIT, learned is not canon, promotion by the owner, and this protocol.
  - `operational`: the Decision Engine, its thresholds, confirmation, the rooms, weighting, the event
    caution and Omega's gates.
- **Anchors.** A rule may anchor *facts*: values the running system reports, such as
  `decision.quorum_min` or `omega.max_spread_points`. The rule text is its reviewed `template` with
  the anchors' values. The canon test proves that `rule` equals the rendered `template`.
- **Retired rules.** They are kept in `retired`, with what superseded them and why. They are never
  indexed and never checked.

## The seats

| Seat | Who | What it does |
|---|---|---|
| Nexus | the xauusd AI Worker | Every hour it reports the decision-side facts it runs with (Decision Engine, rooms, weighting, calendar, parity, lanes), tagged with its deployed version id. Sent through `KnowledgeIngress.ingestDoctrineFacts`. |
| Omega | the Omega engine, inside the AI Worker | In the same hourly report, the execution facts in force: the stored Omega settings and the fixed gates. |
| Aether | the canon keeper | Checks that the rule is in force, renders the text from the template, and checks that every operational value sits inside its hard bound (the mirror of the platform's bounds). |
| Cerebrum | the platform kernel | Its consensus votes on the proposal, its Policy Engine can veto it, and the kernel executes it. |

## One day

1. **03:52 UTC: the session** (`runCouncil`, agent `knowledge-council`).
   - The council first reads the amendments Cerebrum executed (`doctrine.status`).
   - It then compares every anchored fact of the doctrine in force with the latest facts report
     (at most 3 hours old).
2. **Each differing rule gets a status:**
   - `observing`: the reporting seat agrees only when it measured the new value twice, at least
     45 minutes apart, from the same deployed version. Until then the rule waits.
   - `refused`: the Aether seat refuses an operational value outside its hard bound.
   - `unreported`: a fact the system no longer reports. The code changed shape, and only an owner PR
     can update the canon.
   - `propose`: every seat involved agrees.
3. **Proposal to Cerebrum** (`consensus.propose`). At most 3 a session. The same rule and values are
   not proposed again for 7 days.
   - `amend_doctrine` (routine): operational facts only, each inside its hard bound
     (platform `control-plane-shared/src/doctrine.ts`). It executes after the vote, in consensus mode
     `routine` or higher.
   - `amend_constitution` (critical): a constitutional rule, or a fact without a bound (for example a
     guardrail list). It executes only after one owner approval click, in mode `critical`.
4. **Cerebrum executes.**
   - The kernel records the amendment in `doctrine_amendments`, together with the audit event
     `doctrine.amended`.
   - Only the `knowledge-council` agent may propose doctrine amendments, and it may propose nothing
     else.
5. **Every hour: apply** (`syncAmendments`).
   - Aether applies only the amendments Cerebrum executed against the current canon.
   - The rule is re-rendered and the canon index is re-embedded (the effective hash changes).
   - The amendment shows on the Aether page and the Cerebrum Knowledge page.
6. **Codify.** The orchestrator folds executed amendments into `canon/doctrine.json` by a reviewed PR.
   An amendment made against an earlier canon is then superseded and no longer applied.
7. **Report.** Each session publishes one `knowledge_audit` report to the kernel: `info`, or `warning`
   when a rule is refused or unreported.

## Switches

- **`KNOWLEDGE_COUNCIL`** (Aether variable): `propose` (default), `observe` (review only) or `off`.
- **The Cerebrum consensus mode.**
  - `shadow`: records the vote and executes nothing.
  - `routine`: executes `amend_doctrine`.
  - `critical`: also brings `amend_constitution` to the owner.
- **The kernel kill switch** stops everything.
