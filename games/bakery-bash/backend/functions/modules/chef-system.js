/**
 * chef-system.js — Chef generation, output math, satisfaction, and auction resolution.
 *
 * Pure module (no Firebase dependencies). CommonJS exports only.
 *
 * Key formulas (from build-spec.md):
 *   - Base chef: always present, 30 units/day at 1.0× on all products.
 *   - Specialty chef output: 30 × (specialty multiplier if product in chef.specialties,
 *                                  else non-specialty multiplier).
 *   - Sous chef output:      0.5 × headChefOutput(product), where headChef = highest-skill
 *                            specialty chef whose specialty includes that product
 *                            (fallback: base chef = 30).
 *   - Kitchen cohesion:      chefSatisfaction = max(floor, 100 - max(0, n - threshold) × decay).
 *   - Effective output:      totalOutput × (chefSatisfaction / 100).
 *   - Sous chef hire cost:   multiplier × sousChefBaseCost, with escalating schedule.
 */

const {
  CHEF_NATIONALITIES,
  CHEF_MULTIPLIERS,
  CHEF_SPAWN_RATES,
} = require('./config');

const BASE_CHEF_RATE = 30;            // units/day, every chef's base output
const SKILL_ORDER = { novel: 0, intermediate: 1, advanced: 2 };
const MIN_BID_FLOOR_MULTIPLIERS = { novel: 2, intermediate: 3.5, advanced: 5.5 };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight UUID-ish generator using Math.random only.
 * Produces a 16-hex-character identifier — collision-resistant enough for
 * per-round chef pools without pulling in a crypto dependency.
 */
function makeId() {
  const part = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${part()}${part()}`;
}

/**
 * Pick a random element from an array using Math.random.
 */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Sample a skill tier from a { novel, intermediate, advanced } probability map.
 */
function sampleSkillTier(rates) {
  const r = Math.random();
  if (r < rates.novel) return 'novel';
  if (r < rates.novel + rates.intermediate) return 'intermediate';
  return 'advanced';
}

/**
 * Return the numeric ordering of a skill tier (higher = better).
 */
function skillRank(tier) {
  return SKILL_ORDER[tier] ?? -1;
}

// ---------------------------------------------------------------------------
// 1. generateChefPool
// ---------------------------------------------------------------------------

/**
 * Generate one chef candidate for an auction round.
 *
 * @param {number} round   1-indexed round number (1..totalRounds)
 * @param {object} config  merged game config
 * @returns {object} chef candidate
 */
function generateOneChef(round, config) {
  const cfg = config || {};
  const idx = Math.max(0, Math.min(CHEF_SPAWN_RATES.length - 1, round - 1));
  const rates = CHEF_SPAWN_RATES[idx];
  const nationalityKeys = Object.keys(CHEF_NATIONALITIES);
  const nationality = pick(nationalityKeys);
  const gender = Math.random() < 0.5 ? 'male' : 'female';
  const name = pick(CHEF_NATIONALITIES[nationality].names[gender]);
  const skillTier = sampleSkillTier(rates);
  const specialties = CHEF_NATIONALITIES[nationality].specialties.slice();
  const baseCost = (cfg.sousChefBaseCost != null && Number.isFinite(cfg.sousChefBaseCost))
    ? cfg.sousChefBaseCost : 10;
  const minBidFloor = MIN_BID_FLOOR_MULTIPLIERS[skillTier] * baseCost;

  return {
    id: makeId(),
    nationality,
    gender,
    name,
    skillTier,
    specialties,
    minBidFloor,
  };
}

/**
 * Generate the chef pool for an auction round.
 *
 * Pool size is exact (`config.chefPoolSize`, default 12), and names are
 * deduplicated within the round so the live auction/readouts stay unambiguous.
 *
 * @param {number} round   1-indexed round number (1..totalRounds)
 * @param {object} config  merged game config (needs chefPoolSize, sousChefBaseCost)
 * @returns {Array<object>} chef pool
 */
function generateChefPool(round, config) {
  const cfg = config || {};
  const poolSize = Number.isFinite(cfg.chefPoolSize) ? cfg.chefPoolSize : 12;
  const usedNames = new Set();
  const pool = [];
  let attempts = 0;
  const maxAttempts = poolSize * 12;

  while (pool.length < poolSize && attempts < maxAttempts) {
    const chef = generateOneChef(round, cfg);
    if (!usedNames.has(chef.name)) {
      usedNames.add(chef.name);
      pool.push(chef);
    }
    attempts += 1;
  }

  return pool;
}

// ---------------------------------------------------------------------------
// 2. getChefOutputForProduct
// ---------------------------------------------------------------------------

/**
 * Daily output for one chef on a specific product.
 *   output = 30 × (specialty multiplier if product ∈ chef.specialties
 *                  else non-specialty multiplier)
 *
 * The "base chef" is represented by skillTier === 'base' (or missing skillTier):
 * always returns 30 × 1.0 = 30 regardless of product.
 *
 * @param {object} chef    { skillTier, specialties }
 * @param {string} product product key (e.g. 'croissant')
 * @returns {number} units/day
 */
function getChefOutputForProduct(chef, product) {
  if (!chef || chef.skillTier === 'base') return BASE_CHEF_RATE;

  const tier = CHEF_MULTIPLIERS[chef.skillTier];
  if (!tier) return BASE_CHEF_RATE; // unknown skill → treat as base chef

  const isSpecialty = Array.isArray(chef.specialties) && chef.specialties.includes(product);
  const mult = isSpecialty ? tier.specialty : tier.nonSpecialty;
  return BASE_CHEF_RATE * mult;
}

// ---------------------------------------------------------------------------
// Head-chef resolution (used by sous chef math)
// ---------------------------------------------------------------------------

/**
 * Determine the "head chef" for a given product — the highest-skill specialty
 * chef on the team whose specialty list includes the product. If none exist,
 * the fallback is the implicit base chef (returns 30).
 *
 * @param {string} product
 * @param {Array<object>} specialtyChefs
 * @returns {number} head chef's daily output for this product
 */
function getHeadChefOutput(product, specialtyChefs) {
  let best = null;
  for (const chef of specialtyChefs) {
    if (!Array.isArray(chef.specialties) || !chef.specialties.includes(product)) continue;
    if (best === null || skillRank(chef.skillTier) > skillRank(best.skillTier)) {
      best = chef;
    }
  }
  if (best) return getChefOutputForProduct(best, product);
  return BASE_CHEF_RATE; // base chef fallback
}

// ---------------------------------------------------------------------------
// 3. calculateTotalProductOutput
// ---------------------------------------------------------------------------

/**
 * Total daily output for a single product, summing:
 *   - base chef (always 30 units)
 *   - each specialty chef's contribution on this product
 *   - each sous chef assigned to this product, at 0.5 × headChefOutput(product)
 *
 * @param {string} product               product key
 * @param {Array<object>} specialtyChefs the head/specialty chefs on the team
 * @param {object} sousChefAssignments   map { [product]: number of sous chefs assigned }
 * @returns {number} total daily output (units)
 */
function calculateTotalProductOutput(product, specialtyChefs, sousChefAssignments) {
  // Base chef contribution (always present)
  let total = BASE_CHEF_RATE;

  // Specialty chefs each contribute their own output on this product
  for (const chef of specialtyChefs) {
    total += getChefOutputForProduct(chef, product);
  }

  // Sous chefs assigned to this product each contribute 0.5 × headChefOutput
  const sousCount = (sousChefAssignments && sousChefAssignments[product]) || 0;
  if (sousCount > 0) {
    const headOutput = getHeadChefOutput(product, specialtyChefs);
    total += sousCount * 0.5 * headOutput;
  }

  return total;
}

// ---------------------------------------------------------------------------
// 4. calculateChefSatisfactionScore (kitchen cohesion)
// ---------------------------------------------------------------------------

/**
 * Chef satisfaction (kitchen cohesion) decays once you exceed the threshold of
 * sous chefs. Applied later as a multiplier on throughput.
 *
 *   chefSatisfaction = max(floor, 100 - max(0, n - threshold) × decay)
 *
 * With defaults (threshold=4, decay=16, floor=35):
 *   n <= 4  → 100
 *   n = 5   → 84
 *   n = 6   → 68
 *   n = 7   → 52
 *   n = 8   → 36
 *   n >= 9  → 35 (floor)
 *
 * @param {number} sousChefCount
 * @param {object} config  merged game config
 * @returns {number} satisfaction score in [floor, 100]
 */
function calculateChefSatisfactionScore(sousChefCount, config) {
  const cfg = config || {};
  const n = Number.isFinite(sousChefCount) ? Math.max(0, sousChefCount) : 0;
  const threshold = Number.isFinite(cfg.chefSatisfactionThreshold) ? cfg.chefSatisfactionThreshold : 4;
  const decay = Number.isFinite(cfg.chefSatisfactionDecay) ? cfg.chefSatisfactionDecay : 16;
  const floor = Number.isFinite(cfg.chefSatisfactionFloor) ? cfg.chefSatisfactionFloor : 35;
  const over = Math.max(0, n - threshold);
  const raw = 100 - over * decay;
  return Math.max(floor, raw);
}

// ---------------------------------------------------------------------------
// 5. calculateEffectiveOutput
// ---------------------------------------------------------------------------

/**
 * Apply the kitchen-cohesion multiplier to total output.
 *   effectiveOutput = totalOutput × (chefSatisfactionScore / 100)
 *
 * @param {number} totalOutput
 * @param {number} chefSatisfactionScore  in [0, 100]
 * @returns {number}
 */
function calculateEffectiveOutput(totalOutput, chefSatisfactionScore) {
  return totalOutput * (chefSatisfactionScore / 100);
}

// ---------------------------------------------------------------------------
// 6. getSousChefCost (cost of the NEXT sous chef)
// ---------------------------------------------------------------------------

/**
 * Escalating hire schedule. `currentCount` is how many sous chefs the player
 * already owns; the returned cost is for the next (currentCount+1-th) hire.
 *
 * Multiplier table:
 *   1st (currentCount=0): 1.00×
 *   2nd (currentCount=1): 1.50×
 *   3rd (currentCount=2): 2.25×
 *   4th (currentCount=3): 3.00×
 *   5th+ (currentCount>=4): 3.00 + 0.75 × (currentCount - 3)
 *
 * All multiplied by config.sousChefBaseCost.
 *
 * @param {number} currentCount existing sous chef count
 * @param {object} config
 * @returns {number} dollar cost of the next hire
 */
function getSousChefCost(currentCount, config) {
  const n = Number.isFinite(currentCount) ? Math.max(0, Math.floor(currentCount)) : 0;
  const table = [1.0, 1.5, 2.25, 3.0];
  let multiplier;
  if (n < table.length) {
    multiplier = table[n];
  } else {
    multiplier = 3.0 + 0.75 * (n - 3);
  }
  const baseCost = (config && Number.isFinite(config.sousChefBaseCost))
    ? config.sousChefBaseCost : 10;
  return multiplier * baseCost;
}

// ---------------------------------------------------------------------------
// 7. getTotalSousChefHireCost
// ---------------------------------------------------------------------------

/**
 * Total cost to hire `count` sous chefs starting from 0.
 * Sum of getSousChefCost(i, config) for i in [0, count-1].
 *
 * @param {number} count
 * @param {object} config
 * @returns {number} total dollar cost
 */
function getTotalSousChefHireCost(count, config) {
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += getSousChefCost(i, config);
  }
  return total;
}

// ---------------------------------------------------------------------------
// 8. resolveChefAuction
// ---------------------------------------------------------------------------

/**
 * Resolve a sealed-bid chef auction.
 *
 * Input:
 *   chefPool:   Array<chef>
 *   playerBids: Array<{ playerId, chefId, amount, submittedAt }>
 *
 * Rules:
 *   - For each chef in the pool, the highest-amount bid wins.
 *   - Tie on amount → earliest submittedAt wins.
 *   - Chefs with no bids have no winner.
 *   - Each winning player "pays" their own bid amount (first-price auction).
 *     (Swap to second-price here if the game ever changes the rule.)
 *
 * Output:
 *   {
 *     winners:  Map<playerId, chef[]>   // chefs each player won
 *     payments: Map<playerId, number>   // total amount each winning player paid
 *   }
 *
 * @param {Array<object>} chefPool
 * @param {Array<object>} playerBids
 * @returns {{ winners: Map<string, object[]>, payments: Map<string, number> }}
 */
function resolveChefAuction(chefPool, playerBids) {
  const pool = Array.isArray(chefPool) ? chefPool : [];
  const bids = Array.isArray(playerBids) ? playerBids : [];
  const winners = new Map();
  const payments = new Map();

  // Group bids by chefId for O(chefs + bids) lookup.
  const bidsByChef = new Map();
  for (const bid of bids) {
    if (!bidsByChef.has(bid.chefId)) bidsByChef.set(bid.chefId, []);
    bidsByChef.get(bid.chefId).push(bid);
  }

  for (const chef of pool) {
    const bids = bidsByChef.get(chef.id);
    if (!bids || bids.length === 0) continue;

    // Highest amount wins; tiebreak on earliest submittedAt.
    let best = bids[0];
    for (let i = 1; i < bids.length; i++) {
      const b = bids[i];
      if (b.amount > best.amount) {
        best = b;
      } else if (b.amount === best.amount && b.submittedAt < best.submittedAt) {
        best = b;
      }
    }

    if (!winners.has(best.playerId)) winners.set(best.playerId, []);
    winners.get(best.playerId).push(chef);

    payments.set(best.playerId, (payments.get(best.playerId) || 0) + best.amount);
  }

  return { winners, payments };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Primary API
  generateChefPool,
  generateOneChef,
  getChefOutputForProduct,
  calculateTotalProductOutput,
  calculateChefSatisfactionScore,
  calculateEffectiveOutput,
  getSousChefCost,
  getTotalSousChefHireCost,
  resolveChefAuction,

  // Exposed for testing / reuse
  getHeadChefOutput,
  BASE_CHEF_RATE,
  MIN_BID_FLOOR_MULTIPLIERS,
};
