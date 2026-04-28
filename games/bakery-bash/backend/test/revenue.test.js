/**
 * Pins the gaussianNoise seed contract that the multi-day simulation
 * (P2) relies on: same seed → same noise; different day in seed → different
 * noise; clamps respected.
 */

const assert = require('node:assert/strict');
const { gaussianNoise } = require('../functions/modules/revenue');
const { runSimulation } = require('../functions/modules/simulation');
const configMod = require('../functions/modules/config');
// runSimulation expects a *merged* game config (the DEFAULT_GAME_CONFIG
// shape that index.js loads from Firestore — not the bare module object).
// Fold module-level pure constants in so PRICE_ZONES / AD_TYPES / etc.
// are reachable from the merged config.
const config = {
  ...configMod,
  ...configMod.DEFAULT_GAME_CONFIG,
};

describe('gaussianNoise', () => {
  it('produces identical noise for the same seed', () => {
    const a = gaussianNoise(-2, 2, 'game:1:0:player_a');
    const b = gaussianNoise(-2, 2, 'game:1:0:player_a');
    assert.equal(a, b, 'same seed must produce same noise');
  });

  it('produces different noise when only day differs', () => {
    const day0 = gaussianNoise(-2, 2, 'game:1:0:player_a');
    const day1 = gaussianNoise(-2, 2, 'game:1:1:player_a');
    assert.notEqual(day0, day1, 'changing day must change noise');
  });

  it('produces different noise when only player differs', () => {
    const a = gaussianNoise(-2, 2, 'game:1:0:player_a');
    const b = gaussianNoise(-2, 2, 'game:1:0:player_b');
    assert.notEqual(a, b, 'changing player must change noise');
  });

  it('respects min/max clamps across many seeds', () => {
    for (let d = 0; d < 200; d += 1) {
      const v = gaussianNoise(-2, 2, `game:1:${d}:player_a`);
      assert.ok(v >= -2 && v <= 2, `value ${v} out of range`);
    }
  });
});

describe('runSimulation skipCostAccounting flag', () => {
  // Intentionally low budget + meaningful stock to trigger loan-shark
  // when skipCostAccounting=false, and to highlight the difference.
  const player = {
    playerId: 'p_a',
    displayName: 'p_a',
    bakeryName: 'p_a',
    decision: {
      menu: { croissant: true, cookie: true, bagel: true },
      quantities: { croissant: 200, cookie: 200, bagel: 200 },
      sousChefCount: 1,
      sousChefAssignments: { croissant: 1 },
      productPrices: { croissant: 4.75, cookie: 4.0, bagel: 4.5 },
    },
    specialtyChefs: [],
    budgetCurrent: 100, // intentionally low to trigger loan-shark
    returningCustomersPending: 0,
    auctionResults: { adWins: [], adBidPaid: 0, chefsWon: [], chefBidPaid: 0 },
    priorSubmittedPrices: [],
    cleanliness_pct: 5, // very low — would normally roll burglary
  };
  const prefs = { modifiers: { croissant: 1, cookie: 1, bagel: 1 } };

  it('skipCostAccounting=true zeros cost / loan-shark / burglary / budget update', () => {
    const r = runSimulation([player], prefs, config, { gameId: 'g', round: 1, skipCostAccounting: true })[0];
    assert.equal(r.totalSpent, 0, 'no cost charged');
    assert.equal(r.amountBorrowed, 0, 'no borrow');
    assert.equal(r.interestCharged, 0, 'no interest');
    assert.equal(r.budgetAfter, player.budgetCurrent, 'budget unchanged');
    assert.equal(r.burglary, false, 'no burglary roll');
  });

  it('skipCostAccounting=false (default) preserves prior behavior', () => {
    const r = runSimulation([player], prefs, config)[0];
    assert.ok(r.totalSpent > 0, 'cost should be charged');
    assert.ok(r.amountBorrowed > 0, 'loan-shark should fire on overspend');
  });

  it('revenueGross is identical between skip and non-skip modes', () => {
    const skipped = runSimulation([player], prefs, config, { gameId: 'g', round: 1, skipCostAccounting: true })[0];
    const normal = runSimulation([player], prefs, config, { gameId: 'g', round: 1, skipCostAccounting: false })[0];
    assert.equal(skipped.revenueGross, normal.revenueGross, 'gross revenue independent of cost accounting');
  });
});
