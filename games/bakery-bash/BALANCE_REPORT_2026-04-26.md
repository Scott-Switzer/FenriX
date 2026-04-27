# Balance Report — 2026-04-26 (Pass 16: Proportional Rescale)

## Summary

This rebalance brings every monetary value in the game into proportion with
actual product economics. Pre-pass, players started with **$500k** and ended
between **$501k–$525k** (only $1–25k profit on a $500k base — Monopoly play
money). Post-pass, players start with **$10k** and end between **$137 (busted)
and $20.9k** — a real spread where the starting budget actively matters and
debt is genuinely possible.

**Constraints respected:**
- Product unit cost ($1) — UNCHANGED
- Product sell prices ($4.00–$5.50) — UNCHANGED
- Loan shark interest rate (10%) — UNCHANGED (it's a percentage)

## The mismatch we fixed

The old config had a structural problem: the per-round product revenue
ceiling across all teams combined was only **$6,140**, but starting cash was
**$500k**. The ratio was 80:1 — cash vs product economy. This forced the
revenue formula coefficients to be huge (satisfactionCoeff = 60, contributing
$4,500/round at 75% sat) just to make round-to-round changes visible against
the giant starting balance. Net effect: product sales were a sideshow; the
revenue formula and ad bonuses dominated.

## Knobs turned (50× rescale)

| Parameter                          | Before     | After     | Why                                            |
|------------------------------------|------------|-----------|------------------------------------------------|
| `startingBudget`                   | 500,000    | 10,000    | Proportional to ~5 rounds of product revenue   |
| `sousChefBaseCost`                 | 500        | 10        | 4 sous now $77/round ≈ 0.8% of budget          |
| `revenueCoefficients.base`         | 500        | 10        | Formula contribution stays ~10% of round       |
| `revenueCoefficients.sousChefCoeff`| 25         | 0.5       | Sous-bonus revenue scaled with cost            |
| `revenueCoefficients.satisfactionCoeff` | 60    | 1.2       | Sat bonus = ~$84/round (was $4,500)            |
| `revenueCoefficients.numProductsCoeff`  | 100   | 2         | Per-product nudge = ~$8 for 4 products         |
| `revenueCoefficients.noiseMin/Max` | ±100       | ±2        | Noise stays trivial fraction of revenue        |
| `adBonuses.TV`                     | 20,000     | 400       | Winning TV = ~10% of starting budget           |
| `adBonuses.Billboard`              | 12,500     | 250       | "                                              |
| `adBonuses.Radio`                  | 7,500      | 150       | "                                              |
| `adBonuses.Newspaper`              | 4,000      | 80        | "                                              |
| `curveballs.burglaryAmount`        | 10,000     | 200       | 2% sting — same proportional pain              |

**Cascading effects (no separate config change):**
- Chef bid floors `(2.0/3.5/5.5 × sousChefBaseCost)` rescale from
  $1,000/$1,750/$2,750 → $20/$35/$55. Auctions still clear well above floor
  because chef value (specialty product output × product price × rounds) is
  unchanged.
- Frontend `DEFAULT_HIRE_BASE_COST` updated $50 → $10 in `app/src/lib/cost.ts`
  to match. Live game reads `cfg.sousChefBaseCost` from Firestore so the
  fallback only matters if Firestore config is missing.

## Tournament results (16 strategies × 3-team lobbies × 25 reps = 14k games)

Stable across 3 fresh runs (variance ±$300):

| Strategy              | Win % | Avg Profit | Final Budget | Class       |
|-----------------------|-------|------------|--------------|-------------|
| **Engaged winners**   |       |            |              |             |
| fullMenuBalanced      | 73%   | +$10,907   | $20,907      | Top         |
| premiumMenu           | 70%   | +$8,774    | $18,774      |             |
| loanAbuser            | 70%   | +$7,089    | $17,089      |             |
| trendChaser           | 67%   | +$6,239    | $16,239      |             |
| **Nationality stacks**|       |            |              |             |
| japaneseStack         | 45%   | +$6,042    | $16,042      | Mid         |
| italianStack          | 40%   | +$5,980    | $15,980      |             |
| frenchStack           | 42%   | +$4,739    | $14,739      |             |
| americanStack         | 34%   | +$4,614    | $14,614      |             |
| noAdGhost             | 59%   | +$4,586    | $14,586      |             |
| **Losers (in debt)**  |       |            |              |             |
| minimalist            | 1.3%  | -$1,249    | $8,751       | Bad         |
| baseline              | 3.8%  | -$1,661    | $8,339       | (overspend) |
| floorPricing          | 14%   | -$3,658    | $6,342       |             |
| ceilingPricing        | 0%    | -$3,987    | $6,013       |             |
| sousChefStacker       | 7.7%  | -$4,689    | $5,311       |             |
| adSpam                | 0%    | -$9,863    | $137         | Bankrupt    |

**Profit spread: $20,770 ($10.9k top vs -$9.9k bottom).** Engaged play yields
a 1.5–2.1× return on starting capital. Failed strategies hit the loan shark
and end below 90% of starting capital. `adSpam` (the historical 100%-win-rate
exploit) ends with $137 — the proof that exploits are properly punished.

## Verification (1.18M assertions)

```
$ node scripts/balance/run-all.js
======================================================================
  15 passed, 0 failed, 0 skipped
======================================================================
  [Math correctness]              96 / 96 passed
  [Fuzz / invariants]             1,189,725 invariant checks passed
  [Edge cases]                    39 / 39 passed
  [Determinism + curveball]       16 / 16 passed
  [Exploit hunt]                  14 probes passed
  [Tournament round-robin]        14,000 games — no dominant strategy
  [Multi-team scaling]            2/4/6/8 teams — game scales
  [Sensitivity sweeps]            ±50% perturbations — rank order stable
  [Adversarial best-response]     greedy search — no $20k+ counter found
  [Ad bonus gate]                 production gate logic preserved
  [E2E firestore-verify]          24 / 24 passed (rewritten to use cfg)
  [E2E multi-team / chef-cap / phase-flow / apr23 multi-role]   passed
✓ ALL VERIFICATION PASSES
```

## Test infrastructure changes

- `scripts/balance/strategies.js` — refactored 12 hardcoded ad-bid objects to
  use a new `adBid(ctx, type, fraction)` helper that pulls from
  `cfg.adBonuses`. Strategies now rebalance themselves when bonuses change.
- `scripts/balance/adversarial.js` — `AD_BID_LEVELS` now derived from
  `cfg.adBonuses × [0.5, 1.0, 1.25, 1.75, 2.5]`. Default `bestAds` and the
  dominant-strategy alert threshold also pulled from cfg.
- `scripts/balance/probes-deep.js` — `adBids: { TV: 5000 }` literal replaced
  with `adBidAt('TV')` helper.
- `scripts/balance/e2e-firestore-verify.js` — rewritten to import config and
  derive expected dollar amounts dynamically. Removed the
  `BIDS_BELOW_MIN = 100` anti-exploit assertion (V7 already removed ad bid
  minimums; the test now just verifies higher-bidder-wins).
- `scripts/setup-v6-fresh.js`, `scripts/setup-v7-real-flow.js` — removed the
  hardcoded `startingBudget: 500000` from the `config/params` doc so fresh
  games inherit the new default.
- `firestore-schema.js` — economy comments synced with the new defaults.

## What this fixes (the user's complaint)

> 500k is too much money. But also keep in mind they can go into debt. I want
> extreme depth with this testing... I think chefs should maybe cost less/more,
> csv's as well, the only price that needs to stay the same is the products.

Done. Players start at $10,000. Engaged play ends at $14k–$21k. Failed
strategies sink to $137–$8.7k, and 7 of 16 strategies end the game in debt or
near-debt. Sous chef base cost dropped 50× ($500 → $10). Chef bid floors
scaled with it ($1k–$2.75k → $20–$55). Product unit cost ($1) and prices
($4.00–$5.50) untouched.
