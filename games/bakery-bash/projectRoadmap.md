# Bakery Bash — Project Roadmap

**Source of truth:** [GAME_DESIGN_PROPOSAL.md](./GAME_DESIGN_PROPOSAL.md) (April 15, 2026)
**Companion specs:** [BACKEND.md](./BACKEND.md) · [FRONTEND.md](./FRONTEND.md) · [CHEF_ROSTER.md](./CHEF_ROSTER.md)
**Target launch:** April 27 or May 1, 2026
**This roadmap:** MVP-scoped, AI-executable task list for the Frontend and Backend teams.

---

## How To Use This Roadmap (AI Agents, Read This First)

Every task below is written as a **self-contained, AI-digestible unit of work** with:
- A unique **ID** (e.g. `BE-03`, `FE-07`) so commits and PRs can reference it.
- A one-line **goal** — what "done" looks like.
- The **files to touch** (paths, not guesses).
- **Acceptance criteria** — how to verify it works before checking the box.
- **Depends on** — upstream tasks that must be complete first.

Work top-to-bottom. Do not skip ahead; later tasks assume earlier ones exist. When a task is complete:

1. Check the box (`[x]`).
2. Add the commit SHA or PR link on the same line.
3. Only start the next task after the current one passes its acceptance criteria.

The **✅ Done** section is fact, not aspiration — only check a box after verifying the code exists and matches the spec.

---

## Status Legend

- [ ] Not started
- [~] In progress
- [x] Done (verified — paste commit SHA or PR link)
- [!] Blocked (explain the blocker on the line below)

Every task also has a **Priority** tag:
- **P0** — MVP-blocking. Must ship for launch.
- **P1** — MVP-desired. Ship if time allows, but game is playable without it.
- **P2** — Post-MVP. Do not start until P0 + P1 are done and the core loop is stable.

---

# ✅ Already Done (Verified as of April 17, 2026)

These are confirmed in the repo. Do not redo them. If a bug is found, file a new task.

## Backend — Done

- [x] **BE-DONE-01** Firebase project wired (`bakery-bash-54d12`), emulator config, `.firebaserc`, `firebase.json`.
- [x] **BE-DONE-02** `firestore.rules` — player self-only access, game state read-only for players, decisions create-once.
- [x] **BE-DONE-03** Firestore schema draft in `backend/firestore-schema.js`.
- [x] **BE-DONE-04** Callable: `joinGame` — anonymous auth → creates `/games/{gameId}/players/{uid}`, idempotent on rejoin. (`backend/functions/index.js:1748`)
- [x] **BE-DONE-05** Callable: `startGame` — lobby → `round_1` phase transition. (`backend/functions/index.js:1413`)
- [x] **BE-DONE-06** Callable: `advanceGamePhase` — professor-driven phase transitions. (`backend/functions/index.js:1456`)
- [x] **BE-DONE-07** Callable: `submitDecision` — writes immutable decision snapshot. (`backend/functions/index.js:1553`)
- [x] **BE-DONE-08** Trigger: `onDecisionSubmitted` — reacts to decision writes. (`backend/functions/index.js:1382`)
- [x] **BE-DONE-09** Rules test suite (`npm run test:rules`) and auth-flow integration test (`npm run test:auth-flow`).
- [x] **BE-DONE-10** Local emulator seed script (`npm run seed:emulator`, `backend/seed/local-game.json`).

## Frontend — Done

- [x] **FE-DONE-01** Vite + React + TypeScript scaffold in `app/`.
- [x] **FE-DONE-02** Firebase client init (`app/src/lib/firebase.ts`).
- [x] **FE-DONE-03** `AuthProvider` — anonymous sign-in on mount. (`app/src/contexts/AuthContext.tsx`)
- [x] **FE-DONE-04** `GameProvider` — Firestore-backed game/player/leaderboard subscriptions. (`app/src/contexts/GameContext.tsx`)
- [x] **FE-DONE-05** Landing page with join code + name inputs. (`app/src/pages/LandingPage.tsx`)
- [x] **FE-DONE-06** Lobby page with live player list. (`app/src/pages/LobbyPage.tsx`)
- [x] **FE-DONE-07** Game page shell with phase routing. (`app/src/pages/GamePage.tsx`)
- [x] **FE-DONE-08** First-pass decide, bid, simulate, results phases. (`app/src/pages/phases/`)
- [x] **FE-DONE-09** First-pass Auction, Leaderboard, Professor pages.
- [x] **FE-DONE-10** First-pass game types (`app/src/types/game.ts`), round header, sidebar, tabs (Menu / Staff / Auction).

> ⚠️ **Note:** The existing frontend phase files are first-pass scaffolds. They are NOT aligned with the April 15 proposal (no chef system, no loan shark, no roster phase, no conclusion screen, no hidden-budget enforcement). See MVP tasks below for the rework.
>
> ⚠️ **Note:** The existing backend schema (`firestore-schema.js`) and `submitDecision` Cloud Function are based on the **pre-April-8 design**. Phase names, product keys (`latte`/`matchaLatte`), per-player pricing, and single-shot bids all conflict with the proposal. See **Phase 0 — Schema & Code Migration** below. Do that phase first.

---

# 🚧 MVP — Must Ship (P0)

MVP definition (from proposal): one complete 5-round session end-to-end with auth, decisions, bidding, chef roster, simulation, results, CSV export, and a final Conclusion Screen. Professor can start/advance/pause/end.

---

## Phase 0 — Schema & Code Migration (P0, DO THESE FIRST)

The existing `firestore-schema.js`, `submitDecision`, and parts of the frontend are based on the **pre-April-8 design** and conflict with the April 15 proposal. These must be resolved before Phase A — otherwise every new task will collide with stale field names, phase names, and data shapes.

- [ ] **MIG-01** — Product key rename: `latte` → `coffee`, `matchaLatte` → `matcha`
  - **Goal:** All Firestore keys, TypeScript types, Cloud Function logic, seed data, and frontend references use `coffee` and `matcha` (per proposal's 6-product catalog).
  - **Files:** `backend/firestore-schema.js`, `backend/functions/index.js`, `backend/seed/local-game.json`, `backend/test/*`, `app/src/types/game.ts`, any component referencing the old keys.
  - **Acceptance:** Repo-wide grep for `latte` and `matchaLatte` returns zero results outside this migration task's commit message. Rule tests + auth-flow test still green.
  - **Depends on:** none.

- [ ] **MIG-02** — Retire old `PlayerDocument` / `DecisionDocument` / `RoundResultDocument` shapes
  - **Goal:** Remove `productPrices`, `headchefSkill`, `attractivenessWeights`, `creditBalance`, `creditCost`, `staffCount` (single integer), and the single-shot `adBid`/`chefBid` shapes from `firestore-schema.js`. Replace with the new shapes per `BACKEND.md`: `specialtyChefs[]`, `sousChefCount`, `sousChefAssignments`, multi-type `adBids`, per-chef `chefBids`, `amountBorrowed`, `interestCharged`, `revenueGross`, `revenueNet`, per-product satisfaction %, chef satisfaction score, sellout flags.
  - **Files:** `backend/firestore-schema.js`.
  - **Acceptance:** Schema file matches the Firestore Schema section of `BACKEND.md` 1:1. No `productPrices` or `headchefSkill` references remain anywhere.
  - **Depends on:** MIG-01.

- [ ] **MIG-03** — Phase name migration in `submitDecision` and state machine
  - **Goal:** Replace phase checks for `"closing_hours"` / `"decide"` / `"auction"` / `"open_for_business"` / `"results"` with the new state machine labels: `round_N_decide` for decision submit, `round_N_bid_ad` + `round_N_bid_chef` for bid submit, `round_N_roster` for roster actions. `submitDecision` must only accept writes when phase matches `round_${round}_decide`.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Calling `submitDecision` during any non-`*_decide` phase returns `failed-precondition`. Existing `test:auth-flow` passes against the new phase names.
  - **Depends on:** MIG-02.

- [ ] **MIG-04** — Drop pricing input path
  - **Goal:** `submitDecision` no longer accepts `productPrices` in the payload. `validateDecisionInput` rejects requests containing it. Pricing is fetched server-side from `config/params.productPrices` wherever needed.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Old payload including `productPrices` returns `invalid-argument`. Simulator reads prices from config.
  - **Depends on:** MIG-02.

- [ ] **MIG-05** — Split decisions from bids at the callable level
  - **Goal:** `submitDecision` now only accepts `{ quantities, sousChefCount, sousChefAssignments, menu, round }`. A new `submitBids` callable (BE-09) handles ads + chefs. Old combined payload is rejected.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Legacy combined payload fails; two-step decide-then-bid path works end-to-end in emulator.
  - **Depends on:** MIG-03.

- [ ] **MIG-06** — Remove/replace tab-based UI and standalone AuctionPage
  - **Goal:** Delete or refactor `components/game/tabs/{AuctionTab,StaffTab,MenuTab}.tsx` and `pages/AuctionPage.tsx` (333 lines) — none of these match the phase-based flow from the proposal. Update `App.tsx` routing to remove `/auction`. Sous chef hiring moves into `<SousChefPanel>`; menu choice moves into `DecidePhase`; auction logic moves into `BidPhase`.
  - **Files:** `app/src/pages/AuctionPage.tsx` (delete), `app/src/components/game/tabs/*.tsx` (delete), `app/src/components/game/GameSidebar.tsx` (remove tab nav if obsolete), `app/src/App.tsx`.
  - **Acceptance:** No route at `/auction`, no tab components imported anywhere. `GamePage` routes purely on game-doc `phase`.
  - **Depends on:** FE-07, FE-08 (the replacement phases must land before the old UI is deleted, or delete and re-stub — either order is OK but tracking it explicitly).

- [ ] **MIG-07** — Clarify sous chef phase authority
  - **Goal:** Decide — is `sousChefCount` submitted in `decide` phase only, `roster` phase only, or both? Both FRONTEND.md and the proposal show `<SousChefPanel>` on both screens. Resolve with Game Design, then update both specs to match. Proposed default: **hires in `decide` are provisional; hires in `roster` are final; simulator reads the value from the last-submitted roster write.**
  - **Files:** `BACKEND.md`, `FRONTEND.md`, `GAME_DESIGN_PROPOSAL.md` (if needed).
  - **Acceptance:** One authoritative sentence in each spec. Matching implementation in BE-09/BE-11 callable contracts.
  - **Depends on:** none (unblocks BE-09, BE-11, FE-07, FE-09).

- [ ] **MIG-08** — Bakery name assignment flow
  - **Goal:** Clarify whether `displayName` == "bakery name" or whether bakery name is a separate field. Proposed: on join, player enters one name used as both `displayName` and the team/bakery label. Lobby shows it; leaderboard and winner banner reuse it. If randomly generated names are desired, generator lives in `joinGame`.
  - **Files:** `BACKEND.md` (schema note), `FRONTEND.md` (lobby copy), `backend/functions/index.js` (joinGame if generator is added).
  - **Acceptance:** Each spec has one sentence describing the bakery-name source. Lobby renders the correct field.
  - **Depends on:** none.

---

## Phase A — Game Config & Schema Foundation (P0)

Everything else depends on these writes. Do these first.

- [ ] **BE-01** — Seed `games/{gameId}/config/params` on game create
  - **Goal:** Every game doc has a `config/params` subdoc using the values locked in the Decisions Table: `startingBudget: 500000`, `playerCap: 20` (schema must accept up to 50), `sousChefBaseCost: 12500`, `unitCosts: $1/item flat`, `loanSharkInterestRate: 0.10`, `adBonus: { tv: 50000, billboard: 37500, radio: 25000, newspaper: 18750 }`, `chefBidFloors: { novel: 25000, intermediate: 43750, advanced: 68750 }`, `productPrices` and `productBaseDemand` from proposal (unscaled), `productWeights` from proposal, `revenueCoefficients` as placeholders (flagged for INT-06 tuning), `phaseDurations` from BACKEND.md.
  - **Files:** `backend/functions/index.js` (new `createGame` onCall), `backend/firestore-schema.js`, `backend/seed/local-game.json`.
  - **Acceptance:** Create a game via the new callable → inspect emulator UI → every value in DEC-01..DEC-18 is present and correct.
  - **Depends on:** MIG-02.

- [ ] **SPEC-01** — Reconcile placeholder ad bonus values with proposal
  - **Goal:** Proposal lists ad bonus values as "TBD". BACKEND.md picked defaults (TV $200, Billboard $150, Radio $100, Newspaper $75). Either (a) Game Design signs off on the defaults and moves them into the proposal, or (b) the defaults are re-tuned. Also resolve OQ-03 (ad bonus enters revenue as flat add vs flows through traffic).
  - **Files:** `GAME_DESIGN_PROPOSAL.md`, `BACKEND.md`.
  - **Acceptance:** Proposal has a concrete ad bonus table. BACKEND.md points at it, not at its own defaults.
  - **Depends on:** none (unblocks BE-10, BE-13).

- [ ] **BE-02** — `createGame` onCall (professor-only)
  - **Goal:** Professor callable that generates a 6-char joinCode (A–Z, 2–9), writes initial game doc in `lobby` phase, writes `config/params`, writes the full 5-round preference profile (see BE-03), and returns `{ gameId, joinCode }`.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Callable from emulator shell → returns joinCode → `/games/{gameId}` exists with `phase: "lobby"`, `round: 0`, config subdoc, preferences subdoc.
  - **Depends on:** BE-01.

- [ ] **BE-03** — Preference profile generator
  - **Goal:** At game-create, generate a 5-round demand modifier matrix. Each round has exactly 2 Trending (+40%), 2 Warm (+15%), 1 Neutral (0%), 1 Cold (−25%). Constraint: no product is Trending in two consecutive rounds (regenerate if violated). Write to `games/{gameId}/preferences/rounds` with Cloud-Function-only read access.
  - **Files:** `backend/functions/index.js`, `backend/firestore.rules`.
  - **Acceptance:** Unit test in `backend/test/` generates 100 profiles → all satisfy the constraints. Rule test confirms client cannot read this subcollection.
  - **Depends on:** BE-02.

- [ ] **BE-04** — Catalog docs: `catalog/chefs`, `catalog/menuItems`, `config/insightTemplates`
  - **Goal:** Write the static master catalog for chef variants (art specs + name lists + multiplier matrix from `CHEF_ROSTER.md`), menu items with prices and base demand, and the market email phrase library (one template per Trending pair).
  - **Files:** `backend/scripts/seed-catalogs.js` (new), `backend/package.json` (add `seed:catalogs` script).
  - **Acceptance:** Running `npm run seed:catalogs` populates the Firestore emulator with all four nationalities × variants and all 6 products.
  - **Depends on:** BE-01.

---

## Phase B — Round State Machine & Timers (P0)

- [ ] **BE-05** — Expand `advanceGamePhase` to full state machine
  - **Goal:** Enforce transitions `lobby → round_N_email → round_N_decide → round_N_bid_ad → round_N_bid_chef → round_N_roster → simulating → results_ready → round_N+1_email → game_over`. Reject invalid transitions with `failed-precondition`. Wrap in a Firestore transaction. Write `phaseEndsAt` (Timestamp) on each transition using durations from `config/params.phaseDurations`.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Emulator test advances a game through all 5 rounds sequentially and ends in `game_over`. Invalid jumps (e.g. lobby → simulating) return `failed-precondition`.
  - **Depends on:** BE-01, BE-02.

- [ ] **BE-06** — `pauseGame`, `resumeGame`, `endGame` callables (professor-only)
  - **Goal:** `pauseGame` freezes `phaseEndsAt` and sets `status: "paused"`; `resumeGame` restores the timer with remaining duration; `endGame` forces `phase: "game_over"` regardless of current round.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Professor pauses mid-round → timer stops → resume advances correctly. End-game triggers conclusion aggregation (see BE-15).
  - **Depends on:** BE-05.

- [ ] **BE-07** — Market insight email generator
  - **Goal:** On entry to `round_N_email`, select a template from `config/insightTemplates` matching the round's Trending pair and write it to `games/{gameId}/rounds/{N}/marketEmail.body`. Must never reveal exact modifiers or Cold products.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Inspect emulator → marketEmail body exists for rounds 1–5, each references only the 2 Trending products.
  - **Depends on:** BE-03, BE-04, BE-05.

---

## Phase C — Chef System Backend (P0)

- [ ] **BE-08** — Chef pool generator (per round)
  - **Goal:** On entry to `round_N_bid_chef`, spawn 6–8 chefs to `games/{gameId}/rounds/{N}/chefs[]`. Each chef: random nationality, gender, variant, skill (sampled from the round's spawn-rate row), random name from the nationality list, derived specialty. Minimum bid floor = `(Novel 2.0 | Intermediate 3.5 | Advanced 5.5) × baselineFloor`. **Specialty field must be denied to client reads via security rules.**
  - **Files:** `backend/functions/index.js`, `backend/firestore.rules`.
  - **Acceptance:** 5-round sim → each round chefs[] exists, spawn rates within ±10% of target over 100 trials. Client read of a chef's `specialty` field returns `permission-denied`.
  - **Depends on:** BE-04, BE-05.

- [ ] **BE-09** — `submitBids` onCall (ad + chef)
  - **Goal:** Accept `{ adBids: {tv, radio, newspaper, billboard}, chefBids: {chefId: amount} }`. Validate minimum bid floors server-side. Store in `players/{uid}/pendingBids` immutably for that round.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Two players submit → pendingBids docs exist → second submit in same round is rejected (`already-exists`).
  - **Depends on:** BE-08.

- [ ] **BE-10** — Auction resolution (ad + chef)
  - **Goal:** On entry to `round_N_roster`, resolve both auctions. Ad: highest bidder wins, pays bid; if they already won another ad type, award to next-highest. Chef: each chef resolves independently, highest bidder wins, pays bid. Tie-break by `submittedAt asc`. Losing bidders pay nothing. Won chefs append to `players/{uid}.specialtyChefs[]`. If specialty count now > 3, set `pendingRosterAction: true`. Ad winners persisted to `rounds/{N}/adWinners` for next round's banner.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** 3-player auction test → winners correct, no double-ad-wins, pendingRosterAction correctly flagged.
  - **Depends on:** BE-09.

- [ ] **BE-11** — Roster management callables
  - **Goal:** `rosterLayoff({ chefId })` removes a specialty chef from `players/{uid}.specialtyChefs[]` and pushes to `games/{gameId}/auctionReturnPool`. `rosterContinue()` advances the player out of roster phase; rejects with `failed-precondition` if `specialtyChefs.length > 3`.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Player with 4 specialty chefs cannot continue until laying off → once ≤3, can continue. Laid-off chef can re-spawn in future chef pools.
  - **Depends on:** BE-10.

- [ ] **BE-12** — Sous chef hire math + Chef Satisfaction Score
  - **Goal:** Helper fns: `nextSousChefCost(count, baseCost)` returning the escalating cost (1.0×, 1.5×, 2.25×, 3.0×, +0.75×). `chefSatisfactionScore(count) = max(35, 100 − max(0, count − 4) × 16)`. Used by the simulator and exposed through decision submit validation.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Unit tests cover counts 0–10 and match the table in `BACKEND.md`.
  - **Depends on:** BE-01.

---

## Phase D — Simulation Engine (P0)

- [ ] **BE-13** — Revenue + satisfaction simulator
  - **Goal:** `runSimulation(gameId, round)` runs on entry to `simulating`. For each player:
    1. Compute per-chef output (base + specialties). Apply `chefSatisfactionScore / 100` as throughput multiplier.
    2. Cap per-product output by supply purchased.
    3. Fill rate → per-product satisfaction % (with sell-out clamp ≤45 when applicable).
    4. Weighted aggregate satisfaction (Coffee 1.5×, Matcha 1.3×, Croissant 1.2×, others 1.0×; skip products not offered).
    5. Stage-1 satisfaction → Stage-2 competitive customer allocation per product.
    6. Add returning customer bonus from prior round before competitive split.
    7. Mid-round sell-out routing (product-loyal 60% defect weighted by competitor satisfaction; brand-loyal redirect to next menu item).
    8. Gross revenue = 500 + 12×sousChefCount + 8×aggSat + 0.8×adSpend + 50×numProducts + Σ(qty_sold × fixed_price) + noise(±100, seeded by `${gameId}:${round}:${playerId}`).
    9. Loan shark: `borrowed = max(0, spent − budgetCurrent)`; `deduction = borrowed × 1.10`; `revenueNet = revenueGross − deduction`; `budgetNext = budgetCurrent + revenueNet − spent`.
    10. Compute returning customer bonus for next round from this round's agg satisfaction.
  - **Files:** `backend/functions/index.js`, new module `backend/functions/simulator.js`, unit tests in `backend/test/simulator.test.js`.
  - **Acceptance:** Golden-file test — fixed inputs → fixed outputs (noise seeded). Manual playthrough with 2 players matches the worked examples in the proposal (e.g. Advanced French chef on Croissant = 66 units/day).
  - **Depends on:** BE-10, BE-11, BE-12.

- [ ] **BE-14** — Leaderboard writer + per-round result writes
  - **Goal:** After simulation, write per-player round result to `players/{uid}/rounds/{N}` and the flattened CSV row to `csvRows/{playerId}/rounds/{N}`. Rewrite `games/{gameId}/leaderboard/latest` as a ranked array by cumulative net revenue.
  - **Files:** `backend/functions/index.js`, `backend/functions/simulator.js`.
  - **Acceptance:** After each sim, leaderboard is a sorted array and every player has a new `rounds/{N}` doc.
  - **Depends on:** BE-13.

- [ ] **BE-15** — Conclusion aggregation
  - **Goal:** `getConclusion(gameId)` callable. Per-player aggregations: totalRevenue (gross), totalInterest, totalBorrowed, netRevenue = gross − interest − borrowed, budgetRemaining = startingBudget + Σ revenueNet − Σ spent. Rank by netRevenue desc, tiebreak by budgetRemaining desc. Include winner's full chef roster (base + specialties with portrait variant codes). Cache on `games/{gameId}.conclusion` once `phase === "game_over"`.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** After a 5-round test game, conclusion doc matches hand-calculated totals. Re-fetching returns cached data (no recompute).
  - **Depends on:** BE-14.

---

## Phase E — CSV Export & Professor Tools (P0)

- [ ] **BE-16** — `/api/csv/{gameId}/{playerId}` HTTPS function
  - **Goal:** Authenticated player downloads a CSV of their own rounds (all columns per the proposal's Data Requirements section). `null` for satisfaction columns of products not offered. `revenue` is net (post loan shark). Excludes `returning_customers`.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Curl with the player's ID token returns a valid CSV; curl without token or for another player's ID returns 403.
  - **Depends on:** BE-14.

- [ ] **BE-17** — Professor export (`/api/professor/export`)
  - **Goal:** Prepends `playerId, bakeryName, displayName` to every CSV row, returns the full game across all players. Requires professor custom claim.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Professor token returns full CSV; player token returns 403.
  - **Depends on:** BE-16.

- [ ] **BE-18** — Professor custom claim setter
  - **Goal:** A one-off admin script (or callable guarded by a deploy-time secret) that sets `professor: true` on a given UID.
  - **Files:** `backend/scripts/set-professor-claim.js`.
  - **Acceptance:** Running the script with a UID sets the claim; token refresh picks it up.
  - **Depends on:** none.

- [ ] **BE-19** — Disconnection handling
  - **Goal:** If a player submits no decision in a round, default all inputs to 0 (no stock, no sous chef hire, no bids). After 2 consecutive missed phases, set `disconnected: true`.
  - **Files:** `backend/functions/index.js`.
  - **Acceptance:** Simulated player with no submissions in rounds 3+4 → marked disconnected in round 4; revenue computed with zeros.
  - **Depends on:** BE-13.

---

## Phase F — Frontend MVP Rework (P0)

All existing frontend phase files need to be aligned to the April 15 proposal. **Do not continue building on the existing first-pass without applying the hard UI rules from `FRONTEND.md`.**

- [ ] **FE-01** — Hard UI rules enforcement (repo-wide)
  - **Goal:** Add a CI check that greps `app/src/pages/` and `app/src/components/` for `budgetCurrent`, `budgetRemaining`, or "cash left" strings and fails the build if found outside the allow-list (`ConclusionPage.tsx`, `ProfessorPage.tsx`, `ProfessorLeaderboardPage.tsx`). Also add a runtime test asserting no `<ChefCard>` ever renders specialty in the DOM.
  - **Files:** `app/scripts/hide-budget-audit.sh` (new), `app/package.json` (script + pre-push hook), `app/src/components/__tests__/ChefCard.test.tsx`.
  - **Acceptance:** Introducing `budgetCurrent` in a disallowed file fails CI. Test passes against an empty ChefCard.
  - **Depends on:** none (gate for everything else).

- [ ] **FE-02** — Landing page validation + join
  - **Goal:** Wire the existing LandingPage to call `joinGame` callable. Enforce 2–40 char names, 6-char uppercase A–Z/2–9 codes, auto-uppercase input. Error states: invalid code, game started, game full.
  - **Files:** `app/src/pages/LandingPage.tsx`.
  - **Acceptance:** Manual test — all three error states render correctly against the emulator.
  - **Depends on:** BE-DONE-04.

- [ ] **FE-03** — Lobby auto-redirect on game start
  - **Goal:** Subscribe to game doc; when `phase === "round_1_email"`, redirect to `/game/email`.
  - **Files:** `app/src/pages/LobbyPage.tsx`.
  - **Acceptance:** Professor starts game → all lobby clients redirect within 1s.
  - **Depends on:** BE-05.

- [ ] **FE-04** — `<ChefCard>` component
  - **Goal:** Three modes: `"bid"` (with bid input + minimum floor), `"roster"` (with lay-off button), `"won"` (display only). Every mode shows portrait (use variant code from `catalog/chefs`), nationality flag emoji, skill tier badge, name. **Never shows specialty or multipliers.** Includes a regression test confirming no `data-testid="chef-specialty"` ever appears.
  - **Files:** `app/src/components/game/ChefCard.tsx` (new), `app/src/components/game/__tests__/ChefCard.test.tsx`.
  - **Acceptance:** Unit test passes. Storybook-style harness renders all 3 modes × 4 nationalities × 3 skills.
  - **Depends on:** FE-01, BE-04, ART-25 (uses `portraitPath` from catalog).

- [ ] **FE-05** — `<SousChefPanel>` component
  - **Goal:** Displays current count, per-product assignment dropdowns (one per offered menu item), computed "Next hire $X" from escalation curve. Warning copy at count >4 ("Kitchen Satisfaction: 84"), at >8 ("Severe disruption: 35"). Never blocks hiring.
  - **Files:** `app/src/components/game/SousChefPanel.tsx` (new).
  - **Acceptance:** Counts 0–10 all renderable; next-hire cost matches the curve.
  - **Depends on:** FE-01.

- [ ] **FE-06** — `<MarketEmailModal>` and Email phase (`/game/email`)
  - **Goal:** Email-themed UI reading `marketEmail.body`. "Got it" button disabled for 5s. Auto-dismisses when phase transitions to `decide`.
  - **Files:** `app/src/components/game/MarketEmailModal.tsx` (new), `app/src/pages/phases/EmailPhase.tsx` (new), `app/src/App.tsx` route.
  - **Acceptance:** Manual playthrough — modal shows, button enables after 5s, auto-advances on phase change.
  - **Depends on:** BE-07.

- [ ] **FE-07** — Decide phase rework
  - **Goal:** Rebuild `DecidePhase.tsx` per the proposal: countdown timer, quantity inputs per product (fixed price as read-only label), `<SousChefPanel>`, menu unlock toggles for Sandwich/Coffee/Matcha, `<AdWinnerBanner>` (skip on round 1), submission lock. **No budget display anywhere.** Calls `submitDecision`.
  - **Files:** `app/src/pages/phases/DecidePhase.tsx`.
  - **Acceptance:** Manual test — all inputs present, no budget string visible, submit locks the form, the FE-01 CI check passes.
  - **Depends on:** FE-05, FE-11, BE-DONE-07.

- [ ] **FE-08** — Bid phase rework (two sequential auctions)
  - **Goal:** Rebuild `BidPhase.tsx` as two 1-min sealed-bid auctions: Ad (4 cards, multi-bid allowed), then Chef (one `<ChefCard mode="bid">` per pool chef). Submit button calls `submitBids`. Running total of player's own bids is OK. **No budget.** If timer expires without submit, all bids treated as $0.
  - **Files:** `app/src/pages/phases/BidPhase.tsx`.
  - **Acceptance:** Manual test — both auctions flow correctly; chef cards never show specialty; timeout → $0 bids server-side.
  - **Depends on:** FE-04, BE-09.

- [ ] **FE-09** — Roster phase (`/game/roster`)
  - **Goal:** New page. Shows base chef card (greyed out, "cannot remove"), 3 specialty slots (filled or empty), overflow slot highlighted if `specialtyChefs.length > 3`, `<SousChefPanel>`. Lay-off confirmation modal. "Continue" disabled until specialty count ≤3; calls `rosterContinue`.
  - **Files:** `app/src/pages/phases/RosterPhase.tsx` (new), `app/src/App.tsx` route.
  - **Acceptance:** Winning a 4th chef → overflow slot visible → must lay off before continue enables.
  - **Depends on:** FE-04, FE-05, BE-11.

- [ ] **FE-10** — Simulate phase minigame
  - **Goal:** Cosmetic only — tap falling croissants or similar. Auto-transitions to results when `phase === "results_ready"`.
  - **Files:** `app/src/pages/phases/SimulatePhase.tsx`.
  - **Acceptance:** Phase transitions forward; no revenue side-effects.
  - **Depends on:** BE-13.

- [ ] **FE-11** — `<AdWinnerBanner>` component
  - **Goal:** Reads previous round's `adWinners`. Renders a TV / Radio / Newspaper / Billboard surface with the winning bakery's name overlaid. Player's own win highlighted.
  - **Files:** `app/src/components/game/AdWinnerBanner.tsx` (new).
  - **Acceptance:** With a seeded prior round showing TV winner = "Bakery A", banner renders correctly.
  - **Depends on:** BE-10.

- [ ] **FE-12** — `<LoanSharkCallout>` + Results phase rework
  - **Goal:** Rebuild `ResultsPhase.tsx`: red `<LoanSharkCallout>` banner when `amountBorrowed > 0`, large animated net revenue count-up, KPIs row (customers, returning customers, agg satisfaction %, chef satisfaction score), `<ProductBreakdownTable>`, auction results (ads won + `<ChefCard mode="won">` for chefs won), leaderboard row highlighted, Download CSV button hitting `/api/csv/...`, weighting footnote, "Waiting for professor" footer. **No budget.**
  - **Files:** `app/src/pages/phases/ResultsPhase.tsx`, `app/src/components/game/LoanSharkCallout.tsx` (new), `app/src/components/game/ProductBreakdownTable.tsx` (new).
  - **Acceptance:** Manual playthrough with a borrowed-over scenario → red banner shows, numbers match gross − principal − interest.
  - **Depends on:** BE-13, BE-14, BE-16.

- [ ] **FE-13** — Conclusion screen (`/game/conclusion`)
  - **Goal:** New read-only page. Winner banner with team name + full chef roster (`<ChefCard mode="won">` row) + confetti/trophy. Final rankings table (Rank / Team / Total Revenue / Total Interest / Net Revenue / Budget Remaining). Expandable per-round detail rows. **This is the ONLY page where Budget Remaining displays.**
  - **Files:** `app/src/pages/ConclusionPage.tsx` (new), `app/src/App.tsx` route.
  - **Acceptance:** 5-round test game → conclusion screen ranks correctly, tiebreaker works, expansion shows the per-round table.
  - **Depends on:** BE-15, FE-04.

- [ ] **FE-14** — Leaderboard page rework
  - **Goal:** Student view with Rank / Bakery / Net Revenue (this round) / Cumulative Net Revenue. Your row highlighted. **No budget column.** Subscribes to `games/{gameId}/leaderboard/latest`.
  - **Files:** `app/src/pages/LeaderboardPage.tsx`.
  - **Acceptance:** After each simulation, leaderboard updates within 1s.
  - **Depends on:** BE-14.

- [ ] **FE-15** — Professor control panel
  - **Goal:** Rebuild `ProfessorPage.tsx`: Create Game (calls `createGame`, shows join code huge), Start/Advance/Pause/Resume/End buttons (each disabled on invalid phase), player submission status list (✓ / ⏳ / ⚠️), live leaderboard, copy-join-link button. Protected by professor custom claim.
  - **Files:** `app/src/pages/ProfessorPage.tsx`.
  - **Acceptance:** Non-professor UID hitting `/professor` is rejected. Professor can drive a full game start-to-finish from this page.
  - **Depends on:** BE-02, BE-05, BE-06, BE-18.

- [ ] **FE-16** — Professor leaderboard + export (`/professor/leaderboard`)
  - **Goal:** Full visibility — every player's decisions, bids, and results. Aggregate class stats (avg/median/stddev revenue, avg satisfaction). Export-all-CSV button hitting `/api/professor/export`.
  - **Files:** `app/src/pages/ProfessorLeaderboardPage.tsx` (new), `app/src/App.tsx` route.
  - **Acceptance:** Professor can see all rows + downloads a combined CSV with playerId/bakeryName/displayName prefix columns.
  - **Depends on:** BE-17.

- [ ] **FE-17** — `<RoundHeader>` cleanup + `<SubmissionLock>` component
  - **Goal:** `<RoundHeader>` shows round N/M, countdown timer (red <60s), sous chef count, specialty chef count. **No budget.** `<SubmissionLock>` disables the form on submit and shows "N/M players submitted".
  - **Files:** `app/src/components/game/RoundHeader.tsx`, `app/src/components/game/SubmissionLock.tsx` (new).
  - **Acceptance:** Timer counts down; submission lock updates live as other players submit.
  - **Depends on:** FE-01.

---

## Phase H — Art & Asset Pipeline (P0)

24 chef portrait variants are required by `CHEF_ROSTER.md` (head + neckline only, avatar-style). Zero exist today — `assets/svg/characters/` contains only three walk spritesheets. Without these, `<ChefCard>` and the Conclusion winner banner render placeholders.

- [ ] **ART-01** — Define asset spec sheet
  - **Goal:** One doc (`assets/CHEF_PORTRAIT_SPEC.md`) locking down: canvas size (recommend 512×512), export format (SVG preferred, PNG fallback), file-naming convention `chef_{nationality}_{gender}_{variant}.svg` (e.g. `chef_french_male_A.svg`), transparent background, consistent neckline crop. Generator code references these exact filenames.
  - **Files:** `games/bakery-bash/assets/CHEF_PORTRAIT_SPEC.md` (new).
  - **Depends on:** none.

- [ ] **ART-02..ART-05** — French portraits (6 total): `male_A`, `male_B`, `male_C`, `female_A`, `female_B`, `female_C`
- [ ] **ART-06..ART-09** — Japanese portraits (4 total): `male_A`, `male_B`, `female_A`, `female_B`
- [ ] **ART-10..ART-13** — Italian portraits (4 total): `male_A`, `male_B`, `female_A`, `female_B`
- [ ] **ART-14..ART-19** — American portraits (6 total): `male_A`, `male_B`, `male_C`, `female_A`, `female_B`, `female_C`
- [ ] **ART-20** — Base chef portrait (nationality-neutral, greyscale — per roster rules "cannot be removed, greyed out")
- [ ] **ART-21** — Placeholder "empty specialty slot" SVG for roster UI
- [ ] **ART-22** — Trophy + confetti assets for Conclusion winner banner
- [ ] **ART-23** — Four ad-surface backplates: TV frame, radio/speaker icon, newspaper page, billboard — used by `<AdWinnerBanner>`
- [ ] **ART-24** — Loan shark mascot SVG for `<LoanSharkCallout>` banner (stylized shark or cash-grabber icon)

  For each portrait task:
  - **Goal:** Deliver one SVG matching `CHEF_ROSTER.md`'s variant description (skin tone, hair, facial features, hat, neckline per the variant row).
  - **Files:** `games/bakery-bash/assets/svg/characters/chef_{…}.svg`.
  - **Acceptance:** File exists at the spec'd path, opens in browser without errors, neckline crop matches spec, rendered inside `<ChefCard>` looks on-brand alongside siblings.
  - **Depends on:** ART-01.

- [ ] **ART-25** — Register all portrait paths in `catalog/chefs`
  - **Goal:** Once all variants exist, write a `portraitPath` field per variant into the `catalog/chefs` seed so the chef generator (BE-08) can emit the correct filename on spawn.
  - **Files:** `backend/scripts/seed-catalogs.js`.
  - **Depends on:** ART-02..ART-24, BE-04.

---

## Phase G — End-to-End Testing & Hardening (P0)

- [ ] **INT-01** — Full 5-round smoke test in emulator
  - **Goal:** Scripted test: professor creates game → 3 players join → run all 5 rounds (decide, bid, roster, simulate, results) → reach conclusion screen → CSV exports correctly.
  - **Files:** `backend/test/full-game.test.js` (new).
  - **Acceptance:** Green CI run. Produces a real CSV whose numbers hand-check against proposal examples.
  - **Depends on:** all BE-* and FE-* above.

- [ ] **INT-02** — Load test: 30-player game
  - **Goal:** Simulate 30 concurrent players submitting decisions, bids, and roster actions. Confirm no race conditions in auction resolution, no duplicated phase advances.
  - **Files:** `backend/test/load.test.js`.
  - **Acceptance:** All 30 players' results are deterministic and correct. Cloud Function cold-start p95 < 3s.
  - **Depends on:** INT-01.

- [ ] **INT-03** — Hide-budget audit passes in CI
  - **Goal:** The FE-01 check blocks any PR that leaks budget into student-facing UI.
  - **Files:** `.github/workflows/ci.yml` (new if missing).
  - **Acceptance:** Intentionally introducing a budget leak in a PR is blocked by CI.
  - **Depends on:** FE-01.

- [ ] **INT-04** — Security rule audit
  - **Goal:** Extend `backend/test/rules.test.js` to cover new collections: chef `specialty` field, `preferences`, `pendingBids` (player self-only write), `auctionReturnPool` (read-only for players). Player attempting to read another player's private state returns `permission-denied`.
  - **Files:** `backend/test/rules.test.js`.
  - **Acceptance:** All rule tests green.
  - **Depends on:** BE-08, BE-09, BE-11.

- [ ] **INT-05** — Firebase prod deploy dry run
  - **Goal:** `firebase deploy --only firestore:rules,functions --project bakery-bash-54d12` succeeds from a clean checkout. Anonymous Auth is enabled in console. Professor claim set on 1–2 known UIDs.
  - **Files:** none (operational).
  - **Acceptance:** Deploy succeeds; sample game playable end-to-end against prod.
  - **Depends on:** INT-01, BE-18.

- [ ] **INT-06** — Playtest with the team
  - **Goal:** Full team plays a 5-round game at least once. Log all bugs as new tasks in this file. Tune revenue coefficients and starting budget based on observed behavior.
  - **Files:** `backend/functions/index.js` (coefficient tune), this file (bug tasks).
  - **Acceptance:** No P0 bugs outstanding 48h before launch.
  - **Depends on:** INT-05.

---

# 🎯 Post-MVP (P2) — Do Not Start Until MVP Ships

Ordered roughly by strategic value per proposal's "Deferred from Design Deck" table.

- [ ] **POST-01** — Per-product dynamic pricing
  - Unlock price inputs per product, apply price zones (Floor / Competitive / Premium / Ceiling) with elasticity. Above-ceiling pricing drops satisfaction. Floor pricing boosts demand 15%. Biggest strategic value of any post-MVP feature per proposal.

- [ ] **POST-02** — Named customer archetypes
  - 6 archetypes (Morning Regular, Brunch Seeker, Wellness Shopper, Lunch Crowd, Sweet Tooth, Deal Hunter) with per-product loyalty + price sensitivity. Depends on POST-01 dynamic pricing.

- [ ] **POST-03** — Passive AI competitors (1 tier first)
  - Fill empty slots when fewer than N students play. Single heuristic: hire 1 intermediate chef matching the round's Trending pair, stock at 80% of base demand. Add Active and Aggressive tiers later.

- [ ] **POST-04** — Curveball / market events (1–2 to start)
  - "Supplier shortage" (one product's base demand halved), "Food critic visit" (one player random bonus satisfaction). Each event = ~1 day of custom logic.

- [ ] **POST-05** — Sous chef poaching
  - Between-round notification flow: a competitor can offer to poach your sous chef. Counter-offer UI. Requires real-time notifications layer.

- [ ] **POST-06** — Equipment upgrade tiers
  - Purchasable equipment that multiplies per-product throughput (e.g. espresso machine +15% Coffee). Stacks with chef multipliers.

- [ ] **POST-07** — Expand to 12 products
  - Add 6 new products + spawn rate rebalance + new nationality specialty pairings.

- [ ] **POST-08** — Gong/Discord integration for company-wide broadcasts
  - Professor can push live event narration to Discord during gameplay.

- [ ] **POST-09** — Persistent session history + student model accuracy tracking
  - After multiple games, track each student's revenue forecast accuracy. Prof-only dashboard.

- [ ] **POST-10** — Mobile polish
  - Responsive down to 375px is already a goal; this task is iOS-Safari quirks, haptics, home-screen PWA install.

- [ ] **POST-11** — Replay viewer
  - After a game ends, replay round-by-round on the professor panel for class discussion.

- [ ] **POST-12** — Coefficient auto-tuning via gameplay telemetry
  - Use actual class outcomes to re-fit revenue coefficients. Offline Python notebook → write new values to `config/params.revenueCoefficients`.

- [ ] **POST-13** — Simulate-phase minigame
  - Interactive mini-game during the `simulating` phase (tap falling croissants or similar). Cosmetic only — no mechanical effect on revenue. Deferred from MVP per DEC-09 but committed.

---

## Locked Decisions (April 17, 2026 — Dylan M.)

All resolved. Any change requires a design-review revisit.

| Ref | Decision | Locked Value |
|---|---|---|
| DEC-01 | **Starting budget** | **$500,000** per player ("from an investor" — narrative framing) |
| DEC-02 | Sous chef hiring — which phase submits? | **Decide phase only.** Roster screen displays them read-only. |
| DEC-03 | Ad bonus — path into revenue | **Flat add to revenue** (not foot-traffic flow) |
| DEC-04 | Ad bonus values (scaled 250× from original defaults) | TV **$50,000** / Billboard **$37,500** / Radio **$25,000** / Newspaper **$18,750** |
| DEC-05 | Roster phase cadence | **Always show ~1 min** every round, even without overflow |
| DEC-06 | Bakery / team name | **Player types one name at join** (used as both displayName + bakery label) |
| DEC-07 | Phase timer | **Professor clicks advance.** Timer is UI-only soft deadline. |
| DEC-08 | Market insight email | **Full-screen route** `/game/email` |
| DEC-09 | Simulate-phase minigame | **Skip for MVP.** Added as post-MVP (POST-13). |
| DEC-10 | Post-MVP scope commitment | **Ship all proposal-deferred features** (POST-01..POST-07) after launch. Post-MVP is committed, not aspirational. |
| DEC-11 | Mobile support | **Desktop-only for MVP.** Responsive polish is post-MVP. |
| DEC-12 | Player cap | **20 per game for launch**, but schema + load tests must support **50** from day one. |
| DEC-13 | Revenue formula coefficients | **Ship as placeholders**, tune after INT-06. Flat terms will need ~250× scale-up to feel meaningful on a $500k budget — that's a tuning task, not a blocker. |
| DEC-14 | Sous chef base cost | **$12,500** (scaled 250× from old $50 default) |
| DEC-15 | Chef auction minimum bid floors | Novel **$25,000** / Intermediate **$43,750** / Advanced **$68,750** (scaled 250×) |
| DEC-16 | Loan shark interest | **10%** (unchanged — it's a rate, not an absolute) |
| DEC-17 | Product sell prices | **Unchanged from proposal** (Coffee $4, Croissant $4.75, Bagel $3, Cookie $2.50, Sandwich $8.75, Matcha $6.25) |
| DEC-18 | Unit supply cost per item | **Unchanged at $1/item** — NOT scaled. Required to keep sell-price margins positive given DEC-17. |

> **Economic framing (from DEC-01 + DEC-17 + DEC-18):** Players have $500k in investor capital. Supply stock is cheap ($1/unit); sell prices are small ($4–$8.75). The real spend is **staffing + chef auctions + ad bids** — those consume 6-figure chunks of the budget. Revenue from sales alone won't repay investor capital; winning means maximizing net revenue through smart satisfaction + foot traffic decisions. The leaderboard ranks "who grew the investor's money most."

---

## Delivery Timeline (Reference)

| Date | Milestone |
|---|---|
| April 17 (today) | Roadmap published, team aligned on task IDs |
| April 19 | Phase A + B complete (config, schema, state machine) |
| April 22 | Phase C + D complete (chef system, simulator) |
| April 24 | Phase E + F complete (CSV, frontend rework) |
| April 25 | INT-01 full smoke test passing |
| April 26 | INT-02 load test + INT-06 team playtest |
| **April 27 or May 1** | **Launch** |

> Every task ID in this file can be referenced in commits (e.g. `feat(BE-13): simulator engine`) and PR titles so progress is legible without reopening this doc.
