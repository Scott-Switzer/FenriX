# Bakery Bash — Scaling Plan for ~70-Player Session

A concrete, ordered plan for everything that needs to happen between today and a
classroom session of ~70 players / ~25 teams. Built from the load-test data
captured in [PR #98](https://github.com/fenrix-ai/FenriX/pull/98) and the code
audit that followed.

Read top-to-bottom. Tiers are ordered by impact-per-effort. Tick boxes as you
go.

---

## TL;DR

- **PR #98** already eliminates the worst auction-collapse failure mode (sharded
  writes for `topBids` and `recordSubmission`).
- **Tier 1** (no code, ~30 min): deploy + extend phase durations + run snapshot
  watcher during the session. This alone is enough to not crash.
- **Tier 2** (~half day of code): pre-warm + cascade-write fix + practice run.
  Buys real smoothness.
- **Tier 3** (~few hours each, optional): min-instances, prof connection-health
  UI, shard `game.submittedCount`.

---

## What changed in PR #98 (already done)

- ✅ `submitBids` writes to `rounds/{round}/topBidsShards/{0..9}` instead of a
  transactional rewrite of the round doc — eliminates the auction hot-spot.
- ✅ `recordSubmission` shards the `submissions/{docId}` writes the same way.
- ✅ A `concurrency: 1` Firestore trigger aggregates each shard collection back
  to the legacy `rounds/{round}.topBids` (and `submissions/{docId}`) docs the
  FE already listens to. **Frontend contract is unchanged.**
- ✅ `snapshot-game.js` / `watch-and-snapshot.js` / `restore-game.js` for
  per-round snapshots and 1-click rollback.
- ✅ `load-test-auction.js` for characterising future regressions.

### Load-test numbers (legacy → sharded, emulator)

| Scenario | Legacy | Sharded |
|---|---|---|
| 25 teams + 5s rush (realistic) | 21s wall, p95 18s | **4.9s wall, p95 112ms** |
| 25 teams burst | 49s wall, 96% success | **12.6s wall, 100%** |
| 70 teams burst | 70s wall, 16% success, ❌ corrupt | **8.4s wall, 100%, ✅ correct** |

---

## Tier 1 — Must do before the session

### T1.1 — Deploy PR #98 to production

**Why**: this is where the real win lives. Until it's deployed, production has
the legacy code path that fails at scale.

**Steps**
- [ ] Merge PR #98 to `main`
- [ ] `cd games/bakery-bash/backend`
- [ ] `firebase deploy --only functions,firestore:rules --project <prod-project-id>`
- [ ] Verify in the Firebase console that `onTopBidsShardWritten` and
      `onSubmissionShardWritten` show up under Functions → Triggers
- [ ] Smoke-test in production: create a throwaway game, advance to bid_ad,
      place a bid, watch the field land in `rounds/round_1.topBids` via the
      Firestore console

**Effort**: ~10 min
**Risk**: Low. The legacy `updateTopBids` function is left in place (deprecated
but callable) for one release cycle as a rollback safety net.

---

### T1.2 — Extend bid phase durations from 60s → 90s

**Why**: even with the perf fix, the slowest 5% of bids in a 25-team burst land
~12s after the burst starts. A 60s window means a player who clicks submit
in the last 10s might watch their button spin past the timer. 90s gives
margin without dragging the game.

**Steps**
- [ ] Edit `backend/functions/modules/config.js` → `DEFAULT_GAME_CONFIG.phaseDurations`:
      change `bid_ad: 60` to `bid_ad: 90`, `bid_chef: 60` to `bid_chef: 90`
- [ ] If you also want decide phase tuned, consider 300s → 360s
- [ ] Deploy: `firebase deploy --only functions`
- [ ] Verify: a fresh game's `config/params` doc shows the new durations

**Effort**: 5 min
**Risk**: None — pure config change, no behaviour shift.

---

### T1.3 — Run the snapshot watcher during the live session

**Why**: even if everything works, you want a panic button. Per-round snapshots
let you roll back to a known-good state in under a minute.

**Steps**
- [ ] Before class: `cd games/bakery-bash/backend && npm install` (verify deps)
- [ ] Have a service-account credential available (`gcloud auth application-default login`
      or `GOOGLE_APPLICATION_CREDENTIALS` env var)
- [ ] When the game starts, in a terminal:
      `npm run snapshot:watch -- <gameId> --prod`
- [ ] Snapshots land in `./snapshots/<gameId>/snap_round{N}_{phase}_{ts}.json`
- [ ] If something breaks mid-session and you need to rollback:
      `npm run restore -- ./snapshots/<gameId>/latest.json --prod --pause-on-restore --clean`
      then type `RESTORE <gameId>` when prompted
- [ ] Tell players to refresh; their anonymous Firebase Auth UIDs persist so
      they auto-rejoin

**Effort**: 5 min before class + nothing during class (it just runs)
**Risk**: Read-only during the session. Restore is destructive but gated behind
typed confirmation.

---

## Tier 2 — Strongly recommended

### T2.1 — Pre-warm Cloud Functions before the session starts

**Why**: cold-starts add 1–3s to the first call of each function. With 70
players hitting `submitBids` for the first time near-simultaneously, that
extra latency stacks up. Pre-warming amortises it before students notice.

**Plan**
1. Add a `warmFunctions` callable to `backend/functions/index.js` that does
   nothing (just returns `{ok: true}`). One per function we want warm:
   `submitDecision`, `submitBids`, `submitPrices`, `advanceGamePhase`,
   `joinGame`, `createTeam`. Could be one callable that loop-imports each.
2. Add a "Warm up functions" button to the professor page that calls each.
3. Run it ~30 seconds before opening the game to students.

**Steps**
- [ ] Add `exports.warmAll` callable in `index.js`
- [ ] Add button in `app/src/pages/ProfessorPage.tsx` that fires it
- [ ] Test: in dev, click button, observe ~5s while functions warm, then
      subsequent calls are fast

**Effort**: 30–45 min
**Risk**: Low — pure addition.

**Alternative (no code)**: just have the professor manually create a throwaway
game and click through a phase before students arrive. Same effect, less
elegant.

---

### T2.2 — Eliminate team-mate cascade writes

**Why**: every `submitBids` / `submitDecision` cascade-writes the submitting
player's `pendingBids` to all teammates' player docs (so other team members
see what was submitted). With teams of 3+, two teammates clicking submit
within ~1s contend on each other's player docs and one transaction has to
retry.

This is currently a **minor** issue (teams are usually 1–3 people) but it's
the next bottleneck after sharding.

**The fix**: move the team-shared transient state to a single
`teams/{teamId}/pendingBids` doc. Each team writes to one doc, no cross-team
contention, no cascade.

**Plan**
1. Schema: new doc `games/{gameId}/teams/{teamId}/state/pending` with
   `{ ad: {...}, chef: [...], decisionDraft: {...} }`
2. Backend: `submitBids` writes to that doc instead of cascading to teammates
   (current cascade is in `backend/functions/index.js` around the `submitBids`
   transaction's `for (const teamPlayerDoc of teamPlayerDocs)` loop);
   `submitDecision` does the same for `pendingDecision`
3. Frontend: each teammate currently hydrates `pendingDecision` from their own
   player doc snapshot in `app/src/pages/GamePage.tsx` (the player listener's
   `data.pendingDecision` block). Switch that hydration to subscribe to the
   new team doc instead.
4. Migrate: backfill existing `players[].pendingBids` into the new team doc
   on first read (or just blow it away — pendingBids is round-scoped anyway)
5. Firestore rules: team members can read their team's pending doc

**Steps**
- [ ] Spec the data model (one paragraph in this doc or a comment)
- [ ] Add backend writers
- [ ] Update FE readers
- [ ] Update rules
- [ ] Test: 3-player team submits decisions concurrently, no conflicts

**Effort**: ~3 hours
**Risk**: Medium. Touches FE state. Test with the multi-tab pattern from PR #98.

---

### T2.3 — Practice run with 10–15 real humans

**Why**: load tests don't catch what real humans do — browser tabs being
backgrounded, weird network conditions, spelling mistakes in team names,
people refreshing at inconvenient moments. Even a 30-min mock session
catches bugs that won't otherwise show up until showtime.

**Plan**
- [ ] Pick a date 3–7 days before the real session
- [ ] Recruit 10–15 people (your team, friends, a class section)
- [ ] Run a full 5-round game; have someone sit with you watching the
      Firebase console for warnings/errors
- [ ] Specifically attempt: late join, refresh-mid-bid, rapid bid changes,
      one person on terrible wifi
- [ ] Capture issues in a follow-up doc; address Tier-3 items only if a
      practice issue makes them necessary

**Effort**: 30–60 min for the run + ~hour for fixes
**Risk**: None (it's a test).

This is the **highest-confidence** thing on the list. If you only do one Tier-2
item, do this one.

---

## Tier 3 — Nice to have

### T3.1 — Min-instances on Cloud Functions

**Why**: pre-warming (T2.1) is per-session-start. Min-instances keeps N
function instances always warm so cold starts never happen. Cost: ~$15–30/mo
for a couple of instances on the most-called functions.

**Steps**
- [ ] In `functions/index.js` callable definitions, add `minInstances: 2`
      to `submitBids`, `submitDecision`, `advanceGamePhase`
- [ ] Deploy
- [ ] Verify in Firebase console that the functions show "min instances: 2"
- [ ] Watch billing for a week

**Effort**: 10 min
**Risk**: Cost only. Skip if T2.1 covers the case.

---

### T3.2 — Connection health UI on the professor page

**Why**: when a player's listener disconnects (closed laptop, weird wifi),
they see stale state and the professor can't tell. A simple "X / Y players
online" with a list of recently-disconnected uids would let the prof spot it.

**Plan**
1. Each player writes a `lastSeenAt` timestamp to a small per-player
   "presence" doc every 30s while their browser tab is active
2. Professor page reads all presence docs, flags any > 60s stale
3. Show a banner: "3 players appear disconnected — they may need to refresh"

**Steps**
- [ ] New `presence/{uid}` doc, written by client every 30s
- [ ] Professor page subscribes and displays
- [ ] Rules: anyone signed in can read presence (it's just liveness)

**Effort**: ~2 hours
**Risk**: Low. Adds one write per player every 30s = 2 writes/min/player =
fine even at 70 players.

---

### T3.3 — Shard `game.submittedCount`

**Why**: every `submitDecision` runs `FieldValue.increment(1)` on the game
doc's `submittedCount` field inside its transaction. With 25-70 students all
clicking submit in the decide phase, this is the next single-doc hot-spot.

`FieldValue.increment` is atomic and doesn't require a read, so it's
notably more resilient than the legacy `updateTopBids` was. But under heavy
contention you'll still see latency on this counter.

**The fix**: same shard-and-aggregate pattern as `recordSubmission`. Per-shard
counter docs at `games/{gameId}/submittedCountShards/{0..9}`; trigger sums
them and writes to `games/{gameId}.submittedCount`.

**Steps**
- [ ] New module `modules/sharded-counter.js`
- [ ] `submitDecision` writes to its shard
- [ ] Trigger aggregates
- [ ] Update any phase-advance logic that reads `submittedCount` to read
      from the (cached) aggregate (it already does — game doc field stays
      the source of truth)

**Effort**: ~1 hour
**Risk**: Low (mirrors the patterns from PR #98)

**Recommendation**: only do this if practice run (T2.3) shows submitDecision
latency is a problem. Otherwise, lower priority than the rest.

---

## Out of scope (and why)

- **Realtime Database for the auction hot path** — RTDB has higher per-node
  write throughput than Firestore, but moving the auction to it is a major
  rewrite (separate auth path, separate listener model, separate persistence)
  for a problem that sharding already solves at this scale.
- **Cloud Run + Redis** — overkill for a class game. Adds new infra to
  maintain. Reconsider if the game ever scales to 200+ concurrent players.
- **Throw money at Firebase tier upgrade** — the per-document write throttle
  is independent of pricing tier. No tier upgrade can fix the contention.
- **Game-design changes (queued/auctions instead of simultaneous bidding)** —
  changes the game feel; only consider if engineering can't keep up.

---

## Open questions for the user

- [ ] **Session date** — fixes the deadline for which tiers are realistic.
- [ ] **Final team count** — if it's confirmed ≤25, Tier 1 alone is enough.
      If it could go to 70+ teams, Tier 2 starts mattering.
- [ ] **Budget for min-instances** — yes/no on T3.1's monthly cost.
- [ ] **Practice run feasibility** — can you get 10-15 humans for a 30-min
      mock session? This is the single highest-leverage item.
- [ ] **Acceptable degradation modes** — is "slow tail latency on the last
      bid" acceptable, or does every bid need to confirm in <500ms?

---

## Verification, end-to-end

After all of Tier 1 + T2.1 + T2.2 are done:

```bash
# 1. Load test against staging (or production with a throwaway game id)
cd games/bakery-bash/backend
npm run loadtest:auction -- --teams 25 --stagger 5000
# Expect: 100% success, p95 < 500ms

# 2. Multi-team-costs auction regression
npm run test:multi-team-costs

# 3. Manual two-tab session-test (5 min)
firebase emulators:start &
cd ../app && npm run dev
# In two browser tabs / two incognito windows:
#   - Tab A: create team, advance to bid_ad
#   - Tab B: join same game, advance to bid_ad
#   - Tab A places a bid; Tab B's TOP BID column updates within ~2s
```

If all three pass, you're cleared to run the live session.
