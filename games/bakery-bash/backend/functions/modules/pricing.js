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
