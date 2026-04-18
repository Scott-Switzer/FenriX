/**
 * satisfaction.js — Fill-rate → satisfaction %, aggregate weighting, foot-traffic
 * modifiers, returning-customer bonuses, and the sell-out cap.
 *
 * Pure module (no Firebase dependencies). CommonJS exports only.
 *
 * Tier bands (from build-spec.md):
 *   fillRate < 50%    → critical  (satisfaction 0-20)
 *   50-69%            → poor      (21-45)
 *   70-84%            → adequate  (46-65)
 *   85-99%            → good      (66-85)
 *   >= 100%           → excellent (86-100)
 *
 * Within a band, satisfaction % interpolates linearly with fill rate between
 * minSat and maxSat, using the fill-rate position inside the band.
 */

const {
  PRODUCT_CATALOG,
  SATISFACTION_TIERS,
} = require('./config');

// ---------------------------------------------------------------------------
// 1. calculateFillRate
// ---------------------------------------------------------------------------

/**
 * Fill rate = effectiveOutput / baseDemand.
 * Returns 0 when baseDemand is 0 (avoids div-by-zero).
 * Fill rate is uncapped — going past 1.0 is allowed (surplus production).
 *
 * @param {number} effectiveOutput
 * @param {number} baseDemand
 * @returns {number}
 */
function calculateFillRate(effectiveOutput, baseDemand) {
  if (!Number.isFinite(effectiveOutput) || !baseDemand || baseDemand <= 0) return 0;
  return effectiveOutput / baseDemand;
}

// ---------------------------------------------------------------------------
// 2. fillRateToSatisfactionPct
// ---------------------------------------------------------------------------

/**
 * Map fill rate to a 0-100 satisfaction percentage using SATISFACTION_TIERS.
 *
 * Process:
 *   1. Find the first tier where fillRate < tier.maxFillRate.
 *      The last tier uses Infinity, so it always catches fillRate >= 1.0.
 *   2. Linearly interpolate between that tier's minSat and maxSat using the
 *      fill-rate position inside the tier's fill-rate band
 *      [prevTier.maxFillRate, tier.maxFillRate).
 *   3. For the final tier (excellent, >=100%), any fill rate at or above 1.0
 *      returns maxSat (100) — surplus doesn't keep increasing satisfaction.
 *
 * Examples:
 *   fillRate 0.60 → poor band [0.50, 0.70), position 0.5 → minSat + 0.5×(maxSat-minSat)
 *                 = 21 + 0.5×(45-21) = 33%
 *   fillRate 1.20 → excellent → 100%
 *
 * @param {number} fillRate
 * @returns {number} satisfaction in [0, 100]
 */
function fillRateToSatisfactionPct(fillRate) {
  if (fillRate < 0) fillRate = 0;

  for (let i = 0; i < SATISFACTION_TIERS.length; i++) {
    const tier = SATISFACTION_TIERS[i];
    if (fillRate < tier.maxFillRate) {
      const prevMax = i === 0 ? 0 : SATISFACTION_TIERS[i - 1].maxFillRate;
      const bandSize = tier.maxFillRate - prevMax;
      // For the last tier (Infinity band), position = (fr - prevMax) / Inf = 0,
      // so result = minSat (86 for excellent). This is correct: exactly meeting
      // demand earns the start of excellent, surplus doesn't increase further.
      const position = bandSize > 0 ? (fillRate - prevMax) / bandSize : 0;
      const clampedPos = Math.max(0, Math.min(1, position));
      return tier.minSat + clampedPos * (tier.maxSat - tier.minSat);
    }
  }

  // Unreachable with Infinity as last maxFillRate, but safe fallback.
  const last = SATISFACTION_TIERS[SATISFACTION_TIERS.length - 1];
  return last.maxSat;
}

// ---------------------------------------------------------------------------
// Helper: tier name for a satisfaction %
// ---------------------------------------------------------------------------

/**
 * Return the tier name (critical/poor/adequate/good/excellent) for a
 * given satisfaction percentage.
 */
function tierForSatisfaction(pct) {
  // Walk tiers; each has a minSat/maxSat range.
  for (const t of SATISFACTION_TIERS) {
    if (pct >= t.minSat && pct <= t.maxSat) return t.tier;
  }
  // Out-of-range safety: if somehow above 100, return excellent.
  return pct > 100 ? 'excellent' : 'critical';
}

// ---------------------------------------------------------------------------
// 3. calculatePerProductSatisfaction
// ---------------------------------------------------------------------------

/**
 * For each product in PRODUCT_CATALOG:
 *   - If not on the player's menu → value is null.
 *   - Otherwise → { fillRate, satisfactionPct, tier }.
 *
 * @param {object} playerState
 *   { menu: { [product]: bool }, effectiveOutputs: { [product]: number } }
 * @returns {object} map of product → { fillRate, satisfactionPct, tier } | null
 */
function calculatePerProductSatisfaction(playerState) {
  const menu = (playerState && playerState.menu) || {};
  const outputs = (playerState && playerState.effectiveOutputs) || {};
  const result = {};

  for (const product of Object.keys(PRODUCT_CATALOG)) {
    if (!menu[product]) {
      result[product] = null;
      continue;
    }
    const baseDemand = PRODUCT_CATALOG[product].baseDemand;
    const effective = outputs[product] || 0;
    const fillRate = calculateFillRate(effective, baseDemand);
    const satisfactionPct = fillRateToSatisfactionPct(fillRate);
    result[product] = {
      fillRate,
      satisfactionPct,
      tier: tierForSatisfaction(satisfactionPct),
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// 4. calculateAggregateSatisfaction
// ---------------------------------------------------------------------------

/**
 * Weighted average of per-product satisfaction percentages.
 * Weights come from PRODUCT_CATALOG[product].satisfactionWeight. Products not
 * on the menu (null entries) are excluded.
 *
 *   aggregate = Σ(sat_p × weight_p) / Σ(weight_p)
 *
 * @param {object} perProductSatisfaction  output of calculatePerProductSatisfaction
 * @returns {{ aggregateSatisfactionPct: number, weightedSum: number, totalWeight: number }}
 */
function calculateAggregateSatisfaction(perProductSatisfaction) {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [product, entry] of Object.entries(perProductSatisfaction)) {
    if (!entry) continue; // not offered
    const weight = (PRODUCT_CATALOG[product] && PRODUCT_CATALOG[product].satisfactionWeight) || 0;
    const sat = Number.isFinite(entry.satisfactionPct) ? entry.satisfactionPct : 0;
    weightedSum += sat * weight;
    totalWeight += weight;
  }

  const aggregateSatisfactionPct = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return { aggregateSatisfactionPct, weightedSum, totalWeight };
}

// ---------------------------------------------------------------------------
// 5. getFootTrafficModifier
// ---------------------------------------------------------------------------

/**
 * Compute the total foot-traffic modifier (a decimal; 0.10 = +10%).
 *
 * Components, all summed:
 *   1. Satisfaction modifier (linear from -40% to +40%):
 *        aggregateSatisfaction=0 → -0.40
 *        aggregateSatisfaction=50 → 0.00
 *        aggregateSatisfaction=100 → +0.40
 *      = (aggregate - 50) / 50 × 0.40
 *
 *   2. Premium product bonus: +10% for EACH of croissant/matcha that is on the
 *      menu at Excellent (satisfactionPct ≥ 86). Stackable (max +20%).
 *
 *   3. Product variety bonus:
 *        4 products = +5%, 5 = +10%, 6 = +15%  (fewer than 4 = 0)
 *
 *   4. Sous chef bonus (small-team boost; plateaus at 5+):
 *        1 = +5%, 2 = +10%, 3 = +14%, 4 = +17%, 5+ = +17% (no additional)
 *
 * @param {number} aggregateSatisfactionPct
 * @param {object} perProductSatisfaction
 * @param {number} numProductsOffered
 * @param {number} sousChefCount
 * @returns {number} decimal modifier (e.g. 0.35 = +35%)
 */
function getFootTrafficModifier(
  aggregateSatisfactionPct,
  perProductSatisfaction,
  numProductsOffered,
  sousChefCount,
) {
  // 1. Satisfaction modifier (-0.40 .. +0.40)
  const sat = Number.isFinite(aggregateSatisfactionPct) ? aggregateSatisfactionPct : 0;
  const satMod = ((sat - 50) / 50) * 0.40;

  // 2. Premium product bonus (croissant and matcha at Excellent, stackable)
  let premiumBonus = 0;
  for (const product of ['croissant', 'matcha']) {
    const entry = perProductSatisfaction && perProductSatisfaction[product];
    if (entry && entry.satisfactionPct >= 86) {
      premiumBonus += 0.10;
    }
  }

  // 3. Product variety bonus
  let varietyBonus = 0;
  if (numProductsOffered === 4) varietyBonus = 0.05;
  else if (numProductsOffered === 5) varietyBonus = 0.10;
  else if (numProductsOffered >= 6) varietyBonus = 0.15;

  // 4. Sous chef bonus (plateaus at 5+)
  const sousChefTable = { 0: 0, 1: 0.05, 2: 0.10, 3: 0.14, 4: 0.17 };
  const sousChefBonus = sousChefCount >= 5 ? 0.17 : (sousChefTable[sousChefCount] || 0);

  return satMod + premiumBonus + varietyBonus + sousChefBonus;
}

// ---------------------------------------------------------------------------
// 6. getReturningCustomerBonus
// ---------------------------------------------------------------------------

/**
 * Returning customer count for next round, based on aggregate satisfaction.
 *   Excellent (86-100): +15% of priorRoundCustomerCount
 *   Good (66-85):       +8%
 *   Adequate or below:  0 (resets)
 *
 * @param {number} aggregateSatisfactionPct
 * @param {number} priorRoundCustomerCount
 * @param {object} config  merged game config (uses returningCustomerBonuses)
 * @returns {number} number of returning customers (not rounded — caller rounds if needed)
 */
function getReturningCustomerBonus(aggregateSatisfactionPct, priorRoundCustomerCount, config) {
  const bonuses = (config && config.returningCustomerBonuses) || { excellent: 0.15, good: 0.08 };
  const { excellent, good } = bonuses;
  const count = Math.max(0, Number(priorRoundCustomerCount) || 0);
  if (aggregateSatisfactionPct >= 86) return count * excellent;
  if (aggregateSatisfactionPct >= 66) return count * good;
  return 0;
}

// ---------------------------------------------------------------------------
// 7. applySellOut
// ---------------------------------------------------------------------------

/**
 * Sell-out cap: when demand met or exceeded supply (qtySold >= suppliesStocked
 * AND suppliesStocked > 0), satisfaction for that product is capped at the
 * Poor ceiling of 45%. The tier is recomputed to match the capped value.
 *
 * Returns an updated clone of perProductSatisfaction plus a flags object:
 *   selloutFlags: { [product]: boolean }
 *
 * @param {object} perProductSatisfaction  from calculatePerProductSatisfaction
 * @param {object} suppliesStocked         { [product]: number }
 * @param {object} qtySold                 { [product]: number }
 * @returns {{ perProductSatisfaction: object, selloutFlags: object }}
 */
function applySellOut(perProductSatisfaction, suppliesStocked, qtySold) {
  const POOR_CEILING = 45;
  const updated = {};
  const selloutFlags = {};

  for (const [product, entry] of Object.entries(perProductSatisfaction)) {
    if (!entry) {
      updated[product] = null;
      selloutFlags[product] = false;
      continue;
    }

    const stocked = (suppliesStocked && suppliesStocked[product]) || 0;
    const sold = (qtySold && qtySold[product]) || 0;
    const isSellout = stocked > 0 && sold >= stocked;
    selloutFlags[product] = isSellout;

    if (isSellout && entry.satisfactionPct > POOR_CEILING) {
      const capped = POOR_CEILING;
      updated[product] = {
        ...entry,
        satisfactionPct: capped,
        tier: tierForSatisfaction(capped),
      };
    } else {
      updated[product] = { ...entry };
    }
  }

  return { perProductSatisfaction: updated, selloutFlags };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  calculateFillRate,
  fillRateToSatisfactionPct,
  calculatePerProductSatisfaction,
  calculateAggregateSatisfaction,
  getFootTrafficModifier,
  getReturningCustomerBonus,
  applySellOut,
  // Exposed for testing / reuse
  tierForSatisfaction,
};
