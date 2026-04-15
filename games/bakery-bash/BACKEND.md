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
/api/decisions          → Player submits round decisions
/api/simulate           → Internal: runs revenue engine
/api/csv/{gameId}/{id}  → Player downloads their CSV
/api/professor/export   → Professor exports all data
```

---

## Core Systems

### Game State Machine

Backend is the source of truth for game state. Valid transitions:

```
lobby
  → round_N_email      (round briefing / company emails)
  → round_N_decide     (professor starts / advances)
  → round_N_bid        (decide timer expires or professor advances)
  → simulating         (all bids in or timer expires)
  → results_ready      (simulation complete)
  → round_N+1_email    (professor advances)
  → game_over          (after round 5)
```

---

### Revenue Model

```
revenue = 500
        + (30 × staff_count)
        - (15 × avg_price)
        + (0.8 × ad_spend)
        + (50 × num_products)
        + ad_bonus
        + chef_bonus
        + noise [-100, +100]
```

⚠️ These are placeholder coefficients. Game Design delivers finals by April 3.

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
