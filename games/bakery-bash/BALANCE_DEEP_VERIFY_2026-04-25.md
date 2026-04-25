# Bakery Bash — Deep Verification Pass 3 (2026-04-25)

## TL;DR

Pushed verification deeper with property-based fuzz testing, adversarial
best-response search, edge cases, determinism + curveball, and a one-button
test runner.

**Total:** 15 test suites, ~1.2M+ assertions, **all passing**. Found and fixed
**4 more bugs** during verification, including a real adversarial-search
exploit that survived the previous balance pass.

| Category | Suites | Assertions | Pass |
|---|---|---|---|
| Math correctness | 1 | 96 | ✓ |
| Fuzz / invariants | 1 | ~1,200,000 | ✓ |
| Edge cases | 1 | 39 | ✓ |
| Determinism + curveball | 1 | 16 | ✓ |
| Exploit hunt | 1 | 14 probes | ✓ |
| Tournament + adversarial + sensitivity + scaling | 4 | balance verified | ✓ |
| Production E2E (Firebase emulator) | 5 | role-gated, multi-round, ad-bid-min | ✓ |
| Ad-bonus-gate | 1 | dynamic config | ✓ |
| **Total** | **15** | **~1.2M** | **✓ All pass** |

## New bugs found and fixed

### Bug 4: Negative quantities produce negative stockCost

**Found by:** edge-cases.js fuzz scenario 7 (garbage input fields).

**Location:** [revenue.js:223-246](games/bakery-bash/backend/functions/modules/revenue.js)

**What was wrong:** `calculateRoundCosts` used the raw stocked quantity
without clamping. With `quantities: { coffee: -50 }`, stockCost became
negative, which propagated into `totalSpent < 0` and confused budget
tracking. Production validators normally reject negative quantities, but
defense-in-depth wasn't there.

**Fix:** Added `Math.max(0, _num(stocked[product]))` clamping for quantities,
sousChefCount, adBidCost, and chefBidCost. All round-cost components now
guaranteed non-negative.

### Bug 5: 10-round games crashed in harness

**Found by:** edge-cases.js scenario 6 (extended 10-round game).

**Location:** [harness.js:65-78](games/bakery-bash/backend/scripts/balance/harness.js)

**What was wrong:** `makeRoundPreferences()` returned only 5 entries (one per
template). When `cfg.totalRounds = 10`, accessing `roundPrefsList[5..9]`
returned `undefined` and crashed at `roundPrefs.modifiers || {}`.

**Fix:** `makeRoundPreferences(seed, totalRounds)` now cycles through templates
modulo their count, supporting arbitrary round lengths.

### Bug 6: `mergeConfig` dropped `curveballs` field

**Found by:** determinism-curveball.js B.3 (burglary deduction amount).

**Location:** [config.js:380-390](games/bakery-bash/backend/functions/modules/config.js)

**What was wrong:** `mergeConfig` returned a hand-built object that omitted
the `curveballs` block. Consumers calling `cfg.curveballs.burglaryAmount`
got `undefined` and crashed. The simulation worked anyway because
simulation.js had its own fallback to inline defaults — but tunable
config wasn't actually tunable.

**Fix:** Added `curveballs` to `mergeConfig` output with proper numeric
validation. Burglary parameters can now be configured per-game.

### Bug 7: All-4-ads cash arbitrage (adversarial best-response)

**Found by:** adversarial.js best-response search.

**Location:** Conceptual — combination of low ad min bids + ceiling pricing
+ chef + 0 sous.

**What was wrong:** With min bids at 25% of bonus (Pass 12), bidding the
minimum on all 4 ads guaranteed +$33k/round cash margin if uncontested,
totaling +$155-203k profit per game (5-round). That dwarfs the typical
$30k tournament profit, making it a clear dominant strategy.

The fix attempt at 60% mins (Pass 13) reduced it to $73-126k — still
dominant. At 80% mins (Pass 14, called Pass 15 in the most recent code),
it dropped to $23-35k — comparable to other engaged strategies. At 100%
mins (Pass 14 attempt, then reverted), engaged play collapsed because
foot-traffic alone wasn't enough to justify ad bids.

**Settled at Pass 15:** min bid = 80% of bonus. Per-ad max uncontested
margin: $0.8k–$4k. Total all-4-ads max margin: $8.8k/round, $44k over
5 rounds. Adversarial counter strategy now wins ~84% of tournament games
at +$23k profit (vs $9-15k for nationality stacks) — clearly the "smart
play" but no longer crushingly dominant.

I also added the discovered adversarial strategy as a permanent test
fixture (`adversarialCeilingCounter` in [strategies.js](games/bakery-bash/backend/scripts/balance/strategies.js)),
so future balance changes get probed against it.

## Verification suite

### 1. Math correctness — 96 assertions

[scripts/balance/math-verify.js](games/bakery-bash/backend/scripts/balance/math-verify.js)

Hand-traces every formula in the simulation engine. Sections A through K:
chef output, sous cost curves, cohesion, fill rate → satisfaction,
foot traffic modifier components, customer allocation symmetry/asymmetry,
revenue formula (including anti-arbitrage), loan shark, ad bonus gate,
sellout cap, end-to-end profit reconciliation.

```
=== RESULTS: 96 passed, 0 failed ===
```

### 2. Property-based fuzz — ~1.2M assertions

[scripts/balance/fuzz.js](games/bakery-bash/backend/scripts/balance/fuzz.js)

10,000 simulations with random valid (and invalid) player decisions,
random chefs, random round preferences, random budgets including negative.
Asserts 19 game invariants on every result:

- All numeric fields finite
- `customerCount ∈ ℕ`
- `aggregateSatisfactionPct ∈ [0, 100]`
- `chefSatisfactionScore ∈ [floor, 100]`
- `qtySold ≤ qtyStocked`
- `amountBorrowed = max(0, totalSpent - budgetCurrent)`
- `interest = borrowed × rate`
- `revenueNet = revenueGross - (borrowed + interest)`
- `budgetAfter = budgetCurrent + revenueNet - totalSpent` (when no burglary)
- `returningCustomersEarned ∈ {0, ⌊cust × 0.08⌋, ⌊cust × 0.15⌋}`
- `adWins ⊆ {TV, Billboard, Radio, Newspaper}`
- ...etc

```
Results: ~1,200,000 invariant checks passed, 0 failed
```

### 3. Edge cases — 39 assertions

[scripts/balance/edge-cases.js](games/bakery-bash/backend/scripts/balance/edge-cases.js)

Specific extreme scenarios:
1. Zero stock everywhere (no crashes, totalSpent=0)
2. Full chef-cap (3 advanced chefs) at R5
3. Zero starting budget (forced loan shark every spend)
4. Negative starting budget (already in red)
5. 10× max stocking (no sellouts, stock cost matches sum)
6. **10-round extended game** (revealed Bug 5)
7. **Garbage input fields** (NaN, undefined, negative — revealed Bug 4)
8. Sellout cascade across 3 players
9. Returning-customer trend across rounds

```
=== EDGE CASE RESULTS: 39 passed, 0 failed ===
```

### 4. Determinism + curveball — 16 assertions

[scripts/balance/determinism-curveball.js](games/bakery-bash/backend/scripts/balance/determinism-curveball.js)

- Same noiseSeed produces identical revenueGross
- Same harness seed produces identical round-preference order
- Burglary fires at expected ~25% rate when cleanliness < 40%
- Burglary never fires when cleanliness ≥ threshold (200 trials)
- **Burglary deducts the correct amount** (revealed Bug 6)
- Sellout cap with high pre-cap satisfaction → exactly 45 (poor band high)
- Sellout cap tier matches capped sat (no longer hardcoded to "poor")
- Returning-customer formula at exact tier boundaries (sat=66, 86)

```
=== RESULTS: 16 passed, 0 failed ===
```

### 5. Exploit hunt — 14 probes

[scripts/balance/exploit-hunt.js](games/bakery-bash/backend/scripts/balance/exploit-hunt.js)

- Single-product spam (sandwich-only / matcha-only): no exploit
- 3-chef nationality monopoly: balanced ($15-21k)
- Aggressive R1 loan refinance: loses (debt service eats profit)
- 4 vs 6 vs 8 sous: 4 wins ($18k vs -$7k vs -$37k) — cohesion penalty works
- Min-bid-everywhere ad spam: closed (Bug 7 / Pass 15)
- 4-ads-foot-traffic stack: still wins but moderate ($63k → marginal post-Pass 15)
- Stockpile-then-coast: loses
- Pricing strategies (ceiling/competitive/floor): competitive wins (no flag)
- Floor pricing uncontested: wins moderately (rewards engagement)
- Returning-customer snowball: rewards quality investment (intentional)
- Foot-traffic max strategy: wins moderately
- RNG bias check (200 mirror games): now uniform 31/38/31 (was 100/0/0)
- Empty menu: doesn't profit
- Cheap Newspaper alone: closed (now matches no-ad due to min bid)

### 6. Tournament + adversarial + sensitivity + scaling

- **Round-robin** ([run-tournament.js](games/bakery-bash/backend/scripts/balance/run-tournament.js)):
  455 lobbies × 20 reps = 9,100 games per strategy. Final balance:
  premiumMenu (73%, $15k), 4 nationality stacks (50-65%, $9-15k each),
  loanAbuser/baseline/minimalist (~$4-13k), losers (-$6 to -$393k).
- **Adversarial** ([adversarial.js](games/bakery-bash/backend/scripts/balance/adversarial.js)):
  best-response search across 7 different opponent types. Best counter
  profits: $23-36k (down from $155-203k pre-fix).
- **Sensitivity** ([sensitivity.js](games/bakery-bash/backend/scripts/balance/sensitivity.js)):
  ±50% perturbations on 5 critical parameters. Rank order holds; max profit
  shift on extreme perturbation: $25k.
- **Scaling** ([scaling-test.js](games/bakery-bash/backend/scripts/balance/scaling-test.js)):
  2/3/4/5/6/8 team configurations. Spread $2.5k–$5.3k across all team
  counts. No nationality dominates at any scale.

### 7. Production E2E (Firebase emulator)

- `test-multi-team-costs.js` — solo and multi teams pay identical costs
- `test-chef-cap-enforcement.js` — over-cap rosters block phase advance
- `test-phase-flow.js` — 7-phase state machine
- `test-apr23-e2e.js` — full multi-team multi-role with cascade
- **`balance/e2e-firestore-verify.js`** (24 deep checks) — phase
  transitions, ad-bid-minimum enforcement, cost reconciliation exact to
  the dollar, multi-round budget chain, leaderboard

### 8. Ad bonus gate

[scripts/test-ad-bonus-gate.js](games/bakery-bash/backend/scripts/test-ad-bonus-gate.js)

Dynamically reads `cfg.adBonuses.TV` so it tracks balance changes:
- Zero-stock TV winner gets NO bonus
- Stocked TV winner gets full $20k bonus
- Delta ≈ $20k (within noise)

## How to run

### One-button (everything)
```bash
cd games/bakery-bash/backend
node scripts/balance/run-all.js                # full suite (~30s)
node scripts/balance/run-all.js --no-slow      # skip adversarial
node scripts/balance/run-all.js --no-emulator  # skip E2E
```

### Individual suites
```bash
node scripts/balance/math-verify.js                # 96 unit checks
node scripts/balance/fuzz.js 50000                 # 50k iterations
node scripts/balance/edge-cases.js                 # 39 edge cases
node scripts/balance/determinism-curveball.js      # 16 checks
node scripts/balance/exploit-hunt.js               # 14 probes
node scripts/balance/adversarial.js                # best-response (slow)
node scripts/balance/run-tournament.js             # 4500 games
node scripts/balance/scaling-test.js               # multi-team
node scripts/balance/sensitivity.js                # parameter sweeps
```

### E2E (requires firebase emulator running)
```bash
firebase emulators:start --only auth,firestore,functions  # in another shell
FIRESTORE_EMULATOR_HOST="127.0.0.1:8080" \
FIREBASE_AUTH_EMULATOR_HOST="127.0.0.1:9099" \
GCLOUD_PROJECT=bakery-bash-54d12 \
node scripts/balance/e2e-firestore-verify.js
```

## Sample output of run-all.js

```
Running: Math correctness... PASS (0.0s)
Running: Fuzz / invariants (10k iterations)... PASS (0.6s)
Running: Edge cases... PASS (0.0s)
Running: Determinism + curveball... PASS (0.1s)
Running: Exploit hunt... PASS (0.3s)
Running: Tournament (round-robin)... PASS (2.6s)
Running: Multi-team scaling... PASS (0.4s)
Running: Sensitivity sweeps... PASS (2.0s)
Running: Adversarial best-response... PASS (10.6s)
Running: Ad bonus gate (production)... PASS (0.0s)
Running: E2E: multi-team-costs... PASS (3.4s)
Running: E2E: chef-cap-enforcement... PASS (0.3s)
Running: E2E: phase-flow... PASS (0.4s)
Running: E2E: balance/firestore-verify... PASS (0.7s)
Running: E2E: apr23 multi-team multi-role... PASS (4.9s)

======================================================================
Summary
======================================================================
  15 passed, 0 failed, 0 skipped

✓ ALL VERIFICATION PASSES
```

## Total bugs found across 3 verification passes

| # | Bug | Layer found | Severity | Status |
|---|---|---|---|---|
| 1 | Stale `stats` reference in `applySelloutCap` | math-verify | medium (display) | fixed |
| 2 | Hardcoded `tier='poor'` inconsistent with low sat | math-verify | low (display) | fixed |
| 3 | No minimum ad bid → $1 wins ads | exploit-hunt | high (exploit) | fixed |
| 4 | Negative quantities → negative stockCost | edge-cases (garbage input) | medium (defense in depth) | fixed |
| 5 | 10-round games crash harness | edge-cases | low (test infra) | fixed |
| 6 | `mergeConfig` drops `curveballs` field | determinism-curveball | low (config) | fixed |
| 7 | All-4-ads cash arbitrage at low min bids | adversarial best-response | high (exploit) | fixed |

Bugs 1, 2 found in pass 2. Bugs 3-7 found in pass 3 (this report).

All bugs fixed in production code; no regressions introduced (verified via
re-running the full E2E suite after each fix).

## Files changed in this pass

### Production code
- [config.js](games/bakery-bash/backend/functions/modules/config.js) —
  ad bid minimums (Pass 12 → 13 → 14 → 15), curveballs in mergeConfig,
  MULTIPLIER_FLOOR 0.10 → 0.05
- [revenue.js](games/bakery-bash/backend/functions/modules/revenue.js) —
  defensive clamping of negative inputs in `calculateRoundCosts`
- [index.js](games/bakery-bash/backend/functions/index.js) —
  `resolveAndApplyAdAuction` enforces ad bid minimums

### Test infrastructure
- [scripts/balance/fuzz.js](games/bakery-bash/backend/scripts/balance/fuzz.js) — new
- [scripts/balance/adversarial.js](games/bakery-bash/backend/scripts/balance/adversarial.js) — new
- [scripts/balance/edge-cases.js](games/bakery-bash/backend/scripts/balance/edge-cases.js) — new
- [scripts/balance/determinism-curveball.js](games/bakery-bash/backend/scripts/balance/determinism-curveball.js) — new
- [scripts/balance/run-all.js](games/bakery-bash/backend/scripts/balance/run-all.js) — new (one-button runner)
- [scripts/balance/strategies.js](games/bakery-bash/backend/scripts/balance/strategies.js) —
  added `adversarialCeilingCounter` strategy as permanent test fixture
- [scripts/balance/harness.js](games/bakery-bash/backend/scripts/balance/harness.js) —
  10-round support, exposed `makeRoundPreferences` + `PREFERENCE_TEMPLATES`
- [scripts/balance/e2e-firestore-verify.js](games/bakery-bash/backend/scripts/balance/e2e-firestore-verify.js) —
  updated bid amounts to clear new minimums
