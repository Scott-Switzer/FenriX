/**
 * trace.js — End-to-end math trace of one round, verifying numbers by hand.
 *
 * Sets up a single-team scenario (no competition), submits a known decision,
 * and prints intermediate values from each pass of the simulation against
 * what should be computed by hand from the formulas.
 */

'use strict';

const path = require('path');

const config = require(path.join('..', '..', 'functions', 'modules', 'config'));
const chefSystem = require(path.join('..', '..', 'functions', 'modules', 'chef-system'));
const sim = require(path.join('..', '..', 'functions', 'modules', 'simulation'));
const satisfaction = require(path.join('..', '..', 'functions', 'modules', 'satisfaction'));
const revenue = require(path.join('..', '..', 'functions', 'modules', 'revenue'));

const { PRODUCT_CATALOG, PRODUCT_KEYS, DEFAULT_GAME_CONFIG, mergeConfig } = config;
const cfg = mergeConfig(DEFAULT_GAME_CONFIG);

console.log('=== Configuration snapshot ===');
console.log('startingBudget:    $' + cfg.startingBudget.toLocaleString());
console.log('sousChefBaseCost:  $' + cfg.sousChefBaseCost.toLocaleString());
console.log('revenueCoeffs:     ', cfg.revenueCoefficients);
console.log('adBonuses:         ', cfg.adBonuses);
console.log('adFootTraffic:     ', cfg.adFootTrafficBonuses);
console.log('chefSatisfaction:  threshold=' + cfg.chefSatisfactionThreshold + ', decay=' + cfg.chefSatisfactionDecay + ', floor=' + cfg.chefSatisfactionFloor);

console.log('\n=== Product catalog ===');
for (const p of PRODUCT_KEYS) {
  const c = PRODUCT_CATALOG[p];
  console.log(`  ${p}: $${c.fixedPrice} demand=${c.baseDemand} satWeight=${c.satisfactionWeight}`);
}

console.log('\n=== Sous chef cost schedule ===');
for (let n = 1; n <= 8; n++) {
  const cost = chefSystem.getSousChefCost(n - 1, cfg);
  const total = chefSystem.getTotalSousChefHireCost(n, cfg);
  console.log(`  ${n}-th sous chef: $${cost.toLocaleString()} (total for ${n}: $${total.toLocaleString()})`);
}

console.log('\n=== Chef bid floors (sousChefBaseCost × multiplier) ===');
console.log(`  novel:        $${(2 * cfg.sousChefBaseCost).toLocaleString()}`);
console.log(`  intermediate: $${(3.5 * cfg.sousChefBaseCost).toLocaleString()}`);
console.log(`  advanced:     $${(5.5 * cfg.sousChefBaseCost).toLocaleString()}`);

console.log('\n=== Chef-satisfaction (cohesion) curve ===');
for (let n = 0; n <= 10; n++) {
  console.log(`  ${n} sous chefs → ${chefSystem.calculateChefSatisfactionScore(n, cfg)}%`);
}

console.log('\n=== Customer pool by round (assuming neutral modifiers) ===');
for (let r = 1; r <= 5; r++) {
  let total = 0;
  for (const p of PRODUCT_KEYS) total += PRODUCT_CATALOG[p].baseDemand;
  console.log(`  R${r}: ${total} customers (max possible)`);
}

// ---------------------------------------------------------------------------
// Single-round trace
// ---------------------------------------------------------------------------

console.log('\n\n=== Single-round trace: 1 team, 4 products, 4 sous, 1 advanced French chef ===');

const advancedFrenchChef = {
  id: 'chef-test',
  nationality: 'french',
  gender: 'female',
  name: 'TestChef',
  skillTier: 'advanced',
  specialties: ['croissant', 'coffee'],
  minBidFloor: 5.5 * cfg.sousChefBaseCost,
};

const decision = {
  quantities: { coffee: 250, croissant: 250, bagel: 100, cookie: 100, sandwich: 0, matcha: 0 },
  menu:       { coffee: true, croissant: true, bagel: true, cookie: true, sandwich: false, matcha: false },
  sousChefCount: 4,
  sousChefAssignments: { coffee: 2, croissant: 2 }, // 2 on each specialty product
  productPrices: { coffee: 4, croissant: 4.75, bagel: 3, cookie: 2.5 },
};

const player = {
  playerId: 'p1',
  displayName: 'TestPlayer',
  bakeryName: 'TestBakery',
  budgetCurrent: cfg.startingBudget,
  decision,
  priorSubmittedPrices: [],
  specialtyChefs: [advancedFrenchChef],
  sousChefCount: 4,
  returningCustomersPending: 0,
  cleanliness_pct: 100,
  auctionResults: {
    adWins: ['TV'],
    adBidPaid: 200,
    chefBidPaid: 55,  // 5.5 × sousChefBaseCost — advanced floor at the rescaled $10 base
    chefsWon: [advancedFrenchChef],
  },
};

console.log('\n--- Hand-computed expectations ---');

// Output per product
for (const p of ['coffee', 'croissant', 'bagel', 'cookie']) {
  const isSpec = ['coffee', 'croissant'].includes(p);
  const chefMult = isSpec ? 3.0 : 1.8; // advanced specialty / non-specialty
  const headChefOutput = chefSystem.getChefOutputForProduct(advancedFrenchChef, p);
  // base 30 + chef contribution + sous (assigned) × 0.5 × headChefOutput
  const sousAssigned = decision.sousChefAssignments[p] || 0;
  const total = 30 + headChefOutput + sousAssigned * 0.5 * headChefOutput;
  // chef satisfaction at 4 sous = 100 (no penalty)
  const effective = total * 1.0;
  const baseDemand = PRODUCT_CATALOG[p].baseDemand;
  const fillRate = effective / baseDemand;
  console.log(`  ${p}: chef=${headChefOutput} sous=${sousAssigned} total=${total} eff=${effective} demand=${baseDemand} fillRate=${fillRate.toFixed(3)}`);
}

console.log('\n--- runSimulation output ---');

const roundPrefs = { round: 1, modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };
const results = sim.runSimulation([player], roundPrefs, cfg, { gameId: 'trace', round: 1 });
const r = results[0];

console.log(`  customerCount:                ${r.customerCount}`);
console.log(`  aggregateSatisfactionPct:     ${r.aggregateSatisfactionPct.toFixed(2)}`);
console.log(`  chefSatisfactionScore:        ${r.chefSatisfactionScore}`);
console.log(`  revenueGross:                 $${Math.round(r.revenueGross).toLocaleString()}`);
console.log(`  revenueNet:                   $${Math.round(r.revenueNet).toLocaleString()}`);
console.log(`  totalSpent:                   $${Math.round(r.totalSpent).toLocaleString()}`);
console.log(`  amountBorrowed:               $${Math.round(r.amountBorrowed).toLocaleString()}`);
console.log(`  budgetAfter:                  $${Math.round(r.budgetAfter).toLocaleString()}`);
console.log(`  Round profit (budgetDelta):   $${Math.round(r.budgetAfter - cfg.startingBudget).toLocaleString()}`);
console.log('');
console.log('  Per-product details:');
for (const p of ['coffee', 'croissant', 'bagel', 'cookie']) {
  const s = r.perProductSatisfaction[p];
  if (!s) continue;
  console.log(`    ${p}: stocked=${s.qtyStocked} sold=${s.qtySold} fillRate=${s.fillRate.toFixed(3)} sat=${s.satisfactionPct.toFixed(1)} tier=${s.tier} sellout=${s.sellout}`);
}

console.log('\n  Revenue breakdown:');
for (const [p, b] of Object.entries(r.revenueBreakdown || {})) {
  console.log(`    ${p}: ${b.qtySold} × $${b.price} = $${b.revenue}`);
}

console.log('\n--- Cost breakdown (hand) ---');
const stockUnits = Object.values(decision.quantities).reduce((s, q) => s + q, 0);
const stockCost = stockUnits * cfg.unitCostPerProduct;
const sousCost = chefSystem.getTotalSousChefHireCost(4, cfg);
const adBidCost = player.auctionResults.adBidPaid;
const chefBidCost = player.auctionResults.chefBidPaid;
const expectedTotal = stockCost + sousCost + adBidCost + chefBidCost;
console.log(`  stockCost:      $${stockCost.toLocaleString()} (${stockUnits} units × $${cfg.unitCostPerProduct})`);
console.log(`  sousCost (4):   $${sousCost.toLocaleString()}`);
console.log(`  adBid:          $${adBidCost.toLocaleString()}`);
console.log(`  chefBid:        $${chefBidCost.toLocaleString()}`);
console.log(`  TOTAL:          $${expectedTotal.toLocaleString()}`);

console.log('\n--- Revenue formula (hand) ---');
const c = cfg.revenueCoefficients;
const sat = r.aggregateSatisfactionPct;
const numProducts = 4;
const totalProductRev = Object.values(r.revenueBreakdown || {}).reduce((s, b) => s + b.revenue, 0);
console.log(`  base:                          $${c.base}`);
console.log(`  sousChefCoeff(${c.sousChefCoeff}) × 4:                  $${c.sousChefCoeff * 4}`);
console.log(`  satisfactionCoeff(${c.satisfactionCoeff}) × ${sat.toFixed(1)}:   $${(c.satisfactionCoeff * sat).toFixed(0)}`);
console.log(`  adSpendCoeff(${c.adSpendCoeff}) × $10000:           $${c.adSpendCoeff * 10000}`);
console.log(`  numProductsCoeff(${c.numProductsCoeff}) × 4:               $${c.numProductsCoeff * 4}`);
console.log(`  product revenue:               $${Math.round(totalProductRev).toLocaleString()}`);
console.log(`  ad winner bonus (TV):          $${cfg.adBonuses.TV.toLocaleString()}`);
console.log(`  + noise (deterministic):       (some value in [-100, 100])`);
const expectedRev = c.base + c.sousChefCoeff * 4 + c.satisfactionCoeff * sat + c.adSpendCoeff * 10000 + c.numProductsCoeff * 4 + totalProductRev + cfg.adBonuses.TV;
console.log(`  Expected total (no noise): $${Math.round(expectedRev).toLocaleString()}`);
console.log(`  Reported:                  $${Math.round(r.revenueGross).toLocaleString()}`);
console.log(`  Difference (= noise):      $${Math.round(r.revenueGross - expectedRev).toLocaleString()}`);
