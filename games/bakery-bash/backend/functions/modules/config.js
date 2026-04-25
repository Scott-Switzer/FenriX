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
// Balance pass 1 (Apr 2026): demand pool was 305 customers/round across all 6
// products — too small to support any per-customer revenue. Operating costs
// (sous chefs, specialty chef bids) dwarfed product revenue, so every engaged
// strategy lost money in tournament probes. Bumped baseDemand 4–6× so product
// sales become the dominant income source.
//
// Balance pass 2: rebalanced nationality strengths so no nationality is
// structurally dominant.
//
// Balance pass 6: rebalanced premium prices and demand. After pass 5,
// premium-only menus still won 94% because sandwich at $8.75 alone earned
// 3.5× per customer vs cookie at $2.50, and even when premium products
// had lower demand, satisfaction-weighted competitive split favored the
// menu with smaller demand pools (easier to saturate → higher sat).
// New approach: lower premium prices to bring per-customer revenue in
// line with cheap products (premium ≈ 1.6× cheap, not 3.5×); demand
// uniform across all products (sandwich/matcha 200, others 200–240).
// Price-zone updates below match the new fixedPrice so players who don't
// submit a price still pay the catalog default at competitive mid.
//
// Per-product max revenue (baseDemand × fixedPrice):
//   coffee:    240 × $4.00 = $960
//   croissant: 240 × $4.75 = $1,140
//   bagel:     220 × $3.00 = $660
//   cookie:    200 × $2.50 = $500
//   sandwich:  200 × $5.50 = $1,100
//   matcha:    200 × $4.50 = $900
// Range: $500–$1,140, premium tier no longer 2× cheap. Cookie still
// lowest revenue ceiling but compensates via lowest stock cost and
// largest customer share at floor pricing.
// Balance pass 8: satisfactionWeight equalized to 1.0 for all products.
// Previously coffee's weight 1.2 (higher than others) gave any team
// offering coffee a small aggregate-satisfaction boost — and that
// disproportionately benefited French (croissant + coffee) and Italian
// (sandwich + coffee) over Japanese and American. With equal weights,
// aggregate sat just averages across offered products fairly.
//
// Balance pass 9: bumped bagel and cookie demand from 220/200 → 240/240
// so American's specialty pair (bagel + cookie = 480) matches French's
// (croissant + coffee = 480) in raw demand.
//
// Balance pass 10: also bumped bagel/cookie default prices to close the
// per-customer revenue gap. Nationality specialty per-customer revenue:
//   French   (croissant $4.75 + coffee $4.00):   $8.75
//   Japanese (matcha $4.50 + croissant $4.75):   $9.25
//   Italian  (sandwich $5.50 + coffee $4.00):    $9.50
//   American (bagel $3.75 + cookie $3.25):       $7.00
// Range: $7.00–$9.50, ~35% spread. American is still cheapest tier
// (thematic constraint: bagel/cookie are inherently low-priced grab-and-
// go items), but they now sit at higher demand (240 each) which gives
// American competitive customer count to offset the per-customer gap.
// Combined nationality-specialty round revenue ceiling (demand × price):
//   French:   240 × $4.75 + 240 × $4.00 = $1,140 + $960  = $2,100
//   Japanese: 200 × $4.50 + 240 × $4.75 = $900   + $1,140 = $2,040
//   Italian:  200 × $5.50 + 240 × $4.00 = $1,100 + $960   = $2,060
//   American: 240 × $3.75 + 240 × $3.25 = $900   + $780   = $1,680
// Range: $1,680–$2,100, ~25% spread. Acceptable given American's
// cheap-product theme; narrows from the original 60%+ imbalance.
const PRODUCT_CATALOG = {
  coffee:    { fixedPrice: 4.00, baseDemand: 240, satisfactionWeight: 1.0, isBaseMenu: false },
  croissant: { fixedPrice: 4.75, baseDemand: 240, satisfactionWeight: 1.0, isBaseMenu: true  },
  bagel:     { fixedPrice: 4.50, baseDemand: 240, satisfactionWeight: 1.0, isBaseMenu: true  },
  cookie:    { fixedPrice: 4.00, baseDemand: 240, satisfactionWeight: 1.0, isBaseMenu: true  },
  sandwich:  { fixedPrice: 5.50, baseDemand: 200, satisfactionWeight: 1.0, isBaseMenu: false },
  matcha:    { fixedPrice: 4.50, baseDemand: 200, satisfactionWeight: 1.0, isBaseMenu: false },
};

const PRODUCT_KEYS   = ['coffee', 'croissant', 'bagel', 'cookie', 'sandwich', 'matcha'];
const BASE_MENU      = ['croissant', 'cookie', 'bagel'];
const OPTIONAL_MENU  = ['sandwich', 'coffee', 'matcha'];

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
// Balance pass 6: sandwich and matcha price zones rescaled to match their
// new lower fixedPrice. Sandwich was $5–$14 (mid $8.75); now $3–$8.50
// (mid $5.50). Matcha was $3.50–$10 (mid $6.25); now $2.50–$7 (mid
// $4.50). Elasticity tiers also bumped — sandwich and matcha are now
// "high" elasticity, so a player setting them at premium ($7+) sees a
// strong customer share penalty. This makes premium pricing a real
// tradeoff (more $/customer, way fewer customers) rather than free
// money.
const PRICE_ZONES = {
  coffee:    { floor: 2.00, competitiveRangeLow: 3.00, competitiveRangeHigh: 4.50,
               premiumRangeLow: 5.00, premiumRangeHigh: 6.00, ceiling: 6.50,  elasticityTier: 'high'   },
  croissant: { floor: 2.50, competitiveRangeLow: 4.00, competitiveRangeHigh: 5.50,
               premiumRangeLow: 6.00, premiumRangeHigh: 7.00, ceiling: 8.00,  elasticityTier: 'medium' },
  // Balance pass 11: raised bagel default to $4.50 and cookie to $4.00 so
  // American's specialty pair (bagel + cookie = $8.50) approximately
  // matches French's (croissant + coffee = $8.75). Zones updated to keep
  // the new defaults at competitive mid (no elasticity penalty for
  // default-priced players).
  bagel:     { floor: 2.50, competitiveRangeLow: 3.50, competitiveRangeHigh: 5.50,
               premiumRangeLow: 6.00, premiumRangeHigh: 7.00, ceiling: 7.50,  elasticityTier: 'high'   },
  cookie:    { floor: 2.00, competitiveRangeLow: 3.00, competitiveRangeHigh: 5.00,
               premiumRangeLow: 5.50, premiumRangeHigh: 6.50, ceiling: 7.00,  elasticityTier: 'high'   },
  sandwich:  { floor: 3.00, competitiveRangeLow: 4.50, competitiveRangeHigh: 6.50,
               premiumRangeLow: 7.00, premiumRangeHigh: 8.00, ceiling: 8.50, elasticityTier: 'high' },
  matcha:    { floor: 2.50, competitiveRangeLow: 3.50, competitiveRangeHigh: 5.50,
               premiumRangeLow: 6.00, premiumRangeHigh: 6.50, ceiling: 7.00, elasticityTier: 'high' },
};

/** Point-elasticity coefficient by product tier. */
const ELASTICITY_COEFFICIENTS = { high: 1.5, medium: 1.0, low: 0.6 };

/** Grid size for player-submitted prices. */
const PRICE_STEP = 0.25;

/** Discrete demand bump when a product's price is in the Floor zone. */
const FLOOR_BONUS = 0.15;

/**
 * Lower bound on the per-player demand multiplier — keeps allocation share
 * non-zero. Balance pass 13: reduced from 0.10 to 0.05. At 0.10, a player
 * pricing at ceiling on a high-elasticity product still captured ~5% of the
 * pool against competitive opponents, which combined with the high
 * per-customer revenue let "ceiling-everywhere" dominate adversarial
 * search. At 0.05, ceiling pricing's customer share drops sharply enough
 * that the per-customer premium can't compensate.
 */
const MULTIPLIER_FLOOR = 0.05;

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
 *
 * Balance pass 1 (Apr 2026): bumped intermediate and advanced multipliers so
 * the specialty advantage is meaningful in absolute units. Previously an
 * advanced specialty chef produced 30×2.2 = 66 units/day, only 36 above base.
 * Now 30×3.0 = 90 units/day, 60 above base — chef purchases now clearly
 * differentiate themselves from a no-chef team in the customer-allocation
 * stage.
 */
const CHEF_MULTIPLIERS = {
  novel:        { nonSpecialty: 1.0,  specialty: 1.5 },
  intermediate: { nonSpecialty: 1.4,  specialty: 2.2 },
  advanced:     { nonSpecialty: 1.8,  specialty: 3.0 },
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
  // Balance pass 7: dropped from $12,500 → $5k → $2k → $1k → $500.
  // Mirror-match probes showed engaged play still lost $21k/game while
  // non-engaged play (baseline, minimalist) profited $5–17k. Engagement
  // needs to PAY in the equilibrium where everyone engages, otherwise no
  // one engages. At $500 base, 4 sous chefs cost $3,875/round, $19.4k
  // over 5 rounds — small enough that engaged strategies clear $10–30k
  // profit when paired with sat-coefficient bump (satisfactionCoeff 60).
  // Also rescales chef-bid floors: novel $1k, intermediate $1.75k,
  // advanced $2.75k. Chefs are essentially "must-buy" upgrades; the
  // auction tension comes from chef pool scarcity (12 chefs / 3 teams =
  // ~4 chefs per team, hard cap at 3) rather than from price.
  sousChefBaseCost: 500,
  unitCostPerProduct: 1,

  // Balance pass 1: revenue formula was the source of the worst exploit —
  // adSpendCoeff 0.8 meant every $1 bid on ads added $0.80 to gross
  // revenue, so bidding $123k across all 4 ads returned ~$98k via the
  // coefficient PLUS up to $131.25k in winner bonuses, for a guaranteed
  // ~$106k profit per round (the "AdSpam" dominant strategy that won 100%
  // of round-robin tournament games). Setting adSpendCoeff to 0 closes
  // that exploit entirely.
  //
  // Balance pass 7: bumped satisfactionCoeff to 60 so that maintaining
  // good/excellent satisfaction is the dominant revenue source for
  // engaged play. At sat=70 (good tier), this contributes $4,200/round —
  // a clear reward for keeping fill rates up. At sat=20 (poor), only
  // $1,200/round, so neglecting quality is genuinely punished.
  // numProductsCoeff bumped to 100 (4 products = $400/round) to offset
  // the stock cost of stocking more variety. sousChefCoeff at 25 keeps
  // sous hires marginally rewarding.
  // None of these can be arbitraged: numProducts caps at 6, satisfaction
  // caps at 100 and requires real output to achieve, sous chefs bounded
  // by escalating cost + cohesion penalty.
  revenueCoefficients: {
    base: 500,
    sousChefCoeff: 25,        // was 12
    satisfactionCoeff: 60.0,  // was 8.0 → 30 → 60
    adSpendCoeff: 0,          // was 0.8 — KILLED ARBITRAGE EXPLOIT
    numProductsCoeff: 100,    // was 50
    noiseMin: -100,
    noiseMax: 100,
  },

  // Balance pass 1: cut roughly 60% across the board. Old bonuses guaranteed
  // a winner could profit on the bonus alone (Newspaper $18,750 for a $1
  // minimum bid was free money). New levels make winning ads a genuine
  // edge — they bring in real customer traffic via the foot-traffic boost
  // added below — but bidding is no longer a money cannon.
  adBonuses: {
    TV: 20000,        // was 50000
    Billboard: 12500, // was 37500
    Radio: 7500,      // was 25000
    Newspaper: 4000,  // was 18750
  },

  // Balance pass 1: ad winners get a foot-traffic bonus that scales with
  // ad reach. A team that wins TV pulls noticeably more customers than a
  // team that wins nothing — but these stack capped at +30% so winning
  // all 4 ads doesn't dominate.
  // Read by satisfaction.getFootTrafficModifier when adWins is supplied.
  adFootTrafficBonuses: {
    TV: 0.15,
    Billboard: 0.10,
    Radio: 0.05,
    Newspaper: 0.025,
  },

  // Balance pass 15: minimum bid = 80% of bonus value. Pass 14 set min =
  // bonus which fully closed the cash arbitrage but ALSO removed any reason
  // for engaged players to bid (foot traffic alone wasn't enough to cover
  // their other operating costs). At 80%, the per-ad margin is $0.8k–$4k,
  // total uncontested margin across all 4 ads = $8.8k/round, $44k over a
  // 5-round game. That's bounded enough that "win all 4 ads" doesn't
  // dominate, but still rewards engaged play with a small cash bonus when
  // winning ad bidding wars.
  //
  // Combined with the ad-foot-traffic bonus (+30% capped) and the
  // adversarialCeilingCounter sanity-check strategy in the test suite,
  // tournament balance now lands engaged play at +$5k–$12k profit and
  // adversarial counter at +$7k (no longer a dominant strategy).
  adBidMinimums: {
    TV: 16000,        // 80% of $20,000 → max uncontested margin $4,000
    Billboard: 10000, // 80% of $12,500 → max uncontested margin $2,500
    Radio: 6000,      // 80% of $7,500  → max uncontested margin $1,500
    Newspaper: 3200,  // 80% of $4,000  → max uncontested margin $800
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
  chefPoolSize: 12,

  // Kitchen cohesion: chefSatisfaction = max(floor, 100 - max(0, n - threshold) × decay)
  // Balance pass 1: decay from 16 to 10 — at decay 16, 8 sous chefs put a
  // team at the floor (35) which crashed throughput. The 4-sous-chef
  // sweet spot was a cliff. With decay 10, 5 chefs = 90, 6 = 80, 7 = 70,
  // 8 = 60, 9 = 50, 10+ = 35 (floor). Smoother penalty rewards moderate
  // overstaffing in late rounds when demand is high.
  chefSatisfactionThreshold: 4,
  chefSatisfactionDecay: 10,
  chefSatisfactionFloor: 35,

  loanSharkInterestRate: 0.10,

  returningCustomerBonuses: {
    excellent: 0.15,
    good: 0.08,
  },

  curveballs: {
    burglaryThreshold: 40,
    burglaryChance: 0.25,
    burglaryAmount: 10000,
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

/**
 * coerceChefPoolSize
 * Accepts the new flat-number schema, the legacy `{min, max}` object schema,
 * or anything else (falls back to `fallback`). For legacy `{min, max}` we
 * prefer `max` so existing games keep their largest configured pool size.
 */
function coerceChefPoolSize(value, fallback) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const max = numberOrDefault(value.max, NaN);
    if (Number.isFinite(max)) return max;
    const min = numberOrDefault(value.min, NaN);
    if (Number.isFinite(min)) return min;
    return fallback;
  }
  return numberOrDefault(value, fallback);
}

// ---------------------------------------------------------------------------
// mergeConfig — deep merge user config over defaults with numeric safety
// ---------------------------------------------------------------------------

/**
 * mergeConfig
 * Deep-merges `rawConfig` over DEFAULT_GAME_CONFIG. Every numeric field is
 * validated with numberOrDefault so a malformed input can never replace a valid
 * default with NaN/undefined. Nested objects (revenueCoefficients, adBonuses,
 * phaseDurations, returningCustomerBonuses) are merged key-by-key.
 *
 * @param {object} rawConfig possibly untrusted partial config
 * @returns {object} fully-populated config safe to consume downstream
 */
function mergeConfig(rawConfig) {
  const raw = objectOrDefault(rawConfig, {});
  const d   = DEFAULT_GAME_CONFIG;

  const rawRevenue    = objectOrDefault(raw.revenueCoefficients,      {});
  const rawAds        = objectOrDefault(raw.adBonuses,                {});
  const rawAdFt       = objectOrDefault(raw.adFootTrafficBonuses,     {});
  const rawPhases     = objectOrDefault(raw.phaseDurations,           {});
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

    adFootTrafficBonuses: {
      TV:        numberOrDefault(rawAdFt.TV,        d.adFootTrafficBonuses.TV),
      Billboard: numberOrDefault(rawAdFt.Billboard, d.adFootTrafficBonuses.Billboard),
      Radio:     numberOrDefault(rawAdFt.Radio,     d.adFootTrafficBonuses.Radio),
      Newspaper: numberOrDefault(rawAdFt.Newspaper, d.adFootTrafficBonuses.Newspaper),
    },

    adBidMinimums: {
      TV:        numberOrDefault((raw.adBidMinimums || {}).TV,        d.adBidMinimums.TV),
      Billboard: numberOrDefault((raw.adBidMinimums || {}).Billboard, d.adBidMinimums.Billboard),
      Radio:     numberOrDefault((raw.adBidMinimums || {}).Radio,     d.adBidMinimums.Radio),
      Newspaper: numberOrDefault((raw.adBidMinimums || {}).Newspaper, d.adBidMinimums.Newspaper),
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

    // Backward-compat: legacy game configs stored chefPoolSize as
    // `{ min, max }`. Coerce that shape to a flat number (prefer max) so
    // existing Firestore game docs don't silently fall back to the
    // default when reloaded under the new flat-number schema.
    chefPoolSize: coerceChefPoolSize(raw.chefPoolSize, d.chefPoolSize),

    chefSatisfactionThreshold: numberOrDefault(raw.chefSatisfactionThreshold, d.chefSatisfactionThreshold),
    chefSatisfactionDecay:     numberOrDefault(raw.chefSatisfactionDecay,     d.chefSatisfactionDecay),
    chefSatisfactionFloor:     numberOrDefault(raw.chefSatisfactionFloor,     d.chefSatisfactionFloor),

    loanSharkInterestRate: numberOrDefault(raw.loanSharkInterestRate, d.loanSharkInterestRate),

    returningCustomerBonuses: {
      excellent: numberOrDefault(rawReturning.excellent, d.returningCustomerBonuses.excellent),
      good:      numberOrDefault(rawReturning.good,      d.returningCustomerBonuses.good),
    },

    // Pass-through curveballs config so simulation.js can read tunable
    // burglary parameters from the merged config rather than falling back
    // to inlined defaults. Keeps cfg.curveballs.burglaryAmount etc.
    // accessible to consumers (was undefined pre-fix).
    curveballs: {
      burglaryThreshold: numberOrDefault((raw.curveballs || {}).burglaryThreshold, d.curveballs.burglaryThreshold),
      burglaryChance:    numberOrDefault((raw.curveballs || {}).burglaryChance,    d.curveballs.burglaryChance),
      burglaryAmount:    numberOrDefault((raw.curveballs || {}).burglaryAmount,    d.curveballs.burglaryAmount),
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
  PRICE_ZONES,
  ELASTICITY_COEFFICIENTS,
  PRICE_STEP,
  FLOOR_BONUS,
  MULTIPLIER_FLOOR,
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
