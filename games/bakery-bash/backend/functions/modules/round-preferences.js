/**
 * round-preferences.js
 *
 * Generates the demand-preference profile for every round of a game at
 * creation time, and produces a "Plaza Times" market-insight email that
 * gives players a vague hint about what's trending.
 *
 * Per spec, each round assigns:
 *   - 2 Trending products  (+40%, modifier 1.40)
 *   - 2 Warm products      (+15%, modifier 1.15)
 *   - 1 Neutral product    (±0%,  modifier 1.00)
 *   - 1 Cold product       (-25%, modifier 0.75)
 *
 * Hard constraint: no product may be Trending in two consecutive rounds.
 *
 * All functions are pure.
 */

const config = require('./config');

const MOD_TRENDING = 1.40;
const MOD_WARM = 1.15;
const MOD_NEUTRAL = 1.00;
const MOD_COLD = 0.75;

// Simple deterministic shuffle (Fisher–Yates) using Math.random. Tests can
// stub Math.random if they need determinism; preference generation is not
// performance-critical.
function _shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build a single round's preference assignment given the products and any
 * products that are FORBIDDEN from trending this round (because they were
 * trending last round).
 *
 * @param {string[]} allProducts - list of 6 product keys.
 * @param {string[]} forbiddenTrending - products that cannot be Trending.
 * @returns {{ trending: string[], warm: string[], neutral: string[], cold: string[] }}
 */
function _buildRound(allProducts, forbiddenTrending) {
  // Pick 2 trending from the non-forbidden set.
  const eligibleForTrending = allProducts.filter(
    (p) => !forbiddenTrending.includes(p)
  );
  // Safety: if too few eligible (shouldn't happen with 6 products and 2
  // forbidden), fall back to all products.
  const trendingPool = eligibleForTrending.length >= 2
    ? eligibleForTrending
    : allProducts;
  const trending = _shuffle(trendingPool).slice(0, 2);

  const remaining = allProducts.filter((p) => !trending.includes(p));
  const shuffledRemaining = _shuffle(remaining);
  const warm = shuffledRemaining.slice(0, 2);
  const neutral = shuffledRemaining.slice(2, 3);
  const cold = shuffledRemaining.slice(3, 4);

  return { trending, warm, neutral, cold };
}

function _toModifiers(round) {
  const mods = {};
  for (const p of round.trending) mods[p] = MOD_TRENDING;
  for (const p of round.warm) mods[p] = MOD_WARM;
  for (const p of round.neutral) mods[p] = MOD_NEUTRAL;
  for (const p of round.cold) mods[p] = MOD_COLD;
  return mods;
}

/**
 * Generate the preference profile for every round of a game.
 *
 * @param {number} totalRounds
 * @param {Object} cfg - expects cfg.products (keys enumerate the 6 products).
 * @returns {Array<{
 *   trending: string[], warm: string[], neutral: string[], cold: string[],
 *   modifiers: Object<string, number>
 * }>}
 */
function generateGamePreferences(totalRounds, cfg = {}) {
  // Use PRODUCT_KEYS from config module — this is the canonical list of products.
  const products = config.PRODUCT_KEYS.slice();

  const rounds = [];
  let prevTrending = [];
  for (let i = 0; i < totalRounds; i++) {
    const r = _buildRound(products, prevTrending);
    r.modifiers = _toModifiers(r);
    rounds.push(r);
    prevTrending = r.trending;
  }
  return rounds;
}

/**
 * Extract the modifiers object from a round's preferences.
 *
 * @param {{ modifiers: Object<string, number> }} roundPreferences
 * @returns {Object<string, number>}
 */
function getDemandModifiers(roundPreferences) {
  if (!roundPreferences) return {};
  return Object.assign({}, roundPreferences.modifiers || {});
}

// --- Market insight email templates -----------------------------------------
//
// Keyed by a sorted "a|b" string of the two trending products so lookups are
// order-independent. Each body is vague — hints at the trend without
// spelling out the modifier values, per the spec.
const TRENDING_PAIR_TEMPLATES = {
  'coffee|croissant':
    "The morning rush crowd is buzzing about artisan breakfast pairings — shops with that classic French café energy are drawing lines around the block.",
  'coffee|matcha':
    "Wellness Wednesday is trending on social — green is in, but the classics still hold strong. Caffeine, in all its forms, rules the week.",
  'coffee|bagel':
    "Commuter corners are packed at dawn. Regulars report a 'grab-and-go' renaissance — a hot drink in one hand, something chewy in the other.",
  'coffee|cookie':
    "Afternoon pick-me-ups are having a moment. Cozy cafés pairing a warm drink with something sweet are drawing an after-school crowd.",
  'coffee|sandwich':
    "Lunch-hour foot traffic is shifting toward full-service counters — customers want their midday caffeine AND something substantial.",
  'croissant|matcha':
    "Brunch influencers are obsessed with 'Paris-meets-Kyoto' aesthetics this week. Pastel photography is everywhere on the feed.",
  'croissant|bagel':
    "A battle of the doughs! Carb lovers are out in force — flaky vs. chewy, and the neighborhood can't pick a side.",
  'croissant|cookie':
    "A buttery mood has taken hold. Anything that crumbles, flakes, or melts in the mouth is flying off the shelves.",
  'croissant|sandwich':
    "European café vibes are trending — picnic boards, baguette culture, and flaky layers are all the rage.",
  'matcha|bagel':
    "A 'New York meets Tokyo' aesthetic is lighting up lifestyle blogs. Dense chewy carbs plus bright green sips — an unlikely pair that's winning hearts.",
  'matcha|cookie':
    "Tea-time energy is everywhere. Shops leaning into an afternoon-treat vibe are pulling an Instagrammable crowd.",
  'matcha|sandwich':
    "A 'healthy lunch' trend has taken root — light, colorful plates washed down with something green and frothy.",
  'bagel|cookie':
    "Nostalgia is in. Neighborhood staples — the chewy, the sweet, the lunchbox classics — are seeing a quiet comeback.",
  'bagel|sandwich':
    "A 'deli revival' is sweeping the district. Anything built on a hearty base is winning the lunch crowd.",
  'cookie|sandwich':
    "Lunch-and-a-treat combos are the talk of the office Slack channels. Whoever nails the value meal wins the hour.",
};

// Per-product fallbacks if the pair isn't in the library (defensive).
const SINGLE_PRODUCT_FALLBACK = {
  coffee: "caffeine culture is having a renaissance",
  croissant: "flaky French pastries are trending on every feed",
  bagel: "a deli-counter revival has taken hold",
  cookie: "sweet treats are the vibe this week",
  sandwich: "a hearty-lunch movement is picking up steam",
  matcha: "wellness-forward drinks are dominating the conversation",
};

function _pairKey(a, b) {
  return [a, b].sort().join('|');
}

/**
 * Generate a vague market-insight email for this round, based on the two
 * trending products.
 *
 * @param {{ trending: string[] }} roundPreferences
 * @returns {{ subject: string, body: string, from: string }}
 */
function generateMarketInsightEmail(roundPreferences) {
  const trending = (roundPreferences && roundPreferences.trending) || [];
  const from = 'The Plaza Times';

  if (trending.length < 2) {
    return {
      from,
      subject: 'Market Watch: A Quiet Week on the Plaza',
      body: "Nothing especially loud in the tea leaves this week — customers seem to be spreading their dollars around. Sharp operators will stay nimble.",
    };
  }

  const key = _pairKey(trending[0], trending[1]);
  const body = TRENDING_PAIR_TEMPLATES[key]
    || _fallbackBody(trending[0], trending[1]);

  return {
    from,
    subject: 'Market Watch: What\'s Buzzing on the Plaza',
    body,
  };
}

function _fallbackBody(a, b) {
  const ha = SINGLE_PRODUCT_FALLBACK[a] || `${a} is having a moment`;
  const hb = SINGLE_PRODUCT_FALLBACK[b] || `${b} is catching on`;
  return `A curious pairing this week — ${ha}, and at the same time ${hb}. Expect the savvy shopper to chase both.`;
}

module.exports = {
  generateGamePreferences,
  getDemandModifiers,
  generateMarketInsightEmail,
  // exported for tests
  MOD_TRENDING,
  MOD_WARM,
  MOD_NEUTRAL,
  MOD_COLD,
};
