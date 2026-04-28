/**
 * multi-day-simulation.js
 *
 * Wraps the pure runSimulation() in a per-day loop. A round represents one
 * month; this module runs daysPerRound (default 30) sub-simulations, each
 * with an independent demand-variability multiplier and noise seed. Returns
 * monthly aggregates with the daily rows attached for CSV export.
 *
 * Cost / loan-shark / burglary / budget update happen ONCE per month at the
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
 * Curveballs (burglary roll, burgled-day index) still use Math.random()
 * to match the pre-PR behaviour of simulation.js — see runSimulation.
 *
 * Pure: no Firebase deps.
 */

const config = require('./config');
const { runSimulation, computeReturningCustomersEarned } = require('./simulation');
const { calculateRoundCosts } = require('./revenue');
const { calculateLoanShark, updateBudget } = require('./loan-shark');
const { buildCsvRow } = require('./csv-export');

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

function runMonthlySimulation(players, roundPreferences, cfg = config, { gameId = 'game', round = 0 } = {}) {
  const days = (cfg.MULTI_DAY && cfg.MULTI_DAY.daysPerRound) || 30;

  // Run N daily sims. skipCostAccounting=true means each daily call only
  // produces customer / revenue / satisfaction (no cost, no loan-shark, no
  // burglary, no budget update). The wrapper handles all of those once at
  // the monthly level below.
  //
  // Demand is scaled by `dayMult / days` per day, so summing across the
  // month gives ≈ pre-P2 round-level demand. Without this scaling, monthly
  // customer count and revenue would be ~30x pre-P2 and the existing
  // economy (auction bonuses, sous chef costs, starting budget) would be
  // wildly mis-calibrated.
  const dailyResultsByPlayer = new Map();
  for (const p of players) {
    dailyResultsByPlayer.set(p.playerId, []);
  }

  for (let day = 0; day < days; day += 1) {
    const dayMult = demandMultiplierForDay(gameId, round, day, cfg);
    const dayScale = dayMult / days;
    const dayPrefs = dayPreferences(roundPreferences, dayScale);
    const dayResults = runSimulation(players, dayPrefs, cfg, {
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
    // chefSatisfactionScore is purely decision-derived (sousChefCount via
    // calculateChefSatisfactionScore in chef-system.js) — it does NOT depend
    // on demand or customer count, so day-0 ≡ day-29. Picking daily[0] is
    // equivalent to averaging here.
    const chefSatisfactionScore = daily.length ? daily[0].chefSatisfactionScore : 0;
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
    const totalSpent = roundCosts.totalSpent;

    const budgetCurrent = _num(p.budgetCurrent);
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

    // ---- Roll burglary ONCE per month ----
    const burglaryThreshold = (cfg && cfg.curveballs && cfg.curveballs.burglaryThreshold) || 40;
    const burglaryChance = (cfg && cfg.curveballs && cfg.curveballs.burglaryChance) || 0.25;
    const burglaryAmount = (cfg && cfg.curveballs && cfg.curveballs.burglaryAmount) || 10000;
    let burglary = false;
    let actualBurglaryAmount = 0;
    let budgetAfterBurglary = budgetAfter;
    if (typeof p.cleanliness_pct === 'number'
        && p.cleanliness_pct < burglaryThreshold
        && Math.random() < burglaryChance) {
      burglary = true;
      actualBurglaryAmount = burglaryAmount;
      budgetAfterBurglary = Math.max(0, budgetAfter - burglaryAmount);
    }
    // Pick a random day in the month for the burglary so it doesn't
    // always hit mid-month. Math.random matches the burglary roll above.
    const burgledDayIndex = (burglary && daily.length > 0)
      ? Math.floor(Math.random() * daily.length)
      : -1;
    if (burglary && daily[burgledDayIndex]) {
      daily[burgledDayIndex].burglary = true;
      daily[burgledDayIndex].burglaryAmount = actualBurglaryAmount;
    }

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
        burglary: d.burglary || false,
        burglaryAmount: d.burglaryAmount || 0,
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
      chefSatisfactionScore,
      productPrices: last.productPrices || {},
      playerId: p.playerId,
      displayName: p.displayName,
      bakeryName: p.bakeryName,
      round,
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
      budgetAfter: budgetAfterBurglary,
      customerCount,
      perProductCustomers: monthlyPerProductCustomers,
      aggregateSatisfactionPct,
      chefSatisfactionScore,
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
      burglary,
      burglaryAmount: actualBurglaryAmount,
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
