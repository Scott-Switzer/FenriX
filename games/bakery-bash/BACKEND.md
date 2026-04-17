# Bakery Bash — Backend Spec

**Team:** Daniel + Scott + Dylan B.
**Last Updated:** April 16, 2026 — aligned to GAME_DESIGN_PROPOSAL.md (April 15, 2026)

> **Source of truth:** [GAME_DESIGN_PROPOSAL.md](./GAME_DESIGN_PROPOSAL.md). Anything in this spec that conflicts with the proposal is wrong — fix the spec, not the proposal.

---

## API Surface

```
/api/game/create        → Professor creates session (createGame onCall)
/api/game/join          → Player joins session (joinGame onCall — already implemented)
/api/game/start         → Professor starts game
/api/game/advance       → Professor advances phase (state machine below)
/api/game/pause         → Professor pauses
/api/game/resume        → Professor resumes
/api/game/end           → Professor ends game (force game_over)

/api/decisions/submit   → Player submits round decisions (quantities, sous chef hires)
/api/bids/submit        → Player submits ad + chef bids
/api/roster/layoff      → Player lays off a specialty chef during roster phase
/api/roster/continue    → Player advances out of roster phase (rejected if specialty chefs > 3)

/api/simulate           → Internal: runs revenue engine on entry to `simulating`
/api/conclusion         → Returns conclusion-screen data (cached after game_over)

/api/csv/{gameId}/{playerId}  → Player downloads their CSV
/api/professor/export         → Professor exports all data (full game CSV)
```

---

## Game State Machine

Backend is the source of truth for game state. Valid transitions:

```
lobby
  → round_N_email          (professor advances; market insight email body generated)
  → round_N_decide         (timer or professor advances)
  → round_N_bid_ad         (decide submits in or timer expires)
  → round_N_bid_chef       (ad bids in or timer expires)
  → round_N_roster         (chef bids resolved; route here always for ~1 min OR mandatory if won 4th specialty chef)
  → simulating             (all roster decisions in or timer expires)
  → results_ready          (simulation complete)
  → round_N+1_email        (professor advances; loop until N=5)
  → game_over              (after Round 5 results)
```

**Phase durations** (defaults, tunable via `config/params.phaseDurations`):

| Phase | Default duration |
|---|---|
| email | ~30s (or auto-advance after dismiss) |
| decide | ~5 min |
| bid_ad | ~1 min |
| bid_chef | ~1 min |
| roster | ~1 min (forced if specialty chefs > 3) |
| simulating | ~30s (compute time) |
| results | ~1 min (or until professor advances) |

Each transition writes a new `phaseEndsAt: Timestamp` to the game doc. Reject invalid transitions with `failed-precondition`. Wrap each transition in a Firestore transaction so concurrent advances can't double-fire.

---

## Core Systems

### Fixed Product Catalog

Pricing is **fixed for MVP** (per the proposal). Stored in `games/{gameId}/config/params.productPrices`:

| Product | Fixed Price | Base Demand (units/day) | Satisfaction Weight |
|---|---|---|---|
| Coffee | $4.00 | 70 | 1.5 |
| Croissant | $4.75 | 60 | 1.2 |
| Bagel | $3.00 | 55 | 1.0 |
| Cookie | $2.50 | 50 | 1.0 |
| Sandwich | $8.75 | 45 | 1.0 |
| Matcha | $6.25 | 25 | 1.3 |

**Base menu:** Croissant, Cookie, Bagel. Players can opt into Sandwich, Coffee, Matcha each round.

---

### Round Preference Profile

Generated at game create. Persisted at `games/{gameId}/preferences/rounds[N].assignments`. Cloud-Function-readable for sim; client-readable as a hint string only (the email body — see Market Insight Email).

For each of the 5 rounds:
- Exactly **2 Trending (+40%)**, **2 Warm (+15%)**, **1 Neutral (±0%)**, **1 Cold (−25%)**
- **Constraint:** no product is Trending in two consecutive rounds (regenerate the round if violated)

The demand pool for product P in round N is: `baseDemand(P) × roundModifier(P, N)`.

---

### Chef System

#### Chef Pool Generation (per round)

Before each `round_N_bid_chef` phase, generate a chef pool of 6–8 chefs and write to `games/{gameId}/rounds/{round}/chefs`:

For each chef:
- **Nationality** — uniform random from { French, Japanese, Italian, American }
- **Gender** — uniform random
- **Variant** — uniform random from that nationality's variant list (A/B/C with art-direction specs from the proposal)
- **Skill tier** — sampled from the round's spawn-rate row:
  | Skill | R1 | R2 | R3 | R4 | R5 |
  |---|---|---|---|---|---|
  | Novel | 65% | 55% | 40% | 20% | 5% |
  | Intermediate | 30% | 35% | 40% | 45% | 45% |
  | Advanced | 5% | 10% | 20% | 35% | 50% |
- **Name** — random from the per-nationality name list
- **Specialty products** — derived from nationality (French→Croissant+Coffee, Japanese→Matcha+Croissant, Italian→Sandwich+Coffee, American→Bagel+Cookie). **Stored but client-read denied via security rules.**
- **Minimum bid floor** — `(Novel: 2, Intermediate: 3.5, Advanced: 5.5) × baselineFloor`

#### Chef Output Multipliers

Per-chef per-product daily output = `30 × multiplier`:

| Skill | Non-Specialty | Specialty |
|---|---|---|
| Novel | 1.0× | 1.4× |
| Intermediate | 1.25× | 1.75× |
| Advanced | 1.6× | 2.2× |

**Base chef** (always present, cannot be removed): 1.0× on all 6 products, no specialty.

**Total product output (e.g. Croissants)** = sum of every chef's contribution:
```
totalOutput(P) = baseChef(P) + Σ specialtyChef_i(P)
              = 30·1.0 + Σ 30·multiplier_i(P)
```

**Capped by supply:** `effectiveOutput(P) = min(totalOutput(P), supplyStocked(P))`.

#### Specialty Chef Cap = 3

Each player can hold at most 3 specialty chefs. If a chef auction win pushes them over 3, set `pendingRosterAction: true` on their player doc and require lay-off via `/api/roster/layoff` before they can advance out of the roster phase.

Laid-off chefs return to a `auctionReturnPool` and may re-enter future chef pools.

#### Sous Chefs

Hired directly (no auction). Unlimited count. **Each must be assigned to a specific product per round.**

**Output per sous chef:**
```
sousOutput(assignedProduct) = 0.5 × headChefOutput(assignedProduct)
```
where `headChef = highest-skill specialty chef on the team` (falls back to base chef if none).

**Escalating hire cost** (per additional hire per round, applied via `nextSousChefCost(currentCount)`):

| Sous Chef # | Cost Multiplier (× `sousChefBaseCost`) |
|---|---|
| 1st | 1.0× |
| 2nd | 1.5× |
| 3rd | 2.25× |
| 4th | 3.0× |
| 5th+ | +0.75× per additional |

**Chef Satisfaction Score** (kitchen cohesion — penalizes overhiring):
```
chefSatisfaction = max(35, 100 − max(0, sousChefCount − 4) × 16)
```

| Count | Score | State |
|---|---|---|
| 0–4 | 100 | Optimal |
| 5 | 84 | Slightly crowded |
| 6 | 68 | Coordination breaking |
| 7 | 52 | Chaotic |
| 9+ | 35 (floor) | Severe disruption |

Applied as a **throughput multiplier**:
```
effectiveTotalOutput = totalCalculatedOutput × (chefSatisfaction / 100)
```

This is the only kitchen-overstaffing penalty mechanism — there is no separate revenue coefficient.

---

### Customer Allocation

Two-stage model.

**Stage 1 — per-product satisfaction:**
For each player and product P:
```
fillRate(P)        = effectiveOutput(P) / baseDemand(P)
satisfactionPct(P) = clamp(0, 100, tierMap(fillRate))
```
with tier mapping:

| Fill Rate | Tier | Satisfaction % |
|---|---|---|
| < 50% | Critical | 0–20 |
| 50–69% | Poor | 21–45 |
| 70–84% | Adequate | 46–65 |
| 85–99% | Good | 66–85 |
| ≥ 100% | Excellent | 86–100 |

**Sell-out override:** if a sell-out occurs mid-round (see Sell-Out Mechanic), `satisfactionPct(P)` is clamped to ≤45 for that round.

**Stage 2 — per-product allocation:**
```
demandPool(P) = baseDemand(P) × roundModifier(P)
playerShare(P) = demandPool(P) × satisfactionPct(player, P) / Σ satisfactionPct(allPlayers, P)
```
Players not offering P are excluded from the denominator.

**Returning customers** (from the prior round's brand-loyalty bonus) are added to the player's customer count **before** competitive split.

---

### Sell-Out Mechanic

Within a single round, customers consume per-product on a normalized time axis 0..1. When `cumulativeServed(P) > supplyStocked(P)` for a player:

- Mark `sellout[P] = true` for that player
- Drop `satisfactionPct(P) ≤ 45` for the rest of the round
- Re-route arriving customers per loyalty:
  - **Product-loyal** → defects to a random remaining competitor offering P, weighted by their `satisfactionPct(P)`. If no one offers P, becomes a lost customer.
  - **Brand-loyal** → redirects to the same bakery's next available menu product. Lost if nothing else available.

Persist `sellout_*` boolean flags to the round record.

---

### Returning Customer Bonus

Computed at end of each round from that round's aggregate satisfaction:

| Aggregate Satisfaction | Returning Customer Bonus (next round) |
|---|---|
| Excellent (86–100%) | +15% of this round's customer count |
| Good (66–85%) | +8% of this round's customer count |
| Adequate (46–65%) | 0 |
| Poor or Critical | 0 (resets) |

Stored on `players/{uid}.returningCustomersPending`. Added directly to next round's customer count before competitive split. Surfaced on results screen but **excluded from regression CSV** per the proposal.

---

### Aggregate Satisfaction (weighted)

```
aggregateSatisfaction = Σ (weight(P) × satisfactionPct(P)) / Σ weight(P)
```

Using product weights from the catalog (Coffee 1.5, Matcha 1.3, Croissant 1.2, Sandwich/Cookie/Bagel 1.0). Products not offered are excluded from both numerator and denominator.

---

### Revenue Model

```
revenue = 500
        + (12   × sous_chef_count)
        + (8.0  × aggregate_satisfaction_pct)
        + (0.8  × ad_spend)
        + (50   × num_products)
        + Σ (qty_sold(P) × fixed_price(P))
        + noise [-100, +100]
```

⚠️ Coefficients are placeholders pending Game Design tuning. Pull from `config/params.revenueCoefficients`. Noise seeded by `${gameId}:${round}:${playerId}` for reproducibility.

> Removed from earlier spec: `avg_price` (no player price inputs), `headchef_skill` (now flows through aggregate satisfaction), per-chef explicit bonus terms (replaced by satisfaction-driven throughput).

---

### Auction Logic

Sealed-bid, first-price. Highest bidder wins and pays their bid.

**Ad Auction:** 4 types (TV, Radio, Newspaper, Billboard). Player can bid on multiple but wins at most one. If the high bidder already won another ad type this round, award to next-highest. Tie-break by `submittedAt asc`. Bonus values pulled from `config/params.adBonus` (defaults: TV +$200, Billboard +$150, Radio +$100, Newspaper +$75). Persist winners to `games/{gameId}/rounds/{round}/adWinners` so the next round's Decide screen can render the visual ad-winner banner.

**Chef Auction:** Each chef in the round's pool resolves independently. Highest bidder wins, pays bid. A player can win multiple chefs. Tie-break by `submittedAt asc`. Won chefs append to `players/{uid}.specialtyChefs` and trigger `pendingRosterAction` if the player would exceed 3.

---

### Loan Shark / Budget System

**Overspend is allowed.** Players are never blocked at decision/bid submit time.

At end-of-round in `runSimulation`:
```
spent              = stockCost + sousChefHireCost + adAuctionWinningBids + chefAuctionWinningBids
borrowed           = max(0, spent − budgetCurrent)
interest           = borrowed × 0.10
loanSharkDeduction = borrowed + interest
revenueNet         = revenueGross − loanSharkDeduction
budgetNext         = budgetCurrent + revenueNet − spent
```

Persist `amountBorrowed`, `interestCharged`, `revenueGross`, `revenueNet` per round. Surface on results screen via the loan shark callout. **No mid-round warning** — the deduction appears on the post-round report.

> This resolves the previous "non-negative budget" placeholder rule.

**Stock cost:** `Σ qty_stocked(P) × unitCost(P)` where `unitCost` defaults to $1 flat per item (tunable via `config/params.unitCosts`). Unsold supply is wasted (no carryover).

---

### Market Insight Email

On entry to each `round_N_email` phase, generate a vague hint string referencing the upcoming round's Trending products (paraphrased). Maintain a small library of templated phrases per Trending pair in `config/insightTemplates`. Examples:

- Trending = Croissant + Bagel → "Food critics have been spotlighting artisan breakfast staples this week."
- Trending = Matcha + Coffee → "Wellness Wednesday is trending on social — green is in."

Write to `games/{gameId}/rounds/{round}/marketEmail.body`. **Never reveal exact modifiers, Cold products, or specific demand numbers.**

---

### Conclusion Aggregation

`getConclusion(gameId)` callable. Per-player aggregations:
```
totalRevenue    = Σ revenueGross over all rounds
totalInterest   = Σ interestCharged
totalBorrowed   = Σ amountBorrowed
netRevenue      = totalRevenue − totalInterest − totalBorrowed
budgetRemaining = startingBudget + Σ revenueNet − Σ spent     // can be negative
```

**Final ranking:** order by `netRevenue desc`, tiebreak by `budgetRemaining desc`. Include the winner's full chef roster (base chef + all specialty chefs with portrait variant codes).

Cache the result on `games/{gameId}.conclusion` once `phase === 'game_over'` so re-fetches are cheap.

---

## CSV Output

One row per player per round. **Decision inputs:**

```
round, num_products, sous_chef_count, ad_type,
specialty_chef_1_nationality, specialty_chef_1_skill,
specialty_chef_2_nationality, specialty_chef_2_skill,
specialty_chef_3_nationality, specialty_chef_3_skill,
croissant_qty_stocked, cookie_qty_stocked, bagel_qty_stocked,
sandwich_qty_stocked, coffee_qty_stocked, matcha_qty_stocked
```

**Output results:**

```
revenue, amount_borrowed, interest_charged,
customer_count,
aggregate_satisfaction_pct, chef_satisfaction_score,
croissant_satisfaction_pct, cookie_satisfaction_pct, bagel_satisfaction_pct,
sandwich_satisfaction_pct, coffee_satisfaction_pct, matcha_satisfaction_pct,
croissant_qty_sold, cookie_qty_sold, bagel_qty_sold,
sandwich_qty_sold, coffee_qty_sold, matcha_qty_sold,
sellout_croissant, sellout_cookie, sellout_bagel,
sellout_sandwich, sellout_coffee, sellout_matcha
```

`null` for satisfaction columns of products not offered. `revenue` is **net** (post loan shark deduction). `returning_customers` is shown on the results screen but **excluded from this CSV** per the proposal.

The professor export adds `playerId, bakeryName, displayName` prepended to every row.

---

## Firestore Schema (high level)

```
games/{gameId}
  joinCode, phase, round, phaseEndsAt, status, totalPlayers, professorUid, conclusion?
  config/params  → productPrices, productBaseDemand, productWeights, revenueCoefficients,
                   adBonus, sousChefBaseCost, phaseDurations, startingBudget, playerCap, unitCosts
  preferences/rounds  → 5×6 demand modifier matrix (Cloud Functions only — clients see hint string only)
  rounds/{N}
    chefs[]              → chef pool (specialty field client-read DENIED)
    adWinners            → { tv, radio, newspaper, billboard }
    marketEmail.body     → hint string (client-readable)
    players/{uid}        → per-round result snapshot (mirror of player rounds for aggregate views)
  players/{uid}
    displayName, joinedAt, budgetCurrent (private — server-only writes), creditBalance,
    cumulativeRevenue, specialtyChefs[], sousChefCount, sousChefAssignments,
    returningCustomersPending, pendingRosterAction,
    pendingDecision, pendingBids, lastRoundResult,
    decisions/{round}    → immutable submitted decision snapshot
    rounds/{round}       → per-round result (revenue, sat %, sellouts, borrowed, interest)
  leaderboard/latest     → ranked array (Cloud Function rewrites after each sim)
  csvRows/{playerId}/rounds/{round}  → flattened row matching CSV columns
catalog/chefs            → master roster (variant art specs, name lists, multiplier matrix)
catalog/menuItems        → master product catalog
config/insightTemplates  → market email phrase library
```

**Security:** chef `specialty` fields, the preferences matrix, and any other player's private state are never client-readable. Already-implemented `firestore.rules` cover `players/{uid}` self-only access — extend the same pattern to the new collections.

---

## Open Questions

1. **Timer enforcement:** Backend-enforced timers or professor advances manually? **Recommend manual for MVP**, with `phaseEndsAt` shown in the UI as a soft deadline.
2. **Player cap:** Max players per session? Default 30. Tunable via `config/params.playerCap`.
3. ~~**Disconnection handling:**~~ → ✅ Use last submitted values; if no prior submission, default to zeros. After 2 consecutive missed phases, mark `disconnected: true` (visible in professor panel).
4. ~~**Customer split:** Proportional vs winner-take-most?~~ → ✅ **Proportional, weighted by per-product satisfaction**, per the proposal's two-stage model.
5. **Revenue coefficient final tuning:** Coefficients in the formula are placeholders. Game Design will balance after first end-to-end playtest.
6. ~~**Credit/overdraft cost rate?**~~ → ✅ **Loan shark: borrowed × 1.10 deducted from end-of-round revenue.** No mid-round warnings.
7. ~~**Dynamic staffing escalation curve?**~~ → ✅ **Sous chef cost: 1.0×, 1.5×, 2.25×, 3.0×, +0.75× per additional, applied per-hire-per-round.**
8. **Roster phase always-on vs only-on-overflow:** Currently spec'd as always-shown for ~1 min, mandatory only when specialty chefs > 3. Confirm with Game Design.
9. **Starting budget:** Default $2,000 (placeholder). Game Design to finalize.
10. **Ad bonus values vs revenue formula:** The revenue formula has a `0.8 × ad_spend` term and a separate ad-bonus persistence. Need clarity on whether ad bonus enters revenue as a flat add or only flows through customer attraction → satisfaction → revenue. **Recommend: flat add to revenue (simpler regression target), with foot-traffic effects deferred to post-MVP.**

---

## Defaults Table (until Game Design finalizes)

| Variable | Default |
|---|---|
| Starting budget | $2,000 |
| Sous chef base cost | $50 |
| Sous chef cost curve | 1.0×, 1.5×, 2.25×, 3.0×, +0.75× per additional |
| Loan shark interest rate | 10% (× borrowed amount) |
| Customer pool basis | per-product `baseDemand × roundModifier` |
| Unit cost per product | $1 flat |
| Ad bonus values | TV +$200, Billboard +$150, Radio +$100, Newspaper +$75 |
| Player cap | 30 |
| Round count | 5 |
| Specialty chef cap | 3 |
| Chef Satisfaction floor | 35 |
| Returning customer threshold | Excellent: +15%, Good: +8%, else 0 |
