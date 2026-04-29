/**
 * multi-day-simulation.js
 *
 * Wraps the pure runSimulation() in a per-day loop. A round represents one
 * month; this module runs daysPerRound (default 30) sub-simulations, each
 * with an independent demand-variability multiplier and noise seed. Returns
 * monthly aggregates with the daily rows attached for CSV export.
 *
 * Cost / loan-shark / budget update happen ONCE per month at the
 * wrapper level using monthly aggregates, NOT per day. Per-day runSimulation
 * calls use skipCostAccounting=true so they only emit customer / revenue /
 * satisfaction. Without that flag a 30-day month would charge stock cost
 * 30x and loan-shark interest 30x for any team that overspends.
 *
 * Demand scaling: each day's demand pool is `baseDemand * roundMod * dayMult
 * / daysPerRound`, where dayMult is uniform in [0.7, 1.3]. Sum across the
 * month ≈ baseDemand * roundMod (preserves pre-P2 round-level KPI magnitude
 * so the existing economy doesn't need rebalancing).
 *
 * Loan-shark apportionment: `loanSharkDeduction` is computed once on the
 * monthly cost. Per-day `revenueNet` is `revenueGross - daily_share_of_deduction`
 * where the share is proportional to the day's gross revenue. Per-day
 * `amount_borrowed` and `interest_charged` are also apportioned the same way.
 * Sum of daily revenueNet equals monthly revenueNet by construction.
 *
 * Reproducibility: revenue and customer outcomes are reproducible per
 * gameId/round/day via seeded gaussianNoise + the FNV-1a demand multiplier.
 * Reproducibility: outcomes are deterministic per gameId/round/day via seeded
 * Mulberry32 PRNG + FNV-1a demand multiplier so retryStuckSimulation
 * produces bitwise-identical results.
 *
 * Pure: no Firebase deps.
 */

const config = require('./config');
const { runSimulation, computeReturningCustomersEarned } = require('./simulation');
const { calculateRoundCosts } = require('./revenue');
const { calculateLoanShark, updateBudget } = require('./loan-shark');
const { buildCsvRow } = require('./csv-export');
const { nextEquipmentGrade, tierUpgradeCost, gradeFromScore, cleanlinessDriftDelta } = require('./equipment-cleanliness');

/**
 * Build a per-day deterministic demand-variability multiplier.
 * Uniform in [min, max], seeded by `${gameId}:${round}:${day}:demand`.
 */
function demandMultiplierForDay(gameId, round, day, cfg = config) {
  const min = (cfg.MULTI_DAY && cfg.MULTI_DAY.demandVariabilityMin) || 0.7;
  const max = (cfg.MULTI_DAY && cfg.MULTI_DAY.demandVariabilityMax) || 1.3;
  // Simple deterministic FNV-1a hash → [0, 1)
  const seed = `${gameId}:${round}:${day}:demand`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = ((h >>> 0) / 0xffffffff);
  return min + u * (max - min);
}

/**
 * Apply a per-day scale factor to roundPreferences.modifiers so the daily
 * demand pool wobbles around `roundMod / daysPerRound`. Sum across the month
 * ≈ roundMod * baseDemand, matching pre-P2 round-level KPI magnitudes.
 */
function dayPreferences(roundPreferences, dayScale) {
  const baseMods = (roundPreferences && roundPreferences.modifiers)
    ? roundPreferences.modifiers
    : (roundPreferences || {});
  const scaled = {};
  for (const [product, mod] of Object.entries(baseMods)) {
    scaled[product] = (Number(mod) || 1.0) * dayScale;
  }
  return { ...(roundPreferences || {}), modifiers: scaled };
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Deterministic seeded PRNG (Mulberry32). Used for demand variability and
 * noise so retryStuckSimulation produces bitwise-identical results.
 */
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

function runMonthlySimulation(players, roundPreferences, cfg = config, { gameId = 'game', round = 0 } = {}) {
  const days = (cfg.MULTI_DAY && cfg.MULTI_DAY.daysPerRound) || 30;

  // Run N daily sims. skipCostAccounting=true means each daily call only
  // produces customer / revenue / satisfaction (no cost, no loan-shark,
  // no budget update). The wrapper handles all of those once at
  // the monthly level below.
  //
  // Demand is scaled by `dayMult / days` per day, so summing across the
  // month gives ≈ pre-P2 round-level demand. Without this scaling, monthly
  // customer count and revenue would be ~30x pre-P2 and the existing
  // economy (auction bonuses, sous chef costs, starting budget) would be
  // wildly mis-calibrated.
  //
  // returningCustomersPending: customer-allocation seeds each team's
  // returning pool BEFORE the competitive split, and the daily inner
  // runSimulation runs that seeding 30x. Without correction a team entering
  // the round with returning=100 would contribute 30*100=3000 returning
  // customers to the monthly demand pool — multi-round games compound this
  // 30x per round and budgets explode.
  //
  // Fix: apply the full returning pool on day 0 only, zero on other days.
  // This keeps the month-total consistent with pre-P2 semantics while
  // avoiding the per-day integer-rounding loss that scaling by 1/days
  // would produce for small returning counts.
  const playersDay0 = players;
  const playersOtherDays = players.map((p) => ({
    ...p,
    returningCustomersPending: 0,
  }));

  const dailyResultsByPlayer = new Map();
  for (const p of players) {
    dailyResultsByPlayer.set(p.playerId, []);
  }

  for (let day = 0; day < days; day += 1) {
    const dayMult = demandMultiplierForDay(gameId, round, day, cfg);
    const dayScale = dayMult / days;
    const dayPrefs = dayPreferences(roundPreferences, dayScale);
    const dayPlayers = day === 0 ? playersDay0 : playersOtherDays;
    const dayResults = runSimulation(dayPlayers, dayPrefs, cfg, {
      gameId, round, day, skipCostAccounting: true,
    });
    for (const r of dayResults) {
      dailyResultsByPlayer.get(r.playerId).push({ day, ...r });
    }
  }

  // Build monthly aggregates per player.
  const monthlyResults = [];
  for (const p of players) {
    const daily = dailyResultsByPlayer.get(p.playerId) || [];

    const sum = (k) => daily.reduce((s, d) => s + (Number(d[k]) || 0), 0);
    const avg = (k) => (daily.length ? sum(k) / daily.length : 0);

    // Monthly aggregate gross revenue = sum of daily gross revenues.
    // (revenueGross from runSimulation includes per-day product revenue +
    // base + sous + sat + numProducts coefficients + ad bonus + noise. The
    // skipCostAccounting flag does NOT change revenueGross — it just zeros
    // out cost/loan-shark/budget.)
    const revenueGross = sum('revenueGross');
    const customerCount = sum('customerCount');
    const aggregateSatisfactionPct = avg('aggregateSatisfactionPct');
    const last = daily[daily.length - 1] || {};

    // Aggregate per-product customer counts across days. last.perProductCustomers
    // is day-29 only; using it as the round's per-product breakdown would
    // show ~1/30 of the actual monthly customers per product on the Results
    // screen breakdown table.
    const monthlyPerProductCustomers = {};
    for (const d of daily) {
      const ppc = d.perProductCustomers || {};
      for (const [product, count] of Object.entries(ppc)) {
        monthlyPerProductCustomers[product] =
          (monthlyPerProductCustomers[product] || 0) + (Number(count) || 0);
      }
    }

    // ---- Aggregate per-product satisfaction + qty sold across the month ----
    // Per-product satisfaction: mean of daily satisfactionPct (skip nulls).
    // Per-product qty sold: sum of daily qtySold.
    // Per-product sellout: true if ANY day sold out for that product.
    const productKeys = new Set();
    for (const d of daily) {
      for (const k of Object.keys(d.perProductSatisfaction || {})) productKeys.add(k);
    }
    const monthlyPerProductSatisfaction = {};
    const monthlyPerProductSold = {};
    const monthlySelloutFlags = {};
    for (const product of productKeys) {
      let satSum = 0;
      let satN = 0;
      let qtySold = 0;
      let qtyStocked = 0;
      let sellout = false;
      let lastTier = null;
      let lastFillRate = null;
      for (const d of daily) {
        const ps = (d.perProductSatisfaction || {})[product];
        if (!ps) continue;
        if (typeof ps.satisfactionPct === 'number') { satSum += ps.satisfactionPct; satN += 1; }
        qtySold += Number(ps.qtySold) || 0;
        qtyStocked += Number(ps.qtyStocked) || 0;
        if (ps.sellout) sellout = true;
        if (ps.tier) lastTier = ps.tier;
        if (typeof ps.fillRate === 'number') lastFillRate = ps.fillRate;
      }
      monthlyPerProductSatisfaction[product] = {
        satisfactionPct: satN ? satSum / satN : null,
        qtySold,
        qtyStocked,
        sellout,
        tier: lastTier,
        fillRate: lastFillRate,
      };
      monthlyPerProductSold[product] = qtySold;
      monthlySelloutFlags[product] = sellout;
    }

    // ---- Compute MONTHLY cost / loan-shark / budget ONCE ----
    const decision = (p && p.decision) || {};
    const sousChefCount = Number.isFinite(decision.sousChefCount)
      ? decision.sousChefCount
      : Number(p.sousChefCount) || 0;
    const auctionResults = (p && p.auctionResults) || {};
    const adBidPaid = _num(auctionResults.adBidPaid);
    const chefBidPaid = _num(auctionResults.chefBidPaid);

    const costDecision = {
      perProductQtyStocked: decision.quantities || {},
      sousChefCount,
    };
    const costAuction = {
      adAuctionWinningBid: adBidPaid,
      chefAuctionWinningBid: chefBidPaid,
    };
    const roundCosts = calculateRoundCosts(costDecision, costAuction, cfg);
    let totalSpent = roundCosts.totalSpent;

    // ---- Maintenance staff cost ----
    const maintenanceStaffCount = (decision.staffCounts && Number(decision.staffCounts.maintenanceGuys)) || 0;
    const maintenanceCost = Math.max(0, maintenanceStaffCount) * ((cfg && cfg.MAINTENANCE_STAFF_COST) || 20);
    totalSpent += maintenanceCost;

    // ---- Equipment upgrade processing ----
    const upgradeRequested = !!decision.equipmentUpgradePurchased;
    const _eqGradeForRound = p.equipmentGrade || 'C';
    const _nextGrade = nextEquipmentGrade(_eqGradeForRound);
    const _upgradeCost = tierUpgradeCost(_eqGradeForRound);
    let nextRoundEquipmentGrade = _eqGradeForRound;
    let equipmentUpgradeApplied = false;
    const budgetCurrent = _num(p.budgetCurrent);
    if (upgradeRequested && _nextGrade && _upgradeCost && (budgetCurrent - totalSpent) >= _upgradeCost) {
      totalSpent += _upgradeCost;
      nextRoundEquipmentGrade = _nextGrade;
      equipmentUpgradeApplied = true;
    }

    // ---- Cleanliness drift (computed ONCE per round at the monthly level) ----
    // Each inner daily sim sees only ~monthlyCustomers/daysPerRound customers,
    // so day-29's cleanlinessScoreNext reflects only ~1/daysPerRound of the
    // spec drain. Apply the spec drift delta directly to the round-start score
    // using the FULL monthly customerCount — that is the round-end state.
    const _cleanlinessStart = Number.isFinite(Number(p.cleanlinessScore))
      ? Number(p.cleanlinessScore)
      : 75;
    const _cleanlinessDelta = cleanlinessDriftDelta(maintenanceStaffCount, customerCount / days);
    const cleanlinessScore = Math.round(
      Math.max(0, Math.min(100, _cleanlinessStart + _cleanlinessDelta))
    );
    const cleanlinessGrade = gradeFromScore(cleanlinessScore);

    const loanResult = calculateLoanShark(totalSpent, budgetCurrent, cfg);
    const amountBorrowed = loanResult.borrowed;
    const interestCharged = loanResult.interest;
    const loanSharkDeduction = loanResult.loanSharkDeduction;
    const revenueNet = revenueGross - loanSharkDeduction;
    const budgetAfter = Math.round(updateBudget(budgetCurrent, revenueNet, totalSpent));

    // Recompute returningCustomersEarned at the MONTHLY level. The function
    // is linear in customerCount, so taking last.returningCustomersEarned
    // (day-29 only) gives ~1/daysPerRound of the right value — and that
    // gets persisted as next round's returningCustomersPending, breaking
    // the entire round-to-round carryover loop.
    const returningCustomersEarned = computeReturningCustomersEarned(
      aggregateSatisfactionPct,
      customerCount,
      cfg,
    );

    // ---- Apportion loan-shark deduction across days by gross share ----
    // So sum(daily.revenueNet) === monthly.revenueNet, and per-day loan
    // figures sum back to the monthly figure. If revenueGross is zero,
    // every day's net = its gross (== 0).
    const denom = revenueGross !== 0 ? revenueGross : 1;
    const dailyApportioned = daily.map((d) => {
      const share = (d.revenueGross || 0) / denom;
      return {
        day: d.day,
        revenueGross: d.revenueGross,
        revenueNet: d.revenueGross - loanSharkDeduction * share,
        amountBorrowed: amountBorrowed * share,
        interestCharged: interestCharged * share,
        customerCount: d.customerCount,
        aggregateSatisfactionPct: d.aggregateSatisfactionPct,
        perProductCustomers: d.perProductCustomers,
        perProductSatisfaction: d.perProductSatisfaction,
        csvRow: d.csvRow,
      };
    });

    // ---- Build a proper MONTHLY csvRow using monthly aggregates ----
    // Previously this returned `last.csvRow`, which was day-29 with
    // skipCostAccounting=true → cost/loan-shark/customer/revenue columns
    // were broken in the professor CSV (csvRowRef.set in index.js reads
    // from r.csvRow). Recompute from monthly inputs so professor CSV
    // reflects the actual monthly outcome.
    const monthlyCsvRow = buildCsvRow({
      decision,
      specialtyChefs: p.specialtyChefs,
      perProductSatisfaction: monthlyPerProductSatisfaction,
      perProductSold: monthlyPerProductSold,
      selloutFlags: monthlySelloutFlags,
      customerCount,
      revenueGross,
      revenueNet,
      amountBorrowed,
      interestCharged,
      aggregateSatisfactionPct,
      productPrices: last.productPrices || {},
      playerId: p.playerId,
      displayName: p.displayName,
      bakeryName: p.bakeryName,
      round,
      // Equipment + cleanliness fields for professor CSV.
      equipmentGrade: nextRoundEquipmentGrade,
      cleanlinessGrade,
      cleanlinessScore,
      equipmentUpgradePurchased: equipmentUpgradeApplied,
    });

    monthlyResults.push({
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
      perProductCustomers: monthlyPerProductCustomers,
      aggregateSatisfactionPct,
      perProductSatisfaction: monthlyPerProductSatisfaction,
      returningCustomersEarned,
      selloutAnywhere: daily.some((d) => d.selloutAnywhere),
      adWon: last.adWon,
      adWins: last.adWins,
      adBidPaid: last.adBidPaid,
      chefsWon: last.chefsWon,
      chefBidPaid: last.chefBidPaid,
      csvRow: monthlyCsvRow,
      productPrices: last.productPrices,
      revenueBreakdown: last.revenueBreakdown,
      // Equipment + cleanliness state for this round's result.
      equipmentGrade: nextRoundEquipmentGrade,
      cleanlinessScore,
      cleanlinessGrade,
      equipmentUpgradeApplied,
      // Daily breakdown for CSV per-day rows.
      dailyResults: dailyApportioned,
    });
  }

  return monthlyResults;
}

module.exports = {
  runMonthlySimulation,
  demandMultiplierForDay,
};
