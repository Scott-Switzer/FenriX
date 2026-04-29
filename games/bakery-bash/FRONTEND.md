# Bakery Bash — Frontend Spec

**Team:** AB + Kavin
**Last Updated:** April 16, 2026 — aligned to GAME_DESIGN_PROPOSAL.md (April 15, 2026)

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

1. **Budget is hidden during play.** No screen — except `/game/conclusion` and the professor view — may display the player's remaining budget. Do not show "Budget Remaining", "Cash Left", "$X available", or any equivalent. Players track their own finances externally.
2. **Pricing is fixed for MVP.** No price input fields anywhere. Prices are read-only labels next to product inputs (Coffee $4.00, Croissant $4.75, Bagel $3.00, Cookie $2.50, Sandwich $8.75, Matcha $6.25).
3. **Chef specialty is hidden.** ChefCard components must never render specialty products or multiplier values, regardless of whether the data is in props. Only nationality, skill tier (Novel/Intermediate/Advanced), name, and portrait are visible.
4. **Opponents' decisions are hidden.** Players see the leaderboard but never another player's stocked quantities, sous chef count, or bids.
5. **Overspend is allowed.** Decision/bid forms never block on budget. The loan shark applies a 10% interest penalty silently at end of round.

---

## Screens & Components

### 1. Landing / Join Game (`/`)

- Game logo / title
- Input: Player name (2–40 chars)
- Input: 6-character game code (uppercase A–Z, 2–9; auto-uppercased on input)
- Button: "Join Game"
- Error states: invalid code, game already started, game full (cap 30)
- Anonymous Firebase auth happens on mount; join calls the `joinGame` callable on submit.

---

### 2. Lobby (`/lobby`)

- Live list of joined players (subscribe to `games/{gameId}/players`)
- Player count + status ("Waiting for professor to start…")
- Your team/bakery name displayed
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
- **Sous Chef Hiring panel** (see `<SousChefPanel>` below) — current count, per-product assignments, "Next hire $X" computed from escalation curve, soft warnings at >4 (Kitchen Satisfaction drop) and >8 (severe disruption); never blocks
- **Menu unlock panel** — toggle Sandwich / Coffee / Matcha (base menu = Croissant, Cookie, Bagel)
- **Ad-winner banner** at top showing previous round's ad winners on the appropriate ad surface (TV, Radio, Newspaper, Billboard) with the winning bakery's branding overlaid; player's own win highlighted
- (Optional) "Last round's market hint" recap card — dismissible, pulls from prior round's email body
- Submit button — disables after submission, shows "Waiting for other players (N/M submitted)"

> **What is NOT here:** price inputs (prices are fixed), budget display (hidden), chef specialty (hidden).

---

### 5. Phase 2: Bidding (`/game/bid`)

Two sequential 1-minute auctions. Sealed-bid, first-price.

**Ad Auction (1 min)**
- Cards for each ad type: TV, Radio, Newspaper, Billboard
- Bid input per card; player can bid on multiple but wins at most one
- **No budget remaining display.** A "Total of all your bids: $X" running total is acceptable since it's player-derived from their own inputs.
- Submit button locks the form; if timer expires without submit, all bids treated as $0

**Chef Auction (1 min)**
- Cards rendered via `<ChefCard mode="bid">` for each chef in the round's pool
  - Visible: portrait, nationality flag, skill tier (Novel / Intermediate / Advanced), name, minimum bid floor
  - **Hidden:** specialty products, multiplier values
- One bid input per chef. A player can bid on (and win) multiple chefs.
- Minimum bid floor enforced client-side (server is the final arbiter)
- If timer expires without submit: all chef bids treated as $0
- After submit, the BE evaluates wins; if total specialty chefs > 3, BE routes the player to `/game/roster` (otherwise straight to `/game/simulate`)

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
- Ranked by cumulative net revenue
- Your row highlighted
- Columns: Rank, Bakery Name, Net Revenue (this round), Cumulative Net Revenue
- **No budget column.**

**Professor view (`/professor/leaderboard`):**
- All players' decisions and full results visible (this is the live-ops control room view)
- Aggregate class stats (avg revenue, median, std dev, avg satisfaction)
- Export all data as CSV

---

### 11. Professor Control Panel (`/professor`)

- Create Game (form for settings → returns join code displayed huge for the class)
- Start Game / Advance Phase / Pause / Resume / End Game (each disabled when invalid for current phase)
- Player list with per-phase submission status (✓ submitted / ⏳ pending / ⚠️ disconnected)
- Live leaderboard
- "Copy join link" button (puts `https://…/?code=XXXXXX` on clipboard)
- **Auth:** professor custom claim required on the Firebase ID token (not a password — see backend AUTH_PLAYER_FLOW.md)

---

## Reusable Components

| Component | Used By | Notes |
|---|---|---|
| `<RoundHeader>` | All `/game/*` routes | Round N/M, countdown timer, sous chef count, specialty chef count. **No budget.** |
| `<ChefCard mode="bid"\|"roster"\|"won">` | Bid, Roster, Results, Conclusion | Portrait, nationality, skill tier, name. **Never specialty or multipliers.** Has a regression test asserting `data-testid="chef-specialty"` is never in the DOM. |
| `<SousChefPanel>` | Decide, Roster | Current count, per-product assignments, escalating "Next hire $X", warnings at >4 and >8. Never blocks. |
| `<ProductBreakdownTable>` | Results | Per-product stocked / sold / satisfaction % / sell-out flag, sorted by satisfaction desc. |
| `<MarketEmailModal>` | `/game/email` | Email-themed UI, vague hint body, 5-second read delay before dismiss. |
| `<LoanSharkCallout>` | Results | Red banner shown only when `amountBorrowed > 0`. |
| `<AdWinnerBanner>` | Decide | Renders previous round's ad winners on TV/Radio/Newspaper/Billboard surfaces. |
| `<SubmissionLock>` | Decide, Bid (both halves) | Disables form on submit; shows "N/M players submitted". |

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

This catches accidental budget leaks in PRs.

---

## Open Questions

1. ~~**Auction UX:** Can a player bid on multiple ad types or just one?~~ → ✅ **Multiple bids allowed; wins at most one ad and gets routed to next-highest if would-double-win.**
2. ~~**Budget display:** Real-time deductions as inputs change, or only shown on submit?~~ → ✅ **Hidden entirely during play. Revealed once on Conclusion Screen as the tiebreaker.**
3. ~~**Minigame spec:**~~ → ✅ **Skipped for MVP** (DEC-09). Simulate phase shows a cute loading animation only. Interactive minigame is post-MVP (POST-13).
4. ~~**Mobile support:**~~ → ✅ **Desktop-only for MVP** (DEC-11). Responsive polish is post-MVP.
5. ~~**Email phase as full route vs modal overlay:**~~ → ✅ **Full-screen route `/game/email`** (DEC-08).
6. ~~**Roster screen for non-overflow case:**~~ → ✅ **Always shown ~1 min** every round (DEC-05), mandatory when specialty chefs > 3.
7. ~~**Sous chef panel authority:**~~ → ✅ **Hire only on Decide screen** (DEC-02). Roster `<SousChefPanel>` is read-only — shows current count and assignments but does not submit changes.
8. ~~**Bakery name:**~~ → ✅ **Single `displayName` typed at join** (DEC-06) — used as both player name and bakery label everywhere.
9. ~~**Player cap UX:**~~ → ✅ **Show "Game full" at 20** (DEC-12); layout must still render cleanly with up to 50 players for post-MVP.

> **Locked defaults reference:** All game-balance numbers (starting budget $500,000, chef bid floors, ad bonuses, sous chef cost) are locked in [projectRoadmap.md](./projectRoadmap.md) Decisions Table (DEC-01..DEC-18). The frontend reads these from `config/params` — never hardcode.
