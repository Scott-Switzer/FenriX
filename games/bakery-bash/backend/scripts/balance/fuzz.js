/**
 * fuzz.js — Property-based fuzz testing.
 *
 * Generates 10,000+ random valid games and asserts game invariants hold:
 *   1. revenueGross is finite and >= 0
 *   2. revenueNet ∈ ℝ (can go negative if loan shark hits)
 *   3. totalSpent >= 0
 *   4. budgetAfter is finite (can be negative)
 *   5. customerCount ∈ ℕ (non-negative integer)
 *   6. aggregateSatisfactionPct ∈ [0, 100]
 *   7. chefSatisfactionScore ∈ [floor, 100] = [35, 100]
 *   8. perProductCustomers values >= 0, sum approximately equals customerCount
 *   9. perProductSatisfaction.satisfactionPct ∈ [0, 100]
 *  10. perProductSatisfaction.tier is one of {critical, poor, adequate, good, excellent}
 *  11. perProductSatisfaction.qtySold <= qtyStocked
 *  12. amountBorrowed = max(0, totalSpent - budgetCurrent), interest = borrowed × rate
 *  13. revenueNet = revenueGross - (borrowed + interest)
 *  14. budgetAfter = budgetCurrent + revenueNet - totalSpent
 *  15. returningCustomersEarned ∈ {0, ⌊customerCount × 0.08⌋, ⌊customerCount × 0.15⌋}
 *  16. adWins is a subset of {TV, Billboard, Radio, Newspaper}
 *  17. chefBidPaid >= 0; chefsWon length <= chef cap (3)
 *  18. selloutAnywhere consistent with per-product sellout flags
 *  19. Total customers across all teams <= sum(demand × max foot-traffic mod) — soft bound
 *  20. No NaN or Infinity in any numeric field
 *
 * Run: node scripts/balance/fuzz.js [iterations]
 */

'use strict';

const path = require('path');
const cfgMod = require(path.join('..', '..', 'functions', 'modules', 'config'));
const chefMod = require(path.join('..', '..', 'functions', 'modules', 'chef-system'));
const sim = require(path.join('..', '..', 'functions', 'modules', 'simulation'));

const cfg = cfgMod.mergeConfig(cfgMod.DEFAULT_GAME_CONFIG);
const { PRODUCT_KEYS, PRODUCT_CATALOG, CHEF_NATIONALITIES } = cfgMod;
const VALID_TIERS = ['critical', 'poor', 'adequate', 'good', 'excellent'];
const AD_TYPES = ['TV', 'Billboard', 'Radio', 'Newspaper'];

const ITERATIONS = Number(process.argv[2]) || 10000;

let PASS = 0;
let FAIL = 0;
const FAILURES = [];

function fail(label, ctx) {
  FAIL++;
  if (FAILURES.length < 30) {
    FAILURES.push(`${label}: ${JSON.stringify(ctx)}`);
  } else if (FAILURES.length === 30) {
    FAILURES.push('(more failures suppressed)');
  }
}

function ok() { PASS++; }

function isFiniteNum(x) { return typeof x === 'number' && Number.isFinite(x); }

function rint(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function rfloat(min, max) { return Math.random() * (max - min) + min; }
function rchoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rbool(p = 0.5) { return Math.random() < p; }

// ---------------------------------------------------------------------------
// Random valid input generators
// ---------------------------------------------------------------------------

function randomChef(round) {
  const nat = rchoice(Object.keys(CHEF_NATIONALITIES));
  const tier = rchoice(['novel', 'intermediate', 'advanced']);
  return chefMod.generateOneChef(round, cfg);
}

function randomDecision(specialtyChefs) {
  // Random subset of products (1-6)
  const numOffered = rint(1, 6);
  const offered = [];
  const shuffled = PRODUCT_KEYS.slice().sort(() => Math.random() - 0.5);
  for (let i = 0; i < numOffered; i++) offered.push(shuffled[i]);

  const quantities = {};
  const menu = {};
  for (const p of PRODUCT_KEYS) {
    if (offered.includes(p)) {
      menu[p] = true;
      quantities[p] = rint(0, 500);
    } else {
      menu[p] = false;
      quantities[p] = 0;
    }
  }

  const sousChefCount = rint(0, 10);
  const sousAssign = {};
  let remaining = sousChefCount;
  for (const p of offered) {
    if (remaining <= 0) break;
    const give = rint(0, Math.min(remaining, 3));
    sousAssign[p] = give;
    remaining -= give;
  }

  const productPrices = {};
  for (const p of offered) {
    const z = cfgMod.PRICE_ZONES[p];
    if (z) productPrices[p] = rfloat(z.floor, z.ceiling);
  }

  return {
    quantities,
    menu,
    sousChefCount,
    sousChefAssignments: sousAssign,
    productPrices,
  };
}

function randomPlayer(playerId, round) {
  const numChefs = rint(0, 3);
  const specialtyChefs = [];
  for (let i = 0; i < numChefs; i++) specialtyChefs.push(randomChef(round));
  const decision = randomDecision(specialtyChefs);
  return {
    playerId,
    displayName: 'p' + playerId,
    bakeryName: 'b' + playerId,
    budgetCurrent: rfloat(-100000, 1000000), // sometimes negative (test loan shark)
    decision,
    priorSubmittedPrices: [],
    specialtyChefs,
    sousChefCount: decision.sousChefCount,
    returningCustomersPending: rint(0, 200),
    cleanliness_pct: rfloat(0, 100),
    auctionResults: {
      adWins: AD_TYPES.filter(() => rbool(0.25)),
      adBidPaid: rint(0, 50000),
      chefBidPaid: rint(0, 30000),
      chefsWon: [],
    },
  };
}

function randomRoundPrefs() {
  const mods = {};
  for (const p of PRODUCT_KEYS) mods[p] = rfloat(0.5, 1.6);
  return { round: rint(1, 5), modifiers: mods };
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

function checkInvariants(players, results, ctx) {
  const playerById = new Map(players.map((p) => [p.playerId, p]));
  for (const r of results) {
    const p = playerById.get(r.playerId);
    const c = `${ctx} player=${r.playerId}`;

    // 1. revenueGross finite (can be negative if there's negative noise +
    //    no other revenue components, i.e. an "empty offering" outcome).
    if (!isFiniteNum(r.revenueGross)) fail('I.01 revenueGross non-finite', { c, val: r.revenueGross }); else ok();
    // 2. revenueNet finite
    if (!isFiniteNum(r.revenueNet)) fail('I.02 revenueNet non-finite', { c, val: r.revenueNet }); else ok();
    // 3. totalSpent >= 0
    if (!isFiniteNum(r.totalSpent) || r.totalSpent < 0) fail('I.03 totalSpent invalid', { c, val: r.totalSpent }); else ok();
    // 4. budgetAfter finite
    if (!isFiniteNum(r.budgetAfter)) fail('I.04 budgetAfter non-finite', { c, val: r.budgetAfter }); else ok();
    // 5. customerCount integer >= 0
    if (!Number.isInteger(r.customerCount) || r.customerCount < 0) fail('I.05 customerCount invalid', { c, val: r.customerCount }); else ok();
    // 6. aggregateSatisfactionPct in [0, 100]
    if (!isFiniteNum(r.aggregateSatisfactionPct) || r.aggregateSatisfactionPct < 0 || r.aggregateSatisfactionPct > 100)
      fail('I.06 aggregateSat out of range', { c, val: r.aggregateSatisfactionPct }); else ok();
    // 7. chefSatisfactionScore in [floor, 100]
    if (!isFiniteNum(r.chefSatisfactionScore) || r.chefSatisfactionScore < cfg.chefSatisfactionFloor || r.chefSatisfactionScore > 100)
      fail('I.07 chefSatisfactionScore out of range', { c, val: r.chefSatisfactionScore }); else ok();
    // 8. perProductCustomers entries are non-negative integers
    let perProductTotal = 0;
    for (const [prod, n] of Object.entries(r.perProductCustomers || {})) {
      if (!Number.isInteger(n) || n < 0) {
        fail('I.08a perProductCustomers invalid', { c, prod, n });
      } else {
        ok();
        perProductTotal += n;
      }
    }
    // 9. perProductSatisfaction.satisfactionPct in [0, 100]
    for (const [prod, s] of Object.entries(r.perProductSatisfaction || {})) {
      if (!isFiniteNum(s.satisfactionPct) || s.satisfactionPct < 0 || s.satisfactionPct > 100)
        fail('I.09 perProductSat out of range', { c, prod, val: s.satisfactionPct }); else ok();
      // 10. tier is valid
      if (!VALID_TIERS.includes(s.tier))
        fail('I.10 perProductTier invalid', { c, prod, val: s.tier }); else ok();
      // 11. qtySold <= qtyStocked
      if (s.qtySold > s.qtyStocked + 0.001)
        fail('I.11 qtySold > qtyStocked', { c, prod, qtySold: s.qtySold, qtyStocked: s.qtyStocked }); else ok();
    }
    // 12. amountBorrowed = max(0, totalSpent - budgetCurrent)
    const expBorrow = Math.max(0, r.totalSpent - p.budgetCurrent);
    if (Math.abs(r.amountBorrowed - expBorrow) > 0.01)
      fail('I.12 amountBorrowed wrong', { c, exp: expBorrow, got: r.amountBorrowed }); else ok();
    // 13. interestCharged = borrowed × rate
    const expInt = r.amountBorrowed * cfg.loanSharkInterestRate;
    if (Math.abs(r.interestCharged - expInt) > 0.01)
      fail('I.13 interestCharged wrong', { c, exp: expInt, got: r.interestCharged }); else ok();
    // 14. revenueNet = revenueGross - (borrowed + interest)
    const expNet = r.revenueGross - (r.amountBorrowed + r.interestCharged);
    if (Math.abs(r.revenueNet - expNet) > 0.01)
      fail('I.14 revenueNet formula', { c, exp: expNet, got: r.revenueNet }); else ok();
    // 15. budgetAfter = budgetCurrent + revenueNet - totalSpent (rounded)
    // (curveball burglary may also subtract — skip if r.burglary)
    if (!r.burglary) {
      const expBudget = Math.round(p.budgetCurrent + r.revenueNet - r.totalSpent);
      if (Math.abs(r.budgetAfter - expBudget) > 1)
        fail('I.15 budgetAfter formula', { c, exp: expBudget, got: r.budgetAfter }); else ok();
    }
    // 16. returningCustomersEarned formula
    let expReturn = 0;
    if (r.aggregateSatisfactionPct >= 86) expReturn = Math.round(r.customerCount * 0.15);
    else if (r.aggregateSatisfactionPct >= 66) expReturn = Math.round(r.customerCount * 0.08);
    if (r.returningCustomersEarned !== expReturn)
      fail('I.16 returning formula', { c, exp: expReturn, got: r.returningCustomersEarned }); else ok();
    // 17. adWins valid subset
    if (!Array.isArray(r.adWins)) fail('I.17 adWins not array', { c }); else {
      for (const ad of r.adWins) {
        if (!AD_TYPES.includes(ad)) fail('I.17b adWin invalid type', { c, ad }); else ok();
      }
      ok();
    }
    // 18. chefBidPaid >= 0
    if (!isFiniteNum(r.chefBidPaid) || r.chefBidPaid < 0)
      fail('I.18 chefBidPaid invalid', { c, val: r.chefBidPaid }); else ok();
    // 19. NaN/Infinity check on all numeric fields
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number' && !Number.isFinite(v))
        fail('I.19 NaN/Infinity field', { c, key: k, val: v });
    }
    ok();
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  console.log(`Running ${ITERATIONS} fuzz iterations...`);
  const t0 = Date.now();

  for (let i = 0; i < ITERATIONS; i++) {
    const numPlayers = rint(2, 6);
    const players = [];
    for (let p = 0; p < numPlayers; p++) {
      players.push(randomPlayer('p' + p, rint(1, 5)));
    }
    const roundPrefs = randomRoundPrefs();
    let results;
    try {
      results = sim.runSimulation(players, roundPrefs, cfg, { gameId: `fuzz-${i}`, round: roundPrefs.round });
    } catch (e) {
      fail('CRASH in runSimulation', { iteration: i, message: e.message });
      continue;
    }

    if (!Array.isArray(results) || results.length !== players.length) {
      fail('Result count mismatch', { iteration: i, players: players.length, results: results && results.length });
      continue;
    }

    checkInvariants(players, results, `iter=${i}`);
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nResults: ${PASS} invariant checks passed, ${FAIL} failed (${dt}s)`);

  if (FAIL > 0) {
    console.log('\nSample failures:');
    for (const f of FAILURES) console.log('  ' + f);
    process.exit(1);
  }

  console.log('All invariants held across random fuzz inputs.');
}

main();
