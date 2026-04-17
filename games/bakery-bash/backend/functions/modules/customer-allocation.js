/**
 * customer-allocation.js
 *
 * Two-stage competitive customer allocation model for the bakery game.
 *
 * Stage 1: Base traffic pool is computed per product using base demand and
 *          the round's preference modifier (trending / warm / neutral / cold).
 * Stage 2: For each product, the pool is split across players proportional to
 *          each player's per-product satisfaction percentage. Returning
 *          customers are seeded to each player BEFORE the competitive split.
 *
 * After allocation, a per-player foot-traffic modifier (derived from the
 * player's aggregate satisfaction) is applied to their total customer count.
 *
 * All functions are pure — no side effects, no Firebase imports.
 */

const config = require('./config');
const satisfaction = require('./satisfaction');

/**
 * Calculate the total customer (demand) pool for each product in a round.
 *
 * demandPool(P) = baseDemand(P) × roundModifier(P)
 *
 * Non-numeric or non-finite demand modifiers default to 1.0 to prevent NaN
 * from propagating into the pool values.
 *
 * @param {Object} allPlayersPerProductSatisfaction - (unused here but kept
 *        in the signature per spec; per-product totals don't depend on
 *        satisfaction at this stage — Stage 1 is market-wide demand.)
 * @param {Object<string, number>} roundPreferences - product → modifier
 *        e.g. { coffee: 1.4, croissant: 1.15, ... }
 * @param {Object} cfg - Game config. Must expose cfg.products[P].baseDemand.
 * @returns {Object<string, number>} product → totalDemandPool (rounded).
 */
function calculateBaseTrafficPool(allPlayersPerProductSatisfaction, roundPreferences, cfg = config) {
  const catalog = config.PRODUCT_CATALOG;
  // roundPreferences can be { modifiers: { product: number } } or flat { product: number }
  const modifiers = (roundPreferences && roundPreferences.modifiers)
    ? roundPreferences.modifiers
    : (roundPreferences || {});
  const pools = {};
  for (const product of config.PRODUCT_KEYS) {
    const baseDemand = (catalog[product] && catalog[product].baseDemand) || 0;
    const mod = (typeof modifiers[product] === 'number' && Number.isFinite(modifiers[product]))
      ? modifiers[product]
      : 1.0;
    pools[product] = Math.round(baseDemand * mod);
  }
  return pools;
}

/**
 * Allocate customers for a single product across players.
 *
 * Process:
 *   1. Filter to players that actually offer the product (satisfaction > 0
 *      or explicit presence in their per-product map).
 *   2. Seed each player with their returning-customer count for the product.
 *   3. Split the remaining demand pool (demandPool - seededReturning) across
 *      eligible players proportionally to that player's satisfaction pct for
 *      this product.
 *
 * @param {string} product - product key.
 * @param {number} demandPool - total customers wanting this product this round.
 * @param {Array<{playerId: string, perProductSatisfaction: Object<string,number>}>} allPlayersSatisfaction
 * @param {Map<string, number>} returningCustomers - playerId → returning count
 *        (for this product, already apportioned by caller).
 * @returns {Map<string, number>} playerId → allocated customer count for product.
 */
function allocateCustomersPerProduct(product, demandPool, allPlayersSatisfaction, returningCustomers) {
  const result = new Map();

  // Only players offering the product compete for it.
  // perProductSatisfaction values can be plain numbers or objects with .satisfactionPct
  const eligible = (allPlayersSatisfaction || []).filter((p) => {
    const sat = p.perProductSatisfaction || {};
    return Object.prototype.hasOwnProperty.call(sat, product) && sat[product] != null;
  });

  if (eligible.length === 0) return result;

  // Seed returning customers first.
  let seededTotal = 0;
  for (const p of eligible) {
    const r = (returningCustomers && returningCustomers.get(p.playerId)) || 0;
    result.set(p.playerId, r);
    seededTotal += r;
  }

  // Competitive pool is whatever is left of market demand after returning.
  const competitivePool = Math.max(0, demandPool - seededTotal);

  // Helper to extract numeric satisfaction from value (could be number or {satisfactionPct})
  const getSat = (val) => {
    if (val == null) return 0;
    if (typeof val === 'number') return val;
    if (typeof val === 'object' && val.satisfactionPct != null) return val.satisfactionPct;
    return 0;
  };

  // Sum of satisfaction weights across eligible players.
  const totalSat = eligible.reduce(
    (acc, p) => acc + getSat(p.perProductSatisfaction[product]),
    0
  );

  if (totalSat <= 0) {
    // No differentiating satisfaction → split evenly among eligible.
    const even = competitivePool / eligible.length;
    for (const p of eligible) {
      result.set(p.playerId, (result.get(p.playerId) || 0) + even);
    }
  } else {
    for (const p of eligible) {
      const share = getSat(p.perProductSatisfaction[product]) / totalSat;
      const add = competitivePool * share;
      result.set(p.playerId, (result.get(p.playerId) || 0) + add);
    }
  }

  // Round to integers (floor) — leftover drift is acceptable for a game sim.
  for (const [k, v] of result.entries()) {
    result.set(k, Math.round(v));
  }
  return result;
}

/**
 * Master allocation function — runs all three allocation stages for a round.
 *
 * @param {Array<{
 *   playerId: string,
 *   perProductSatisfaction: Object<string,number>,
 *   returningCustomers: number,
 *   sousChefCount: number,
 *   numProductsOffered: number,
 *   aggregateSatisfactionPct: number
 * }>} allPlayersState - array of per-player state objects.
 * @param {Object<string,number>} roundPreferences - product → demand modifier.
 * @param {Object} cfg - game config.
 * @returns {Map<string, {
 *   totalCustomers: number,
 *   perProductCustomers: Object<string, number>,
 *   footTrafficModifier: number
 * }>} playerId → allocation result.
 */
function allocateAllCustomers(allPlayersState, roundPreferences, cfg = config) {
  // Step A: market demand per product.
  const pools = calculateBaseTrafficPool(null, roundPreferences, cfg);

  // Step B: foot-traffic modifier per player.
  // The caller (simulation.js) already computes this and passes it as
  // footTrafficMultiplier. If present, use it directly; otherwise compute.
  const footTrafficByPlayer = new Map();
  for (const p of allPlayersState) {
    if (p.footTrafficMultiplier != null) {
      footTrafficByPlayer.set(p.playerId, p.footTrafficMultiplier);
    } else {
      // Fallback: compute from aggregate satisfaction + defaults
      const mod = satisfaction.getFootTrafficModifier(
        p.aggregateSatisfactionPct || 0,
        p.perProductSatisfaction || {},
        p.numProductsOffered || 0,
        p.sousChefCount || 0
      );
      footTrafficByPlayer.set(p.playerId, 1 + mod);
    }
  }

  // Step C: for each product, distribute returning customers and run the
  // per-product competitive allocation.
  const perProductAllocations = {}; // product → Map<playerId, count>
  for (const product of Object.keys(pools)) {
    // Apportion each player's returningCustomers total across the products
    // they offer (even split). This keeps the module simple: callers that
    // want finer control can pre-split and pass product-specific maps.
    const returningForProduct = new Map();
    for (const p of allPlayersState) {
      const offered = p.perProductSatisfaction
        ? Object.keys(p.perProductSatisfaction)
        : [];
      if (!offered.includes(product)) continue;
      const n = offered.length || 1;
      const share = Math.round(((p.returningCustomers || 0) / n));
      returningForProduct.set(p.playerId, share);
    }

    perProductAllocations[product] = allocateCustomersPerProduct(
      product,
      pools[product],
      allPlayersState,
      returningForProduct
    );
  }

  // Step D: aggregate per-player, then apply foot-traffic modifier to totals.
  const out = new Map();
  for (const p of allPlayersState) {
    const perProductCustomers = {};
    let total = 0;
    for (const product of Object.keys(pools)) {
      const alloc = perProductAllocations[product] || new Map();
      const n = alloc.get(p.playerId) || 0;
      if (n > 0) {
        perProductCustomers[product] = n;
        total += n;
      }
    }
    const mod = footTrafficByPlayer.get(p.playerId) || 1.0;
    const totalCustomers = Math.round(total * mod);

    out.set(p.playerId, {
      totalCustomers,
      perProductCustomers,
      footTrafficModifier: mod,
    });
  }

  return out;
}

/**
 * Redistribute customers after one or more players sell out.
 *
 * Rules (from spec):
 *   - When a player sells out of product P, the satisfaction for P drops
 *     (handled elsewhere) and 60% of the REMAINING demand for P that was
 *     allocated to that player is redistributed to competitors offering P,
 *     weighted by their per-product satisfaction ("product-loyal" defect).
 *   - The other 40% are "brand-loyal" — they stay with the player but
 *     redirect to the player's next available (non-sold-out) product.
 *
 * This function treats the allocation values as the current customer counts
 * *after* sales have been subtracted (i.e. these are would-be turned-away
 * customers). Callers should pass the "unserved demand" portion; for a pure
 * post-hoc redistribution, passing the full allocation is also supported.
 *
 * @param {Map<string, {
 *   totalCustomers: number,
 *   perProductCustomers: Object<string, number>,
 *   footTrafficModifier: number
 * }>} allocations
 * @param {Map<string, Object<string, boolean>>} selloutFlags
 *        playerId → { product: true } for products that sold out.
 * @param {Array<{playerId: string, perProductSatisfaction: Object<string,number>}>} allPlayersSatisfaction
 * @returns {Map<string, Object>} updated allocations (new Map; input not mutated).
 */
function processCustomerDefections(allocations, selloutFlags, allPlayersSatisfaction) {
  // Deep-copy allocations so we don't mutate caller state.
  const next = new Map();
  for (const [pid, a] of allocations.entries()) {
    next.set(pid, {
      totalCustomers: a.totalCustomers,
      perProductCustomers: Object.assign({}, a.perProductCustomers || {}),
      footTrafficModifier: a.footTrafficModifier,
    });
  }

  if (!selloutFlags || selloutFlags.size === 0) return next;

  const satByPlayer = new Map(
    (allPlayersSatisfaction || []).map((p) => [p.playerId, p.perProductSatisfaction || {}])
  );

  for (const [pid, products] of selloutFlags.entries()) {
    const playerAlloc = next.get(pid);
    if (!playerAlloc) continue;

    for (const product of Object.keys(products || {})) {
      if (!products[product]) continue;
      const unserved = playerAlloc.perProductCustomers[product] || 0;
      if (unserved <= 0) continue;

      // All unserved removed from this player for this product.
      playerAlloc.perProductCustomers[product] = 0;
      playerAlloc.totalCustomers = Math.max(0, playerAlloc.totalCustomers - unserved);

      const productLoyal = Math.round(unserved * 0.60);
      const brandLoyal = unserved - productLoyal;

      // --- Product-loyal: defect to competitors offering this product. ---
      const competitors = [];
      for (const p of allPlayersSatisfaction || []) {
        if (p.playerId === pid) continue;
        const flags = selloutFlags.get(p.playerId) || {};
        if (flags[product]) continue; // competitor also sold out → skip
        const sat = (p.perProductSatisfaction || {})[product];
        if (sat != null && sat > 0) competitors.push({ playerId: p.playerId, sat });
      }

      if (competitors.length > 0 && productLoyal > 0) {
        const total = competitors.reduce((a, c) => a + c.sat, 0);
        for (const c of competitors) {
          const share = total > 0 ? c.sat / total : 1 / competitors.length;
          const add = Math.round(productLoyal * share);
          const alloc = next.get(c.playerId);
          if (!alloc) continue;
          alloc.perProductCustomers[product] =
            (alloc.perProductCustomers[product] || 0) + add;
          alloc.totalCustomers += add;
        }
      }

      // --- Brand-loyal: stay with player but redirect to their next
      // available (non-sold-out) product. Pick highest-satisfaction option. ---
      if (brandLoyal > 0) {
        const mySat = satByPlayer.get(pid) || {};
        const myFlags = selloutFlags.get(pid) || {};
        const candidates = Object.keys(mySat)
          .filter((p) => p !== product && !myFlags[p] && mySat[p] > 0)
          .sort((a, b) => (mySat[b] || 0) - (mySat[a] || 0));
        if (candidates.length > 0) {
          const next_p = candidates[0];
          playerAlloc.perProductCustomers[next_p] =
            (playerAlloc.perProductCustomers[next_p] || 0) + brandLoyal;
          playerAlloc.totalCustomers += brandLoyal;
        }
        // If no products left, brand-loyal customers are lost (no redirect).
      }
    }
  }

  return next;
}

module.exports = {
  calculateBaseTrafficPool,
  allocateCustomersPerProduct,
  allocateAllCustomers,
  processCustomerDefections,
};
