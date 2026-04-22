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

/**
 * Catalog base prices — mirror `PRODUCT_CATALOG[*].fixedPrice` on the backend.
 * Used as the Round-1 default for `productPrices`. Rounds 2–5 default to the
 * previous round's submission (carry-over handled server-side too).
 */
export const DEFAULT_PRICES: Record<ProductKey, number> = {
  croissant: 4.75,
  cookie: 2.50,
  bagel: 3.00,
  sandwich: 8.75,
  coffee: 4.00,
  matcha: 6.25,
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
