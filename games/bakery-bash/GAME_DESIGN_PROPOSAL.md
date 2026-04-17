# Game Design Proposal — Bakery Bash

**Date:** April 1, 2026 · Updated April 8, 2026 (all-hands decisions)
**Team:** Game Design (Dylan M. + Mia) · Frontend (AB + Kavin) · Backend (Daniel + Scott + Dylan B.)
**Target Launch:** April 27 or May 1, 2026
**Course:** MGSC 310 · Prof. Frenzel · Chapman University

> This document proposes an MVP-scoped version of Bakery Bash. It is intentionally simplified from the full design deck to maximize the chance of shipping a working game by launch day. Features can be layered on after the core loop works.

---

## Concept

Players run competing grab-and-go cafés in a shared plaza food court. Each round, they set prices for their products, decide how many staff to hire, and bid in auctions for scarce resources (advertisements, highly-rated chefs, etc.) on a fixed budget given at the start of the game. A regression model running on the individual player's computer can be used to help them win. The player with the highest cumulative net revenue across all rounds wins.

Players receive "company emails" between rounds containing sales proceeds, market updates, and news. They export their data as CSV, build predictive models externally (Excel for MGSC 220, Python for MGSC 310), and input decisions back through the UI. There is no in-game model building. The game teaches regression modeling, price elasticity, resource optimization, and competitive strategy through direct experience.

> **Design principle:** Players do NOT see their remaining budget in the UI. They receive revenue reports and sales data each round but must track their own finances externally (Excel, paper, etc.). This is intentional — financial self-management is part of the challenge.

---

## Target Variable

**Revenue** (continuous, in dollars). This is the output of the regression model and the metric students will try to predict. It is computed server-side — players never see the target model coefficients directly.

Revenue must be continuous (not bucketed or categorical) so students can run linear regression on it. Integer is also acceptable — you could round to whole dollars.

---

## Round Structure

5 rounds, approximately 42.5 minutes total including setup and explanation time.

| Phase | Duration | What Happens |
|---|---|---|
| 1. Decide | ~5 min | Players set prices, adjust staffing, and add new menu items based on regression model (+ new data from each round). Timer counts down. |
| 2. Bidding | ~2 min | Players do an advertisements bidding round (1 min) and head chefs bidding round (1 min). |
| 3. Simulate | ~30 sec | Backend runs a regression model, computes revenue, allocates customers. Run a minigame for players to interact with here. |
| 4. Review | ~1 min | Players see results: revenue, customer count, leaderboard update. |
| 4.5. Company Email | — | Players receive an in-game "company email" with sales proceeds, market updates, and news. Data is exportable as CSV for external modeling. |
| 5. Repeat | — | Next round begins. New data row appended to player's dataset. |

---

## Player Decisions (MVP)

Three base decision inputs per round.

| Decision | Input Type | What Player Does | Why It Matters |
|---|---|---|---|
| Quantity | Stock quantity per product | Set quantity for each product | Players must balance the costs of stock input and the expected revenue |
| Average Price | Average price of products | Set average price of store's products | Teaches price elasticity — too high loses customers, too low kills margin |
| Staffing | Integer | Choose how many employees to hire (costs $/round) | Marginal returns — more staff = more throughput but higher costs. **Staffing costs are dynamic** — prices increase each round as demand rises. If all specialists are taken by competitors, they become unavailable. Players who anticipate demand and hire early get rewarded with lower costs. |
| Ad/Chef Bids | $ amount | Choose how much to spend on bidding | Competitive — shared customer pool means ad ROI depends on others' spend |

### Bidding Process

Players have 1 minute to bid each round, sealed auction, highest bidder wins. Players strategize to maximize their expected value.

**Advertisements:** Players bid across 4 different advertisements (TV, radio, newspaper, billboard), each with different optimal prices and varying levels of revenue yield. **Ad auction winners get visual representation in the game** — e.g., if your bakery wins the billboard bid, other players see your bakery's ad on screen next round.

**Chefs:** Players bid across chefs with different skill levels (RNG). Each skill level yields different levels of revenue output.

### Menu Items

**Base:** Croissant, Cookie, Bagel

**Option to add new menu item + quantity of stock each round.**

**New item selection:** Sandwich, Latte, Matcha Latte — six products, six price inputs total.

---

## Scoring System

**Primary metric:** Cumulative net revenue across all rounds. One number, one leaderboard. Clear winner.

**Secondary metric (tiebreaker):** Average customer satisfaction. Displayed but not the primary ranking criterion.

**Two separate UIs:**
1. **Student-facing UI** — simplified: login, decision inputs, leaderboard, company emails. No budget tracker, no model building tools.
2. **Professor / Live Ops UI** — full visibility: market share, all player data, AI bot controls, dynamic pricing levers. Scott and Dylan B. will run the control room on game day.

---

## Competitive Dynamics

### How Players Compete

The shared customer pool is the core competitive mechanism. Each round, a finite number of customers are distributed across all cafés based on an attractiveness score. The score is a function of:

- **Pricing** — competitive prices attract more budget-conscious shoppers
- **Product variety** — more menu items = broader appeal
- **Staff count** — more staff = faster service = less churn
- **Ad spend** — directly increases foot traffic share

This is zero-sum at the margin — players have to adopt different strategies to stand out.

### Preventing Dominant Strategy

Three mechanisms:

1. **Model noise** — a random component in revenue computation means the "optimal" inputs shift slightly each round
2. **Competitive allocation** — your revenue depends on what others do, not just your own decisions. There's no fixed optimal strategy.
3. **Information asymmetry** — players only see their own data. They can observe the leaderboard but not competitors' decisions. This prevents pure copycat strategies.

---

## Data Requirements

After each round, players receive a downloadable CSV of new rows. Players accumulate data over rounds and can download it as CSV/XLSX to build models in their own environment.

| Column | Type | Description |
|---|---|---|
| day | int | Round number (1, 2, 3…) |
| revenue | float | TARGET VARIABLE — total revenue for the round ($) |
| num_products | int | Number of products on your menu that round |
| avg_price | float | Mean sell price across all menu items ($) |
| staff_count | int | Total employees hired |
| ad_spend | float | Dollars allocated to advertising |
| customer_count | int | Customers who visited your café |
| customer_satisfaction | float | Customer satisfaction score (0–100) |
| headchef_skill | int | Chef skill level (0–100) |
| croissant | char | Quantity sold |
| cookie | char | Quantity sold |
| bagel | char | Quantity sold |
| sandwich | char | Quantity sold |
| latte | char | Quantity sold |
| matcha_latte | char | Quantity sold |
| ad_type | char | Type of ad (TV, mall, etc.) |

### Dataset Structure

Time series × multiple bakeries. Example:

```
Day 1  Bakery A  [feature inputs…]
Day 1  Bakery B  [feature inputs…]
Day 2  Bakery A  [feature inputs…]
Day 2  Bakery B  [feature inputs…]
```

Students can run a regression in Excel or Python using the set variables. Players are intended to receive the CSV file 1 week in advance to prep their models for gameplay.

**Backend deliverable:** a CSV containing the player's new data after each round iteration.

---

## MVP Scope — What Must Work for Launch

Minimum set of features needed to play one complete game session. Everything below must work. Everything above the cut line is a bonus.

- [ ] 1 — Player joins a game session (simple auth + lobby screen)
- [ ] 2 — Player builds their bakery: set budget, current staff, menu, prices
- [ ] 3 — For each new round: player sets prices, staff count, and ad spend
- [ ] 4 — Player submits decisions before timer expires
- [ ] 5 — Backend runs regression model → computes revenue + customer allocation
- [ ] 6 — Player sees round results + leaderboard ranking
- [ ] 7 — Player downloads their new data as CSV
- [ ] 8 — Repeat for 5 rounds
- [ ] 9 — Professor can start, advance, pause, and end the game

---

## Deferred from Design Deck

The following features from the original design deck are cut from v1. They can be added incrementally after the core loop works and is stable. This is not a rejection of these ideas — it's a sequencing decision.

| Feature | Why Cut from v1 | Add Back If Time? |
|---|---|---|
| 3 sealed-bid auctions | 2–3 days of BE + FE work; simplify to flat ad spend | Yes — high impact |
| Employee poaching | Complex real-time flow; requires notifications, counter-offers | Maybe — Phase 2 |
| Employee tiers & satisfaction | Replace with simple headcount; keeps model simpler | Maybe |
| 6 curveball types | Each needs custom logic; start with 0, add 1–2 if time | Yes — 1 or 2 |
| AI competitors (3 tiers) | Each tier needs heuristic logic; skip for v1 | Maybe — Passive only |
| In-game chat + achievements | Non-essential; use Discord/Slack | No |
| Supplier product drops | Adds complexity to menu system; use fixed products | No |
| Equipment upgrade tiers | Simplify to binary or remove; reduces decisions | Maybe |
| 12 products | Reduce to 5–6; fewer price inputs, simpler UI | Cosmetic — easy to add back |

---

## Regression Model — Starter Coefficients

Backend needs concrete coefficients to build the revenue engine. Placeholder model to start coding against. Game Design should refine these based on the professor's dataset and balance testing.

```
revenue = 500
        + (30 × staff_count)
        − (15 × avg_price)
        + (0.8 × ad_spend)
        + (50 × num_products)
        + noise
```

- Base revenue of $500/round just for being open
- Each employee adds ~$30 of revenue (diminishing returns not modeled yet)
- Higher avg prices reduce customer volume (price elasticity)
- Ad spend has positive but sub-linear return
- More menu items attract more customers
- Noise term: random uniform ±$100 to prevent deterministic optimization

> ⚠️ These are PLACEHOLDER coefficients. Backend will code against this structure and swap in final values.

---

## Starting Conditions (Confirmed — All-Hands April 8)

Same starting point for everyone. Same base-level staff, same menu, same budget. No advantages at the start. Differentiation comes purely from decisions made during the game.

## Budget Rules (Confirmed — All-Hands April 8)

- Budget is set at a fixed amount (TBD — exact number to be finalized).
- Players spend across products, marketing, and staffing.
- **Overbidding is allowed** — players can exceed their budget but take on credit at a cost.
- No in-game budget tracker. Players must manage their own finances externally.
- No hand-holding on financial tracking.

## Open Questions

1. **Customer allocation formula:** How exactly are customers split? Proportional to attractiveness score? Winner-take-most?
   → *Should be determined by customer satisfaction*

2. ~~**Starting conditions:** Does everyone start identical (same budget, same menu, same staff)? Or is there variation?~~
   → ✅ **Resolved:** Everyone starts the same. Same base-level staff, same menu, same budget. (All-hands April 8)

3. ~~**Budget replenishment:** Do players get new budget each round, or is it cumulative from revenue? If cumulative, early mistakes compound — is that intended?~~
   → ✅ **Resolved:** Cumulative. Overbidding allowed with credit at a cost. (All-hands April 8)

4. **Which ONE feature from the cut list is highest priority if we have extra time?**
   → Recommend: 1 simple curveball event OR passive AI competitor, not both.

5. **Exact starting budget amount?** — Needs to be finalized.

6. **Credit cost rate?** — What interest/penalty applies when players overbid beyond their budget?

7. **Staffing price escalation curve?** — How much do staffing costs increase per round? Linear, exponential?

---

## Next Steps

| Date | Task | Owner |
|---|---|---|
| April 3 | Game Design delivers final game config doc (all numbers, coefficients, starting conditions, budget rules) | Game Design |
| April 3 | Game Design + Backend agree on Firestore schema | Game Design + Backend |
| April 4 | Backend starts building auth + round state machine | Backend |
| April 4 | Frontend starts building lobby + decision dashboard | Frontend |
| April 10 | First end-to-end playable demo — one round, ugly, but functional | All |
