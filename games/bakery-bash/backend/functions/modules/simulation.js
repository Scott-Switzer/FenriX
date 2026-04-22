/**
 * simulation.js — Pure end-of-round simulation engine.
 *
 * No Firebase dependencies. CommonJS exports only.
 *
 * Given a snapshot of all players' decisions, chef rosters, budgets, auction
 * results, and the round's preference profile, `runSimulation` returns a
 * per-player result array suitable for batch-writing back to Firestore by the
 * caller (index.js).
 *
 * This module orchestrates the pure sub-modules:
 *   - config.js           (PRODUCT_CATALOG, PRODUCT_KEYS, etc.)
 *   - chef-system.js      (output math, chef satisfaction score)
 *   - satisfaction.js     (fill rate → tier mapping, aggregate)
 *   - customer-allocation.js (two-stage competitive split)
 *   - revenue.js          (revenue formula, round cost totaling)
 *   - loan-shark.js       (borrowing + interest)
 *   - csv-export.js       (flat CSV row builder)
 */

const {
  PRODUCT_CATALOG,
  PRODUCT_KEYS,
  PRICE_ZONES,
} = require('./config');

const {
  resolvePriceForSim,
} = require('./pricing');

const {
  calculateTotalProductOutput,
  calculateChefSatisfactionScore,
  calculateEffectiveOutput,
} = require('./chef-system');

const {
  fillRateToSatisfactionPct,
  tierForSatisfaction,
  calculateAggregateSatisfaction,
  getFootTrafficModifier,
} = require('./satisfaction');

const {
  allocateAllCustomers,
} = require('./customer-allocation');

const {
  computeGrossRevenue,
  calculateRoundCosts,
} = require('./revenue');

const {
  calculateLoanShark,
  updateBudget,
} = require('./loan-shark');

const {
  buildCsvRow,
} = require('./csv-export');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely pull a numeric modifier for a product from the round preferences.
 * Defaults to 1.0 (neutral) when missing or invalid.
 */
function getRoundModifier(roundPreferences, product) {
  const modifiers = (roundPreferences && roundPreferences.modifiers) || {};
  const raw = modifiers[product];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1.0;
}

/**
 * The list of products this player offers this round. A product is considered
 * "offered" if it is in the menu object with truthy value, OR it has a
 * non-zero quantity stocked.
 */
function getOfferedProducts(decision) {
  const menu = (decision && decision.menu) || {};
  const quantities = (decision && decision.quantities) || {};
  return PRODUCT_KEYS.filter((product) => {
    const onMenu = menu[product] === true;
    const qty = Number(quantities[product]) || 0;
    return onMenu || qty > 0;
  });
}

/**
 * Safe quantity lookup.
 */
function getQuantity(decision, product) {
  const q = decision && decision.quantities ? decision.quantities[product] : 0;
  const n = Number(q);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Pull the ad name (or null) from a player's auction results.
 */
function getAdWon(player) {
  const ar = player && player.auctionResults;
  if (!ar) return null;
  return typeof ar.adWon === 'string' && ar.adWon ? ar.adWon : null;
}

function getAdBidPaid(player) {
  const ar = player && player.auctionResults;
  if (!ar) return 0;
  const v = Number(ar.adBidPaid);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function getChefBidPaid(player) {
  const ar = player && player.auctionResults;
  if (!ar) return 0;
  const v = Number(ar.chefBidPaid);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// ---------------------------------------------------------------------------
// Per-player output + satisfaction computation
// ---------------------------------------------------------------------------

/**
 * Compute, for a single player, their effective output and per-product
 * satisfaction for every offered product.
 *
 * Returns:
 *   {
 *     offeredProducts: string[],
 *     chefSatisfactionScore: number,
 *     perProduct: {
 *       [product]: {
 *         totalOutput, effectiveOutput,
 *         qtyStocked, fillRate,
 *         satisfactionPct, tier
 *       }
 *     }
 *   }
 */
function computePlayerOutputAndSatisfaction(player, roundPreferences, config) {
  const decision = player.decision || {};
  const specialtyChefs = Array.isArray(player.specialtyChefs) ? player.specialtyChefs : [];
  const sousChefAssignments = (decision && decision.sousChefAssignments) || {};
  const sousChefCount = Number.isFinite(decision.sousChefCount)
    ? decision.sousChefCount
    : Number(player.sousChefCount) || 0;

  const chefSatisfactionScore = calculateChefSatisfactionScore(sousChefCount, config);

  const offeredProducts = getOfferedProducts(decision);
  const perProduct = {};

  for (const product of offeredProducts) {
    // Step 1: raw total output from base + specialty + sous chefs
    const totalOutput = calculateTotalProductOutput(product, specialtyChefs, sousChefAssignments);

    // Step 2: supply cap — cannot exceed what was stocked
    const qtyStocked = getQuantity(decision, product);
    const supplyCapped = Math.min(totalOutput, qtyStocked);

    // Step 3: chef-satisfaction multiplier on throughput
    const effectiveOutput = calculateEffectiveOutput(supplyCapped, chefSatisfactionScore);

    // Step 4: fill rate uses round-modified base demand (trending boosts demand)
    const baseDemand = (PRODUCT_CATALOG[product] && PRODUCT_CATALOG[product].baseDemand) || 0;
    const roundModifier = getRoundModifier(roundPreferences, product);
    const demand = Math.max(1, baseDemand * roundModifier);

    const fillRate = effectiveOutput / demand;
    const satisfactionPct = fillRateToSatisfactionPct(fillRate);
    const tier = tierForSatisfaction(satisfactionPct);

    perProduct[product] = {
      totalOutput,
      effectiveOutput,
      qtyStocked,
      fillRate,
      satisfactionPct,
      tier,
    };
  }

  return { offeredProducts, chefSatisfactionScore, perProduct };
}

// ---------------------------------------------------------------------------
// Sell-out cap
// ---------------------------------------------------------------------------

/**
 * If a product's allocated customer count exceeds supply, we cap the
 * customers at the supply and drop the satisfaction tier to Poor.
 *
 * Spec: "When supply exhausted: satisfaction drops to Poor (≤45)."
 * We cap the satisfaction at 45 (high end of poor) so excellent operations
 * that sold out still get a bit of credit relative to truly bad ones.
 */
const SELLOUT_SAT_CAP = 45;

function applySelloutCap(perProductStats, product) {
  const stats = perProductStats[product];
  if (!stats) return { sellout: false };
  // HIGH-06 fix: clone the entry before mutation to avoid corrupting
  // Pass 1 data that may be referenced later.
  const cloned = { ...stats };
  cloned.satisfactionPct = Math.min(stats.satisfactionPct, SELLOUT_SAT_CAP);
  cloned.tier = 'poor';
  perProductStats[product] = cloned;
  return { sellout: true };
}

// ---------------------------------------------------------------------------
// Returning customer bonus (for NEXT round)
// ---------------------------------------------------------------------------

/**
 * Given this round's aggregate satisfaction (0-100) and this round's customer
 * count, how many customers "return" next round?
 *
 * | Aggregate Sat | Bonus                              |
 * | Excellent     | +15% of prior round's customers    |
 * | Good          | +8%                                |
 * | Else          | 0 (resets)                         |
 */
function computeReturningCustomersEarned(aggregateSatPct, customerCount, config) {
  const bonuses = (config && config.returningCustomerBonuses) || { excellent: 0.15, good: 0.08 };
  if (aggregateSatPct >= 86) {
    return Math.round(customerCount * bonuses.excellent);
  }
  if (aggregateSatPct >= 66) {
    return Math.round(customerCount * bonuses.good);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * runSimulation
 *
 * @param {Array<object>} players           per-player state (see module docstring)
 * @param {object}        roundPreferences  { modifiers: { product: multiplier } }
 * @param {object}        config            merged game config
 * @returns {Array<object>} per-player results
 */
function runSimulation(players, roundPreferences, config, { gameId = 'game', round = 0 } = {}) {
  const safePlayers = Array.isArray(players) ? players : [];

  // Numeric sanitizer: coerces value to a finite number, defaulting to 0.
  const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  // ---------------------------------------------------------------------
  // Pass 1 — per-player output, chef-sat score, per-product satisfaction
  // ---------------------------------------------------------------------
  const perPlayer = safePlayers.map((player) => {
    const { offeredProducts, chefSatisfactionScore, perProduct } =
      computePlayerOutputAndSatisfaction(player, roundPreferences, config);

    // Aggregate satisfaction (weighted) across this player's offered products.
    const aggResult = calculateAggregateSatisfaction(perProduct);
    const aggregateSatisfactionPct = aggResult.aggregateSatisfactionPct;

    return {
      player,
      offeredProducts,
      chefSatisfactionScore,
      perProduct,
      aggregateSatisfactionPct,
    };
  });

  // ---------------------------------------------------------------------
  // POST-01: resolve each player's productPrices with carry-over fallback.
  // ---------------------------------------------------------------------
  const resolvedPricesPerPlayer = {};
  for (const pp of perPlayer) {
    const p = pp.player;
    const decision = p.decision || {};
    const submitted = decision.productPrices || {};
    const prior = Array.isArray(p.priorSubmittedPrices) ? p.priorSubmittedPrices : [];
    const resolved = {};
    for (const product of PRODUCT_KEYS) {
      const cfg = PRICE_ZONES[product];
      if (!cfg) continue;
      resolved[product] = resolvePriceForSim({
        product,
        submittedThisRound: submitted[product],
        priorSubmissions: prior.map((m) => (m && m[product])),
        productCfg: cfg,
        catalogBasePrice: (PRODUCT_CATALOG[product] && PRODUCT_CATALOG[product].fixedPrice) || 0,
      });
    }
    resolvedPricesPerPlayer[p.playerId] = resolved;
  }

  // ---------------------------------------------------------------------
  // Pass 2 — competitive customer allocation across all players
  // ---------------------------------------------------------------------
  // allocateAllCustomers is expected to return:
  //   Map<playerId, { total: number, perProduct: { [product]: count } }>
  // taking into account: aggregate satisfaction, ad foot-traffic modifier,
  // returning customers, and per-product competitive split.
  const allocationInput = perPlayer.map((pp) => {
    const p = pp.player;
    const decision = p.decision || {};
    const sousChefCount = Number.isFinite(decision.sousChefCount)
      ? decision.sousChefCount
      : Number(p.sousChefCount) || 0;
    // Compute foot traffic modifier using the full signature
    const footTrafficMod = getFootTrafficModifier(
      pp.aggregateSatisfactionPct,
      pp.perProduct,
      pp.offeredProducts.length,
      sousChefCount
    );

    return {
      playerId: p.playerId,
      aggregateSatisfactionPct: pp.aggregateSatisfactionPct,
      perProductSatisfaction: pp.perProduct,
      offeredProducts: pp.offeredProducts,
      returningCustomers: Math.max(0, Number(p.returningCustomersPending) || 0),
      footTrafficMultiplier: 1 + footTrafficMod,
      sousChefCount,
      numProductsOffered: pp.offeredProducts.length,
    };
  });

  const allocation = allocateAllCustomers(allocationInput, roundPreferences, config, resolvedPricesPerPlayer);

  // ---------------------------------------------------------------------
  // Pass 3 — sell-outs, quantities sold, revenue, loan shark, CSV row
  // ---------------------------------------------------------------------
  const results = [];

  for (const pp of perPlayer) {
    const p = pp.player;
    const decision = p.decision || {};
    const allocEntry = allocation.get ? allocation.get(p.playerId) : allocation[p.playerId];
    const allocPerProduct = (allocEntry && (allocEntry.perProductCustomers || allocEntry.perProduct)) || {};
    const customerCount = (allocEntry && Number.isFinite(allocEntry.totalCustomers))
      ? allocEntry.totalCustomers
      : (allocEntry && Number.isFinite(allocEntry.total))
        ? allocEntry.total
        : Object.values(allocPerProduct).reduce((s, n) => s + (Number(n) || 0), 0);

    // --- Sell-out detection + quantity sold ---
    const perProductCustomers = {};
    const perProductSatisfaction = {};
    let selloutAnywhere = false;

    for (const product of pp.offeredProducts) {
      const stats = pp.perProduct[product];
      const allocatedCustomers = Math.max(0, Math.floor(Number(allocPerProduct[product]) || 0));
      const qtyStocked = stats.qtyStocked;

      let sellout = false;
      if (allocatedCustomers > qtyStocked) {
        const r = applySelloutCap(pp.perProduct, product);
        sellout = r.sellout;
        selloutAnywhere = selloutAnywhere || sellout;
      }

      const qtySold = Math.min(allocatedCustomers, qtyStocked);

      perProductCustomers[product] = allocatedCustomers;
      perProductSatisfaction[product] = {
        fillRate: stats.fillRate,
        satisfactionPct: stats.satisfactionPct,
        tier: stats.tier,
        qtySold,
        qtyStocked,
        sellout,
      };
    }

    // Recompute aggregate satisfaction after sell-out caps.
    const postSelloutAggResult = calculateAggregateSatisfaction(pp.perProduct);
    const postSelloutAggregate = postSelloutAggResult.aggregateSatisfactionPct;

    // --- Revenue ---
    const resolvedPrices = resolvedPricesPerPlayer[p.playerId] || {};
    const revenueBreakdown = {};
    let totalProductRevenue = 0;
    for (const [product, s] of Object.entries(perProductSatisfaction)) {
      const override = resolvedPrices[product];
      const catalogPrice = (PRODUCT_CATALOG[product] && PRODUCT_CATALOG[product].fixedPrice) || 0;
      const price = Number.isFinite(override) ? override : catalogPrice;
      const rev = s.qtySold * price;
      revenueBreakdown[product] = { qtySold: s.qtySold, price, revenue: rev };
      totalProductRevenue += rev;
    }

    const sousChefCount = Number.isFinite(decision.sousChefCount)
      ? decision.sousChefCount
      : Number(p.sousChefCount) || 0;
    const adBidPaid = getAdBidPaid(p);
    const adWon = getAdWon(p);

    // DEC-03/DEC-04: flat ad-winner bonus added to gross revenue.
    // TV $50k, Billboard $37.5k, Radio $25k, Newspaper $18.75k (config.adBonuses).
    const adWinnerBonus =
      (adWon && config && config.adBonuses && config.adBonuses[adWon]) || 0;

    let revenueGross = computeGrossRevenue({
      sousChefCount,
      aggregateSatisfactionPct: postSelloutAggregate,
      adSpend: adBidPaid,
      numProducts: pp.offeredProducts.length,
      totalProductRevenue,
      noiseSeed: `${gameId || 'game'}:${round}:${p.playerId}`,
    }, config);
    revenueGross += adWinnerBonus;

    // --- Round costs (excluding loan shark) ---
    const costDecision = {
      perProductQtyStocked: decision.quantities || {},
      sousChefCount,
    };
    const costAuction = {
      adAuctionWinningBid: adBidPaid,
      chefAuctionWinningBid: getChefBidPaid(p),
    };
    const roundCosts = calculateRoundCosts(costDecision, costAuction, config);
    const totalSpent = roundCosts.totalSpent;

    // --- Loan shark ---
    const budgetCurrent = _num(p.budgetCurrent);
    const loanResult = calculateLoanShark(totalSpent, budgetCurrent, config);
    const amountBorrowed = loanResult.borrowed;
    const interestCharged = loanResult.interest;
    const loanSharkDeduction = loanResult.loanSharkDeduction;
    const revenueNet = revenueGross - loanSharkDeduction;

    // HIGH-07 fix: use the canonical updateBudget formula from loan-shark.js.
    // Spec says budgets CAN go negative — do NOT clamp at zero.
    const budgetAfter = Math.round(
      updateBudget(budgetCurrent, revenueNet, totalSpent)
    );

    // --- Returning customers earned (for NEXT round) ---
    const returningCustomersEarned = computeReturningCustomersEarned(
      postSelloutAggregate,
      customerCount,
      config
    );

    // --- CSV row (flat) ---
    const csvRow = buildCsvRow({
      decision,
      specialtyChefs: p.specialtyChefs,
      perProductSatisfaction,
      customerCount,
      revenueGross,
      revenueNet,
      amountBorrowed,
      interestCharged,
      aggregateSatisfactionPct: postSelloutAggregate,
      chefSatisfactionScore: pp.chefSatisfactionScore,
      // POST-01: per-product resolved prices (snapped, clamped, carry-over)
      // flow into the `price_<product>` CSV columns via csv-export.js.
      productPrices: resolvedPricesPerPlayer[p.playerId] || {},
      // For professor export
      playerId: p.playerId,
      displayName: p.displayName,
      bakeryName: p.bakeryName,
    });

    results.push({
      playerId: p.playerId,
      displayName: p.displayName,
      bakeryName: p.bakeryName,
      revenueGross,
      revenueNet,
      amountBorrowed,
      interestCharged,
      totalSpent,
      budgetAfter,
      customerCount,
      perProductCustomers,
      aggregateSatisfactionPct: postSelloutAggregate,
      chefSatisfactionScore: pp.chefSatisfactionScore,
      perProductSatisfaction,
      returningCustomersEarned,
      selloutAnywhere,
      csvRow,
      productPrices: resolvedPricesPerPlayer[p.playerId] || {},
      revenueBreakdown,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  runSimulation,
  // Exposed for unit testing
  computePlayerOutputAndSatisfaction,
  computeReturningCustomersEarned,
  SELLOUT_SAT_CAP,
};
