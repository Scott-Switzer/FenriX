/**
 * revenue.js
 *
 * Revenue and cost calculations for a single round.
 *
 * Revenue formula (per spec):
 *   revenue = base
 *           + sousChefCoeff   × sousChefCount
 *           + satisfactionCoeff × aggregateSatisfactionPct
 *           + adSpendCoeff    × adSpend
 *           + numProductsCoeff × numProducts
 *           + Σ(qtySold(P) × fixedPrice(P))
 *           + noise
 *
 * Default coefficients (balance-tuned): base=500, sousChef=25, satisfaction=60,
 * adSpend=0 (anti-arbitrage), numProducts=100, noise ∈ [-100, +100].
 *
 * All functions are pure.
 */

const { PRODUCT_CATALOG } = require('./config');
const config = require('./config');

// --- Named constants for revenue formula magic numbers ----------------------
// Kept in sync with DEFAULT_GAME_CONFIG.revenueCoefficients in config.js.
// Production callers always pass the merged cfg; these only fire when a
// caller omits cfg.revenueCoefficients (e.g., legacy callers, REPL, edge
// tests). Drift here would silently re-enable the killed adSpend exploit.

/** Base revenue added every round regardless of decisions. */
const REVENUE_BASE = 500;

/** Revenue gained per sous chef hired. */
const SOUS_CHEF_COEFFICIENT = 25;

/** Revenue multiplier applied to aggregate satisfaction percentage. */
const SATISFACTION_COEFFICIENT = 60;

/** Revenue multiplier applied to ad spend (dollars). Zeroed to kill arbitrage. */
const AD_SPEND_COEFFICIENT = 0;

/** Revenue bonus per distinct product offered. */
const PRODUCT_BONUS = 100;

// --- Safe numeric helper ----------------------------------------------------

/**
 * Extract a finite number from v. Returns 0 for NaN, Infinity, null, undefined.
 * @param {*} v
 * @returns {number}
 */
const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// --- Deterministic seeded PRNG (Mulberry32) ---------------------------------
// Used so that when a noiseSeed is supplied the same round produces the same
// result, which makes simulations replayable and tests deterministic.
function _hashStringToInt(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function _mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded Gaussian (approx. via sum-of-uniforms, a.k.a. Irwin–Hall mean-centered)
 * clamped to [min, max]. If seed is omitted, Math.random is used.
 *
 * @param {number} min
 * @param {number} max
 * @param {string|number} [seed]
 * @returns {number}
 */
function gaussianNoise(min, max, seed) {
  let rng;
  if (seed != null) {
    const s = typeof seed === 'number' ? seed : _hashStringToInt(String(seed));
    rng = _mulberry32(s);
  } else {
    rng = Math.random;
  }
  // Sum of 6 uniforms ≈ Gaussian with mean 3, variance 0.5 → normalize to [-1,1].
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += rng();
  const g = (sum - 3) / 3; // roughly [-1, 1] for typical draws
  const mid = (min + max) / 2;
  const half = (max - min) / 2;
  const raw = mid + g * half;
  return Math.max(min, Math.min(max, raw));
}

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
    const override = perPlayerPrices && Number.isFinite(perPlayerPrices[product])
      ? perPlayerPrices[product]
      : null;
    const price = override != null ? override : catalogPrice;
    const revenue = qty * price;
    breakdown[product] = { qtySold: qty, price, revenue };
    total += revenue;
  }
  return { totalProductRevenue: total, breakdown };
}

/**
 * Compute gross revenue for a player in a given round.
 *
 * Revenue = base
 *         + SOUS_CHEF_COEFFICIENT × sousChefCount
 *         + SATISFACTION_COEFFICIENT × aggregateSatisfactionPct
 *         + AD_SPEND_COEFFICIENT × adSpend
 *         + PRODUCT_BONUS × numProducts
 *         + totalProductRevenue
 *         + noise
 *
 * @param {{
 *   sousChefCount: number,
 *   aggregateSatisfactionPct: number,
 *   adSpend: number,
 *   numProducts: number,
 *   totalProductRevenue: number,
 *   noiseSeed?: string
 * }} inputs
 * @param {Object} cfg - uses cfg.revenueCoefficients { base, sousChefCoeff,
 *   satisfactionCoeff, adSpendCoeff, numProductsCoeff, noiseMin, noiseMax }.
 * @returns {number} gross revenue (before loan shark deduction).
 */
function computeGrossRevenue(inputs, cfg = config) {
  inputs = inputs || {};
  const c = (cfg && cfg.revenueCoefficients) || {};
  const base = c.base != null ? c.base : REVENUE_BASE;
  const sousChefCoeff = c.sousChefCoeff != null ? c.sousChefCoeff : SOUS_CHEF_COEFFICIENT;
  const satCoeff = c.satisfactionCoeff != null ? c.satisfactionCoeff : SATISFACTION_COEFFICIENT;
  const adCoeff = c.adSpendCoeff != null ? c.adSpendCoeff : AD_SPEND_COEFFICIENT;
  const npCoeff = c.numProductsCoeff != null ? c.numProductsCoeff : PRODUCT_BONUS;
  const noiseMin = c.noiseMin != null ? c.noiseMin : -100;
  const noiseMax = c.noiseMax != null ? c.noiseMax : 100;

  const noise = gaussianNoise(noiseMin, noiseMax, inputs.noiseSeed);

  const revenue =
    base +
    sousChefCoeff * _num(inputs.sousChefCount) +
    satCoeff * _num(inputs.aggregateSatisfactionPct) +
    adCoeff * _num(inputs.adSpend) +
    npCoeff * _num(inputs.numProducts) +
    _num(inputs.totalProductRevenue) +
    noise;

  return revenue;
}

/**
 * Escalating sous chef hire cost.
 *
 * Per spec: 1st=1.0×, 2nd=1.5×, 3rd=2.25×, 4th=3.0×, 5th+=+0.75× per
 * additional (all × sousChefBaseCost).
 *
 * Inlined here (rather than importing chef-system) to avoid a cyclic
 * dependency between revenue.js and chef-system.js.
 *
 * @param {number} count - number of sous chefs hired.
 * @param {number} baseCost - cost per "unit multiplier" (default 10 — see
 *   DEFAULT_GAME_CONFIG.sousChefBaseCost). Test callers may pass any
 *   positive number to exercise the formula at a different scale.
 * @returns {number} total hire cost.
 */
function _sousChefHireCost(count, baseCost) {
  const b = baseCost != null ? baseCost : 10;
  const multipliers = [1.0, 1.5, 2.25, 3.0]; // 1st..4th
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (i < multipliers.length) {
      total += multipliers[i] * b;
    } else {
      // 5th chef = 3.0 + 0.75 = 3.75×, 6th = 4.5×, ...
      const m = 3.0 + 0.75 * (i - 3);
      total += m * b;
    }
  }
  return total;
}

/**
 * Calculate total round costs for a player.
 *
 * @param {{
 *   perProductQtyStocked: Object<string, number>,
 *   sousChefCount: number
 * }} decision
 * @param {{
 *   adAuctionWinningBid?: number,
 *   chefAuctionWinningBid?: number
 * }} auctionResults
 * @param {Object} cfg - uses cfg.unitCostPerProduct { product: cost } and
 *   cfg.sousChefBaseCost (default 10 — see DEFAULT_GAME_CONFIG).
 * @returns {{
 *   stockCost: number,
 *   sousChefHireCost: number,
 *   adBidCost: number,
 *   chefBidCost: number,
 *   totalSpent: number
 * }}
 */
function calculateRoundCosts(decision, auctionResults, cfg = config) {
  const stocked = (decision && decision.perProductQtyStocked) || {};
  const rawUnitCost = cfg && cfg.unitCostPerProduct;
  // unitCostPerProduct can be a flat number (e.g., 1) or per-product object
  const isFlat = typeof rawUnitCost === 'number';
  let stockCost = 0;
  for (const product of Object.keys(stocked)) {
    // Clamp negative or non-finite quantities to 0. Production validators
    // already reject those, but defense-in-depth here keeps stockCost
    // non-negative even if a malformed payload slips through (fuzz/edge
    // case 7.5: NaN/undefined/negative quantities used to produce negative
    // totalSpent which then propagated into budgetAfter and confused
    // downstream consumers).
    const qty = Math.max(0, _num(stocked[product]));
    const cost = isFlat ? rawUnitCost : _num((rawUnitCost && rawUnitCost[product]));
    stockCost += qty * Math.max(0, cost);
  }

  // Same defense for sousChefCount.
  const rawSous = (decision && decision.sousChefCount) || 0;
  const sousCount = Math.max(0, _num(rawSous));
  const sousChefHireCost = _sousChefHireCost(
    sousCount,
    cfg && cfg.sousChefBaseCost
  );

  const adBidCost = Math.max(0, _num((auctionResults && auctionResults.adAuctionWinningBid) || 0));
  const chefBidCost = Math.max(0, _num((auctionResults && auctionResults.chefAuctionWinningBid) || 0));

  const totalSpent = stockCost + sousChefHireCost + adBidCost + chefBidCost;

  return { stockCost, sousChefHireCost, adBidCost, chefBidCost, totalSpent };
}

module.exports = {
  gaussianNoise,
  calculateProductRevenue,
  computeGrossRevenue,
  calculateRoundCosts,
  // Exported for testing; also re-usable if chef-system wants a shared impl.
  _sousChefHireCost,
};
