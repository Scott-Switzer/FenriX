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

module.exports = {
  classifyZone,
  calculatePriceDemandMultiplier,
  snapPriceToStep,
  clampPrice,
  resolvePriceForSim,
};
