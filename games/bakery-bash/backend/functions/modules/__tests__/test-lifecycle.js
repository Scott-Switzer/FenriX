#!/usr/bin/env node
/**
 * Full Game Lifecycle Integration Test
 * 
 * Simulates a complete 5-round game with 3 players making different
 * strategic choices each round. Verifies the entire pipeline from
 * preference generation → decision validation → simulation → conclusion.
 * 
 * Run: node modules/test-lifecycle.js
 */

const config = require('../config');
const chefSys = require('../chef-system');
const satisfaction = require('../satisfaction');
const custAlloc = require('../customer-allocation');
const revenue = require('../revenue');
const loanShark = require('../loan-shark');
const roundPrefs = require('../round-preferences');
const phases = require('../phases');
const csvExport = require('../csv-export');
const conclusion = require('../conclusion');
const validation = require('../decision-validation');
const simulation = require('../simulation');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  } else {
    passed++;
  }
}

function assertFinite(val, msg) {
  assert(Number.isFinite(val), `${msg}: expected finite, got ${val}`);
}

console.log('=== Full Game Lifecycle Integration Test ===\n');

const cfg = config.mergeConfig({});
const TOTAL_ROUNDS = 5;

// ============================================================================
// Phase 1: Game creation — generate preferences for all rounds
// ============================================================================
console.log('--- Phase 1: Game creation ---');
const gamePreferences = roundPrefs.generateGamePreferences(TOTAL_ROUNDS);
assert(gamePreferences.length === TOTAL_ROUNDS, 'Generated preferences for all rounds');

// Verify market insight emails can be generated for each round
for (let i = 0; i < TOTAL_ROUNDS; i++) {
  const email = roundPrefs.generateMarketInsightEmail(gamePreferences[i]);
  assert(email.from === 'The Plaza Times', `Round ${i + 1} email from Plaza Times`);
  assert(email.body.length > 0, `Round ${i + 1} email has body`);
  assert(email.subject.length > 0, `Round ${i + 1} email has subject`);
}

// ============================================================================
// Phase 2: Player setup — 3 players with different strategies
// ============================================================================
console.log('\n--- Phase 2: Player setup ---');

const playerState = {
  alice: { budget: 2000, specialtyChefs: [], returning: 0, allResults: [] },
  bob: { budget: 2000, specialtyChefs: [], returning: 0, allResults: [] },
  carol: { budget: 2000, specialtyChefs: [], returning: 0, allResults: [] },
};

// Strategies:
// Alice: Conservative — base 3 products, moderate stocking, no sous chefs early
// Bob: Aggressive — expand to 6 products fast, high stocking, many sous chefs
// Carol: Specialty — few products but high quality, focus on chef acquisitions

// ============================================================================
// Phase 3: Simulate each round
// ============================================================================
let currentPhase = 'lobby';

for (let round = 1; round <= TOTAL_ROUNDS; round++) {
  console.log(`\n--- Round ${round} ---`);

  // --- Phase transitions: lobby → email → decide → bid_ad → bid_chef → roster → simulating → results_ready ---
  // Verify getNextPhase produces the correct sequence for this round
  if (round === 1) {
    const next = phases.getNextPhase('lobby', 0, TOTAL_ROUNDS);
    assert(next.phase === 'round_1_email', 'lobby → round_1_email');
    assert(next.round === 1, 'round_1_email round = 1');
  } else {
    const next = phases.getNextPhase('results_ready', round - 1, TOTAL_ROUNDS);
    assert(next.phase === `round_${round}_email`, `results_ready → round_${round}_email`);
    assert(next.round === round, `round_${round}_email round = ${round}`);
  }
  // Validate intra-round transitions (these are round-agnostic patterns)
  const intraPhases = ['email', 'bid_ad', 'bid_chef', 'roster', 'decide'];
  for (let i = 0; i < intraPhases.length - 1; i++) {
    const from = `round_${round}_${intraPhases[i]}`;
    const to = `round_${round}_${intraPhases[i + 1]}`;
    const valid = phases.isValidTransition(from, to);
    assert(valid, `Transition ${from} → ${to} valid`);
  }
  assert(phases.isValidTransition(`round_${round}_roster`, `round_${round}_decide`), `roster → decide valid`);
  assert(phases.isValidTransition(`round_${round}_decide`, 'simulating'), `decide → simulating valid`);
  assert(phases.isValidTransition('simulating', 'results_ready'), `simulating → results_ready valid`);

  // --- Decision phase ---
  assert(phases.canSubmitDecision(`round_${round}_decide`), `Can submit decisions in round ${round}`);

  // Build decisions based on player strategies
  const aliceDecision = buildAliceDecision(round, playerState.alice);
  const bobDecision = buildBobDecision(round, playerState.bob);
  const carolDecision = buildCarolDecision(round, playerState.carol);

  // Validate all decisions
  const valAlice = validation.validateDecision(aliceDecision, round, cfg);
  assert(valAlice.numProducts >= 3, `Alice decision valid (${valAlice.numProducts} products)`);

  const valBob = validation.validateDecision(bobDecision, round, cfg);
  assert(valBob.numProducts >= 3, `Bob decision valid (${valBob.numProducts} products)`);

  const valCarol = validation.validateDecision(carolDecision, round, cfg);
  assert(valCarol.numProducts >= 3, `Carol decision valid (${valCarol.numProducts} products)`);

  // --- Ad auction ---
  assert(phases.canSubmitBids(`round_${round}_bid_ad`, 'ad'), `Can submit ad bids round ${round}`);
  const aliceAdBids = validation.validateAdBids(round >= 3 ? { TV: 150 } : {});
  const bobAdBids = validation.validateAdBids({ TV: 200, Billboard: 100 });
  const carolAdBids = validation.validateAdBids(round >= 2 ? { Radio: 80 } : {});

  // --- Chef auction ---
  assert(phases.canSubmitBids(`round_${round}_bid_chef`, 'chef'), `Can submit chef bids round ${round}`);
  const pool = chefSys.generateChefPool(round, cfg);
  assert(pool.length >= 6, `Chef pool has ${pool.length} chefs`);

  // Bob bids aggressively on chefs
  const bobChefBids = [];
  if (round <= 3 && pool.length > 0) {
    bobChefBids.push({ chefId: pool[0].id, amount: pool[0].minBidFloor + 50 });
  }

  // Carol bids on the best chef
  const carolChefBids = [];
  const advancedChefs = pool.filter(c => c.skillTier === 'advanced');
  if (advancedChefs.length > 0 && round <= 4) {
    carolChefBids.push({ chefId: advancedChefs[0].id, amount: advancedChefs[0].minBidFloor + 100 });
  }

  // Resolve auction
  const allBids = [
    ...bobChefBids.map(b => ({ ...b, playerId: 'bob', submittedAt: Date.now() })),
    ...carolChefBids.map(b => ({ ...b, playerId: 'carol', submittedAt: Date.now() + 1 })),
  ];
  const auctionResult = chefSys.resolveChefAuction(pool, allBids);

  // Update specialty chefs
  const bobWon = auctionResult.winners.get('bob') || [];
  const carolWon = auctionResult.winners.get('carol') || [];
  playerState.bob.specialtyChefs.push(...bobWon);
  playerState.carol.specialtyChefs.push(...carolWon);

  const bobChefPayment = auctionResult.payments.get('bob') || 0;
  const carolChefPayment = auctionResult.payments.get('carol') || 0;

  // --- Simulation ---
  const players = [
    {
      playerId: 'alice',
      displayName: 'Alice',
      bakeryName: "Alice's Artisan",
      budgetCurrent: playerState.alice.budget,
      specialtyChefs: playerState.alice.specialtyChefs,
      returningCustomersPending: playerState.alice.returning,
      decision: aliceDecision,
      auctionResults: {
        adWon: round >= 3 ? 'TV' : null, // simplified: Alice wins TV when she bids
        adBidPaid: round >= 3 ? 150 : 0,
        chefBidPaid: 0,
      },
    },
    {
      playerId: 'bob',
      displayName: 'Bob',
      bakeryName: "Bob's Bakehouse",
      budgetCurrent: playerState.bob.budget,
      specialtyChefs: playerState.bob.specialtyChefs,
      returningCustomersPending: playerState.bob.returning,
      decision: bobDecision,
      auctionResults: {
        adWon: 'Billboard',
        adBidPaid: 100,
        chefBidPaid: bobChefPayment,
      },
    },
    {
      playerId: 'carol',
      displayName: 'Carol',
      bakeryName: "Carol's Corner",
      budgetCurrent: playerState.carol.budget,
      specialtyChefs: playerState.carol.specialtyChefs,
      returningCustomersPending: playerState.carol.returning,
      decision: carolDecision,
      auctionResults: {
        adWon: round >= 2 ? 'Radio' : null,
        adBidPaid: round >= 2 ? 80 : 0,
        chefBidPaid: carolChefPayment,
      },
    },
  ];

  const roundResults = simulation.runSimulation(players, gamePreferences[round - 1], cfg);
  assert(roundResults.length === 3, `Round ${round}: 3 player results`);

  // Validate each player's result
  for (const r of roundResults) {
    assertFinite(r.revenueGross, `${r.playerId} R${round} revenueGross`);
    assertFinite(r.revenueNet, `${r.playerId} R${round} revenueNet`);
    assertFinite(r.customerCount, `${r.playerId} R${round} customerCount`);
    assertFinite(r.aggregateSatisfactionPct, `${r.playerId} R${round} aggSatisfaction`);
    assertFinite(r.budgetAfter, `${r.playerId} R${round} budgetAfter`);
    assertFinite(r.totalSpent, `${r.playerId} R${round} totalSpent`);
    assert(typeof r.perProductSatisfaction === 'object', `${r.playerId} R${round} has perProductSatisfaction`);
    assert(typeof r.csvRow === 'object', `${r.playerId} R${round} has csvRow`);
    assert(typeof r.returningCustomersEarned === 'number', `${r.playerId} R${round} has returningCustomersEarned`);

    // Verify no NaN in per-product data
    for (const [product, pps] of Object.entries(r.perProductSatisfaction)) {
      assertFinite(pps.satisfactionPct, `${r.playerId} R${round} ${product} satisfactionPct`);
      assertFinite(pps.qtySold, `${r.playerId} R${round} ${product} qtySold`);
    }
  }

  // Update player state for next round
  for (const r of roundResults) {
    const ps = playerState[r.playerId];
    ps.budget = r.budgetAfter;
    ps.returning = r.returningCustomersEarned;
    ps.allResults.push({
      round,
      revenueGross: r.revenueGross,
      revenueNet: r.revenueNet,
      amountBorrowed: r.amountBorrowed,
      interestCharged: r.interestCharged,
      totalSpent: r.totalSpent,
    });
  }

  // Build CSV rows
  const csvRows = roundResults.map(r => {
    const row = r.csvRow;
    row.player_id = r.playerId;
    row.bakery_name = r.bakeryName;
    row.display_name = r.displayName;
    return row;
  });
  const csvStr = csvExport.buildCsvString(csvRows, true);
  assert(csvStr.length > 0, `Round ${round} CSV generated`);

  console.log(`  Alice: budget=$${Math.round(playerState.alice.budget)}, returning=${playerState.alice.returning}`);
  console.log(`  Bob:   budget=$${Math.round(playerState.bob.budget)}, returning=${playerState.bob.returning}`);
  console.log(`  Carol: budget=$${Math.round(playerState.carol.budget)}, returning=${playerState.carol.returning}`);
}

// ============================================================================
// Phase 4: Game conclusion
// ============================================================================
console.log('\n--- Phase 4: Game conclusion ---');

const aliceAgg = conclusion.aggregatePlayerResults(playerState.alice.allResults, cfg);
const bobAgg = conclusion.aggregatePlayerResults(playerState.bob.allResults, cfg);
const carolAgg = conclusion.aggregatePlayerResults(playerState.carol.allResults, cfg);

assertFinite(aliceAgg.totalRevenue, 'Alice total revenue');
assertFinite(bobAgg.totalRevenue, 'Bob total revenue');
assertFinite(carolAgg.totalRevenue, 'Carol total revenue');
assertFinite(aliceAgg.netRevenue, 'Alice net revenue');

const rankings = conclusion.rankPlayers([
  { playerId: 'alice', netRevenue: aliceAgg.netRevenue, budgetRemaining: playerState.alice.budget },
  { playerId: 'bob', netRevenue: bobAgg.netRevenue, budgetRemaining: playerState.bob.budget },
  { playerId: 'carol', netRevenue: carolAgg.netRevenue, budgetRemaining: playerState.carol.budget },
]);

assert(rankings.length === 3, '3 players ranked');
assert(rankings[0].rank === 1, 'First place is rank 1');
assert(rankings[2].rank >= 2, 'Last place has rank >= 2');

const conclusionData = conclusion.buildConclusionData(rankings, playerState[rankings[0].playerId].specialtyChefs);
assert(conclusionData.winner != null, 'Winner exists');
assert(conclusionData.rankings.length === 3, 'Rankings in conclusion');
assert(typeof conclusionData.timestamp === 'number', 'Timestamp exists');

console.log(`\n  Winner: ${conclusionData.winner.playerId}`);
console.log(`  Rankings:`);
for (const r of rankings) {
  console.log(`    #${r.rank} ${r.playerId}: net=$${Math.round(r.netRevenue)}, budget=$${Math.round(r.budgetRemaining)}`);
}

// ============================================================================
// Phase 5: Phase machine — verify game_over is reachable
// ============================================================================
console.log('\n--- Phase 5: Phase machine verification ---');
const finalTransition = phases.getNextPhase('results_ready', TOTAL_ROUNDS, TOTAL_ROUNDS);
assert(finalTransition.phase === 'game_over', 'Final transition reaches game_over');
assert(!phases.isGameActive('game_over'), 'game_over is not active');

// ============================================================================
// Phase 6: 150-player stress test (full round)
// ============================================================================
console.log('\n--- Phase 6: 150-player stress test ---');
const stressPlayers = [];
for (let i = 0; i < 150; i++) {
  stressPlayers.push({
    playerId: `stress_${i}`,
    displayName: `Player ${i}`,
    bakeryName: `Bakery ${i}`,
    budgetCurrent: 2000,
    specialtyChefs: i % 5 === 0 ? [{ skillTier: 'advanced', specialties: ['croissant', 'coffee'] }] : [],
    returningCustomersPending: 0,
    decision: {
      menu: { croissant: true, cookie: true, bagel: true, sandwich: i % 2 === 0, coffee: i % 3 === 0, matcha: false },
      quantities: { croissant: 30 + (i % 20), cookie: 20, bagel: 15, sandwich: i % 2 === 0 ? 10 : 0, coffee: i % 3 === 0 ? 20 : 0 },
      sousChefCount: i % 4,
      sousChefAssignments: i % 4 > 0 ? { croissant: Math.min(i % 4, 2), cookie: Math.max(0, (i % 4) - 2) } : {},
    },
    auctionResults: { adWon: i === 0 ? 'TV' : null, adBidPaid: i === 0 ? 200 : 0, chefBidPaid: 0 },
  });
}

const start = Date.now();
const stressResults = simulation.runSimulation(stressPlayers, gamePreferences[0], cfg);
const elapsed = Date.now() - start;

assert(stressResults.length === 150, '150 player results');
assert(elapsed < 5000, `150-player sim under 5s (actual: ${elapsed}ms)`);

let nanCount = 0;
for (const r of stressResults) {
  if (!Number.isFinite(r.revenueGross) || !Number.isFinite(r.budgetAfter) || !Number.isFinite(r.customerCount)) {
    nanCount++;
  }
}
assert(nanCount === 0, `No NaN in 150-player results (found ${nanCount})`);

console.log(`  150 players: ${elapsed}ms, 0 NaN values`);

// ============================================================================
// FINAL REPORT
// ============================================================================
console.log('\n========================================');
console.log(`LIFECYCLE TEST: ${passed} passed, ${failed} failed`);
console.log('========================================');
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

// ============================================================================
// Strategy builders
// ============================================================================

function buildAliceDecision(round, state) {
  // Conservative: base 3 products, grows slowly
  const menu = { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false };
  const quantities = { croissant: 40, cookie: 30, bagel: 20 };
  let sousChefCount = 0;
  const sousChefAssignments = {};

  if (round >= 3) {
    menu.sandwich = true;
    quantities.sandwich = 15;
  }
  if (round >= 4) {
    sousChefCount = 1;
    sousChefAssignments.croissant = 1;
  }

  return { menu, quantities, sousChefCount, sousChefAssignments };
}

function buildBobDecision(round, state) {
  // Aggressive: expand fast, high volume
  const menu = { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false };
  const quantities = { croissant: 60, cookie: 50, bagel: 40 };
  let sousChefCount = Math.min(round, 4);
  const sousChefAssignments = {};

  if (round >= 2) {
    menu.sandwich = true;
    menu.coffee = true;
    quantities.sandwich = 30;
    quantities.coffee = 40;
  }
  if (round >= 3) {
    menu.matcha = true;
    quantities.matcha = 25;
  }

  // Distribute sous chefs
  if (sousChefCount > 0) {
    sousChefAssignments.croissant = Math.min(sousChefCount, 2);
    if (sousChefCount > 2) sousChefAssignments.cookie = sousChefCount - 2;
  }

  return { menu, quantities, sousChefCount, sousChefAssignments };
}

function buildCarolDecision(round, state) {
  // Quality-focused: few products, high stock
  const menu = { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false };
  const quantities = { croissant: 80, cookie: 60, bagel: 50 };
  let sousChefCount = Math.min(round - 1, 3);
  if (sousChefCount < 0) sousChefCount = 0;
  const sousChefAssignments = {};

  if (round >= 4) {
    menu.coffee = true;
    quantities.coffee = 50;
  }

  if (sousChefCount > 0) {
    sousChefAssignments.croissant = sousChefCount;
  }

  return { menu, quantities, sousChefCount, sousChefAssignments };
}
