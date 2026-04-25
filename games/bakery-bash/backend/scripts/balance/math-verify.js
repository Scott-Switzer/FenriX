/**
 * math-verify.js — Exhaustive math verification.
 *
 * Tests game-logic correctness across many scenarios. Hand-computes the
 * expected value for each formula, runs the simulation, and asserts they
 * match (within floating-point or noise tolerances).
 *
 * Sections:
 *   A. Chef output math (every chef tier × every product, w/ and w/o sous)
 *   B. Sous chef hire cost (escalating curve)
 *   C. Chef satisfaction (cohesion) curve
 *   D. Fill rate → satisfaction tier mapping (boundary + interior values)
 *   E. Foot-traffic modifier (each component independently + summed)
 *   F. Customer allocation (3-team symmetric and asymmetric)
 *   G. Revenue formula (each term traced)
 *   H. Loan shark math (under-budget, exact-budget, over-budget)
 *   I. Ad winner bonus gate (0 stock vs >0 stock)
 *   J. Sellout cap (qtySold == qtyStocked)
 *   K. End-to-end round profit reconciliation
 *
 * Run:  node scripts/balance/math-verify.js
 * Exit code 0 if all pass, 1 if any fail.
 */

'use strict';

const path = require('path');
const cfgMod = require(path.join('..', '..', 'functions', 'modules', 'config'));
const chefMod = require(path.join('..', '..', 'functions', 'modules', 'chef-system'));
const satMod = require(path.join('..', '..', 'functions', 'modules', 'satisfaction'));
const allocMod = require(path.join('..', '..', 'functions', 'modules', 'customer-allocation'));
const revMod = require(path.join('..', '..', 'functions', 'modules', 'revenue'));
const loanMod = require(path.join('..', '..', 'functions', 'modules', 'loan-shark'));
const sim = require(path.join('..', '..', 'functions', 'modules', 'simulation'));

const cfg = cfgMod.mergeConfig(cfgMod.DEFAULT_GAME_CONFIG);

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------

let PASS = 0;
let FAIL = 0;
const FAILURES = [];

function approx(a, b, tol = 0.001) {
  return Math.abs(a - b) <= tol;
}

function check(label, actual, expected, tol = 0.001) {
  if (approx(actual, expected, tol)) {
    PASS++;
    return true;
  }
  FAIL++;
  FAILURES.push(`${label}: expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`);
  return false;
}

function checkEq(label, actual, expected) {
  if (actual === expected) {
    PASS++;
    return true;
  }
  FAIL++;
  FAILURES.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return false;
}

function checkBool(label, condition) {
  if (condition) {
    PASS++;
    return true;
  }
  FAIL++;
  FAILURES.push(`${label}: condition false`);
  return false;
}

// ---------------------------------------------------------------------------
// A. Chef output math
// ---------------------------------------------------------------------------

console.log('=== A. Chef output math ===');

const BASE_CHEF_RATE = 30;

// Test base chef (no specialty): always returns 30
check('A.1 base chef on coffee', chefMod.getChefOutputForProduct({ skillTier: 'base' }, 'coffee'), 30);
check('A.2 base chef on matcha', chefMod.getChefOutputForProduct({ skillTier: 'base' }, 'matcha'), 30);

// Test each tier × specialty / non-specialty
const tiers = ['novel', 'intermediate', 'advanced'];
const tierExp = cfgMod.CHEF_MULTIPLIERS;
for (const tier of tiers) {
  const chef = { skillTier: tier, specialties: ['croissant', 'coffee'] };
  // Specialty product
  check(`A.3 ${tier} on specialty croissant`,
    chefMod.getChefOutputForProduct(chef, 'croissant'),
    BASE_CHEF_RATE * tierExp[tier].specialty);
  // Non-specialty product
  check(`A.4 ${tier} on non-specialty bagel`,
    chefMod.getChefOutputForProduct(chef, 'bagel'),
    BASE_CHEF_RATE * tierExp[tier].nonSpecialty);
}

// calculateTotalProductOutput: base + chef + sous
const advancedFrenchChef = { skillTier: 'advanced', specialties: ['croissant', 'coffee'] };

// 0 sous, 0 chefs, base only
check('A.5 base only, no chef',
  chefMod.calculateTotalProductOutput('croissant', [], {}),
  30);

// With advanced French chef on croissant (specialty), 0 sous
check('A.6 advanced french chef on croissant',
  chefMod.calculateTotalProductOutput('croissant', [advancedFrenchChef], {}),
  30 + 30 * tierExp.advanced.specialty);

// With chef + 2 sous on croissant
// sous contribution = 2 × 0.5 × headChefOutput = 2 × 0.5 × (30 × 3.0) = 90
check('A.7 chef + 2 sous on croissant',
  chefMod.calculateTotalProductOutput('croissant', [advancedFrenchChef], { croissant: 2 }),
  30 + 30 * tierExp.advanced.specialty + 2 * 0.5 * 30 * tierExp.advanced.specialty);

// Sous on bagel (chef has no specialty for bagel): sous ONLY amplifies
// specialty chefs. Since no chef on the team specializes in bagel, the head
// chef output for sous purposes falls back to the base 30. So:
//   total = 30 (base) + 30 × 1.8 (advanced French non-specialty on bagel)
//         + 1 × 0.5 × 30 (sous × 0.5 × base fallback)
//         = 30 + 54 + 15 = 99
check('A.8 chef + 1 sous on bagel (non-specialty)',
  chefMod.calculateTotalProductOutput('bagel', [advancedFrenchChef], { bagel: 1 }),
  30 + 30 * tierExp.advanced.nonSpecialty + 1 * 0.5 * 30);

// Two chefs on overlapping specialty
const novelFrenchChef = { skillTier: 'novel', specialties: ['croissant', 'coffee'] };
check('A.9 advanced + novel french on croissant',
  chefMod.calculateTotalProductOutput('croissant', [advancedFrenchChef, novelFrenchChef], {}),
  30 + 30 * tierExp.advanced.specialty + 30 * tierExp.novel.specialty);

// ---------------------------------------------------------------------------
// B. Sous chef hire cost
// ---------------------------------------------------------------------------

console.log('=== B. Sous chef hire cost ===');

const baseCost = cfg.sousChefBaseCost;
// Multipliers: 1.0, 1.5, 2.25, 3.0, 3.75, 4.5, ...
const expectedMults = [1.0, 1.5, 2.25, 3.0, 3.75, 4.5, 5.25, 6.0];

for (let i = 0; i < 8; i++) {
  check(`B.${i + 1} ${i + 1}-th sous chef cost`,
    chefMod.getSousChefCost(i, cfg),
    expectedMults[i] * baseCost);
}

// Total for N sous chefs = sum of first N multipliers × baseCost
let runningTotal = 0;
for (let i = 0; i < expectedMults.length; i++) {
  runningTotal += expectedMults[i] * baseCost;
  check(`B.total${i + 1} total cost for ${i + 1} sous chefs`,
    chefMod.getTotalSousChefHireCost(i + 1, cfg),
    runningTotal);
}

// ---------------------------------------------------------------------------
// C. Chef satisfaction (cohesion) curve
// ---------------------------------------------------------------------------

console.log('=== C. Chef satisfaction (cohesion) curve ===');

const threshold = cfg.chefSatisfactionThreshold; // 4
const decay = cfg.chefSatisfactionDecay;           // 10
const floor = cfg.chefSatisfactionFloor;           // 35

// At or below threshold: always 100
for (let n = 0; n <= threshold; n++) {
  check(`C.${n} cohesion @ ${n} sous`,
    chefMod.calculateChefSatisfactionScore(n, cfg),
    100);
}

// Above threshold: 100 - (n - threshold) × decay
for (let n = threshold + 1; n <= 9; n++) {
  const expected = Math.max(floor, 100 - (n - threshold) * decay);
  check(`C.${n} cohesion @ ${n} sous`,
    chefMod.calculateChefSatisfactionScore(n, cfg),
    expected);
}

// At very high count, floored at 35
check('C.20 cohesion @ 20 sous (floored)',
  chefMod.calculateChefSatisfactionScore(20, cfg),
  floor);

// ---------------------------------------------------------------------------
// D. Fill rate → satisfaction tier mapping
// ---------------------------------------------------------------------------

console.log('=== D. Fill rate → satisfaction ===');

// Boundary values
check('D.1 fillRate 0.0 → 0 (critical)', satMod.fillRateToSatisfactionPct(0.0), 0);
check('D.2 fillRate 0.5 (poor band start) → 21', satMod.fillRateToSatisfactionPct(0.5), 21);
check('D.3 fillRate 0.7 (adequate band start) → 46', satMod.fillRateToSatisfactionPct(0.7), 46);
check('D.4 fillRate 0.85 (good band start) → 66', satMod.fillRateToSatisfactionPct(0.85), 66);
check('D.5 fillRate 1.0 (excellent band start) → 86', satMod.fillRateToSatisfactionPct(1.0), 86);

// Interpolation: poor band [0.50, 0.70), midpoint 0.60 → halfway from 21 to 45
check('D.6 fillRate 0.6 (mid-poor) → 33',
  satMod.fillRateToSatisfactionPct(0.6),
  21 + 0.5 * (45 - 21));

// Good band [0.85, 1.00), midpoint 0.925 → halfway from 66 to 85
check('D.7 fillRate 0.925 (mid-good) → 75.5',
  satMod.fillRateToSatisfactionPct(0.925),
  66 + 0.5 * (85 - 66));

// Excellent band — at min (86) since position is 0 in infinite band
check('D.8 fillRate 2.0 (saturated excellent) → 86',
  satMod.fillRateToSatisfactionPct(2.0),
  86);

// ---------------------------------------------------------------------------
// E. Foot-traffic modifier components
// ---------------------------------------------------------------------------

console.log('=== E. Foot-traffic modifier ===');

// 1. Satisfaction modifier alone (no premium products, 0 products, 0 sous, no ads)
check('E.1 sat=50 → 0 modifier', satMod.getFootTrafficModifier(50, {}, 0, 0, [], cfg), 0);
check('E.2 sat=0 → -0.40', satMod.getFootTrafficModifier(0, {}, 0, 0, [], cfg), -0.40);
check('E.3 sat=100 → +0.40', satMod.getFootTrafficModifier(100, {}, 0, 0, [], cfg), 0.40);

// 2. Premium products (any product at excellent → +0.06 each)
const ppSat = {
  croissant: { satisfactionPct: 90 },  // excellent
  coffee:    { satisfactionPct: 90 },  // excellent
  cookie:    { satisfactionPct: 50 },  // not excellent
};
check('E.4 sat=50 + 2 excellent products → +0.12',
  satMod.getFootTrafficModifier(50, ppSat, 3, 0, [], cfg),
  0 + 0.12 + 0); // sat 0 + premium 0.12 + variety 0 (3 products)

// 3. Variety bonus
check('E.5 4 products → +0.05', satMod.getFootTrafficModifier(50, {}, 4, 0, [], cfg), 0.05);
check('E.6 5 products → +0.10', satMod.getFootTrafficModifier(50, {}, 5, 0, [], cfg), 0.10);
check('E.7 6 products → +0.15', satMod.getFootTrafficModifier(50, {}, 6, 0, [], cfg), 0.15);
check('E.8 3 products → 0', satMod.getFootTrafficModifier(50, {}, 3, 0, [], cfg), 0);

// 4. Sous chef bonus
check('E.9 1 sous → +0.05', satMod.getFootTrafficModifier(50, {}, 0, 1, [], cfg), 0.05);
check('E.10 4 sous → +0.17', satMod.getFootTrafficModifier(50, {}, 0, 4, [], cfg), 0.17);
check('E.11 5+ sous → +0.17 (plateau)', satMod.getFootTrafficModifier(50, {}, 0, 8, [], cfg), 0.17);

// 5. Ad bonus
check('E.12 TV win → +0.15',  satMod.getFootTrafficModifier(50, {}, 0, 0, ['TV'], cfg), 0.15);
check('E.13 All 4 ads → capped at +0.30',
  satMod.getFootTrafficModifier(50, {}, 0, 0, ['TV', 'Billboard', 'Radio', 'Newspaper'], cfg),
  0.30);

// All combined: max possible foot-traffic mod
const allExcellent = {};
for (const p of ['coffee', 'croissant', 'bagel', 'cookie', 'sandwich', 'matcha']) {
  allExcellent[p] = { satisfactionPct: 100 };
}
const maxMod = satMod.getFootTrafficModifier(100, allExcellent, 6, 4, ['TV', 'Billboard'], cfg);
// sat 0.40 + premium 0.36 + variety 0.15 + sous 0.17 + ad 0.25 = 1.33
check('E.14 max combined modifier', maxMod, 0.40 + 0.36 + 0.15 + 0.17 + 0.25);

// ---------------------------------------------------------------------------
// F. Customer allocation (3-team symmetric)
// ---------------------------------------------------------------------------

console.log('=== F. Customer allocation ===');

const playerStates = [
  { playerId: 'p1', perProductSatisfaction: { croissant: { satisfactionPct: 80 } }, returningCustomers: 0,
    sousChefCount: 0, numProductsOffered: 1, footTrafficMultiplier: 1.0, aggregateSatisfactionPct: 80, offeredProducts: ['croissant'] },
  { playerId: 'p2', perProductSatisfaction: { croissant: { satisfactionPct: 80 } }, returningCustomers: 0,
    sousChefCount: 0, numProductsOffered: 1, footTrafficMultiplier: 1.0, aggregateSatisfactionPct: 80, offeredProducts: ['croissant'] },
  { playerId: 'p3', perProductSatisfaction: { croissant: { satisfactionPct: 80 } }, returningCustomers: 0,
    sousChefCount: 0, numProductsOffered: 1, footTrafficMultiplier: 1.0, aggregateSatisfactionPct: 80, offeredProducts: ['croissant'] },
];

const neutralRoundPrefs = { modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };

const alloc = allocMod.allocateAllCustomers(playerStates, neutralRoundPrefs, cfg);
const p1 = alloc.get('p1').totalCustomers;
const p2 = alloc.get('p2').totalCustomers;
const p3 = alloc.get('p3').totalCustomers;
// Symmetric: each gets ~80 (240 / 3 = 80)
check('F.1 symmetric split team 1', p1, 80, 1);
check('F.2 symmetric split team 2', p2, 80, 1);
check('F.3 symmetric split team 3', p3, 80, 1);
checkBool('F.4 all 3 sum ~= 240', Math.abs(p1 + p2 + p3 - 240) <= 2);

// Asymmetric: team 1 has higher sat
const asymStates = [
  { playerId: 'p1', perProductSatisfaction: { croissant: { satisfactionPct: 90 } }, returningCustomers: 0,
    sousChefCount: 0, numProductsOffered: 1, footTrafficMultiplier: 1.0, aggregateSatisfactionPct: 90, offeredProducts: ['croissant'] },
  { playerId: 'p2', perProductSatisfaction: { croissant: { satisfactionPct: 30 } }, returningCustomers: 0,
    sousChefCount: 0, numProductsOffered: 1, footTrafficMultiplier: 1.0, aggregateSatisfactionPct: 30, offeredProducts: ['croissant'] },
  { playerId: 'p3', perProductSatisfaction: { croissant: { satisfactionPct: 30 } }, returningCustomers: 0,
    sousChefCount: 0, numProductsOffered: 1, footTrafficMultiplier: 1.0, aggregateSatisfactionPct: 30, offeredProducts: ['croissant'] },
];

const alloc2 = allocMod.allocateAllCustomers(asymStates, neutralRoundPrefs, cfg);
const a1 = alloc2.get('p1').totalCustomers;
const a2 = alloc2.get('p2').totalCustomers;
const a3 = alloc2.get('p3').totalCustomers;
// p1 share = 90/(90+30+30) = 0.6 → 144 customers
// p2/p3 = 30/150 = 0.2 → 48 each
check('F.5 high-sat team gets 60% share', a1, 144, 1);
check('F.6 low-sat teams get 20% each (a)', a2, 48, 1);
check('F.7 low-sat teams get 20% each (b)', a3, 48, 1);

// ---------------------------------------------------------------------------
// G. Revenue formula
// ---------------------------------------------------------------------------

console.log('=== G. Revenue formula ===');

// All zero inputs
const r0 = revMod.computeGrossRevenue({
  sousChefCount: 0, aggregateSatisfactionPct: 0, adSpend: 0, numProducts: 0, totalProductRevenue: 0,
  noiseSeed: 'g.1',
}, cfg);
const c = cfg.revenueCoefficients;
// Expected: base + 0 + 0 + 0 + 0 + 0 + noise (deterministic)
const noise01 = r0 - c.base;
checkBool('G.1 all-zero revenue near base', Math.abs(noise01) <= (c.noiseMax + 1));

// All non-zero
const r1 = revMod.computeGrossRevenue({
  sousChefCount: 4, aggregateSatisfactionPct: 80, adSpend: 10000, numProducts: 4, totalProductRevenue: 5000,
  noiseSeed: 'g.2',
}, cfg);
const expected1 = c.base + c.sousChefCoeff * 4 + c.satisfactionCoeff * 80 +
                  c.adSpendCoeff * 10000 + c.numProductsCoeff * 4 + 5000;
const diff1 = r1 - expected1;
checkBool('G.2 full revenue formula matches (within noise)', Math.abs(diff1) <= (c.noiseMax + 1));

// adSpendCoeff is 0 — adSpend should NOT affect revenue (anti-arbitrage check)
const rA = revMod.computeGrossRevenue({
  sousChefCount: 0, aggregateSatisfactionPct: 0, adSpend: 0, numProducts: 0, totalProductRevenue: 0,
  noiseSeed: 'g.fixed',
}, cfg);
const rB = revMod.computeGrossRevenue({
  sousChefCount: 0, aggregateSatisfactionPct: 0, adSpend: 1000000, numProducts: 0, totalProductRevenue: 0,
  noiseSeed: 'g.fixed',
}, cfg);
check('G.3 ANTI-EXPLOIT: adSpend has no revenue effect (coeff=0)', rA, rB, 0.001);

// ---------------------------------------------------------------------------
// H. Loan shark
// ---------------------------------------------------------------------------

console.log('=== H. Loan shark ===');

// Under budget: no borrow
let l = loanMod.calculateLoanShark(50000, 100000, cfg);
check('H.1 under budget — no borrow', l.borrowed, 0);
check('H.2 under budget — no interest', l.interest, 0);
check('H.3 under budget — no deduction', l.loanSharkDeduction, 0);
checkBool('H.4 under budget — didBorrow=false', !l.didBorrow);

// Exact budget: no borrow
l = loanMod.calculateLoanShark(100000, 100000, cfg);
check('H.5 exact budget — no borrow', l.borrowed, 0);

// Over budget: borrow + 10% interest
l = loanMod.calculateLoanShark(150000, 100000, cfg);
check('H.6 over budget — borrowed = 50k', l.borrowed, 50000);
check('H.7 over budget — interest = 5k (10%)', l.interest, 5000);
check('H.8 over budget — total deduction = 55k', l.loanSharkDeduction, 55000);
checkBool('H.9 over budget — didBorrow=true', l.didBorrow);

// updateBudget
const newBudget = loanMod.updateBudget(100000, 80000, 150000); // budget + revenueNet - totalSpent
check('H.10 updateBudget', newBudget, 100000 + 80000 - 150000);

// ---------------------------------------------------------------------------
// I. Ad winner bonus gate (anti-exploit)
// ---------------------------------------------------------------------------

console.log('=== I. Ad winner bonus gate ===');

const baseDecision = {
  quantities: { croissant: 0, cookie: 0, bagel: 0, coffee: 0 },
  menu:       { croissant: true, cookie: true, bagel: true, coffee: true },
  sousChefCount: 0,
};

const noStockPlayer = {
  playerId: 'p-nostock', displayName: 'NoStock', bakeryName: 'NS',
  budgetCurrent: 500000,
  decision: baseDecision,
  priorSubmittedPrices: [],
  specialtyChefs: [],
  sousChefCount: 0,
  returningCustomersPending: 0,
  cleanliness_pct: 100,
  auctionResults: { adWins: ['TV'], adBidPaid: 0, chefBidPaid: 0, chefsWon: [] },
};

const stockedDecision = {
  quantities: { croissant: 100, cookie: 100, bagel: 100, coffee: 100 },
  menu:       { croissant: true, cookie: true, bagel: true, coffee: true },
  sousChefCount: 0,
};
const stockedPlayer = {
  ...noStockPlayer,
  playerId: 'p-stock', displayName: 'Stock', bakeryName: 'Stock',
  decision: stockedDecision,
};

const stockResults = sim.runSimulation([noStockPlayer, stockedPlayer], neutralRoundPrefs, cfg, { gameId: 'gate', round: 1 });
const noStockGross = stockResults.find(r => r.playerId === 'p-nostock').revenueGross;
const stockGross   = stockResults.find(r => r.playerId === 'p-stock').revenueGross;

checkBool('I.1 ANTI-EXPLOIT: no-stock team did NOT receive TV bonus',
  noStockGross < cfg.adBonuses.TV);
checkBool('I.2 stocked team received TV bonus',
  stockGross >= cfg.adBonuses.TV - 100);
checkBool('I.3 stock-vs-no-stock delta > TV bonus minus noise',
  Math.abs((stockGross - noStockGross)) >= cfg.adBonuses.TV - 200);

// ---------------------------------------------------------------------------
// J. Sellout cap
// ---------------------------------------------------------------------------

console.log('=== J. Sellout cap ===');

// To get sellout cap to actually FIRE (i.e., bring sat down from > 45),
// pre-cap satisfaction must be > 45. That means fillRate ≥ 0.7 (adequate
// tier or higher). With 1 advanced French chef (90 units/day on croissant)
// + 4 sous all on croissant (4 × 0.5 × 90 = 180), total output = 30 + 90 +
// 180 = 300. Stock 200 < output → effective output capped at qtyStocked
// (200) in pass 1. fillRate = 200/240 = 0.833 → adequate tier (~64). Then
// sellout fires (allocated 240 > stocked 200) → cap to 45.
const selloutPlayer = {
  playerId: 'p-sellout', displayName: 'Sellout', bakeryName: 'SO',
  budgetCurrent: 500000,
  decision: {
    quantities: { croissant: 200 },
    menu:       { croissant: true },
    sousChefCount: 4,
    sousChefAssignments: { croissant: 4 },
  },
  priorSubmittedPrices: [],
  specialtyChefs: [advancedFrenchChef],
  sousChefCount: 4,
  returningCustomersPending: 0,
  cleanliness_pct: 100,
  auctionResults: { adWins: [], adBidPaid: 0, chefBidPaid: 0, chefsWon: [] },
};

// To trigger sellout, need allocated customers > qtyStocked.
// With only 1 player offering croissant, they get all 240 demand → 240 > 200 → sellout.
const selloutResult = sim.runSimulation([selloutPlayer], neutralRoundPrefs, cfg, { gameId: 'sellout', round: 1 });
const sr = selloutResult[0];
checkBool('J.1 sellout flag set', sr.perProductSatisfaction.croissant.sellout === true);
check('J.2 sellout sat capped at 45',
  sr.perProductSatisfaction.croissant.satisfactionPct, 45);
checkEq('J.3 sellout tier = poor (since sat is at 45 = poor band high end)',
  sr.perProductSatisfaction.croissant.tier, 'poor');
check('J.4 qtySold = qtyStocked when allocated > stocked',
  sr.perProductSatisfaction.croissant.qtySold,
  sr.perProductSatisfaction.croissant.qtyStocked);

// Also test the OTHER case: sellout with sat already low — sat stays low,
// tier stays critical (the cap doesn't FORCE poor any more after fix).
const lowSatSellout = {
  ...selloutPlayer,
  playerId: 'p-low-sellout',
  decision: {
    quantities: { croissant: 50 },
    menu:       { croissant: true },
    sousChefCount: 0,
    sousChefAssignments: {},
  },
  specialtyChefs: [],
  sousChefCount: 0,
};
const lowResult = sim.runSimulation([lowSatSellout], neutralRoundPrefs, cfg, { gameId: 'low-sellout', round: 1 });
const lr = lowResult[0];
checkBool('J.5 low-sat sellout flag set', lr.perProductSatisfaction.croissant.sellout === true);
checkBool('J.6 low-sat sellout sat NOT raised by cap (was below 45)',
  lr.perProductSatisfaction.croissant.satisfactionPct < 45);
checkEq('J.7 low-sat sellout tier reflects actual sat',
  lr.perProductSatisfaction.croissant.tier, 'critical');

// ---------------------------------------------------------------------------
// K. End-to-end round profit reconciliation
// ---------------------------------------------------------------------------

console.log('=== K. End-to-end profit reconciliation ===');

// Build a known scenario, run simulation, hand-compute every component.
const reconPlayer = {
  playerId: 'p-recon',
  displayName: 'Recon', bakeryName: 'RB',
  budgetCurrent: 500000,
  decision: {
    quantities: { coffee: 100, croissant: 100, bagel: 80, cookie: 80 },
    menu:       { coffee: true, croissant: true, bagel: true, cookie: true },
    sousChefCount: 4,
    sousChefAssignments: { coffee: 1, croissant: 1, bagel: 1, cookie: 1 },
    productPrices: { coffee: 4, croissant: 4.75, bagel: 4.50, cookie: 4 },
  },
  priorSubmittedPrices: [],
  specialtyChefs: [advancedFrenchChef],
  sousChefCount: 4,
  returningCustomersPending: 0,
  cleanliness_pct: 100,
  auctionResults: { adWins: ['TV'], adBidPaid: 5000, chefBidPaid: 2750, chefsWon: [] },
};

const reconResult = sim.runSimulation([reconPlayer], neutralRoundPrefs, cfg, { gameId: 'recon', round: 1 });
const rr = reconResult[0];

// Hand-compute total spent
const stockUnits = 100 + 100 + 80 + 80;
const handStockCost = stockUnits * cfg.unitCostPerProduct;
const handSousCost = chefMod.getTotalSousChefHireCost(4, cfg);
const handAdCost = 5000;
const handChefCost = 2750;
const handTotalSpent = handStockCost + handSousCost + handAdCost + handChefCost;
check('K.1 totalSpent matches hand-compute', rr.totalSpent, handTotalSpent);

// Budget after = budget + revenueNet - totalSpent
const handBudgetAfter = Math.round(500000 + rr.revenueNet - handTotalSpent);
check('K.2 budgetAfter = budget + revenueNet - totalSpent', rr.budgetAfter, handBudgetAfter, 1);

// Revenue formula reconciliation (within noise)
const handBaseRev = c.base + c.sousChefCoeff * 4 + c.satisfactionCoeff * rr.aggregateSatisfactionPct +
                   c.adSpendCoeff * 5000 + c.numProductsCoeff * 4;
let handProductRev = 0;
for (const breakdown of Object.values(rr.revenueBreakdown || {})) {
  handProductRev += breakdown.revenue;
}
const handAdWinnerBonus = cfg.adBonuses.TV;  // stocked, so eligible
const handGrossExpected = handBaseRev + handProductRev + handAdWinnerBonus;
const grossDiff = rr.revenueGross - handGrossExpected;
checkBool('K.3 revenueGross matches hand-compute (within noise)',
  Math.abs(grossDiff) <= (c.noiseMax + 1));

// Returning customers earned: depends on aggregateSatisfactionPct
let expectedReturning = 0;
if (rr.aggregateSatisfactionPct >= 86) expectedReturning = Math.round(rr.customerCount * 0.15);
else if (rr.aggregateSatisfactionPct >= 66) expectedReturning = Math.round(rr.customerCount * 0.08);
check('K.4 returningCustomersEarned formula', rr.returningCustomersEarned, expectedReturning);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n=== RESULTS: ${PASS} passed, ${FAIL} failed ===`);

if (FAIL > 0) {
  console.log('\nFailures:');
  for (const f of FAILURES) console.log('  ' + f);
  process.exit(1);
}

console.log('All math verifications passed.');
process.exit(0);
