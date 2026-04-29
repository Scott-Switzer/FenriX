# Tasks April 28 — Post-Playtest Triage (Friday Apr 30, 8 AM Ship)

**Date:** 2026-04-28 (eve of pre-class hardening)
**Source:** in-person playtest with 12–15 students, two scribes
**Game date:** **Friday Apr 30, 8 AM** — ~36 working hours from now
**Bottom line:** core game loop holds. The biggest economic + correctness bugs are 1–10 line backend fixes. The biggest UX ones are role gating, sealed-bid display, and a top-bar that says who-does-what.

This doc verifies every note from the two scribe sheets against the code, dedupes overlap, and splits the work across **4 teams** to minimise merge conflicts. Massaro carries the backend + the panic-button fixes (most tokens, game lead). Each task has **Problem · Proposed Fix · Files · Priority · Effort**.

**Verification method:** every "Confirmed" task has been code-checked at the file:line shown. Items marked "Visual: verify in emulator" are subjective UX changes I couldn't deterministically confirm without playing — call those out at standup tomorrow.

---

## Legend

- **P0** — must ship before Friday 8 AM. Game-breaking, economically broken, or explicitly user-flagged.
- **P1** — high-value, ship if time. Real friction at playtest.
- **P2** — polish. Worth doing if a team finishes their P0/P1 early.
- **Effort:** XS (<1 hr) · S (1–3 hr) · M (3–8 hr) · L (1+ day)

| Team | Owner | Surface area | Approx total effort |
|---|---|---|---|
| 🔴 **Massaro** | game lead | All `backend/`, plus `ProfessorPage`, `GameContext`, presence/disconnect | ~3 days |
| 🟡 **Kavin / Sofia** | pair | Decide phase + sprites (BakeryView, StaffTab, ChefLayer) | ~1.5 days |
| 🟢 **Barlava** | solo | AuctionPage + data-purchase relocation + LoanSharkCallout | ~1 day |
| 🔵 **Scott** | solo | RoundHeader + ProfessorPage timer + naming/labels | ~1 day |

## How to track progress

Each task header has an inline checkbox: `## [ ] M-XX [P0, S] — title`. When you finish a task, edit it to `## [x] M-XX [P0, S] — title` (or add `(✅ DONE 2026-04-XX by <name>)` after the title for traceability). The doc IS the tracker — no separate Trello / GitHub Issues to keep in sync. Push to main with the checkbox flip in your PR.

To see what's still open: `grep "^## \[ \]" tasks-april-28.md`. To see what's done: `grep "^## \[x\]" tasks-april-28.md`.

---

## Confirmed role split (post-playtest)

This is the canonical role mapping for Friday. Several tasks (M-17, M-18, K-01, B-05, S-03, S-07) implement these moves:

| Role | Owns |
|---|---|
| **Operations** | Sous chefs · Maintenance · Equipment upgrade · Roster (lay off chefs) |
| **Finance** | Prices · **Quantities** (moved from Operations) |
| **Analyst** (renamed from Advertising / "Bidder") | Ad bids · **Chef bids** (moved from Finance) · Data purchases · CSV download |
| **Solo** | All of the above (when team has ≤ 2 members) |

---

## Cross-team coordination — read first

Five places where two teams touch the same file or depend on each other's work. Coordinate before touching:

1. **`app/src/pages/RosterPhasePage.tsx`** — Massaro adds the backend `layoffChefs` callable (M-13); Scott rewires the FE to use it (S-05). Massaro lands first.
2. **`backend/functions/modules/config.js`** — Massaro owns all backend config changes (`phaseDurations.simulating`, `phaseDurations.bid_*`). Scott does NOT touch backend.
3. **`app/src/pages/phases/ResultsPhase.tsx`** — Scott renames the CSV button (S-07); Barlava lifts data purchases into the same screen (B-05). Coordinate insertion point — Scott goes first (one-line label change), then Barlava adds the new section.
4. **Role-split chain (M-17 + M-18 + K-10 + K-01 + S-03):** Massaro lands M-17 (`submitPrices` accepts `quantities`) and M-18 (`roleOwnsChefBids` → advertising) first. Then K-10 wires the FE to send quantities through `submitPrices`. Then S-03 ships the rename + helper updates. Then K-01 applies the per-input greying using the new helpers. Sequence is hard — don't reorder.
5. **`app/src/types/game.ts`** — touched by M-17 (new `roleOwnsQuantities` helper), M-18 (`roleOwnsChefBids` body change), and S-03 (label rename). Land in that order; rebase any in-flight branches.

If you need to change a file someone else owns, ping in #bakery-bash before pushing.

---

# 🔴 MASSARO — backend + critical fixes

> Heaviest load. All P0 economy bugs + correctness fixes that need backend work. **No teammate should touch `backend/functions/` this sprint.**

### 🚀 Quick-win batch (knock out in one fresh window, ~30 min total)

These are all 1–5 line fixes. Land them as a single PR titled "April 28 quick wins" so the rest of your day is free for the harder M-02 / M-16 / M-17 work:

| Task | LOC | What to change |
|---|---|---|
| **M-01** | 1 | Add `equipmentUpgradePurchased` to the simulation decision payload at `backend/functions/index.js:2253` |
| **M-03** | 1 | Divide customerCount by `days` at `backend/functions/modules/multi-day-simulation.js:271` |
| **M-04** | ~5 | Add `cumulativeRevenue` to ranking entry at `index.js:2500-2510` + change sort key |
| **M-09** | 2 | Add `dailyBreakdown` to `ADD_RESULT` payload at `app/src/pages/GamePage.tsx:313-352` |
| **M-12** | 1 | `bid_ad: 45, bid_chef: 45` in `backend/functions/modules/config.js:447-448` |
| **M-15** | 1 | `simulating: 25` in same `config.js:455` |

After this PR lands, the bigger items (M-02 economy rebalance, M-16 race condition, M-17/M-18 role split) get clean test runs against fixed infrastructure.

---

## [x] M-01 [P0, S] — Equipment upgrade is silently dropped on the way to the simulator

**Problem.** Players who toggle "Upgrade Equipment" pay the cost in the UI, but the simulation never sees the upgrade — `equipmentUpgradePurchased` is missing from the assembled simulation `decision` object. Everyone's grade stays at C forever.

**Repro from code:** `backend/functions/index.js:2233-2253` builds the decision payload and spreads `menu / quantities / sousChefCount / sousChefAssignments / productPrices / staffCounts` only. `decision-validation.js:215-244` correctly extracts the flag onto the validated decision doc, but the simulator at `multi-day-simulation.js:250` reads `decision.equipmentUpgradePurchased` which is `undefined` → upgrade branch never fires.

**Fix.** Add **one line** at `index.js:2253`:
```js
equipmentUpgradePurchased: !!decision.equipmentUpgradePurchased,
```

**Acceptance.** Toggle the upgrade in decide → finish round → next-round Status tab shows the new grade.

---

## [x] M-02 [P0, M] — Specialty chefs should be a BONUS, not a gate. Today no-chef teams earn $0.

**User intent (confirmed Q2):** chefs are a multiplier on top of base, not a prerequisite. A team that takes no specialty chef in round 1 should still run a viable bakery and earn real money — just less than a team that won a chef.

**Problem.** Confirmed root cause at `backend/functions/modules/simulation.js:486-494`:
```js
if (customerCount === 0 && totalProductRevenue === 0) {
  revenueGross = adWinnerBonus;
}
```
When a team has no specialty chefs, satisfaction tanks → `customer-allocation.js:136` `Math.round(...)` rounds the team's allocation share to 0 → 0 customers → revenue zeroed. There is **no minimum-customer floor**. The base chef *does* produce 30 units (`chef-system.js:147,199`) but those units never get a customer.

**Fix.** Three-part, sized to make chefs feel like a +25–50% bonus rather than make-or-break:
1. In `customer-allocation.js`, raise the floor: any team with an open menu + stocked product gets at least `BASE_CHEF_CUSTOMERS = 12` per day. (12 ≈ ⅓ of base-chef daily output of ~30 units, leaves room for fill-rate loss.)
   ```js
   const computed = Math.round(weight * total);
   result.set(p.playerId, p.menuOpenAndStocked ? Math.max(BASE_CHEF_CUSTOMERS, computed) : computed);
   ```
2. Drop the `revenueGross = adWinnerBonus` kill-switch in `simulation.js:486-494`. Only zero `revenueGross` when **`offeredProducts.length === 0`** (truly closed).
3. In `customer-allocation.js`, when computing `weight = sat × priceMult`, also multiply by `(1 + 0.25 × specialtyChefCount)` so a team with 2 specialty chefs draws ~50% more customers than the same team with 0 — the "chef as bonus" framing in code form.

**Acceptance.** Run a 4-team sim:
- Team A: 0 specialty chefs, stocks 30 croissants @ $4 → ~$1,000–$1,500 net (was $0).
- Team B: 2 specialty chefs, same stock + price → ~$1,800–$2,500 net.
- The chef advantage is visible (~50% more) but not "$0 vs $2k".

**Risk.** Rebalances the entire economy. Smoke test against `test/multi-day-simulation.test.js` and update assertions. Tune `BASE_CHEF_CUSTOMERS` and the `0.25` multiplier with a 5-min sim run before committing.

**Also resolves Q8** (the "one team got 0 customers, did nothing different" report). Without the floor, a borderline-elastic round can flip a team from "small share" to "literally 0" with no obvious cause; the floor makes that impossible.

---

## [x] M-03 [P0, S] — Cleanliness drops to F with 5 maintenance staff

**Problem.** Confirmed at `equipment-cleanliness.js:42-46` returning `staffCount × 20 - customerCount × 0.20`. The applier at `multi-day-simulation.js:271` passes the **monthly** customer count (~1000–4000), not per-day. So 5 staff × 20 = +100 boost vs 2000 customers × 0.20 = –400 drain → score 0 → F. The constants were calibrated for a per-DAY count, not a 30-day aggregate.

**Fix.** At the apply site, divide by `days`:
```js
const _cleanlinessDelta = cleanlinessDriftDelta(maintenanceStaffCount, customerCount / days);
```

**Acceptance.** Team with 4 maintenance + 1500 monthly customers should land at A or B, not F. Verify in `test-cleanliness-drift.js` (write one if missing).

---

## [x] M-04 [P0, S] — Standings always show 0 (or the last round's net only)

**Problem.** Confirmed: `index.js:2497-2510` writes `revenueNet` into the leaderboard payload but **not** `cumulativeRevenue`. The FE at `LeaderboardPage.tsx:118-121` and `ResultsPhase.tsx:392-398` reads `cumulativeRevenue ?? revenueNet` — falls back to *per-round* net, which can easily be 0 on a bad round.

(The starting $10k complaint is a red herring: `cumulativeRevenue` starts at 0 and only increments by `revenueNet` post-loan-shark. The bug is that the FE never sees the running total.)

**Fix.** In `index.js:2500-2510`, when assembling each ranking entry, add:
```js
cumulativeRevenue: numberOrDefault(memberData.cumulativeRevenue, 0) + r.revenueNet,
```
Sort by `cumulativeRevenue` instead of `revenueNet` (one-line sort change).

**Acceptance.** After 3 rounds, leaderboard "Profit" column matches `players/{uid}.cumulativeRevenue` for every team.

---

## [x] M-05 [P0, S] — Cap team size at 3 (currently lets a 4th in)

**Problem.** `joinGame` (`backend/functions/index.js:1106-1257`) checks the game-wide `playerCap` (default 20) but **never compares team `memberCount` against a max**. The FE shows the count but never disables the join button.

**Fix.** In `joinGame`, when `outcomeNewJoin && tSnap.exists`:
```js
const current = tSnap.get('memberCount') || Object.keys(tSnap.get('roleAssignments') || {}).length;
if (current >= 3) {
  throw new HttpsError('resource-exhausted', 'That team is full (3 max).');
}
```

**Acceptance.** Try to join a 3-person team → red "team full" error.

(Scott will mirror this on the FE — see S-04. Massaro lands the backend gate first since it's the source of truth.)

---

## [x] M-06 [P0, M] — Late joiners can't enter once the prof presses Start

**Problem.** `index.js:1131-1134` rejects new uids with `failed-precondition` when `phase !== 'lobby'`. Rejoiners (existing uid) get through, but a fresh student who's late is locked out. User wants late joiners to slot into a team with room.

**Fix.** Drop the lobby gate for new joiners. Add an auto-routing branch: if no `teamId`/`teamNumber` provided, query `teams` where `memberCount < 3` ordered ascending, and assign to the first one — or auto-create a new team if none exists.

**Acceptance.** Start the game → second tab joins with a fresh anon auth → lands on a team with ≤2 members within 2 s.

---

## [x] M-07 [P0, S] — Auto-advance dies if the prof tab is backgrounded (round 2 didn't advance)

**Problem.** `ProfessorPage.tsx:506-531` is a single `setTimeout`. Browsers throttle setTimeout in backgrounded tabs (Chrome ≥ 1 s, can stretch to 1 min+). If the prof tabs over to look at something, round 2 never auto-advances.

**Fix.** Replace with a 1 s `setInterval` polling `Date.now() >= phaseEndsAtMs + extraDelay`, fire once, clear interval. Same `expectedFromPhase` guard so duplicates are still ignored.

**Acceptance.** Open the prof tab, switch to another tab for the full email-phase duration, switch back — game has advanced.

**Stretch (P1):** add a Cloud Scheduler safety net that fires `advanceGamePhase` if `phaseEndsAtMs` is more than 60 s in the past. Nice-to-have, not required for Friday.

---

## [x] M-08 [P0, S] — Refresh wipes the in-progress decision draft

**Problem.** `GamePage.tsx:243-296` re-hydrates `pendingDecision` only after `submitDecision` writes to Firestore. Local edits in `BakeryView` / `StaffTab` go into the in-memory reducer only. Refresh during decide → starts over.

**Fix.** In `GameContext.tsx`, persist `pendingDecision`, `pendingAdBids`, `pendingChefBids` to `localStorage` in the same key pattern as `PERSISTED_SESSION_KEY` (existing pattern at line 512-573). Rehydrate in `buildInitialState`.

**Acceptance.** Edit some quantities → refresh → quantities still there.

---

## [x] M-09 [P0, S] — Student CSV only has 1 row per round, not 30 (FE-only fix)

**User intent (confirmed Q5):** the **student** CSV is the one that matters — the professor isn't downloading these. So this is the FE download path on `RoundHeader.tsx`.

**Problem.** Backend already writes `lastRoundResult.dailyBreakdown` (30 entries) per `index.js:2407-2417`. The student-side `downloadResultsCsv` in `RoundHeader.tsx:200-209` already knows how to expand `dailyBreakdown` into per-day rows. **But** `GamePage.tsx:313-352` `ADD_RESULT` dispatch **does not include `dailyBreakdown` in the payload** — so the in-memory `roundResults` array never carries the daily data even though Firestore has it. CSV download falls back to the 1-row-per-round path.

**Fix.** Two lines:
1. `app/src/pages/GamePage.tsx:313-352` — add `dailyBreakdown: Array.isArray(lrr.dailyBreakdown) ? lrr.dailyBreakdown : undefined,` to the `ADD_RESULT` payload.
2. `app/src/types/game.ts` — confirm `RoundResult.dailyBreakdown` is in the type. If not, add `dailyBreakdown?: DailyBreakdownEntry[]`.

That's it. The CSV writer already does the per-day expansion. No backend change, no write-amplification concern, no `exportProfessorCsv` rework.

**Acceptance.** Open results after round 2 → click Download → CSV has 60 rows per team (2 rounds × 30 days). Verify a `day` column appears.

**Note.** `exportProfessorCsv` (the prof-side path) stays as-is — per Q5, the prof isn't using it. We can deprecate it post-Friday.

---

## [x] M-10 [P0, S] — Reclaim a teammate's role when they disconnect

**Problem.** When a player closes their tab, their role in `teams/{teamId}.roleAssignments` is never released. The remaining teammates can't take over and that submit-button stays disabled forever.

**Fix.** Add `reclaimTeammateRole({ gameId, teamId, targetUid })` callable that allows any teammate to clear `roleAssignments[targetUid]` if either:
- That uid's `presence` doc is stale (>60 s since last heartbeat), OR
- `players/{uid}.disconnected === true`.

Massaro does the backend. Scott wires the "Take over" button into RoundHeader (see S-06).

**Acceptance.** Open 3 tabs → assign roles → close one tab → wait 60 s → other tab can click "Take over" on the disconnected role and submit.

---

## [x] M-11 [P1, M] — Sealed bid: no more live "Top Bid" reveal during the auction (Massaro verified — no backend/non-AuctionPage leak; awaits B-01 FE change)

**Problem.** Currently `AuctionPage.tsx:854-861` (ads) and `:962-968` (chefs) render `topBidsAd[ad.id]` / `topBidsChef[chef.id]` live. User wants this hidden until the phase ends — true sealed-bid mechanic.

**Backend side (Massaro):** No code change needed. The sharded-top-bids module still tracks the leader so the auction resolution works; we just stop rendering that field on the FE.

**FE side (Barlava):** see B-01 — Barlava handles the AuctionPage display change. Massaro just confirms in-team that no other surface (ProfessorPage, devnav) leaks the live top bid to students.

**Acceptance.** Student bids $50 → another team bids $80 → student doesn't see the $80 until phase ends. After phase, AdWinnerBanner / ChefWinnerBanner reveal the winners.

---

## [x] M-12 [P1, XS] — Bid duration: 45 s (confirmed Q1, currently 90 s)

**Problem.** `config.js:447-448` has `bid_ad: 90, bid_chef: 90`. Per Q1 the user wants 45 s — gives students a real think while still feeling time-pressured.

**Fix.** Change to `bid_ad: 45, bid_chef: 45` in `config.js`. Re-run `scripts/test-70-players.js` to confirm submits still complete inside the window.

**Acceptance.** Bid timer counts down from 45 s. 70-player test still 70/70 succeed.

---

## [x] M-13 [P1, S] — Layoff multiple chefs in one shot (backend)

**Problem.** `index.js:3264-3335` `layoffChef` accepts one chefId. User wants batch.

**Fix.** Add sibling callable `layoffChefs({ gameId, chefIds: string[] })` that does all writes in one transaction (one chefReturnPool batch, one player-doc update with the filtered roster). Authorize same as `layoffChef`.

Scott consumes this from the FE — see S-05. **Massaro lands first.**

**Acceptance.** FE can call `layoffChefs({ gameId, chefIds: [a, b] })` → both chefs leave the roster in a single Firestore write.

---

## [x] M-14 [P1, S] — Customers should still walk in even at high prices (price elasticity tuning)

**Problem.** `pricing.js:43-52` uses a per-product elasticity coefficient; cookies/coffee/bagel/sandwich/matcha are all `high=1.5` (`config.js:169`). Combined with M-02's no-floor bug, a $1 difference can route 0 customers to the higher-priced team.

**Fix.** Two complementary changes:
1. After M-02 lands (customer floor), high-elasticity teams will still get *some* foot traffic.
2. Soften `high` from 1.5 → 1.2 in `config.js:169` so a $1-over-mid step is multiplier `0.7` instead of `0.625`. Conservative.

**Acceptance.** Run `test-pricing.js` with two teams at $4 and $5 cookies → both get >0 customers, the cheaper team gets meaningfully more (~60/40 split, not 100/0).

---

## [x] M-15 [P2, XS] — Simulation animation should run longer

**Problem.** `SimulatePhase.tsx:8` `DAY_DURATION_MS = 4000`, backend `simulating` phase is 8 s (`config.js:455`). Animation gets clipped.

**Fix.** Bump `phaseDurations.simulating` to 25 s. Also bump `SIMULATE_MIN_DISPLAY_MS` (Kavin/Sofia handle the FE side — see K-09).

**Acceptance.** Simulation animation plays end-to-end without abrupt cut.

---

## [x] M-16 [P0, M] — Race condition: simultaneous last-second bids credited to the wrong team

**Problem (confirmed Q7).** Round 2, two teams in the same lobby, both submitted bids at the timer = 0–1 s. One team was told they won an ad slot they didn't actually pay for; the other team's bid was credited to the wrong team. This is a classic last-write-wins race in the auction resolution path.

**Likely root cause.** `submitBids` (`backend/functions/index.js:3051+`) writes through `sharded-top-bids` which is designed for high concurrency, but the auction *resolution* (called from `advanceGamePhase` when the bid phase ends) may race with the freeze-window writes. Specifically: if a `submitBids` write commits between the resolution's read of "highest bid" and its write of "winnerId", the resolved-winner can be a stale read.

**Fix path.** Investigation + fix, in this order:
1. Read `backend/functions/modules/sharded-top-bids.js` — verify it tracks `(bidderUid, amount, submittedAtMs)` per slot. If `submittedAtMs` isn't tracked, add it.
2. Read the auction resolution code (search `index.js` for `resolveAdAuction` / `resolveChefAuction` / `auctionResults.ads`). Verify the resolution closes the bid phase BEFORE reading top bids — i.e., the freeze-stage `advanceGamePhase` should set a "bids closed" flag and reject any `submitBids` arriving after.
3. Tighten the gate: in `submitBids`, check `phase === 'bid_ad' || phase === 'bid_chef'` and reject if the read-time phase has flipped. Use `expectedFromPhase` (same pattern as `advanceGamePhase`) so a late bid can't slip in during phase transition.
4. Re-resolve the auction transactionally — wrap the "read top bids → write winnerId" sequence in a single `runTransaction`.

**Effort:** investigation 1 hr + fix 2–3 hr. Has the highest "we won't know until we run it" risk on the list.

**Acceptance.** Simulate two bots submitting `submitBids` exactly at `phaseEndsAtMs` (or later by 100ms). The later bid should be REJECTED with `failed-precondition`, and the resolved winner should match what the FE shows. Add a regression test `scripts/test-bid-race-condition.js`.

**If we run out of time:** fallback is M-12's tighter timer (45 s) + the existing 3 s freeze grace — the race window shrinks but doesn't close. Document the known issue and ship.

---

## [x] M-17 [P0, M] — Move quantity ownership from Operations to Finance

**Problem (confirmed Q6).** Today Operations owns the entire decide submit (menu + quantities + sous chefs + maintenance + equipment) via `submitDecision`, while Finance owns only prices via `submitPrices`. Per the new role split, Finance should also own quantities.

**Backend fix.**
1. Update `submitPrices` (`backend/functions/index.js`, search for `exports.submitPrices`) to also accept `quantities: Record<ProductKey, number>`. Validate via the same shape check used in `decision-validation.js`.
2. Update `submitDecision` to STRIP `quantities` from its accepted payload — Operations no longer writes quantities. Keep `staffCounts`, `equipmentUpgradePurchased`, `menu`, etc.
3. The simulation `decision` assembler at `index.js:2233-2253` reads from the stored decision doc — the doc still has both fields after both submits land, so no change here.
4. Add a new helper `roleOwnsQuantities` in `app/src/types/game.ts` returning `role === 'finance' || role === 'solo'`. Coordinate with K-01 (Kavin/Sofia gate the quantity steppers).

**Acceptance.** Finance can submit a round with prices + quantities; Operations submits without touching quantities. Both submits land before the round can advance (existing checkmark grid already supports two submitters per team).

**Effort:** ~4 hr backend + tests; pairs with K-01 / K-10 on the FE side.

---

## [x] M-18 [P0, S] — Move chef bid ownership from Finance to Analyst

**Problem (confirmed Q6).** Today `roleOwnsChefBids` returns `finance || solo`. Per the new role split, the renamed Analyst role (was Advertising) owns BOTH ad bids and chef bids.

**Backend fix.**
1. `submitBids` (`index.js:3051+`) currently authorizes chef bids when `role === 'finance' || role === 'solo'`. Change to `role === 'advertising' || role === 'solo'` (advertising stays as the backend role string; only the label changes — see S-03).
2. Update `app/src/types/game.ts` `roleOwnsChefBids` → `role === 'advertising' || role === 'solo'`.
3. Verify the role-gated tooltip in `AuctionPage.tsx:768-783` (`canSubmitForPhase`) still works post-change.

**Acceptance.** Sign in as Finance → cannot submit chef bids. Sign in as Analyst → can submit both ad AND chef bids.

**Effort:** ~1.5 hr.

---

## [x] M-19 [P1, S] — Prof checkmarks always show ✓ for completed phases (Q10 confirmed)

**Problem (confirmed Q10).** When the round advances past a phase, missing teams' checkmarks stay ⏳ in `ProfessorPage.tsx`. User wants them to flip to ✓ regardless of whether the team actually submitted — the round moved on, so visually it's "done."

**Fix.** In `ProfessorPage.tsx` `teamPhaseStatus` (line 570-631), add a "phase already passed" check. The ordering is `bid_ad → bid_chef → roster → decide → simulating → results_ready → email`. If `currentBasePhase` is past `phaseKey` for the same round, return `{submitted: true, ...}` regardless of the submissions doc.

Implementation sketch:
```js
const PHASE_ORDER = ['bid_ad', 'bid_chef', 'roster', 'decide'];
const currentIdx = PHASE_ORDER.indexOf(currentBasePhase);
const phaseIdx = PHASE_ORDER.indexOf(phaseKey);
const phaseAlreadyPassed = currentIdx > phaseIdx ||
  ['simulating', 'results_ready', 'email'].includes(currentBasePhase);
if (phaseAlreadyPassed) {
  return { submitted: true, submittedBy: null, submittedByUid: null, preferredRole };
}
// ...existing logic for the active phase
```

**Acceptance.** Round 1 phase = `decide`. Bid_Ad / Bid_Chef / Roster columns all show ✓ for every team, even if some teams never actually submitted. Decide column shows ⏳/✓ based on real submission status.

**Files:** `app/src/pages/ProfessorPage.tsx`.

---

## [x] M-20 [P1, S] — Budget doesn't grow with revenue (Q13) — likely a downstream symptom of M-02 (verified — no code change needed per investigation; transitively fixed by M-02 PR #137; final 2-round playtest confirmation Wed 4 PM)

**Investigation result (2026-04-28).** The math IS correct in the code:
- `loan-shark.js:77-79` `updateBudget(budgetCurrent, revenueNet, totalSpent) → budgetCurrent + revenueNet - totalSpent`. Correct formula.
- `multi-day-simulation.js:282` `const budgetAfter = Math.round(updateBudget(...))`. Correct invocation.
- `index.js:2332` `budgetCurrent: r.budgetAfter`. Correct write — the post-sim budget overwrites the pre-sim budget. Direct overwrite, not increment, so no double-apply risk.

So if budget isn't growing, the most likely real culprit is **M-02** — when teams have 0 customers and 0 revenue (today's bug), `revenueNet = 0` and `budgetAfter = budgetCurrent - totalSpent`. Budget shrinks (or stays flat if they spent nothing), making it look like "money doesn't accumulate."

**Plan.**
1. Land M-02 first (customer floor + chef-as-bonus rebalance).
2. After M-02 ships, run a 2-round sim and verify: round 2 `budgetCurrent` ≥ round 1 budget for any team with positive `revenueNet`.
3. If budget STILL doesn't grow post-M-02, investigate. But based on the code, M-02 should fix this transitively.

**Files (if real bug surfaces post-M-02):** `backend/functions/index.js`, `backend/functions/modules/multi-day-simulation.js`.

**Acceptance.** After M-02: team starts round 1 with $X. Earns $Y net. Round 2 Hire-tab affordability shows $X + $Y - costs available. Confirms via `test/multi-day-simulation.test.js`.

**Effort downgraded from M to S** since the plan is mostly verification. Time saved goes to M-16.

---

## [x] M-21 [P1, S] — Expose what-hurt-satisfaction signals on lastRoundResult (Q16)

**Investigation result (2026-04-28).** Read `satisfaction.js`. The actual data model is **NOT** "price + fill rate + cleanliness all add up to satisfaction." Reality:
- **Satisfaction = function of fill rate per product only** (`satisfaction.js:65-86` `fillRateToSatisfactionPct`). Per-product satisfaction is then weighted-averaged across products via `aggregateProductSatisfaction` (line 145-170).
- **Price** affects **demand** (in `pricing.js`), not satisfaction.
- **Cleanliness** affects **foot traffic** (separate multiplier), not satisfaction.

So the user's mental model ("3 factors hurt satisfaction") doesn't match the math. But the user's intent ("show me what hurt my round") is reasonable. Best resolution: surface the three relevant signals **alongside** satisfaction — they're each computed already.

**Backend fix.** In `backend/functions/index.js` around line 2343-2349 where `lastRoundResult` is assembled, add:
```js
roundSignals: {
  satisfactionPct: r.aggregateSatisfactionPct, // already exposed; keep for UI grouping
  perProductSatisfaction: r.perProductSatisfaction, // already computed; pass through
  cleanlinessGrade: r.cleanlinessGrade,             // already exposed
  cleanlinessScore: r.cleanlinessScore,             // already exposed
  priceCompetitivenessPct: ...,                     // NEW — average of price multipliers vs ceiling
},
```
The first four are already computed — pure passthrough. `priceCompetitivenessPct` is the only new value: in the simulation post-processing, average each product's price multiplier from `pricing.js` and convert to a 0-100 scale ("100% = perfect price for demand").

**Pairs with B-07** (Barlava renders these as a "what hurt this round" panel on Results).

**Files:** `backend/functions/modules/multi-day-simulation.js` (compute `priceCompetitivenessPct`), `backend/functions/index.js:2343-2349` (passthrough), `app/src/types/game.ts` (add type).

**Acceptance.** `lastRoundResult.roundSignals` is populated for every team after every round with all four signals.

---

## [x] M-22 [P0, M] — Player-leaves-mid-game graceful handling (shipped via PR #149 — backend auto-clear + fan-out ticker; FE banner from item #3 deferred; follow-up: atomic role-clear via WriteBatch, hook timeout-leak cleanup, `parsePhase` no-phase guard)

**Problem.** Original playtest note: *"Need error handling for when a teammate leaves, their role is just gone."* M-10 + S-06 cover the **manual** role-reclaim path (a teammate clicks "Take over"). But there's no broader story for "a player closed their tab and isn't coming back" — and a non-trivial number of students will abandon mid-round in a 70-player class. Today the team is effectively stuck waiting for them:
- Their `presence` heartbeat goes stale ~60 s after last ping (already detected)
- Their `players/{uid}.disconnected` flag is set only at end-of-round (too late)
- Their `roleAssignments[uid]` claim stays put forever
- The team's submission grid stays at ⏳ for any phase they own
- Auto-advance still fires per the timer, but the team submitted nothing for that role's decisions → loses the round

**Scope (minimum viable for Friday).** Backend-led, ~4 hours:

1. **Promote stale-presence detection from end-of-round to live.** Add a Firestore-triggered (or scheduled) function that flips `players/{uid}.disconnected = true` when their `presence/{uid}.lastSeenAt` is more than **90 s** old. Today this only fires at end-of-round; do it continuously so the team sees the disconnect within a round.
2. **Auto-clear the role claim when stale during a submission phase.** When a player goes stale AND the current phase is one they own (`bid_ad`/`bid_chef`/`roster`/`decide`), automatically clear `teams/{teamId}.roleAssignments[uid] = null`. Existing FE-I15 helpers (`roleOwnsX` falls back to "any teammate" when nobody holds the role) take it from there — any teammate can submit. This is the auto version of M-10's manual `reclaimTeammateRole` callable.
3. **Team-visible banner.** When a teammate is detected stale, render a banner on every other teammate's screen: *"Bob disconnected — anyone on the team can submit their role's decisions now."* Reuses S-06's "Take Over" button pattern but at the team-banner level rather than per-pill.
4. **Verify team can advance.** After M-17 + M-18 land (role moves), explicitly test: 3-person team where one player goes stale during decide — the remaining 2 must be able to submit on the leaver's behalf and the round must advance normally.
5. **Don't double-charge.** If a stale player had pending bids/decisions submitted before going stale, those stay valid (they paid for them). Only the role *claim* gets released, not the *work* they already submitted.

**Pairs with:** M-10 (manual reclaim, already on Massaro's list), S-06 (Take Over button per-pill, on Scott's list). M-22 is the layer above — auto-detect + team banner + don't-block-on-them.

**Files:** `backend/functions/index.js` (presence stale detection + auto-clear role), possibly a new `backend/functions/modules/presence.js` for the staleness logic, `app/src/components/game/RoundHeader.tsx` (team-visible banner; coordinate with S-01 / S-06 if landing same day), `app/src/types/game.ts` (verify `roleOwnsX` fallback still works post-M-17/M-18).

**Acceptance.**
- Open 3 tabs as a team. Close one tab. Within 90 s, the other 2 see a banner naming the disconnected player.
- The remaining 2 can submit any decision (bids, prices, quantities, staff) without the prof manually intervening.
- The round auto-advances on the timer regardless of the disconnected player.
- The disconnected player's previously submitted decisions (if any) still apply to the simulation.

**Effort:** M (~4 hr backend + ~1 hr FE banner). Higher-priority than M-19 since it directly affects whether a team can complete a round.

**Risk.** False positives — a player on a slow connection might tick stale, lose their role, then reconnect to find they can't submit anymore. Mitigation: when a stale player reconnects, restore their role claim if no teammate has taken it over yet. Track via `roleAssignments[uid] === null` AND `roleAssignments[uid]_releasedAt` timestamp; on reconnect within 5 min, restore.

---

# 🟡 KAVIN / SOFIA — Decide phase, sprites, sync

> Pair work — split as you like. Total ~1.5 days for two people. Touching `BakeryView`, `GameContext`, `StaffTab`, sprites.

## [ ] K-01 [P0, M] — Grey out non-role inputs across Decide (split per new role mapping)

**Problem.** Non-role-owners can edit decide inputs (only the submit button is gated). Confirmed at `GamePage.tsx:736-743` (only `canSubmit` gated) and `BakeryView.tsx:300, 226, 457` (only price gated). Plus the new role split (per Q6 + M-17) means **different inputs need different gates** within the same screen.

**Fix.** Per-input gating using the new role helpers (depends on M-17 landing the `roleOwnsQuantities` helper):

| Input | Gate (role) | Helper |
|---|---|---|
| Menu toggles (auto-on per K-04, but if user can disable) | Finance / Solo | `roleOwnsQuantities` |
| Quantity steppers | Finance / Solo | `roleOwnsQuantities` |
| Price inputs | Finance / Solo | `roleOwnsPricing` (existing) |
| Sous-chef steppers | Operations / Solo | `roleOwnsDecide` (existing — but rename to `roleOwnsStaff` for clarity) |
| Maintenance steppers | Operations / Solo | same |
| Equipment upgrade button | Operations / Solo | same |

Pass `disabled={!roleOwnsX(role, teamRoleAssignments)}` on each input. Add a tooltip naming the role-owner ("Your Operations teammate submits this decision.").

**Coordination:** waits on M-17 landing the new helper. Until then, apply the existing `roleOwnsDecide` gate to non-Finance inputs and follow up.

**Acceptance.** Sign in as Operations → quantity steppers visibly disabled with tooltip "Your Finance teammate submits quantities." Sign in as Finance → sous-chef steppers disabled with tooltip "Your Operations teammate submits staff."

**Files:** `app/src/pages/GamePage.tsx`, `app/src/components/game/BakeryView.tsx`, `app/src/components/game/tabs/StaffTab.tsx`.

---

## [ ] K-02 [P0, S] — Decision drafts don't sync across teammates fast enough

**Problem.** User report: "one person tries to sell 10 and it doesn't update fast enough across the team." `GamePage.tsx:380-472` already subscribes to the team-pending doc, but **draft writes only happen on submit** — local edits don't propagate until the role-owner clicks Submit.

**Fix.** Add a debounced auto-save (`~500 ms`) that calls a new lightweight callable `saveDecisionDraft({ gameId, draft })` whenever `pendingDecision` changes locally. Backend writes a merge to `teams/{teamId}/state/pending.decisionDraft` (the listener already picks this up).

**Coordinate with Massaro** — the new callable lives in `backend/functions/index.js`. Open a quick PR to him for the backend stub (~20 lines) before you wire the FE side.

**Acceptance.** Player A bumps croissants from 10 → 15 → Player B sees the change in <1 s without A clicking Submit.

**Files:** `app/src/pages/GamePage.tsx`, `app/src/contexts/GameContext.tsx`, `backend/functions/index.js` (Massaro lands).

---

## [ ] K-03 [P0, S] — "Miscellaneous" spend doesn't show on teammates' screens

**Problem.** `GameContext.tsx:430-442` `ADD_MISC_SPEND` updates **local state only**. When Finance buys competitor intel, only Finance's tab sees the deduction line.

**Fix.** Same auto-save as K-02 — include `pendingDecision.miscSpent` in the team-doc draft. The team-pending listener already echoes draft fields; just add `miscSpent` to the field list at `GamePage.tsx:400-430`.

**Acceptance.** Finance buys $100 intel → Operations sees the $100 line item appear in <1 s.

---

## [ ] K-04 [P0, S] — Auto-enable all unlocked products (kill the "+ Add" button)

**Problem.** `BakeryView.tsx:259-268` renders "+ Add" buttons for unlocked-but-disabled products. User wants them auto-enabled.

**Fix.** In the `SET_TEAM_UNLOCKS` reducer (`GameContext.tsx:444+`), when adding a product to `unlockedProducts`, also flip `pendingDecision.menu[product] = true`. Remove the "+ Add" branch from `BakeryView.tsx:259-268`.

**Acceptance.** Team unlocks bagels mid-decide → bagel station immediately editable, no separate "Add" click needed.

---

## [ ] K-05 [P0, S] — Carry the menu/products forward into the next round

**Problem.** User report: "If they buy a new product, it should stay the same the next round." `decision-validation.js:421` resets `menu` to `BASE_MENU` each round; bought-but-unstocked products don't survive.

**Fix.** Hydrate next-round `pendingDecision.menu` from the player doc's persisted `unlockedProducts` (already on the player doc — set on purchase). One place: when `SET_ROUND` fires (`GameContext.tsx`, find the `SET_ROUND` reducer), seed `menu` with `{ ...BASE_MENU_TRUE, ...unlockedProductsAsTrue }`.

**Acceptance.** Round 1 unlock bagels → round 2 starts with bagels in menu, same as croissants.

---

## [ ] K-06 [P1, M] — Sous-chef sprites: white hat, navy apron, white t-shirt

**Problem.** User wants the sous-chef sprites visually distinct as chefs. Current: `chef-bakery.ts:20-33` palette uses cream/white. No navy apron.

**Fix.** Recolor palette index 6 (apron) to navy across `chef-bakery.ts`, `chef-deli.ts`, `chef-barista.ts`. Confirm hat is white (already is) and chest is white (palette index 5 or similar — verify visually).

**Files:** `app/src/components/bakery-scene/sprites/chef-bakery.ts`, `chef-deli.ts`, `chef-barista.ts`.

**Acceptance.** Visual: open the simulation → sous chefs read as "chef" not "blue blob".

---

## [ ] K-07 [P1, L] — Render specialty chefs in the simulation kitchen

**Problem.** `SimulatePhase.tsx:108-121` plumbs only `staffCounts` (sous-chef counts) into `<PixelBakeryScene>`. Specialty chefs from the team's roster never render.

**Fix.** Plumb `specialtyChefs` from `GameContext` through `SimulatePhase` → `PixelBakeryScene` → `ChefLayer`. Render them as separate sprites with nationality-distinct colors (use existing chef-portrait icons in `/assets/chefs/`). One sprite per specialty chef, positioned alongside the sous chefs.

**Files:** `app/src/components/bakery-scene/PixelBakeryScene.tsx`, `useBakeryScene.ts`, `ChefLayer.tsx`.

**Acceptance.** Team with 2 specialty chefs (1 French, 1 Japanese) → kitchen shows 2 distinct chef sprites + however many sous chefs.

---

## [ ] K-08 [P2, S] — Condensed menu on the left of decide (price/qty without scrolling)

**Problem.** User wants a left-side condensed menu strip with price + quantity instead of scrolling through stations. Big restructure.

**Fix.** Restructure `GamePage.tsx` decide layout: keep `<BakeryView>` as the visual scene, but add a left-rail summary panel showing each product with inline `price · qty` editors. Read-only mode mirrors the rail.

**This is the biggest non-Massaro task. If you're tight on time, defer to next sprint.** Visual: verify in emulator before Friday.

**Files:** `app/src/pages/GamePage.tsx`, possibly a new `app/src/components/game/MenuRail.tsx`.

---

## [ ] K-09 [P2, XS] — Bump simulation min display to match Massaro's backend bump

**Problem.** Pairs with M-15. Frontend min display needs to match the new backend duration.

**Fix.** `SimulatePhase.tsx:8` — bump `SIMULATE_MIN_DISPLAY_MS` to `20_000`. Coordinate with Massaro's `phaseDurations.simulating` change.

---

## [ ] K-10 [P0, S] — FE: Finance submits quantities (pairs with M-17)

**Problem.** Today the quantity steppers in `BakeryView.tsx` write to `pendingDecision.quantities`, which is sent up by Operations' `submitDecision`. After M-17 lands, the backend `submitPrices` callable will accept quantities — the FE needs to send them in that call.

**Fix.**
1. In `GamePage.tsx`, find the `submitPrices` call (search for `httpsCallable(functions, "submitPrices")`). Extend the payload to include `quantities: pendingDecision.quantities`.
2. Remove `quantities` from the `submitDecision` payload (a few lines above).
3. After M-17 + S-03 land, gate the quantity steppers in `BakeryView.tsx` using the new `roleOwnsQuantities` helper (this is K-01's job — coordinate).

**Coordination.** Land AFTER M-17. Sequence: Massaro ships M-17 → Kavin/Sofia immediately ship K-10 → K-01 follows for the gating polish.

**Acceptance.** Round runs end-to-end with Finance submitting prices+quantities and Operations submitting staff. Both checkmarks must land for the round to advance.

**Files:** `app/src/pages/GamePage.tsx`.

---

## [ ] K-11 [P0, S] — Remove the "Update Prices" friction button (Q12 + Q14)

**Investigation result (2026-04-28).** Located at **`app/src/pages/GamePage.tsx:825-840`**. The offending UI is the secondary submit button rendered alongside the primary one in `<SubmissionLock>`'s action slot:
```tsx
{roleOwnsPricing(role, teamRoleAssignments) && (
  <button onClick={handleSubmitPrices} disabled={submittingPrices || !gameId}>
    {submittingPrices ? "Submitting…"
      : pricesSubmitted ? "✓ Update Prices" : "Submit Prices"}
  </button>
)}
```
The button itself isn't the gate — it's just the submit. The actual friction comes from how the BakeryView is rendered above: `<BakeryView readOnly={decisionSubmitted}>` at line 805 uses `decisionSubmitted` (Operations' submit state), but PriceInput is likely cross-checking `pricesSubmitted` to lock itself once Finance has clicked "Submit Prices" once. So Finance submits → inputs lock → they have to click "Update Prices" to unlock → edit → re-submit.

**Fix.** After M-17 lands, the entire two-button pattern collapses: Finance owns prices+quantities under one submit, no separate "Submit Prices" button at all. Plan:
1. Wait for M-17 to merge.
2. Delete the `roleOwnsPricing(...) &&` button block at `GamePage.tsx:827-840` and the `handleSubmitPrices` handler (line ~657-671).
3. The single Finance submit (the existing primary submit at line 841-852) should call the unified `submitPrices` callable that now accepts both prices + quantities.
4. In `PriceInput.tsx`, remove any `pricesSubmitted`-based readOnly logic. Inputs should follow `roleOwnsPricing` only (or `roleOwnsQuantities` per K-01).

**Acceptance.** Land on round 2 → click directly into a price input → type a new value → no intermediate "Update Prices" button visible anywhere. One Finance submit at the end of decide.

**Files:** `app/src/pages/GamePage.tsx:825-840`, `app/src/components/game/PriceInput.tsx`.

---

# 🟢 BARLAVA — Auction + data purchases + loan shark

> Solo work, ~1 day. AuctionPage is the main file; data purchases move from GameSidebar to ResultsPhase.

## [ ] B-01 [P0, S] — Hide live "Top Bid" during the auction (sealed bid)

**Problem.** `AuctionPage.tsx:854-861` (ads) and `:962-968` (chefs) render the live top bid. User wants sealed-bid behavior.

**Fix.** Replace the rendered top-bid value with a placeholder copy: "Sealed — revealed when round ends." Keep the data fetch alive (we still need it for `isLockedAdBid` etc.) — just don't display the number. Also remove the `isTiedAdBid` "Tied — raise your bid to win" warning (it leaks the same info).

Update the descriptive copy at `AuctionPage.tsx:823-830` and the "How to Play" page accordingly: "This is a sealed-bid auction. Submit your best bid before the timer runs out — you won't see opponents' bids."

**Files:** `app/src/pages/AuctionPage.tsx`, `app/src/pages/HowToPlayPage.tsx`.

**Acceptance.** Bid input shows your bid only; opponents' top bid is not visible until results.

---

## [ ] B-02 [P0, S] — Max-input caps + red error (dollar 999,999 · qty 9,999 · staff 99) (Q17 confirmed)

**Problem.** No max on bid inputs (`AuctionPage.tsx:872-896, 986-1007`), price inputs (`PriceInput.tsx:48-59` only has per-product ceiling), quantity inputs (`BakeryView.tsx:200-210` only has min), or staff steppers (`StaffTab.tsx:14` `MAX_PER_ROLE = 20` — too low per Q17).

**Fix.** Three different caps for three input categories:

| Input category | Max | Error message | File |
|---|---|---|---|
| Dollar inputs (bids, prices) | **$999,999** | "Going way over budget there!" | `AuctionPage.tsx`, `PriceInput.tsx` |
| Product quantity | **9,999** | "Max 9,999 units per product." | `BakeryView.tsx` |
| Sous chef + maintenance staff | **99** | "Max 99 per role." | `StaffTab.tsx` (raise `MAX_PER_ROLE` from 20 to 99) |

Add `max={N}` and a red `--error` class + helper text per the pattern already present elsewhere (e.g. `auction-ad__bid-input--error` at AuctionPage:874). For staff: also bump the disabled-state on the increment button so 99 is the cap (currently 20).

**Files:** `app/src/pages/AuctionPage.tsx`, `app/src/components/game/PriceInput.tsx`, `app/src/components/game/BakeryView.tsx`, `app/src/components/game/tabs/StaffTab.tsx`.

**Acceptance.** Type 1234567 in a bid → red. Type 10000 in quantity → red. Try to add a 100th sous chef → button disabled, text caps at 99.

---

## [ ] B-03 [P0, XS] — Press Enter to submit bids

**Problem.** Confirmed: bid inputs only have `onChange`, no Enter handler.

**Fix.** Wrap each bid input row in `<form onSubmit={handleSubmitSingleBid(chef.id)}>` for chefs, or add `onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitBids(); }}` on ad inputs.

**Files:** `app/src/pages/AuctionPage.tsx`.

**Acceptance.** Type a bid → press Enter → bid submitted.

---

## [ ] B-04 [P0, XS] — Show chef nationality on the bid card

**Problem.** `AuctionPage.tsx:947-961` shows the chef portrait (filename derived from nationality) and `chef.name` ("French Chef") but no explicit nationality text badge separate from the name.

**Fix.** Add a small badge `<span className="auction-chef__nationality">{NATIONALITY_LABELS[chef.nationality]}</span>` near the name. Pattern matches the existing skill tag at line 954-958.

**Files:** `app/src/pages/AuctionPage.tsx`.

**Acceptance.** Chef card shows "Italian" badge clearly.

---

## [ ] B-05 [P1, M] — Move data purchases out of the sidebar into the Results screen

**Problem.** `GameSidebar.tsx:197-288` houses competitor intel + Tier 1/2 chef data, gated to Finance during decide. Per Q3, user wants them on Results, gated to the just-played round only — no buying older rounds.

**Fix.**
1. Lift the JSX + handlers from `GameSidebar.tsx:197-288` into a new section in `ResultsPhase.tsx` near the `Download CSV` button (`ResultsPhase.tsx:222-230`).
2. Change the round arg to `currentRound` (Results shows the just-finished round). **Do NOT support buying older rounds.** If the FE somehow has historical results loaded, show only the current-round buy button.
3. Gate purchases on `role === 'advertising' || role === 'solo'` (the renamed Analyst — coordinate with S-03).

**Files:** `app/src/pages/phases/ResultsPhase.tsx`, `app/src/components/game/GameSidebar.tsx`.

**Acceptance.** Decide phase has no data-purchase section. Results phase has the three data-buy buttons next to the CSV download. Only Analyst sees them. Only the just-finished round is purchasable.

---

## [ ] B-06 [P1, S] — Make the loan shark visible (Q4 confirmed: show inline warning during Decide)

**Problem.** `LoanSharkCallout.tsx:25` only renders when `amountBorrowed > 0` and only on the Results phase. No live warning during decide that "this decision will trigger borrowing." User report: "Loan shark is not clear."

**Fix.** Both:
1. In `LoanSharkCallout.tsx`, surface the interest rate explicitly: "Borrowed $X at 10% interest — paid $Y this round."
2. **Confirmed Q4: ship the inline warning.** On `BakeryView.tsx` near the `totalCommitted` calc (~line 385), if `totalCommitted > budgetCurrent`, show a yellow chip: "⚠ This decision will trigger the loan shark — 10% interest." This crosses the "budget hidden during play" rule on purpose; the user explicitly OKed it. Update the Hard UI Rule comment in the affected file noting the override.

**Files:** `app/src/components/game/LoanSharkCallout.tsx`, `app/src/components/game/BakeryView.tsx`.

**Acceptance.** Player overspends → callout shows "Borrowed $X · interest $Y · 10% rate." Inline warning chip appears in Decide as soon as `totalCommitted > budgetCurrent`.

---

## [ ] B-07 [P1, S] — "What hurt this round" panel on Results (pairs with M-21)

**Investigation result.** See M-21 — satisfaction is NOT a literal sum of three components. Satisfaction = fill-rate based; price affects demand separately; cleanliness affects foot traffic separately. The right UX is to surface the three relevant signals as **sibling metrics** rather than as "components of satisfaction."

**Fix.** After Massaro lands M-21, add a "What hurt this round" panel to `ResultsPhase.tsx` between the metric cards and the auction results section. Show 3 indicator rows pulled from `lastRoundResult.roundSignals`:

```tsx
<section className="results-phase__signals">
  <h3 className="results-phase__section-title">What hurt this round?</h3>
  <ul className="results-phase__signal-list">
    <li>
      <span>Fill rate</span>
      <strong>{worstFillRateProduct.name}: {worstFillRateProduct.satisfactionPct}%</strong>
    </li>
    <li>
      <span>Price competitiveness</span>
      <strong>{priceCompetitivenessPct}%</strong>
    </li>
    <li>
      <span>Cleanliness</span>
      <strong>{cleanlinessGrade} ({cleanlinessScore})</strong>
    </li>
  </ul>
</section>
```

For fill rate, surface the WORST per-product satisfaction (e.g. "Bagel: 22%") since that's actionable. Color each row red (<60), yellow (60–79), green (≥80).

**Coordination.** Land AFTER M-21. Sequence: Massaro ships M-21 backend → Barlava picks up B-07 same day.

**Files:** `app/src/pages/phases/ResultsPhase.tsx`, plus a small CSS addition.

**Acceptance.** Results shows a "What hurt this round?" section. Worst-rated factor row is in red and points at the actual lever (which product, which signal).

---

# 🔵 SCOTT — Round header, professor timer, naming, layoff UI

> Solo work, ~1 day. Smaller, mostly UX polish.

## [x] S-01 [P0, S] — Top-bar bold role display + teammate role roster (✅ DONE 2026-04-29 by Claude/Scott)

**Problem.** `RoundHeader.tsx:286-298` shows the team label + a single role badge ("Active: X" or "Your turn: X"). User wants:
- Boldly specify who the current player is
- Show each teammate's role next to their name

**Fix.** Extend `round-header__team` block to render a small pill cluster:
- "**You** — *Operations*" (bolded, highlighted if `isActiveRole`)
- "Bob — Advertising"
- "Alice — Finance"

Pull names from `rosterByUid` (the existing roster listener), iterate `teamRoleAssignments`. Pattern roughly:
```tsx
{Object.entries(teamRoleAssignments).map(([uid, r]) => (
  <span key={uid} className={uid === playerId ? 'role-pill role-pill--mine' : 'role-pill'}>
    {uid === playerId ? <strong>You</strong> : rosterByUid[uid]?.displayName} — {PLAYER_ROLE_LABELS[r]}
  </span>
))}
```

**Files:** `app/src/components/game/RoundHeader.tsx`.

**Acceptance.** All 3 teammates' roles visible in the header. Your row is bold.

---

## [x] S-02 [P0, XS] — Visible countdown timer on the Professor panel (✅ DONE 2026-04-29 by Claude/Scott — PR #151)

**Problem.** `ProfessorPage.tsx` reads `phaseEndsAtMs` only to wire auto-advance. There's no rendered timer. The professor literally cannot see when the phase ends.

**Fix.** Reuse the existing `usePhaseCountdownSeconds` hook. Render next to the "+ 1 Min" button at `ProfessorPage.tsx:1080-1085`:
```tsx
<span className="professor-page__timer">{formatTime(usePhaseCountdownSeconds() ?? 0)}</span>
```
Color red when <30s (RoundHeader already has the CSS; reuse).

**Files:** `app/src/pages/ProfessorPage.tsx`.

**Acceptance.** Prof sees a live "0:42" countdown next to the controls.

---

## [x] S-03 [P0, S] — Rename "Bidder" → "Analyst" + update role helper labels and copy (✅ DONE 2026-04-29 by Claude/Scott)

**Problem.** Per Q6, Analyst (renamed from Advertising / "Bidder") owns ad bids + chef bids + data purchases + CSV download. Backend role string stays `advertising` for compatibility — only the labels and gating change.

**Fix.**
1. Change the label in `app/src/types/game.ts` `PLAYER_ROLE_LABELS.advertising` from "Bidder" to "Analyst".
2. Confirm `roleOwnsAdBids` already returns `advertising || solo` (no change needed).
3. `roleOwnsChefBids` — Massaro changes the helper in M-18; verify Scott's gating reads use the helper rather than hardcoded role strings.
4. In `GameSidebar.tsx:151`, rename `isFinance` → `isAnalyst`, gate on `role === 'advertising' || role === 'solo'`. (After Barlava's B-05 lifts the purchases out of GameSidebar, this gate moves with them — coordinate.)
5. Update copy in `HowToPlayPage.tsx` and `TeamPage.tsx` role descriptions:
   - **Analyst:** "Submits ad bids and chef bids in the auctions. Buys data sets in Results. Downloads the team's monthly data."
   - **Finance:** "Submits prices and quantities in Decide. Owns the team's pricing strategy."
   - **Operations:** "Submits sous chefs, maintenance, and equipment upgrades in Decide. Manages the chef roster (lay-offs)."

**Files:** `app/src/types/game.ts`, `app/src/components/game/GameSidebar.tsx`, `app/src/pages/phases/ResultsPhase.tsx` (post-B-05), `app/src/pages/HowToPlayPage.tsx`, `app/src/pages/TeamPage.tsx`.

**Acceptance.** Role badge says "Analyst" everywhere. Analyst can submit ad+chef bids and buy data. Finance can submit prices+quantities. Operations submits staff+roster.

---

## [x] S-04 [P0, XS] — FE side of the team-size cap (mirror M-05) (✅ DONE 2026-04-29 by Claude/Scott)

**Problem.** Even after Massaro lands the backend cap, the FE still lets students click into a 3-member team card.

**Fix.** In `LandingPage.tsx:452`, disable the team card button when `t.memberCount >= 3`. Show "Full" text.

**Files:** `app/src/pages/LandingPage.tsx`.

**Acceptance.** 3-member team's card is greyed out, "Full" label visible.

---

## [ ] S-05 [P1, M] — Lay-off UX redesign: instant lay-off + "Lay offs" panel + Re-hire button (Q15 confirmed)

**Problem (confirmed Q15).** Today: click chef → confirm modal → laid off → chef returns to pool permanently. User wants a richer UX:
- **(a)** Click chef → instant lay-off (no confirm modal).
- **(b)** Laid-off chefs appear in a "Lay offs" panel on the right side of the screen.
- **(c)** Each laid-off chef has a green "Re-hire" button. Clicking it puts the chef back on the roster — but **only if there's space** (i.e., team is currently at < `specialtyChefCap`). If the roster is full, "Re-hire" is disabled with a tooltip "Lay off another chef first."

The lay-off → re-hire is a **transient** state during the roster phase; once the phase advances, laid-off chefs are committed to the return pool and can't be re-hired in future rounds.

**Backend implications.**
- `layoffChef` (and the new `layoffChefs` from M-13) currently writes the chef to the return pool immediately. For instant-but-reversible lay-offs, EITHER:
  - **(α)** Keep writes immediate; add a `rehireChef({ gameId, chefId })` callable that pulls the chef back out of the return pool IF the player's roster has space AND the chef was laid off THIS round.
  - **(β)** Buffer lay-offs in client-only state until the player clicks Continue. Backend stays simple.
- Pick **(α)** — backend remains source of truth; survives a refresh; matches the existing pattern.
- Coordinate with Massaro: he adds `rehireChef` callable as a small extension under M-13 (~1 hr).

**Frontend fix (Scott).**
1. Remove the confirm modal in `RosterPhasePage.tsx:241-263, 427-463`. Click → call `layoffChef({ chefId })` directly.
2. Add a "Lay offs" panel on the right (mirror the existing slot grid layout). Subscribe to the same player doc; show any chefs that were laid off this round (need a way to distinguish "laid off this round" from "never on roster" — either via a new field on the return pool entry like `laidOffInRound: currentRound, laidOffByUid` or a separate `tempLayoffs` array on the player doc — Massaro decides backend shape).
3. Each panel chef has a green "Re-hire" button. Disabled if `specialtyChefs.length >= specialtyChefCap` with tooltip.
4. Multi-select layoff (the original S-05 scope) still applies — if a team needs to drop multiple chefs to get under cap, they can click each one in sequence with no modal interrupting. M-13's `layoffChefs` batch callable becomes useful here for "select 3, lay off all" once the modal-free flow is in place.

**Files:** `app/src/pages/RosterPhasePage.tsx`, `backend/functions/index.js` (Massaro adds `rehireChef`).

**Acceptance.**
- Click a chef on the roster → it instantly slides to the "Lay offs" panel on the right (no modal).
- "Re-hire" button works → chef returns to roster IF space exists.
- Refresh the page mid-roster-phase → laid-off chefs still in the panel, re-hireable.
- Click Continue → laid-off chefs commit to the return pool, can't be re-hired next round.

**Effort:** bumped from S to M because of the new backend callable + panel layout work.

---

## [x] S-06 [P1, S] — "Take over" button next to disconnected teammates (mirror M-10) (✅ DONE 2026-04-29 by Claude/Scott)

**Problem.** Pairs with Massaro's M-10 backend callable.

**Fix.** In `RoundHeader.tsx` (after S-01 lands the role roster), if any teammate's presence is stale, show a "Take over [role]" button next to their pill. Click → calls `reclaimTeammateRole({ targetUid })`.

**Files:** `app/src/components/game/RoundHeader.tsx`.

**Acceptance.** Disconnected teammate → "Take over" button appears next to their role for the rest of the team.

---

## [x] S-07 [P1, XS] — Rename CSV button + analyst-only gate (✅ DONE 2026-04-29 by Claude/Scott)

**Problem.** `ResultsPhase.tsx:222-230` button label is "⬇ Download CSV", available to anyone.

**Fix.** Rename to "⬇ Download your monthly data". Wrap in `{(role === 'advertising' || role === 'solo') && ...}` (post-S-03 rename). Same change for the CSV Inbox button on `RoundHeader.tsx:264-278`.

**Files:** `app/src/pages/phases/ResultsPhase.tsx`, `app/src/components/game/RoundHeader.tsx`.

**Acceptance.** Only Analyst sees the download button.

---

## [x] S-08 [P1, XS] — Fix "Basic Chef" copy on RosterPhasePage (✅ DONE 2026-04-29 by Claude/Scott)

**Problem.** `RosterPhasePage.tsx:336-344` shows "Basic Chef" header but the body text reads "Always in your kitchen." which the user found confusing.

**Fix.** Change body to: "Your free chef. Produces 30 units per round." (or similar — this confirms the basic chef does produce). Drop the "Always in your kitchen" line.

**Files:** `app/src/pages/RosterPhasePage.tsx`.

**Acceptance.** Visual: copy makes sense to a first-time player.

---

## [x] S-09 [P1, XS] — Sticky/freeze the top bar on Decide so the timer is always visible (Q18 confirmed) (✅ DONE 2026-04-29 by Claude/Scott)

**Problem (confirmed Q18).** During Decide the page scrolls, taking the timer out of view. User wants the `RoundHeader` pinned to the top so the countdown is always visible.

**Fix.** CSS-only. Add `position: sticky; top: 0; z-index: 10;` to the `.round-header` class (or wrap the header in a sticky container in `GamePage.tsx` if `position: sticky` doesn't behave inside the existing `<PageShell>`). Verify the same change doesn't break the AuctionPage / ResultsPhase layouts (those pages also render `<RoundHeader />`).

**Files:** `app/src/styles/global.css` (or wherever `.round-header` lives) — find via:
```bash
grep -rn "\.round-header" app/src/styles/
```

**Acceptance.** Scroll Decide phase to the bottom → timer still visible at the top of the viewport.

---

# Suggested Sequencing

### Two playtests on the schedule

- **🎯 Wed Apr 29 · 4 PM** — mid-sprint playtest. Validates the role-split + economy changes have landed. If chef-as-bonus is too generous or Finance/Operations submit ordering is broken, we catch it here with 16 hours of headroom.
- **🎯 Thu Apr 30 · 8 AM** — final integration playtest. Last sanity check before Friday 8 AM. Everything must be green.

Schedule below is built around hitting both playtests with all required tasks landed.

---

**Tonight (Tues) → Wed AM:** Backend gates + role-split helpers land first so everyone unblocks.
- **Massaro (fresh window 1 — quick-win batch):** M-01 + M-03 + M-04 + M-09 + M-12 + M-15 in a single PR (~30 min total — all 1–5 line fixes per the table at the top of the Massaro section).
- **Massaro (after the quick-win PR):** M-05 + M-06 (3 hr) → M-18 (1.5 hr). End the night with the role helpers updated so Scott + Barlava can pick up S-03 / B-05 first thing Wed.
- **Kavin/Sofia:** K-04 (1 hr) → K-05 (1 hr). Don't start K-01 yet — wait for M-17.
- **Barlava:** B-02 (1 hr — now covers all 3 cap categories) → B-03 (½ hr) → B-04 (½ hr).
- **Scott:** S-02 (½ hr) → S-04 (½ hr) → S-08 (½ hr) → S-09 (½ hr — sticky top bar) → S-01 (2 hr).

**Wed AM → Wed 3 PM:** Role split + economy. **Everyone must have their must-haves merged by 3 PM** so the 4 PM playtest exercises the new behavior.
- **Massaro:** M-17 (4 hr — `submitPrices` accepts quantities) → M-08 (2 hr — refresh persistence) → M-02 (4 hr — biggest economy fix) → M-21 (1 hr — satisfaction signals passthrough). Defer M-20 to Thurs AM since investigation showed it's likely a downstream symptom of M-02 — confirm in the 4 PM playtest first.
- **Kavin/Sofia:** K-10 (1 hr — immediately after M-17 lands) → K-11 (1 hr — kill the "Update Prices" friction button at GamePage.tsx:825-840) → K-01 (3 hr — per-input gating using new helpers). Then K-02 + K-03 (3 hr — sync work, paired with Massaro's `saveDecisionDraft`).
- **Barlava:** B-01 (2 hr — sealed bid) → B-05 (3 hr — data move; depends on S-03 for the gate) → B-07 (1 hr — satisfaction signals UI; depends on M-21).
- **Scott:** S-03 (2 hr — rename + helper updates; depends on M-18) → S-07 (½ hr).

**🎯 Wed 4 PM playtest** — focus on:
- Role split (Operations submits staff, Finance submits prices+quantities, Analyst submits bids) — does the new flow feel right?
- Chef-as-bonus economy — do no-chef teams clear ~$1k? Do chef teams clear ~$1.5–2k?
- Sealed-bid auctions — are students confused, or does it feel like a real auction?
- Sticky timer + new top-bar role display — is the role split visible?

After the playtest, immediately list any new bugs in the doc as `## [ ] PT-01 [P0/P1, X] — title` so they're tracked.

**Wed PM (post-playtest) → Thurs AM:** Race-condition fix + lay-off UX redesign + disconnect handling + playtest-driven fixes.
- **Massaro:** M-16 (4–6 hr — bid attribution race, P0 confirmed; investigation + transactional fix — the highest-risk task on the list) → M-22 (4 hr — player-leaves-mid-game graceful handling, P0 because a 70-player class will see drop-offs every round) → M-07 (1 hr — auto-advance setInterval) → M-10 backend (2 hr — manual reclaim, complements M-22's auto path) → M-19 (1 hr — prof checkmarks always ✓ on advance) → `rehireChef` callable for S-05 (1 hr) → M-20 verification + any playtest fixes.
- **Kavin/Sofia:** K-06 (3 hr — sprite recolor) → K-07 (4 hr — specialty chef rendering, time-permitting) → playtest fixes.
- **Barlava:** B-06 (1 hr — loan shark) → playtest fixes.
- **Scott:** S-05 (3 hr — full lay-off UX: instant lay-off + Lay offs panel + Re-hire button; depends on Massaro's `rehireChef` callable) + S-06 (1.5 hr — pair with Massaro's M-10/M-22) → playtest fixes.

**🎯 Thu 8 AM playtest** — final integration. Run the full game end-to-end with 4 of you + 4 dummy clients on a fresh build. Look for:
- Any P0 still ⏳ in this doc → must close before noon
- Any new bug from the Wed playtest still open
- Chef-as-bonus tuning — is the gap between teams reasonable?
- M-16 race condition — try to repro by submitting bids at exactly `phaseEndsAtMs`

After this playtest you have 24 hours to land any cleanup. Cut the build by Thursday 9 PM.

**Friday 7 AM:**
- Final smoke test with the practice run runbook.
- Pre-warm the servers from the prof panel 30 min before class.

---

# Resolutions to original open questions (all answered 2026-04-28)

All eight questions resolved. Summary captured here so the team has the rationale for each design call without re-reading the chat:

- **Q1 → 45 s.** Bid duration = 45 s (M-12 updated). Tighter than today (90 s), looser than the user's first instinct (30 s), still passes the 70-player concurrency test.
- **Q2 → "chefs are a bonus, not a gate."** No hard customer count; instead a per-day floor (~12 customers) for any team with an open menu, plus a chef-count multiplier so 2 specialty chefs draw ~50% more (M-02 updated). Tune in a 5-min sim run before merge.
- **Q3 → buy current-round data only.** No backfill of older rounds (B-05 updated).
- **Q4 → ship the inline loan-shark warning** during Decide. Explicit override of the "budget hidden during play" rule (B-06 updated). Document the override in the affected component.
- **Q5 → option B.** 30 rows per round in the **student** CSV (the prof CSV is being deprecated — students download per-day data themselves). Actually simpler than I framed it: backend already writes `dailyBreakdown`; FE just needs to forward it through `ADD_RESULT` (M-09 updated to a 2-line FE-only fix).
- **Q6 → confirmed roles.** Codified in the role table at the top of this doc. New backend tasks M-17 (quantities → Finance) and M-18 (chef bids → Analyst) added; FE tasks K-01, K-10, S-03, B-05 updated to match.
- **Q7 → race-condition bid attribution at last-second submits.** Promoted to its own P0 task **M-16** with an investigation + transactional-fix plan. Highest "won't know until we run it" risk on the list.
- **Q8 → couldn't repro deterministically.** User confirmed teams "did nothing different the last round, then got customers" — a one-off. M-02's customer floor + M-14's elasticity softening should make this impossible going forward; add a regression test under M-02 acceptance.

---

# What I deliberately deferred (and why)

- **"Display condensed menu on left of simulation"** (K-08) — meaningful UX restructure. P2 because the existing layout works; this is polish.
- **"Anyone can refresh and lose decisions"** — fixed by M-08, but the deeper "reactive multi-tab merge conflict" stays for next sprint.
- **"Per-monthly data inside one round"** — covered by M-09 from the prof side; the FE student view shows daily already.
- **"Loan shark incremental interest rates"** — current is flat 10%. Increasing it for repeat offenders is a balance change worth its own design pass post-Friday.
- **"Going negative → message from loan shark"** — covered by B-06; deeper "narrative loan shark NPC" is post-Friday.
