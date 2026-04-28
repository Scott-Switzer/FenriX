# Dataset → Game Bridge: CSV X-Columns + Multi-Day Per Round

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the in-game CSV export sufficient for students to re-train predictive models between rounds, by (P1) exposing the team's own decision inputs as columns, and (P2) simulating 30 daily outcomes per monthly round so each round produces 30 CSV rows instead of 1.

**Architecture:** P1 is a pure CSV-schema change (adds 13 columns to one frontend file; data is already on the player round doc). P2 wraps the existing pure `runSimulation()` in a per-day loop, varies demand via a per-day multiplier, persists per-day docs in a new subcollection, and aggregates daily rows into the existing round-level KPIs for the Results screen. No game flow changes — round = month, players still make 5 strategic decisions.

**Tech Stack:** Firebase Cloud Functions (Node 20, CommonJS), Firestore, React 18 + Vite, Mocha for unit tests. The pure simulation modules (`simulation.js`, `customer-allocation.js`, `revenue.js`) have no Firebase deps and can be unit-tested directly.

**Background:** See [analysis/FINDINGS.md §5 and §7](../FINDINGS.md). Feasibility analysis for the multi-day approach in [scripts/06_retraining_feasibility.py](../scripts/06_retraining_feasibility.py).

---

## Scope

### In scope
- **P1** — Add 13 decision-input columns to the student CSV export. Pure schema change.
- **P2** — Multi-day simulation: each monthly round runs 30 daily sub-simulations with per-day demand variability. Persists per-day rows for CSV export. Aggregates to monthly KPIs for the Results screen so the existing UI works unchanged.

### Out of scope (deferred)
- **P3** — Cross-team CSV pooling. Tracked as a design decision in the [Open Questions](#open-design-question-p3-cross-team-csv-pooling) section at the end of this plan. **Do not implement P3 in this PR.**
- New strategic decisions per day (e.g., mid-month price changes). Stays as one set of decisions per round.
- Backend professor CSV changes. Already includes all data we need; the gap is on the student side.

### Non-goals
- Performance optimization beyond what's needed to keep total round time under 8 seconds (current sim budget per `BACKEND.md`).
- UI redesign of the Results screen. Daily breakdown shown as an expandable section; primary KPIs remain monthly aggregates.
- Touching the dataset itself (locked per professor).

---

## File Inventory

**P1 (CSV X-columns):**
- Modify: `games/bakery-bash/app/src/components/game/RoundHeader.tsx` (CSV_COLUMNS array lines 40–68; serializeRow lines 93–151)
- Modify: `games/bakery-bash/app/src/types/game.ts` (RoundResult interface lines 370–414 — add `productPrices` and `quantitiesStocked` fields)
- Modify: `games/bakery-bash/backend/functions/index.js` (lastRoundResult write at lines 2194–2230 — surface productPrices and quantities to the player doc so the frontend type sees them)

**P2 (multi-day per round):**
- Create: `games/bakery-bash/backend/functions/modules/multi-day-simulation.js` — wraps `runSimulation()` in a per-day loop with per-day variability and aggregation
- Create: `games/bakery-bash/backend/test/multi-day-simulation.test.js` — unit tests for the wrapper
- Modify: `games/bakery-bash/backend/functions/modules/revenue.js` (gaussianNoise at line 78 — accept day index in seed; computeGrossRevenue at line 146 — pass day through)
- Modify: `games/bakery-bash/backend/functions/modules/simulation.js` (runSimulation signature at line 264 — accept optional `day` param for noise seed)
- Modify: `games/bakery-bash/backend/functions/modules/config.js` — add `daysPerRound` (default 30) and demand variability config
- Modify: `games/bakery-bash/backend/functions/index.js` (runSimulationAndPersist at lines 1865–2240 — call multi-day wrapper, persist daily docs in `players/{uid}/rounds/{roundId}/days/{dayId}` and `csvRows/{uid}/rounds/{roundId}/days/{dayId}`)
- Modify: `games/bakery-bash/app/src/components/game/RoundHeader.tsx` (downloadResultsCsv to read daily rows; add `day` column)
- Modify: `games/bakery-bash/app/src/types/game.ts` (RoundResult — add optional `dailyBreakdown` array)

---

## P1 — CSV X-Columns

The 13 columns to add (placed adjacent to the existing units-sold columns so the output reads `decided → sold` in column order):

```
num_products,
croissant_qty_stocked, cookie_qty_stocked, bagel_qty_stocked,
sandwich_qty_stocked, coffee_qty_stocked, matcha_qty_stocked,
price_croissant, price_cookie, price_bagel,
price_sandwich, price_coffee, price_matcha
```

These exist on the backend per-round doc already (see `simulation.js` lines 411–418 and 496–514, where `productPrices` and per-product `qtyStocked` are computed and emitted in `csvRow`). The professor CSV (`csv-export.js` lines 60–75) includes them. The student-side gap is purely that they're not bridged to `lastRoundResult` (the doc the frontend reads).

### Task P1.1: Surface productPrices and quantitiesStocked on lastRoundResult

**Files:**
- Modify: `games/bakery-bash/backend/functions/index.js:2194-2230`

- [ ] **Step 1: Add the two fields to the lastRoundResult write block**

In `runSimulationAndPersist`, the `playerUpdate.lastRoundResult` object (around line 2194) currently includes `revenueGross`, `revenueNet`, `customerCount`, `aggregateSatisfactionPct`, `staffCounts`, etc. Add these immediately after `staffCounts`:

```js
        productPrices:
          (r.csvRow && typeof r.csvRow === 'object'
            ? {
                croissant: numberOrDefault(r.csvRow.price_croissant, null),
                cookie: numberOrDefault(r.csvRow.price_cookie, null),
                bagel: numberOrDefault(r.csvRow.price_bagel, null),
                sandwich: numberOrDefault(r.csvRow.price_sandwich, null),
                coffee: numberOrDefault(r.csvRow.price_coffee, null),
                matcha: numberOrDefault(r.csvRow.price_matcha, null),
              }
            : null),
        quantitiesStocked:
          (r.csvRow && typeof r.csvRow === 'object'
            ? {
                croissant: numberOrDefault(r.csvRow.croissant_qty_stocked, 0),
                cookie: numberOrDefault(r.csvRow.cookie_qty_stocked, 0),
                bagel: numberOrDefault(r.csvRow.bagel_qty_stocked, 0),
                sandwich: numberOrDefault(r.csvRow.sandwich_qty_stocked, 0),
                coffee: numberOrDefault(r.csvRow.coffee_qty_stocked, 0),
                matcha: numberOrDefault(r.csvRow.matcha_qty_stocked, 0),
              }
            : null),
        numProducts: numberOrDefault(r.csvRow && r.csvRow.num_products, 0),
```

- [ ] **Step 2: Verify by inspection**

Read the current shape of `r.csvRow` in `csv-export.js:216-310` (`buildCsvRow`). Confirm the field names match exactly: `price_croissant`, `croissant_qty_stocked`, `num_products`. If `buildCsvRow` writes them under different names, adjust the lastRoundResult mapping above.

- [ ] **Step 3: Commit**

```bash
git add games/bakery-bash/backend/functions/index.js
git commit -m "feat(bakery-bash): surface productPrices+quantitiesStocked on lastRoundResult"
```

### Task P1.2: Extend the RoundResult type

**Files:**
- Modify: `games/bakery-bash/app/src/types/game.ts:370-414`

- [ ] **Step 1: Add the three new optional fields to the RoundResult interface**

After the `productBreakdown` field (around line 402), add:

```ts
  /** Resolved per-product prices the team submitted this round (POST-01). */
  productPrices?: Partial<Record<ProductKey, number | null>>;
  /** Per-product quantities the team stocked this round (decision input). */
  quantitiesStocked?: Partial<Record<ProductKey, number>>;
  /** Number of products the team offered (3–6, base menu always on). */
  numProducts?: number;
```

- [ ] **Step 2: Run typecheck**

```bash
cd games/bakery-bash/app && npm run typecheck
```

Expected: passes. If unfamiliar fields appear in errors, the existing `RoundResult` consumers don't reference these fields yet — the optional `?` means they won't break.

- [ ] **Step 3: Commit**

```bash
git add games/bakery-bash/app/src/types/game.ts
git commit -m "feat(bakery-bash): add productPrices+quantitiesStocked+numProducts to RoundResult"
```

### Task P1.3: Extend the CSV schema and serializer

**Files:**
- Modify: `games/bakery-bash/app/src/components/game/RoundHeader.tsx:40-68` (CSV_COLUMNS)
- Modify: `games/bakery-bash/app/src/components/game/RoundHeader.tsx:93-151` (serializeRow)

- [ ] **Step 1: Add 13 columns to CSV_COLUMNS, placed before the units-sold block**

Replace the current `CSV_COLUMNS` constant with:

```ts
const CSV_COLUMNS = [
  "round",
  "revenue_net",
  "revenue_gross",
  "amount_borrowed",
  "interest_charged",
  "customer_count",
  "customer_satisfaction",
  "chef_satisfaction_score",
  "cleanliness_pct",
  "oven_health_pct",
  "slicer_health_pct",
  "espresso_health_pct",
  "bakery_sous_chef_count",
  "deli_sous_chef_count",
  "barista_sous_chef_count",
  "maintenance_guy_count",
  "ad_won",
  "ad_paid",
  "chef_won",
  "chef_paid",
  "sellout",
  // -- Decision inputs (P1, 2026-04-27) --
  "num_products",
  "price_croissant",
  "price_cookie",
  "price_bagel",
  "price_sandwich",
  "price_coffee",
  "price_matcha",
  "croissant_qty_stocked",
  "cookie_qty_stocked",
  "bagel_qty_stocked",
  "sandwich_qty_stocked",
  "coffee_qty_stocked",
  "matcha_qty_stocked",
  // -- Decision outcomes --
  "croissants_sold",
  "cookies_sold",
  "bagels_sold",
  "sandwiches_sold",
  "coffees_sold",
  "matchas_sold",
] as const;
```

- [ ] **Step 2: Update serializeRow to emit the new columns in the same order**

Add a `prices` and `stocked` destructure block at the top of `serializeRow` (around line 95):

```ts
  const prices = r.productPrices ?? {};
  const stocked = r.quantitiesStocked ?? {};
```

Then in the return array, insert the 13 new values between the existing `r.selloutAnywhere ? "1" : "0"` line and `num(breakdown.croissant)`:

```ts
    r.selloutAnywhere ? "1" : "0",
    // -- Decision inputs --
    num(r.numProducts),
    num(prices.croissant),
    num(prices.cookie),
    num(prices.bagel),
    num(prices.sandwich),
    num(prices.coffee),
    num(prices.matcha),
    num(stocked.croissant),
    num(stocked.cookie),
    num(stocked.bagel),
    num(stocked.sandwich),
    num(stocked.coffee),
    num(stocked.matcha),
    // -- Decision outcomes (existing) --
    num(breakdown.croissant),
    ...
```

- [ ] **Step 3: Run typecheck and lint**

```bash
cd games/bakery-bash/app && npm run typecheck && npm run lint
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add games/bakery-bash/app/src/components/game/RoundHeader.tsx
git commit -m "feat(bakery-bash): expose decision inputs in student CSV export"
```

### Task P1.4: Smoke test against the emulator

**Files:**
- No file edits; verifies P1.1–P1.3 work end-to-end.

- [ ] **Step 1: Run the existing revenue-flow integration test**

```bash
cd games/bakery-bash/backend && npm run test:revenue-flow
```

Expected: passes (decision-input changes don't touch the revenue path it tests).

- [ ] **Step 2: Boot the emulator and play one round manually**

```bash
cd games/bakery-bash/backend && firebase emulators:start --project bakery-bash-54d12
```

In a second terminal, run the app dev server (`cd games/bakery-bash/app && npm run dev`). Join two anonymous players to a game, advance through round 1, then download the CSV from the Results screen.

- [ ] **Step 3: Verify CSV contains the 13 new columns with non-empty values**

Open the downloaded file. Confirm header row matches the new schema and the data row has populated `num_products`, `price_*`, and `*_qty_stocked` fields. If any are blank, the lastRoundResult bridge in P1.1 didn't land — re-check that step.

- [ ] **Step 4: Commit verification notes**

(No code change; verification only.)

---

## P2 — Multi-Day Per Round

A round = 1 month = 30 simulated days. Strategic decisions are made once per round (unchanged). The simulation runs 30 times within each round, varying the demand pool with a per-day multiplier sampled from a configured distribution. Each daily run produces a row in the CSV. Monthly aggregates feed the Results screen so existing UI works.

### Design decisions baked into this plan
- **30 days per round.** Configurable via `config.daysPerRound`, default 30.
- **Per-day demand variability:** uniform multiplier in `[0.7, 1.3]` (configurable). Applied to `roundPreferences.modifiers` before each daily sim.
- **Noise seed** extends to `${gameId}:${round}:${day}:${playerId}` so each day has independent revenue noise.
- **Cumulative state per round:** budget updates ONCE at end of round (sum of daily nets); returning customers carry to next round based on monthly aggregate satisfaction; cleanliness/maintenance degrade per round (not per day) — current behavior preserved.
- **Burglary check:** rolled once per month (current behavior), not 30 times. Avoids 30× burglary frequency.
- **Customer count display:** Results screen shows monthly total = sum of daily customer counts.

### Task P2.1: Update gaussianNoise to accept a day-aware seed

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/revenue.js:78-101`
- Test: `games/bakery-bash/backend/test/revenue.test.js` (create)

- [ ] **Step 1: Write failing test for day-varied seeds**

Create `games/bakery-bash/backend/test/revenue.test.js`:

```js
const assert = require('node:assert/strict');
const { gaussianNoise } = require('../functions/modules/revenue');

describe('gaussianNoise', () => {
  it('produces identical noise for the same seed', () => {
    const a = gaussianNoise(-2, 2, 'game:1:0:player_a');
    const b = gaussianNoise(-2, 2, 'game:1:0:player_a');
    assert.equal(a, b, 'same seed must produce same noise');
  });
  it('produces different noise when only day differs', () => {
    const day0 = gaussianNoise(-2, 2, 'game:1:0:player_a');
    const day1 = gaussianNoise(-2, 2, 'game:1:1:player_a');
    assert.notEqual(day0, day1, 'changing day must change noise');
  });
  it('respects min/max clamps', () => {
    for (let d = 0; d < 200; d += 1) {
      const v = gaussianNoise(-2, 2, `game:1:${d}:player_a`);
      assert.ok(v >= -2 && v <= 2, `value ${v} out of range`);
    }
  });
});
```

- [ ] **Step 2: Run the test, confirm it passes (gaussianNoise already supports arbitrary seeds)**

```bash
cd games/bakery-bash/backend && npx mocha test/revenue.test.js
```

Expected: PASS. The existing `gaussianNoise` already accepts arbitrary seed strings (revenue.js:78-101); this test simply pins down the contract we'll rely on for multi-day.

- [ ] **Step 3: Commit**

```bash
git add games/bakery-bash/backend/test/revenue.test.js
git commit -m "test(bakery-bash): pin gaussianNoise seed contract for multi-day sim"
```

### Task P2.2: Add daysPerRound and demand variability to config

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/config.js`

- [ ] **Step 1: Add the config keys**

Locate the section near the existing `chefPoolSize` constants (around line 400) and add:

```js
// ---------------------------------------------------------------------------
// Multi-day simulation (2026-04-27)
// ---------------------------------------------------------------------------
// Each round represents one month. The simulation runs daysPerRound daily
// sub-simulations, each with a per-day demand multiplier sampled uniformly
// from [demandVariabilityMin, demandVariabilityMax]. Daily revenue uses
// independent Gaussian noise (seed includes day index). Monthly KPIs
// (revenue, customer count, etc.) are sums across the days.
const MULTI_DAY = {
  daysPerRound: 30,
  demandVariabilityMin: 0.7,
  demandVariabilityMax: 1.3,
};
```

Add `MULTI_DAY` to the module's existing exports object.

- [ ] **Step 2: Verify the export is wired**

```bash
cd games/bakery-bash/backend && node -e "const c = require('./functions/modules/config'); console.log(c.MULTI_DAY);"
```

Expected: `{ daysPerRound: 30, demandVariabilityMin: 0.7, demandVariabilityMax: 1.3 }`.

- [ ] **Step 3: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/config.js
git commit -m "feat(bakery-bash): add MULTI_DAY config for per-round daily sim"
```

### Task P2.3: Thread day index + skipCostAccounting flag into runSimulation

**Why the skipCostAccounting flag:** when the multi-day wrapper calls `runSimulation` 30 times per round, the cost (stock × $1/unit, sous chef hire, ad bid, chef bid) and the loan-shark interest get charged 30 times. That breaks the budget math — a $200 stock cost becomes $6,000, a 1-time loan-shark borrow becomes 30 borrows + 30 interest charges. Fix: per-day calls skip cost/loan-shark/burglary entirely; the multi-day wrapper computes them ONCE at month-end on the monthly aggregate.

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/simulation.js:264, 448, 462-486, 516-528`

- [ ] **Step 1: Accept `day` and `skipCostAccounting` in runSimulation options**

Change line 264 from:

```js
function runSimulation(players, roundPreferences, config, { gameId = 'game', round = 0 } = {}) {
```

to:

```js
function runSimulation(players, roundPreferences, config, { gameId = 'game', round = 0, day = 0, skipCostAccounting = false } = {}) {
```

- [ ] **Step 2: Include day in the noise seed**

Change line 448 from:

```js
      noiseSeed: `${gameId || 'game'}:${round}:${p.playerId}`,
```

to:

```js
      noiseSeed: `${gameId || 'game'}:${round}:${day}:${p.playerId}`,
```

- [ ] **Step 3: Wrap the cost / loan-shark / burglary block in the flag**

In the `for (const pp of perPlayer)` pass-3 loop (around lines 462–528), the current code computes cost, loan-shark, budget, and burglary unconditionally. Replace that whole block with a conditional. The "before" block in the file currently looks like:

```js
    // --- Round costs (excluding loan shark) ---
    const costDecision = {
      perProductQtyStocked: decision.quantities || {},
      sousChefCount,
    };
    const costAuction = {
      adAuctionWinningBid: adBidPaid,
      chefAuctionWinningBid: chefBidPaid,
    };
    const roundCosts = calculateRoundCosts(costDecision, costAuction, config);
    const totalSpent = roundCosts.totalSpent;

    // --- Loan shark ---
    const budgetCurrent = _num(p.budgetCurrent);
    const loanResult = calculateLoanShark(totalSpent, budgetCurrent, config);
    const amountBorrowed = loanResult.borrowed;
    const interestCharged = loanResult.interest;
    const loanSharkDeduction = loanResult.loanSharkDeduction;
    const revenueNet = revenueGross - loanSharkDeduction;

    // ... budgetAfter / returningCustomers / csvRow build (KEEP these as-is) ...

    // --- Burglar curveball (BE-N06) — fires when cleanliness is critically low ---
    const burglaryThreshold = ...;
    // ... burglary block ...
```

Replace the cost / loan-shark block with:

```js
    // --- Round costs (excluding loan shark) ---
    // P2: when skipCostAccounting=true (multi-day inner calls), zero out costs
    // and loan-shark — the multi-day wrapper computes them once per month using
    // monthly aggregates. Otherwise (single-round mode, default), behave as before.
    let totalSpent = 0;
    let amountBorrowed = 0;
    let interestCharged = 0;
    let loanSharkDeduction = 0;
    if (!skipCostAccounting) {
      const costDecision = {
        perProductQtyStocked: decision.quantities || {},
        sousChefCount,
      };
      const costAuction = {
        adAuctionWinningBid: adBidPaid,
        chefAuctionWinningBid: chefBidPaid,
      };
      const roundCosts = calculateRoundCosts(costDecision, costAuction, config);
      totalSpent = roundCosts.totalSpent;

      const budgetCurrent = _num(p.budgetCurrent);
      const loanResult = calculateLoanShark(totalSpent, budgetCurrent, config);
      amountBorrowed = loanResult.borrowed;
      interestCharged = loanResult.interest;
      loanSharkDeduction = loanResult.loanSharkDeduction;
    }
    const revenueNet = revenueGross - loanSharkDeduction;
```

And replace the budgetAfter calculation and burglary block with:

```js
    // HIGH-07 fix: use the canonical updateBudget formula from loan-shark.js.
    // Spec says budgets CAN go negative — do NOT clamp at zero.
    // P2: when skipCostAccounting=true, just pass budgetCurrent through unchanged
    // (the wrapper will compute the real budgetAfter once per month).
    const budgetCurrentForUpdate = _num(p.budgetCurrent);
    const budgetAfter = skipCostAccounting
      ? budgetCurrentForUpdate
      : Math.round(updateBudget(budgetCurrentForUpdate, revenueNet, totalSpent));

    // --- Returning customers earned (for NEXT round) ---
    const returningCustomersEarned = computeReturningCustomersEarned(
      postSelloutAggregate,
      customerCount,
      config
    );

    // --- CSV row (flat) ---
    const csvRow = buildCsvRow({
      decision,
      specialtyChefs: p.specialtyChefs,
      perProductSatisfaction,
      customerCount,
      revenueGross,
      revenueNet,
      amountBorrowed,
      interestCharged,
      aggregateSatisfactionPct: postSelloutAggregate,
      chefSatisfactionScore: pp.chefSatisfactionScore,
      productPrices: resolvedPricesPerPlayer[p.playerId] || {},
      playerId: p.playerId,
      displayName: p.displayName,
      bakeryName: p.bakeryName,
    });

    // --- Burglar curveball — skip in per-day inner calls, wrapper rolls it once per month ---
    let burglary = false;
    let actualBurglaryAmount = 0;
    let budgetAfterBurglary = budgetAfter;
    if (!skipCostAccounting) {
      const burglaryThreshold = (config && config.curveballs && config.curveballs.burglaryThreshold) || 40;
      const burglaryChance = (config && config.curveballs && config.curveballs.burglaryChance) || 0.25;
      const burglaryAmount = (config && config.curveballs && config.curveballs.burglaryAmount) || 10000;
      const cleanlinessPct = typeof p.cleanliness_pct === 'number' ? p.cleanliness_pct : undefined;
      if (cleanlinessPct != null && cleanlinessPct < burglaryThreshold && Math.random() < burglaryChance) {
        burglary = true;
        actualBurglaryAmount = burglaryAmount;
        budgetAfterBurglary = Math.max(0, budgetAfter - burglaryAmount);
      }
    }
```

Leave the existing `csvRow` build (around lines 495–514) and the `results.push({ ... })` (around lines 530–557) **untouched** — they sit between the cost block and the burglary block and don't need changes. The replacements above are in-place edits to two distinct ranges; preserve the lines in between.

- [ ] **Step 4: Add a quick mocha test for the skip flag**

Append to `games/bakery-bash/backend/test/revenue.test.js` (created in P2.1):

```js
const { runSimulation } = require('../functions/modules/simulation');
const config = require('../functions/modules/config');

describe('runSimulation skipCostAccounting flag', () => {
  const player = {
    playerId: 'p_a',
    displayName: 'p_a',
    bakeryName: 'p_a',
    decision: {
      menu: { croissant: true, cookie: true, bagel: true },
      quantities: { croissant: 200, cookie: 200, bagel: 200 },
      sousChefCount: 1,
      sousChefAssignments: { croissant: 1 },
      productPrices: { croissant: 4.75, cookie: 4.0, bagel: 4.5 },
    },
    specialtyChefs: [],
    budgetCurrent: 100, // intentionally low to trigger loan-shark
    returningCustomersPending: 0,
    auctionResults: { adWins: [], adBidPaid: 0, chefsWon: [], chefBidPaid: 0 },
    priorSubmittedPrices: [],
    cleanliness_pct: 5, // very low, would normally trigger burglary
  };
  const prefs = { modifiers: { croissant: 1, cookie: 1, bagel: 1 } };

  it('skipCostAccounting=true zeros cost and loan-shark', () => {
    const r = runSimulation([player], prefs, config, { gameId: 'g', round: 1, skipCostAccounting: true })[0];
    assert.equal(r.totalSpent, 0, 'no cost charged');
    assert.equal(r.amountBorrowed, 0, 'no borrow');
    assert.equal(r.interestCharged, 0, 'no interest');
    assert.equal(r.budgetAfter, player.budgetCurrent, 'budget unchanged');
    assert.equal(r.burglary, false, 'no burglary roll');
  });

  it('skipCostAccounting=false (default) preserves prior behavior', () => {
    const r = runSimulation([player], prefs, config)[0];
    assert.ok(r.totalSpent > 0, 'cost should be charged');
    // Loan shark should fire because totalSpent > $100 budget
    assert.ok(r.amountBorrowed > 0, 'loan-shark should fire on overspend');
  });

  it('revenueGross is identical between skip and non-skip modes', () => {
    const skipped = runSimulation([player], prefs, config, { gameId: 'g', round: 1, skipCostAccounting: true })[0];
    const normal = runSimulation([player], prefs, config, { gameId: 'g', round: 1, skipCostAccounting: false })[0];
    assert.equal(skipped.revenueGross, normal.revenueGross, 'gross revenue independent of cost accounting');
  });
});
```

- [ ] **Step 5: Run the new + existing tests**

```bash
cd games/bakery-bash/backend && npx mocha test/revenue.test.js
```

Expected: all tests in revenue.test.js pass (gaussianNoise + skipCostAccounting).

- [ ] **Step 6: Run the integration test for revenue flow**

```bash
cd games/bakery-bash/backend && npm run test:revenue-flow
```

Expected: passes. Day defaults to 0 and skipCostAccounting defaults to false, so backward compat holds. If the test asserts exact revenue values, the noise seed change (`:0:` insertion) will produce different but stable values — adjust assertions to ranges if needed.

- [ ] **Step 7: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/simulation.js \
       games/bakery-bash/backend/test/revenue.test.js
git commit -m "feat(bakery-bash): add day index + skipCostAccounting flag to runSimulation"
```

### Task P2.4: Build the multi-day wrapper

**Files:**
- Create: `games/bakery-bash/backend/functions/modules/multi-day-simulation.js`
- Test: `games/bakery-bash/backend/test/multi-day-simulation.test.js`

- [ ] **Step 1: Write the failing test**

Create `games/bakery-bash/backend/test/multi-day-simulation.test.js`:

```js
const assert = require('node:assert/strict');
const config = require('../functions/modules/config');
const { runMonthlySimulation } = require('../functions/modules/multi-day-simulation');

const fakePlayer = (id) => ({
  playerId: id,
  displayName: id,
  bakeryName: id,
  decision: {
    menu: { croissant: true, cookie: true, bagel: true },
    quantities: { croissant: 200, cookie: 200, bagel: 200 },
    sousChefCount: 1,
    sousChefAssignments: { croissant: 1 },
    productPrices: { croissant: 4.75, cookie: 4.0, bagel: 4.5 },
  },
  specialtyChefs: [],
  budgetCurrent: 10000,
  returningCustomersPending: 0,
  auctionResults: { adWins: [], adBidPaid: 0, chefsWon: [], chefBidPaid: 0 },
  priorSubmittedPrices: [],
});

describe('runMonthlySimulation', () => {
  const prefs = { modifiers: { croissant: 1.0, cookie: 1.0, bagel: 1.0 } };

  it('returns one monthly aggregate per player + an array of daily rows', () => {
    const out = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1',
      round: 1,
    });
    assert.equal(out.length, 1, 'one aggregate per player');
    const agg = out[0];
    assert.ok(Array.isArray(agg.dailyResults), 'has dailyResults array');
    assert.equal(agg.dailyResults.length, config.MULTI_DAY.daysPerRound, '30 daily rows');
  });

  it('monthly revenueGross equals sum of daily revenueGross', () => {
    const out = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1',
      round: 1,
    });
    const agg = out[0];
    const sum = agg.dailyResults.reduce((s, d) => s + d.revenueGross, 0);
    assert.ok(Math.abs(agg.revenueGross - sum) < 0.01, 'monthly gross is sum of daily gross');
  });

  it('charges cost ONCE per month, not 30x', () => {
    // Stock cost = 600 units * $1 = $600. If charged 30x, totalSpent would
    // be $18,000+. The wrapper must call cost accounting only once per month.
    const out = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1',
      round: 1,
    });
    const agg = out[0];
    // Stock cost (600 units * $1) + sous chef hire (1 chef * $10) = ~$610.
    // Allow some headroom but assert it's not 30x what it should be.
    assert.ok(agg.totalSpent < 2000, `expected monthly cost < $2k, got $${agg.totalSpent}`);
  });

  it('does NOT charge loan-shark interest 30x for an overspending team', () => {
    // Force overspend: tiny budget, expensive decisions.
    const broke = { ...fakePlayer('p_a'), budgetCurrent: 100 };
    const out = runMonthlySimulation([broke], prefs, config, { gameId: 'g1', round: 1 });
    const agg = out[0];
    // Real interest on a one-time borrow of (totalSpent - $100) at 10% should
    // be a few hundred at worst, not thousands (which 30x would produce).
    assert.ok(agg.interestCharged < 1000,
      `expected one-time interest < $1k, got $${agg.interestCharged}`);
  });

  it('produces different daily customer counts (variability fires)', () => {
    const out = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1',
      round: 1,
    });
    const counts = out[0].dailyResults.map((d) => d.customerCount);
    const uniq = new Set(counts);
    assert.ok(uniq.size > 1, `expected variety in daily customer counts, got ${counts.join(',')}`);
  });

  it('is deterministic for the same gameId/round (reproducible)', () => {
    const a = runMonthlySimulation([fakePlayer('p_a')], prefs, config, { gameId: 'g1', round: 1 });
    const b = runMonthlySimulation([fakePlayer('p_a')], prefs, config, { gameId: 'g1', round: 1 });
    assert.equal(a[0].revenueGross, b[0].revenueGross, 'same inputs = same outputs');
  });

  it('rolls burglary at most once per month, not once per day', () => {
    const dirtyPlayer = { ...fakePlayer('p_a'), cleanliness_pct: 10 };
    const out = runMonthlySimulation([dirtyPlayer], prefs, config, { gameId: 'g1', round: 1 });
    const burgledDays = out[0].dailyResults.filter((d) => d.burglary).length;
    assert.ok(burgledDays <= 1, `expected ≤1 burgled day, got ${burgledDays}`);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
cd games/bakery-bash/backend && npx mocha test/multi-day-simulation.test.js
```

Expected: FAIL with "Cannot find module '../functions/modules/multi-day-simulation'".

- [ ] **Step 3: Create the module**

Create `games/bakery-bash/backend/functions/modules/multi-day-simulation.js`:

```js
/**
 * multi-day-simulation.js
 *
 * Wraps the pure runSimulation() in a per-day loop. A round represents one
 * month; this module runs daysPerRound (default 30) sub-simulations, each
 * with an independent demand-variability multiplier and noise seed. Returns
 * monthly aggregates with the daily rows attached for CSV export.
 *
 * Cost accounting / loan-shark / burglary / budget update happen ONCE per
 * month at the wrapper level using monthly aggregates, NOT per day. Per-day
 * runSimulation calls use skipCostAccounting=true so they only emit
 * customer / revenue / satisfaction.
 *
 * Pure: no Firebase deps. All randomness goes through seeded utilities or
 * is derived from gameId/round/day so simulations are reproducible.
 */

const config = require('./config');
const { runSimulation } = require('./simulation');
const { calculateRoundCosts } = require('./revenue');
const { calculateLoanShark, updateBudget } = require('./loan-shark');

/**
 * Build a per-day deterministic demand-variability multiplier.
 * Uniform in [min, max], seeded by `${gameId}:${round}:${day}:demand`.
 */
function demandMultiplierForDay(gameId, round, day, cfg = config) {
  const min = cfg.MULTI_DAY.demandVariabilityMin;
  const max = cfg.MULTI_DAY.demandVariabilityMax;
  // Simple deterministic hash → [0, 1)
  const seed = `${gameId}:${round}:${day}:demand`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = ((h >>> 0) / 0xffffffff);
  return min + u * (max - min);
}

/**
 * Apply a per-day multiplier to roundPreferences.modifiers.
 */
function dayPreferences(roundPreferences, dayMult) {
  const baseMods = (roundPreferences && roundPreferences.modifiers)
    ? roundPreferences.modifiers
    : (roundPreferences || {});
  const scaled = {};
  for (const [product, mod] of Object.entries(baseMods)) {
    scaled[product] = (Number(mod) || 1.0) * dayMult;
  }
  return { ...(roundPreferences || {}), modifiers: scaled };
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function runMonthlySimulation(players, roundPreferences, cfg = config, { gameId = 'game', round = 0 } = {}) {
  const days = (cfg.MULTI_DAY && cfg.MULTI_DAY.daysPerRound) || 30;

  // Run N daily sims. skipCostAccounting=true means each daily call only
  // produces customer / revenue / satisfaction outputs (no cost, no
  // loan-shark, no burglary, no budget update). The wrapper handles all of
  // those once at the monthly level below.
  const dailyResultsByPlayer = new Map();
  for (const p of players) {
    dailyResultsByPlayer.set(p.playerId, []);
  }

  for (let day = 0; day < days; day += 1) {
    const dayMult = demandMultiplierForDay(gameId, round, day, cfg);
    const dayPrefs = dayPreferences(roundPreferences, dayMult);
    const dayResults = runSimulation(players, dayPrefs, cfg, {
      gameId, round, day, skipCostAccounting: true,
    });
    for (const r of dayResults) {
      dailyResultsByPlayer.get(r.playerId).push({ day, ...r });
    }
  }

  // Build monthly aggregates per player.
  const monthlyResults = [];
  for (const p of players) {
    const daily = dailyResultsByPlayer.get(p.playerId) || [];

    const sum = (k) => daily.reduce((s, d) => s + (Number(d[k]) || 0), 0);
    const avg = (k) => daily.length ? sum(k) / daily.length : 0;

    // Monthly aggregate gross revenue = sum of daily gross revenues.
    // (revenueGross from runSimulation includes per-day product revenue +
    // base + sous + sat + numProducts coefficients + ad bonus + noise. The
    // skipCostAccounting flag does NOT affect revenueGross — it just zeros
    // out cost/loan-shark/budget.)
    const revenueGross = sum('revenueGross');
    const customerCount = sum('customerCount');
    const aggregateSatisfactionPct = avg('aggregateSatisfactionPct');
    const chefSatisfactionScore = daily.length ? daily[0].chefSatisfactionScore : 0;
    const last = daily[daily.length - 1] || {};

    // ---- Compute MONTHLY cost / loan-shark / budget ONCE ----
    const decision = (p && p.decision) || {};
    const sousChefCount = Number.isFinite(decision.sousChefCount)
      ? decision.sousChefCount
      : Number(p.sousChefCount) || 0;
    const auctionResults = (p && p.auctionResults) || {};
    const adBidPaid = _num(auctionResults.adBidPaid);
    const chefBidPaid = _num(auctionResults.chefBidPaid);

    const costDecision = {
      perProductQtyStocked: decision.quantities || {},
      sousChefCount,
    };
    const costAuction = {
      adAuctionWinningBid: adBidPaid,
      chefAuctionWinningBid: chefBidPaid,
    };
    const roundCosts = calculateRoundCosts(costDecision, costAuction, cfg);
    const totalSpent = roundCosts.totalSpent;

    const budgetCurrent = _num(p.budgetCurrent);
    const loanResult = calculateLoanShark(totalSpent, budgetCurrent, cfg);
    const amountBorrowed = loanResult.borrowed;
    const interestCharged = loanResult.interest;
    const loanSharkDeduction = loanResult.loanSharkDeduction;
    const revenueNet = revenueGross - loanSharkDeduction;
    const budgetAfter = Math.round(updateBudget(budgetCurrent, revenueNet, totalSpent));

    // ---- Roll burglary ONCE per month ----
    const burglaryThreshold = (cfg && cfg.curveballs && cfg.curveballs.burglaryThreshold) || 40;
    const burglaryChance = (cfg && cfg.curveballs && cfg.curveballs.burglaryChance) || 0.25;
    const burglaryAmount = (cfg && cfg.curveballs && cfg.curveballs.burglaryAmount) || 10000;
    let burglary = false;
    let actualBurglaryAmount = 0;
    let budgetAfterBurglary = budgetAfter;
    if (typeof p.cleanliness_pct === 'number'
        && p.cleanliness_pct < burglaryThreshold
        && Math.random() < burglaryChance) {
      burglary = true;
      actualBurglaryAmount = burglaryAmount;
      budgetAfterBurglary = Math.max(0, budgetAfter - burglaryAmount);
    }
    // Mark the middle day as the burglary day so the daily breakdown shows where it hit.
    const burgledDayIndex = burglary ? Math.floor(daily.length / 2) : -1;
    if (burglary && daily[burgledDayIndex]) {
      daily[burgledDayIndex].burglary = true;
      daily[burgledDayIndex].burglaryAmount = actualBurglaryAmount;
    }

    monthlyResults.push({
      playerId: p.playerId,
      displayName: p.displayName,
      bakeryName: p.bakeryName,
      revenueGross,
      revenueNet,
      amountBorrowed,
      interestCharged,
      totalSpent,
      budgetAfter: budgetAfterBurglary,
      customerCount,
      perProductCustomers: last.perProductCustomers || {},
      aggregateSatisfactionPct,
      chefSatisfactionScore,
      perProductSatisfaction: last.perProductSatisfaction || {},
      returningCustomersEarned: last.returningCustomersEarned || 0,
      selloutAnywhere: daily.some((d) => d.selloutAnywhere),
      adWon: last.adWon,
      adWins: last.adWins,
      adBidPaid: last.adBidPaid,
      chefsWon: last.chefsWon,
      chefBidPaid: last.chefBidPaid,
      csvRow: last.csvRow,
      productPrices: last.productPrices,
      revenueBreakdown: last.revenueBreakdown,
      burglary,
      burglaryAmount: actualBurglaryAmount,
      // Daily breakdown for CSV per-day rows.
      dailyResults: daily.map((d) => ({
        day: d.day,
        revenueGross: d.revenueGross,
        revenueNet: d.revenueGross, // per-day net = gross (no per-day cost; cost is monthly)
        customerCount: d.customerCount,
        aggregateSatisfactionPct: d.aggregateSatisfactionPct,
        perProductCustomers: d.perProductCustomers,
        perProductSatisfaction: d.perProductSatisfaction,
        burglary: d.burglary || false,
        burglaryAmount: d.burglaryAmount || 0,
        csvRow: d.csvRow,
      })),
    });
  }

  return monthlyResults;
}

module.exports = {
  runMonthlySimulation,
  demandMultiplierForDay,
};
```

- [ ] **Step 4: Run test, confirm it passes**

```bash
cd games/bakery-bash/backend && npx mocha test/multi-day-simulation.test.js
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/multi-day-simulation.js \
       games/bakery-bash/backend/test/multi-day-simulation.test.js
git commit -m "feat(bakery-bash): add multi-day simulation wrapper (30 days/round)"
```

### Task P2.5: Wire multi-day into runSimulationAndPersist

**Files:**
- Modify: `games/bakery-bash/backend/functions/index.js:1865-2240`

- [ ] **Step 1: Replace the runSimulation call with the multi-day wrapper**

In `runSimulationAndPersist`, find:

```js
const results = runSimulation(players, prefs, config, { gameId: gameRef.id, round });
```

Replace with:

```js
const { runMonthlySimulation } = require('./modules/multi-day-simulation');
const results = runMonthlySimulation(players, prefs, config, { gameId: gameRef.id, round });
```

(`runMonthlySimulation` returns the same shape as `runSimulation` plus a `dailyResults` field. Existing code that consumes `results[i].revenueNet`, `results[i].customerCount`, etc. continues to work — those are the monthly aggregates.)

- [ ] **Step 2: Persist daily rows to a new subcollection**

After the existing batch writes for `playerRoundRef` and `csvRowRef`, add (still inside the `for (const memberDoc of memberDocs)` loop, after `batch.set(csvRowRef, ...)`):

```js
      // P2: per-day CSV rows for re-training. Stored under
      // games/{id}/csvRows/{uid}/rounds/{roundId}/days/{dayId}.
      const daily = Array.isArray(r.dailyResults) ? r.dailyResults : [];
      for (const d of daily) {
        if (opsInBatch + 1 > BATCH_OP_LIMIT) {
          batches.push(batch);
          batch = db.batch();
          opsInBatch = 0;
        }
        const dayDocId = `day_${String(d.day).padStart(2, '0')}`;
        const dayRef = gameRef
          .collection('csvRows')
          .doc(memberDoc.id)
          .collection('rounds')
          .doc(roundId)
          .collection('days')
          .doc(dayDocId);
        batch.set(dayRef, {
          round,
          day: d.day,
          playerId: memberDoc.id,
          row: {
            ...(d.csvRow || {}),
            day: d.day,
            player_id: memberDoc.id,
            display_name: memberData.displayName || r.displayName,
            bakery_name: r.bakeryName,
          },
          writtenAt: FieldValue.serverTimestamp(),
        });
        opsInBatch += 1;
      }
```

- [ ] **Step 3: Surface dailyResults on lastRoundResult so the frontend can read it**

In the `playerUpdate.lastRoundResult` block (added/edited in P1.1), add:

```js
        dailyBreakdown: Array.isArray(r.dailyResults)
          ? r.dailyResults.map((d) => ({
              day: d.day,
              revenueNet: d.revenueNet,
              customerCount: d.customerCount,
              aggregateSatisfactionPct: d.aggregateSatisfactionPct,
            }))
          : [],
```

- [ ] **Step 4: Run integration test for revenue flow**

```bash
cd games/bakery-bash/backend && npm run test:revenue-flow
```

Expected: passes. Per-round monthly aggregates should match what the test expects (within tolerance — Gaussian noise is now per-day so monthly noise is √30 × per-day noise; if exact-equality assertions exist, loosen them to a band).

- [ ] **Step 5: Commit**

```bash
git add games/bakery-bash/backend/functions/index.js
git commit -m "feat(bakery-bash): persist per-day CSV rows under rounds/{roundId}/days/{dayId}"
```

### Task P2.6: Aggregate daily rows in the student CSV download

**Files:**
- Modify: `games/bakery-bash/app/src/components/game/RoundHeader.tsx`

- [ ] **Step 1: Add `day` column to CSV_COLUMNS**

Insert `"day"` immediately after `"round"` in the schema (top of CSV_COLUMNS).

- [ ] **Step 2: Update the type and serializer to support per-day rows**

In `serializeRow`, add `day` to the destructure and emit it as the second column. Type the input as `RoundResult & { day?: number }`.

In `downloadResultsCsv`, change the iteration:

```ts
export function downloadResultsCsv(results: RoundResult[]) {
  const header = CSV_COLUMNS.join(",");
  const rows: string[] = [];
  for (const r of results) {
    const daily = (r as RoundResult & {
      dailyBreakdown?: Array<{ day: number; revenueNet: number; customerCount: number; aggregateSatisfactionPct: number }>;
    }).dailyBreakdown ?? [];
    if (daily.length > 0) {
      // emit one row per day, carrying the round-level decision inputs +
      // the daily outcome metrics
      for (const d of daily) {
        rows.push(serializeRow({ ...r, day: d.day, revenueNet: d.revenueNet, customerCount: d.customerCount, customerSatisfaction: d.aggregateSatisfactionPct }));
      }
    } else {
      // legacy / pre-P2 round — emit one row with day = 0
      rows.push(serializeRow({ ...r, day: 0 }));
    }
  }
  const blob = new Blob([header + "\n" + rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "bakery-bash-results.csv";
  a.click();
  URL.revokeObjectURL(url);
}
```

> **Note on outcome columns when emitting daily rows:** the daily rows currently only carry `revenueNet`, `customerCount`, and `aggregateSatisfactionPct`. Per-day breakdowns of units sold and per-product satisfaction would require adding more fields to `dailyBreakdown` (Step 3 of P2.5). For the MVP, emit per-day rows with **decision inputs constant across the round** + **daily outcome aggregates**, and leave `croissants_sold` etc. as the monthly value on every daily row (clearly noted in the column header comment if helpful). Refine in a follow-up if the lossy daily product breakdown matters for student modeling.

- [ ] **Step 3: Typecheck**

```bash
cd games/bakery-bash/app && npm run typecheck
```

Expected: passes. If the type cast around `dailyBreakdown` complains, also add the field to the `RoundResult` interface in `types/game.ts` as an optional array.

- [ ] **Step 4: Commit**

```bash
git add games/bakery-bash/app/src/components/game/RoundHeader.tsx \
       games/bakery-bash/app/src/types/game.ts
git commit -m "feat(bakery-bash): emit one CSV row per day for re-training"
```

### Task P2.7: Sanity-check Results screen still shows correct monthly KPIs

**Files:**
- Inspect: `games/bakery-bash/app/src/pages/phases/ResultsPhase.tsx`

- [ ] **Step 1: Boot the emulator and play a round**

```bash
cd games/bakery-bash/backend && firebase emulators:start --project bakery-bash-54d12
```

App in second terminal: `cd games/bakery-bash/app && npm run dev`. Join two players, advance round 1.

- [ ] **Step 2: Verify Results screen monthly KPIs are reasonable**

Confirm:
- `Profit` ≈ what a single-day run would produce × ~30 (roughly; demand variability adds spread)
- `Customers` ≈ ~30× a single-day count
- `Satisfaction` average around the previous single-day level
- Auction outcomes shown correctly
- No JS errors in browser console

- [ ] **Step 3: Download CSV and verify**

Open the downloaded file. Confirm:
- 30 rows per round per team (not 1)
- `day` column ranges 0–29
- Decision inputs (price, qty_stocked, num_products, ad bid, chef bid, sous chef counts) are **identical across all 30 days for the same round** (correct — same decisions)
- `revenue_net`, `customer_count`, `customer_satisfaction` **vary day to day** (correct — demand variability)

- [ ] **Step 4: Commit verification notes (no code change required if all passes)**

If the Results screen breaks due to scale (e.g., monthly customer count overflowing a UI element), file a follow-up issue rather than fixing in this PR. UI polish is out of scope.

### Task P2.8: Backwards-compat shim for legacy round docs

**Files:**
- Inspect: `games/bakery-bash/app/src/components/game/CsvInboxModal.tsx`
- Possibly modify: read path for cumulative CSV history

- [ ] **Step 1: Determine whether the CSV download reads from `lastRoundResult.dailyBreakdown` or queries Firestore**

Read `CsvInboxModal.tsx` and trace where `roundResults` originates. If it pulls from `lastRoundResult` only, the `?? []` fallback in P2.6 covers legacy data. If it queries `csvRows/{uid}/rounds/{roundId}` directly, ensure the read path also looks for the `days` subcollection and includes daily rows.

- [ ] **Step 2: If a Firestore query change is needed, add it; otherwise no action**

If the read path needs updating, modify the query to include the daily subcollection. Pre-P2 rounds without daily docs continue to fall back to a single row per round.

- [ ] **Step 3: Commit if changed**

```bash
git add games/bakery-bash/app/src/components/game/CsvInboxModal.tsx
git commit -m "feat(bakery-bash): include daily CSV rows in cumulative history download"
```

---

## Validation Checklist

After both P1 and P2 land:

- [ ] Student CSV downloaded after round 1 has 40 columns: `round, day, revenue_net, ..., num_products, price_*, *_qty_stocked, ..., *_sold` (27 original + 13 P1 new + `day`)
- [ ] CSV has 30 rows per round per team (one per simulated day)
- [ ] Decision-input columns are constant across the 30 days of a round (sanity: same decision → same X)
- [ ] Outcome columns (revenue, customers, satisfaction) vary day to day (sanity: demand variability fires)
- [ ] Monthly KPIs on Results screen match sums/means of the daily values
- [ ] `npm run test:revenue-flow` passes
- [ ] `npx mocha test/` passes (gaussianNoise + multi-day-simulation tests)
- [ ] No regressions in `npm run test:rules` (Firestore rules unchanged)
- [ ] Frontend `npm run typecheck` and `npm run lint` pass
- [ ] Manual smoke: 2 teams × 2 rounds in emulator → both teams' CSVs have 60 rows each

---

## Rollout

- Feature flag is **not required** — this is additive (more CSV columns + more CSV rows). Existing consumers continue to work.
- Backfill is **not required** — pre-P2 round docs without `dailyBreakdown` fall back to single-row CSV per round (P2.8 shim).
- Coordinate ship with the live session date so students don't see schema changes mid-game. If the session is imminent, ship to a staging Firebase project first.
- Update the data dictionary / student-facing communication to reflect the new columns. Specifically tell students:
  - Each round now produces 30 rows of daily outcomes (you have ~30× more rows for re-training)
  - The decision input columns are the *same* across all 30 days of a round (because you only made one set of decisions for that month)
  - Daily revenue/customer counts vary because of demand variability — this is intentional realism

---

## Open Design Question — P3 (Cross-Team CSV Pooling)

**Decision needed before / soon after this PR ships:**

Should each team be able to download not just their own round-by-round CSV, but also **anonymized** CSVs of *other teams* at the end of each round (or end of game)?

### Why this matters

From [analysis/FINDINGS.md §4](../FINDINGS.md): the multi-day simulation gives more *Y observations per X* per team but **does not give more X variation per team** (each team still only makes 5 strategic decisions). For per-team regression coefficients to actually improve via in-game data, students need to see other teams' decisions too.

With cross-team pooling:
- Each team has 5 own X vectors + 11 other teams × 5 = 55 X vectors → 60 distinct X with which to fit a regression
- Combined with P2's 30 daily rows: 60 × 30 = 1800 total rows per team
- This is what unlocks the §4 simulation's "online learning starts mattering at 150+ obs" payoff

Without it, students get 5 own X vectors × 30 days = 5 X with 30 Y each → great for *Y uncertainty estimation* but not *coefficient learning*.

### Trade-offs

| Pro | Con |
|---|---|
| Real re-training payoff (X variation) | Reduces strategic privacy — teams can see what worked for opponents |
| Simulates the dataset's "I got data from many bakeries" framing | Risks model convergence — everyone trains on the same pool, ends up with similar predictions |
| Aligns with how the original dataset was framed (cross-bakery survey) | Requires anonymization (team names removed); may need a separate "study CSV" doc to avoid leaking opponent identity in the live leaderboard |
| Cheap — release at end-of-round, no pacing impact | Requires a small backend handler (`exportPooledRoundCsv` callable) + frontend "Download class data" button |

### Two options if you decide yes

**Option A: Release pool at end of each round.** Each team can download all teams' rows for completed rounds. Encourages mid-game re-training. Maximal pedagogical lift but also maximal opponent intelligence.

**Option B: Release pool at end of game only.** Used as a post-game lab/analysis exercise. No mid-game opponent intel, but no in-game re-training value either — pedagogy becomes "here's how your model would have done if you'd had richer data."

### Recommendation

Decide before this PR merges so the schema can be finalized. If you choose Option A, add a feature-flagged `exportPooledRoundCsv` Cloud Function in a follow-up PR. If you choose Option B, no code change needed beyond what this PR ships — the professor can hand out the combined CSV manually after the game.

---

## File index

- [analysis/FINDINGS.md](../FINDINGS.md) — context for why these changes
- [analysis/scripts/06_retraining_feasibility.py](../scripts/06_retraining_feasibility.py) — simulation supporting the multi-day rationale
- [analysis/scripts/05_noise_features_bias.py](../scripts/05_noise_features_bias.py) — supporting evidence for the parallel pedagogical guidance (drop noise features before training)
