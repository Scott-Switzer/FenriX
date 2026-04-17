/**
 * config.js — Central configuration and constants for the bakery game.
 *
 * Pure module (no Firebase dependencies). All values come from build-spec.md.
 * CommonJS exports only.
 */

// ---------------------------------------------------------------------------
// Product catalog
// ---------------------------------------------------------------------------

/**
 * PRODUCT_CATALOG
 * Keyed by product string. Each entry has:
 *   - fixedPrice:         sale price per unit (USD)
 *   - baseDemand:         baseline daily demand (units)
 *   - satisfactionWeight: weighting in the aggregate satisfaction calculation
 *   - isBaseMenu:         true if product is offered by default (base menu)
 */
const PRODUCT_CATALOG = {
  coffee:    { fixedPrice: 4.00, baseDemand: 70, satisfactionWeight: 1.5, isBaseMenu: false },
  croissant: { fixedPrice: 4.75, baseDemand: 60, satisfactionWeight: 1.2, isBaseMenu: true  },
  bagel:     { fixedPrice: 3.00, baseDemand: 55, satisfactionWeight: 1.0, isBaseMenu: true  },
  cookie:    { fixedPrice: 2.50, baseDemand: 50, satisfactionWeight: 1.0, isBaseMenu: true  },
  sandwich:  { fixedPrice: 8.75, baseDemand: 45, satisfactionWeight: 1.0, isBaseMenu: false },
  matcha:    { fixedPrice: 6.25, baseDemand: 25, satisfactionWeight: 1.3, isBaseMenu: false },
};

const PRODUCT_KEYS   = ['coffee', 'croissant', 'bagel', 'cookie', 'sandwich', 'matcha'];
const BASE_MENU      = ['croissant', 'cookie', 'bagel'];
const OPTIONAL_MENU  = ['sandwich', 'coffee', 'matcha'];

// ---------------------------------------------------------------------------
// Advertising
// ---------------------------------------------------------------------------

const AD_TYPES = ['TV', 'Billboard', 'Radio', 'Newspaper'];

// ---------------------------------------------------------------------------
// Chef nationalities, specialties, and name pools
// ---------------------------------------------------------------------------

/**
 * CHEF_NATIONALITIES
 * For each nationality:
 *   - specialties: product keys the chef has a specialty multiplier on (hidden from the player)
 *   - names:       male/female name pools used to generate chef display names
 */
const CHEF_NATIONALITIES = {
  french: {
    specialties: ['croissant', 'coffee'],
    names: {
      male:   ['Jean-Pierre', 'Marcel'],
      female: ['Colette', 'Amélie'],
    },
  },
  japanese: {
    specialties: ['matcha', 'croissant'],
    names: {
      male:   ['Hiroshi', 'Kenji'],
      female: ['Yuki', 'Aiko'],
    },
  },
  italian: {
    specialties: ['sandwich', 'coffee'],
    names: {
      male:   ['Marco', 'Luca'],
      female: ['Sofia', 'Giulia'],
    },
  },
  american: {
    specialties: ['bagel', 'cookie'],
    names: {
      male:   ['Jake', 'Tyler'],
      female: ['Madison', 'Ashley'],
    },
  },
};

// ---------------------------------------------------------------------------
// Chef output multipliers (applied to the 30 units/day base rate)
// ---------------------------------------------------------------------------

/**
 * CHEF_MULTIPLIERS
 * Look up by skill tier. `specialty` applies when the chef is producing a product
 * in their nationality's specialty list; otherwise `nonSpecialty` applies.
 */
const CHEF_MULTIPLIERS = {
  novel:        { nonSpecialty: 1.0,  specialty: 1.4 },
  intermediate: { nonSpecialty: 1.25, specialty: 1.75 },
  advanced:     { nonSpecialty: 1.6,  specialty: 2.2 },
};

// ---------------------------------------------------------------------------
// Chef spawn rates per round (probabilities must sum to 1.0)
// ---------------------------------------------------------------------------

/**
 * CHEF_SPAWN_RATES
 * Array index = round - 1. Each entry gives the probability of a generated chef
 * being at each skill tier for that round.
 */
const CHEF_SPAWN_RATES = [
  { novel: 0.65, intermediate: 0.30, advanced: 0.05 }, // R1
  { novel: 0.55, intermediate: 0.35, advanced: 0.10 }, // R2
  { novel: 0.40, intermediate: 0.40, advanced: 0.20 }, // R3
  { novel: 0.20, intermediate: 0.45, advanced: 0.35 }, // R4
  { novel: 0.05, intermediate: 0.45, advanced: 0.50 }, // R5
];

// ---------------------------------------------------------------------------
// Satisfaction tier table (fill rate → satisfaction %)
// ---------------------------------------------------------------------------

/**
 * SATISFACTION_TIERS
 * Ordered ascending by maxFillRate. For a given fill rate, pick the first tier
 * where fillRate < maxFillRate (the last tier uses Infinity for >=100%).
 * Within a tier, linearly interpolate between minSat and maxSat using the
 * fill-rate position inside the tier's fill-rate band.
 */
const SATISFACTION_TIERS = [
  { maxFillRate: 0.50,     tier: 'critical',  minSat: 0,  maxSat: 20  },
  { maxFillRate: 0.70,     tier: 'poor',      minSat: 21, maxSat: 45  },
  { maxFillRate: 0.85,     tier: 'adequate',  minSat: 46, maxSat: 65  },
  { maxFillRate: 1.00,     tier: 'good',      minSat: 66, maxSat: 85  },
  { maxFillRate: Infinity, tier: 'excellent', minSat: 86, maxSat: 100 },
];

// ---------------------------------------------------------------------------
// Default game configuration (all tunable parameters)
// ---------------------------------------------------------------------------

const DEFAULT_GAME_CONFIG = {
  startingBudget: 500000,
  sousChefBaseCost: 50,
  unitCostPerProduct: 1,

  revenueCoefficients: {
    base: 500,
    sousChefCoeff: 12,
    satisfactionCoeff: 8.0,
    adSpendCoeff: 0.8,
    numProductsCoeff: 50,
    noiseMin: -100,
    noiseMax: 100,
  },

  adBonuses: {
    TV: 50000,
    Billboard: 37500,
    Radio: 25000,
    Newspaper: 18750,
  },

  phaseDurations: {
    email: 30,
    decide: 300,
    bid_ad: 60,
    bid_chef: 60,
    roster: 60,
    simulating: 30,
    results: 60,
  },

  totalRounds: 5,
  specialtyChefCap: 3,
  chefPoolSize: { min: 6, max: 8 },

  // Kitchen cohesion: chefSatisfaction = max(floor, 100 - max(0, n - threshold) × decay)
  chefSatisfactionThreshold: 4,
  chefSatisfactionDecay: 16,
  chefSatisfactionFloor: 35,

  loanSharkInterestRate: 0.10,

  returningCustomerBonuses: {
    excellent: 0.15,
    good: 0.08,
  },
};

// ---------------------------------------------------------------------------
// Helpers — defensive value coercion
// ---------------------------------------------------------------------------

/**
 * numberOrDefault
 * Returns `value` if it is a finite number; otherwise returns `fallback`.
 * Accepts numeric strings by parsing with Number().
 *
 * @param {*} value     candidate value
 * @param {number} fallback default to use when value is invalid
 * @returns {number}
 */
function numberOrDefault(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * objectOrDefault
 * Returns `value` if it is a plain (non-null, non-array) object; else `fallback`.
 *
 * @param {*} value
 * @param {object} fallback
 * @returns {object}
 */
function objectOrDefault(value, fallback) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return fallback;
}

/**
 * cleanString
 * Returns value trimmed if it's a string; otherwise an empty string.
 *
 * @param {*} value
 * @returns {string}
 */
function cleanString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

// ---------------------------------------------------------------------------
// mergeConfig — deep merge user config over defaults with numeric safety
// ---------------------------------------------------------------------------

/**
 * mergeConfig
 * Deep-merges `rawConfig` over DEFAULT_GAME_CONFIG. Every numeric field is
 * validated with numberOrDefault so a malformed input can never replace a valid
 * default with NaN/undefined. Nested objects (revenueCoefficients, adBonuses,
 * phaseDurations, chefPoolSize, returningCustomerBonuses) are merged key-by-key.
 *
 * @param {object} rawConfig possibly untrusted partial config
 * @returns {object} fully-populated config safe to consume downstream
 */
function mergeConfig(rawConfig) {
  const raw = objectOrDefault(rawConfig, {});
  const d   = DEFAULT_GAME_CONFIG;

  const rawRevenue    = objectOrDefault(raw.revenueCoefficients,      {});
  const rawAds        = objectOrDefault(raw.adBonuses,                {});
  const rawPhases     = objectOrDefault(raw.phaseDurations,           {});
  const rawPoolSize   = objectOrDefault(raw.chefPoolSize,             {});
  const rawReturning  = objectOrDefault(raw.returningCustomerBonuses, {});

  return {
    startingBudget:     numberOrDefault(raw.startingBudget,     d.startingBudget),
    sousChefBaseCost:   numberOrDefault(raw.sousChefBaseCost,   d.sousChefBaseCost),
    unitCostPerProduct: numberOrDefault(raw.unitCostPerProduct, d.unitCostPerProduct),

    revenueCoefficients: {
      base:              numberOrDefault(rawRevenue.base,              d.revenueCoefficients.base),
      sousChefCoeff:     numberOrDefault(rawRevenue.sousChefCoeff,     d.revenueCoefficients.sousChefCoeff),
      satisfactionCoeff: numberOrDefault(rawRevenue.satisfactionCoeff, d.revenueCoefficients.satisfactionCoeff),
      adSpendCoeff:      numberOrDefault(rawRevenue.adSpendCoeff,      d.revenueCoefficients.adSpendCoeff),
      numProductsCoeff:  numberOrDefault(rawRevenue.numProductsCoeff,  d.revenueCoefficients.numProductsCoeff),
      noiseMin:          numberOrDefault(rawRevenue.noiseMin,          d.revenueCoefficients.noiseMin),
      noiseMax:          numberOrDefault(rawRevenue.noiseMax,          d.revenueCoefficients.noiseMax),
    },

    adBonuses: {
      TV:        numberOrDefault(rawAds.TV,        d.adBonuses.TV),
      Billboard: numberOrDefault(rawAds.Billboard, d.adBonuses.Billboard),
      Radio:     numberOrDefault(rawAds.Radio,     d.adBonuses.Radio),
      Newspaper: numberOrDefault(rawAds.Newspaper, d.adBonuses.Newspaper),
    },

    phaseDurations: {
      email:      numberOrDefault(rawPhases.email,      d.phaseDurations.email),
      decide:     numberOrDefault(rawPhases.decide,     d.phaseDurations.decide),
      bid_ad:     numberOrDefault(rawPhases.bid_ad,     d.phaseDurations.bid_ad),
      bid_chef:   numberOrDefault(rawPhases.bid_chef,   d.phaseDurations.bid_chef),
      roster:     numberOrDefault(rawPhases.roster,     d.phaseDurations.roster),
      simulating: numberOrDefault(rawPhases.simulating, d.phaseDurations.simulating),
      results:    numberOrDefault(rawPhases.results,    d.phaseDurations.results),
    },

    totalRounds:      numberOrDefault(raw.totalRounds,      d.totalRounds),
    specialtyChefCap: numberOrDefault(raw.specialtyChefCap, d.specialtyChefCap),

    chefPoolSize: {
      min: numberOrDefault(rawPoolSize.min, d.chefPoolSize.min),
      max: numberOrDefault(rawPoolSize.max, d.chefPoolSize.max),
    },

    chefSatisfactionThreshold: numberOrDefault(raw.chefSatisfactionThreshold, d.chefSatisfactionThreshold),
    chefSatisfactionDecay:     numberOrDefault(raw.chefSatisfactionDecay,     d.chefSatisfactionDecay),
    chefSatisfactionFloor:     numberOrDefault(raw.chefSatisfactionFloor,     d.chefSatisfactionFloor),

    loanSharkInterestRate: numberOrDefault(raw.loanSharkInterestRate, d.loanSharkInterestRate),

    returningCustomerBonuses: {
      excellent: numberOrDefault(rawReturning.excellent, d.returningCustomerBonuses.excellent),
      good:      numberOrDefault(rawReturning.good,      d.returningCustomerBonuses.good),
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  PRODUCT_CATALOG,
  PRODUCT_KEYS,
  BASE_MENU,
  OPTIONAL_MENU,
  AD_TYPES,
  CHEF_NATIONALITIES,
  CHEF_MULTIPLIERS,
  CHEF_SPAWN_RATES,
  SATISFACTION_TIERS,
  DEFAULT_GAME_CONFIG,
  mergeConfig,
  numberOrDefault,
  objectOrDefault,
  cleanString,
};
