# POST-01 — Per-Product Dynamic Pricing Design

**Date:** 2026-04-21
**Roadmap item:** POST-01 (biggest strategic-value post-MVP feature per `games/bakery-bash/projectRoadmap.md`)
**Status:** Design approved; ready for implementation plan

---

## Goal

Ship per-product dynamic pricing controlled by the Finance role, so pricing becomes a strategic lever in Bakery Bash and a first-class regressor in the CSV that students export for MGSC 220 / 310 modeling homework.

## Scope

**In scope:**
- Player-controlled prices, one per product, submitted each round by the Finance role
- Zone classification per product (Floor / Competitive / Premium) derived from the proposal's Price Points table
- Continuous point-elasticity demand effect scaled by per-product elasticity tier (High / Medium / Low)
- Discrete Floor-zone demand bonus (+15%)
- Price as a weight in the existing competitive-allocation formula — pool stays fixed, price shifts relative shares
- Server- and client-side clamping to `[floor, ceiling]` with $0.25 granularity
- Six new `price_<product>` columns in the regression CSV
- Carry-over defaults: round 1 = catalog `basePrice`; rounds 2–5 = last round's submitted price

**Out of scope (explicitly):**
- Above-ceiling satisfaction penalty — the proposal's post-MVP rule is dropped in favor of hard clamping at ceiling. Simpler, and continuous elasticity already punishes premium pricing via demand volume.
- Customer archetypes with per-product price sensitivity — tracked as POST-02
- Price effects on `satisfactionScore` directly — satisfaction stays operational-quality only (fill rate × chef quality × cleanliness). Price is a separate allocation weight.
- Above-ceiling inputs — UI and server reject any price above the product's ceiling

## Locked Design Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Feature scope | Full POST-01 minus above-ceiling penalty (clamped instead) |
| 2 | Role owner | Finance |
| 3 | UI surface | Inline price field per product row on the Decide screen, role-gated |
| 4 | Demand formula | Continuous point-elasticity: `1 + floorBonus − e × %ΔP_vs_competitiveMid`, `e ∈ {1.5, 1.0, 0.6}` for High / Medium / Low |
| 5 | Ceiling handling | Hard clamp on both client and server; no above-ceiling penalty mechanic |
| 6 | Demand integration | Price is a weight in competitive allocation: `share ∝ satisfaction × priceDemandMultiplier`. Pool conserved. |
| 7 | Granularity + defaults | $0.25 steps; Round 1 default = catalog `basePrice`; Rounds 2–5 default = last round's submitted price |
| 8 | CSV output | 6 new columns (`price_<product>`) between qty and outcome columns; no multiplier or zone columns |

---

## Architecture

### Per-Round Data Flow

1. **Decide phase opens.** Decide screen renders per-product rows with `[menu toggle] [qty] [price + zone badge]`. Price inputs enabled only when `player.role === 'finance'`.
2. **Finance edits price.** Client snaps to $0.25, clamps to `[floor, ceiling]`, updates the zone badge live (Floor / Competitive / Premium).
3. **Finance clicks "Submit Prices."** New callable `submitPrices` runs; server re-snaps, re-clamps, writes `productPrices` onto the player's decision doc for the current round. Multiple submits during the same phase are allowed (latest wins).
4. **Professor triggers simulate.** `runSimulation` loads each player's `productPrices`. For any product where Finance didn't submit this round, `resolvePriceForSim` walks back: last round's price, else round 1 fallback = catalog `basePrice`.
5. **Simulation per player × product:**
   - `priceDemandMultiplier = 1 + floorBonus − elasticity × (price − competitiveMid) / competitiveMid`, floored at 0.1
   - Competitive-allocation weight becomes `satisfactionScore × priceDemandMultiplier`
   - Revenue uses the submitted price instead of `PRODUCT_CATALOG.fixedPrice`
6. **CSV export** appends 6 new `price_<product>` columns.

### Module Changes — Backend (`games/bakery-bash/backend/functions/modules/`)

| File | Change |
|---|---|
| `config.js` | Add `PRICE_ZONES` per product (floor, competitiveRangeLow, competitiveRangeHigh, premiumRangeLow, premiumRangeHigh, ceiling, elasticityTier). Add `ELASTICITY_COEFFICIENTS = { high: 1.5, medium: 1.0, low: 0.6 }`. Add `PRICE_STEP = 0.25`, `FLOOR_BONUS = 0.15`, `MULTIPLIER_FLOOR = 0.1`. |
| **NEW** `pricing.js` | Pure functions: `classifyZone(price, productCfg)`, `calculatePriceDemandMultiplier(price, productCfg)`, `snapPriceToStep(price)`, `clampPrice(price, productCfg)`, `resolvePriceForSim(submittedThisRound, priorSubmissions, catalogBase)`. |
| `decision-validation.js` | New `validateProductPrices(obj)` — rejects non-number, NaN, Infinity, zero/negative, unknown keys; snaps, clamps, returns canonical `{ [ProductKey]: number }`. |
| `customer-allocation.js` | Allocation weight multiplies in `priceDemandMultiplier` from `pricing.js`. One-line change in the weight calculation. |
| `revenue.js` | `calculateProductRevenue(qtySold, perPlayerPrices)` uses submitted prices, not `PRODUCT_CATALOG.fixedPrice`. |
| `simulation.js` | Reads `productPrices` from each player's decision doc, resolves carry-over, threads prices into allocation + revenue. |
| `csv-export.js` | Append `price_<product>` columns in the qty-section of the row. |
| `index.js` (Functions entry) | New `submitPrices` callable. Server enforces that the caller's role is `finance` (mirrors existing `submitBids` role gating). Prices live in their own callable rather than piggybacking on `submitDecision` — Operations and Finance are separate people and should not race on the same document write. |

### Module Changes — Frontend (`games/bakery-bash/app/src/`)

| File | Change |
|---|---|
| `types/game.ts` | Add `PriceZone = 'floor' \| 'competitive' \| 'premium'`. Extend `PendingDecisionDraft` with `productPrices: Record<ProductKey, number>`. Extend `MenuItem` with `priceFloor`, `priceCeiling`, `elasticityTier`. |
| Decide page component | Per product row now renders price input + nudge buttons + zone badge. Price input disabled unless `player.role === 'finance'`. |
| New Finance submit button | Sits next to Operations' existing "Submit Decisions" and Advertising's "Submit Ad Bids" buttons. Labeled "Submit Prices" until first submit, then "Update Prices" on subsequent edits within the same phase. |
| New `<PriceInput>` component | Numeric input with $0.25 nudge buttons, blur-time snap, clamp-on-submit toast, live zone badge. |

### Firestore Schema Delta

```
/games/{gameId}/players/{playerId}/decisions/{round}
  ...existing fields...
  productPrices?: { [ProductKey]: number }    # new, optional
```

```
/games/{gameId}/gameConfig
  ...existing fields...
  priceZones?: { ... }                          # optional override of config.js defaults
  elasticityCoefficients?: { high, medium, low } # optional override
```

Both new fields are optional. Missing `productPrices` → carry-over logic applies. Missing game config overrides → sim uses `config.js` constants.

---

## Pricing Math

### Per-Product Zone Configuration

Values come from the proposal's Price Points Per Product table:

| Product | Floor | Competitive Range | Premium Range | Ceiling | Elasticity Tier |
|---|---|---|---|---|---|
| Coffee | $2.00 | $3.00–$4.50 | $5.00–$6.00 | $6.50 | High |
| Croissant | $2.50 | $4.00–$5.50 | $6.00–$7.00 | $8.00 | Medium |
| Bagel | $1.50 | $2.50–$3.50 | $4.00–$5.00 | $5.50 | High |
| Cookie | $1.00 | $2.00–$3.00 | $3.50–$4.50 | $5.00 | High |
| Sandwich | $5.00 | $7.50–$10.00 | $10.50–$12.50 | $14.00 | Medium |
| Matcha | $3.50 | $5.50–$7.00 | $7.50–$9.00 | $10.00 | Low |

### Zone Classification

Three mutually exclusive zones, no gaps, covering `[floor, ceiling]`:

- **Floor:** `floor ≤ price < competitiveRangeLow`
- **Competitive:** `competitiveRangeLow ≤ price < premiumRangeLow`
- **Premium:** `premiumRangeLow ≤ price ≤ ceiling`

### Demand Multiplier Formula

```js
// pricing.js
const ELASTICITY_COEFFICIENTS = { high: 1.5, medium: 1.0, low: 0.6 };
const FLOOR_BONUS = 0.15;
const MULTIPLIER_FLOOR = 0.1;

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

### Worked Examples — Coffee (competitiveMid = $3.75, e = 1.5)

| Price | Zone | Floor bonus | Elasticity effect | Multiplier |
|---|---|---|---|---|
| $2.00 | floor | +0.15 | +0.70 | **1.85** |
| $2.75 | floor | +0.15 | +0.40 | **1.55** |
| $3.00 | competitive | 0 | +0.30 | **1.30** |
| $3.75 | competitive | 0 | 0 | **1.00** |
| $4.50 | competitive | 0 | −0.30 | **0.70** |
| $5.00 | premium | 0 | −0.50 | **0.50** |
| $6.50 | premium | 0 | −1.10 | **0.10** (floored) |

### Worked Examples — Matcha (competitiveMid = $6.25, e = 0.6)

| Price | Zone | Floor bonus | Elasticity effect | Multiplier |
|---|---|---|---|---|
| $3.50 | floor | +0.15 | +0.264 | **1.414** |
| $6.25 | competitive | 0 | 0 | **1.00** |
| $10.00 | premium | 0 | −0.36 | **0.64** |

Low-elasticity products (Matcha) retain more demand at premium prices — matches the proposal's "Matcha specialist" archetype.

### Allocation Integration

In `customer-allocation.js`, the existing weight calculation gains one factor:

```js
// before
const weight = satisfactionScore[product] * footTrafficModifier;
// after
const weight = satisfactionScore[product] * footTrafficModifier
             * calculatePriceDemandMultiplier(prices[product], catalogCfg[product]);
```

Pool total is unchanged; the zero-sum allocation now responds to price. A player at floor grabs more of the same pool; a player at ceiling grabs much less.

### Revenue Integration

In `revenue.js`, replace the catalog lookup:

```js
// before
const price = PRODUCT_CATALOG[product].fixedPrice;
// after
const price = perPlayerPrices[product];   // resolved upstream with carry-over
```

### Known Non-Linearity — Floor Step

Because the Floor bonus is discrete and elasticity is continuous, the multiplier jumps at the Floor / Competitive boundary. For Coffee this is a step from 1.55 (at $2.75) down to 1.30 (at $3.00) — a ~16% drop. Intentional: models volume-discount threshold effects. Flag for INT-06 tuning pass alongside DEC-13's revenue coefficients. Students who notice will find the step meaningful; those fitting a smooth regression will still recover the overall elasticity with modest residual noise.

### Multiplier Floor (`0.1`)

Prevents ceiling-priced high-elasticity products from producing a zero or negative demand weight, which would zero out the player's allocation share for that product and make `log(price × customers)`-type regressors undefined. Ten percent of normal demand preserves a meaningful signal while still reading as "you priced yourself out of the market."

---

## UI

### Decide Screen — Per-Product Row

```
┌──────────────────────────────────────────────────────────────────────┐
│ 🥐 Croissant    [✓ On menu]    Qty: [  45 ]                          │
│                                Price: [$ 4.75] [-][+]  [Competitive] │
├──────────────────────────────────────────────────────────────────────┤
│ ☕ Coffee       [✓ On menu]    Qty: [  70 ]                          │
│                                Price: [$ 2.00] [-][+]  [Floor] +15%  │
├──────────────────────────────────────────────────────────────────────┤
│ 🍵 Matcha       [  On menu]    Qty: [   0 ]                          │
│                                Price: [$ 6.25] [-][+]  [Competitive] │
└──────────────────────────────────────────────────────────────────────┘
```

**Input behavior:**
- `[-]` and `[+]` nudge $0.25 per click, clamped to `[floor, ceiling]`
- Typing a value is allowed; snap-to-$0.25 happens on blur
- Values outside `[floor, ceiling]` are visually snapped and the user gets a toast ("Clamped to $X.XX — outside the $F.FF–$C.CC range")
- Disabled for non-Finance roles (read-only display with a lock glyph, per DEC-21 pattern)

**Zone badge colors:**
- **Floor** — green, with `+15%` tooltip
- **Competitive** — grey/neutral
- **Premium** — amber (no explicit warning; the demand drop communicates itself via the CSV)

**Focus hints:** tooltip on focus shows `Floor $2.00  /  Ceiling $6.50` so Finance knows the bounds without guessing.

### Submit Buttons (bottom of Decide screen)

```
[Submit Decisions — Operations]   [Submit Prices — Finance]   [Submit Ad Bids — Advertising]
```

Three role-gated buttons, each enabled only for its role. Mirrors existing Advertising pattern. Finance's button reads "Submit Prices" on first click, then "Update Prices" for subsequent submissions within the same phase.

### Carry-Over UX

- **Round 1:** price fields pre-filled with catalog `basePrice`. Hint line: *"Round 1 prices default to menu baselines. Edit any that you want to change."*
- **Rounds 2–5:** pre-filled with the most recent submitted price per product (walking back through prior rounds). If a product has never been submitted — e.g., Finance skipped rounds 1 and 2 — the field falls back to catalog `basePrice`, same as round 1. Hint varies: *"Showing last round's prices"* if any prior submission exists, else the round-1 hint repeats.
- Finance is not required to submit every round. If they skip, the carry-over value flows through to simulation; the sim logs whether each price was fresh-submitted or carried over for replay debugging.

### Non-Finance View

All roles see every price and zone badge as read-only values. This is intentional — teammates need to see Finance's pricing to coordinate quantities and ad bids.

---

## CSV Output

Six new columns added to the per-round CSV, positioned between the `qty_` block and the outcome columns:

```
roundNumber, playerId, ...,
  menu_<product>, qty_<product>,
  price_coffee, price_croissant, price_bagel, price_cookie, price_sandwich, price_matcha,   ← NEW
  sousChef_<product>, adSpend_<product>,
  customers_<product>, satisfaction_<product>, revenue_<product>, ...
```

- Values are plain numbers with 2 decimals (e.g., `4.75`, `2.00`). No zone or multiplier columns — derivable from the prices themselves, and exposing the multiplier would trivialize the homework.
- Columns exist even for products not on the player's menu this round — they carry the carry-over / default value. This keeps the CSV rectangular for regression tooling.

---

## Validation and Error Handling

| Rule | Behavior |
|---|---|
| Non-object / missing `productPrices` | Optional field; sim falls back to carry-over |
| Unknown product key in payload | Rejected with `invalid-argument` (prevents silent typos) |
| Non-finite / NaN / Infinity / non-number value | Rejected with `invalid-argument` |
| Negative or zero price | Rejected |
| Price not on $0.25 grid | Server snaps to nearest $0.25; client snaps on blur |
| Price outside `[floor, ceiling]` | Server clamps silently; client visually snaps and shows toast |
| Products missing from payload | Treated as "no update this round" → carry-over |

**Runtime error handling:**
- **Finance never submits in a round:** `resolvePriceForSim` walks back to the last submitted price; round 1 fallback = catalog `basePrice`. Info-level log identifies which prices were carry-overs.
- **Multiple submits during same phase:** latest wins; doc is overwritten, not merged.
- **Prof advances before Finance submits:** sim uses carry-over; no hard block (matches DEC-07 — professor-driven advancement, timer is UI-only).
- **Corrupted Firestore price (type mismatch, somehow out of range):** treated as missing → carry-over → catalog base. Sim never crashes on bad data.
- **Client loses connection during submit:** existing `submitDecision` retry pattern applies to `submitPrices` as well.

---

## Testing Strategy

### Backend Unit Tests (`test-suite.js` additions)

1. `classifyZone` — each of the 6 products at floor, competitiveRangeLow, competitiveRangeHigh, premiumRangeLow, premiumRangeHigh, ceiling, plus one interior point per zone
2. `calculatePriceDemandMultiplier` — spot-check each product at floor, competitiveMid, ceiling; verify the floor-bonus step sits exactly at the Floor / Competitive boundary
3. `snapPriceToStep` — $4.00 → $4.00; $4.12 → $4.00; $4.13 → $4.25; $4.37 → $4.25; edge cases: $0.00, negative, very large
4. `clampPrice` — below floor → floor; above ceiling → ceiling; on bounds → unchanged
5. `resolvePriceForSim` — round 1 missing → catalog base; round 3 missing → round 2's price; all rounds missing → catalog base
6. `validateProductPrices` — rejects NaN, Infinity, negative, zero, non-number, unknown keys; snaps + clamps correctly

### Compliance Tests (`test-compliance.js` additions)

1. `PRICE_ZONES` has all 6 products; each has `floor < competitiveRangeLow < competitiveRangeHigh < premiumRangeLow < premiumRangeHigh < ceiling`
2. Each zone value matches the proposal table exactly
3. `ELASTICITY_COEFFICIENTS` has entries for each elasticity tier referenced in `PRICE_ZONES`
4. `PRICE_STEP === 0.25`, `FLOOR_BONUS === 0.15`, `MULTIPLIER_FLOOR === 0.1`

### Simulation Integration Tests (`test-suite.js` + `test-adversarial.js`)

1. Two-player run: player A floors all prices, player B ceilings all prices. Assert A captures >60% of customers and B captures <20% (pool-conserved zero-sum)
2. Total customers allocated per product ≤ `baseDemand × roundModifier` (pool still capped)
3. Revenue per product equals `qtySold × submittedPrice` (not `fixedPrice`)
4. CSV row contains `price_<product>` columns at expected positions with 2-decimal values
5. Round 3 player with no submitted price gets round 2's price in CSV + revenue

### Adversarial Tests (`test-adversarial.js` additions)

1. Submit price = ceiling + $0.01 → server clamps; sim uses ceiling
2. Submit price = floor − $0.01 → server clamps; sim uses floor
3. Submit `price_coffee: "free"` → rejected with `invalid-argument`
4. Submit extra key `productPrices.latte: 5` → rejected (catches MIG-01-style regressions)
5. Submit `productPrices: null` → treated as "no update" (carry-over), not rejected

### Frontend Tests

1. `<PriceInput>` snaps to $0.25 on blur and shows toast when clamped
2. Zone badge reflects current value through Floor → Competitive → Premium
3. Input disabled when `player.role !== 'finance'`; enabled when finance
4. "Submit Prices" button disabled for non-finance; enabled for finance

### Stress Test (`test-stress.js`)

- 20-player run with randomized prices — sim completes within existing P50 latency budget (pricing adds O(products × players) work, negligible vs current allocation cost)

---

## Open Tuning Parameters

These values are placeholders pinned to the proposal's stated intent. They will be retuned after INT-06 (integration testing) alongside DEC-13's revenue coefficients:

- `ELASTICITY_COEFFICIENTS.high` = 1.5
- `ELASTICITY_COEFFICIENTS.medium` = 1.0
- `ELASTICITY_COEFFICIENTS.low` = 0.6
- `FLOOR_BONUS` = 0.15
- `MULTIPLIER_FLOOR` = 0.1

Professor can override any of these per-game via `gameConfig.elasticityCoefficients` and `gameConfig.priceZones`.

---

## Decisions Not In This Spec

These were discussed in brainstorming and recorded in the roadmap's decision log rather than duplicated here:

- DEC-17 (fixed MVP prices) — superseded by POST-01 when players opt in to dynamic pricing
- DEC-21 (team roles) — Finance role inherits price-submit ownership under its scope
- POST-02 (customer archetypes) — scheduled as a separate spec; depends on POST-01 landing cleanly

## Roadmap Cross-References

- `games/bakery-bash/projectRoadmap.md` — POST-01 entry under "Post-MVP Features (Committed per DEC-10)"
- `games/bakery-bash/GAME_DESIGN_PROPOSAL.md` — "Price Points Per Product" table (section 814) and "Post-MVP pricing rules" (section 829)
- DEC-10 (post-MVP commitment), DEC-13 (revenue coefficient tuning), DEC-21 (team role gating)
