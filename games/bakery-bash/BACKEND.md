# Bakery Bash — Backend Spec

**Team:** Scott + Dylan B. (Daniel departed — April 19, 2026)
**Last Updated:** April 19, 2026 — aligned to GAME_DESIGN_PROPOSAL.md (April 19 Team Roles update)

> **Source of truth:** [GAME_DESIGN_PROPOSAL.md](./GAME_DESIGN_PROPOSAL.md). Anything in this spec that conflicts with the proposal is wrong — fix the spec, not the proposal.

---

## API Surface

> **Role-gated callables (April 19 update, DEC-21):** `submitDecision`, `submitBids` (split into ad/chef), `layoffChef`, and `continueFromRoster` check the caller's `role` on `players/{uid}` before accepting. Operations owns Decide; Advertising owns Ad bids; Finance owns Chef bids + roster. Solo / incomplete teams get fallback: a single player with no teammates owns all three buttons. See `Team Roles & Access` in GAME_DESIGN_PROPOSAL.md.

```
/api/game/create        → Professor creates session (createGame onCall)
/api/game/join          → Player joins session (joinGame onCall — already implemented; accepts teamName + role)
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

### Per-Product Dynamic Pricing (POST-01)

Implemented in `functions/modules/pricing.js` and `functions/modules/config.js::PRICE_ZONES`.

The Finance role submits per-product prices via the `submitPrices` callable. Prices are validated and written to `players/{uid}/decisions/round_N.productPrices` by Admin SDK (bypasses Firestore client rules).

#### Price Zones

Each product has a `PRICE_ZONES` entry with a floor, competitive range, premium range, and ceiling. Prices snap to a $0.25 grid and are clamped to `[floor, ceiling]` before the simulation runs.

| Zone | Range | Effect |
|---|---|---|
| Floor | `[floor, competitiveRangeLow)` | +15% demand bonus (`FLOOR_BONUS = 0.15`) |
| Competitive | `[competitiveRangeLow, premiumRangeLow)` | Baseline demand |
| Premium | `[premiumRangeLow, ceiling]` | Negative elasticity only |

#### Demand Multiplier Formula

```
competitiveMid = (competitiveRangeLow + competitiveRangeHigh) / 2
pctΔP = (price − competitiveMid) / competitiveMid
elasticityEffect = −elasticityCoeff × pctΔP
multiplier = max(0.1, 1 + floorBonus + elasticityEffect)
```

Elasticity coefficients by tier: `high = 1.5`, `medium = 1.0`, `low = 0.6`.

| Product | Floor | Ceiling | Elasticity |
|---|---|---|---|
| Coffee | $2.00 | $6.50 | high |
| Croissant | $2.50 | $8.00 | medium |
| Bagel | $1.50 | $5.50 | high |
| Cookie | $1.00 | $5.00 | high |
| Sandwich | $5.00 | $14.00 | medium |
| Matcha | $3.50 | $10.00 | low |

#### Carry-Over Logic

If a player does not submit prices for a product this round, the simulation carries over the most recent prior submission for that product. If no prior submission exists, the catalog `fixedPrice` is used. This is handled by `resolvePriceForSim()` in `pricing.js`.

#### Revenue

`calculateProductRevenue` in `revenue.js` accepts an optional `productPrices` map. When present, each product's price is taken from the map (falling back to catalog for missing or invalid entries).

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

> **April 19 update:** CSV rows are now **one per team per round** (not per player), since financial state is shared across a team. Each row still carries both `teamId` and the submitting `playerId`+`role` per phase, so regression work can still partition by individual when useful.

One row per team per round. **Decision inputs:**

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

The professor export adds `teamId, teamName?, member_operations_uid, member_advertising_uid, member_finance_uid` prepended to every row. `teamName` is blank when the team chose not to set one (DEC-23).

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
  teams/{teamId}         → name? (optional — DEC-23), memberUids[], createdAt (April 19, DEC-21)
                           Financial state (budgetCurrent, cumulativeRevenue, specialtyChefs[], etc.)
                           lives on the TEAM doc, not per-player, once a team is formed.
  players/{uid}
    displayName, joinedAt, teamId, role: "finance"|"advertising"|"operations"|"solo",
    pendingDecision, pendingBids, lastRoundResult,
    decisions/{round}    → immutable submitted decision snapshot (mirrors team decision)
    rounds/{round}       → per-round result (revenue, sat %, sellouts, borrowed, interest)
                           (mirror of team rounds for player CSV export)
  leaderboard/latest     → ranked array of TEAMS (Cloud Function rewrites after each sim)
  csvRows/{teamId}/rounds/{round}  → flattened row matching CSV columns, one per team per round
catalog/chefs            → master roster (variant art specs, name lists, multiplier matrix)
catalog/menuItems        → master product catalog
config/insightTemplates  → market email phrase library
```

**Security:** chef `specialty` fields, the preferences matrix, and any other team's private state are never client-readable. `players/{uid}` remains self-only. Teammates read the shared `teams/{teamId}` doc (members list + team name). Extend existing rule patterns to the new `teams` and `config/teamNameWords` collections.

### Role Validation (DEC-21)

Role ownership map for callables:

| Callable | Role Required (on 3-person team) | Fallback |
|---|---|---|
| `submitDecision` | `operations` | On teams < 3, any member whose role includes `operations` (solo player = all roles). |
| `submitBids` (ad payload) | `advertising` | Same fallback rule. |
| `submitBids` (chef payload) | `finance` | Same fallback rule. |
| `layoffChef`, `continueFromRoster` | `finance` | Same fallback rule. |

Reject mismatched callers with `permission-denied`. The `role` field on `players/{uid}` is written once by `joinGame` and not editable by the player.

---

## Open Questions

1. ~~**Timer enforcement:**~~ → ✅ **Professor-manual advance** (DEC-07). `phaseEndsAt` is a UI-only soft deadline.
2. ~~**Player cap:**~~ → ✅ **20 per game for launch** (DEC-12). Schema must support 50.
3. ~~**Disconnection handling:**~~ → ✅ Use last submitted values; if no prior submission, default to zeros. After 2 consecutive missed phases, mark `disconnected: true` (visible in professor panel).
4. ~~**Customer split:** Proportional vs winner-take-most?~~ → ✅ **Proportional, weighted by per-product satisfaction**, per the proposal's two-stage model.
5. **Revenue coefficient final tuning:** Coefficients in the formula are placeholders. Tune after INT-06 playtest. Flat terms will need ~250× scale-up to feel meaningful on a $500k budget — DEC-13 acknowledges this.
6. ~~**Credit/overdraft cost rate?**~~ → ✅ **Loan shark: borrowed × 1.10 deducted from end-of-round revenue.** No mid-round warnings.
7. ~~**Dynamic staffing escalation curve?**~~ → ✅ **Sous chef cost: 1.0×, 1.5×, 2.25×, 3.0×, +0.75× per additional, applied per-hire-per-round.**
8. ~~**Roster phase always-on vs only-on-overflow:**~~ → ✅ **Always shown ~1 min** (DEC-05), mandatory only when specialty chefs > 3.
9. ~~**Starting budget:**~~ → ✅ **$500,000** "investor capital" (DEC-01).
10. ~~**Ad bonus values vs revenue formula path:**~~ → ✅ **Flat add to revenue** (DEC-03). Values: TV $50k / BB $37.5k / Radio $25k / Newspaper $18.75k (DEC-04).
11. ~~**Sous chef hire phase authority:**~~ → ✅ **Decide phase only** (DEC-02). Roster phase displays them read-only.

---

## Defaults Table (LOCKED — April 17, 2026)

These values are finalized per `projectRoadmap.md` DEC-01..DEC-18. Any change requires design-review sign-off.

| Variable | Locked Value | Source |
|---|---|---|
| Starting budget | **$500,000** ("investor capital" narrative) | DEC-01 |
| Sous chef base cost | **$12,500** | DEC-14 |
| Sous chef cost curve | 1.0×, 1.5×, 2.25×, 3.0×, +0.75× per additional | Proposal |
| Chef minimum bid — Novel | **$25,000** | DEC-15 |
| Chef minimum bid — Intermediate | **$43,750** | DEC-15 |
| Chef minimum bid — Advanced | **$68,750** | DEC-15 |
| Loan shark interest rate | 10% | DEC-16 |
| Customer pool basis | per-product `baseDemand × roundModifier` | Proposal |
| Unit cost per product (supply) | **$1 flat** (NOT scaled — preserves margin given fixed sell prices) | DEC-18 |
| Product sell prices | Proposal values (Coffee $4, Croissant $4.75, Bagel $3, Cookie $2.50, Sandwich $8.75, Matcha $6.25) | DEC-17 |
| Ad bonus — TV | **$50,000** | DEC-04 |
| Ad bonus — Billboard | **$37,500** | DEC-04 |
| Ad bonus — Radio | **$25,000** | DEC-04 |
| Ad bonus — Newspaper | **$18,750** | DEC-04 |
| Ad bonus path into revenue | Flat add to revenue (not via foot traffic) | DEC-03 |
| Player cap | **20 per game** for launch; schema must support **50** | DEC-12 |
| Round count | 5 | Proposal |
| Specialty chef cap | 3 | Proposal |
| Chef Satisfaction floor | 35 | Proposal |
| Returning customer threshold | Excellent: +15%, Good: +8%, else 0 | Proposal |
| Sous chef hire phase | Decide phase only; Roster phase shows read-only | DEC-02 |
| Roster phase cadence | Always shown ~1 min; mandatory if specialty chefs > 3 | DEC-05 |
| Timer enforcement | Professor-manual advance; `phaseEndsAt` is UI-only | DEC-07 |
| Market email delivery | Full-screen route `/game/email` | DEC-08 |

> **Margin note:** Sell prices + unit supply cost are NOT scaled with the starting budget. The "big money" is operational (staffing, chef bids, ads). Supply costs stay trivial so margins on sales remain positive. Revenue-formula flat coefficients (base $500, agg-sat ×$8, etc.) are placeholder — they'll need ~250× scale-up during INT-06 tuning to make sales-driven revenue competitive with staffing spend.
