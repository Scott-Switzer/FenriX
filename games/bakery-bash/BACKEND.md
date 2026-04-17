# Bakery Bash — Backend Spec

**Team:** Daniel + Scott + Dylan B.
**Last Updated:** April 2, 2026

---

## Page Map

```
/api/game/create        → Professor creates session
/api/game/join          → Player joins session
/api/game/start         → Professor starts game
/api/game/advance       → Professor advances phase
/api/decisions          → Player submits Closing Hours decisions
/api/simulate           → Internal: runs revenue engine
/api/csv/{gameId}/{id}  → Player downloads their CSV
/api/professor/export   → Professor exports all data
```

---

## Core Systems

### Game State Machine

Backend is the source of truth for game state. Every phase transition writes the same `phase`, `currentRound`, and server-generated `phaseEndTime` to `/games/{gameId}` so every client calculates time remaining from the same Firestore timestamp. Clients must not run authoritative local countdowns.

```
lobby
  → round_N_closing_hours      (players make menu, staffing, pricing, and bid decisions)
  → round_N_auction            (three sealed-bid auctions)
  → round_N_open_for_business  (café runs, revenue calculated)
  → round_N_results            (leaderboard updates, CSV data drops exported)
  → round_N+1_closing_hours    (professor advances)
  → game_over          (after round 5)
```

Phase durations are stored in `/games/{gameId}/config/params.phaseDurations`:

| Phase | Default |
|---|---:|
| `closing_hours` | 180s |
| `auction` | 90s |
| `open_for_business` | 30s |
| `results` | 60s |

---

### Revenue Model

```
revenue = 500
        + (30 × staff_count)
        - (15 × avg_price)
        + (0.8 × ad_spend)
        + (50 × num_products)
        + ad_bonus
        + (5 × headchef_skill)
        + noise [-100, +100]
```

⚠️ These are placeholder coefficients. Game Design delivers finals by April 3.

---

### Decision Submission

Players submit Closing Hours decisions through the `submitDecision` callable Cloud Function, never by writing decision snapshots directly from the browser. The function validates server-side before writing `/games/{gameId}/players/{playerId}/decisions/round_N`.

Required validation:

- Menu must include at least one sweet item (`croissant` or `cookie`)
- Menu must include at least one savory item (`bagel` or `sandwich`)
- Menu must include at least one drink (`latte` or `matchaLatte`)
- Staff count, prices, quantities, ad spend, ad type, and chef bid fields must be well-formed
- Submission round must match the game's current round
- Game phase must be `closing_hours`

If validation fails, the function returns a clear `invalid-argument` error for the frontend to display.

---

### Customer Allocation

Total pool = `100 × num_players`. Distributed proportionally by attractiveness score:

```
attractiveness = (1 / avg_price) × 100
              + (staff_count × 5)
              + (ad_spend × 0.3)
              + (num_products × 10)
```

Each player's share: `customers_i = total × (score_i / sum of all scores)`

---

### Auction Logic

Sealed-bid, first-price. Highest bidder wins and pays their bid.

**Ad Auction:** 4 types (TV, Radio, Newspaper, Billboard). Player can bid on multiple but wins at most one. If winner already claimed another ad, award to next highest bidder.

**Chef Auction:** 3 chefs per round, skill levels randomized (range 0–100). Each player bids on one. Highest bidder per chef wins.

---

### Budget System

```
budget_next = budget_current + revenue - costs_this_round

costs = staffing_cost + ad_spend + stock_cost + winning_bids + credit_cost
```

Budget is cumulative — early mistakes compound. Starting budget TBD (suggest $2,000).

Players may be allowed to carry a negative budget through an overdraft/credit mechanic, but the cost rate and repayment rules are pending Game Design sign-off (see Open Question #6). Until that rate is finalized, backend validation should keep the current non-negative budget rule.

Staffing cost will move from a flat per-staff cost to a dynamic curve so higher headcounts become progressively more expensive. The exact escalation curve is pending Game Design sign-off (see Open Question #7). Until then, backend config should retain the flat fallback.

---

### CSV Output

One row per player per round. Column order:

```
day, revenue, num_products, avg_price, staff_count, ad_spend,
customer_count, customer_satisfaction, headchef_skill,
croissant, cookie, bagel, sandwich, latte, matcha_latte, ad_type
```

During the simulation step (`open_for_business` phase), the backend creates a per-player email data drop at:

```
/games/{gameId}/players/{playerId}/emails/round_{nextRound}_data
```

There is no separate "email phase" — emails are written as part of `runRoundSimulation` and are available by the time the game transitions to `results`. The email contains a `text/csv` attachment with all CSV rows available through the just-completed round. The frontend should read this backend-owned email document and let the owning player download the attached CSV before making the next round's decisions.

Emails are skipped after the final round since there is no next round to deliver them for.

---

## Open Questions

1. **Timer enforcement:** Backend-enforced timers or professor advances manually? Recommend: manual for MVP.
2. **Player cap:** Max players per session? Suggest 30.
3. **Disconnection handling:** If player drops mid-round, use last submitted values.
4. **Customer split:** Proportional vs winner-take-most — Game Design must decide.
5. **All numbers below** still need Game Design sign-off by April 3:
6. **Credit/overdraft cost rate:** What interest/fee rate applies when a player spends beyond current cash, and when is it charged (immediately, per round, or at game end)?
7. **Dynamic staffing escalation curve:** What curve should replace flat `staff_count × cost_per_staff` — step tiers, linear escalation, exponential growth, or another schedule?

| Variable | Default if unconfirmed |
|---|---|
| Starting budget | $2,000 |
| Cost per staff/round | $50 |
| Credit/overdraft cost rate | TBD — keep non-negative budget validation |
| Staffing cost escalation curve | TBD — keep flat cost fallback |
| Unit cost per product | $1 flat |
| Customer pool formula | 100 × num_players |
| Purchase rate per item | 0.3 flat |
| Ad bonus values | TV +$200, Billboard +$150, Radio +$100, Newspaper +$75 |
