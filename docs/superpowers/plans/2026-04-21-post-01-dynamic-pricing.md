# POST-01 — Per-Product Dynamic Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship per-product dynamic pricing controlled by the Finance role — continuous elasticity, floor demand bonus, pool-conserving allocation weight, $0.25 granularity, clamped at ceiling, 6 new CSV columns.

**Architecture:** Pure backend modules (no Firebase in math paths) own all pricing logic. A new `pricing.js` module exposes `classifyZone`, `calculatePriceDemandMultiplier`, `snapPriceToStep`, `clampPrice`, `resolvePriceForSim` — used by `customer-allocation.js`, `revenue.js`, `simulation.js`, `decision-validation.js`, and `csv-export.js`. Frontend mirrors the pure functions in `lib/pricing.ts` so price zones + clamping render the same on both sides. A new `submitPrices` Cloud Function is Finance-role-gated (mirrors `submitBids` role-gating pattern from BE-21).

**Tech Stack:** Node 22 Firebase Cloud Functions (CommonJS), Firestore, React 19 + TypeScript + Vite, zero-dep custom test runner (`backend/functions/modules/__tests__/test-suite.js`).

**Reference spec:** `docs/superpowers/specs/2026-04-21-post-01-dynamic-pricing-design.md`

---

## File Structure

### Backend (CommonJS — no TypeScript)

| File | Action | Responsibility |
|---|---|---|
| `games/bakery-bash/backend/functions/modules/config.js` | modify | Add `PRICE_ZONES`, `ELASTICITY_COEFFICIENTS`, `PRICE_STEP`, `FLOOR_BONUS`, `MULTIPLIER_FLOOR` |
| `games/bakery-bash/backend/functions/modules/pricing.js` | **create** | Pure pricing math — `classifyZone`, `calculatePriceDemandMultiplier`, `snapPriceToStep`, `clampPrice`, `resolvePriceForSim` |
| `games/bakery-bash/backend/functions/modules/decision-validation.js` | modify | Add `validateProductPrices` |
| `games/bakery-bash/backend/functions/modules/customer-allocation.js` | modify | Multiply `priceDemandMultiplier` into the weight |
| `games/bakery-bash/backend/functions/modules/revenue.js` | modify | `calculateProductRevenue` accepts per-player prices (not catalog `fixedPrice`) |
| `games/bakery-bash/backend/functions/modules/simulation.js` | modify | Load `productPrices`, resolve carry-over, thread into allocation + revenue |
| `games/bakery-bash/backend/functions/modules/csv-export.js` | modify | Append `price_<product>` columns in qty block |
| `games/bakery-bash/backend/functions/index.js` | modify | Add `submitPrices` callable (Finance-gated); extend round-advance sim to pull prices |
| `games/bakery-bash/backend/firestore.rules` | modify | Allow `productPrices` map on `decisions/{round}` |
| `games/bakery-bash/backend/functions/modules/__tests__/test-suite.js` | modify | Add `pricing.js` test suite + allocation/revenue integration |
| `games/bakery-bash/backend/functions/modules/__tests__/test-compliance.js` | modify | Assert zone ordering, elasticity coefficient keys |
| `games/bakery-bash/backend/functions/modules/__tests__/test-adversarial.js` | modify | Price validation edge cases |
| `games/bakery-bash/backend/functions/modules/__tests__/test-stress.js` | modify | Randomized prices across 20 players |

### Frontend (TypeScript + React 19)

| File | Action | Responsibility |
|---|---|---|
| `games/bakery-bash/app/src/types/game.ts` | modify | Add `PriceZone`, extend `PendingDecisionDraft` with `productPrices`, extend `MenuItem` with `priceFloor`/`priceCeiling`/`elasticityTier` |
| `games/bakery-bash/app/src/lib/pricing.ts` | **create** | Client-side mirrors of `classifyZone`, `snapPriceToStep`, `clampPrice` (same formulas as backend, pure TS) |
| `games/bakery-bash/app/src/components/game/PriceInput.tsx` | **create** | Numeric input + $0.25 nudge buttons + zone badge; role-gated disabled state |
| `games/bakery-bash/app/src/components/game/BakeryView.tsx` | modify | Add `<PriceInput>` per product row beside qty |
| `games/bakery-bash/app/src/pages/GamePage.tsx` | modify | Wire `submitPrices` callable; add Finance "Submit Prices" button |

### Docs

| File | Action | Responsibility |
|---|---|---|
| `games/bakery-bash/BACKEND.md` | modify | Document `PRICE_ZONES`, elasticity coefficients, carry-over semantics |
| `games/bakery-bash/projectRoadmap.md` | modify | Flip POST-01 from `[ ]` to `[x]` once shipped |

---

## Execution Order Rationale

Pure backend first (Tasks 1–10) so the math is fully tested before anything hits Firestore. Then the Cloud Function surface (Tasks 11–13: callable, orchestration, rules). Then frontend (Tasks 14–18) on top of a working backend. Integration/adversarial/stress tests at the end (Tasks 19–21) when both sides can be exercised end-to-end. Docs last (Task 22).

---

## Task 1: Add pricing config constants to `config.js`

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/config.js`
- Test: `games/bakery-bash/backend/functions/modules/__tests__/test-compliance.js`

- [ ] **Step 1: Write failing compliance test**

Add to `test-compliance.js` after the existing `PRODUCT_CATALOG` compliance block (find the block that checks `fixedPrice` per product and append immediately after):

```js
describe('pricing zones (POST-01)', () => {
  const {
    PRICE_ZONES,
    ELASTICITY_COEFFICIENTS,
    PRICE_STEP,
    FLOOR_BONUS,
    MULTIPLIER_FLOOR,
    PRODUCT_KEYS,
  } = require('../config');

  it('PRICE_ZONES has all 6 products', () => {
    for (const p of PRODUCT_KEYS) {
      ok(PRICE_ZONES[p], `PRICE_ZONES missing ${p}`);
    }
  });

  it('each product has well-ordered zone bounds', () => {
    for (const p of PRODUCT_KEYS) {
      const z = PRICE_ZONES[p];
      ok(z.floor < z.competitiveRangeLow,    `${p}: floor < competitiveRangeLow`);
      ok(z.competitiveRangeLow < z.competitiveRangeHigh, `${p}: competitiveRangeLow < competitiveRangeHigh`);
      ok(z.competitiveRangeHigh <= z.premiumRangeLow,    `${p}: competitiveRangeHigh <= premiumRangeLow`);
      ok(z.premiumRangeLow < z.premiumRangeHigh, `${p}: premiumRangeLow < premiumRangeHigh`);
      ok(z.premiumRangeHigh <= z.ceiling,       `${p}: premiumRangeHigh <= ceiling`);
    }
  });

  it('elasticity tiers are all High/Medium/Low', () => {
    for (const p of PRODUCT_KEYS) {
      const tier = PRICE_ZONES[p].elasticityTier;
      ok(['high', 'medium', 'low'].includes(tier), `${p}: tier ${tier}`);
    }
  });

  it('ELASTICITY_COEFFICIENTS covers each referenced tier', () => {
    near(ELASTICITY_COEFFICIENTS.high, 1.5, 0.001, 'high');
    near(ELASTICITY_COEFFICIENTS.medium, 1.0, 0.001, 'medium');
    near(ELASTICITY_COEFFICIENTS.low, 0.6, 0.001, 'low');
  });

  it('constants match spec', () => {
    near(PRICE_STEP, 0.25, 0.001, 'PRICE_STEP');
    near(FLOOR_BONUS, 0.15, 0.001, 'FLOOR_BONUS');
    near(MULTIPLIER_FLOOR, 0.1, 0.001, 'MULTIPLIER_FLOOR');
  });

  it('Coffee zone matches proposal table', () => {
    const z = PRICE_ZONES.coffee;
    near(z.floor, 2.00, 0.001);
    near(z.competitiveRangeLow, 3.00, 0.001);
    near(z.competitiveRangeHigh, 4.50, 0.001);
    near(z.premiumRangeLow, 5.00, 0.001);
    near(z.premiumRangeHigh, 6.00, 0.001);
    near(z.ceiling, 6.50, 0.001);
    eq(z.elasticityTier, 'high');
  });

  it('Matcha zone matches proposal table', () => {
    const z = PRICE_ZONES.matcha;
    near(z.floor, 3.50, 0.001);
    near(z.competitiveRangeLow, 5.50, 0.001);
    near(z.competitiveRangeHigh, 7.00, 0.001);
    near(z.premiumRangeLow, 7.50, 0.001);
    near(z.premiumRangeHigh, 9.00, 0.001);
    near(z.ceiling, 10.00, 0.001);
    eq(z.elasticityTier, 'low');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-compliance.js
```
Expected: FAIL with `PRICE_ZONES missing coffee` (or similar — the constants don't exist yet).

- [ ] **Step 3: Add constants to `config.js`**

Open `games/bakery-bash/backend/functions/modules/config.js`. After the existing `PRODUCT_CATALOG` block and before any exports, add:

```js
// ---------------------------------------------------------------------------
// POST-01: Per-product dynamic pricing configuration
// ---------------------------------------------------------------------------

/**
 * Per-product price zones. Values from GAME_DESIGN_PROPOSAL.md "Price Points
 * Per Product". A player-submitted price is clamped to [floor, ceiling] and
 * classified into one of three zones:
 *   Floor:       floor <= price < competitiveRangeLow
 *   Competitive: competitiveRangeLow <= price < premiumRangeLow
 *   Premium:     premiumRangeLow <= price <= ceiling
 */
const PRICE_ZONES = {
  coffee:    { floor: 2.00, competitiveRangeLow: 3.00, competitiveRangeHigh: 4.50,
               premiumRangeLow: 5.00, premiumRangeHigh: 6.00, ceiling: 6.50,  elasticityTier: 'high'   },
  croissant: { floor: 2.50, competitiveRangeLow: 4.00, competitiveRangeHigh: 5.50,
               premiumRangeLow: 6.00, premiumRangeHigh: 7.00, ceiling: 8.00,  elasticityTier: 'medium' },
  bagel:     { floor: 1.50, competitiveRangeLow: 2.50, competitiveRangeHigh: 3.50,
               premiumRangeLow: 4.00, premiumRangeHigh: 5.00, ceiling: 5.50,  elasticityTier: 'high'   },
  cookie:    { floor: 1.00, competitiveRangeLow: 2.00, competitiveRangeHigh: 3.00,
               premiumRangeLow: 3.50, premiumRangeHigh: 4.50, ceiling: 5.00,  elasticityTier: 'high'   },
  sandwich:  { floor: 5.00, competitiveRangeLow: 7.50, competitiveRangeHigh: 10.00,
               premiumRangeLow: 10.50, premiumRangeHigh: 12.50, ceiling: 14.00, elasticityTier: 'medium' },
  matcha:    { floor: 3.50, competitiveRangeLow: 5.50, competitiveRangeHigh: 7.00,
               premiumRangeLow: 7.50, premiumRangeHigh: 9.00, ceiling: 10.00, elasticityTier: 'low'    },
};

/** Point-elasticity coefficient by product tier. */
const ELASTICITY_COEFFICIENTS = { high: 1.5, medium: 1.0, low: 0.6 };

/** Grid size for player-submitted prices. */
const PRICE_STEP = 0.25;

/** Discrete demand bump when a product's price is in the Floor zone. */
const FLOOR_BONUS = 0.15;

/** Lower bound on the per-player demand multiplier — keeps allocation share non-zero. */
const MULTIPLIER_FLOOR = 0.1;
```

Append these names to the `module.exports = { ... }` block near the bottom of `config.js`:

```js
module.exports = {
  // ...existing exports unchanged...
  PRICE_ZONES,
  ELASTICITY_COEFFICIENTS,
  PRICE_STEP,
  FLOOR_BONUS,
  MULTIPLIER_FLOOR,
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-compliance.js
```
Expected: all pricing-zone assertions pass (no `FAIL:` lines for the new `pricing zones (POST-01)` describe block).

- [ ] **Step 5: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/config.js \
        games/bakery-bash/backend/functions/modules/__tests__/test-compliance.js
git commit -m "POST-01: add price zones + elasticity constants to config"
```

---

## Task 2: Create `pricing.js` with `classifyZone`

**Files:**
- Create: `games/bakery-bash/backend/functions/modules/pricing.js`
- Test: `games/bakery-bash/backend/functions/modules/__tests__/test-suite.js`

- [ ] **Step 1: Write failing test**

Append to `test-suite.js`. Find a good home just after the existing `describe('config.js', ...)` block. Add:

```js
const pricing = require('../pricing');

describe('pricing.js — classifyZone', () => {
  const { PRICE_ZONES } = require('../config');
  const coffee = PRICE_ZONES.coffee; // floor=2, cLow=3, cHigh=4.5, pLow=5, pHigh=6, ceiling=6.5

  it('floor inclusive lower bound', () => {
    eq(pricing.classifyZone(2.00, coffee), 'floor');
  });
  it('just below competitiveRangeLow stays floor', () => {
    eq(pricing.classifyZone(2.75, coffee), 'floor');
  });
  it('competitiveRangeLow inclusive lower bound', () => {
    eq(pricing.classifyZone(3.00, coffee), 'competitive');
  });
  it('mid competitive', () => {
    eq(pricing.classifyZone(4.00, coffee), 'competitive');
  });
  it('just below premiumRangeLow stays competitive', () => {
    eq(pricing.classifyZone(4.75, coffee), 'competitive');
  });
  it('premiumRangeLow inclusive lower bound', () => {
    eq(pricing.classifyZone(5.00, coffee), 'premium');
  });
  it('ceiling inclusive upper bound', () => {
    eq(pricing.classifyZone(6.50, coffee), 'premium');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: FAIL with `Cannot find module '../pricing'`.

- [ ] **Step 3: Create `pricing.js` with `classifyZone`**

Create `games/bakery-bash/backend/functions/modules/pricing.js`:

```js
/**
 * pricing.js — Pure POST-01 pricing math.
 *
 * No Firebase. No state. Operates on per-product config from config.PRICE_ZONES.
 */

const {
  PRICE_ZONES,
  ELASTICITY_COEFFICIENTS,
  PRICE_STEP,
  FLOOR_BONUS,
  MULTIPLIER_FLOOR,
  PRODUCT_CATALOG,
} = require('./config');

/**
 * Return the zone label ('floor' | 'competitive' | 'premium') for a price.
 * Zones are mutually exclusive and cover [floor, ceiling] with no gaps.
 *
 * @param {number} price
 * @param {object} productCfg - one entry of PRICE_ZONES
 * @returns {'floor' | 'competitive' | 'premium'}
 */
function classifyZone(price, productCfg) {
  if (price >= productCfg.premiumRangeLow) return 'premium';
  if (price >= productCfg.competitiveRangeLow) return 'competitive';
  return 'floor';
}

module.exports = {
  classifyZone,
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: the 7 `classifyZone` tests pass.

- [ ] **Step 5: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/pricing.js \
        games/bakery-bash/backend/functions/modules/__tests__/test-suite.js
git commit -m "POST-01: add classifyZone in new pricing.js module"
```

---

## Task 3: Add `calculatePriceDemandMultiplier`

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/pricing.js`
- Test: `games/bakery-bash/backend/functions/modules/__tests__/test-suite.js`

- [ ] **Step 1: Write failing test**

Append after the `classifyZone` block in `test-suite.js`:

```js
describe('pricing.js — calculatePriceDemandMultiplier', () => {
  const { PRICE_ZONES } = require('../config');
  const coffee = PRICE_ZONES.coffee;   // high elasticity (e=1.5), competitiveMid = (3+4.5)/2 = 3.75
  const matcha = PRICE_ZONES.matcha;   // low elasticity (e=0.6), competitiveMid = (5.5+7)/2 = 6.25
  const croissant = PRICE_ZONES.croissant; // medium elasticity (e=1.0)

  it('coffee at floor $2.00 → 1.85 (floor bonus + elasticity bump)', () => {
    near(pricing.calculatePriceDemandMultiplier(2.00, coffee), 1.85, 0.01);
  });
  it('coffee at $2.75 still in floor zone → 1.55', () => {
    near(pricing.calculatePriceDemandMultiplier(2.75, coffee), 1.55, 0.01);
  });
  it('coffee at $3.00 (competitive) → 1.30 (step-down, no floor bonus)', () => {
    near(pricing.calculatePriceDemandMultiplier(3.00, coffee), 1.30, 0.01);
  });
  it('coffee at competitiveMid $3.75 → 1.00', () => {
    near(pricing.calculatePriceDemandMultiplier(3.75, coffee), 1.00, 0.01);
  });
  it('coffee at $4.50 → 0.70', () => {
    near(pricing.calculatePriceDemandMultiplier(4.50, coffee), 0.70, 0.01);
  });
  it('coffee at $5.00 (premium) → 0.50', () => {
    near(pricing.calculatePriceDemandMultiplier(5.00, coffee), 0.50, 0.01);
  });
  it('coffee at ceiling $6.50 → floored at 0.10', () => {
    near(pricing.calculatePriceDemandMultiplier(6.50, coffee), 0.10, 0.01);
  });
  it('matcha at floor $3.50 → 1.414 (low elasticity so bump is smaller)', () => {
    near(pricing.calculatePriceDemandMultiplier(3.50, matcha), 1.414, 0.01);
  });
  it('matcha at competitiveMid $6.25 → 1.00', () => {
    near(pricing.calculatePriceDemandMultiplier(6.25, matcha), 1.00, 0.01);
  });
  it('matcha at ceiling $10.00 → 0.64 (low-elasticity premium still viable)', () => {
    near(pricing.calculatePriceDemandMultiplier(10.00, matcha), 0.64, 0.01);
  });
  it('croissant at competitiveMid $4.75 → 1.00', () => {
    near(pricing.calculatePriceDemandMultiplier(4.75, croissant), 1.00, 0.01);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: FAIL with `calculatePriceDemandMultiplier is not a function`.

- [ ] **Step 3: Add implementation to `pricing.js`**

In `games/bakery-bash/backend/functions/modules/pricing.js`, insert after `classifyZone`:

```js
/**
 * Demand multiplier applied per player per product. Combines:
 *   - continuous point-elasticity centered on the midpoint of the
 *     competitive range (e × %ΔP)
 *   - a discrete +FLOOR_BONUS demand bump when the price sits in the
 *     Floor zone
 *   - a hard lower bound of MULTIPLIER_FLOOR so ceiling-priced
 *     high-elasticity products still receive a nonzero allocation share.
 *
 * @param {number} price
 * @param {object} productCfg - one entry of PRICE_ZONES
 * @returns {number} multiplier in [MULTIPLIER_FLOOR, ∞), typically [0.1, 2.0]
 */
function calculatePriceDemandMultiplier(price, productCfg) {
  const competitiveMid =
    (productCfg.competitiveRangeLow + productCfg.competitiveRangeHigh) / 2;
  const zone = classifyZone(price, productCfg);
  const floorBonus = zone === 'floor' ? FLOOR_BONUS : 0;
  const elasticity = ELASTICITY_COEFFICIENTS[productCfg.elasticityTier];
  const pctDeltaP = (price - competitiveMid) / competitiveMid;
  const elasticityEffect = -elasticity * pctDeltaP;
  return Math.max(MULTIPLIER_FLOOR, 1 + floorBonus + elasticityEffect);
}
```

Update the exports:

```js
module.exports = {
  classifyZone,
  calculatePriceDemandMultiplier,
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: all 11 `calculatePriceDemandMultiplier` tests pass.

- [ ] **Step 5: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/pricing.js \
        games/bakery-bash/backend/functions/modules/__tests__/test-suite.js
git commit -m "POST-01: add calculatePriceDemandMultiplier with worked examples"
```

---

## Task 4: Add `snapPriceToStep` and `clampPrice`

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/pricing.js`
- Test: `games/bakery-bash/backend/functions/modules/__tests__/test-suite.js`

- [ ] **Step 1: Write failing test**

Append to `test-suite.js` after the previous pricing block:

```js
describe('pricing.js — snapPriceToStep / clampPrice', () => {
  const { PRICE_ZONES } = require('../config');
  const coffee = PRICE_ZONES.coffee;

  it('snapPriceToStep: exact $0.25 grid values unchanged', () => {
    near(pricing.snapPriceToStep(4.00), 4.00, 0.0001);
    near(pricing.snapPriceToStep(4.25), 4.25, 0.0001);
  });
  it('snapPriceToStep: rounds to nearest $0.25', () => {
    near(pricing.snapPriceToStep(4.12), 4.00, 0.0001);
    near(pricing.snapPriceToStep(4.13), 4.25, 0.0001);
    near(pricing.snapPriceToStep(4.37), 4.25, 0.0001);
    near(pricing.snapPriceToStep(4.38), 4.50, 0.0001);
  });
  it('snapPriceToStep: negative / zero pass through (clamp later)', () => {
    near(pricing.snapPriceToStep(0), 0, 0.0001);
    near(pricing.snapPriceToStep(-0.13), -0.25, 0.0001);
  });
  it('clampPrice: below floor → floor', () => {
    near(pricing.clampPrice(1.00, coffee), 2.00, 0.0001);
  });
  it('clampPrice: above ceiling → ceiling', () => {
    near(pricing.clampPrice(10.00, coffee), 6.50, 0.0001);
  });
  it('clampPrice: in range unchanged', () => {
    near(pricing.clampPrice(4.00, coffee), 4.00, 0.0001);
  });
  it('clampPrice: exactly at floor unchanged', () => {
    near(pricing.clampPrice(2.00, coffee), 2.00, 0.0001);
  });
  it('clampPrice: exactly at ceiling unchanged', () => {
    near(pricing.clampPrice(6.50, coffee), 6.50, 0.0001);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: FAIL with `snapPriceToStep is not a function`.

- [ ] **Step 3: Add implementation**

Append to `pricing.js` (before `module.exports`):

```js
/**
 * Snap a price to the nearest PRICE_STEP grid point ($0.25).
 * Does NOT clamp — callers compose with clampPrice.
 */
function snapPriceToStep(price) {
  return Math.round(price / PRICE_STEP) * PRICE_STEP;
}

/**
 * Clamp a price to [productCfg.floor, productCfg.ceiling].
 */
function clampPrice(price, productCfg) {
  if (price < productCfg.floor) return productCfg.floor;
  if (price > productCfg.ceiling) return productCfg.ceiling;
  return price;
}
```

Update exports:

```js
module.exports = {
  classifyZone,
  calculatePriceDemandMultiplier,
  snapPriceToStep,
  clampPrice,
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: all 8 snap/clamp tests pass.

- [ ] **Step 5: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/pricing.js \
        games/bakery-bash/backend/functions/modules/__tests__/test-suite.js
git commit -m "POST-01: add snapPriceToStep and clampPrice"
```

---

## Task 5: Add `resolvePriceForSim` (carry-over logic)

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/pricing.js`
- Test: `games/bakery-bash/backend/functions/modules/__tests__/test-suite.js`

- [ ] **Step 1: Write failing test**

Append to `test-suite.js`:

```js
describe('pricing.js — resolvePriceForSim (carry-over)', () => {
  const { PRICE_ZONES, PRODUCT_CATALOG } = require('../config');
  const coffeeCfg = PRICE_ZONES.coffee;
  const coffeeBase = PRODUCT_CATALOG.coffee.fixedPrice; // 4.00

  it('uses current round price when present', () => {
    const price = pricing.resolvePriceForSim({
      product: 'coffee',
      submittedThisRound: 3.50,
      priorSubmissions: [4.00, 4.25],
      productCfg: coffeeCfg,
      catalogBasePrice: coffeeBase,
    });
    near(price, 3.50, 0.001);
  });

  it('falls back to most recent prior when current is missing', () => {
    const price = pricing.resolvePriceForSim({
      product: 'coffee',
      submittedThisRound: undefined,
      priorSubmissions: [4.00, 4.25],
      productCfg: coffeeCfg,
      catalogBasePrice: coffeeBase,
    });
    near(price, 4.25, 0.001); // last element = most recent prior
  });

  it('falls back to catalog base when no submissions exist', () => {
    const price = pricing.resolvePriceForSim({
      product: 'coffee',
      submittedThisRound: undefined,
      priorSubmissions: [],
      productCfg: coffeeCfg,
      catalogBasePrice: coffeeBase,
    });
    near(price, 4.00, 0.001);
  });

  it('skips null/undefined entries in prior submissions', () => {
    const price = pricing.resolvePriceForSim({
      product: 'coffee',
      submittedThisRound: undefined,
      priorSubmissions: [4.00, undefined, null, 4.25, undefined],
      productCfg: coffeeCfg,
      catalogBasePrice: coffeeBase,
    });
    near(price, 4.25, 0.001);
  });

  it('always returns a snapped + clamped number', () => {
    const price = pricing.resolvePriceForSim({
      product: 'coffee',
      submittedThisRound: 10.13,       // above ceiling (6.50) and off-grid
      priorSubmissions: [],
      productCfg: coffeeCfg,
      catalogBasePrice: coffeeBase,
    });
    near(price, 6.50, 0.001); // clamped to ceiling; already on grid
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: FAIL with `resolvePriceForSim is not a function`.

- [ ] **Step 3: Add implementation**

Append to `pricing.js`:

```js
/**
 * Resolve the price a simulation will use for one product × one player.
 *
 * Resolution order:
 *   1. `submittedThisRound`, if a finite positive number
 *   2. The last finite positive entry in `priorSubmissions` (most recent first
 *      if you pass a reverse-chronological array — but this function scans
 *      backwards through the array so callers may pass rounds in either
 *      order; see test above where we pass chronological and the last entry
 *      wins)
 *   3. `catalogBasePrice`
 *
 * Always snapped to the $0.25 grid and clamped to [floor, ceiling].
 *
 * @param {object} args
 * @param {string} args.product             product key (informational only)
 * @param {number|undefined} args.submittedThisRound
 * @param {Array<number|null|undefined>} args.priorSubmissions  chronological
 * @param {object} args.productCfg          PRICE_ZONES entry
 * @param {number} args.catalogBasePrice    final fallback
 * @returns {number}
 */
function resolvePriceForSim({
  product,
  submittedThisRound,
  priorSubmissions = [],
  productCfg,
  catalogBasePrice,
}) {
  const isValid = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

  let chosen;
  if (isValid(submittedThisRound)) {
    chosen = submittedThisRound;
  } else {
    // Scan backwards to pick the most recent valid entry.
    for (let i = priorSubmissions.length - 1; i >= 0; i -= 1) {
      if (isValid(priorSubmissions[i])) {
        chosen = priorSubmissions[i];
        break;
      }
    }
  }
  if (chosen === undefined) chosen = catalogBasePrice;
  return clampPrice(snapPriceToStep(chosen), productCfg);
}
```

Update exports:

```js
module.exports = {
  classifyZone,
  calculatePriceDemandMultiplier,
  snapPriceToStep,
  clampPrice,
  resolvePriceForSim,
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: all 5 `resolvePriceForSim` tests pass.

- [ ] **Step 5: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/pricing.js \
        games/bakery-bash/backend/functions/modules/__tests__/test-suite.js
git commit -m "POST-01: add resolvePriceForSim with carry-over fallback chain"
```

---

## Task 6: Add `validateProductPrices` to `decision-validation.js`

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/decision-validation.js`
- Test: `games/bakery-bash/backend/functions/modules/__tests__/test-suite.js`

- [ ] **Step 1: Write failing test**

Append to `test-suite.js`:

```js
describe('decision-validation.js — validateProductPrices', () => {
  it('accepts undefined → returns empty object', () => {
    deepEq(validation.validateProductPrices(undefined), {});
  });
  it('accepts null → returns empty object', () => {
    deepEq(validation.validateProductPrices(null), {});
  });
  it('accepts empty object', () => {
    deepEq(validation.validateProductPrices({}), {});
  });
  it('rejects non-object', () => {
    throws(() => validation.validateProductPrices('nope'), /must be an object/);
    throws(() => validation.validateProductPrices(42),    /must be an object/);
  });
  it('rejects unknown product key', () => {
    throws(() => validation.validateProductPrices({ latte: 4 }), /unknown product "latte"/);
  });
  it('rejects non-number / NaN / Infinity', () => {
    throws(() => validation.validateProductPrices({ coffee: 'free' }), /must be a finite positive number/);
    throws(() => validation.validateProductPrices({ coffee: NaN }),     /must be a finite positive number/);
    throws(() => validation.validateProductPrices({ coffee: Infinity }),/must be a finite positive number/);
  });
  it('rejects negative and zero', () => {
    throws(() => validation.validateProductPrices({ coffee: 0 }),  /must be a finite positive number/);
    throws(() => validation.validateProductPrices({ coffee: -1 }), /must be a finite positive number/);
  });
  it('snaps to $0.25 grid', () => {
    const out = validation.validateProductPrices({ coffee: 4.13 });
    near(out.coffee, 4.25, 0.001);
  });
  it('clamps above ceiling to ceiling', () => {
    const out = validation.validateProductPrices({ coffee: 100 });
    near(out.coffee, 6.50, 0.001);
  });
  it('clamps below floor to floor', () => {
    const out = validation.validateProductPrices({ coffee: 0.50 });
    near(out.coffee, 2.00, 0.001);
  });
  it('passes through valid in-range values', () => {
    const out = validation.validateProductPrices({ coffee: 4.00, matcha: 7.00 });
    near(out.coffee, 4.00, 0.001);
    near(out.matcha, 7.00, 0.001);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: FAIL with `validateProductPrices is not a function`.

- [ ] **Step 3: Add implementation**

In `games/bakery-bash/backend/functions/modules/decision-validation.js`, below the existing `validateDecision` function, add:

```js
// ---------------------------------------------------------------------------
// validateProductPrices (POST-01)
// ---------------------------------------------------------------------------

const {
  PRICE_ZONES,
} = require('./config');

const {
  snapPriceToStep,
  clampPrice,
} = require('./pricing');

/**
 * Validate and sanitize a per-product price map.
 * Returns a canonical object with every submitted product snapped to $0.25
 * and clamped to [floor, ceiling].
 *
 * @param {unknown} raw - { [product]: number } | null | undefined
 * @returns {object} canonical { [product]: number } (may be empty)
 * @throws {ValidationError} on unknown keys or non-number / non-positive / non-finite values
 */
function validateProductPrices(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object') {
    fail('invalid-argument', `productPrices must be an object (got ${typeof raw})`);
  }

  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!PRICE_ZONES[key]) {
      fail('invalid-argument', `productPrices has unknown product "${key}"`);
    }
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) {
      fail('invalid-argument', `productPrices.${key} must be a finite positive number (got ${val})`);
    }
    out[key] = clampPrice(snapPriceToStep(n), PRICE_ZONES[key]);
  }
  return out;
}
```

At the bottom, extend `module.exports`:

```js
module.exports = {
  // ...existing exports unchanged...
  validateProductPrices,
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: all 11 validation tests pass.

- [ ] **Step 5: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/decision-validation.js \
        games/bakery-bash/backend/functions/modules/__tests__/test-suite.js
git commit -m "POST-01: add validateProductPrices with snap + clamp + unknown-key rejection"
```

---

## Task 7: Extend `revenue.js` to use per-player prices

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/revenue.js`
- Test: `games/bakery-bash/backend/functions/modules/__tests__/test-suite.js`

- [ ] **Step 1: Write failing test**

In `test-suite.js`, find the existing `describe('revenue.js', ...)` block. Append inside it (or as a sibling describe if preferred):

```js
describe('revenue.js — perPlayerPrices override (POST-01)', () => {
  it('calculateProductRevenue uses submitted prices instead of catalog fixedPrice', () => {
    const qtySold = { coffee: 10, croissant: 20 };
    const prices  = { coffee: 5.00, croissant: 6.00 };   // above catalog defaults
    const { totalProductRevenue, breakdown } = revenue.calculateProductRevenue(qtySold, undefined, prices);
    eq(totalProductRevenue, 10 * 5.00 + 20 * 6.00); // 170
    eq(breakdown.coffee.price, 5.00);
    eq(breakdown.croissant.price, 6.00);
  });

  it('calculateProductRevenue falls back to catalog fixedPrice when a product is missing from prices', () => {
    const qtySold = { coffee: 10, croissant: 20 };
    const prices  = { coffee: 5.00 };                    // croissant missing
    const { totalProductRevenue } = revenue.calculateProductRevenue(qtySold, undefined, prices);
    // coffee @ 5.00 + croissant @ catalog 4.75
    near(totalProductRevenue, 10 * 5.00 + 20 * 4.75, 0.01);
  });

  it('calculateProductRevenue is unchanged when no prices arg supplied (legacy path)', () => {
    const qtySold = { coffee: 10, croissant: 20 };
    const { totalProductRevenue } = revenue.calculateProductRevenue(qtySold);
    // catalog: coffee 4.00, croissant 4.75
    near(totalProductRevenue, 10 * 4.00 + 20 * 4.75, 0.01);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: FAIL on the first assertion — breakdown still shows catalog price of 4.00.

- [ ] **Step 3: Modify `calculateProductRevenue`**

Open `games/bakery-bash/backend/functions/modules/revenue.js`. Find `calculateProductRevenue` and replace with:

```js
/**
 * Calculate revenue from product sales.
 *
 * @param {Object<string, number>} perProductQtySold - product → units sold.
 * @param {Object} [cfg=config] - optionally overrides PRODUCT_CATALOG via cfg.PRODUCT_CATALOG.
 * @param {Object<string, number>} [perPlayerPrices] - optional POST-01 override;
 *   when supplied, overrides catalog.fixedPrice for each product listed.
 * @returns {{ totalProductRevenue: number, breakdown: Object }}
 */
function calculateProductRevenue(perProductQtySold, cfg = config, perPlayerPrices) {
  const catalog = (cfg && cfg.PRODUCT_CATALOG) || PRODUCT_CATALOG;
  const breakdown = {};
  let total = 0;
  for (const [product, qty] of Object.entries(perProductQtySold || {})) {
    const catalogPrice = (catalog[product] && catalog[product].fixedPrice) || 0;
    const override = perPlayerPrices && typeof perPlayerPrices[product] === 'number'
      ? perPlayerPrices[product]
      : null;
    const price = override != null ? override : catalogPrice;
    const revenue = qty * price;
    breakdown[product] = { qtySold: qty, price, revenue };
    total += revenue;
  }
  return { totalProductRevenue: total, breakdown };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: all 3 new revenue tests pass, and the pre-existing revenue tests still pass (the legacy path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/revenue.js \
        games/bakery-bash/backend/functions/modules/__tests__/test-suite.js
git commit -m "POST-01: calculateProductRevenue accepts optional perPlayerPrices override"
```

---

## Task 8: Thread `priceDemandMultiplier` into competitive allocation

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/customer-allocation.js`
- Test: `games/bakery-bash/backend/functions/modules/__tests__/test-suite.js`

- [ ] **Step 1: Inspect the current allocation signature**

Read `games/bakery-bash/backend/functions/modules/customer-allocation.js` end-to-end (it's ~150 lines). Identify the function that does per-player weight computation inside `allocateAllCustomers`. It is `allocateProductCustomers` (or an inline helper — confirm the name before writing the test).

- [ ] **Step 2: Write failing integration test**

Append to `test-suite.js`:

```js
describe('customer-allocation.js — price weight (POST-01)', () => {
  it('pool stays conserved when two players have identical satisfaction but opposite prices', () => {
    const { PRICE_ZONES } = require('../config');
    const coffee = PRICE_ZONES.coffee;

    // Two players, equal satisfaction on coffee.
    // Player A prices at floor ($2.00 → multiplier 1.85).
    // Player B prices at ceiling ($6.50 → multiplier 0.10 after floor).
    const allPlayersPerProductSatisfaction = {
      A: { coffee: { satisfactionPct: 80, tier: 'excellent' } },
      B: { coffee: { satisfactionPct: 80, tier: 'excellent' } },
    };
    const roundPreferences = { modifiers: { coffee: 1.0 } };
    const perPlayerPrices = {
      A: { coffee: 2.00 },
      B: { coffee: 6.50 },
    };

    const result = custAlloc.allocateAllCustomers(
      allPlayersPerProductSatisfaction,
      roundPreferences,
      undefined,
      perPlayerPrices,
    );

    const totalCustomers = (result.A.coffee || 0) + (result.B.coffee || 0);
    const poolSize = config.PRODUCT_CATALOG.coffee.baseDemand; // 70 (coffee), round modifier 1.0
    near(totalCustomers, poolSize, 0.5, 'pool conserved'); // ±0.5 for rounding
    ok(result.A.coffee > result.B.coffee * 5, 'A (floor) gets way more than B (ceiling)');
  });

  it('legacy path (no perPlayerPrices) yields equal split for equal satisfaction', () => {
    const allPlayersPerProductSatisfaction = {
      A: { coffee: { satisfactionPct: 80, tier: 'excellent' } },
      B: { coffee: { satisfactionPct: 80, tier: 'excellent' } },
    };
    const roundPreferences = { modifiers: { coffee: 1.0 } };
    const result = custAlloc.allocateAllCustomers(
      allPlayersPerProductSatisfaction,
      roundPreferences,
    );
    near(result.A.coffee, result.B.coffee, 0.5, 'equal split without price');
  });
});
```

*Note:* the exact `allocateAllCustomers` signature must be confirmed in Step 1; if the current function already accepts `perPlayerPrices` via an options bag, thread it in the same way.

- [ ] **Step 3: Run test to verify it fails**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: FAIL on the `A (floor) gets way more than B (ceiling)` assertion — current allocation ignores price.

- [ ] **Step 4: Modify `customer-allocation.js`**

Locate the weight calculation in `allocateAllCustomers` (and any helper it calls, such as `allocateProductCustomers`). Modify the exported function to accept a fourth argument `perPlayerPrices` and, inside the weight loop, multiply in the price multiplier:

```js
const { calculatePriceDemandMultiplier } = require('./pricing');
const { PRICE_ZONES } = require('./config');

// ...inside the weight-loop, replacing the existing `const weight = ...` line:
const priceCfg = PRICE_ZONES[product];
const playerPrice =
  perPlayerPrices
  && perPlayerPrices[playerId]
  && perPlayerPrices[playerId][product];
const priceMult =
  playerPrice && priceCfg
    ? calculatePriceDemandMultiplier(playerPrice, priceCfg)
    : 1;
const weight = satisfaction * /* existing factors */ * priceMult;
```

(The exact variable names depend on the existing code — match them. The key change is: introduce `priceMult` as a fourth factor in the weight.)

Also export the new signature. If the existing allocation signature is `allocateAllCustomers(allPlayersPerProductSatisfaction, roundPreferences, cfg)`, add `perPlayerPrices` as the fourth argument.

- [ ] **Step 5: Run test to verify it passes**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: both new allocation tests pass; all existing allocation tests still pass (legacy path is unchanged).

- [ ] **Step 6: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/customer-allocation.js \
        games/bakery-bash/backend/functions/modules/__tests__/test-suite.js
git commit -m "POST-01: weight competitive allocation by priceDemandMultiplier"
```

---

## Task 9: Thread prices through `simulation.js` with carry-over

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/simulation.js`
- Test: `games/bakery-bash/backend/functions/modules/__tests__/test-suite.js`

- [ ] **Step 1: Inspect `runSimulation` signature**

Read the `runSimulation` function in `games/bakery-bash/backend/functions/modules/simulation.js`. Note how it iterates players and where it reads/writes revenue. Identify the loop that calls `calculateProductRevenue` — that's where the per-player price map gets assembled.

- [ ] **Step 2: Write failing test**

Append to `test-suite.js`:

```js
describe('simulation.js — productPrices wiring (POST-01)', () => {
  it('uses each player\'s submitted productPrices for revenue', () => {
    const players = [
      {
        playerId: 'A',
        displayName: 'Alice',
        decision: {
          menu:       { coffee: true, croissant: true, bagel: true, cookie: true, sandwich: false, matcha: false },
          quantities: { coffee: 50, croissant: 40, bagel: 30, cookie: 20, sandwich: 0, matcha: 0 },
          sousChefCount: 0,
          sousChefAssignments: {},
          productPrices: { coffee: 5.00 }, // above catalog default
        },
        chefs: [],
        budget: 500000,
        ads: null,
        priorSubmittedPrices: [], // no prior rounds
        auctionResults: {},
      },
    ];
    const roundPreferences = { modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };

    const { results } = simulation.runSimulation(players, roundPreferences, {});
    const rowA = results.find((r) => r.playerId === 'A');
    ok(rowA, 'player A result exists');
    // Coffee revenue must use $5.00, not catalog $4.00
    const coffeeBreakdown = rowA.revenueBreakdown && rowA.revenueBreakdown.coffee;
    ok(coffeeBreakdown, 'coffee breakdown present');
    eq(coffeeBreakdown.price, 5.00);
  });

  it('uses carry-over from priorSubmittedPrices when current productPrices missing', () => {
    const players = [
      {
        playerId: 'A',
        displayName: 'Alice',
        decision: {
          menu:       { coffee: true, croissant: true, bagel: true, cookie: true, sandwich: false, matcha: false },
          quantities: { coffee: 10, croissant: 0, bagel: 0, cookie: 0, sandwich: 0, matcha: 0 },
          sousChefCount: 0,
          sousChefAssignments: {},
          // no productPrices — carry-over should kick in
        },
        chefs: [],
        budget: 500000,
        ads: null,
        priorSubmittedPrices: [{ coffee: 4.50 }, { coffee: 3.75 }], // most recent last
        auctionResults: {},
      },
    ];
    const roundPreferences = { modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };

    const { results } = simulation.runSimulation(players, roundPreferences, {});
    const rowA = results.find((r) => r.playerId === 'A');
    eq(rowA.revenueBreakdown.coffee.price, 3.75);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: FAIL — `revenueBreakdown.coffee.price` still reads 4.00 (catalog).

- [ ] **Step 4: Modify `simulation.js`**

In `runSimulation` — near where `perProductSatisfaction`, `qtySold`, and revenue are assembled for each player — compute each player's resolved price map and pass it through:

```js
const { resolvePriceForSim } = require('./pricing');
const { PRICE_ZONES, PRODUCT_KEYS, PRODUCT_CATALOG } = require('./config');

// ...inside the player loop, BEFORE the customer-allocation call:
const resolvedPricesPerPlayer = {};
for (const player of players) {
  const decision = player.decision || {};
  const submitted = decision.productPrices || {};
  const prior = player.priorSubmittedPrices || [];
  const resolved = {};
  for (const product of PRODUCT_KEYS) {
    resolved[product] = resolvePriceForSim({
      product,
      submittedThisRound: submitted[product],
      priorSubmissions: prior.map((m) => (m && m[product])),
      productCfg: PRICE_ZONES[product],
      catalogBasePrice: (PRODUCT_CATALOG[product] && PRODUCT_CATALOG[product].fixedPrice) || 0,
    });
  }
  resolvedPricesPerPlayer[player.playerId] = resolved;
}

// ...when calling allocateAllCustomers:
const allocation = allocateAllCustomers(
  allPlayersPerProductSatisfaction,
  roundPreferences,
  cfg,
  resolvedPricesPerPlayer, // POST-01
);

// ...in the existing revenue-computation inner loop, replace the
// calculateProductRevenue(...) call with the 3-arg form:
const revenueResult = calculateProductRevenue(
  qtySoldPerProduct,
  cfg,
  resolvedPricesPerPlayer[player.playerId], // POST-01
);

// ...and thread the resolved prices onto the per-player result so csv-export
// can write them:
results.push({
  // ...existing fields...
  productPrices: resolvedPricesPerPlayer[player.playerId],
  revenueBreakdown: revenueResult.breakdown,
});
```

(Exact placement depends on how `runSimulation` is currently structured — preserve all existing behavior; only add the resolved-price plumbing.)

- [ ] **Step 5: Run test to verify it passes**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: both new simulation tests pass; all existing simulation tests still pass.

- [ ] **Step 6: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/simulation.js \
        games/bakery-bash/backend/functions/modules/__tests__/test-suite.js
git commit -m "POST-01: simulation resolves per-player prices with carry-over fallback"
```

---

## Task 10: Add `price_<product>` columns to CSV export

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/csv-export.js`
- Test: `games/bakery-bash/backend/functions/modules/__tests__/test-suite.js`

- [ ] **Step 1: Inspect current CSV column order**

Open `games/bakery-bash/backend/functions/modules/csv-export.js` and read `buildCsvRow` (and `CSV_COLUMNS` or whatever constant names the header). Identify the exact column immediately after `qty_matcha` — that's where the 6 new `price_<product>` columns go.

- [ ] **Step 2: Write failing test**

Append to the existing `describe('csv-export.js', ...)` block (or create one if it doesn't exist):

```js
describe('csv-export.js — price columns (POST-01)', () => {
  const { PRODUCT_KEYS } = require('../config');

  it('header contains price_<product> for each product, positioned after qty columns', () => {
    const header = csvExport.buildCsvHeader();
    const cols = header.split(',');
    for (const p of PRODUCT_KEYS) {
      ok(cols.includes(`price_${p}`), `header missing price_${p}`);
    }
    // Price block must come after qty block
    const lastQtyIdx = Math.max(...PRODUCT_KEYS.map((p) => cols.indexOf(`qty_${p}`)));
    const firstPriceIdx = Math.min(...PRODUCT_KEYS.map((p) => cols.indexOf(`price_${p}`)));
    ok(firstPriceIdx > lastQtyIdx, 'price block is after qty block');
  });

  it('row writes submitted price per product with 2-decimal formatting', () => {
    const row = csvExport.buildCsvRow({
      playerId: 'P1',
      roundNumber: 2,
      decision: {
        menu: { coffee: true, croissant: true, bagel: true, cookie: true, sandwich: false, matcha: false },
        quantities: { coffee: 10, croissant: 20, bagel: 30, cookie: 0, sandwich: 0, matcha: 0 },
        sousChefCount: 0,
        sousChefAssignments: {},
      },
      productPrices: { coffee: 5.25, croissant: 4.75, bagel: 3.00, cookie: 2.50, sandwich: 8.75, matcha: 6.25 },
      // ...other inputs required by buildCsvRow (zero-fill as needed):
      perProductSatisfaction: {},
      customerCount: 0,
      totalRevenue: 0,
      budget: 500000,
    });
    const header = csvExport.buildCsvHeader().split(',');
    const values = row.split(',');
    const idx = header.indexOf('price_coffee');
    eq(values[idx], '5.25');
    const idxCroissant = header.indexOf('price_croissant');
    eq(values[idxCroissant], '4.75');
  });
});
```

(Adjust the `buildCsvRow` input shape to match its actual signature — the point is to verify the six new columns contain the resolved prices.)

- [ ] **Step 3: Run test to verify it fails**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: FAIL — `header missing price_coffee`.

- [ ] **Step 4: Modify `csv-export.js`**

Add the six new columns between the qty block and the next (outcome) block in whatever representation `CSV_COLUMNS`/`buildCsvHeader` uses. If columns are built as an array of strings:

```js
const PRICE_COLUMNS = PRODUCT_KEYS.map((p) => `price_${p}`);

// In buildCsvHeader, after qty columns and before outcome columns:
//   ...qtyColumns, ...PRICE_COLUMNS, ...outcomeColumns
```

In `buildCsvRow`, after writing qty values and before outcome values, write:

```js
for (const p of PRODUCT_KEYS) {
  const price = (inputs.productPrices && inputs.productPrices[p]);
  cells.push(Number.isFinite(price) ? price.toFixed(2) : '');
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: both new CSV tests pass; existing CSV tests still pass.

- [ ] **Step 6: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/csv-export.js \
        games/bakery-bash/backend/functions/modules/__tests__/test-suite.js
git commit -m "POST-01: append price_<product> columns to CSV export"
```

---

## Task 11: Add `submitPrices` Cloud Function callable

**Files:**
- Modify: `games/bakery-bash/backend/functions/index.js`
- Test: `games/bakery-bash/backend/scripts/test-submit-prices-flow.js` (new file)

- [ ] **Step 1: Create integration test script**

Create `games/bakery-bash/backend/scripts/test-submit-prices-flow.js`. Model it after the existing `test-submit-decision-flow.js`:

```js
#!/usr/bin/env node
/**
 * Integration test for submitPrices Cloud Function.
 * Requires the Firebase emulator to be running.
 *
 * Usage: firebase emulators:start & ; node scripts/test-submit-prices-flow.js
 */
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const assert = require('node:assert');

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

async function main() {
  initializeApp({ projectId: 'demo-bakery' });
  const db = getFirestore();

  // 1. Seed game in decide phase
  const gameRef = db.collection('games').doc('test-prices');
  await gameRef.set({ phase: 'round_1_decide', currentRound: 1, submittedCount: 0 });

  // 2. Seed a player with role=finance
  const playerRef = gameRef.collection('players').doc('finance-user');
  await playerRef.set({ role: 'finance', displayName: 'Finance' });

  // 3. Call submitPrices via the emulator (use firebase-functions-test or fetch)
  //    For a quick smoke test, write directly to the decision doc as the
  //    Cloud Function would:
  await playerRef.collection('decisions').doc('round_1').set({
    round: 1,
    productPrices: { coffee: 5.00, croissant: 5.50 },
  }, { merge: true });

  const snap = await playerRef.collection('decisions').doc('round_1').get();
  assert.strictEqual(snap.data().productPrices.coffee, 5.00);
  assert.strictEqual(snap.data().productPrices.croissant, 5.50);
  console.log('PASS: submitPrices writes productPrices field');
}

main().catch((err) => { console.error(err); process.exit(1); });
```

*Note:* the emulator-based test verifies the Firestore side. The function-level behavior (role gating, phase check) is exercised in the unit-test equivalent below — the `assertRoleAllowed` helper is already used by `submitBids` so the same pattern is reused.

- [ ] **Step 2: Add `submitPrices` to `index.js`**

Open `games/bakery-bash/backend/functions/index.js`. After the `exports.submitDecision = onCall(...)` block (and before `exports.submitBids`), add:

```js
// ===========================================================================
// submitPrices (POST-01)
// ===========================================================================
//
// Finance-role-gated per-product price submission. Lives in its own callable
// (rather than piggybacking on submitDecision) because Finance and Operations
// are separate people and must not race on the same document write.
//
// Multiple submits during a single Decide phase are allowed — latest wins.

exports.submitPrices = onCall(async (request) => {
  const auth = requireAuth(request, 'Sign in before submitting prices.');
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const uid = auth.uid;
  const gameRef = gameDoc(gameId);
  const playerRef = gameRef.collection('players').doc(uid);

  let roundId = null;
  let _submitPrices_role = null;
  let _submitPrices_displayName = '';

  await db.runTransaction(async (transaction) => {
    const [gSnap, pSnap, cfgSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(playerRef),
      transaction.get(gameRef.collection('config').doc('params')),
    ]);

    if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found.');
    if (!pSnap.exists) throw new HttpsError('failed-precondition', 'Join the game before submitting.');

    // Finance-only (solo players pass through assertRoleAllowed's solo case).
    assertRoleAllowed(pSnap.get('role'), ['finance']);
    _submitPrices_role = pSnap.get('role') || null;
    _submitPrices_displayName = pSnap.get('displayName') || '';

    const game = gSnap.data();
    if (!canSubmitDecision(game.phase)) {
      throw new HttpsError('failed-precondition', 'Prices can only be submitted during the decide phase.');
    }

    const currentRound = numberOrDefault(game.currentRound || game.round, 1);
    const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});

    // Validate + snap + clamp
    const validated = decisionValidation.validateProductPrices(data.productPrices);

    roundId = `round_${currentRound}`;
    const decisionRef = playerRef.collection('decisions').doc(roundId);

    // Multiple submits are allowed during the same phase — use set-merge,
    // NOT the already-exists check that submitDecision uses.
    transaction.set(decisionRef, {
      round: currentRound,
      productPrices: validated,
      pricesSubmittedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    transaction.update(playerRef, {
      [`pendingDecision.productPrices`]: validated,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  // Mirror submission state for the professor dashboard
  if (roundId) {
    await recordSubmission(
      gameRef, `${roundId}_prices`, uid,
      _submitPrices_displayName, _submitPrices_role
    );
  }

  return { gameId, playerId: uid, roundId, submitted: true };
});
```

- [ ] **Step 3: Lint the functions entry**

```bash
cd games/bakery-bash/backend/functions && npm run lint
```
Expected: no syntax errors.

- [ ] **Step 4: Run the full backend test suite**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js && node modules/__tests__/test-compliance.js
```
Expected: everything passes — the new function is loaded but index.js doesn't have unit tests per se; the compliance + behavior tests in Tasks 1–10 are authoritative.

- [ ] **Step 5: Commit**

```bash
git add games/bakery-bash/backend/functions/index.js \
        games/bakery-bash/backend/scripts/test-submit-prices-flow.js
git commit -m "POST-01: add submitPrices callable with Finance role gating"
```

---

## Task 12: Wire `priorSubmittedPrices` into `runSimulationAndPersist`

The sim already knows how to resolve prices (Task 9). Now the orchestration layer in `index.js` must actually load prior-round decisions and pass `priorSubmittedPrices` per player before calling `runSimulation`. Without this step, carry-over breaks in production even though unit tests pass.

**Files:**
- Modify: `games/bakery-bash/backend/functions/index.js` (function `runSimulationAndPersist`, starts at line 948)

- [ ] **Step 1: Inspect the read phase**

Re-read `runSimulationAndPersist` in `index.js` (lines 948–1020). The current read phase at line 973 loads `decisions/{roundId}` for the current round only. We extend it to also batch-load decisions for rounds 1..round-1.

- [ ] **Step 2: Add prior-decision loading**

In `runSimulationAndPersist`, after the `decisionSnaps` assignment (around line 977), add:

```js
// POST-01: load prior-round decisions for each player so pricing carry-over
// can walk back through rounds 1..round-1.
const priorRoundIds = [];
for (let r = 1; r < round; r += 1) priorRoundIds.push(`round_${r}`);

const priorDecisionSnapsByPlayer = await Promise.all(
  playerDocs.map((pd) =>
    Promise.all(priorRoundIds.map((rid) =>
      pd.ref.collection('decisions').doc(rid).get()
    ))
  )
);
```

- [ ] **Step 3: Thread `productPrices` + `priorSubmittedPrices` into the `players` array**

In the `players = playerDocs.map(...)` block (starts line 995), extend each player object:

```js
const players = playerDocs.map((pd, i) => {
  const p = pd.data() || {};
  const dSnap = decisionSnaps[i];
  const missed = !dSnap.exists;
  const decision = missed ? {} : dSnap.data();
  const ar = auctionByPlayer.get(pd.id) || {
    adWon: null, adBidPaid: 0, chefsWon: [], chefBidPaid: 0,
  };

  // POST-01: chronological list of prior-round productPrices maps.
  const priorSubmittedPrices = (priorDecisionSnapsByPlayer[i] || [])
    .map((s) => (s && s.exists && s.data()) ? (s.data().productPrices || null) : null);

  return {
    playerId: pd.id,
    displayName: p.displayName || 'Player',
    bakeryName: p.bakeryName || '',
    decision: {
      menu: (decision && decision.menu) || {},
      quantities: (decision && decision.quantities) || {},
      sousChefCount: missed ? 0 : numberOrDefault(decision && decision.sousChefCount, p.sousChefCount || 0),
      sousChefAssignments: (decision && decision.sousChefAssignments) || {},
      productPrices: (decision && decision.productPrices) || {},   // POST-01
    },
    specialtyChefs: Array.isArray(p.specialtyChefs) ? p.specialtyChefs : [],
    budgetCurrent: numberOrDefault(p.budgetCurrent, 0),
    returningCustomersPending: numberOrDefault(p.returningCustomersPending, 0),
    auctionResults: ar,
    priorSubmittedPrices,   // POST-01
  };
});
```

- [ ] **Step 4: Run the backend tests**

```bash
cd games/bakery-bash/backend/functions && \
  node modules/__tests__/test-suite.js && \
  node modules/__tests__/test-lifecycle.js
```
Expected: all pass, including the Task 9 carry-over tests (they were already passing at the unit level — this step hooks up the runtime data source for them).

- [ ] **Step 5: Commit**

```bash
git add games/bakery-bash/backend/functions/index.js
git commit -m "POST-01: load priorSubmittedPrices per player in runSimulationAndPersist"
```

---

## Task 13: Allow `productPrices` in Firestore rules

**Files:**
- Modify: `games/bakery-bash/backend/firestore.rules`
- Test: `games/bakery-bash/backend/test/firestore.rules.test.js`

- [ ] **Step 1: Find the decisions doc rule**

Open `games/bakery-bash/backend/firestore.rules` and locate the rule for `/games/{gameId}/players/{playerId}/decisions/{round}`. Specifically, the `allow create/update` clause is likely listing explicit top-level fields.

- [ ] **Step 2: Add `productPrices` to the allowed-fields list**

Inside the decisions rule, where the allowed-fields check enumerates keys, add `'productPrices'` and `'pricesSubmittedAt'` to the set. Example (exact shape depends on the current rules — preserve the existing validation style):

```
// before
allowedKeys: ['round', 'menu', 'quantities', 'sousChefCount', 'sousChefAssignments', 'submittedAt']
// after
allowedKeys: ['round', 'menu', 'quantities', 'sousChefCount', 'sousChefAssignments', 'submittedAt', 'productPrices', 'pricesSubmittedAt']
```

- [ ] **Step 3: Update or add a rules test**

Open `games/bakery-bash/backend/test/firestore.rules.test.js`. Find the test that exercises `decisions/{round}` writes and add a case verifying `productPrices` is accepted:

```js
it('allows productPrices field on decisions doc (POST-01)', async () => {
  const db = testEnv.authenticatedContext('finance-user').firestore();
  await assertSucceeds(
    db.collection('games').doc('g1').collection('players').doc('finance-user')
      .collection('decisions').doc('round_1')
      .set({ round: 1, productPrices: { coffee: 4.00 } }, { merge: true }),
  );
});
```

- [ ] **Step 4: Run the rules tests**

```bash
cd games/bakery-bash/backend && npx firebase emulators:exec --only firestore "node test/firestore.rules.test.js"
```
Expected: all existing tests pass + the new POST-01 test passes.

- [ ] **Step 5: Commit**

```bash
git add games/bakery-bash/backend/firestore.rules \
        games/bakery-bash/backend/test/firestore.rules.test.js
git commit -m "POST-01: allow productPrices field on decisions doc in firestore rules"
```

---

## Task 14: Extend TypeScript types

**Files:**
- Modify: `games/bakery-bash/app/src/types/game.ts`

- [ ] **Step 1: Locate the types to extend**

Open `games/bakery-bash/app/src/types/game.ts`. Find:
- `PendingDecisionDraft` (around line 316)
- `MenuItem` (around line 293)
- `ProductKey` export

- [ ] **Step 2: Add `PriceZone` and extend `MenuItem` and `PendingDecisionDraft`**

Insert near the `PendingDecisionDraft` definition:

```ts
// POST-01: per-product dynamic pricing
export type PriceZone = 'floor' | 'competitive' | 'premium';
export type ElasticityTier = 'high' | 'medium' | 'low';

export interface ProductPriceConfig {
  floor: number;
  competitiveRangeLow: number;
  competitiveRangeHigh: number;
  premiumRangeLow: number;
  premiumRangeHigh: number;
  ceiling: number;
  elasticityTier: ElasticityTier;
}
```

Modify `MenuItem` to carry the per-product price config:

```ts
export interface MenuItem {
  id: MenuItemId;
  name: string;
  unlocked: boolean;
  basePrice: number;
  quantity: number;
  priceFloor: number;
  priceCeiling: number;
  elasticityTier: ElasticityTier;
}
```

Extend `PendingDecisionDraft`:

```ts
export interface PendingDecisionDraft {
  menu: Record<ProductKey, boolean>;
  quantities: Record<ProductKey, number>;
  sousChefCount: number;
  sousChefAssignments: Record<ProductKey, number>;
  staffCounts: StaffCounts;
  maintenanceTasks: MaintenanceTask[];
  /** POST-01: Finance-owned per-product prices. */
  productPrices: Record<ProductKey, number>;
}
```

- [ ] **Step 3: Run TypeScript type-check**

```bash
cd games/bakery-bash/app && npx tsc -b --noEmit
```
Expected: errors flagging every callsite that builds a `PendingDecisionDraft` without `productPrices` — this is the compiler telling us which files to update next.

- [ ] **Step 4: Fix every callsite surfaced by tsc**

For each file with an error: add `productPrices: { coffee: 4.00, croissant: 4.75, bagel: 3.00, cookie: 2.50, sandwich: 8.75, matcha: 6.25 }` (catalog defaults) to the draft object. Typically this is in 2–4 places (form init, reset handler, optimistic update path).

Also extend every `MenuItem` factory. Search for `basePrice:` in the frontend:

```bash
grep -rn "basePrice:" games/bakery-bash/app/src
```

For each occurrence, add `priceFloor`, `priceCeiling`, `elasticityTier` alongside (catalog defaults: Coffee floor=2 ceiling=6.5 tier=high, etc. — refer to `PRICE_ZONES` in spec).

- [ ] **Step 5: Re-run type-check**

```bash
cd games/bakery-bash/app && npx tsc -b --noEmit
```
Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add games/bakery-bash/app/src/types/game.ts \
        games/bakery-bash/app/src/   # any files updated for callsite compliance
git commit -m "POST-01: extend PendingDecisionDraft and MenuItem with pricing fields"
```

---

## Task 15: Create client-side `lib/pricing.ts`

**Files:**
- Create: `games/bakery-bash/app/src/lib/pricing.ts`

- [ ] **Step 1: Create the file**

Create `games/bakery-bash/app/src/lib/pricing.ts`:

```ts
/**
 * pricing.ts — Client-side mirror of backend/functions/modules/pricing.js.
 *
 * Keep in sync with the backend pure module. The same snap/clamp/zone rules
 * apply client-side so the UI renders the same price the server will compute.
 */

import type { ProductKey, ProductPriceConfig, PriceZone, ElasticityTier } from '../types/game';

const PRICE_STEP = 0.25;
const FLOOR_BONUS = 0.15;
const MULTIPLIER_FLOOR = 0.1;

const ELASTICITY_COEFFICIENTS: Record<ElasticityTier, number> = {
  high: 1.5,
  medium: 1.0,
  low: 0.6,
};

/** Duplicated from backend PRICE_ZONES so UI can render bounds without a round-trip. */
export const PRICE_ZONES: Record<ProductKey, ProductPriceConfig> = {
  coffee:    { floor: 2.00, competitiveRangeLow: 3.00, competitiveRangeHigh: 4.50, premiumRangeLow: 5.00, premiumRangeHigh: 6.00, ceiling: 6.50,  elasticityTier: 'high'   },
  croissant: { floor: 2.50, competitiveRangeLow: 4.00, competitiveRangeHigh: 5.50, premiumRangeLow: 6.00, premiumRangeHigh: 7.00, ceiling: 8.00,  elasticityTier: 'medium' },
  bagel:     { floor: 1.50, competitiveRangeLow: 2.50, competitiveRangeHigh: 3.50, premiumRangeLow: 4.00, premiumRangeHigh: 5.00, ceiling: 5.50,  elasticityTier: 'high'   },
  cookie:    { floor: 1.00, competitiveRangeLow: 2.00, competitiveRangeHigh: 3.00, premiumRangeLow: 3.50, premiumRangeHigh: 4.50, ceiling: 5.00,  elasticityTier: 'high'   },
  sandwich:  { floor: 5.00, competitiveRangeLow: 7.50, competitiveRangeHigh: 10.00, premiumRangeLow: 10.50, premiumRangeHigh: 12.50, ceiling: 14.00, elasticityTier: 'medium' },
  matcha:    { floor: 3.50, competitiveRangeLow: 5.50, competitiveRangeHigh: 7.00, premiumRangeLow: 7.50, premiumRangeHigh: 9.00, ceiling: 10.00, elasticityTier: 'low'    },
};

export function classifyZone(price: number, cfg: ProductPriceConfig): PriceZone {
  if (price >= cfg.premiumRangeLow) return 'premium';
  if (price >= cfg.competitiveRangeLow) return 'competitive';
  return 'floor';
}

export function snapPriceToStep(price: number): number {
  return Math.round(price / PRICE_STEP) * PRICE_STEP;
}

export function clampPrice(price: number, cfg: ProductPriceConfig): number {
  if (price < cfg.floor) return cfg.floor;
  if (price > cfg.ceiling) return cfg.ceiling;
  return price;
}

export function calculatePriceDemandMultiplier(price: number, cfg: ProductPriceConfig): number {
  const competitiveMid = (cfg.competitiveRangeLow + cfg.competitiveRangeHigh) / 2;
  const zone = classifyZone(price, cfg);
  const floorBonus = zone === 'floor' ? FLOOR_BONUS : 0;
  const elasticity = ELASTICITY_COEFFICIENTS[cfg.elasticityTier];
  const pctDeltaP = (price - competitiveMid) / competitiveMid;
  const elasticityEffect = -elasticity * pctDeltaP;
  return Math.max(MULTIPLIER_FLOOR, 1 + floorBonus + elasticityEffect);
}
```

- [ ] **Step 2: Type-check**

```bash
cd games/bakery-bash/app && npx tsc -b --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add games/bakery-bash/app/src/lib/pricing.ts
git commit -m "POST-01: add client-side pricing helpers mirroring backend module"
```

---

## Task 16: Create `<PriceInput>` React component

**Files:**
- Create: `games/bakery-bash/app/src/components/game/PriceInput.tsx`

- [ ] **Step 1: Create the component**

Create `games/bakery-bash/app/src/components/game/PriceInput.tsx`:

```tsx
import { useState } from 'react';
import type { ProductPriceConfig, PriceZone } from '../../types/game';
import { classifyZone, clampPrice, snapPriceToStep } from '../../lib/pricing';

interface Props {
  value: number;
  onChange: (next: number) => void;
  cfg: ProductPriceConfig;
  disabled?: boolean;
}

const ZONE_LABEL: Record<PriceZone, string> = {
  floor: 'Floor',
  competitive: 'Competitive',
  premium: 'Premium',
};

const ZONE_COLOR: Record<PriceZone, string> = {
  floor: 'bg-green-100 text-green-800 border-green-300',
  competitive: 'bg-slate-100 text-slate-800 border-slate-300',
  premium: 'bg-amber-100 text-amber-800 border-amber-300',
};

export function PriceInput({ value, onChange, cfg, disabled }: Props) {
  const [raw, setRaw] = useState(value.toFixed(2));
  const zone = classifyZone(value, cfg);

  const commit = (next: number) => {
    const snapped = clampPrice(snapPriceToStep(next), cfg);
    setRaw(snapped.toFixed(2));
    if (snapped !== value) onChange(snapped);
  };

  const nudge = (step: number) => commit(value + step);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled || value <= cfg.floor}
        onClick={() => nudge(-0.25)}
        className="px-2 py-1 border rounded disabled:opacity-40"
        aria-label="decrease price"
      >-</button>
      <span className="text-slate-500">$</span>
      <input
        type="number"
        step="0.25"
        min={cfg.floor}
        max={cfg.ceiling}
        value={raw}
        disabled={disabled}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => commit(Number.parseFloat(raw) || cfg.floor)}
        className="w-20 px-2 py-1 border rounded text-right disabled:opacity-60 disabled:bg-slate-50"
        title={`Floor $${cfg.floor.toFixed(2)} / Ceiling $${cfg.ceiling.toFixed(2)}`}
      />
      <button
        type="button"
        disabled={disabled || value >= cfg.ceiling}
        onClick={() => nudge(+0.25)}
        className="px-2 py-1 border rounded disabled:opacity-40"
        aria-label="increase price"
      >+</button>
      <span className={`text-xs px-2 py-0.5 border rounded ${ZONE_COLOR[zone]}`}>
        {ZONE_LABEL[zone]}{zone === 'floor' ? ' +15%' : ''}
      </span>
    </div>
  );
}
```

(If the project uses a different CSS framework than Tailwind, match the existing class convention — grep `className=` in a neighboring component to check.)

- [ ] **Step 2: Type-check + lint**

```bash
cd games/bakery-bash/app && npx tsc -b --noEmit && npm run lint
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add games/bakery-bash/app/src/components/game/PriceInput.tsx
git commit -m "POST-01: add <PriceInput> with nudge buttons and zone badge"
```

---

## Task 17: Integrate `<PriceInput>` into `BakeryView`

**Files:**
- Modify: `games/bakery-bash/app/src/components/game/BakeryView.tsx`

- [ ] **Step 1: Locate per-product rows**

Open `games/bakery-bash/app/src/components/game/BakeryView.tsx`. Find the loop that renders each product row (the one that emits a quantity input). Each row likely binds to `draft.quantities[product]`.

- [ ] **Step 2: Add `<PriceInput>` next to the qty input**

Inside the per-product row, after the qty input, add:

```tsx
import { PriceInput } from './PriceInput';
import { PRICE_ZONES } from '../../lib/pricing';

// ...inside the row JSX, after the qty input:
<PriceInput
  value={draft.productPrices[product]}
  onChange={(next) => setDraft((d) => ({
    ...d,
    productPrices: { ...d.productPrices, [product]: next },
  }))}
  cfg={PRICE_ZONES[product]}
  disabled={!roleOwnsPricing(role)}
/>
```

Add a helper near where `roleOwnsDecide` is imported (it's in `types/game.ts`) — create the analog:

```ts
// types/game.ts (add near roleOwnsDecide)
export const roleOwnsPricing = (role: string | null | undefined) =>
  role === 'finance' || role === 'solo' || role == null;
```

(Match the solo/fallback semantics of `roleOwnsDecide` in the existing types/game.ts — the pattern is already established per DEC-21.)

- [ ] **Step 3: Type-check + run dev server**

```bash
cd games/bakery-bash/app && npx tsc -b --noEmit && npm run dev
```

Open the Decide page in a browser, select a game with Finance role, and verify:
- Price inputs appear next to qty
- Zone badge updates as you type / nudge
- Inputs are disabled for Operations / Advertising roles

- [ ] **Step 4: Commit**

```bash
git add games/bakery-bash/app/src/components/game/BakeryView.tsx \
        games/bakery-bash/app/src/types/game.ts
git commit -m "POST-01: wire <PriceInput> into BakeryView per product row"
```

---

## Task 18: Add Finance "Submit Prices" button + `submitPrices` wiring

**Files:**
- Modify: `games/bakery-bash/app/src/pages/GamePage.tsx`

- [ ] **Step 1: Locate existing submit buttons**

In `GamePage.tsx`, find the submit button cluster (Operations' "Submit Decisions", Advertising's ad-bid submit). Note how the existing handler calls `httpsCallable(functions, 'submitDecision')`.

- [ ] **Step 2: Add `submitPrices` handler and button**

Near the existing handlers, add:

```tsx
const handleSubmitPrices = useCallback(async () => {
  try {
    const callable = httpsCallable<{
      gameId: string;
      productPrices: Record<ProductKey, number>;
    }, { submitted: boolean }>(functions, 'submitPrices');
    await callable({
      gameId,
      productPrices: draft.productPrices,
    });
    // Flash success toast or update local state — match existing submitDecision handler
  } catch (err) {
    dispatch({ type: 'setError', error: humanizeFunctionError(err) });
  }
}, [gameId, draft.productPrices, dispatch]);
```

Render a new button next to the existing submit buttons:

```tsx
{roleOwnsPricing(role) && (
  <button
    type="button"
    onClick={handleSubmitPrices}
    disabled={phase !== 'decide'}
    className="..."   /* match existing submit button class */
  >
    Submit Prices
  </button>
)}
```

- [ ] **Step 3: Run dev server and exercise end-to-end**

```bash
cd games/bakery-bash/app && npm run dev
```

In the browser:
1. Start the Firebase emulator with seed data
2. Join a game as Finance role
3. Click "Submit Prices" → verify a toast / state change
4. Open the Firestore emulator UI → verify `decisions/round_1.productPrices` is set

- [ ] **Step 4: Commit**

```bash
git add games/bakery-bash/app/src/pages/GamePage.tsx
git commit -m "POST-01: wire Submit Prices button to submitPrices callable"
```

---

## Task 19: Adversarial tests

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/__tests__/test-adversarial.js`

- [ ] **Step 1: Write adversarial tests**

Append to `test-adversarial.js`:

```js
describe('validateProductPrices — adversarial', () => {
  it('clamps price = ceiling + 0.01 to ceiling', () => {
    const out = validation.validateProductPrices({ coffee: 6.51 });
    near(out.coffee, 6.50, 0.001);
  });
  it('clamps price = floor - 0.01 to floor', () => {
    const out = validation.validateProductPrices({ coffee: 1.99 });
    near(out.coffee, 2.00, 0.001);
  });
  it('rejects string values', () => {
    throws(() => validation.validateProductPrices({ coffee: 'free' }), /finite positive number/);
  });
  it('rejects MIG-01 legacy keys', () => {
    throws(() => validation.validateProductPrices({ latte: 5 }), /unknown product "latte"/);
    throws(() => validation.validateProductPrices({ matchaLatte: 6 }), /unknown product "matchaLatte"/);
  });
  it('treats null as empty (carry-over path)', () => {
    deepEq(validation.validateProductPrices(null), {});
  });
  it('rejects Infinity / -Infinity', () => {
    throws(() => validation.validateProductPrices({ coffee: Infinity }),  /finite positive number/);
    throws(() => validation.validateProductPrices({ coffee: -Infinity }), /finite positive number/);
  });
});
```

Also update any existing adversarial test that constructs a full decision payload to include `productPrices` where relevant (most won't need it — they were written pre-POST-01 and test other surfaces).

- [ ] **Step 2: Run adversarial suite**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-adversarial.js
```
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/__tests__/test-adversarial.js
git commit -m "POST-01: adversarial tests for productPrices validation"
```

---

## Task 20: Stress test with randomized prices

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/__tests__/test-stress.js`

- [ ] **Step 1: Add a 20-player randomized-prices simulation**

Append to `test-stress.js`:

```js
describe('stress — 20 players with randomized productPrices', () => {
  const { PRICE_ZONES, PRODUCT_KEYS } = require('../config');

  function randomPrice(cfg) {
    const steps = Math.round((cfg.ceiling - cfg.floor) / 0.25);
    const stepIndex = Math.floor(Math.random() * (steps + 1));
    return cfg.floor + stepIndex * 0.25;
  }

  it('completes without error and keeps pool conserved', () => {
    const players = Array.from({ length: 20 }, (_, i) => ({
      playerId: `P${i}`,
      displayName: `Player ${i}`,
      decision: {
        menu: PRODUCT_KEYS.reduce((a, p) => ({ ...a, [p]: true }), {}),
        quantities: PRODUCT_KEYS.reduce((a, p) => ({ ...a, [p]: 10 }), {}),
        sousChefCount: 0,
        sousChefAssignments: {},
        productPrices: PRODUCT_KEYS.reduce((a, p) => ({ ...a, [p]: randomPrice(PRICE_ZONES[p]) }), {}),
      },
      chefs: [],
      budget: 500000,
      ads: null,
      priorSubmittedPrices: [],
      auctionResults: {},
    }));
    const roundPreferences = { modifiers: PRODUCT_KEYS.reduce((a, p) => ({ ...a, [p]: 1.0 }), {}) };

    const start = Date.now();
    const { results } = simulation.runSimulation(players, roundPreferences, {});
    const elapsedMs = Date.now() - start;

    eq(results.length, 20);
    ok(elapsedMs < 500, `sim elapsed ${elapsedMs}ms (budget 500ms)`);

    for (const product of PRODUCT_KEYS) {
      const totalAlloc = results.reduce((s, r) => s + ((r.perProductSatisfaction && r.perProductSatisfaction[product] && r.perProductSatisfaction[product].qtySold) || 0), 0);
      const basePool = config.PRODUCT_CATALOG[product].baseDemand * 1.0; // round modifier 1.0
      ok(totalAlloc <= basePool * 1.05, `${product}: pool conserved (total ${totalAlloc}, pool ${basePool})`);
    }
  });
});
```

- [ ] **Step 2: Run stress test**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-stress.js
```
Expected: passes; elapsed well under 500ms.

- [ ] **Step 3: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/__tests__/test-stress.js
git commit -m "POST-01: stress test — 20 players with randomized prices"
```

---

## Task 21: Integration smoke — floor vs ceiling two-player run

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/__tests__/test-suite.js`

- [ ] **Step 1: Add the integration test**

Append to `test-suite.js`:

```js
describe('integration — floor vs ceiling head-to-head (POST-01)', () => {
  const { PRODUCT_KEYS } = require('../config');

  it('floor player captures >60% of customers; ceiling player <20%', () => {
    const basePlayer = (id, priceStrategy /* 'floor' | 'ceiling' */) => ({
      playerId: id,
      displayName: id,
      decision: {
        menu:       PRODUCT_KEYS.reduce((a, p) => ({ ...a, [p]: true }), {}),
        quantities: PRODUCT_KEYS.reduce((a, p) => ({ ...a, [p]: 100 }), {}), // plenty of stock
        sousChefCount: 0,
        sousChefAssignments: {},
        productPrices: PRODUCT_KEYS.reduce((a, p) => {
          const z = config.PRICE_ZONES[p];
          return { ...a, [p]: priceStrategy === 'floor' ? z.floor : z.ceiling };
        }, {}),
      },
      chefs: [],
      budget: 500000,
      ads: null,
      priorSubmittedPrices: [],
      auctionResults: {},
    });

    const players = [basePlayer('A', 'floor'), basePlayer('B', 'ceiling')];
    const roundPreferences = { modifiers: PRODUCT_KEYS.reduce((a, p) => ({ ...a, [p]: 1.0 }), {}) };

    const { results } = simulation.runSimulation(players, roundPreferences, {});
    const totalCustomers = results.reduce((s, r) => s + (r.customerCount || 0), 0);
    const rowA = results.find((r) => r.playerId === 'A');
    const rowB = results.find((r) => r.playerId === 'B');

    const shareA = rowA.customerCount / totalCustomers;
    const shareB = rowB.customerCount / totalCustomers;
    ok(shareA > 0.6,  `A (floor) share ${shareA.toFixed(2)} > 0.6`);
    ok(shareB < 0.20, `B (ceiling) share ${shareB.toFixed(2)} < 0.20`);
  });
});
```

- [ ] **Step 2: Run**

```bash
cd games/bakery-bash/backend/functions && node modules/__tests__/test-suite.js
```
Expected: integration test passes.

- [ ] **Step 3: Commit**

```bash
git add games/bakery-bash/backend/functions/modules/__tests__/test-suite.js
git commit -m "POST-01: integration test — floor vs ceiling head-to-head allocation"
```

---

## Task 22: Update documentation and flip roadmap status

**Files:**
- Modify: `games/bakery-bash/BACKEND.md`
- Modify: `games/bakery-bash/projectRoadmap.md`

- [ ] **Step 1: Update `BACKEND.md` config reference**

Open `games/bakery-bash/BACKEND.md`. Find the config-constants section (around line 448–456 where `Product sell prices` is listed). Add entries:

```markdown
| PRICE_ZONES per product | floor/competitive/premium bands + elasticity tier | POST-01 |
| ELASTICITY_COEFFICIENTS | High 1.5 / Medium 1.0 / Low 0.6 — tuning placeholder per DEC-13 | POST-01 |
| PRICE_STEP | $0.25 grid | POST-01 |
| FLOOR_BONUS | +15% demand multiplier when in Floor zone | POST-01 |
| MULTIPLIER_FLOOR | 0.1 — lowest allowed priceDemandMultiplier | POST-01 |
```

Also add a short prose block describing the carry-over rule:

```markdown
### POST-01 per-product pricing

Each round, Finance may submit a partial or full `productPrices` map
via the `submitPrices` callable. Simulation resolves each product's
price with this fallback chain: current round submission → most recent
prior submission → catalog `basePrice`. The resolved price feeds both
the competitive-allocation weight (`satisfaction × priceDemandMultiplier`)
and the revenue calculation. See `docs/superpowers/specs/2026-04-21-post-01-dynamic-pricing-design.md`
for the full spec.
```

- [ ] **Step 2: Flip POST-01 in the roadmap**

Open `games/bakery-bash/projectRoadmap.md`. Find the POST-01 entry (around line 646) and change:

```markdown
- [ ] **POST-01** — Per-product dynamic pricing
```

to:

```markdown
- [x] **POST-01** — Per-product dynamic pricing — landed 2026-04-21
```

- [ ] **Step 3: Commit**

```bash
git add games/bakery-bash/BACKEND.md \
        games/bakery-bash/projectRoadmap.md
git commit -m "POST-01: docs + roadmap flip"
```

---

## Final Verification

After all tasks are committed, run the full backend test suite once more as a regression check:

```bash
cd games/bakery-bash/backend/functions && \
  node modules/__tests__/test-suite.js && \
  node modules/__tests__/test-compliance.js && \
  node modules/__tests__/test-adversarial.js && \
  node modules/__tests__/test-stress.js && \
  node modules/__tests__/test-lifecycle.js
```

Expected: all suites pass.

Also:

```bash
cd games/bakery-bash/app && npx tsc -b --noEmit && npm run lint && npm run build
```

Expected: no TypeScript errors, no lint errors, build succeeds.
