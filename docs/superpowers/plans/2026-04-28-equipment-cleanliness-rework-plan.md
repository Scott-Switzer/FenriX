# Equipment & Cleanliness Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead Maintenance and Chef Satisfaction systems with two new player-visible mechanics — Equipment Grade (A–F upgrade ladder) and Cleanliness Grade (drift-driven by maintenance staffing) — and reshape the CSV export to match.

**Architecture:** Surgical bolt-on to the existing revenue pipeline. New pure helpers in a dedicated module (`equipment-cleanliness.js`). Insertion points at specific lines in `simulation.js` for capacity/satisfaction multipliers, drift, and upgrade application. Hard removals of three legacy systems (chef satisfaction, MaintenanceBars/MaintenanceTask, burglary curveball).

**Tech Stack:** Node.js (CommonJS, mocha + node:assert/strict tests), TypeScript (React frontend), Firestore.

**Spec:** [docs/superpowers/specs/2026-04-28-equipment-cleanliness-rework-design.md](docs/superpowers/specs/2026-04-28-equipment-cleanliness-rework-design.md)

---

## Phase A — Config and pure helpers (additive, no behavior change yet)

### Task A1: Add config constants

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/config.js`

- [ ] **Step 1: Append new constants before the `module.exports = {` block**

Add to `config.js` (just before the closing `module.exports`, around line 685):

```js
// ---------------------------------------------------------------------------
// Equipment & Cleanliness (rework, 2026-04-28)
// ---------------------------------------------------------------------------

const EQUIPMENT_GRADES = ['F', 'E', 'D', 'C', 'B', 'A'];

const EQUIPMENT_TIER_COSTS = {
  // Cost to upgrade FROM the listed grade (so 'F' → cost to go F→E)
  F: 400, E: 600, D: 800, C: 1000, B: 1200, A: 0,
};

const EQUIPMENT_CAPACITY_FACTOR = {
  F: 0.90, E: 0.94, D: 0.97, C: 1.00, B: 1.03, A: 1.07,
};

const EQUIPMENT_SATISFACTION_FACTOR = {
  F: 0.95, E: 0.97, D: 0.99, C: 1.00, B: 1.02, A: 1.05,
};

const CLEANLINESS_SATISFACTION_FACTOR = {
  F: 0.90, E: 0.94, D: 0.97, C: 1.00, B: 1.03, A: 1.07,
};

// Score-to-grade bands. 0-100 internal score → letter grade.
const CLEANLINESS_BANDS = [
  { grade: 'F', min:  0, max: 17  },
  { grade: 'E', min: 17, max: 34  },
  { grade: 'D', min: 34, max: 51  },
  { grade: 'C', min: 51, max: 68  },
  { grade: 'B', min: 68, max: 85  },
  { grade: 'A', min: 85, max: 101 },  // 100 falls in A
];

const CLEANLINESS_STAFF_BOOST_PER_HEAD = 20;
const CLEANLINESS_DRAIN_PER_CUSTOMER   = 0.20;
const MAINTENANCE_STAFF_COST = 20;

const DEFAULT_EQUIPMENT_GRADE         = 'C';
const DEFAULT_CLEANLINESS_SCORE       = 75;  // mid-B
const DEFAULT_MAINTENANCE_STAFF_COUNT = 2;
```

- [ ] **Step 2: Add to module.exports**

In the `module.exports = {` block at the bottom of config.js, append these names:

```js
  EQUIPMENT_GRADES,
  EQUIPMENT_TIER_COSTS,
  EQUIPMENT_CAPACITY_FACTOR,
  EQUIPMENT_SATISFACTION_FACTOR,
  CLEANLINESS_SATISFACTION_FACTOR,
  CLEANLINESS_BANDS,
  CLEANLINESS_STAFF_BOOST_PER_HEAD,
  CLEANLINESS_DRAIN_PER_CUSTOMER,
  MAINTENANCE_STAFF_COST,
  DEFAULT_EQUIPMENT_GRADE,
  DEFAULT_CLEANLINESS_SCORE,
  DEFAULT_MAINTENANCE_STAFF_COUNT,
```

- [ ] **Step 3: Verify nothing breaks**

Run: `cd games/bakery-bash/backend && npm test`
Expected: existing test suite passes (no behavior change yet).

- [ ] **Step 4: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend/functions/modules/config.js
git commit -m "feat(bakery-bash): add equipment+cleanliness config constants"
```

---

### Task A2: Create equipment-cleanliness helpers module with TDD

**Files:**
- Create: `games/bakery-bash/backend/functions/modules/equipment-cleanliness.js`
- Test: `games/bakery-bash/backend/test/equipment-cleanliness.test.js`

- [ ] **Step 1: Write the failing test file**

Create `games/bakery-bash/backend/test/equipment-cleanliness.test.js`:

```js
const assert = require('node:assert/strict');
const {
  equipmentFactorCapacity,
  equipmentFactorSatisfaction,
  cleanlinessFactor,
  gradeFromScore,
  cleanlinessDriftDelta,
  nextEquipmentGrade,
  tierUpgradeCost,
} = require('../functions/modules/equipment-cleanliness');

describe('equipment-cleanliness helpers', () => {
  describe('equipmentFactorCapacity', () => {
    it('returns the table value per grade', () => {
      assert.equal(equipmentFactorCapacity('F'), 0.90);
      assert.equal(equipmentFactorCapacity('C'), 1.00);
      assert.equal(equipmentFactorCapacity('A'), 1.07);
    });
    it('falls back to 1.00 for unknown grades', () => {
      assert.equal(equipmentFactorCapacity('Z'), 1.00);
      assert.equal(equipmentFactorCapacity(undefined), 1.00);
    });
  });

  describe('equipmentFactorSatisfaction', () => {
    it('returns the table value per grade', () => {
      assert.equal(equipmentFactorSatisfaction('F'), 0.95);
      assert.equal(equipmentFactorSatisfaction('C'), 1.00);
      assert.equal(equipmentFactorSatisfaction('A'), 1.05);
    });
  });

  describe('cleanlinessFactor', () => {
    it('returns the table value per grade', () => {
      assert.equal(cleanlinessFactor('F'), 0.90);
      assert.equal(cleanlinessFactor('C'), 1.00);
      assert.equal(cleanlinessFactor('A'), 1.07);
    });
  });

  describe('gradeFromScore', () => {
    it('maps band edges correctly', () => {
      assert.equal(gradeFromScore(0),  'F');
      assert.equal(gradeFromScore(16), 'F');
      assert.equal(gradeFromScore(17), 'E');
      assert.equal(gradeFromScore(50), 'D');
      assert.equal(gradeFromScore(60), 'C');
      assert.equal(gradeFromScore(75), 'B');
      assert.equal(gradeFromScore(85), 'A');
      assert.equal(gradeFromScore(100), 'A');
    });
    it('clamps out-of-range scores', () => {
      assert.equal(gradeFromScore(-5),  'F');
      assert.equal(gradeFromScore(150), 'A');
    });
  });

  describe('cleanlinessDriftDelta', () => {
    it('produces -40/0/+40 at 200 customers, 0/2/4 staff', () => {
      assert.equal(cleanlinessDriftDelta(0, 200), -40);
      assert.equal(cleanlinessDriftDelta(2, 200), 0);
      assert.equal(cleanlinessDriftDelta(4, 200), 40);
    });
    it('clamps non-numeric inputs to 0', () => {
      assert.equal(cleanlinessDriftDelta(NaN, 200), -40);
      assert.equal(cleanlinessDriftDelta(2, NaN), 40);
    });
  });

  describe('nextEquipmentGrade', () => {
    it('returns next-up grade', () => {
      assert.equal(nextEquipmentGrade('F'), 'E');
      assert.equal(nextEquipmentGrade('C'), 'B');
      assert.equal(nextEquipmentGrade('B'), 'A');
    });
    it('returns null at A (no further upgrade)', () => {
      assert.equal(nextEquipmentGrade('A'), null);
    });
    it('returns null for unknown grades', () => {
      assert.equal(nextEquipmentGrade('Z'), null);
    });
  });

  describe('tierUpgradeCost', () => {
    it('returns cost from each upgradable grade', () => {
      assert.equal(tierUpgradeCost('F'), 400);
      assert.equal(tierUpgradeCost('E'), 600);
      assert.equal(tierUpgradeCost('D'), 800);
      assert.equal(tierUpgradeCost('C'), 1000);
      assert.equal(tierUpgradeCost('B'), 1200);
    });
    it('returns null at A (no upgrade available)', () => {
      assert.equal(tierUpgradeCost('A'), null);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (module doesn't exist yet)**

Run: `cd games/bakery-bash/backend && npx mocha test/equipment-cleanliness.test.js`
Expected: FAIL with `Error: Cannot find module '../functions/modules/equipment-cleanliness'`.

- [ ] **Step 3: Create the helper module**

Create `games/bakery-bash/backend/functions/modules/equipment-cleanliness.js`:

```js
/**
 * equipment-cleanliness.js — Pure helpers for the equipment grade and
 * cleanliness drift mechanics. CommonJS, no Firebase deps.
 */

const {
  EQUIPMENT_GRADES,
  EQUIPMENT_TIER_COSTS,
  EQUIPMENT_CAPACITY_FACTOR,
  EQUIPMENT_SATISFACTION_FACTOR,
  CLEANLINESS_SATISFACTION_FACTOR,
  CLEANLINESS_BANDS,
  CLEANLINESS_STAFF_BOOST_PER_HEAD,
  CLEANLINESS_DRAIN_PER_CUSTOMER,
} = require('./config');

function equipmentFactorCapacity(grade) {
  const v = EQUIPMENT_CAPACITY_FACTOR[grade];
  return Number.isFinite(v) ? v : 1.00;
}

function equipmentFactorSatisfaction(grade) {
  const v = EQUIPMENT_SATISFACTION_FACTOR[grade];
  return Number.isFinite(v) ? v : 1.00;
}

function cleanlinessFactor(grade) {
  const v = CLEANLINESS_SATISFACTION_FACTOR[grade];
  return Number.isFinite(v) ? v : 1.00;
}

function gradeFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return 'F';
  if (n >= 100) return 'A';
  for (const band of CLEANLINESS_BANDS) {
    if (n >= band.min && n < band.max) return band.grade;
  }
  return 'F';
}

function cleanlinessDriftDelta(maintenanceStaff, customers) {
  const s = Number.isFinite(Number(maintenanceStaff)) ? Number(maintenanceStaff) : 0;
  const c = Number.isFinite(Number(customers)) ? Number(customers) : 0;
  return s * CLEANLINESS_STAFF_BOOST_PER_HEAD - c * CLEANLINESS_DRAIN_PER_CUSTOMER;
}

function nextEquipmentGrade(grade) {
  const idx = EQUIPMENT_GRADES.indexOf(grade);
  if (idx < 0) return null;
  if (idx === EQUIPMENT_GRADES.length - 1) return null; // already at A
  return EQUIPMENT_GRADES[idx + 1];
}

function tierUpgradeCost(currentGrade) {
  if (currentGrade === 'A') return null;
  const cost = EQUIPMENT_TIER_COSTS[currentGrade];
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}

module.exports = {
  equipmentFactorCapacity,
  equipmentFactorSatisfaction,
  cleanlinessFactor,
  gradeFromScore,
  cleanlinessDriftDelta,
  nextEquipmentGrade,
  tierUpgradeCost,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd games/bakery-bash/backend && npx mocha test/equipment-cleanliness.test.js`
Expected: all 7 describe blocks pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend/functions/modules/equipment-cleanliness.js \
        games/bakery-bash/backend/test/equipment-cleanliness.test.js
git commit -m "feat(bakery-bash): add equipment+cleanliness pure helpers with tests"
```

---

## Phase B — Type system and decision validation

### Task B1: Add EquipmentGrade type and player-state fields to game.ts

**Files:**
- Modify: `games/bakery-bash/app/src/types/game.ts`

- [ ] **Step 1: Add the EquipmentGrade type alias**

In `app/src/types/game.ts`, after the `ChefSkillTier` type around line 257, add:

```typescript
export type EquipmentGrade = 'F' | 'E' | 'D' | 'C' | 'B' | 'A';
```

- [ ] **Step 2: Add fields to GameState (around line 660+, near maintenanceBars)**

In the `GameState` interface, add these fields:

```typescript
  /** Equipment grade A-F. Default C; bumps one tier per round when upgraded. */
  equipmentGrade: EquipmentGrade;
  /** Cleanliness internal score 0-100. Drifts each round. */
  cleanlinessScore: number;
  /** Cleanliness grade derived from cleanlinessScore — cached for UI. */
  cleanlinessGrade: EquipmentGrade;
```

- [ ] **Step 3: Add `equipmentUpgradePurchased` to PendingDecisionDraft**

In the `PendingDecisionDraft` interface (around line 340+), add:

```typescript
  /** When true, simulation will deduct tierUpgradeCost(currentGrade) and bump grade. */
  equipmentUpgradePurchased?: boolean;
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd games/bakery-bash/app && npx tsc --noEmit`
Expected: clean output (no new errors). If existing chef-sat / MaintenanceBars references show errors, that's fine — we'll fix them in Phase D.

- [ ] **Step 5: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/app/src/types/game.ts
git commit -m "feat(bakery-bash): add EquipmentGrade type and equipment+cleanliness fields"
```

---

### Task B2: Extend decision validation

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/decision-validation.js`

- [ ] **Step 1: Locate the decision validator**

Open `decision-validation.js`. Around line 173 the `sousChefCount` check happens. Find the place where the validated decision object is assembled (around line 219 — `return { sousChefCount, ... }`).

- [ ] **Step 2: Add validation and pass-through for new fields**

Add this block before the final `return`:

```js
  // --- equipmentUpgradePurchased (boolean, default false) ---
  let equipmentUpgradePurchased = false;
  if (data.equipmentUpgradePurchased !== undefined && data.equipmentUpgradePurchased !== null) {
    if (typeof data.equipmentUpgradePurchased !== 'boolean') {
      fail('invalid-argument', `equipmentUpgradePurchased must be a boolean`);
    }
    equipmentUpgradePurchased = data.equipmentUpgradePurchased;
  }

  // --- staffCounts.maintenanceGuys (non-negative int, default 2) ---
  // staffCounts is a permissive object today; we add only the maintenanceGuys
  // bound check and leave other keys untouched.
  const staffCounts = (data.staffCounts && typeof data.staffCounts === 'object')
    ? { ...data.staffCounts }
    : {};
  if (staffCounts.maintenanceGuys === undefined || staffCounts.maintenanceGuys === null) {
    staffCounts.maintenanceGuys = 2; // default
  } else {
    staffCounts.maintenanceGuys = requireNonNegInt(
      staffCounts.maintenanceGuys, 'staffCounts.maintenanceGuys'
    );
  }
```

- [ ] **Step 3: Include both in the returned validated decision object**

Update the `return` to include the new fields:

```js
  return {
    // ... existing fields ...
    equipmentUpgradePurchased,
    staffCounts,
  };
```

- [ ] **Step 4: Verify existing tests still pass**

Run: `cd games/bakery-bash/backend && npm test`
Expected: existing decision-validation tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend/functions/modules/decision-validation.js
git commit -m "feat(bakery-bash): validate equipmentUpgradePurchased + maintenanceGuys"
```

---

## Phase C — Wire mechanics into the simulation pipeline

### Task C1: Apply equipment factor to capacity and satisfaction

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/simulation.js`

- [ ] **Step 1: Add the helper imports at the top of simulation.js**

Around line 1-30 where other modules are imported, add:

```js
const {
  equipmentFactorCapacity,
  equipmentFactorSatisfaction,
  cleanlinessFactor,
  gradeFromScore,
  cleanlinessDriftDelta,
  nextEquipmentGrade,
  tierUpgradeCost,
} = require('./equipment-cleanliness');
```

- [ ] **Step 2: Replace the chef-sat throughput multiplier with equipment factor**

At line 181 in `computePlayerOutputAndSatisfaction`, replace:

```js
  const chefSatisfactionScore = calculateChefSatisfactionScore(sousChefCount, config);
```

with:

```js
  const equipmentGrade = player.equipmentGrade || 'C';
  const cleanlinessGrade = gradeFromScore(player.cleanlinessScore);
```

At line 195, replace:

```js
    const effectiveOutput = calculateEffectiveOutput(supplyCapped, chefSatisfactionScore);
```

with:

```js
    const effectiveOutput = supplyCapped * equipmentFactorCapacity(equipmentGrade);
```

- [ ] **Step 3: Apply cleanliness × equipment satisfaction multipliers**

At line 203, replace:

```js
    const satisfactionPct = fillRateToSatisfactionPct(fillRate);
```

with:

```js
    const rawSat = fillRateToSatisfactionPct(fillRate);
    const satisfactionPct = Math.max(0, Math.min(100,
      rawSat * cleanlinessFactor(cleanlinessGrade) * equipmentFactorSatisfaction(equipmentGrade)
    ));
```

- [ ] **Step 4: Update the function's return shape**

At line 216, replace:

```js
  return { offeredProducts, chefSatisfactionScore, perProduct };
```

with:

```js
  return { offeredProducts, perProduct, equipmentGrade, cleanlinessGrade };
```

- [ ] **Step 5: Update the runSimulation call sites**

In `runSimulation`, find the destructuring at line 294-295:

```js
    const { offeredProducts, chefSatisfactionScore, perProduct } =
      computePlayerOutputAndSatisfaction(player, roundPreferences, config);
```

Replace with:

```js
    const { offeredProducts, perProduct, equipmentGrade, cleanlinessGrade } =
      computePlayerOutputAndSatisfaction(player, roundPreferences, config);
```

And in the returned object from this map (line 301-307), drop `chefSatisfactionScore` and add the two new ones:

```js
    return {
      player,
      offeredProducts,
      perProduct,
      aggregateSatisfactionPct,
      equipmentGrade,
      cleanlinessGrade,
    };
```

- [ ] **Step 6: Run existing simulation tests, expect breakage on chef-sat references**

Run: `cd games/bakery-bash/backend && npx mocha test/multi-day-simulation.test.js test/revenue.test.js`
Expected: some failures referencing `chefSatisfactionScore`. Capture them — they get fixed in C2-C4 and Phase D.

- [ ] **Step 7: Don't commit yet** — capacity is wired but result-emit, drift, and upgrade still pending. Continue to C2.

---

### Task C2: Wire equipment upgrade purchase

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/simulation.js`

- [ ] **Step 1: Add upgrade application in cost accounting (~line 482-510)**

Right after the existing `if (!skipCostAccounting) { ... }` block that computes `totalSpent`, BEFORE the loan-shark calculation, add equipment upgrade accounting:

Find this section (around line 502):

```js
      const roundCosts = calculateRoundCosts(costDecision, costAuction, config);
      totalSpent = roundCosts.totalSpent;
```

After it, add:

```js
      // Equipment upgrade — deduct cost if requested and the player has cash + room to upgrade.
      // Returns the new grade for the result; original `equipmentGrade` (read above) is unchanged
      // for the rest of THIS round's compute. The bump applies to NEXT round.
      const upgradeRequested = !!decision.equipmentUpgradePurchased;
      const _eqGradeForRound = pp.equipmentGrade || 'C';
      const _nextGrade = nextEquipmentGrade(_eqGradeForRound);
      const _upgradeCost = tierUpgradeCost(_eqGradeForRound);
      let equipmentUpgradeApplied = false;
      let nextRoundEquipmentGrade = _eqGradeForRound;
      if (upgradeRequested && _nextGrade && _upgradeCost && (budgetCurrent - totalSpent) >= _upgradeCost) {
        totalSpent += _upgradeCost;
        nextRoundEquipmentGrade = _nextGrade;
        equipmentUpgradeApplied = true;
      }

      // Maintenance staff cost — flat per-head, deducted alongside other staff.
      const maintenanceStaffCount = (decision.staffCounts && Number(decision.staffCounts.maintenanceGuys)) || 0;
      const maintenanceCost = Math.max(0, maintenanceStaffCount) *
        ((config && config.MAINTENANCE_STAFF_COST) || 20);
      totalSpent += maintenanceCost;
```

- [ ] **Step 2: Carry forward when skipCostAccounting=true**

Outside the `if (!skipCostAccounting)` block (so these defaults exist for the multi-day inner-call path), add:

```js
    let nextRoundEquipmentGrade = pp.equipmentGrade || 'C';
    let equipmentUpgradeApplied = false;
```

at the top of the per-player loop (around line 378). Then move the assignment of these variables INSIDE the `if (!skipCostAccounting)` block (don't declare with `let` again — just assign). This way both code paths converge on a defined value.

- [ ] **Step 3: Don't commit yet** — drift and result emit still pending.

---

### Task C3: Compute cleanliness drift and emit new result fields

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/simulation.js`

- [ ] **Step 1: Compute drift after revenue, before result push**

After `revenueNet` is computed (around line 510), add:

```js
    // Cleanliness drift for next round.
    const _maintenanceStaffCount = (decision.staffCounts && Number(decision.staffCounts.maintenanceGuys)) || 0;
    const _currentScore = Number.isFinite(p.cleanlinessScore) ? p.cleanlinessScore : 75;
    const _delta = cleanlinessDriftDelta(_maintenanceStaffCount, customerCount);
    const cleanlinessScoreNext = Math.max(0, Math.min(100, _currentScore + _delta));
    const cleanlinessGradeNext = gradeFromScore(cleanlinessScoreNext);
```

- [ ] **Step 2: Update the buildCsvRow call to include new fields**

The `buildCsvRow(...)` call at line 528-546. Drop `chefSatisfactionScore`. Add the new fields:

```js
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
      productPrices: resolvedPricesPerPlayer[p.playerId] || {},
      // New equipment + cleanliness fields:
      equipmentGrade: pp.equipmentGrade,
      cleanlinessScore: cleanlinessScoreNext,
      cleanlinessGrade: cleanlinessGradeNext,
      equipmentUpgradePurchased: equipmentUpgradeApplied,
      // For professor export
      playerId: p.playerId,
      displayName: p.displayName,
      bakeryName: p.bakeryName,
    });
```

- [ ] **Step 3: Update result push (around line 569)**

Replace the existing `results.push({ ... })` call. Drop `chefSatisfactionScore`, `burglary`, `burglaryAmount`. Add the new fields:

```js
    results.push({
      playerId: p.playerId,
      displayName: p.displayName,
      bakeryName: p.bakeryName,
      revenueGross,
      revenueNet,
      amountBorrowed,
      interestCharged,
      totalSpent,
      budgetAfter,
      customerCount,
      perProductCustomers,
      aggregateSatisfactionPct: postSelloutAggregate,
      perProductSatisfaction,
      returningCustomersEarned,
      selloutAnywhere,
      adWon: adWins[0] || null,
      adWins,
      adBidPaid,
      chefsWon,
      chefBidPaid,
      csvRow,
      productPrices: resolvedPricesPerPlayer[p.playerId] || {},
      revenueBreakdown,
      // New: equipment + cleanliness state for next round persistence.
      equipmentGrade: nextRoundEquipmentGrade,
      cleanlinessScore: cleanlinessScoreNext,
      cleanlinessGrade: cleanlinessGradeNext,
      equipmentUpgradeApplied,
    });
```

Note: `budgetAfter` (not `budgetAfterBurglary`) — burglary block is being removed in Phase D.

- [ ] **Step 4: Run sim tests; expect chef-sat references to fail (we fix in Phase D)**

Run: `cd games/bakery-bash/backend && npx mocha test/multi-day-simulation.test.js test/revenue.test.js`
Expected: chef-sat-related assertions fail. Burglary still works (we delete in Phase D). 

- [ ] **Step 5: Commit Phase C as a single batch**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend/functions/modules/simulation.js
git commit -m "feat(bakery-bash): wire equipment+cleanliness into simulation pipeline"
```

---

## Phase D — Removals (chef satisfaction, MaintenanceBars, burglary)

### Task D1: Remove burglary code path

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/simulation.js`
- Modify: `games/bakery-bash/backend/functions/modules/multi-day-simulation.js`
- Modify: `games/bakery-bash/backend/functions/modules/config.js`

- [ ] **Step 1: Delete burglary block in simulation.js**

Around line 548-567 in `simulation.js`, delete the entire `// --- Burglar curveball (BE-N06) — fires when cleanliness is critically low ---` block, including the `let burglary = false;` initialization and the `if (!skipCostAccounting) { ... }` body.

If `budgetAfterBurglary` is referenced after that block (line 578), replace it with `budgetAfter`.

- [ ] **Step 2: Delete burglary mirror in multi-day-simulation.js**

Around line 279-285 in `multi-day-simulation.js`, find and delete the burglary block. Look for `if (typeof p.cleanliness_pct === 'number' && p.cleanliness_pct < burglaryThreshold)` and delete the surrounding logic.

- [ ] **Step 3: Delete burglary config in config.js**

Search for `curveballs:` in `config.js` (around line 480). Delete the entire `curveballs: { ... }` block from `DEFAULT_GAME_CONFIG` AND from the `mergeConfig` function below it (around line 670 — `curveballs: { burglaryThreshold: ... }`). Remove `curveballs` from the result of `mergeConfig`.

- [ ] **Step 4: Run tests, fix any burglary-test breakage**

Run: `cd games/bakery-bash/backend && npm test`
If `multi-day-simulation.test.js` references burglary, delete those test cases.

- [ ] **Step 5: Verify with grep**

Run: `grep -rE "burglary|Burglary" /Users/dylanmassaro/FenriX/games/bakery-bash/{backend/functions,app/src}`
Expected: only matches in CHANGELOG / archived comments. No live code references.

- [ ] **Step 6: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend
git commit -m "refactor(bakery-bash): remove dead burglary curveball"
```

---

### Task D2: Remove chef satisfaction system

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/chef-system.js`
- Modify: `games/bakery-bash/backend/functions/modules/config.js`
- Modify: `games/bakery-bash/app/src/types/game.ts`

- [ ] **Step 1: Delete `calculateChefSatisfactionScore` and `calculateEffectiveOutput`**

In `chef-system.js`, delete the entire `calculateChefSatisfactionScore` function (around line 240-256) and the entire `calculateEffectiveOutput` function (around line 257-265).

Remove both names from the `module.exports` object at the bottom of the file.

- [ ] **Step 2: Delete chef-sat tunables from config.js**

In `config.js` `DEFAULT_GAME_CONFIG`, find and delete:
- `chefSatisfactionThreshold: 4,`
- `chefSatisfactionDecay: 10,` (or 16, depending on current value)
- `chefSatisfactionFloor: 35,`

Also remove their corresponding lines in `mergeConfig`.

- [ ] **Step 3: Remove chef-sat fields from game.ts**

In `app/src/types/game.ts`:
- Delete `chefSatisfactionScore?: number;` from RoundResult (around line 419).
- Delete `chefDepartures?: string[];` from RoundResult (around line 425).
- Delete `chefSatisfactionScores: Record<string, number>;` from GameState (around line 670).

- [ ] **Step 4: Run backend tests**

Run: `cd games/bakery-bash/backend && npm test`

If `chef-system.test.js` references `calculateChefSatisfactionScore`, delete those tests. If `revenue.test.js` references chef satisfaction in its assertions, update them to expect the new equipment-factor behavior (capacity is now multiplied by `equipmentFactorCapacity('C')` = 1.00 for default test players).

- [ ] **Step 5: Type-check the frontend**

Run: `cd games/bakery-bash/app && npx tsc --noEmit`
Fix any references to deleted fields in components — most will be in `ResultsPhase.tsx` / `RoundHeader.tsx`. Replace any chef-sat display with nothing or with the new equipmentGrade.

- [ ] **Step 6: Verify with grep**

Run: `grep -rE "chefSatisfaction|chef_satisfaction|calculateEffectiveOutput|calculateChefSatisfactionScore|chefDepartures" /Users/dylanmassaro/FenriX/games/bakery-bash/{backend/functions,app/src}`
Expected: empty.

- [ ] **Step 7: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash
git commit -m "refactor(bakery-bash): remove chef satisfaction system"
```

---

### Task D3: Remove MaintenanceBars and MaintenanceTask

**Files:**
- Modify: `games/bakery-bash/app/src/types/game.ts`
- Modify: any UI files referencing maintenanceBars

- [ ] **Step 1: Delete MaintenanceTask type**

In `app/src/types/game.ts` around line 178-189, delete the entire `MaintenanceTask` type alias and any `MAINTENANCE_TASKS` constant arrays.

- [ ] **Step 2: Delete MaintenanceBars interface**

In `app/src/types/game.ts` around line 195-200, delete the entire `MaintenanceBars` interface.

- [ ] **Step 3: Delete `maintenanceTasks` from PendingDecisionDraft**

Find and delete the `maintenanceTasks?: MaintenanceTask[];` line in `PendingDecisionDraft` (around line 346).

- [ ] **Step 4: Delete `maintenanceBars` from GameState**

Around line 665, delete `maintenanceBars: MaintenanceBars;`.

Also delete `DEFAULT_MAINTENANCE_BARS` constant if present.

- [ ] **Step 5: Find and fix all consumers**

Run: `grep -rE "maintenanceBars|MaintenanceBars|MaintenanceTask|maintenanceTasks" /Users/dylanmassaro/FenriX/games/bakery-bash/app/src`

For each match:
- `GameContext.tsx`: remove `maintenanceBars` from context state, default value, and exposed value.
- `StatusTab.tsx`: handled in Phase G.
- `BakeryView.tsx`, `GameSidebar.tsx`, `GamePage.tsx`, `RoundHeader.tsx`, `ResultsPhase.tsx`, `SimulatePhase.tsx`, `ProfessorLeaderboardPage.tsx`: delete any references that read or display the bars. If a UI element falls out, remove the element.

- [ ] **Step 6: Type-check**

Run: `cd games/bakery-bash/app && npx tsc --noEmit`
Fix remaining type errors.

- [ ] **Step 7: Verify with grep**

Run: `grep -rE "maintenanceBars|MaintenanceBars|MaintenanceTask|maintenanceTasks" /Users/dylanmassaro/FenriX/games/bakery-bash`
Expected: empty.

- [ ] **Step 8: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash
git commit -m "refactor(bakery-bash): remove MaintenanceBars/MaintenanceTask system"
```

---

## Phase E — CSV reshape

### Task E1: Update CSV columns and row builder

**Files:**
- Modify: `games/bakery-bash/backend/functions/modules/csv-export.js`

- [ ] **Step 1: Drop the obsolete columns**

In the `CSV_COLUMNS` array (around line 49):
- Delete the `chef_satisfaction_score` column entry (line 83).
- Delete the `avg_cleanliness_pct` column entry (line 107).
- Delete the `avg_machine_health_pct` column entry (line 108).

- [ ] **Step 2: Add the new columns and rename**

In their place, add:

```js
  { key: 'equipment_grade',             header: 'equipment_grade',             type: 'string' },
  { key: 'cleanliness_grade',           header: 'cleanliness_grade',           type: 'string' },
  { key: 'cleanliness_score',           header: 'cleanliness_score',           type: 'int'    },
  { key: 'equipment_upgrade_purchased', header: 'equipment_upgrade_purchased', type: 'bool'   },
```

Rename the `maintenance_guy_count` column (line 112):

```js
  { key: 'maintenance_staff_count', header: 'maintenance_staff_count', type: 'int' },
```

- [ ] **Step 3: Update buildCsvRow to populate new columns**

In `buildCsvRow` (around line 264), DROP this line:

```js
  row.chef_satisfaction_score     = firstDefined(r.chefSatisfactionScore);
```

Around line 302-307 (the staff/maintenance section), replace:

```js
  row.avg_cleanliness_pct     = firstDefined(r.avg_cleanliness_pct);
  row.avg_machine_health_pct  = firstDefined(r.avg_machine_health_pct);
  row.bakery_sous_chef_count  = intOrNull(staffCounts.bakerySousChefs);
  row.deli_sous_chef_count    = intOrNull(staffCounts.deliSousChefs);
  row.barista_sous_chef_count = intOrNull(staffCounts.baristaSousChefs);
  row.maintenance_guy_count   = intOrNull(staffCounts.maintenanceGuys);
```

with:

```js
  row.equipment_grade             = firstDefined(r.equipmentGrade);
  row.cleanliness_grade           = firstDefined(r.cleanlinessGrade);
  row.cleanliness_score           = firstDefined(r.cleanlinessScore);
  row.equipment_upgrade_purchased = !!r.equipmentUpgradePurchased;
  row.bakery_sous_chef_count      = intOrNull(staffCounts.bakerySousChefs);
  row.deli_sous_chef_count        = intOrNull(staffCounts.deliSousChefs);
  row.barista_sous_chef_count     = intOrNull(staffCounts.baristaSousChefs);
  row.maintenance_staff_count     = intOrNull(staffCounts.maintenanceGuys);
```

- [ ] **Step 4: Run CSV-related tests**

Run: `cd games/bakery-bash/backend && npx mocha test/`
Update or delete any test that asserts on the dropped column names.

- [ ] **Step 5: Verify a sample CSV**

Run a small smoke check:
```bash
cd /Users/dylanmassaro/FenriX/games/bakery-bash/backend
node -e "
const { CSV_COLUMNS } = require('./functions/modules/csv-export');
console.log(CSV_COLUMNS.map(c => c.header).join(','));
"
```
Expected: column list contains `equipment_grade`, `cleanliness_grade`, `cleanliness_score`, `equipment_upgrade_purchased`, `maintenance_staff_count`, and does NOT contain `chef_satisfaction_score`, `avg_cleanliness_pct`, `avg_machine_health_pct`, `maintenance_guy_count`.

- [ ] **Step 6: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend/functions/modules/csv-export.js \
        games/bakery-bash/backend/test
git commit -m "feat(bakery-bash): reshape CSV with equipment+cleanliness columns"
```

---

## Phase F — Player state initialization and persistence

### Task F1: Initialize new fields on join

**Files:**
- Modify: `games/bakery-bash/backend/functions/index.js`

- [ ] **Step 1: Update player state seed at line 4350**

Around line 4350-4370 (the player-state initialization block on game join), replace:

```js
      chefSatisfactionScores: {},
      maintenanceBars: {
        cleanliness: 100,
        ovenHealth: 100,
        slicerHealth: 100,
        espressoHealth: 100,
      },
```

with:

```js
      equipmentGrade: 'C',
      cleanlinessScore: 75,
      cleanlinessGrade: 'B',
```

- [ ] **Step 2: Find any other player-state seed sites**

Run: `grep -n "sousChefCount: 0" /Users/dylanmassaro/FenriX/games/bakery-bash/backend/functions/index.js`
For each match (line 821, 1209, 1450, 4456 from earlier exploration), check the surrounding initializer block. If it includes `chefSatisfactionScores` or `maintenanceBars`, apply the same replacement.

- [ ] **Step 3: Persist `cleanlinessScore` and `equipmentGrade` between rounds**

Find the per-round persistence site:

```bash
grep -nE "returningCustomersPending\s*[:=]" /Users/dylanmassaro/FenriX/games/bakery-bash/backend/functions/index.js
```

The match(es) point at the spot where `runSimulation` results are written back to each player's Firestore doc for the next round. At each such call site, alongside `returningCustomersPending`, also write the three new fields:

```js
  equipmentGrade: result.equipmentGrade,
  cleanlinessScore: result.cleanlinessScore,
  cleanlinessGrade: result.cleanlinessGrade,
```

(`result` is the per-player object from runSimulation; the field names match what Phase C3 emits.)

- [ ] **Step 4: Run end-to-end smoke**

Run: `cd games/bakery-bash/backend && npx mocha test/multi-day-simulation.test.js`
Expected: passes (or fails only on assertions you update to reference the new fields).

- [ ] **Step 5: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend/functions/index.js
git commit -m "feat(bakery-bash): initialize and persist equipment+cleanliness state"
```

---

## Phase G — UI changes

### Task G1: Update GameContext

**Files:**
- Modify: `games/bakery-bash/app/src/contexts/GameContext.tsx`

- [ ] **Step 1: Drop maintenanceBars; add equipmentGrade/cleanlinessGrade**

Open `app/src/contexts/GameContext.tsx`. Find every line referencing `maintenanceBars` (state declaration, default, value object). Delete each one. Then in the same locations, add:

```typescript
  // In the context state shape:
  equipmentGrade: EquipmentGrade;
  cleanlinessGrade: EquipmentGrade;
  cleanlinessScore: number;

  // In the default value:
  equipmentGrade: 'C',
  cleanlinessGrade: 'B',
  cleanlinessScore: 75,

  // In the consumer (Firestore doc → state):
  equipmentGrade: gameState.equipmentGrade ?? 'C',
  cleanlinessGrade: gameState.cleanlinessGrade ?? 'B',
  cleanlinessScore: gameState.cleanlinessScore ?? 75,
```

Also import `EquipmentGrade` from `../types/game`.

- [ ] **Step 2: Type-check**

Run: `cd games/bakery-bash/app && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/app/src/contexts/GameContext.tsx
git commit -m "feat(bakery-bash): expose equipmentGrade+cleanlinessGrade in context"
```

---

### Task G2: Rewrite StatusTab to show grades instead of bars

**Files:**
- Modify: `games/bakery-bash/app/src/components/game/tabs/StatusTab.tsx`

- [ ] **Step 1: Replace the file contents entirely**

Overwrite `StatusTab.tsx` with:

```tsx
import { useGame } from "../../../contexts/GameContext";

const GRADE_COLORS: Record<string, string> = {
  A: "var(--sage)",
  B: "var(--lime)",
  C: "var(--honey)",
  D: "var(--honey)",
  E: "var(--berry)",
  F: "var(--berry)",
};

interface GradeProps {
  label: string;
  grade: string;
  hint: string;
}

function GradeDisplay({ label, grade, hint }: GradeProps) {
  const color = GRADE_COLORS[grade] || "var(--honey)";
  return (
    <div className="status-tab__grade-row">
      <div className="status-tab__grade-label">{label}</div>
      <div
        className="status-tab__grade-letter"
        style={{ color, fontSize: "3rem", fontWeight: 700, lineHeight: 1 }}
        aria-label={`${label} grade ${grade}`}
      >
        {grade}
      </div>
      <div className="status-tab__grade-hint" style={{ fontSize: "0.85rem", opacity: 0.8 }}>
        {hint}
      </div>
    </div>
  );
}

export function StatusTab() {
  const { equipmentGrade, cleanlinessGrade } = useGame();

  return (
    <div className="status-tab">
      <h3 className="sidebar-tab__title">Kitchen Status</h3>
      <p className="sidebar-tab__hint">
        Equipment and cleanliness are graded A through F. Equipment upgrades
        cost cash; cleanliness drifts each round based on maintenance staffing.
      </p>

      <div className="status-tab__grades" aria-label="Kitchen status grades">
        <GradeDisplay
          label="Equipment"
          grade={equipmentGrade}
          hint="Upgrade during the Decide phase"
        />
        <GradeDisplay
          label="Cleanliness"
          grade={cleanlinessGrade}
          hint="Hire maintenance staff to keep this up"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd games/bakery-bash/app && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Visual smoke check**

Run the dev server and confirm the StatusTab now shows two grade letters (Equipment + Cleanliness) instead of the four health bars. (`cd games/bakery-bash/app && npm run dev`, then click through to a game's sidebar.)

- [ ] **Step 4: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/app/src/components/game/tabs/StatusTab.tsx
git commit -m "feat(bakery-bash): replace health bars with grade letters in StatusTab"
```

---

### Task G3: Add Maintenance Staff and Equipment Upgrade controls to DecidePhase

**Files:**
- Modify: `games/bakery-bash/app/src/pages/phases/DecidePhase.tsx` (or the operations sub-component if it lives in one)

- [ ] **Step 1: Find the existing staff control area**

Run: `grep -n "maintenanceGuys\|staffCounts" /Users/dylanmassaro/FenriX/games/bakery-bash/app/src/pages/phases/DecidePhase.tsx`
Locate where staff counts are rendered. If there's already a maintenance staff input, the work is just labeling and lifting the bound. If not, this is a new control.

- [ ] **Step 2: Add the Maintenance Staff stepper**

Below the existing sous-chef controls, render:

```tsx
<div className="decide-phase__staff-row">
  <label htmlFor="maintenance-staff">Maintenance Staff</label>
  <input
    id="maintenance-staff"
    type="number"
    min={0}
    value={draft.staffCounts?.maintenanceGuys ?? 2}
    onChange={(e) => {
      const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
      updateDraft({
        ...draft,
        staffCounts: { ...(draft.staffCounts || {}), maintenanceGuys: n },
      });
    }}
  />
  <span className="decide-phase__cost-hint">${20 * (draft.staffCounts?.maintenanceGuys ?? 2)}/round</span>
</div>
```

(The exact draft / updateDraft hooks depend on the existing DecidePhase API — adapt to match.)

- [ ] **Step 3: Add the Equipment Upgrade button**

Below the maintenance row:

```tsx
{(() => {
  const grade = gameState.equipmentGrade ?? 'C';
  const next = nextEquipmentGrade(grade); // import this helper
  const cost = tierUpgradeCost(grade);
  const purchased = !!draft.equipmentUpgradePurchased;
  if (!next || cost === null) return <p>Equipment at A — max grade.</p>;
  return (
    <div className="decide-phase__equipment-row">
      <button
        type="button"
        onClick={() =>
          updateDraft({ ...draft, equipmentUpgradePurchased: !purchased })
        }
        aria-pressed={purchased}
      >
        {purchased ? '✓ ' : ''}Upgrade Equipment to {next} (${cost})
      </button>
    </div>
  );
})()}
```

You'll need to import `nextEquipmentGrade` and `tierUpgradeCost` — since these live in the backend module, replicate them as small TS helpers in `app/src/lib/equipment.ts` (mirror the lookup tables) OR fetch them from a config endpoint. For a Friday MVP, the simplest path is a tiny duplicated TS module:

```typescript
// app/src/lib/equipment.ts
const TIER_COSTS: Record<string, number> = {
  F: 400, E: 600, D: 800, C: 1000, B: 1200, A: 0,
};
const GRADES = ['F', 'E', 'D', 'C', 'B', 'A'];

export function nextEquipmentGrade(grade: string): string | null {
  const idx = GRADES.indexOf(grade);
  if (idx < 0 || idx === GRADES.length - 1) return null;
  return GRADES[idx + 1];
}

export function tierUpgradeCost(grade: string): number | null {
  if (grade === 'A') return null;
  const c = TIER_COSTS[grade];
  return Number.isFinite(c) && c > 0 ? c : null;
}
```

- [ ] **Step 4: Type-check + smoke test**

Run: `cd games/bakery-bash/app && npx tsc --noEmit`
Run the dev server, complete a Decide phase, confirm both controls appear and submit.

- [ ] **Step 5: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/app
git commit -m "feat(bakery-bash): add maintenance staff + equipment upgrade controls to DecidePhase"
```

---

## Phase H — End-to-end verification

### Task H1: Run full backend test suite and fix breakage

- [ ] **Step 1: Run all backend tests**

Run: `cd games/bakery-bash/backend && npm test`
Expected: green. If any test fails:
- If it asserts on a removed concept (chef sat, burglary, MaintenanceBars), delete the test.
- If it asserts on numeric output that changed because the equipment factor moved from 1.00 (chef sat at 100) to 1.00 (equipment at C), values should match — no update needed.
- If it asserts on chef-sat-at-100 explicitly, replace with equipment-at-C explicitly.

- [ ] **Step 2: Run a scripted multi-day simulation**

Run: `cd games/bakery-bash/backend && node scripts/test-revenue-flow.js` (if it exists), OR write a short ad-hoc node script that:
1. Builds 4 player states with `equipmentGrade: 'C'`, `cleanlinessScore: 75`.
2. Calls `runSimulation` with a sample decision setting `staffCounts: { maintenanceGuys: 0 }` and 200 customers.
3. Checks that the result includes `cleanlinessScore < 75` (drift fired).

- [ ] **Step 3: Commit any test fixes**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend/test
git commit -m "test(bakery-bash): update tests for equipment+cleanliness rework"
```

---

### Task H2: Run a full game playthrough in dev

- [ ] **Step 1: Start dev environment**

Run: `cd games/bakery-bash/app && npm run dev` and open the local URL.

- [ ] **Step 2: Play one game end-to-end**

- Create a game with 1 player + 3 bots.
- Complete one Decide phase: hire 4 sous chefs, 2 maintenance staff, set qtys to 200/product, no equipment upgrade.
- Run the round.
- Check Results phase: equipment grade should still be C; cleanliness grade should still be B (drift roughly 0 at 200 customers + 2 staff).
- Run a second round: hire 0 maintenance staff. Cleanliness should drop one or two grades.
- Run a third round: purchase Equipment Upgrade. Confirm budget deducts $1000 (C→B) and grade shows B in StatusTab next round.

- [ ] **Step 3: Inspect a sample CSV**

In Firestore (or via a debug endpoint), pull the round CSV. Confirm:
- `equipment_grade`, `cleanliness_grade`, `cleanliness_score`, `equipment_upgrade_purchased`, `maintenance_staff_count` are present.
- `chef_satisfaction_score`, `avg_cleanliness_pct`, `avg_machine_health_pct`, `maintenance_guy_count` are absent.

- [ ] **Step 4: Final grep verification**

Run all three (each should be empty):

```bash
grep -rE "chefSatisfaction|chef_satisfaction|calculateEffectiveOutput|calculateChefSatisfactionScore" /Users/dylanmassaro/FenriX/games/bakery-bash/{backend/functions,app/src}
grep -rE "maintenanceBars|MaintenanceBars|MaintenanceTask|maintenanceTasks" /Users/dylanmassaro/FenriX/games/bakery-bash/{backend/functions,app/src}
grep -rE "burglary|Burglary" /Users/dylanmassaro/FenriX/games/bakery-bash/{backend/functions,app/src}
```

- [ ] **Step 5: Final commit (if any straggler fixes)**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash
git commit -m "chore(bakery-bash): final cleanup post equipment+cleanliness rework"
```

---

## Done

All 10 acceptance criteria from the spec should now hold:

1. ✅ Equipment factor applied to capacity
2. ✅ Equipment + cleanliness factors applied to satisfaction
3. ✅ Cleanliness drift correct at 200 customers (verified by helper test)
4. ✅ Equipment upgrade flow works (budget deduction + grade bump)
5. ✅ Chef satisfaction fully gone (verified by grep)
6. ✅ MaintenanceBars fully gone (verified by grep)
7. ✅ Burglary fully gone (verified by grep)
8. ✅ CSV columns aligned (verified by `node -e` check)
9. ✅ Existing tests still pass
10. ✅ Round-trip game playable (verified manually)
