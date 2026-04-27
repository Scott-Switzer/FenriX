/**
 * test-ad-bonus-gate.js
 *
 * A24-I10 regression test. The flat ad-winner bonus (TV $50k, Billboard
 * $37.5k, Radio $25k, Newspaper $18.75k) must only be awarded to a team
 * that actually stocked product this round. Before the guard, a team
 * could win the biggest ad, stock nothing, and collect the bonus anyway —
 * a risk-free profit that broke the game's economy.
 *
 * This test calls the pure `runSimulation` function directly (no emulator)
 * with two synthetic players: one who stocked a single croissant and one
 * who stocked literally nothing. Both win TV. Asserts that the first
 * earns the $50k TV bonus as part of `revenueGross`, and the second
 * does not.
 *
 * Run via: npm run test:ad-bonus-gate
 */

const path = require('path');
// simulation.js is a pure CommonJS module with no Firebase dependency, so
// we can load it directly from the backend/functions/modules folder.
const simulationPath = path.resolve(
  __dirname,
  '..',
  'functions',
  'modules',
  'simulation.js',
);
const { runSimulation } = require(simulationPath);
const configModule = require(
  path.resolve(__dirname, '..', 'functions', 'modules', 'config.js'),
);

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    console.error(
      `FAIL: ${message} — expected ${expected}, got ${actual}.`,
    );
    process.exit(1);
  }
}

function main() {
  const config = configModule.mergeConfig({});
  const TV_BONUS = config.adBonuses.TV; // $50,000

  // The "zero" player: won TV but stocked nothing.
  const zeroStockPlayer = {
    playerId: 'zero-stock',
    displayName: 'Zero Stock',
    bakeryName: 'Empty Bakery',
    budgetCurrent: 10000,
    cumulativeRevenue: 0,
    specialtyChefs: [],
    sousChefCount: 0,
    returningCustomersPending: 0,
    consecutiveMissedRounds: 0,
    disconnected: false,
    decision: {
      // Empty menu, empty quantities — stocked literally nothing.
      menu: {
        coffee: false,
        croissant: false,
        bagel: false,
        cookie: false,
        sandwich: false,
        matcha: false,
      },
      quantities: {
        coffee: 0,
        croissant: 0,
        bagel: 0,
        cookie: 0,
        sandwich: 0,
        matcha: 0,
      },
      sousChefCount: 0,
      sousChefAssignments: {},
      productPrices: {},
    },
    auctionResults: {
      // Won TV at a small price to cover ad-bid spend.
      adWins: ['TV'],
      adWon: 'TV',
      adBidPaid: 1000,
      chefsWon: [],
      chefBidPaid: 0,
    },
  };

  // The "stocked" player: won TV and stocked a single croissant. The
  // TV bonus MUST apply here.
  const stockedPlayer = {
    playerId: 'stocked',
    displayName: 'Stocked',
    bakeryName: 'Working Bakery',
    budgetCurrent: 10000,
    cumulativeRevenue: 0,
    specialtyChefs: [],
    sousChefCount: 0,
    returningCustomersPending: 0,
    consecutiveMissedRounds: 0,
    disconnected: false,
    decision: {
      menu: {
        coffee: false,
        croissant: true,
        bagel: false,
        cookie: false,
        sandwich: false,
        matcha: false,
      },
      quantities: {
        coffee: 0,
        croissant: 1,
        bagel: 0,
        cookie: 0,
        sandwich: 0,
        matcha: 0,
      },
      sousChefCount: 0,
      sousChefAssignments: {},
      productPrices: {},
    },
    auctionResults: {
      adWins: ['TV'],
      adWon: 'TV',
      adBidPaid: 1000,
      chefsWon: [],
      chefBidPaid: 0,
    },
  };

  const results = runSimulation(
    [zeroStockPlayer, stockedPlayer],
    { modifiers: {} },
    config,
    { gameId: 'test-ad-bonus-gate', round: 1 },
  );

  const zero = results.find((r) => r.playerId === 'zero-stock');
  const stocked = results.find((r) => r.playerId === 'stocked');
  assert(zero, 'zero-stock result present');
  assert(stocked, 'stocked result present');

  // The zero-stock player's revenueGross must NOT include the TV bonus.
  // computeGrossRevenue contributes only base revenue + per-product rev
  // (zero here) + a noise term that lives in [-100, 100] by default. The
  // bonus would add $50k on top of that, which would be strictly greater
  // than any possible noise-only gross. Assert strictly less than the
  // bonus as a conservative check.
  assert(
    zero.revenueGross < TV_BONUS,
    `A24-I10: zero-stock team should NOT receive the $${TV_BONUS} TV ad bonus. ` +
      `revenueGross=${zero.revenueGross}.`,
  );
  console.log(
    `  ✓ zero-stock team did NOT receive TV bonus (revenueGross=${zero.revenueGross}).`,
  );

  // The stocked player's revenueGross must be at least the TV bonus. The
  // bonus alone is $50k; the rest of revenueGross (base + product + noise)
  // is additive and never negative enough to cancel it out (noise floor
  // is -100 by default; base revenue is $500).
  assert(
    stocked.revenueGross >= TV_BONUS,
    `A24-I10: stocked team (1 croissant) should receive the $${TV_BONUS} TV bonus. ` +
      `revenueGross=${stocked.revenueGross}.`,
  );
  console.log(
    `  ✓ stocked team received TV bonus (revenueGross=${stocked.revenueGross}).`,
  );

  // Extra regression — the gap between the two teams should be at
  // least TV_BONUS minus small-delta noise. We give a conservative
  // floor of 0.9 * TV_BONUS to allow for the base + product revenue
  // delta + noise variance.
  const delta = stocked.revenueGross - zero.revenueGross;
  assert(
    delta >= 0.9 * TV_BONUS,
    `A24-I10: the delta between stocked and zero-stock revenueGross must be ~= TV bonus. ` +
      `Got delta=${delta}, expected >= ${0.9 * TV_BONUS}.`,
  );
  console.log(
    `  ✓ delta between teams (${delta}) is within the expected TV bonus range.`,
  );

  // adWins should still be recorded on both results — the guard only
  // zeroes out the bonus, it does not revoke the auction win itself.
  assertEqual(
    (zero.adWins || []).join(','),
    'TV',
    'zero-stock team still records the TV auction win',
  );
  assertEqual(
    (stocked.adWins || []).join(','),
    'TV',
    'stocked team still records the TV auction win',
  );
  console.log('  ✓ both teams still record the TV auction win');

  console.log('\nAd bonus gate test passed.');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
