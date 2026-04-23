# Bakery Bash — Playtesting Issues Discovered Apr 23

> Found by end-to-end simulated playthrough: 6 users / 2 teams of 3 / 5-round game against the local Firebase emulator. Each round was walked phase-by-phase with Firestore docs + `lastRoundResult` inspected and hand-computed against the cost formulas in `revenue.js` / `loan-shark.js`.

**Date:** 2026-04-23
**Branch base:** `fix-backend-race-and-limbo` (fork off `main` — this branch already has unrelated race fixes)
**Target:** May 1, 2026 live session
**Repro scripts (local only, not committed):** `/tmp/playtest.js`, `/tmp/playtest3.js`, `/tmp/verify_bug.js`

---

## Priority Summary

### From automated playthrough (6-user emulator run, numbers-focused)

| ID | Area | Title | Priority | Effort |
|---|---|---|---|---|
| BE-I01 | simulation / auction | **Auction costs are charged N× for a team of N** | **P0 — ship-blocker** | M (~1 day) |
| BE-I02 | roster / phases | **Chef cap (3) is never enforced; teams hoard 10+ chefs** | **P0 — ship-blocker** | M (~1 day) |
| BE-I03 | roster / schema | **Auction-results doc duplicates payload under both team-slug and every member uid** | **P0** (enables I01 fix) | S (½ day) |
| BE-I04 | team formation | **2-player teams have no `operations` role — can't submit decisions** | **P0** | S–M (½–1 day) |
| BE-I05 | results schema | **`classStats.totalCustomerPool` never written** | P1 | XS (~1 hr) |
| BE-I06 | results schema | **`fillRate` missing from `lastRoundResult`** | P1 | XS (~1 hr) |
| BE-I07 | chef pool | **`skillLevel` field missing / renamed to `skillTier`** | P1 | S (~2 hr) |
| BE-I08 | tests | **`test-phase-flow` + `test-lifecycle` (backend/scripts) expect old phase order** | P1 | XS (~1 hr) |
| BE-I09 | tests | **Unit-test failure: `generateChefPool produces valid chefs`** | P1 | S (~2 hr) |
| DOC-I10 | docs | **`GAME_DESIGN_PROPOSAL.md` phase-order section contradicts shipped code** | P1 | XS (~½ hr) |
| UX-I11 | auctions | **Tie-break is earlier-submission → network-speed wins** | P2 | S–M |
| FE-I12 | simulate phase | **Sim advances `decide → results_ready` in <3s; "simulating" frame is invisible** | P2 | S |

### From manual playtesting (browser walk-through, UX-focused)

| ID | Area | Title | Priority | Effort |
|---|---|---|---|---|
| BE-I13 | team roles | **"× Clear" button on Pick Your Role doesn't actually clear the role** | **P0** | XS (~1 hr) |
| FE-I14 | team roles | **"Pick Your Role" briefing references "role owner" without defining it** | P2 | XS (~½ hr) |
| FE-I15 / BE-I04 | team roles | **Teams with only 1 or 2 roles picked can't submit — need a solo-fallback** | **P0** (sibling of BE-I04) | S (½ day) |
| FE-I16 | ad auction | **Typing into $0 bid input produces "01000" (leading zero)** | **P1** | XS (~½ hr) |
| BE-I17 | professor | **`pauseGame` flips a flag that nothing honors — timer and submissions still tick** | **P1** | M (~1 day) |
| FE-I18 | professor | **Per-phase submission grid is stuck on ⏳ for everyone** | **P1** | S (~2 hr) |
| DESIGN-I19 | chef auction | **Minimum bid floor feels arbitrary — reconsider removing or simplifying** | P2 | design discussion |
| FE-I20 | results | **Revenue / Customers / Satisfaction values duplicated in label strip below cards** | P2 | XS (~½ hr) |
| FE-I21 | conclusion | **End-game screen needs polish — mirror the Results-phase card style** | P2 | M (~½–1 day) |

**P0 total effort (all sources): ~4–4.5 person-days.** Everything P0 should land before May 1 or the live game will produce nonsense numbers for multi-player teams, block any team that doesn't show up with exactly 3 people, and present a broken "Clear role" button on the first screen every student sees.

---

## P0 — Must-fix before May 1

### BE-I01 — Auction costs multiplied by team size

**Severity:** Critical. Kills the game economy for every team of 2 or 3 — which is literally every team on May 1.

**Symptom.** On the 6-player run, Team Rolling-Scones (3 members) won TV + Radio at $35,000 actual and 2 chefs at $70,250 actual. Every member doc showed:

```
adBidPaid:    $105,000   (= $35,000 × 3)
chefBidPaid:  $210,750   (= $70,250 × 3)
totalSpent:   $347,260   (matches hand-calc with 3× multiplier)
```

By round 2 the team is in the loan shark. By round 5 the team is at **−$6,882,934** while a solo player with identical strategy was at **+$506,970**. Leaderboard is useless.

**Root cause.**
1. [`resolveAndApplyAdAuction` (index.js:487–564)](backend/functions/index.js:487) writes `adAuctionResults[winnerKey] = {…, totalPaid}` and then **copies the same payload under every member uid**:
   ```js
   for (const memberUid of winnerGroup.memberUids) {
     adAuctionResults[memberUid] = {
       adTypes: [...adAuctionResults[winnerKey].adTypes],
       totalPaid: adAuctionResults[winnerKey].totalPaid,
     };
   }
   ```
   Same pattern for chef auction ([index.js:762–770](backend/functions/index.js:762)).
2. [`runSimulationAndPersist` (index.js:1781–1801)](backend/functions/index.js:1781) then sums `adBidPaid` / `chefBidPaid` across every `memberUid`:
   ```js
   for (const memberUid of team.memberUids) {
     const ar = auctionByPlayer.get(memberUid) || {};
     aggregatedAuction.adBidPaid += numberOrDefault(ar.adBidPaid, 0);
     aggregatedAuction.chefBidPaid += numberOrDefault(ar.chefBidPaid, 0);
   }
   ```
   N copies × N members = N² wait no — N copies each read once = N× the real amount. Either way, wrong.

**Fix (recommended).** Pick one source of truth and stop double-writing. Two clean options:

- **(A)** Write auction results only under the team key (`winnerKey`), delete the per-member copies. Then in `runSimulationAndPersist`, read `auctionByPlayer.get(team.key)` **once per team**, not once per member.
- **(B)** Keep per-member copies for FE convenience, but add a `teamKey` field and skip member entries whose `teamKey` matches the canonical one when summing.

(A) is cleaner and cheaper to review. Couple it with BE-I03 so the doc shape is obvious.

**Acceptance.**
- With 3 teams of size 1/2/3 placing identical TV bids that each win, every winning team shows `totalSpent = stockCost + sousChefCost + 30000 + chefBidCost` regardless of team size.
- New integration test `backend/scripts/test-multi-team-costs.js` that creates a 1-member and a 3-member team, has both win equal-priced auctions, and asserts `totalSpent` matches.

---

### BE-I02 — Chef roster cap (3 specialty chefs) is never enforced

**Severity:** Critical. Teams that bid aggressively stockpile 10+ chefs over 5 rounds and get runaway output, breaking the competitive balance the design intended.

**Symptom.** In the 6-player run:
```
Round 1: A has 2 chefs
Round 2: A has 4 chefs  ← should have been capped at 3 after R1
Round 3: A has 6 chefs
Round 4: A has 8 chefs
Round 5: A has 10 chefs
```
`continueFromRoster` rejects with `"Lay off chefs until you have at most 3"` — but that's a client-side guard only. The professor's `advanceGamePhase` moves the phase from `roster → decide` regardless of whether any team confirmed, and nothing forces a lay-off.

**Root cause.**
- [`continueFromRoster` (index.js:2572)](backend/functions/index.js:2572) only throws if `count > specialtyChefCap` — but it's not a blocker for phase advance.
- [`advanceGamePhase` (index.js:1375)](backend/functions/index.js:1375) has no "is every team roster-resolved?" check before leaving `roster`.
- `layoffChef` exists and works, but no auto-layoff fires on roster timeout.

**Fix (recommended).** Two complementary changes:

1. **Block advance** out of `roster` when any team has more specialty chefs than `specialtyChefCap`. In the transactional phase-transition step:
   ```js
   if (basePhaseName === 'roster' /* leaving roster */) {
     const offenders = await findTeamsOverChefCap(gameRef, config.specialtyChefCap);
     if (offenders.length) {
       throw new HttpsError('failed-precondition',
         `Teams still over chef cap: ${offenders.join(', ')}. Use Force Layoff or wait for roster to resolve.`);
     }
   }
   ```
2. **Auto-layoff on timeout.** If the roster phase timer expires and a team is still over cap, drop the most recently acquired chef(s) into the round's `chefReturnPool` and fire a client notification. Reuse the existing `layoffChef` code path.

Either fix alone is enough to prevent the runaway case; both together give the professor clean UX.

**Acceptance.**
- Round 3+ run where Team A wins 3 chefs/round consistently shows `specialtyChefs.length <= 3` after every advance.
- Laid-off chefs appear in `rounds/round_N/chefReturnPool` with `returnedByPlayerId` set.
- Professor panel shows a "Team X still over cap" warning banner when trying to advance from roster.

---

### BE-I03 — Auction-results doc shape leaks member uids alongside team slug

**Severity:** High (root cause of BE-I01; also confuses any CSV export or audit tooling).

**Symptom.** A round's `auctionResults` doc in Firestore looks like:
```json
{
  "rolling-scones": { "totalPaid": 35000, "adTypes": ["TV", "Radio"] },
  "a1-1776970489087": { "totalPaid": 35000, "adTypes": ["TV", "Radio"] },
  "a2-1776970489087": { "totalPaid": 35000, "adTypes": ["TV", "Radio"] },
  "a3-1776970489087": { "totalPaid": 35000, "adTypes": ["TV", "Radio"] },
  "bread-winners":   { "totalPaid": 20000, "adTypes": ["Billboard"] },
  "b1-…":            { "totalPaid": 20000, "adTypes": ["Billboard"] },
  …
}
```
— eight entries for two winning teams. Consumers that iterate `Object.entries()` will double- or quadruple-count.

**Fix.** Write under **team slug only**. If FE wants a per-member reference, derive from `gameRef/teams/{slug}` at read time. Update any downstream reader (`loadAuctionResultsByPlayer`, professor CSV export) to key by team.

**Acceptance.**
- `rounds/{round}/adAuctionResults` and `chefAuctionResults` keys match the set of winning team slugs exactly — no uids.
- All consumers (simulation, CSV export, professor view) pass integration tests with the new shape.

---

### BE-I04 — 2-player teams can't play without manual role assignment

**Severity:** High. Attendance on May 1 will not be perfectly divisible by 3. Any team that shows up with 2 people will hit `permission-denied` on `submitDecision`.

**Symptom.** `joinGame`/`createTeam` auto-assign in order `['finance', 'advertising', 'operations']`. For a 2-player team, nobody gets operations. Any `submitDecision`, `layoffChef`, or `continueFromRoster` call throws:
```
Your role "finance" cannot perform this action. Required: operations.
```
The design doc says 2-player teams should "split at join — one player picks 2 roles" but there's no UI or backend path for that.

**Fix (recommended).** In the `joinGame` / `createTeam` transaction, when the team's third role would be empty, give one existing member a `dualRole` array (or: degrade all their roles to `solo`, which already bypasses the role-gate in `assertRoleAllowed`).

Minimum-risk version for May 1: **when a team has ≤2 members, every member's role is set to `solo`**. `assertRoleAllowed` already has the solo short-circuit, so no downstream change is needed. Full three-person teams keep the existing specialist roles.

**Acceptance.**
- A 2-player team can submit ad bids, chef bids, decisions, and roster continues from either member's browser.
- A 3-player team still role-gates as today (decide-submit button greyed out on non-operations devices, etc.).
- Transition case: if a third player joins later while still in lobby, the team's roles flip from `solo/solo` to `finance/advertising/operations`.

---

### BE-I13 — "× Clear" button on Pick Your Role does nothing

**Severity:** High. Discovered via manual playtest. It's on the first interactive screen every student lands on, so a broken button there signals "this is janky" before the game even starts.

**Symptom.** User selects a role (e.g. Finance), sees "✓ You" and the "× Clear" button appear, clicks Clear — the spinner flashes ("Clearing…") but the role stays assigned. Team doc and player doc still show `role: "finance"`.

**Root cause.** Frontend [handleClearRole (TeamPage.tsx:298–313)](app/src/pages/TeamPage.tsx:298) calls `setTeamRole({ gameId, teamId, role: null })`. Backend [setTeamRole (index.js:2932–2977)](backend/functions/index.js:2932) validates with `const role = cleanString(...)` (returns `""` for null) and then:
```js
if (!role) throw new HttpsError('invalid-argument', 'role is required.');
```
The call silently throws, the client catches it in the role-error setter, and nothing changes. The FE even swallows the error without a visible toast because `role: null` was never part of the contract.

**Fix.** Two clean options:

- **(A)** Backend: add a branch in `setTeamRole` for `role === null | "" | "unassigned"`:
   ```js
   if (role === null || role === "" || role === "unassigned") {
     // Allowed — clear this player's role.
     tx.update(teamRef, { [`roleAssignments.${auth.uid}`]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
     tx.update(playerRef, { role: "unassigned" });
     return;
   }
   ```
   Also delete the player's entry from `team.roleAssignments` and drop `role` on the player doc back to `unassigned` (or `null`).
- **(B)** Add a sibling callable `clearTeamRole` that only needs `{ gameId, teamId }`. Slightly cleaner contract; more code surface.

Go with (A) — less callable sprawl.

**Acceptance.**
- Click "× Clear" on an assigned role → the "✓ You" indicator disappears, the role badge becomes available for others, and the player's doc shows `role: "unassigned"` (or `null`).
- Another teammate can now pick the cleared role.
- Clicking Clear with no role assigned is a no-op (doesn't throw).
- Integration: extend `test-team-roles.js` with a `clear → reclaim` round-trip.

---

### FE-I15 — Teams with 1 or 2 roles picked can't submit anything

**Severity:** High. Sibling of **BE-I04** — same root problem, different surface. On May 1 teams won't all show up with 3 people, **and** even 3-person teams may not all have picked before the phase moves on. Right now the game hard-gates on specific roles and has no graceful fallback.

**Symptom scenarios.**
- A 2-person team joins. First joiner auto-assigned `finance`, second `advertising`, nobody has `operations`. Decide-phase submit throws `permission-denied — Required: operations`.
- A 3-person team where one player picked finance but the other two haven't picked yet when the phase advances. Same failure mode — ad/operations submits are locked.
- A solo person joined a 3-person team that was abandoned. Their role is e.g. `advertising` with no way to cover the other two.

**Fix (recommended).** Two layers, complementary:

1. **Runtime guard** (backend). Wherever `assertRoleAllowed(role, [...])` is called, also accept when **the team has no member holding the required role**. Pseudocode:
   ```js
   async function assertRoleOrTeamFallback(playerDoc, allowedRoles, teamDoc) {
     if (playerDoc.get('role') === 'solo') return;
     if (allowedRoles.includes(playerDoc.get('role'))) return;
     const assignments = (teamDoc.data() || {}).roleAssignments || {};
     const someoneHoldsRequired = Object.values(assignments).some((r) => allowedRoles.includes(r));
     if (!someoneHoldsRequired) return; // fallback: anyone on the team can do it
     throw new HttpsError('permission-denied', `Your role "${playerDoc.get('role')}" cannot perform this action. Required: ${allowedRoles.join(' or ')}.`);
   }
   ```
   Apply everywhere `assertRoleAllowed` currently fires: `submitDecision`, `submitPrices`, `submitBids (ad)`, `submitBids (chef)`, `layoffChef`, `continueFromRoster`.

2. **Frontend reflection**. The disabled-submit tooltip today reads *"Your [role] teammate submits this decision."* That's a lie if nobody on the team has that role. Read the team's `roleAssignments`; if the required role is vacant, **enable** the submit button for every teammate with a note like *"No one has picked Operations yet — anyone can submit."* File: role-gated button components in `TeamPage.tsx` / `GamePage.tsx` / `AuctionPage.tsx`.

**Relationship to BE-I04.** BE-I04 (P0 from the automated run) fixes the auto-assignment path so joins always leave the team playable; FE-I15 is the runtime guarantee in case a team ends up lopsided anyway (e.g., manual clears, mid-game disconnects). **Ship both.** I04 is the default path; I15 is the safety net.

**Acceptance.**
- 2-player team with roles `finance`/`advertising` (no operations): either teammate can submit a decide, either can confirm roster, either can lay off a chef. Verified in a new `test-fallback-roles.js`.
- 1-player team (role `finance`) — same player can do everything. Same test asserts this case.
- 3-player team with all roles filled behaves exactly as today (role-gating still enforced). Regression-test by running the existing `test-team-roles.js`.

---

### FE-I14 — "Pick Your Role" briefing uses "role owner" without defining it

**Severity:** Low (P2). Flagged during manual playtest.

**Symptom.** The intro paragraph above the role cards reads:
> Everyone sees every screen, but only the **role owner** can press *Submit*. Choose together — each role can only be held by one teammate.

The phrase "role owner" isn't introduced anywhere before this point. New students hit it cold and have to infer.

**Fix.** Rewrite to define the concept inline, e.g.:
> Every teammate sees every screen. For each decision, only **the teammate who picked that role** can press *Submit* — so pick together, and each role can only be held by one person.

While there: the `team-page__roles-solo` paragraph assumes 1-person → "flying solo right now — once teammates join you'll be able to pick a role". With FE-I15's fallback, update the wording to "all three submit buttons are enabled for you" → *still accurate but reinforce that this also applies if roles are left unfilled*.

**Files:** [TeamPage.tsx:443–455](app/src/pages/TeamPage.tsx:443).

---

## P1 — Noticeable, ship if time

### BE-I05 — `classStats.totalCustomerPool` is never written

Design proposal expects a `totalCustomerPool` on the round's class stats. Firestore currently has:
```
{ avgRevenueNet, minRevenueNet, maxRevenueNet, playerCount, avgCustomerCount }
```
Anything referencing `totalCustomerPool` (leaderboard banner, professor "pool share" view) renders `undefined`. Either compute it (`= avgCustomerCount × playerCount`, or sum during simulation) or delete the field from the design doc.

**Fix:** add `totalCustomerPool: results.reduce((s, r) => s + r.customerCount, 0)` to the classStats write in `runSimulationAndPersist`.

---

### BE-I06 — `fillRate` missing from `lastRoundResult`

`simulation.js` computes `fillRate` per product inside `perProductSatisfaction[product]`, but doesn't surface a player-level aggregate on `lastRoundResult`. Any Result-screen UI reading `lrr.fillRate` gets `undefined`.

**Fix:** copy the weighted-average fillRate (or per-product map) onto the result payload. Also surface it on the CSV row so students can regress against it.

---

### BE-I07 — Chef-pool skill-level field name inconsistency

`catalog/chefs/items` seed uses `skillTier`. At least one consumer was written for `skillLevel`. In the 6-player run, inspection showed `skillLevel: undefined` on every pool chef (the fallback read). Rename all reads to `skillTier`, or always coerce one to the other in the seed.

Grep once, pick the canonical name, update the rest. Add a schema comment at the top of `chef-system.js` so future contributors don't reintroduce the split.

---

### BE-I08 — Integration tests `test-phase-flow` + old `test-lifecycle` encode the old phase order

`backend/scripts/test-phase-flow.js` asserts `round_1_email → round_1_decide`, but the shipped order is `round_1_email → round_1_bid_ad`. Same for the standalone `backend/scripts/test-lifecycle.js`. These tests currently fail on `npm run test:phase-flow`. Update the fixtures to match the shipped `PHASE_ORDER`.

---

### BE-I09 — Unit test: `generateChefPool produces valid chefs` fails

`node functions/modules/__tests__/test-suite.js` fails with:
```
✗ generateChefPool produces valid chefs
    pool size 12 — expected truthy, got false
```
Likely the same `skillLevel` vs `skillTier` symptom as BE-I07, manifesting inside the pool validator. Tie the fixes together.

---

### DOC-I10 — `GAME_DESIGN_PROPOSAL.md` phase-order section is stale

The proposal's "Round Structure" table lists: **Decide → Bidding → Roster → Simulate → Review → Email**.
The shipped code is: **Email → bid_ad → bid_chef → Roster → Decide → Simulate → Review**.

Both the Apr 22 tasks doc (`playtesting-apr22-remaining-tasks.md`) and `phases.js` confirm the auction-before-decide order is the intentional, shipped design. Update the GAME_DESIGN_PROPOSAL table + any follow-on references to match, so students and the prof brief from the same playbook.

No code change needed.

---

### FE-I16 — Typing into the ad-bid input produces "01000"

**Severity:** Moderate. Every ad-auction participant hits this on their first bid. Doesn't corrupt data (the number stored is correct), but looks broken.

**Symptom.** Ad bid field starts showing "0" (the placeholder-ish default). User types "1000" expecting to see "1000" — instead sees "01000".

**Root cause.** [AuctionPage.tsx:678](app/src/pages/AuctionPage.tsx:678):
```jsx
value={pendingAdBids[ad.id] ?? 0}
```
Forces `0` as the initial displayed value rather than blank. When the user begins typing, React's controlled-input reconciliation concatenates rather than replacing in some browsers, producing the leading zero.

**Fix.** One-line change:
```jsx
value={pendingAdBids[ad.id] ? pendingAdBids[ad.id] : ""}
placeholder="0"
```
An empty string plus a `placeholder="0"` gives the same visual affordance without forcing a literal "0" character in the input's value.

Also apply to the equivalent chef-bid input around line 752 (same shape).

**Acceptance.** Clearing the field and typing `1000` shows `1000`. Clearing and blurring without typing shows the placeholder `0`. Submitted bid is still the integer value.

---

### BE-I17 — `pauseGame` flag doesn't actually pause anything

**Severity:** Moderate. Professor expects Pause to stop the timer and block submissions. Today it only toggles a cosmetic label.

**Symptom.** Professor clicks Pause → the header shows "· paused" → but the phase timer keeps counting down, players can still submit, and the phase auto-advances when the timer expires.

**Root cause.** [`setPausedFlag` (index.js:2603)](backend/functions/index.js:2603) updates `paused: true` / `pausedAt: <ts>` on the game doc. **Nothing else in the codebase reads `paused`.** Grep `game.paused|paused ===|if (paused` across `backend/functions/` returns 0 matches. Phase advance, `submitDecision`, `submitBids`, `submitPrices`, `continueFromRoster`, `layoffChef` — none consult the flag.

**Fix.** Two complementary changes:

1. **Freeze the timer.** When `paused: true` is written, capture `pausedAt`. When `resumed`, compute `elapsedMs = resumedAt - pausedAt` and bump `phaseEndsAt` by that amount. Requires a `resumeGame` change that reads `pausedAt`, extends `phaseEndsAt`, then clears `pausedAt`.
2. **Block submissions.** Add to the top of each player-action callable:
   ```js
   if (gSnap.get('paused') === true) {
     throw new HttpsError('failed-precondition', 'Game is paused by the professor.');
   }
   ```
   Touches: `submitDecision`, `submitPrices`, `submitBids`, `continueFromRoster`, `layoffChef`. Also block `advanceGamePhase` unless the professor explicitly resumes first (or allow advance, up to the team).

**Acceptance.** With the game paused:
- `phaseEndsAt` reflects the original end + the paused duration after resume.
- All six player callables return `failed-precondition` → client renders "Game is paused" banner.
- Existing integration test `test-phase-flow` grows a paused-mid-phase assertion.

---

### FE-I18 — Per-phase submission grid never updates (stuck on ⏳)

**Severity:** Moderate. Professor has no way to see who submitted what during a round, which makes pacing the live session much harder.

**Symptom.** Grid rows under "Decide / Ad Bids / Chef Bids / Roster" all show ⏳ permanently; toggling submit from a player's device doesn't change anything.

**Root cause.** Two candidates, both plausible:
1. **Permission.** [ProfessorPage.tsx:283–294](app/src/pages/ProfessorPage.tsx:283) — the `onSnapshot(submissionsRef, …)` listener fails with `permission-denied` unless the signed-in uid has the `professor: true` custom claim. The error toast reads *"To see per-phase submission status, your account needs the professor custom claim (run `scripts/set-professor-claim.js`)."* If the professor is signed in as an anonymous test user, this is the first-time state — and the toast may be missed.
2. **Reads never arrive.** Even with the claim, [recordSubmission (index.js:574–588)](backend/functions/index.js:574) may be silently swallowing errors. It runs on every decision/bid submit, merges into `submissions/round_{N}_{phase}`, and only logs warnings. If any of the per-submit paths aren't calling it, the doc stays empty forever.

**Fix.**
1. Verify `scripts/set-professor-claim.js` has been run against the signed-in professor uid (document this in the professor-ownership message, and/or expose a "Grant myself prof claim" admin button during dev).
2. Grep every submit callable (`submitDecision`, `submitPrices`, `submitBids`, `layoffChef`, `continueFromRoster`) and confirm each one calls `recordSubmission(gameRef, submissionDocId, uid, displayName, role)` with the right `submissionDocId`. Add a test that after each submit, the corresponding `submissions/round_{N}_{phase}/{uid}.status === 'submitted'`.
3. Upgrade the missing-claim banner to a dismissable toast with a "Fix it" link to the script instructions.

**Acceptance.**
- With the claim granted, each submit immediately flips the corresponding row from ⏳ to ✓ within 1s (Firestore snapshot).
- Without the claim, the banner is obvious and the grid still falls back gracefully to the plain roster.

---

## P2 — Polish

### UX-I11 — Auction tie-break is "earlier submission wins"

Current tie-break in `resolveAndApplyAdAuction` / `resolveChefAuction`: if two teams bid the same dollar amount, the one whose Firestore write landed first wins. This means network-latency decides the auction.

Fairer options:
- Split the pot evenly between tied bidders (they all get the ad slot; ad bonus divided).
- Coin-flip (deterministic seed `${gameId}:${round}:${adType}`) — more dramatic and at least random.
- Resolve strictly by bid amount; ties become "no winner this round" — cleanest, disincentivizes round-number bidding.

Pick one, document it in `GAME_DESIGN_PROPOSAL.md`, and surface the resolution on the ad-result screen ("Tied at $30,000 — coin flip: Rolling Scones").

---

### FE-I12 — "Simulating" phase frame never shows

Phase sequence observed in logs:
```
Phase → round_1_decide
Phase → results_ready    ← simulating state invisible to user
```
The backend writes `phase: simulating` inside a transaction, runs the sim, then flips to `results_ready` in a follow-up transaction — all in ~2 seconds. The design expects a 2-minute animated Simulate screen (already built in `SimulatePhase.tsx` per the Apr 22 task doc).

Either:
- Force a minimum wall-clock time in the `simulating → results_ready` transition (wait until `phaseEndsAt` or a small floor like 20 s), or
- Decouple the FE animation from the Firestore phase (enter simulating, start animation, poll for `results_ready`, hold until animation completes).

The second is already the right architecture for a slow-connection client; the backend just needs to stay in `simulating` long enough for the FE to commit to the transition.

---

### DESIGN-I19 — Reconsider the chef-bid minimum-bid floor

**Severity:** Design question surfaced during playtesting. Not a defect, a trade-off.

**Observation.** Chef minimum bids scale by skill tier:

| Skill tier | Min bid floor |
|---|---|
| Novel | $25,000 |
| Intermediate | $43,750 |
| Advanced | $68,750 |

Rejected bids throw `"Your bid for Chef #N ($X) is below the Minimum Ask of $Y"`. With a $500k starting budget, the minimum ask already consumes 5–14% of round-1 budget before the auction even clears — it acts as a soft price floor that punishes hesitation.

**Options to discuss.**
1. **Remove the floor entirely.** Any bid ≥ $1 counts. Clean, simple, aligns with "sealed auction, highest wins". Downside: a team can grab a chef for $1 if no one else bids.
2. **Lower and unify the floor.** e.g. $5,000 flat regardless of skill. Keeps the "chefs cost real money" signal without making skill-tier arithmetic a gating rule.
3. **Reveal the floor on the card.** Today it's shown ("Min Ask: $25,000") but the per-tier scaling isn't explained and students don't know which tier they're bidding on. Either surface the tier or hide the tier-gating entirely.
4. **Keep as-is, but soften the error.** Round the floor to $25/$50/$75k buckets so the number feels intentional, and improve the error message to explain *why* the floor exists.

**Recommendation.** Go with (2) — unified floor around $5k or $10k. Keeps the "auction costs matter" incentive without making minimum-ask trivia part of the regression-modeling puzzle.

No decision yet; write up the trade-off and bring it to the next all-hands.

**Files if the decision lands:** `decision-validation.js` (remove floor check), `chef-system.js` or catalog seed (set `minBidFloor`), `AuctionPage.tsx` chef-card labels.

---

### FE-I20 — Results cards duplicate their values in the label strip below

**Severity:** Cosmetic (P2). Flagged during manual playtest.

**Symptom.** The Results phase shows three big KPI cards (Revenue, Customers, Satisfaction) and **then** a label strip below that repeats the same three values with text labels. Visually noisy and redundant.

**Files.** [ResultsPhase.tsx:225–265](app/src/pages/phases/ResultsPhase.tsx:225). The duplicate lives in the `<dl>`-ish label rows at lines 248–265 (`label="Net revenue"`, `label="Customers"`, `label="Customer satisfaction"`).

**Fix.** Drop the three redundant label rows. Keep the "Chef satisfaction" row (unique), and keep the "Gross revenue" row inside the fallback branch (also unique).

**Before:**
```
[ Revenue      $160,800 ]    [ Customers 179 ]    [ Satisfaction 83 ]
  Net revenue        $160,800
  Customers               179
  Customer satisfaction    83/100
  Chef satisfaction       100/100
```

**After:**
```
[ Revenue      $160,800 ]    [ Customers 179 ]    [ Satisfaction 83 ]
  Chef satisfaction       100/100
```

**Acceptance.** Visual QA on the Results screen shows each KPI once. Chef-satisfaction detail still visible.

---

### FE-I21 — End-game Conclusion screen needs polish

**Severity:** Cosmetic (P2). Last screen every student sees — worth making it feel finished.

**Symptom.** Conclusion page today is a functional rankings list, but feels drafty compared to the polished Results-phase card layout. Specific complaints:
- Winner announcement isn't visually distinct from the rest of the rankings.
- Final team revenue numbers live in a plain table — no "hero" treatment.
- No post-game summary of key moments (best round, biggest auction, biggest debt).
- The chef roster display for the winning team is a dense list instead of portrait cards.

**Fix (outline).** Bring the visual style from `ResultsPhase.tsx` to `ConclusionPage.tsx`:
1. Hero banner at top — "🏆 Winning Team: **Bread Winners**" with team logo/emoji and $net.
2. KPI cards for the class — `Total customers served`, `Total revenue generated`, `Largest debt taken on`, `Highest satisfaction round`.
3. Ranking table kept but restyled to match the leaderboard card style (`LeaderboardPage.tsx` already has this — consider extracting).
4. Winning roster → use the same chef-portrait cards as the Roster phase (`ChefCard.tsx` or equivalent).
5. "Play again?" CTA for the professor only — else "Thanks for playing, here's your CSV" link for students.

**Files.** [ConclusionPage.tsx](app/src/pages/ConclusionPage.tsx), reuse components from `ResultsPhase.tsx` and `LeaderboardPage.tsx`.

**Acceptance.** Design review with Mia + AB; before/after screenshots attached to the PR. No new data shown that the backend doesn't already provide (`getConclusion` already returns rankings + chef rosters).

---

## Suggested Sequencing

Split into tracks so backend + frontend can run in parallel.

**Backend track (Scott / Dylan B.)**
1. **Day 1:** BE-I03 (schema cleanup) → BE-I01 (cost multiplier fix, depends on I03) → add `test-multi-team-costs.js` → verify end-to-end via the `/tmp/playtest.js`-style harness.
2. **Day 2:** BE-I02 (chef cap enforcement) → BE-I04 (auto-assign for 2-player teams) → BE-I13 (backend branch of the Clear-role fix, backend side). All three touch the role/roster transaction; batching them keeps the diffs coherent.
3. **Day 3:** BE-I17 (real pause). Non-trivial because it touches `phaseEndsAt` bookkeeping plus six submit callables. Slot it after I04 so the "solo-fallback" guard already exists everywhere you'd be adding the paused guard.
4. **Day 4 (pre-launch cleanup):** BE-I05 / I06 / I07 / I08 / I09 / DOC-I10 — all small. Group into one PR titled something like "schema and doc cleanup before live session".

**Frontend track (AB / Kavin)**
1. **Day 1:** FE-I16 (leading-zero bid input, 1-line fix) → FE-I18 (submission grid — verify prof claim path, surface the banner) → FE-I15 client side (enable submit when roles unfilled, reading `roleAssignments`).
2. **Day 2:** FE-I14 (rewrite role-picker briefing copy) → FE-I20 (drop duplicate metric labels on results).
3. **Day 3+:** FE-I21 (Conclusion polish). Needs design time with Mia.

**Game-design track (Dylan M. / Mia)**
- DESIGN-I19: decide on minimum-bid-floor direction and write it up in `GAME_DESIGN_PROPOSAL.md` before code work starts on the chef bid UI.
- Post-launch / nice-to-have: UX-I11 tie-break choice, FE-I12 simulating-phase timing.

### Cross-track coordination points

- **BE-I04 + FE-I15 must ship in the same release.** Backend is the safety net, frontend is the UX. Ship only one and you either (a) have silent role-denies with confusing disabled buttons, or (b) have enabled buttons that throw permission-denied on click.
- **BE-I13 + FE-I14** bundle naturally (same screen, same PR-reviewer context).
- **BE-I01 + BE-I03** must land together. Splitting them risks a half-migrated auction-results doc shape in production.

## Testing recommendations

Before merging any of the P0 fixes:

1. **Add a multi-team economic test** (`test-multi-team-costs.js`): 1-member + 3-member team submit identical decisions, both win identical auctions, assert `totalSpent`, `budgetCurrent`, and `revenueNet` match between them.
2. **Add a roster-cap enforcement test**: 3-member team wins 4 chefs; assert phase advance out of roster throws until one is laid off or auto-dropped.
3. **Re-run `backend/scripts/test-lifecycle.js`** — all 15 phase-transition assertions should pass after BE-I08.

Running `node functions/modules/__tests__/test-suite.js` from the backend dir should report **0 failed** before shipping.
