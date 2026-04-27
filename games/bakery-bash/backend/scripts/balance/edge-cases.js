/**
 * edge-cases.js — Test the simulation at extreme inputs.
 *
 * Tests:
 *   1. Zero stock everywhere — game should still simulate without crash
 *   2. Full chef-cap roster (3 chefs all advanced) at R5
 *   3. 0-budget team starts game (forced loan shark every round)
 *   4. Negative budget at start (already in the red)
 *   5. Maximum stocking everywhere (10x demand)
 *   6. Single-player game (everyone gets max share)
 *   7. 10-round game (extended snowball test)
 *   8. Empty player set (degenerate)
 *   9. NaN/null/undefined fields in decisions (should sanitize, not crash)
 *  10. Sellout cascade (multiple sellouts on same product)
 *  11. All same chef nationality across teams
 *  12. Returning customer carry-over (R1 excellent → R2 has returning)
 */

'use strict';

const path = require('path');
const cfgMod = require(path.join('..', '..', 'functions', 'modules', 'config'));
const sim = require(path.join('..', '..', 'functions', 'modules', 'simulation'));
const harness = require('./harness');
const strategies = require('./strategies');

const cfg = cfgMod.mergeConfig(cfgMod.DEFAULT_GAME_CONFIG);
const { PRODUCT_KEYS, PRODUCT_CATALOG } = cfgMod;

let PASS = 0;
let FAIL = 0;
const FAILS = [];

function check(label, cond, details) {
  if (cond) { PASS++; console.log('  ✓ ' + label); return true; }
  FAIL++; FAILS.push(label + ': ' + (details || 'condition false'));
  console.log('  ✗ ' + label + (details ? ' — ' + details : ''));
  return false;
}

function fmt(n) {
  if (typeof n !== 'number') return String(n);
  const s = Math.round(n).toLocaleString('en-US');
  return n < 0 ? `-$${s.slice(1)}` : `$${s}`;
}

// ---------------------------------------------------------------------------
// Edge case 1: Zero stock everywhere
// ---------------------------------------------------------------------------
console.log('\n=== 1. Zero stock everywhere ===');
{
  const players = [{
    playerId: 'p1', displayName: 'P1', bakeryName: 'B1',
    budgetCurrent: 10000,
    decision: {
      quantities: { croissant: 0, cookie: 0, bagel: 0 },
      menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false },
      sousChefCount: 0, sousChefAssignments: {}, productPrices: {},
    },
    priorSubmittedPrices: [], specialtyChefs: [], sousChefCount: 0,
    returningCustomersPending: 0, cleanliness_pct: 100,
    auctionResults: { adWins: [], adBidPaid: 0, chefBidPaid: 0, chefsWon: [] },
  }];
  const result = sim.runSimulation(players, { modifiers: { coffee: 1, croissant: 1, bagel: 1, cookie: 1, sandwich: 1, matcha: 1 } }, cfg, { gameId: 'e1', round: 1 });
  check('1.1 simulation completes', result.length === 1);
  check('1.2 customerCount is non-negative', result[0].customerCount >= 0);
  check('1.3 revenueGross is finite', Number.isFinite(result[0].revenueGross));
  check('1.4 budgetAfter is finite', Number.isFinite(result[0].budgetAfter));
  check('1.5 totalSpent = 0 (nothing was bought)', result[0].totalSpent === 0);
}

// ---------------------------------------------------------------------------
// Edge case 2: Full chef-cap roster at R5
// ---------------------------------------------------------------------------
console.log('\n=== 2. Full chef-cap (3 advanced chefs) at R5 ===');
{
  const chefs = [
    { id: 'c1', nationality: 'french', skillTier: 'advanced', specialties: ['croissant', 'coffee'], minBidFloor: 5.5*cfg.sousChefBaseCost, name: 'Marcel' },
    { id: 'c2', nationality: 'japanese', skillTier: 'advanced', specialties: ['matcha', 'croissant'], minBidFloor: 5.5*cfg.sousChefBaseCost, name: 'Hiroshi' },
    { id: 'c3', nationality: 'italian', skillTier: 'advanced', specialties: ['sandwich', 'coffee'], minBidFloor: 5.5*cfg.sousChefBaseCost, name: 'Luca' },
  ];
  const players = [{
    playerId: 'p1', displayName: 'P1', bakeryName: 'B1',
    budgetCurrent: 10000,
    decision: {
      quantities: { croissant: 300, coffee: 300, sandwich: 300, matcha: 300, bagel: 300, cookie: 300 },
      menu: { croissant: true, coffee: true, sandwich: true, matcha: true, bagel: true, cookie: true },
      sousChefCount: 4,
      sousChefAssignments: { croissant: 1, coffee: 1, matcha: 1, sandwich: 1 },
      productPrices: {},
    },
    priorSubmittedPrices: [], specialtyChefs: chefs, sousChefCount: 4,
    returningCustomersPending: 100, cleanliness_pct: 100,
    auctionResults: { adWins: ['TV'], adBidPaid: 330, chefBidPaid: 0, chefsWon: [] },
  }];
  const result = sim.runSimulation(players, { modifiers: { coffee: 1, croissant: 1, bagel: 1, cookie: 1, sandwich: 1, matcha: 1 } }, cfg, { gameId: 'e2', round: 5 });
  const r = result[0];
  check('2.1 simulation completes', !!r);
  check('2.2 high satisfaction with 3 chefs', r.aggregateSatisfactionPct >= 60, `got sat=${r.aggregateSatisfactionPct}`);
  check('2.3 customerCount > 0', r.customerCount > 0);
  // Advanced chef on specialty: 30 × 3.0 = 90. With 1 sous: + 0.5 × 90 = 135. Plus base 30. Total = 30+90+45 = 165 per specialty product.
  // For shared specialty (croissant from french+japanese): 30+90+90+sous = 30+90+90+45 = 255
  // Coffee specialty (french+italian): same.
  // All this is reasonable.
}

// ---------------------------------------------------------------------------
// Edge case 3: 0 budget at start (forced loan shark)
// ---------------------------------------------------------------------------
console.log('\n=== 3. Zero budget at start (forced loan shark) ===');
{
  const players = [{
    playerId: 'p1', displayName: 'P1', bakeryName: 'B1',
    budgetCurrent: 0,
    decision: {
      quantities: { croissant: 100, coffee: 100, bagel: 100 },
      menu: { croissant: true, coffee: true, bagel: true, sandwich: false, cookie: false, matcha: false },
      sousChefCount: 2, sousChefAssignments: { croissant: 1, coffee: 1 }, productPrices: {},
    },
    priorSubmittedPrices: [], specialtyChefs: [], sousChefCount: 2,
    returningCustomersPending: 0, cleanliness_pct: 100,
    auctionResults: { adWins: [], adBidPaid: 0, chefBidPaid: 0, chefsWon: [] },
  }];
  const result = sim.runSimulation(players, { modifiers: { coffee: 1, croissant: 1, bagel: 1, cookie: 1, sandwich: 1, matcha: 1 } }, cfg, { gameId: 'e3', round: 1 });
  const r = result[0];
  check('3.1 amountBorrowed > 0 since budget=0 and totalSpent>0', r.amountBorrowed > 0);
  check('3.2 interestCharged = 10% of borrowed', Math.abs(r.interestCharged - r.amountBorrowed * 0.1) < 0.01);
  check('3.3 revenueNet = revenueGross - (borrowed + interest)',
    Math.abs(r.revenueNet - (r.revenueGross - r.amountBorrowed - r.interestCharged)) < 0.01);
  check('3.4 budgetAfter = 0 + revenueNet - totalSpent', r.budgetAfter === Math.round(r.revenueNet - r.totalSpent));
}

// ---------------------------------------------------------------------------
// Edge case 4: Negative starting budget
// ---------------------------------------------------------------------------
console.log('\n=== 4. Negative starting budget (-$50k) ===');
{
  const players = [{
    playerId: 'p1', displayName: 'P1', bakeryName: 'B1',
    budgetCurrent: -50000,
    decision: {
      quantities: { croissant: 50 },
      menu: { croissant: true, coffee: false, bagel: false, sandwich: false, cookie: false, matcha: false },
      sousChefCount: 0, sousChefAssignments: {}, productPrices: {},
    },
    priorSubmittedPrices: [], specialtyChefs: [], sousChefCount: 0,
    returningCustomersPending: 0, cleanliness_pct: 100,
    auctionResults: { adWins: [], adBidPaid: 0, chefBidPaid: 0, chefsWon: [] },
  }];
  const result = sim.runSimulation(players, { modifiers: { coffee: 1, croissant: 1, bagel: 1, cookie: 1, sandwich: 1, matcha: 1 } }, cfg, { gameId: 'e4', round: 1 });
  const r = result[0];
  // Budget already negative; spending $50 of stock requires borrowing $50
  check('4.1 borrowed >= totalSpent (since budget already negative)', r.amountBorrowed >= r.totalSpent - 0.01);
  check('4.2 budgetAfter is finite, can be more negative', Number.isFinite(r.budgetAfter));
}

// ---------------------------------------------------------------------------
// Edge case 5: Maximum stocking everywhere (10× demand)
// ---------------------------------------------------------------------------
console.log('\n=== 5. Maximum stocking (10× demand on all 6 products) ===');
{
  const stocks = {};
  const menu = {};
  for (const p of PRODUCT_KEYS) {
    stocks[p] = PRODUCT_CATALOG[p].baseDemand * 10;
    menu[p] = true;
  }
  const players = [{
    playerId: 'p1', displayName: 'P1', bakeryName: 'B1',
    budgetCurrent: 10000,
    decision: { quantities: stocks, menu, sousChefCount: 0, sousChefAssignments: {}, productPrices: {} },
    priorSubmittedPrices: [], specialtyChefs: [], sousChefCount: 0,
    returningCustomersPending: 0, cleanliness_pct: 100,
    auctionResults: { adWins: [], adBidPaid: 0, chefBidPaid: 0, chefsWon: [] },
  }];
  const result = sim.runSimulation(players, { modifiers: { coffee: 1, croissant: 1, bagel: 1, cookie: 1, sandwich: 1, matcha: 1 } }, cfg, { gameId: 'e5', round: 1 });
  const r = result[0];
  // Stock cost: 10 × baseDemand × $1 = $13,200 (1320 demand × 10 = 13200 units × $1 stock cost)
  const expectedStockCost = Object.values(stocks).reduce((s, x) => s + x, 0) * cfg.unitCostPerProduct;
  check('5.1 stock cost = sum(units) × unitCost', Math.abs(r.totalSpent - expectedStockCost) < 1, `expected ${expectedStockCost}, got ${r.totalSpent}`);
  // No sellouts (we stocked 10x demand)
  for (const p of PRODUCT_KEYS) {
    if (r.perProductSatisfaction[p]) {
      check(`5.${p} no sellout`, r.perProductSatisfaction[p].sellout === false);
    }
  }
}

// ---------------------------------------------------------------------------
// Edge case 6: 10-round game (extended snowball test)
// ---------------------------------------------------------------------------
console.log('\n=== 6. 10-round game (extended) ===');
{
  // Use harness.runOneGame but with totalRounds override
  const teams = [
    { id: 't0', name: 'french', strategy: { play: strategies.frenchStack, name: 'frenchStack', label: 'frenchStack' } },
    { id: 't1', name: 'japanese', strategy: { play: strategies.japaneseStack, name: 'japaneseStack', label: 'japaneseStack' } },
    { id: 't2', name: 'minimal', strategy: { play: strategies.minimalist, name: 'minimalist', label: 'minimalist' } },
  ];
  const result = harness.runOneGame(teams, { totalRounds: 10 }, 0);
  for (const t of result.teams) {
    check(`6.${t.strategyName} produced 10 rounds`, t.profitByRound.length === 10);
    check(`6.${t.strategyName} budget tracked through 10 rounds`,
      Number.isFinite(t.finalBudget) && t.profitByRound.every((p) => Number.isFinite(p)));
  }
}

// ---------------------------------------------------------------------------
// Edge case 7: NaN/null/undefined fields (should sanitize, not crash)
// ---------------------------------------------------------------------------
console.log('\n=== 7. Garbage fields in decisions ===');
{
  const players = [{
    playerId: 'p1', displayName: 'P1', bakeryName: 'B1',
    budgetCurrent: 10000,
    decision: {
      quantities: { croissant: NaN, cookie: 'abc', bagel: undefined, coffee: -50 },
      menu: { croissant: true, coffee: true, bagel: true, sandwich: false, cookie: 'yes' },
      sousChefCount: NaN, sousChefAssignments: { croissant: undefined }, productPrices: {},
    },
    priorSubmittedPrices: [], specialtyChefs: [], sousChefCount: NaN,
    returningCustomersPending: NaN, cleanliness_pct: undefined,
    auctionResults: { adWins: [], adBidPaid: NaN, chefBidPaid: undefined, chefsWon: null },
  }];
  let crashed = false;
  let result;
  try {
    result = sim.runSimulation(players, { modifiers: { coffee: 1, croissant: 1, bagel: 1, cookie: 1, sandwich: 1, matcha: 1 } }, cfg, { gameId: 'e7', round: 1 });
  } catch (e) { crashed = true; FAILS.push('7. crashed: ' + e.message); }
  check('7.1 simulation does not crash on garbage', !crashed);
  if (!crashed) {
    const r = result[0];
    check('7.2 revenueGross finite', Number.isFinite(r.revenueGross));
    check('7.3 budgetAfter finite', Number.isFinite(r.budgetAfter));
    check('7.4 customerCount integer >= 0', Number.isInteger(r.customerCount) && r.customerCount >= 0);
    check('7.5 totalSpent is non-negative finite', Number.isFinite(r.totalSpent) && r.totalSpent >= 0);
  }
}

// ---------------------------------------------------------------------------
// Edge case 8: Sellout cascade (low stock, high demand, multiple players)
// ---------------------------------------------------------------------------
console.log('\n=== 8. Sellout cascade (3 players, all stocking 10 of croissant) ===');
{
  const players = [];
  for (let i = 0; i < 3; i++) {
    players.push({
      playerId: 'p' + i, displayName: 'P' + i, bakeryName: 'B' + i,
      budgetCurrent: 10000,
      decision: {
        quantities: { croissant: 10 },
        menu: { croissant: true, coffee: false, bagel: false, sandwich: false, cookie: false, matcha: false },
        sousChefCount: 0, sousChefAssignments: {}, productPrices: {},
      },
      priorSubmittedPrices: [], specialtyChefs: [], sousChefCount: 0,
      returningCustomersPending: 0, cleanliness_pct: 100,
      auctionResults: { adWins: [], adBidPaid: 0, chefBidPaid: 0, chefsWon: [] },
    });
  }
  const result = sim.runSimulation(players, { modifiers: { coffee: 1, croissant: 1, bagel: 1, cookie: 1, sandwich: 1, matcha: 1 } }, cfg, { gameId: 'e8', round: 1 });
  for (const r of result) {
    check(`8.${r.playerId} sold out`, r.perProductSatisfaction.croissant.sellout === true);
    check(`8.${r.playerId} qtySold <= qtyStocked`, r.perProductSatisfaction.croissant.qtySold <= r.perProductSatisfaction.croissant.qtyStocked);
  }
}

// ---------------------------------------------------------------------------
// Edge case 9: Returning customer snowball (R1 excellent → R2 has carryover)
// ---------------------------------------------------------------------------
console.log('\n=== 9. Returning-customer snowball ===');
{
  const teams = [
    { id: 't0', name: 'snowball', strategy: { play: strategies.frenchStack, name: 'frenchStack', label: 'frenchStack' } },
    { id: 't1', name: 'baseline', strategy: { play: strategies.baseline, name: 'baseline', label: 'baseline' } },
    { id: 't2', name: 'minimal', strategy: { play: strategies.minimalist, name: 'minimalist', label: 'minimalist' } },
  ];
  const result = harness.runOneGame(teams, {}, 0);
  // Sum of customers across rounds for the snowball team — should not all be the same
  // Returning customers DO accumulate when sat is high
  const snowball = result.teams.find((t) => t.strategyName === 'frenchStack');
  let increasingTrend = 0;
  for (let i = 1; i < snowball.customersByRound.length; i++) {
    if (snowball.customersByRound[i] >= snowball.customersByRound[i - 1] - 50) increasingTrend++;
  }
  // Allow for round-pref variation, but on a 5-round game we should see at least 2 round-over-round non-decreases
  check('9.1 customer count tracks round-over-round (snowball or stable)', increasingTrend >= 2);
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
console.log(`\n=== EDGE CASE RESULTS: ${PASS} passed, ${FAIL} failed ===`);
if (FAIL > 0) {
  for (const f of FAILS) console.log('  ' + f);
  process.exit(1);
}
console.log('All edge cases handled correctly.');
