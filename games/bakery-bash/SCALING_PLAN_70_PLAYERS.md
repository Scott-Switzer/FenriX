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
- **All code work is shipped:** PRs [#101](https://github.com/fenrix-ai/FenriX/pull/101)
  (T1.2 phases), [#102](https://github.com/fenrix-ai/FenriX/pull/102)
  (T2.1 warm-up), [#103](https://github.com/fenrix-ai/FenriX/pull/103)
  (T3.3 sharded counter), [#107](https://github.com/fenrix-ai/FenriX/pull/107)
  (T2.4 save/restart UI). Bundle deploy below covers all four.
- **Remaining manual work**:
  1. **Production deploy** — `firebase deploy --only functions,firestore:rules,hosting --project <prod>`
  2. **Practice run** (T2.3) — single highest-leverage thing left
  3. T2.2 cascade-writes only if practice run shows it bites at 3-player teams
- **Skipped or superseded** (with reasons documented inline): T1.3 CLI
  watcher (superseded by T2.4's in-app save/restore); T3.1 min-instances
  (T2.1 covers it for \$0/mo).

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
- [x] Merge PR #98 to `main`
- [ ] `cd games/bakery-bash/backend`
- [ ] `firebase deploy --only functions,firestore:rules --project <prod-project-id>`
- [ ] Verify in the Firebase console that `onTopBidsShardWritten`,
      `onSubmissionShardWritten`, and `onSubmittedCountShardWritten` show up
      under Functions → Triggers
- [ ] Smoke-test in production: create a throwaway game, advance to bid_ad,
      place a bid, watch the field land in `rounds/round_1.topBids` via the
      Firestore console

**Effort**: ~10 min
**Risk**: Low. The legacy `updateTopBids` function is left in place (deprecated
but callable) for one release cycle as a rollback safety net.

> **Status:** Pre-merge work shipped. Production deploy is the only remaining
> step here — bundle it with the deploys for #101, #102, #103, #107 below into
> a single `firebase deploy --only functions,firestore:rules` and you're done.

---

### T1.2 — Extend bid phase durations from 60s → 90s — ✅ SHIPPED

**Why**: even with the perf fix, the slowest 5% of bids in a 25-team burst land
~12s after the burst starts. A 60s window means a player who clicks submit
in the last 10s might watch their button spin past the timer. 90s gives
margin without dragging the game.

**Steps**
- [x] Edit `backend/functions/modules/config.js` → `DEFAULT_GAME_CONFIG.phaseDurations`:
      change `bid_ad: 60` to `bid_ad: 90`, `bid_chef: 60` to `bid_chef: 90`
- [ ] If you also want decide phase tuned, consider 300s → 360s
- [ ] Deploy: `firebase deploy --only functions`
- [x] Verify: a fresh game's `config/params` doc shows the new durations

**Effort**: 5 min
**Risk**: None — pure config change, no behaviour shift.

> **Status:** Shipped in [#101](https://github.com/fenrix-ai/FenriX/pull/101).
> Deploy bundled with the other Tier 1/2/3 deploys.

---

### T1.3 — Run the snapshot watcher during the live session — superseded by [T2.4](#t24--save--restart-this-round-from-the-professor-ui)

**Why**: even if everything works, you want a panic button. Per-round snapshots
let you roll back to a known-good state in under a minute.

> **Status:** Superseded by [T2.4](#t24--save--restart-this-round-from-the-professor-ui)
> ([#107](https://github.com/fenrix-ai/FenriX/pull/107)) — auto-snapshots now
> fire server-side at the start of every round and the restore UI lives on the
> professor page, no terminal required. The CLI watcher still works as a
> belt-and-braces fallback if you want a local-disk copy too.

**Fallback steps (only if you want the local-disk safety net too)**
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

### T2.1 — Pre-warm Cloud Functions before the session starts — ✅ SHIPPED

**Why**: cold-starts add 1–3s to the first call of each function. With 70
players hitting `submitBids` for the first time near-simultaneously, that
extra latency stacks up. Pre-warming amortises it before students notice.

**Implementation note**: each Gen 2 callable becomes its own Cloud Run service,
so a single `warmAll` proxy can't substitute. Each hot callable now has an
`isWarmupRequest` short-circuit that returns immediately without auth or
game-state validation; the FE button calls all six in parallel.

**Steps**
- [x] Add `isWarmupRequest` short-circuit at the top of each hot callable
      (`submitBids`, `submitDecision`, `submitPrices`, `advanceGamePhase`,
      `joinGame`, `createTeam`)
- [x] Add "Warm up servers" button on `ProfessorPage.tsx` with status pill UI
- [ ] Test in dev/staging after deploy: click button, observe ~5s while
      functions warm, then subsequent calls are fast

> **Status:** Shipped in [#102](https://github.com/fenrix-ai/FenriX/pull/102).
> Deploy bundled below.

**Effort**: 30–45 min
**Risk**: Low — pure addition.

---

### T2.2 — Eliminate team-mate cascade writes — ✅ SHIPPED

**Why**: every `submitBids` / `submitDecision` cascade-writes the submitting
player's `pendingBids` to all teammates' player docs (so other team members
see what was submitted). With teams of 3+, two teammates clicking submit
within ~1s contend on each other's player docs and one transaction has to
retry.

This is currently a **minor** issue (teams are usually 1–3 people) but it's
the next bottleneck after sharding.

**The fix**: move the team-shared transient state to a single
`teams/{teamId}/state/pending` doc. Each team writes to one doc, no cross-team
contention, no cascade.

**Plan**
1. Schema: new doc `games/{gameId}/teams/{teamId}/state/pending` with
   `{ ad: {...}, chef: [...], decisionDraft: {...}, updatedByUid, updatedAt }`
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
- [x] Spec the data model (one paragraph in this doc or a comment)
- [x] Add backend writers
- [x] Update FE readers
- [x] Update rules
- [x] Test: 3-player team submits decisions concurrently, no conflicts

> **Status:** Shipped. The submitter's own player doc still gets the same
> `pendingBids` / `pendingDecision` write it always did (so the submitter's
> UI reads exactly as before); the team-shared draft is mirrored once to
> `teams/{teamId}/state/pending` so other teammates can subscribe without
> us having to fan out into their player docs. `submitPrices` is
> intentionally untouched — its cascade is a separate concern (Finance
> rarely races with Operations) and would have widened the diff. Round
> transitions clear the team doc via the new `resetPendingTeamStateForRound`
> alongside the existing per-player reset. Solo players (no `teamId`) skip
> the team mirror; their player doc remains the only source of truth.

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

### T2.4 — Save / restart-this-round from the professor UI

**Why**: T1.3 puts the panic button in a terminal — fine for our team, awful for
a professor running 70 students mid-class. A "Restart this round" button on the
professor page lets them recover from a class-killing bug without dropping into
a CLI mid-session. It also removes the requirement that someone keep
`npm run snapshot:watch` running on a laptop for the whole session.

The existing snapshot infrastructure from PR #98 (`snapshot-game.js` /
`watch-and-snapshot.js` / `restore-game.js`) does the heavy lifting. This task
wraps it in callables, auto-fires it at round boundaries, and exposes one
button + one confirmation dialog on the professor page.

**The fix**

1. **Auto-snapshot at the start of every round.** Hook into `advanceGamePhase`'s
   transition into `round_N_email` — best-effort, non-fatal, runs after the
   transaction commits.
2. **`createSnapshot({ gameId })` callable.** Manual checkpoint button on the
   professor page. Gated to `professorUid` like the other admin callables.
3. **`restoreSnapshot({ gameId, snapshotId })` callable.** Pauses the game,
   restores, leaves it paused. Returns the new state so the professor can
   message students to refresh. Gated to `professorUid`. Logs every restore
   to Cloud Logging with the calling uid (audit trail).
4. **Storage.** Snapshots can exceed Firestore's 1 MB doc limit at 70 players
   × 5 rounds (estimate ~1.5 MB compressed). Write the blob to Firebase
   Cloud Storage at `gs://<bucket>/snapshots/{gameId}/{snapshotId}.json`,
   then write a small index doc to `games/{gameId}/snapshots/{snapshotId}`
   with `{ phase, round, capturedAt, gcsPath, sizeBytes, capturedByUid }`.
   FE lists snapshots via the index docs.
5. **Frontend.** Three additions to the professor page:
   - **"Save now"** button — manual checkpoint
   - **"Restart from last save"** button — opens a list of recent snapshots
     (newest first), click one to restore. Gated behind a typed confirmation
     ("RESTORE round_N") to match `restore-game.js`'s safety pattern. Restored
     game lands paused.
   - **"Last saved: round 3 · 12:34"** indicator next to the buttons.
6. **Retention.** Cap snapshots per game at 20 (auto-prune oldest). Cap age at
   30 days. Storage cost at 1.5 MB × 20 × $0.026/GB·mo is fractions of a cent
   per game — negligible.

**Steps**
- [x] Refactor: extract `serialize` / `deserialize` from
      `scripts/snapshot-game.js` and `scripts/restore-game.js` into
      `functions/modules/snapshot.js` so the scripts AND the callables share one
      implementation. Keep the CLI scripts working — the module just becomes
      their backbone.
- [x] Schema: `games/{gameId}/snapshots/{snapshotId}` index doc with chunked
      payload at `…/chunks/{N}` (Firestore-only, no Cloud Storage dependency
      since Storage isn't configured for this project).
- [x] Backend: `createSnapshot` and `restoreSnapshot` callables.
- [x] Backend: hook auto-snapshot into both `startGame` AND the
      `advanceGamePhase` round-email transition.
- [x] FE: "Save now" + "Restart from last save" buttons + "Last saved: …"
      indicator on `ProfessorPage.tsx`. (Snapshot list modal deferred to v2 —
      v1 just restores the most recent snapshot.)
- [x] Rules: `snapshots/{id}` readable by professor only; `…/chunks/{N}`
      server-only.
- [ ] Test: trigger a fake mid-round failure (e.g., manually corrupt a
      `submissions` doc), restore, confirm players auto-rejoin after refresh
      and round can complete normally. **Recommended manual test before
      tomorrow's practice run.**
- [ ] Test: restore from a snapshot that's older than the current round
      (round 4 game, restoring to round 2 snapshot) — confirms the destructive
      "clean" semantics that drop drift docs.

> **Status:** Shipped in [#107](https://github.com/fenrix-ai/FenriX/pull/107).
> Storage backend simplified from Cloud Storage to Firestore subcollection
> chunks since Storage isn't configured for this project.

**Effort**: ~3–4 hours
**Risk**: **Medium**. Restore is destructive — keep all three safety gates:
typed confirmation, log every restore with the calling uid, set `paused: true`
on the restored game so players can't write into a half-restored state.

**Cost**: Negligible (Firestore subcollection storage at this scale; retention
caps shards to 20 snapshots × ~1.5 MB = 30 MB per game).

---

## Tier 3 — Nice to have

### T3.1 — Min-instances on Cloud Functions — superseded by [T2.1](#t21--pre-warm-cloud-functions-before-the-session-starts---shipped)

**Why**: pre-warming (T2.1) is per-session-start. Min-instances keeps N
function instances always warm so cold starts never happen. Cost: ~$15–30/mo
for a couple of instances on the most-called functions.

> **Status:** Skipped in favour of T2.1's free warm-up button. Min-instances
> bills 24/7 for an effect that only matters for ~1 hour per class. Re-evaluate
> if the game runs daily or shifts to always-on.

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

### T3.3 — Shard `game.submittedCount` — ✅ SHIPPED

**Why**: every `submitDecision` runs `FieldValue.increment(1)` on the game
doc's `submittedCount` field inside its transaction. With 25-70 students all
clicking submit in the decide phase, this is the next single-doc hot-spot.

`FieldValue.increment` is atomic and doesn't require a read, so it's
notably more resilient than the legacy `updateTopBids` was. But under heavy
contention you'll still see latency on this counter.

**The fix**: same shard-and-aggregate pattern as `recordSubmission`. Per-uid
shard docs at `games/{gameId}/submittedCountShards/round_{N}/shards/{0..9}`
keyed by uid (idempotent — retries don't double-count); a `concurrency: 1`
trigger sums them and writes to `games/{gameId}.submittedCount`.

**Steps**
- [x] New module `modules/sharded-counter.js`
- [x] `submitDecision` writes to its shard (replaces in-transaction `FieldValue.increment(1)`)
- [x] `onSubmittedCountShardWritten` trigger aggregates
- [x] Reset paths (`resetGame`) wipe the shards subcollection too
- [x] Firestore rules: server-only access on `submittedCountShards`

> **Status:** Shipped in [#103](https://github.com/fenrix-ai/FenriX/pull/103).
> 102/102 stress regression tests pass; RC-7 (the `submittedCount` desync
> guard) still green. Deploy bundled below.

**Effort**: ~1 hour
**Risk**: Low (mirrors the patterns from PR #98)

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

---

## Deploy bundle (everything currently merged)

All shipped work — PRs [#101](https://github.com/fenrix-ai/FenriX/pull/101),
[#102](https://github.com/fenrix-ai/FenriX/pull/102),
[#103](https://github.com/fenrix-ai/FenriX/pull/103),
[#107](https://github.com/fenrix-ai/FenriX/pull/107) — deploys in one shot:

```bash
cd games/bakery-bash/backend
firebase deploy --only functions,firestore:rules --project <prod-project-id>

cd ../app
npm run build
firebase deploy --only hosting --project <prod-project-id>
```

**What to verify in the Firebase console after the functions deploy:**
- Triggers tab shows: `onTopBidsShardWritten`, `onSubmissionShardWritten`,
  `onSubmittedCountShardWritten`
- Functions list shows: `createSnapshot`, `restoreSnapshot` (new in #107)
- All hot callables (`submitBids`, `submitDecision`, `submitPrices`,
  `advanceGamePhase`, `joinGame`, `createTeam`) deployed (new revision)

**One-line smoke** (after deploy lands):
1. Create a game → join code shows
2. Click "Warm up servers" → 5–8s pill, then "warm" badge
3. Click "Save Now" → "Last saved: round 0 · …" indicator appears (or wait
   for auto-save when you click Start Game; round 1 gets an auto-snapshot)
4. Use one extra browser tab to join + place a bid in `bid_ad`; confirm the
   top-bids column updates in <2s
