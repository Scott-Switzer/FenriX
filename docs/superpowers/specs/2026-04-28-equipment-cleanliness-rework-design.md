# Equipment & Cleanliness Rework — Bakery Bash (v5)

**Status:** Design — Friday-achievable scope
**Date:** 2026-04-28
**Target ship:** Friday 2026-05-01 (3 working days)
**Scope:** `games/bakery-bash` — bolt new mechanics onto the existing revenue pipeline; remove dead/legacy systems; reshape CSV.

---

## 1. Problem

The game has three under-leveraged systems plus a CSV that doesn't match the publishing-team's published dataset schema:

1. **Maintenance is a dead end.** [simulation.js:558](games/bakery-bash/backend/functions/modules/simulation.js:558) reads `p.cleanliness_pct`, but **nothing in the backend ever writes it**, so the burglary trigger never fires. The four `MaintenanceBars` ([game.ts:195](games/bakery-bash/app/src/types/game.ts:195)) sit on client state forever at 100.
2. **Chef satisfaction** ([chef-system.js:240](games/bakery-bash/backend/functions/modules/chef-system.js:240)) penalizes throughput as sous chefs grow past 4. It's an internal multiplier students don't see and can't analyze.
3. **CSV columns** like `chef_satisfaction_score` and `avg_machine_health_pct` ([csv-export.js:83,108](games/bakery-bash/backend/functions/modules/csv-export.js:83)) export game-internal concepts that don't appear in the published student dataset.

Goal: make `equipment_grade` and `cleanliness_grade` real, driven mechanics; remove the dead/legacy concepts; align the CSV.

## 2. Goals

- **Equipment grade** (A–F) is a player-visible strategic stat: capacity multiplier + satisfaction multiplier. Upgrades cost cash, one tier per round.
- **Cleanliness grade** (A–F) drifts each round based on `maintenance_staff_count` versus customer volume. Affects satisfaction.
- **Maintenance staff count** is a Decide-phase input replacing the dead `maintenanceTasks` array.
- **Chef satisfaction is removed** as a concept. Capacity becomes `(base + specialty + sous chef contributions) × equipment_factor_capacity`. No morale multiplier.
- **MaintenanceBars are removed** (state, UI, decision input) — replaced by the single `cleanlinessGrade` plus a fixed `equipmentGrade`.
- **Burglary curveball is removed** (currently dead code anyway).
- **CSV is realigned** with the new mechanics.

## 3. Non-Goals (deferred)

- Step 1–9 pipeline rewrite from the v4 spec — **dropped**. The existing `getFootTrafficModifier` / `getReturningCustomerBonus` / `customer-allocation.js` model stays intact.
- `tradition_factor` — **dropped**. Chef nationality already affects output via `chef.specialties` ([chef-system.js:174](games/bakery-bash/backend/functions/modules/chef-system.js:174)); no extra lever needed.
- `PRODUCT_SPECIALTIES` constant — **not needed** (no tradition_factor).
- `hireOrder` field on chefs — **not needed**. The CSV continues to export per-chef columns rather than a single derived "head chef".
- Ad channel rename (TV → Instagram/TikTok), product-catalog expansion (6 → 8 products), `yelp_review_count`, `location_type`, `traffic_zone`, `bakery_size`, etc. — **out of scope**. The CSV ships with what's actually in the game.
- No backwards-compat shim. In-flight games may need to be reset.

---

## 4. Code Surface

### 4.1 Insertion points (where new code goes)

| Where | What happens |
|---|---|
| [simulation.js:181](games/bakery-bash/backend/functions/modules/simulation.js:181) | DELETE the `calculateChefSatisfactionScore` call. |
| [simulation.js:195](games/bakery-bash/backend/functions/modules/simulation.js:195) | REPLACE `calculateEffectiveOutput(supplyCapped, chefSatisfactionScore)` with `supplyCapped × equipmentFactorCapacity(player.equipmentGrade)`. |
| [simulation.js:203](games/bakery-bash/backend/functions/modules/simulation.js:203) | After `fillRateToSatisfactionPct(fillRate)`, multiply by `cleanlinessFactor(cleanlinessGrade) × equipmentFactorSatisfaction(equipmentGrade)`, clamp [0, 100]. |
| [simulation.js:216](games/bakery-bash/backend/functions/modules/simulation.js:216) | DROP `chefSatisfactionScore` from return; ADD `equipmentGrade`, `cleanlinessGrade`, `cleanlinessScoreNext`. |
| [simulation.js:482-510](games/bakery-bash/backend/functions/modules/simulation.js:482) (cost accounting) | If `decision.equipmentUpgradePurchased`, add tier cost to `totalSpent` and bump `player.equipmentGrade` for the round result. |
| [simulation.js:548-567](games/bakery-bash/backend/functions/modules/simulation.js:548) | DELETE the entire burglary block. |
| New point — after revenue calc, before pushing result | Compute `cleanlinessScoreNext = clamp(0,100, currentScore + maintenance_staff_count*20 - customers*0.20)`; derive next grade. Include in result so `index.js` writes it back to player state for next round. |

### 4.2 Removals (file-level)

| File | What to remove |
|---|---|
| [game.ts:178-200](games/bakery-bash/app/src/types/game.ts:178) | `MaintenanceTask` enum, `MaintenanceBars` interface |
| [game.ts:346](games/bakery-bash/app/src/types/game.ts:346) | `maintenanceTasks` from `PendingDecisionDraft` |
| [game.ts:418,665,670](games/bakery-bash/app/src/types/game.ts:418) | `chefSatisfactionScore`, `chefSatisfactionScores`, `chefDepartures`, `maintenanceBars` from GameState/RoundResult |
| [chef-system.js:240-260](games/bakery-bash/backend/functions/modules/chef-system.js:240) | `calculateChefSatisfactionScore`, `calculateEffectiveOutput` (remove from exports too) |
| [config.js](games/bakery-bash/backend/functions/modules/config.js) (~line 465-487) | `chefSatisfactionThreshold/Decay/Floor`, `curveballs.burglaryThreshold/Chance/Amount` |
| [simulation.js:548-567](games/bakery-bash/backend/functions/modules/simulation.js:548) | Burglary block + `burglary`, `burglaryAmount` from result push |
| [multi-day-simulation.js:279-285](games/bakery-bash/backend/functions/modules/multi-day-simulation.js:279) | Burglary mirror block |
| [csv-export.js:83,107-108](games/bakery-bash/backend/functions/modules/csv-export.js:83) | `chef_satisfaction_score`, `avg_cleanliness_pct`, `avg_machine_health_pct` columns + their writes (lines 265, 302-303) |

### 4.3 Additions

**Config additions** in `config.js` (alongside `DEFAULT_GAME_CONFIG` and module exports):

```js
// Equipment ladder
const EQUIPMENT_GRADES = ['F', 'E', 'D', 'C', 'B', 'A'];

const EQUIPMENT_TIER_COSTS = {
  // cost to upgrade FROM the listed grade (i.e., 'F' = cost to go F→E)
  F: 400, E: 600, D: 800, C: 1000, B: 1200, A: 0, // A is max, no further upgrade
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

// Cleanliness grade bands [min, max) on the 0-100 internal score.
// Order matches EQUIPMENT_GRADES (F at the bottom, A at top).
const CLEANLINESS_BANDS = [
  { grade: 'F', min:  0, max: 17  },
  { grade: 'E', min: 17, max: 34  },
  { grade: 'D', min: 34, max: 51  },
  { grade: 'C', min: 51, max: 68  },
  { grade: 'B', min: 68, max: 85  },
  { grade: 'A', min: 85, max: 101 },  // 100 falls in A
];

// Drift: per-round Δ on the 0-100 cleanliness score.
const CLEANLINESS_STAFF_BOOST_PER_HEAD = 20;   // each maintenance staffer adds +20 to score
const CLEANLINESS_DRAIN_PER_CUSTOMER   = 0.20; // each customer subtracts 0.20

// Maintenance staff cost per round
const MAINTENANCE_STAFF_COST = 20;

// Defaults applied to new players
const DEFAULT_EQUIPMENT_GRADE = 'C';
const DEFAULT_CLEANLINESS_SCORE = 75;     // mid-B
const DEFAULT_MAINTENANCE_STAFF_COUNT = 2; // the comfort line at typical traffic
```

All seven of those plus `EQUIPMENT_GRADES` and `CLEANLINESS_BANDS` get added to `module.exports`.

**Pure helpers** — new file `backend/functions/modules/equipment-cleanliness.js`:

```js
function equipmentFactorCapacity(grade) { ... }       // table lookup with fallback to 1.00
function equipmentFactorSatisfaction(grade) { ... }   // ditto
function cleanlinessFactor(grade) { ... }             // ditto
function gradeFromScore(score) { ... }                // walks CLEANLINESS_BANDS
function cleanlinessDriftDelta(staff, customers) { ... } // pure math
function nextEquipmentGrade(grade) { ... }            // returns the next-up grade or null at A
function tierUpgradeCost(currentGrade) { ... }        // returns cost from F/E/D/C/B; returns null for A (no upgrade available)
```

**Type additions** in `game.ts`:

```typescript
export type EquipmentGrade = 'F' | 'E' | 'D' | 'C' | 'B' | 'A';

// Add to GameState:
//   equipmentGrade: EquipmentGrade;
//   cleanlinessScore: number;     // 0-100 internal
//   cleanlinessGrade: EquipmentGrade;  // derived; cached for UI

// Add to PendingDecisionDraft:
//   equipmentUpgradePurchased: boolean;
// (Maintenance staff count REUSES existing decision.staffCounts.maintenanceGuys —
//  no new field. The DecidePhase UI just gets a new control that writes into it.)
```

**Decision validation** in `decision-validation.js`: extend the validator to allow `equipmentUpgradePurchased` (boolean, default false) and `staffCounts.maintenanceGuys` (non-negative int, default 2). Validation is light — server enforces "can only afford if budget allows" at simulation time.

**Maintenance staff source of truth**: throughout this spec, `maintenance_staff_count` refers to `decision.staffCounts.maintenanceGuys` ([csv-export.js:307](games/bakery-bash/backend/functions/modules/csv-export.js:307)). Existing field, new UI control, new CSV column header — but no new data path.

**Player-state initialization**: when a new player joins a game (in `index.js`'s join handler — wherever player state is seeded), initialize:
```js
equipmentGrade: DEFAULT_EQUIPMENT_GRADE,
cleanlinessScore: DEFAULT_CLEANLINESS_SCORE,
cleanlinessGrade: 'B',
```

---

## 5. Equipment Ladder

**Costs** (one-tier-per-round):

| Upgrade | Cost |
|---|---|
| F → E | $400 |
| E → D | $600 |
| D → C | $800 |
| C → B | $1,000 |
| B → A | $1,200 |
| **F→A total** | **$5,000** |

**Multipliers**:

| Grade | Capacity factor | Satisfaction factor |
|---|---|---|
| F | 0.90 | 0.95 |
| E | 0.94 | 0.97 |
| D | 0.97 | 0.99 |
| C | 1.00 | 1.00 |
| B | 1.03 | 1.02 |
| A | 1.07 | 1.05 |

C is the default starting grade. Each grade above C gives +3% capacity and +1–2% satisfaction; below C is symmetric.

**Decide-phase decision**: a single boolean `equipmentUpgradePurchased`. If true and the player has cash to cover the next-tier cost, simulation deducts the cost and bumps the grade by one tier. If they can't afford or are already at A, the flag is silently ignored.

---

## 6. Cleanliness Drift

**Score** is an internal 0–100 integer; **grade** is derived per `CLEANLINESS_BANDS`.

**Per-round delta** (applied at end of round, after revenue):
```
Δ = (maintenance_staff_count × 20) − (allocated_customers × 0.20)
cleanlinessScoreNext = clamp(0, 100, cleanlinessScore + Δ)
```

`allocated_customers` = `customerCount` from the round's allocation result (the post-competitive-split per-player customer count).

**Behavior at typical 200 customers/round**:

| Maintenance staff | Δ | Effect |
|---|---|---|
| 0 | −40 | Slips ~2 grades |
| 1 | −20 | Slips ~1 grade |
| 2 | 0 | Steady |
| 3 | +20 | Improves ~1 grade |
| 4 | +40 | Improves ~2 grades |

**Cost**: `MAINTENANCE_STAFF_COST = $20/round per staffer`. 2 staff = $40/round (~0.9% of typical revenue).

**Multiplier on satisfaction**:

| Grade | Cleanliness factor |
|---|---|
| F | 0.90 |
| E | 0.94 |
| D | 0.97 |
| C | 1.00 |
| B | 1.03 |
| A | 1.07 |

**Combined revenue swing** (F-everything vs. A-everything across capacity, equipment-sat, cleanliness-sat): `0.90 × 0.95 × 0.90` = 0.770 worst case; `1.07 × 1.05 × 1.07` = 1.202 best case; **swing 1.56×**. Comparable to a winning ad slate or 4-sous-chef investment.

---

## 7. CSV Changes

**Drop columns** ([csv-export.js:83,107,108](games/bakery-bash/backend/functions/modules/csv-export.js:83)):
- `chef_satisfaction_score`
- `avg_cleanliness_pct`
- `avg_machine_health_pct`

**Add columns** (in their place, in the staff/maintenance section):
- `equipment_grade` — string, A-F
- `cleanliness_grade` — string, A-F
- `cleanliness_score` — int 0-100
- `maintenance_staff_count` — int (replaces `maintenance_guy_count` semantically — same data, but rename)
- `equipment_upgrade_purchased` — bool

**Rename**: `maintenance_guy_count` → `maintenance_staff_count` (keeps the data flow at `decision.staffCounts.maintenanceGuys`; just relabel in the column definition).

**Keep unchanged**: all per-product columns, `revenue`, `customer_count`, `aggregate_satisfaction_pct`, specialty chef slots, sous chef counts, ad type. These map cleanly to what students will see.

The professor extras (`player_id`, `bakery_name`, `display_name`) stay as-is.

---

## 8. UI Changes

### 8.1 StatusTab ([app/src/components/game/tabs/StatusTab.tsx](games/bakery-bash/app/src/components/game/tabs/StatusTab.tsx))

Replace the 4 health bars with two grade displays:
- **Equipment Grade** — large letter (A-F) with color (A green → F red), small caption "purchase upgrades during Decide phase"
- **Cleanliness Grade** — large letter (A-F) with the same color scale, small caption "improve by hiring maintenance staff"

Color scale (reuse the `healthColor` palette concept):
- A → sage (var(--sage))
- B → lime (var(--lime))
- C → honey (var(--honey))
- D → honey
- E → berry (var(--berry))
- F → berry

Drop the old `HealthBar` component and the `useGame().maintenanceBars` access.

### 8.2 DecidePhase

Add two controls (location TBD by implementer — likely in the staff/operations section):

1. **Maintenance Staff** — number input or +/- stepper, default 2, bounded 0-10. Writes to `decision.staffCounts.maintenanceGuys` (existing field).
2. **Upgrade Equipment This Round** — checkbox or button labeled `Upgrade to <next-grade> ($X)`, where X is `tierUpgradeCost(currentGrade)`. Disabled if at A grade. Writes to `decision.equipmentUpgradePurchased` (new field).

Both submit through the existing decision pipeline.

---

## 9. Acceptance Criteria

Each must be objectively verifiable before merge:

1. **Equipment factor applied to capacity.** A bakery at A grade produces 1.07× the units of a bakery at C grade with identical other inputs (verifiable by unit test on `computePlayerOutputAndSatisfaction`).
2. **Equipment + cleanliness factors applied to satisfaction.** Per-product `satisfactionPct` is multiplied by both factors and clamped to [0, 100].
3. **Cleanliness drift correct.** At 200 allocated customers and 0/2/4 maintenance staff, `cleanlinessScoreNext - cleanlinessScore` is exactly −40 / 0 / +40 (unit test).
4. **Equipment upgrade flow works.** Setting `equipmentUpgradePurchased=true` deducts the tier cost from `totalSpent` and bumps `equipmentGrade` by one. Insufficient budget → flag ignored, grade unchanged. At A → flag ignored.
5. **Chef satisfaction fully gone.** `grep -rE "chefSatisfaction|chef_satisfaction|calculateEffectiveOutput|calculateChefSatisfactionScore" games/bakery-bash/{app/src,backend/functions}` returns empty.
6. **MaintenanceBars fully gone.** `grep -rE "MaintenanceBars|maintenanceBars|MaintenanceTask|maintenanceTasks" games/bakery-bash/{app/src,backend/functions}` returns empty.
7. **Burglary fully gone.** `grep -rE "burglary|Burglary" games/bakery-bash/{app/src,backend/functions}` returns empty (apart from CHANGELOG/comments).
8. **CSV columns aligned.** New CSV exports contain `equipment_grade`, `cleanliness_grade`, `cleanliness_score`, `maintenance_staff_count`, `equipment_upgrade_purchased`. They do NOT contain `chef_satisfaction_score`, `avg_cleanliness_pct`, `avg_machine_health_pct`, `maintenance_guy_count`.
9. **Existing tests still pass.** `npm test` in `backend/` passes after the rework. New tests added for equipment/cleanliness helpers and drift.
10. **Round-trip game.** A 5-round game can be played end-to-end with the new mechanics; equipment grade changes when upgrades are purchased; cleanliness grade drifts visibly with maintenance staffing.

---

## 10. Out-of-the-Loop Items

Things implementer should know but are not direct work:

- **`p.cleanliness_pct` is dead state.** The simulation reads it but it's never written. Once burglary is removed, the field can be deleted from anywhere it leaks (likely none beyond the burglary block).
- **`avg_cleanliness_pct` and `avg_machine_health_pct` are blank in current CSVs** ([csv-export.js:297](games/bakery-bash/backend/functions/modules/csv-export.js:297) explicitly notes the feature is unimplemented). Removing the columns is a no-op for output content — just relabels the schema.
- **Decision validation is permissive.** [decision-validation.js](games/bakery-bash/backend/functions/modules/decision-validation.js) doesn't currently validate `staffCounts` or `maintenanceGuys` — those flow through unchecked. Adding `maintenanceStaffCount` validation is a small bonus but not strictly required for Friday.

---

## 11. Files Likely To Change

| File | Why |
|---|---|
| `backend/functions/modules/config.js` | Add equipment/cleanliness config. Remove burglary + chef-sat tunables. |
| `backend/functions/modules/equipment-cleanliness.js` (NEW) | Pure helpers (factors, drift, grade lookup). |
| `backend/functions/modules/simulation.js` | Insertion points per §4.1; remove burglary; remove chef-sat call. |
| `backend/functions/modules/multi-day-simulation.js` | Mirror burglary removal. |
| `backend/functions/modules/chef-system.js` | Delete `calculateChefSatisfactionScore`, `calculateEffectiveOutput`. |
| `backend/functions/modules/csv-export.js` | Drop and add columns per §7. |
| `backend/functions/modules/decision-validation.js` | Add `maintenanceStaffCount` and `equipmentUpgradePurchased` validation. |
| `backend/functions/index.js` | Initialize new player-state fields on join; persist `cleanlinessScoreNext` and `equipmentGrade` between rounds. |
| `app/src/types/game.ts` | Add `EquipmentGrade`, equipment/cleanliness fields. Remove `MaintenanceBars`, `MaintenanceTask`, chef-sat fields. |
| `app/src/components/game/tabs/StatusTab.tsx` | Replace bars with grade displays. |
| `app/src/pages/phases/DecidePhase.tsx` (or wherever the operations section lives) | Add maintenance staff input + equipment upgrade control. |
| `app/src/contexts/GameContext.tsx` | Drop `maintenanceBars` from context, add `equipmentGrade`, `cleanlinessGrade`. |
| `app/src/components/game/RoundHeader.tsx` | If it references `maintenanceBars`, replace with grade display or remove. |
| `app/src/pages/phases/ResultsPhase.tsx`, `SimulatePhase.tsx`, `ProfessorLeaderboardPage.tsx` | Audit for `chef_satisfaction_score` / `maintenanceBars` references; fix or delete. |
| `backend/test/*.test.js` | Update affected tests; add coverage for new helpers and drift. |

---

## 12. Estimated Effort

- **Backend wiring** (config, helpers, simulation insertion, removals, validation): ~1 day
- **CSV reshape** + tests: ~0.5 day
- **UI** (StatusTab, DecidePhase controls, context cleanup): ~0.5–1 day
- **Smoke testing** + balance harness check: ~0.5 day

**Total**: 2.5–3 days. Friday is achievable.
