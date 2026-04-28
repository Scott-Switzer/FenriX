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

const {
  equipmentFactorCapacity,
  equipmentFactorSatisfaction,
  cleanlinessFactor,
  gradeFromScore,
  cleanlinessDriftDelta,
  nextEquipmentGrade,
  tierUpgradeCost,
} = require('./equipment-cleanliness');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// BUG-3 fix: deterministic seeded PRNG (Mulberry32) for burglary so
// retryStuckSimulation produces identical results.
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
 * Pull the ad names won by a player this round.
 */
function getAdWins(player) {
  const ar = player && player.auctionResults;
  if (!ar) return [];
  if (Array.isArray(ar.adWins)) {
    return ar.adWins.filter((adType) => typeof adType === 'string' && adType);
  }
  return typeof ar.adWon === 'string' && ar.adWon ? [ar.adWon] : [];
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

function getChefsWon(player) {
  const ar = player && player.auctionResults;
  if (!ar || !Array.isArray(ar.chefsWon)) return [];
  return ar.chefsWon.filter((chef) => chef && typeof chef === 'object');
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

  const equipmentGrade = player.equipmentGrade || 'C';
  const cleanlinessGrade = gradeFromScore(player.cleanlinessScore);

  const offeredProducts = getOfferedProducts(decision);
  const perProduct = {};

  for (const product of offeredProducts) {
    // Step 1: raw total output from base + specialty + sous chefs
    const totalOutput = calculateTotalProductOutput(product, specialtyChefs, sousChefAssignments);

    // Step 2: supply cap — cannot exceed what was stocked
    const qtyStocked = getQuantity(decision, product);
    const supplyCapped = Math.min(totalOutput, qtyStocked);

    // Step 3: equipment factor on throughput
    const effectiveOutput = supplyCapped * equipmentFactorCapacity(equipmentGrade);

    // Step 4: fill rate uses round-modified base demand (trending boosts demand)
    const baseDemand = (PRODUCT_CATALOG[product] && PRODUCT_CATALOG[product].baseDemand) || 0;
    const roundModifier = getRoundModifier(roundPreferences, product);
    const demand = Math.max(1, baseDemand * roundModifier);

    const fillRate = effectiveOutput / demand;
    const rawSat = fillRateToSatisfactionPct(fillRate);
    const satisfactionPct = Math.max(0, Math.min(100,
      rawSat * cleanlinessFactor(cleanlinessGrade) * equipmentFactorSatisfaction(equipmentGrade)
    ));
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

  return { offeredProducts, perProduct, equipmentGrade, cleanlinessGrade };
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
  // Recompute tier from the capped satisfaction so it stays consistent.
  // Was hardcoded to 'poor' which produced sat=8 / tier='poor' inconsistencies
  // when the cap didn't change the underlying sat (because it was already low).
  cloned.tier = tierForSatisfaction(cloned.satisfactionPct);
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
function runSimulation(players, roundPreferences, config, { gameId = 'game', round = 0, day = 0, skipCostAccounting = false } = {}) {
  const safePlayers = Array.isArray(players) ? players : [];

  // Numeric sanitizer: coerces value to a finite number, defaulting to 0.
  const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  // ---------------------------------------------------------------------
  // Pass 1 — per-player output, chef-sat score, per-product satisfaction
  // ---------------------------------------------------------------------
  const perPlayer = safePlayers.map((player) => {
    const { offeredProducts, perProduct, equipmentGrade, cleanlinessGrade } =
      computePlayerOutputAndSatisfaction(player, roundPreferences, config);

    // Aggregate satisfaction (weighted) across this player's offered products.
    const aggResult = calculateAggregateSatisfaction(perProduct);
    const aggregateSatisfactionPct = aggResult.aggregateSatisfactionPct;

    return {
      player,
      offeredProducts,
      perProduct,
      aggregateSatisfactionPct,
      equipmentGrade,
      cleanlinessGrade,
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
    // Balance pass 1: ad wins now contribute foot-traffic, not just cash.
    const adWins = getAdWins(p);
    // Compute foot traffic modifier using the full signature
    const footTrafficMod = getFootTrafficModifier(
      pp.aggregateSatisfactionPct,
      pp.perProduct,
      pp.offeredProducts.length,
      sousChefCount,
      adWins,
      config
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
    let nextRoundEquipmentGrade = pp.equipmentGrade || 'C';
    let equipmentUpgradeApplied = false;

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
      const preStats = pp.perProduct[product];
      const allocatedCustomers = Math.max(0, Math.floor(Number(allocPerProduct[product]) || 0));
      const qtyStocked = preStats.qtyStocked;

      let sellout = false;
      if (allocatedCustomers > qtyStocked) {
        const r = applySelloutCap(pp.perProduct, product);
        sellout = r.sellout;
        selloutAnywhere = selloutAnywhere || sellout;
      }

      // Read stats AFTER the potential cap so the output reflects the cap.
      // applySelloutCap reassigns pp.perProduct[product] to a cloned entry —
      // capturing stats before the call would surface pre-cap values.
      const stats = pp.perProduct[product];
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
    const adWins = getAdWins(p);
    const chefBidPaid = getChefBidPaid(p);
    const chefsWon = getChefsWon(p);

    // DEC-03/DEC-04: flat ad-winner bonus added to gross revenue.
    // A24-I10: only award the bonus if the team actually stocked product
    // this round — an ad that points customers at a dark storefront
    // earns nothing. Prevents the "win TV, stock nothing, collect $50k"
    // exploit where a team guaranteed a $15k-plus profit with zero risk.
    const stockedAnything = Object.values(pp.perProduct).some(
      (stats) => stats && Number(stats.qtyStocked) > 0,
    );
    const adWinnerBonus = stockedAnything
      ? adWins.reduce((sum, adType) => {
          return sum + ((config && config.adBonuses && config.adBonuses[adType]) || 0);
        }, 0)
      : 0;

    let revenueGross = computeGrossRevenue({
      sousChefCount,
      aggregateSatisfactionPct: postSelloutAggregate,
      adSpend: adBidPaid,
      numProducts: pp.offeredProducts.length,
      totalProductRevenue,
      noiseSeed: `${gameId || 'game'}:${round}:${day}:${p.playerId}`,
    }, config);
    revenueGross += adWinnerBonus;

    // V9 (Apr 26): if no customers actually walked in AND nothing was sold,
    // the player wasn't really "open" — `computeGrossRevenue` would still
    // hand them the $500 base + noise floor (foot-traffic baseline), which
    // confused playtesters seeing "$527 profit / 0 customers" on the
    // results screen. Zero out the formula's floor in that case so an
    // empty bakery shows as $0 (plus any ad-winner bonus they earned).
    if (customerCount === 0 && totalProductRevenue === 0) {
      revenueGross = adWinnerBonus;
    }

    // --- Round costs (excluding loan shark) ---
    // P2 (2026-04-27): when skipCostAccounting=true (multi-day inner calls),
    // zero out costs and loan-shark — the multi-day wrapper computes them
    // ONCE per month using monthly aggregates. Otherwise (single-round mode,
    // default) behave as before. Without this flag a 30-day month would charge
    // stock cost 30× and loan-shark interest 30× for any team that overspends.
    const budgetCurrent = _num(p.budgetCurrent);
    let totalSpent = 0;
    let amountBorrowed = 0;
    let interestCharged = 0;
    let loanSharkDeduction = 0;
    if (!skipCostAccounting) {
      const costDecision = {
        perProductQtyStocked: decision.quantities || {},
        sousChefCount,
      };
      const costAuction = {
        adAuctionWinningBid: adBidPaid,
        chefAuctionWinningBid: chefBidPaid,
      };
      const roundCosts = calculateRoundCosts(costDecision, costAuction, config);
      totalSpent = roundCosts.totalSpent;

      // Equipment upgrade — deduct cost if requested and the player has cash + room to upgrade.
      // Returns the new grade for the result; original `equipmentGrade` (pp.equipmentGrade)
      // is unchanged for the rest of THIS round's compute. The bump applies to NEXT round.
      const upgradeRequested = !!decision.equipmentUpgradePurchased;
      const _eqGradeForRound = pp.equipmentGrade || 'C';
      const _nextGrade = nextEquipmentGrade(_eqGradeForRound);
      const _upgradeCost = tierUpgradeCost(_eqGradeForRound);
      if (upgradeRequested && _nextGrade && _upgradeCost && (budgetCurrent - totalSpent) >= _upgradeCost) {
        totalSpent += _upgradeCost;
        nextRoundEquipmentGrade = _nextGrade;
        equipmentUpgradeApplied = true;
      }

      // Maintenance staff cost — flat per-head, deducted alongside other staff.
      const maintenanceStaffCount = (decision.staffCounts && Number(decision.staffCounts.maintenanceGuys)) || 0;
      const maintenanceCost = Math.max(0, maintenanceStaffCount) *
        ((config && config.MAINTENANCE_STAFF_COST) || 20);
      totalSpent += maintenanceCost;

      const loanResult = calculateLoanShark(totalSpent, budgetCurrent, config);
      amountBorrowed = loanResult.borrowed;
      interestCharged = loanResult.interest;
      loanSharkDeduction = loanResult.loanSharkDeduction;
    }
    const revenueNet = revenueGross - loanSharkDeduction;

    // Cleanliness drift for next round.
    const _maintenanceStaffCount = (decision.staffCounts && Number(decision.staffCounts.maintenanceGuys)) || 0;
    const _currentScore = Number.isFinite(p.cleanlinessScore) ? p.cleanlinessScore : 75;
    const _delta = cleanlinessDriftDelta(_maintenanceStaffCount, customerCount);
    const cleanlinessScoreNext = Math.max(0, Math.min(100, _currentScore + _delta));
    const cleanlinessGradeNext = gradeFromScore(cleanlinessScoreNext);

    // HIGH-07 fix: use the canonical updateBudget formula from loan-shark.js.
    // Spec says budgets CAN go negative — do NOT clamp at zero.
    // P2: when skipCostAccounting=true, just pass budgetCurrent through
    // unchanged (the wrapper computes the real budgetAfter once per month).
    const budgetAfter = skipCostAccounting
      ? budgetCurrent
      : Math.round(updateBudget(budgetCurrent, revenueNet, totalSpent));

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
      // Equipment + cleanliness (from C2/C3):
      equipmentGrade: pp.equipmentGrade,
      cleanlinessScore: cleanlinessScoreNext,
      cleanlinessGrade: cleanlinessGradeNext,
      equipmentUpgradePurchased: equipmentUpgradeApplied,
      // POST-01: per-product resolved prices (snapped, clamped, carry-over)
      // flow into the `price_<product>` CSV columns via csv-export.js.
      productPrices: resolvedPricesPerPlayer[p.playerId] || {},
      // Professor export:
      playerId: p.playerId,
      displayName: p.displayName,
      bakeryName: p.bakeryName,
    });

    // --- Burglar curveball (BE-N06) — fires when cleanliness is critically low ---
    // P2: skip in per-day inner calls; wrapper rolls it once per month so the
    // burglary chance isn't multiplied 30× across daily sub-simulations.
    let burglary = false;
    let actualBurglaryAmount = 0;
    let budgetAfterBurglary = budgetAfter;
    if (!skipCostAccounting) {
      const burglaryThreshold = (config && config.curveballs && config.curveballs.burglaryThreshold) || 40;
      const burglaryChance = (config && config.curveballs && config.curveballs.burglaryChance) || 0.25;
      const burglaryAmount = (config && config.curveballs && config.curveballs.burglaryAmount) || 10000;
      const cleanlinessPct = typeof p.cleanliness_pct === 'number' ? p.cleanliness_pct : undefined;
      // BUG-3 fix: seeded PRNG for deterministic burglary.
      const burglarySeed = `${gameId || 'game'}:${round}:${p.playerId}:burglary`;
      const burglaryRng = _mulberry32(_hashStringToInt(burglarySeed));
      if (cleanlinessPct != null && cleanlinessPct < burglaryThreshold && burglaryRng() < burglaryChance) {
        burglary = true;
        actualBurglaryAmount = burglaryAmount;
        budgetAfterBurglary = Math.max(0, budgetAfter - burglaryAmount);
      }
    }

    results.push({
      playerId: p.playerId,
      displayName: p.displayName,
      bakeryName: p.bakeryName,
      revenueGross,
      revenueNet,
      amountBorrowed,
      interestCharged,
      totalSpent,
      budgetAfter: budgetAfterBurglary,
      customerCount,
      perProductCustomers,
      aggregateSatisfactionPct: postSelloutAggregate,
      // Equipment + cleanliness state for next round persistence:
      equipmentGrade: nextRoundEquipmentGrade,
      cleanlinessScore: cleanlinessScoreNext,
      cleanlinessGrade: cleanlinessGradeNext,
      equipmentUpgradeApplied,
      perProductSatisfaction,
      returningCustomersEarned,
      selloutAnywhere,
      adWon: adWins[0] || null,
      adWins,
      adBidPaid,
      chefsWon,
      chefBidPaid,
      csvRow,
      productPrices: resolvedPricesPerPlayer[p.playerId] || {},
      revenueBreakdown,
      burglary,
      burglaryAmount: burglary ? actualBurglaryAmount : 0,
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
