# Bakery Bash — Frontend Spec

**Team:** AB + Kavin
**Last Updated:** April 2, 2026

---

## Page Map

```
/                   → Landing / Join Game
/lobby              → Waiting room (pre-game)
/game
  /game/email       → Company email inbox / modal
  /game/decide      → Phase 1: Set prices, staffing, menu
  /game/bid         → Phase 2: Ad + Chef auction
  /game/simulate    → Phase 3: Minigame / loading screen
  /game/results     → Phase 4: Round results
/leaderboard        → Live leaderboard
/professor          → Professor control panel (protected)
```

---

## Screens & Components

### 1. Landing / Join Game (`/`)

- Game logo / title
- Input: Player name
- Input: Game code
- Button: "Join Game"
- Error state: invalid code, game already started, game full

---

### 2. Lobby (`/lobby`)

- Live list of joined players
- Player count + status ("Waiting for professor to start…")
- Your bakery name displayed
- Auto-redirects when professor starts game

---

### 3. Company Email (`/game/email`)

- Inbox-style page or modal shown when the game phase is `email`
- Displays company emails for the current round (supplier updates, staffing notices, market news, professor announcements)
- Each email card shows sender, subject, timestamp, and body
- Supports unread/read state locally so players can review messages without blocking backend progress
- Primary action: "Continue to Decisions" when the professor advances to `decide`
- Can also be opened from the in-game header as a modal during later phases for reference

---

### 4. Phase 1: Decide (`/game/decide`)

- Round indicator ("Round 2 of 5")
- Countdown timer (red when < 60s)
- Budget display
- Price inputs — one per menu item
- Stock quantity inputs — one per menu item
- Staff count input (shows cost per staff/round)
- Ad spend input
- Menu unlock panel (add Sandwich / Latte / Matcha Latte)
- Submit button — disables after submission, shows "Waiting for other players"

---

### 5. Phase 2: Bidding (`/game/bid`)

Two sequential 1-minute auctions:

**Ad Auction (1 min)**
- Cards for each ad type: TV, Radio, Newspaper, Billboard
- Bid input per card
- Budget remaining display
- Submit button

**Chef Auction (1 min)**
- Cards for each chef (randomized skill level shown)
- Bid input per card
- Submit button
- If timer expires without submit: treated as $0 bid

---

### 6. Phase 3: Simulate (`/game/simulate`)

- Animated loading screen ("Kitchen is busy…")
- Simple minigame — e.g. tap falling croissants (score display only, no mechanical effect)
- Auto-transitions to results when backend finishes

---

### 7. Phase 4: Results (`/game/results`)

- Revenue this round (large, prominent)
- Customer count
- Customer satisfaction score
- Auction results (which ad/chef you won)
- Leaderboard — ranked list, your row highlighted
- CSV Download button
- Waits for professor to advance to next round

---

### 8. Leaderboard (`/leaderboard`)

**Student view:**
- Ranked by cumulative net revenue
- Your row highlighted
- Columns: Rank, Bakery Name, Revenue (this round), Cumulative Revenue

**Professor view (`/professor/leaderboard`):**
- All players' decisions visible
- Aggregate class stats
- Export all data as CSV

---

### 9. Professor Control Panel (`/professor`)

- Start Game
- Advance Round
- Pause / Resume
- End Game
- Player list with submission status (who has submitted)
- Live leaderboard
- Password-protected route

---

## Component Hierarchy

```
<App>
  <AuthProvider>
    <GameProvider>
      <Router>
        <LandingPage />
        <LobbyPage />
        <GamePage>
          <RoundHeader />     ← round number, timer, budget
          <EmailPhase />
          <DecidePhase />
          <BidPhase />
          <SimulatePhase />
          <ResultsPhase />
        </GamePage>
        <LeaderboardPage />
        <ProfessorPage />
      </Router>
    </GameProvider>
  </AuthProvider>
</App>
```

---

## Open Questions

1. **Minigame spec:** What exactly is the Phase 3 minigame? Needs a decision before April 4.
2. **Mobile support:** Desktop-only or do students play on phones?
3. **Auction UX:** Can a player bid on multiple ad types or just one?
4. **Budget display:** Real-time deductions as inputs change, or only shown on submit?
