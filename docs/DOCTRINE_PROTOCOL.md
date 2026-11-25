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
   - `observing`: the reporting seat agrees only when it measured the same new value twice, at least
     45 minutes apart. Until then the rule waits. The deployed versions of both reports are kept as
     evidence; a redeploy between them does not reset the count (owner 2026-11-11: xauusd deploys
     several times a day).
   - `refused`: the Aether seat refuses an operational value outside its hard bound.
   - `unreported`: a fact the system no longer reports. The code changed shape, and only an owner PR
     can update the canon.
   - `propose`: every seat involved agrees.
3. **Proposal to Cerebrum** (`consensus.propose`). At most 3 a session. The same rule and values are
   not proposed again for 7 days while the owner has not decided or has refused. A proposal Cerebrum
   executed reads `executed` in `council_proposals` from the next hourly sync (`markExecutedProposals`)
   and no longer counts: if its drift comes back, a canon change dropped it, and it is proposed again.
   - `amend_doctrine` (routine): operational facts only, each inside its hard bound
     (platform `control-plane-shared/src/doctrine.ts`). It executes after the vote, in consensus mode
     `routine` or higher.
   - `amend_constitution` (critical): a constitutional rule, or a fact without a bound (for example a
     guardrail list). It executes only after one owner approval click, in mode `critical`.
   Before the cooldown is read, the council reads its own open proposals of the last 7 days back through
   `consensus.status` (tier 0, its own proposals only, at most 50 ids a call, ids of the kernel's shape
   `cns_<uuid>`; `syncProposalStatuses`):
   - `rejected` or `expired` is stored on the row; a final row is never overwritten and not read again.
     Both keep the 7-day cooldown, like an undecided proposal (orchestrator ruling on aether#45: re-asking
     an ignored proposal every ~48 h would ask the owner about 15 times a month per rule).
   - Only `executed` lifts the cooldown. `consensus.status` never writes executed; only the propose answer
     (a routine amendment executed at the vote) or `markExecutedProposals` (once the amendment is in
     `doctrine_applied`) does, so a transient `doctrine.status` failure cannot lead to the same values
     being proposed twice.
   - `not_found` (unknown to the platform) and `pending_owner` change nothing, so the cooldown holds
     (fail closed). A `pending_owner` past its `expires_at` counts as pending until the platform's sweep
     makes it read `expired`.
   - A denial (the capability not granted yet) changes nothing and waits 6 hours
     (`aether_meta` key `council_status_backoff_until`), as `corrections.read` does.
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

## Omega's policy (B-12, 2026-11-11)

- `KnowledgeIngress.omegaPolicy()` gives the xauusd Worker the Omega facts of the doctrine in force,
  each within its fact's bound: the spread and the signal age, and since ADR-0020 Amendment 10
  (aether#40, 2026-11-22) the limits per account profile (`risk_pct_<profile>`,
  `max_daily_loss_pct_<profile>`, `max_positions_<profile>`) as information. The single risk %,
  positions and daily loss % are no longer in it.
- An executed amendment of the spread or the signal age therefore reaches Omega's settings within an
  hour, but only while the owner's switch `OMEGA_POLICY_AUTO` is on in xauusd. xauusd does not apply the
  per-profile values: its own profile caps (`effectiveLimits`) and the owner's settings decide the risk.

## The Mizan witness (AE2, 2026-11-25)

Owner 2026-11-23, relayed by the coordinator: "Setuju ketiganya", "Versi netral", "Sebelum parity", "Council naik,
auto mati". xauusd builds the witness (MZ1); Aether holds its doctrine.

- **`mizan_witness`** (operational): the Mizan Oracle votes in the Decision Engine at a share of the witness weight per
  trading mode, 0.02 each to start. Its seven facts (`mizan.de_weight_<mode>`, `mizan.score_floor`,
  `mizan.score_window`, `mizan.min_readings`) have the platform's PF2 bounds (`MIZAN_BOUNDS`), so the council amends
  them as routine, the weights only inside 0 to 0.04.
- **`parity_trust_only`** (constitutional) gains the text of one exception, anchored by `parity.mizan_before_parity`,
  `off` in the canon: when on, the witness votes while its parity group runs alongside, and a mismatch freezes it at 0
  until 24 consecutive matches. xauusd reports what its code does, so `false` until the amendment is in force. The
  `amend_constitution` is raised on the owner's request, shows as `pending_owner`, and only the owner's click executes
  it. A report never raises it: a drift of `parity.mizan_before_parity` (`OWNER_RAISED_FACTS`) is refused, with a
  warning.
- **Timing.** Until xauusd reports the eight facts, both rules read `unreported`, so this lands with MZ1.

## Switches

- **`KNOWLEDGE_COUNCIL`** (Aether variable): `propose` (default), `observe` (review only) or `off`.
- **The Cerebrum consensus mode.**
  - `shadow`: records the vote and executes nothing.
  - `routine`: executes `amend_doctrine`.
  - `critical`: also brings `amend_constitution` to the owner.
- **The kernel kill switch** stops everything.
