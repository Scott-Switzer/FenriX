# Bakery Bash — Balance Audit & Fixes (2026-04-24)

## TL;DR

Ran ~10,000 simulated 5-round games across 15 strategies in 3-, 4-, and 6-team
configurations. The pre-balance config had **catastrophic dominant-strategy
exploits** — bidding on ads alone netted +$475k profit (95% of starting budget)
in 100% of games while every engaged play strategy lost money. Applied 11
balance passes targeting 9 root causes; the post-balance config has all 4
chef nationalities winning 67–69% of games at $24–26k profit each (within 7%
of each other), with no exploitable arbitrage.

| Metric | Pre-balance | Post-balance |
|---|---|---|
| Top profit | +$475k (AdSpam) | +$30k (PremiumMenu) |
| Top vs bottom engaged-play spread | $1.78M | $6k |
| Single dominant strategy win rate | 100% | 73% |
| Nationality-specialty profit range | $0–$36k (∞ skew) | $24–26k (~7%) |
| Engaged play profitable? | No (all lose) | Yes (all 4 nationalities profit) |
| Doing nothing wins? | Yes (88% win rate) | No (12% win rate) |

The full analysis, per-issue breakdown, and what each fix changed are below.

---

## Methodology

Built a Node.js simulation harness ([backend/scripts/balance/](backend/scripts/balance/))
that runs the pure simulation modules directly (no Firebase). The harness
bypasses the emulator for speed — full tournaments of 4,500 games run in ~1
second versus ~10 minutes through Firebase.

**Test components:**
- [backend/scripts/balance/harness.js](backend/scripts/balance/harness.js) —
  Multi-team multi-round game runner with per-game shuffled round preferences
  and randomized team-order to eliminate harness biases.
- [backend/scripts/balance/strategies.js](backend/scripts/balance/strategies.js) —
  15 strategies covering nationality stacks, premium/cheap menus, ad
  arbitrage, sous chef extremes, loan abuse, trend chasing, and minimalism.
- [backend/scripts/balance/run-tournament.js](backend/scripts/balance/run-tournament.js) —
  Round-robin: every triple of strategies plays N reps, then we aggregate
  win-rate and avg-profit per strategy.
- [backend/scripts/balance/probes.js](backend/scripts/balance/probes.js) +
  [probes-deep.js](backend/scripts/balance/probes-deep.js) — Targeted probes
  testing specific exploit theories (ad arbitrage, nationality dominance,
  sous chef sweet spot, foot-traffic max, etc.).
- [backend/scripts/balance/multi-team-test.js](backend/scripts/balance/multi-team-test.js) —
  Confirms balance holds at 2, 4, and 6 teams.
- [backend/scripts/balance/trace.js](backend/scripts/balance/trace.js) — End-
  to-end math tracing of one round; verified that simulation output matches
  hand-computed expectations from the spec formulas.

**Verification:** trace.js confirms revenue formula, cost calculation, output
math (base + specialty + sous), satisfaction tier mapping, and customer
allocation all produce numerically correct results to within $50 noise.

---

## Issues Found, Severity, and Fixes

Issues are ranked by severity. CRITICAL means a single dominant strategy. HIGH
means a strong dominant tendency. MEDIUM means a balance imbalance that
shifts but doesn't dominate. The columns are:

- **Issue** — what was wrong
- **Mechanic** — exactly which formula/parameter caused it
- **Probe data** — observed effect in simulations
- **Fix** — what we changed
- **Result** — observed effect after fix

### 1. CRITICAL — Ad-spend revenue arbitrage

| Field | Detail |
|---|---|
| Issue | Bidding more on ads added more revenue than it cost. |
| Mechanic | `revenueCoefficients.adSpendCoeff = 0.8` meant every $1 bid on ads added $0.80 to gross revenue. Stacked with the $50k TV winner bonus (paid even when no one else competed), the AdSpam strategy guaranteed +$106k profit per round just from ad bids. |
| Probe data | AdSpam strategy: 100% win rate, +$475k profit (vs starting $500k). All other strategies lost $200k–$1.3M. |
| Fix | [config.js:179-198](backend/functions/modules/config.js) — set `adSpendCoeff: 0.8 → 0`. Also halved ad winner bonuses (TV $50k → $20k, Billboard $37.5k → $12.5k, Radio $25k → $7.5k, Newspaper $18.75k → $4k) so winning ads is a moderate edge, not free money. |
| Result | AdSpam now 0% win rate, -$393k loss. Strategy fully dominated. |

### 2. CRITICAL — Engaged play universally unprofitable

| Field | Detail |
|---|---|
| Issue | Every strategy that hired chefs, sous chefs, or stocked beyond minimum LOST money. Doing nothing was the optimal play. |
| Mechanic | Three compounding causes: (a) demand pool was 305 customers/round across all 6 products — too small to support meaningful product revenue; (b) sous chefs cost $12,500 base × escalating curve = $96,875 for 4 sous chefs (19% of starting budget) per round; (c) specialty chef bids floored at $25k–$68.75k against minimal output benefit. |
| Probe data | Every nationality stack lost $200k–$1.3M. Minimalist (no chefs, no sous, no ads) won 88% of games. |
| Fix | (a) [config.js:33-72](backend/functions/modules/config.js) — bumped `baseDemand` 4× (305 → 1320 customers/round), so product sales are the dominant revenue source. (b) [config.js:182-194](backend/functions/modules/config.js) — `sousChefBaseCost: $12,500 → $500`. 4 sous chefs now cost $3,875 (was $96,875). (c) Chef bid floors auto-rescaled via `MIN_BID_FLOOR_MULTIPLIERS × sousChefBaseCost`: novel $1k, intermediate $1.75k, advanced $2.75k (was $25k/$43.75k/$68.75k). |
| Result | Engaged play is now profitable. All 4 nationality stacks profit $24–26k. Minimalist drops to 12.5% win rate, $4k profit. |

### 3. CRITICAL — French chef nationality structurally dominant

| Field | Detail |
|---|---|
| Issue | French chef won 100% of nationality-vs-nationality games. The user explicitly named this — "get a certain nationality of chef" being a winning move. |
| Mechanic | Two compounding causes: (a) French specialty pair (croissant + coffee) had highest summed demand (60 + 70 = 130) vs Japanese (matcha 25 + croissant 60 = 85) and others; (b) coffee had `satisfactionWeight: 1.5` (highest of any product), boosting French/Italian aggregate satisfaction; (c) team-order tiebreak in ad auctions consistently favored strategies named earlier in the lobby tuple. |
| Probe data | French: 100% win in nationality showdowns (-$605k loss vs others -$1.2M). After demand bump: still 92.9% win, $36k profit (vs American $17k). |
| Fix | (a) [config.js:33-58](backend/functions/modules/config.js) — equalized `baseDemand` to 200–240 across all products; specialty pairs now total 440–480 within ±5%. (b) [config.js:39](backend/functions/modules/config.js) — equalized `satisfactionWeight: 1.0` for all products (was coffee 1.5, croissant 1.2, matcha 1.3). (c) [config.js:33-72](backend/functions/modules/config.js) — bumped bagel/cookie default prices from $3/$2.50 to $4.50/$4.00 (with matching zone shifts) so American's per-customer revenue ($8.50) approximates French's ($8.75). (d) [run-tournament.js:90-100](backend/scripts/balance/run-tournament.js) — randomized team order per game to remove the harness ad-auction tie bias. |
| Result | All 4 nationality stacks within 7% of each other: French $24.5k, Japanese $26k, Italian $25.6k, American $24.4k. Win rates 67–69% each (no statistical separation). |

### 4. HIGH — Sous chef stacking exploit / cohesion cliff

| Field | Detail |
|---|---|
| Issue | At the original `chefSatisfactionDecay: 16`, going from 4 to 5 sous chefs dropped throughput by 16%, making 4 the only correct count and 5+ a brick wall. Combined with high per-chef cost, hiring 8 sous chefs lost $9.3M. |
| Mechanic | `chefSatisfactionScore = max(floor, 100 - max(0, n - 4) × 16)`. At decay 16: 5 sous = 84%, 6 = 68%, 7 = 52%, 8 = 36%, 9+ = 35% (floor). The drop is too steep for 5 to ever beat 4 economically. |
| Probe data | SousChefStacker (8 sous): 0% win rate, -$9.3M loss. |
| Fix | [config.js:225-235](backend/functions/modules/config.js) — `chefSatisfactionDecay: 16 → 10`. Now 5 = 90%, 6 = 80%, 8 = 60%, 10 = 40%. Smoother slope rewards moderate overstaffing in late rounds when demand is high. |
| Result | SousChefStacker still loses (-$62k) but no longer catastrophically. The cohesion penalty + escalating cost still makes 5+ sous strictly suboptimal vs 4, just not crushingly so. |

### 5. HIGH — Premium products dominate cheap products

| Field | Detail |
|---|---|
| Issue | Sandwich at $8.75 and matcha at $6.25 with the same demand pool meant a "premium menu" earned 3.5× more per customer than a cheap menu, and there was no offsetting cost or demand penalty — a player offering matcha + sandwich + croissant + coffee won 95% of games even after fixing the ad arbitrage. |
| Mechanic | Per-product revenue = baseDemand × fixedPrice. Sandwich (45 × $8.75 = $394) vs cookie (50 × $2.50 = $125) — sandwich earned 3.2× more. Same chef boost benefits both equally, so specialty multiplier didn't help cheap products catch up. |
| Probe data | After fixing #1 and #2, premiumMenu: 95% win rate, +$9.8k profit (vs nationality stacks at break-even). |
| Fix | [config.js:25-34](backend/functions/modules/config.js) — sandwich $8.75 → $5.50, matcha $6.25 → $4.50; matching `PRICE_ZONES` updated so the new defaults sit at competitive mid (no elasticity penalty). Also bumped sandwich/matcha to "high" elasticity tier (was medium/low) so setting them at premium prices now strongly punishes customer share. |
| Result | premiumMenu still wins 73% but profit only $30k vs nationality $24–26k. PremiumMenu is now an *adaptive* strategy (pick best chef for offered products) rather than a *dominant* strategy — a smart player who diversifies will outperform a nationality-locked player by ~20%, which is reasonable for skill expression. |

### 6. HIGH — Specialty chef purchases never broke even

| Field | Detail |
|---|---|
| Issue | An advanced French chef cost $68,750 (5.5 × $12,500 base) and added ~36 units/day on each of 2 specialty products. With the original tiny customer pool (305), that ~36 extra capacity could only translate to a few hundred dollars in additional revenue — chefs lost ~$60k each over a 5-round game. |
| Mechanic | Min bid floor multipliers × sousChefBaseCost. With base $12,500: novel $25k, intermediate $43.75k, advanced $68.75k. Output uplift formula: 30 × (specialty multiplier - 1) units/day = 30 × 1.2 = 36 extra/day for advanced specialty. With customer pool ~100/team/round at $4 avg, max additional revenue from one chef is ~$200/round. |
| Probe data | BuyAdvancedChef vs NoChef in 3-team game: nearly identical losses (-$438k vs -$478k). Chef provides ~$40k of value over 5 rounds, costs $68.75k. Net -$28.75k per chef. |
| Fix | (a) `sousChefBaseCost: $12,500 → $500` (Issue #2) cascades to chef floors via `MIN_BID_FLOOR_MULTIPLIERS`: novel $1k, intermediate $1.75k, advanced $2.75k. (b) [config.js:127-141](backend/functions/modules/config.js) — bumped `CHEF_MULTIPLIERS` so advanced specialty is 3.0× (was 2.2×). An advanced specialty chef now produces 90 units/day vs 30 base — clear differentiation. |
| Result | Chefs are now affordable and noticeably impactful. Buying chefs is the meta — every profitable strategy in the round-robin uses them. |

### 7. MEDIUM — Ads had no effect on customer count

| Field | Detail |
|---|---|
| Issue | The original system rewarded ad winners with cash bonuses but didn't actually *bring more customers*. Ads were just a money-printing dial (when combined with the broken `adSpendCoeff`), not a marketing tool. The foot-traffic modifier ignored ad wins entirely. |
| Mechanic | `getFootTrafficModifier` only considered satisfaction, premium products, variety, and sous chefs. Ad wins didn't enter the customer-allocation math. |
| Probe data | Across all probes, ad bidding affected revenue only via the formula coefficient and winner bonus — never via customer count. |
| Fix | [config.js:200-209](backend/functions/modules/config.js) — added `adFootTrafficBonuses: { TV: 0.15, Billboard: 0.10, Radio: 0.05, Newspaper: 0.025 }`. [satisfaction.js:200-260](backend/functions/modules/satisfaction.js) — `getFootTrafficModifier` now accepts `adWins` + `cfg` and adds the per-ad-type foot-traffic boost (capped at +30% total). [simulation.js:325-334](backend/functions/modules/simulation.js) — wires `adWins` through to the foot-traffic call. |
| Result | Winning TV now brings customers (+15% foot traffic) AND a smaller cash bonus ($20k). Ads function as marketing, not money-printing. |

### 8. MEDIUM — Premium-product foot-traffic bonus biased nationality choice

| Field | Detail |
|---|---|
| Issue | The foot-traffic bonus gave +10% per "excellent" satisfaction on **croissant or matcha specifically**, stackable for +20%. This bias favored French (croissant specialist) and Japanese (matcha + croissant specialist) over Italian and American. |
| Mechanic | [satisfaction.js (old)](backend/functions/modules/satisfaction.js) — `for (const product of ['croissant', 'matcha'])` hardcoded the two products. |
| Probe data | French and Japanese both got +20% foot traffic from premium bonus when their specialty products hit excellent. Italian (sandwich + coffee) and American (bagel + cookie) got 0. |
| Fix | [satisfaction.js:208-217](backend/functions/modules/satisfaction.js) — premium product bonus now applies to *any* product at excellent (+6% each, stackable up to +36% for full menu). |
| Result | Bonus is now product-agnostic. American/Italian get the foot-traffic boost when they hit excellent on bagel/sandwich, just like French does on croissant. |

### 9. LOW — Newspaper bonus was free money for any non-zero bid

| Field | Detail |
|---|---|
| Issue | Newspaper paid $18,750 to whoever won the auction. Minimum bid was $1. If no one else bid, you got $18,750 for $1 — pure free money. |
| Mechanic | `adBonuses.Newspaper: 18750` and no minimum-bid scaling. |
| Probe data | This was rolled into the AdSpam exploit (#1), but even without ad-spam, a single-Newspaper-bid strategy yielded +$18.7k in any uncontested round. |
| Fix | (a) Newspaper bonus reduced to $4,000 (Issue #1). (b) Newspaper foot-traffic bonus is +2.5% (Issue #7) — a cheap ad with a small benefit, suitable for budget-conscious teams. |
| Result | Cheap-ad strategies still viable but no longer crushing. |

---

## Final Tournament Results

After all 11 balance passes, with shuffled team order and shuffled round
preferences (20 reps × 455 lobbies = 9,100 games per strategy):

| Strategy | Win % | Avg Rank | Avg Profit | Notes |
|---|---|---|---|---|
| premiumMenu | 72.9% | 1.37 | $30,407 | Adaptive (picks best chef from any nationality) — modestly above pure nationality |
| japaneseStack | 68.7% | 1.43 | $26,025 | |
| italianStack | 67.5% | 1.45 | $25,610 | |
| frenchStack | 68.7% | 1.45 | $24,492 | |
| americanStack | 68.4% | 1.45 | $24,405 | All 4 nationalities clustered within 7% |
| trendChaser | 41.4% | 1.82 | $14,850 | Adapts to round preferences but doesn't lock in a nationality |
| loanAbuser | 34.9% | 1.78 | $13,053 | Borrows R1 to bulk-buy chefs — modest edge |
| baseline | 12.6% | 2.22 | $5,435 | 3 base products, 2 sous, no chefs — survives but doesn't excel |
| minimalist | 11.7% | 2.03 | $3,840 | Do nothing — break even at best |
| ceilingPricing | 11.3% | 2.36 | $3,478 | Penalty applies in mixed lobbies (other teams stay competitive) |
| fullMenuBalanced | 15.4% | 2.06 | $2,477 | 6 products spreads sous too thin |
| noAdGhost | 9.5% | 2.34 | -$6,344 | Skipping ads gives up real foot-traffic + cash |
| floorPricing | 10.3% | 2.55 | -$7,637 | Too-low margin overwhelms demand boost |
| sousChefStacker | 6.8% | 2.69 | -$56,888 | Cohesion penalty + escalating cost punishes 8+ sous |
| adSpam | 0.0% | 3.00 | -$393,002 | Arbitrage closed; bidding $123k/round on ads is now ruin |

**Spread among "engaged play" strategies (top 5): $24,405–$30,407 = 24% range.**
**Spread among 4 nationalities: $24,405–$26,025 = 6.6% range.**

---

## Multi-Team Configurations

Verified balance holds at 2, 4, and 6 teams:

**2-team (French vs American, 50 reps):**
- frenchStack: 44.0% wins, $15,447 avg profit
- americanStack: 56.0% wins, $20,563 avg profit
- *American slightly favored when 2-team and not contested by Italian/Japanese.*

**4-team (4 nationalities, 50 reps):**
- frenchStack: 30%, $3,683
- japaneseStack: 26%, $5,526
- italianStack: 20%, $2,544
- americanStack: 24%, $690
- *4-team: tighter competition (more contention for finite pool), all profits compressed to ±$5k. No nationality dominates.*

**6-team (4 nationalities + premium + baseline, 50 reps):**
- premiumMenu: 28%, $2,312
- italianStack: 20%, $248
- japaneseStack: 18%, -$277
- americanStack: 18%, -$2,824
- frenchStack: 16%, -$3,952
- baseline: 0%, -$4,310
- *6-team: nearly perfect spread. Italian slightly leads, French at the bottom — the role inverts as competition increases.*

---

## What I Did Not Change (and why)

- **Chef nationality theme** (French = croissant + coffee, etc.). Thematically
  meaningful and didn't need to change. Balance was achieved through
  product-pricing and demand tuning instead.
- **5 round structure / round preference templates** — the 5 themed-round
  rotation (neutral / coffee / premium / american / sandwich) is part of the
  game design. I shuffled the order per game in the harness so probes don't
  bias toward whichever theme fires first, but the templates themselves are
  unchanged.
- **Loan shark interest (10%)** — works fine. LoanAbuser strategy is
  marginally profitable, neither dominant nor punished.
- **Returning-customer bonus** (15% / 8% for excellent / good satisfaction) —
  small enough effect that it doesn't need rebalancing.
- **Burglary curveball** — gated by cleanliness threshold, doesn't fire often
  enough in normal play to affect balance probes.
- **Sellout cap** at satisfaction 45 — works as intended; oversupplying for
  sellout protection is a real strategic choice.

---

## What Could Still Be Tuned (low priority)

These are observations from the data, not problems:

1. **Adaptive strategies (premiumMenu) edge nationality stacks by ~20%.** A
   player who picks the best chef for their menu (instead of locking in a
   nationality) does better. This is *good design* — rewards skill — but
   could be tightened if you want pure nationality lock to be optimal.

2. **Ad-winner cash bonus + foot-traffic bonus stack.** Winning TV gives both
   $20k cash AND +15% foot traffic. Could split into either-or if it's too
   strong, but probe data shows it's not currently exploitable.

3. **Floor pricing strategy still loses (-$7k).** The +15% floor demand bonus +
   elasticity multiplier doesn't compensate for halving per-customer revenue.
   Could increase the floor bonus from 0.15 to 0.25, but again — players
   choosing this can sometimes win in mixed lobbies, just not in expectation.

4. **Cohesion penalty** at 5+ sous chefs is now smooth (decay 10) but still
   makes 4 the optimal count. If you wanted true variability — making 5 or 6
   sous viable in some round-preference scenarios — you could go lower (decay
   6) but that risks late-game sous-stacking exploits.

---

## Files Changed

- [backend/functions/modules/config.js](backend/functions/modules/config.js) —
  All balance constants. Each section has an explanatory comment naming the
  pass and the data motivating the change. ~80 lines of changes.
- [backend/functions/modules/satisfaction.js](backend/functions/modules/satisfaction.js) —
  `getFootTrafficModifier` now product-agnostic (premium bonus per any
  excellent) and accepts ad wins + cfg for ad foot-traffic effect.
- [backend/functions/modules/simulation.js](backend/functions/modules/simulation.js) —
  Wires `adWins` and `cfg` through to `getFootTrafficModifier`.

## Files Added (test infrastructure, not shipped)

- [backend/scripts/balance/harness.js](backend/scripts/balance/harness.js)
- [backend/scripts/balance/strategies.js](backend/scripts/balance/strategies.js)
- [backend/scripts/balance/run-tournament.js](backend/scripts/balance/run-tournament.js)
- [backend/scripts/balance/probes.js](backend/scripts/balance/probes.js)
- [backend/scripts/balance/probes-deep.js](backend/scripts/balance/probes-deep.js)
- [backend/scripts/balance/multi-team-test.js](backend/scripts/balance/multi-team-test.js)
- [backend/scripts/balance/trace.js](backend/scripts/balance/trace.js)
- [backend/scripts/balance/smoke.js](backend/scripts/balance/smoke.js)

These are diagnostic tools — feel free to keep them in `scripts/balance/` for
future balance work, or delete them if you don't want them in the repo.

---

## How to Re-run

```bash
cd /Users/dylanmassaro/FenriX/games/bakery-bash/backend

# Final round-robin (4500 games / 1 second)
node scripts/balance/run-tournament.js

# Mirror match (3 teams using same strategy)
node -e "
const h = require('./scripts/balance/harness');
const s = require('./scripts/balance/strategies');
console.log(h.runManyGames(['t0','t1','t2'].map((id, i) => ({
  id, name: 'frenchStack-' + i,
  strategy: { play: s.frenchStack, name: 'frenchStack' },
})), {}, 100));
"

# Math trace (verify formulas)
node scripts/balance/trace.js

# Multi-team scaling (2/4/6 teams)
node scripts/balance/multi-team-test.js

# Targeted probes
node scripts/balance/probes.js                 # all probes
node scripts/balance/probes.js adSpamMirror    # one probe
```

The probes are deterministic given a fixed seed, so you can rerun them after
further config changes to see the impact.
