/**
 * P2.4 — runMonthlySimulation wrapper.
 *
 * Pins the contract:
 *   - 30 daily sub-simulations per round (configurable via MULTI_DAY.daysPerRound)
 *   - cost / loan-shark / budget update happen ONCE per month, not per day
 *   - per-day customer counts vary because of the demand multiplier
 *   - same gameId/round = same monthly outcome (reproducibility)
 */

const assert = require('node:assert/strict');
const configMod = require('../functions/modules/config');
const { runMonthlySimulation } = require('../functions/modules/multi-day-simulation');

// Same merge pattern as revenue.test.js — runSimulation reads top-level
// fields like cfg.unitCostPerProduct that live under DEFAULT_GAME_CONFIG.
const config = {
  ...configMod,
  ...configMod.DEFAULT_GAME_CONFIG,
};

const fakePlayer = (id, overrides = {}) => ({
  playerId: id,
  displayName: id,
  bakeryName: id,
  decision: {
    menu: { croissant: true, cookie: true, bagel: true },
    quantities: { croissant: 200, cookie: 200, bagel: 200 },
    sousChefCount: 1,
    sousChefAssignments: { croissant: 1 },
    productPrices: { croissant: 4.75, cookie: 4.0, bagel: 4.5 },
  },
  specialtyChefs: [],
  budgetCurrent: 10000,
  returningCustomersPending: 0,
  auctionResults: { adWins: [], adBidPaid: 0, chefsWon: [], chefBidPaid: 0 },
  priorSubmittedPrices: [],
  ...overrides,
});

describe('runMonthlySimulation', () => {
  const prefs = { modifiers: { croissant: 1.0, cookie: 1.0, bagel: 1.0 } };

  it('returns one monthly aggregate per player + an array of daily rows', () => {
    const out = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1', round: 1,
    });
    assert.equal(out.length, 1, 'one aggregate per player');
    const agg = out[0];
    assert.ok(Array.isArray(agg.dailyResults), 'has dailyResults array');
    assert.equal(agg.dailyResults.length, config.MULTI_DAY.daysPerRound, '30 daily rows');
  });

  it('monthly revenueGross equals sum of daily revenueGross', () => {
    const out = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1', round: 1,
    });
    const agg = out[0];
    const sum = agg.dailyResults.reduce((s, d) => s + d.revenueGross, 0);
    assert.ok(Math.abs(agg.revenueGross - sum) < 0.01,
      `monthly gross (${agg.revenueGross}) should equal sum of daily gross (${sum})`);
  });

  it('charges cost ONCE per month, not 30x', () => {
    // Stock 600 units * $1 = $600. Plus 1 sous chef = $10. Total ~$610.
    // If cost were charged 30x, totalSpent would be ~$18,300 — way out of bounds.
    const out = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1', round: 1,
    });
    const agg = out[0];
    assert.ok(agg.totalSpent < 2000, `expected monthly cost < $2k, got $${agg.totalSpent}`);
    assert.ok(agg.totalSpent > 500, `expected monthly cost > $500, got $${agg.totalSpent}`);
  });

  it('does NOT charge loan-shark interest 30x for an overspending team', () => {
    // Force overspend: tiny budget, expensive decisions.
    const broke = fakePlayer('p_a', { budgetCurrent: 100 });
    const out = runMonthlySimulation([broke], prefs, config, { gameId: 'g1', round: 1 });
    const agg = out[0];
    // Real one-time loan: borrow ~$510 at 10% = ~$51 interest. 30x would be ~$1,500.
    assert.ok(agg.interestCharged > 0, 'loan-shark should fire on overspend');
    assert.ok(agg.interestCharged < 200,
      `expected one-time interest < $200, got $${agg.interestCharged}`);
  });

  it('produces different daily customer counts (variability fires)', () => {
    const out = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1', round: 1,
    });
    const counts = out[0].dailyResults.map((d) => d.customerCount);
    const uniq = new Set(counts);
    assert.ok(uniq.size > 1, `expected variety in daily customer counts, got ${counts.join(',')}`);
  });

  it('is deterministic for the same gameId/round (reproducible)', () => {
    const a = runMonthlySimulation([fakePlayer('p_a')], prefs, config, { gameId: 'g1', round: 1 });
    const b = runMonthlySimulation([fakePlayer('p_a')], prefs, config, { gameId: 'g1', round: 1 });
    assert.equal(a[0].revenueGross, b[0].revenueGross, 'same inputs = same outputs');
  });

  it('produces different outcomes across rounds (round folded into seed)', () => {
    const r1 = runMonthlySimulation([fakePlayer('p_a')], prefs, config, { gameId: 'g1', round: 1 });
    const r2 = runMonthlySimulation([fakePlayer('p_a')], prefs, config, { gameId: 'g1', round: 2 });
    assert.notEqual(r1[0].revenueGross, r2[0].revenueGross,
      'different rounds should produce different revenueGross via day*round noise seeds');
  });

  // ---- Review-fix tests (PR #110 follow-ups) ----

  it('apportions loan-shark deduction so sum of daily revenueNet = monthly revenueNet', () => {
    // Force a loan: budget $100, real cost ~$610 → borrows ~$510 + interest.
    const broke = fakePlayer('p_a', { budgetCurrent: 100 });
    const out = runMonthlySimulation([broke], prefs, config, { gameId: 'g1', round: 1 });
    const agg = out[0];
    const dailyNetSum = agg.dailyResults.reduce((s, d) => s + d.revenueNet, 0);
    assert.ok(Math.abs(agg.revenueNet - dailyNetSum) < 0.01,
      `monthly revenueNet (${agg.revenueNet}) should equal sum of daily revenueNet (${dailyNetSum})`);
    // And the same for amount_borrowed and interest_charged.
    const dailyBorrowSum = agg.dailyResults.reduce((s, d) => s + d.amountBorrowed, 0);
    const dailyInterestSum = agg.dailyResults.reduce((s, d) => s + d.interestCharged, 0);
    assert.ok(Math.abs(agg.amountBorrowed - dailyBorrowSum) < 0.01,
      `monthly amountBorrowed should equal sum of daily; got ${agg.amountBorrowed} vs ${dailyBorrowSum}`);
    assert.ok(Math.abs(agg.interestCharged - dailyInterestSum) < 0.01,
      `monthly interestCharged should equal sum of daily; got ${agg.interestCharged} vs ${dailyInterestSum}`);
  });

  it('monthly csvRow has correct cost / loan-shark / customer columns (not zeros from skipCostAccounting)', () => {
    // Force loan-shark to fire so we can verify amount_borrowed > 0.
    const broke = fakePlayer('p_a', { budgetCurrent: 100 });
    const out = runMonthlySimulation([broke], prefs, config, { gameId: 'g1', round: 1 });
    const agg = out[0];
    const row = agg.csvRow || {};
    // The professor CSV reads from r.csvRow — these columns must reflect
    // the monthly aggregate, not day-29 with skipCostAccounting=true (which
    // would have zeros for cost / borrow / interest).
    assert.ok(row.amount_borrowed > 0,
      `monthly csvRow.amount_borrowed should be > 0 for overspending team, got ${row.amount_borrowed}`);
    assert.ok(row.interest_charged > 0,
      `monthly csvRow.interest_charged should be > 0, got ${row.interest_charged}`);
    assert.equal(row.revenue, agg.revenueNet,
      'monthly csvRow.revenue should equal monthly revenueNet (post loan-shark)');
    assert.equal(row.customer_count, agg.customerCount,
      'monthly csvRow.customer_count should equal monthly aggregate (sum across days), not day-29 only');
  });

  it('returningCustomersEarned uses MONTHLY customerCount, not day-29 alone (PR #110 re-review A)', () => {
    // computeReturningCustomersEarned is linear in customerCount. Taking
    // last.returningCustomersEarned (day-29 only) gives ~1/daysPerRound of
    // what it should be, breaking the round-to-round carryover loop.
    // Excellent satisfaction (>= 86) gives a 0.15 bonus rate, so
    // expected ≈ monthly customerCount * 0.15.
    const out = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1', round: 1,
    });
    const agg = out[0];
    // High satisfaction setup (lots of stock, no competition) → excellent tier.
    assert.ok(agg.aggregateSatisfactionPct >= 86,
      `setup expected to hit excellent tier; got ${agg.aggregateSatisfactionPct}`);
    const expected = Math.round(agg.customerCount * 0.15);
    // Allow small rounding tolerance.
    assert.ok(Math.abs(agg.returningCustomersEarned - expected) <= 2,
      `returningCustomersEarned ${agg.returningCustomersEarned} should ≈ ${expected} (monthly customerCount * 0.15); ` +
      `if it's ~1/30 of expected, the day-29-only bug regressed`);
  });

  it('perProductCustomers is aggregated across days, not day-29 only (PR #110 re-review A)', () => {
    // last.perProductCustomers is day-29 only, ~1/daysPerRound of the
    // round's per-product totals. Aggregating across days gives the real
    // monthly per-product breakdown.
    const out = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1', round: 1,
    });
    const agg = out[0];
    const dailySum = {};
    for (const d of agg.dailyResults) {
      for (const [k, v] of Object.entries(d.perProductCustomers || {})) {
        dailySum[k] = (dailySum[k] || 0) + (Number(v) || 0);
      }
    }
    for (const product of Object.keys(dailySum)) {
      assert.equal(agg.perProductCustomers[product], dailySum[product],
        `monthly perProductCustomers.${product} should equal sum of daily; ` +
        `got ${agg.perProductCustomers[product]} vs ${dailySum[product]}`);
    }
  });

  it('per-day rows carry apportioned amountBorrowed + interestCharged (PR #110 re-review B)', () => {
    // The frontend CSV serializeRow falls back to r.amountBorrowed (monthly)
    // if the daily row doesn't carry it — students summing the column would
    // get 30x the actual loan. Verify the wrapper exposes apportioned values
    // on each daily row so the lastRoundResult payload can forward them.
    const broke = fakePlayer('p_a', { budgetCurrent: 100 });
    const out = runMonthlySimulation([broke], prefs, config, { gameId: 'g1', round: 1 });
    const agg = out[0];
    assert.ok(agg.amountBorrowed > 0, 'setup must trigger a loan');
    for (const d of agg.dailyResults) {
      assert.ok(typeof d.amountBorrowed === 'number',
        `each daily row must expose amountBorrowed; got ${typeof d.amountBorrowed}`);
      assert.ok(typeof d.interestCharged === 'number',
        `each daily row must expose interestCharged; got ${typeof d.interestCharged}`);
      // Each day's apportioned share must be < monthly (otherwise sum > monthly).
      assert.ok(d.amountBorrowed < agg.amountBorrowed,
        `daily amountBorrowed (${d.amountBorrowed}) must be < monthly (${agg.amountBorrowed})`);
    }
  });

  it('returningCustomersPending is applied ONCE per month, not 30x (multi-day bug fix)', () => {
    // Bug discovered while building the strategy tournament: the wrapper
    // passes the player struct to runSimulation 30 times per round, and the
    // player's `returningCustomersPending` (e.g., 100) gets seeded into the
    // demand pool every single day. Over 30 days that's 30*100 = 3000
    // returning customers contributed to the monthly demand pool when only
    // 100 actually returned — a multi-round game's customer counts compound
    // 30x per round and budgets explode.
    //
    // Fix: scale returningCustomersPending by 1/daysPerRound before the
    // daily loop so summing across days gives ≈ the original returning
    // pool (matching the same approach as demand modifier scaling).
    const baseline = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1', round: 1,
    });
    const baseCust = baseline[0].customerCount;

    const withReturning = runMonthlySimulation(
      [fakePlayer('p_a', { returningCustomersPending: 100 })],
      prefs, config, { gameId: 'g1', round: 1 },
    );
    const cust = withReturning[0].customerCount;

    // Adding 100 returning customers per month should bump monthly customer
    // count by ≈100 (after foot-traffic + competitive split), NOT by 3000.
    const delta = cust - baseCust;
    assert.ok(delta < 500,
      `returning=100 should bump monthly customers by ~100, got delta=${delta} (cust=${cust} vs baseline=${baseCust}). ` +
      `If delta >= 3000 the 30x multiplication bug is back.`);
    assert.ok(delta > 0,
      `returning=100 should increase customers above baseline; got no change (cust=${cust}, baseline=${baseCust})`);
  });

  it('monthly customer count stays in pre-P2 round-level magnitude (not 30x)', () => {
    // Pre-P2: a team with 200/200/200 stock, 1 sous, $10k budget would
    // typically see a few hundred customers per round. After the day-scale
    // fix (#3), 30 daily sub-sims with demand divided by daysPerRound
    // should aggregate back to ≈ pre-P2 round-level magnitude.
    // baseDemand for croissant/cookie/bagel = 240 each = 720 total.
    // A solo player gets ~all of it (no competitor). Allow generous bounds
    // to absorb satisfaction / sellout effects.
    const out = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1', round: 1,
    });
    const agg = out[0];
    assert.ok(agg.customerCount < 2000,
      `monthly customer count should be in pre-P2 range, got ${agg.customerCount} (looks like the 30x scaling bug)`);
    assert.ok(agg.customerCount > 100,
      `monthly customer count should be meaningful, got ${agg.customerCount}`);
  });

  it('cleanliness drift uses the per-day customer count, not the monthly aggregate (M-03)', () => {
    // M-03 (2026-04-28): the spec constants for cleanlinessDriftDelta were
    // calibrated for a PER-DAY customer count, not a 30-day aggregate.
    // Passing the monthly aggregate over-drained the score (5 staff vs 2000
    // monthly customers → +100 boost vs -400 drain → F regardless of
    // staffing). Fix at the apply site: divide by days.
    //
    // PR #128 originally asserted the opposite — that the FULL monthly count
    // should drain the score below 50. That was the bug, not the fix; the
    // test now asserts the corrected per-day behavior.
    const out = runMonthlySimulation(
      [fakePlayer('p_a', { cleanlinessScore: 100 })],
      prefs, config, { gameId: 'g1', round: 1 },
    );
    const agg = out[0];
    // 0 maintenance staff, hundreds of monthly customers / 30 days
    // → small drain per round. Score should stay near 100, not collapse.
    assert.ok(agg.cleanlinessScore >= 80,
      `cleanlinessScore ${agg.cleanlinessScore} should stay high when drift is ` +
      `applied per-day (>= 80). monthlyCustomers=${agg.customerCount}; expected ` +
      `drain ≈ ${(0.20 * agg.customerCount / 30).toFixed(1)}. ` +
      `If it's < 50, M-03 regressed and the monthly aggregate is back at the apply site.`);
  });

  it('exposes priceCompetitivenessPct for the lastRoundResult.roundSignals panel (M-21)', () => {
    // M-21: surfaces a 0–100 metric so the FE (B-07) can render
    // "What hurt this round?" indicators on Results. Pure passthrough
    // for the four already-computed signals; this metric is the new
    // computation. At catalog-base prices (croissant 4.75, cookie 4.0,
    // bagel 4.5 — all near competitive mid), the multiplier should
    // hover around 1.0 so the metric should land near 100.
    const out = runMonthlySimulation([fakePlayer('p_a')], prefs, config, {
      gameId: 'g1', round: 1,
    });
    const agg = out[0];
    assert.ok(typeof agg.priceCompetitivenessPct === 'number',
      'priceCompetitivenessPct should be a number');
    assert.ok(agg.priceCompetitivenessPct >= 0 && agg.priceCompetitivenessPct <= 100,
      `priceCompetitivenessPct should be in [0, 100], got ${agg.priceCompetitivenessPct}`);
    assert.ok(agg.priceCompetitivenessPct >= 90,
      `at near-mid prices, expected priceCompetitivenessPct >= 90, got ${agg.priceCompetitivenessPct}`);
  });

  it('priceCompetitivenessPct drops when prices move into the premium zone (M-21)', () => {
    // Premium prices reduce the demand multiplier below 1, which the
    // metric exposes as a sub-100 value — that's the signal we want
    // surfacing on the Results panel.
    const cheap = fakePlayer('cheap', {
      decision: {
        menu: { croissant: true, cookie: true, bagel: true },
        quantities: { croissant: 200, cookie: 200, bagel: 200 },
        sousChefCount: 1,
        sousChefAssignments: { croissant: 1 },
        productPrices: { croissant: 4.75, cookie: 4.0, bagel: 4.5 },
      },
    });
    const premium = fakePlayer('premium', {
      decision: {
        menu: { croissant: true, cookie: true, bagel: true },
        quantities: { croissant: 200, cookie: 200, bagel: 200 },
        sousChefCount: 1,
        sousChefAssignments: { croissant: 1 },
        // Push every price into the premium zone of its config range.
        productPrices: { croissant: 7.0, cookie: 6.0, bagel: 6.0 },
      },
    });
    const out = runMonthlySimulation([cheap, premium], prefs, config, {
      gameId: 'g1', round: 1,
    });
    const cheapAgg = out.find((r) => r.playerId === 'cheap');
    const premiumAgg = out.find((r) => r.playerId === 'premium');
    assert.ok(premiumAgg.priceCompetitivenessPct < cheapAgg.priceCompetitivenessPct,
      `premium-priced team should have a LOWER priceCompetitivenessPct than cheap. ` +
      `premium=${premiumAgg.priceCompetitivenessPct}, cheap=${cheapAgg.priceCompetitivenessPct}`);
  });

});
