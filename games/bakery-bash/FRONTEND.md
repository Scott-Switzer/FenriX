# Bakery Bash — Frontend Spec

**Team:** AB + Kavin
**Last Updated:** April 19, 2026 — aligned to GAME_DESIGN_PROPOSAL.md (April 19 Team Roles update)

> **Source of truth:** [GAME_DESIGN_PROPOSAL.md](./GAME_DESIGN_PROPOSAL.md). Anything in this spec that conflicts with the proposal is wrong — fix the spec, not the proposal.

---

## Page Map

```
/                       → Landing / Join Game
/lobby                  → Waiting room (pre-game)
/game
  /game/email           → Phase 0/4.5: Market insight email between rounds
  /game/decide          → Phase 1: Set quantity per product, sous chef hiring, add menu items
  /game/bid             → Phase 2: Ad auction (1 min) + Chef auction (1 min)
  /game/roster          → Phase 2.5: Chef Roster Management (mandatory if 4th specialty chef won)
  /game/simulate        → Phase 3: Minigame / loading screen while backend runs
  /game/results         → Phase 4: Round results
  /game/conclusion      → Phase 6: Final rankings + winner banner (after Round 5 only)
/leaderboard            → Live leaderboard (cumulative net revenue)
/professor              → Professor control panel (protected)
/professor/leaderboard  → Professor full data view + export
```

---

## Hard UI Rules (from the proposal — non-negotiable)

These rules apply globally to every screen. Violating them breaks the game's core design.

1. **Budget is hidden during play.** No screen — except `/game/conclusion` and the professor leaderboard (`/professor/leaderboard`) — may display the player's remaining budget. Do not show "Budget Remaining", "Cash Left", "$X available", or any equivalent on any other surface. Players otherwise track their own finances externally.

   > **P1 override rescinded (2026-04-19):** The earlier `<BudgetSummary>` decide-phase panel was reverted per the April 19 MVP spec ("Decide phase rework … no budget"). The component file `components/game/BudgetSummary.tsx` was subsequently deleted in PR #78's dead-code cleanup; `budgetCurrent` still flows through `GameContext` because Conclusion + the professor leaderboard read it, but it must not render on any in-game surface.

   > **B-06 carve-out (2026-04-29):** The Decide phase BakeryView shows a yellow chip ("⚠ This decision will trigger the loan shark — 10% interest on the overspend.") when `totalCommitted > budgetCurrent`. The chip is a boolean signal only — it does **not** display the actual budget number, the overspend amount, or the available cash. The user explicitly authorized this carve-out (Q4) so the loan shark stops being a Results-screen surprise. See `BakeryView.tsx`.
2. **Pricing is fixed for MVP.** No price input fields anywhere. Prices are read-only labels next to product inputs (Coffee $4.00, Croissant $4.75, Bagel $3.00, Cookie $2.50, Sandwich $8.75, Matcha $6.25).
3. **Chef specialty is hidden.** ChefCard components must never render specialty products or multiplier values, regardless of whether the data is in props. Only nationality, skill tier (Novel/Intermediate/Advanced), name, and portrait are visible.
4. **Opposing teams' decisions are hidden.** Players see the leaderboard but never another team's stocked quantities, sous chef count, or bids. Teammates on the same team DO see each other's inputs in real time.
5. **Overspend is allowed.** Decision/bid forms never block on budget. The loan shark applies a 10% interest penalty silently at end of round.
6. **Role-gated submits (April 19, DEC-21).** Every submit button reads the logged-in player's `role` and disables when the player's role doesn't own that phase, with a tooltip: *"Your [role] teammate submits this decision."* Inputs stay visible and interactive for everyone on the team — only the submit is gated. Solo players (team size 1) have all roles and all submits enabled.
7. **Never show the numeric sous chef threshold (DEC-25).** No copy should say "4 sous chefs" or "don't hire more than N". Use subtle behavioral hints ("Kitchen getting crowded", "Your head chef looks stressed") so players discover the curve by playing.

---

## Screens & Components

### 1. Landing / Join Game (`/`)

- Game logo / title
- Input: Player name (2–40 chars)
- Input: **Team name** (2–40 chars, **optional** per DEC-23 — teams can skip this and be labelled by members' displayNames)
- Input: 6-character game code (uppercase A–Z, 2–9; auto-uppercased on input)
- **Role picker (radio group):** Finance / Advertising / Operations / "Solo (all roles)" — defaults to Solo when no teammate has already claimed a role in this team; otherwise defaults to the first unclaimed role.
- Button: "Join Game"
- Error states: invalid code, game already started, game full (cap 20 teams), role already taken in this team.
- Anonymous Firebase auth happens on mount; join calls the `joinGame` callable on submit with `{ displayName, teamName?, joinCode, role }`.

---

### 2. Lobby (`/lobby`)

- Live list of joined **teams**, each expanded to show its 1–3 members with role badges (subscribe to `games/{gameId}/teams` + `games/{gameId}/players`)
- Team count + status ("Waiting for professor to start…")
- Your team name displayed large with your role badge
- Teammates joining live append under the same team card — no refresh needed
- Auto-redirects to `/game/email` (Round 1) when professor starts game

---

### 3. Phase 0 / 4.5: Market Insight Email (`/game/email`)

Shown at the start of each round (and after results before the next round). Email-themed modal/page.

- "From: The Plaza Times" (or similar) header, envelope icon, subject line
- Vague hint body (e.g., "Food critics have been spotlighting artisan breakfast staples this week" → hints Croissant/Bagel are Trending). Body text is generated server-side from the round's preference profile.
- "Got it — ready for next round" button (disabled for the first 5 seconds so players read it)
- Auto-dismisses when phase transitions to `decide`
- Never reveals exact demand modifiers or Cold products

---

### 4. Phase 1: Decide (`/game/decide`)

- Round indicator ("Round 2 of 5")
- Countdown timer (red when < 60s)
- **No budget display.**
- **Quantity per product** — one numeric input per offered menu item, with the fixed price shown as a read-only label next to the input
- **Sous Chef Hiring panel** (see `<SousChefPanel>` below) — current count, **per-section assignments** (Bakery / Deli / Barista), "Next hire $X" computed from escalation curve, **behavioral-only warnings** ("Kitchen getting crowded" / "Your head chef looks stressed") — never reveal the numeric threshold (DEC-25). Never blocks.
- **Menu unlock panel** — toggle Sandwich / Coffee / Matcha (base menu = Croissant, Cookie, Bagel)
- **Ad-winner banner** at top showing previous round's ad winners on the appropriate ad surface (TV, Radio, Newspaper, Billboard) with the winning bakery's branding overlaid; player's own win highlighted
- (Optional) "Last round's market hint" recap card — dismissible, pulls from prior round's email body
- Submit button (role-gated to **Operations**; disabled on other teammates' devices with tooltip) — disables after submission, shows "Waiting for other teams (N/M submitted)"
- Maintenance Guy ("janitor") panel: hire count + task assignment (Clean Store / Repair Oven / Repair Meat Slicer / Repair Espresso Machine). Owned by Operations (DEC-22). Station health bars + cleanliness % visible here.

> **What is NOT here:** price inputs (prices are fixed), budget display (hidden), chef specialty (hidden), numeric sous chef threshold copy (DEC-25).

---

### 5. Phase 2: Bidding (`/game/bid`)

Two sequential 1-minute auctions. Sealed-bid, first-price.

**Ad Auction (1 min)**
- Cards for each ad type: TV, Radio, Newspaper, Billboard
- **Current top bid readout** on each card in large, high-contrast type — readable at 2m from the screen (≥ 48px). Treated as a heads-up ticker, not a footnote. (April 19 meeting — the previous treatment was too small to read during competitive bidding.)
- Bid input per card; team can bid on multiple but wins at most one
- **No budget remaining display.** A "Total of all your team's bids: $X" running total is acceptable since it's team-derived from their own inputs.
- Submit button (role-gated to Advertising; disabled on other teammates' devices with tooltip) locks the form; if timer expires without submit, all bids treated as $0

**Chef Auction (1 min)**
- Cards rendered via `<ChefCard mode="bid">` for each chef in the round's pool
  - Visible: portrait, nationality flag, skill tier (Novel / Intermediate / Advanced), name, minimum bid floor, **current top bid (large, high-contrast)**
  - **Hidden:** specialty products, multiplier values
- One bid input per chef. A team can bid on (and win) multiple chefs.
- Minimum bid floor enforced client-side (server is the final arbiter)
- If timer expires without submit: all chef bids treated as $0
- Submit button is **role-gated to Finance** (disabled on other teammates' devices with tooltip)
- After submit, the BE evaluates wins; if total specialty chefs > 3, BE routes the team to `/game/roster` (otherwise straight to `/game/simulate`)

---

### 6. Phase 2.5: Chef Roster Management (`/game/roster`)

Always rendered after the bid phase. Mandatory if the player would exceed 3 specialty chefs after auction wins.

**Layout:**
- **Base Chef card** — always present, greyed out, "cannot be removed" label
- **Specialty Slots 1–3** — filled chef cards (via `<ChefCard mode="roster">`) or empty placeholders
- **Overflow slot** — newly won chef displayed here if no open slot exists; highlighted to indicate action required
- **Sous Chef panel** (`<SousChefPanel>`) — always visible alongside the specialty roster

**Lay-off flow:**
- Click any specialty chef → "Lay Off" button
- Confirmation modal: *"Release [Chef Name] back to the auction pool?"*
- On confirm: chef removed from roster (returns to auction pool for future rounds)
- "Continue" button is **disabled** until specialty chef count ≤ 3

**ChefCard rules apply** — nationality + skill tier + name + portrait visible; specialty hidden.

---

### 7. Phase 3: Simulate (`/game/simulate`)

- Animated loading screen ("Kitchen is busy…")
- Simple minigame — e.g. tap falling croissants (cosmetic only, no mechanical effect on revenue)
- Auto-transitions to `/game/results` when backend finishes (phase becomes `results_ready`)

---

### 8. Phase 4: Results (`/game/results`)

- **Loan shark callout** (only when `amountBorrowed > 0`) — red banner above revenue: "🦈 Loan Shark Visit — You borrowed $X. Penalty: $X principal + $Y interest = **$Z deducted**."
- **Net Revenue this round** (large, prominent, animated count-up). When `amountBorrowed > 0`, also show smaller "Gross $X − Penalty $Z = Net $N" line.
- KPIs row: Customer count, Returning customers (separate stat), Aggregate satisfaction %, Chef satisfaction score
- **Per-product breakdown table** — Product, Stocked, Sold, Satisfaction % (with tier badge), Sell-out flag (🔥 if true). Sorted by satisfaction descending.
- Auction results — which ad you won, which chefs you won (rendered as `<ChefCard mode="won">`)
- Leaderboard — ranked list (cumulative net revenue), your row highlighted
- "Download CSV" button → calls `/api/csv/{gameId}/{playerId}`
- Footnote on satisfaction weighting: "Aggregate satisfaction is weighted: Coffee 1.5×, Matcha 1.3×, Croissant 1.2×, others 1.0×"
- Persistent "Waiting for professor to advance…" footer
- **No budget display.**

---

### 9. Phase 6: Conclusion Screen (`/game/conclusion`)

Shown after Round 5 results are processed. **Read-only — no inputs, no decisions.**

**Winner Banner (top):**
- Team name of the winning bakery (largest net revenue; tiebreaker: budget remaining)
- Row of `<ChefCard mode="won">` for the winning team's full chef roster (base chef + all specialty chefs) with names + nationality flags
- Visual flourish (confetti or trophy)

**Final Rankings Table:**

| Column | Description |
|---|---|
| Rank | 1st, 2nd, 3rd… |
| Team Name | Player/team display name |
| Total Revenue | Sum of gross revenue across all 5 rounds |
| Total Interest Charged | Cumulative loan shark interest |
| Net Revenue | Total Revenue − Total Interest − Total Principal Borrowed |
| Budget Remaining | **Tiebreaker.** Can be negative (red if so). Not added to Net Revenue. |

**Per-Player Detail (Expandable):**
Each row expands into a per-round breakdown — Round / Revenue / Borrowed / Interest / Net.

**Professor view:** identical screen plus an "Export full results CSV" button.

> This is the **only screen** in the game where Budget Remaining is shown.

---

### 10. Leaderboard (`/leaderboard`)

**Student view:**
- Ranked **by team** (cumulative net revenue), not by individual player
- Your team's row highlighted
- Columns: Rank, Bakery Label (team name if set, else concatenated member displayNames per DEC-23), Net Revenue (this round), Cumulative Net Revenue
- **No budget column.**

**Professor view (`/professor/leaderboard`):**
- All players' decisions and full results visible (this is the live-ops control room view)
- Aggregate class stats (avg revenue, median, std dev, avg satisfaction)
- Export all data as CSV

---

### 11. Professor Control Panel (`/professor`)

Expanded in the April 19 meeting — prof needs **real-time visibility into every team's progress** to run the 8–10 AM live session confidently.

- Create Game (form for settings → returns join code displayed huge for the class)
- Start Game / Advance Phase / Pause / Resume / End Game (each disabled when invalid for current phase)
- **Per-team submission grid** (rows = teams, columns = phases of the current round). Cell states: ✓ submitted / ⏳ pending / ⚠️ disconnected / 🔒 not yet unlocked. Click a team row to drill in.
- **Team drill-down panel** — on row click, shows the team's last-submitted decisions (quantities, sous chef counts + section assignments, Maintenance Guy hires, bid amounts, roster). This is the "individual team progress and decisions" visibility the prof asked for.
- **Live aggregate stats** — mean/median revenue, satisfaction distribution, spread between fastest and slowest team on the current phase. Updates in real time as sims complete.
- Live leaderboard (same data as `/leaderboard` but with per-team budget column visible here).
- "Copy join link" button (puts `https://…/?code=XXXXXX` on clipboard)
- **Reset / New Game** button — ends the current session and starts a fresh one without leaving the page. Covers the "intro warm-up" use case (DEC-26) and the data-regen testing workflow.
- **Auth:** professor custom claim required on the Firebase ID token (not a password — see backend AUTH_PLAYER_FLOW.md)

---

## Reusable Components

| Component | Used By | Notes |
|---|---|---|
| `<RoundHeader>` | All `/game/*` routes | Round N/M, countdown timer, sous chef count, specialty chef count, **team name + your role badge**. **No budget.** |
| `<ChefCard mode="bid"\|"roster"\|"won">` | Bid, Roster, Results, Conclusion | Portrait, nationality, skill tier, name. **Never specialty or multipliers.** Has a regression test asserting `data-testid="chef-specialty"` is never in the DOM. |
| `<SousChefPanel>` | Decide, Roster | Current count, **per-section assignments** (Bakery / Deli / Barista — not per product, per DEC-20), escalating "Next hire $X". **No numeric threshold hints** (DEC-25): subtle behavioral copy only. Never blocks. |
| `<ProductBreakdownTable>` | Results | Per-product stocked / sold / satisfaction % / sell-out flag, sorted by satisfaction desc. |
| `<MarketEmailModal>` | `/game/email` | Email-themed UI, vague hint body, 5-second read delay before dismiss. |
| `<LoanSharkCallout>` | Results | Red banner shown only when `amountBorrowed > 0`. |
| `<AdWinnerBanner>` | Decide | Renders previous round's ad winners on TV/Radio/Newspaper/Billboard surfaces, overlaid with the winning team's name. |
| `<SubmissionLock>` | Decide, Bid (both halves), Roster | Disables form on submit; shows "N/M teams submitted". Reads logged-in player's `role` and gates the submit button (tooltip for non-owning roles). |
| `<RoleBadge>` | RoundHeader, Lobby, Professor panel | Small pill showing the player's role (Finance / Advertising / Operations / Solo) with a color code. Purely informational. |

---

## Component Hierarchy

```
<App>
  <AuthProvider>                          ← Firebase Anonymous Auth
    <GameProvider>                        ← Firestore-backed: game doc, player doc, leaderboard
      <Router>
        <LandingPage />
        <LobbyPage />
        <GamePage>
          <RoundHeader />                 ← round, timer, sous/specialty chef counts (NO budget)
          <EmailPhase>
            <MarketEmailModal />
          </EmailPhase>
          <DecidePhase>
            <AdWinnerBanner />
            <SousChefPanel />
            <SubmissionLock />
          </DecidePhase>
          <BidPhase>
            <AdAuction />
            <ChefAuction>
              <ChefCard mode="bid" />
            </ChefAuction>
            <SubmissionLock />
          </BidPhase>
          <RosterPhase>
            <ChefCard mode="roster" />
            <SousChefPanel />
          </RosterPhase>
          <SimulatePhase />
          <ResultsPhase>
            <LoanSharkCallout />
            <ProductBreakdownTable />
            <ChefCard mode="won" />
          </ResultsPhase>
        </GamePage>
        <ConclusionPage>
          <ChefCard mode="won" />         ← winner roster
        </ConclusionPage>
        <LeaderboardPage />
        <ProfessorPage />
        <ProfessorLeaderboardPage />
      </Router>
    </GameProvider>
  </AuthProvider>
</App>
```

---

## Hide-Budget Audit (CI rule)

Add a CI check (lint rule or grep test) that fails if `budgetCurrent`, `budgetRemaining`, or any "remaining cash" UI is referenced in any file under `app/src/pages/` or `app/src/components/` **except**:
- `pages/ConclusionPage.tsx`
- `pages/ProfessorPage.tsx`
- `pages/ProfessorLeaderboardPage.tsx`
- `pages/GamePage.tsx` (only for the player-doc listener that dispatches `SET_BUDGET` into context so Conclusion + professor views can render it later)
- `contexts/GameContext.tsx` (only for the `budgetCurrent` field on `GameState` and the `SET_BUDGET` action)
- `lib/cost.ts` (cost-only helpers; never reads or renders `budgetCurrent` itself)
- `components/game/BakeryView.tsx` (B-06 carve-out: yellow loan-shark warning chip when `totalCommitted > budgetCurrent`, plus the `cannotAfford` boolean used to disable product-unlock buttons. Reads `budgetCurrent` for boolean comparison only — never renders the dollar amount.)
- `components/game/tabs/StaffTab.tsx` (K-01: equipment-upgrade affordability gate. Reads `budgetCurrent` to compute `available` for the upgrade button's `disabled` state — never renders the value.)

This catches accidental budget leaks in PRs. Implemented in `scripts/audit-ui-rules.sh` (FE-01) and wired to a pre-push hook via `scripts/install-git-hooks.sh`.

---

## Open Questions

1. ~~**Auction UX:** Can a player bid on multiple ad types or just one?~~ → ✅ **Multiple bids allowed; wins at most one ad and gets routed to next-highest if would-double-win.**
2. ~~**Budget display:** Real-time deductions as inputs change, or only shown on submit?~~ → ✅ **Hidden entirely during play. Revealed once on Conclusion Screen as the tiebreaker.** The earlier P1 override that put a live `<BudgetSummary>` in the decide sidebar was rescinded on 2026-04-19 per the updated MVP spec.
3. ~~**Minigame spec:**~~ → ✅ **Skipped for MVP** (DEC-09). Simulate phase shows a cute loading animation only. Interactive minigame is post-MVP (POST-13).
4. ~~**Mobile support:**~~ → ✅ **Desktop-only for MVP** (DEC-11). Responsive polish is post-MVP.
5. ~~**Email phase as full route vs modal overlay:**~~ → ✅ **Full-screen route `/game/email`** (DEC-08).
6. ~~**Roster screen for non-overflow case:**~~ → ✅ **Always shown ~1 min** every round (DEC-05), mandatory when specialty chefs > 3.
7. ~~**Sous chef panel authority:**~~ → ✅ **Hire only on Decide screen** (DEC-02). Roster `<SousChefPanel>` is read-only — shows current count and assignments but does not submit changes.
8. ~~**Bakery name:**~~ → ✅ **Single `displayName` typed at join** (DEC-06) — used as both player name and bakery label everywhere.
9. ~~**Player cap UX:**~~ → ✅ **Show "Game full" at 20** (DEC-12); layout must still render cleanly with up to 50 players for post-MVP.

> **Locked defaults reference:** All game-balance numbers (starting budget $500,000, chef bid floors, ad bonuses, sous chef cost) are locked in [projectRoadmap.md](./projectRoadmap.md) Decisions Table (DEC-01..DEC-18). The frontend reads these from `config/params` — never hardcode.
