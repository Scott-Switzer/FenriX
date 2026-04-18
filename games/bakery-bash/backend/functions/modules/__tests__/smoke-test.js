// Quick smoke test — run with: node _smoke_test.js
const config = require('../config');
const chefSys = require('../chef-system');
const sat = require('../satisfaction');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ---------- config ----------
const cfg = config.mergeConfig({});
assert(cfg.startingBudget === 500000, 'startingBudget default');
assert(cfg.sousChefBaseCost === 12500, 'sousChefBaseCost default');
assert(cfg.adBonuses.TV === 50000, 'adBonuses.TV default');
assert(cfg.returningCustomerBonuses.excellent === 0.15, 'returning excellent');

// User overrides (and a bad value)
const cfg2 = config.mergeConfig({
  startingBudget: 3000,
  sousChefBaseCost: 'not a number',
  adBonuses: { TV: 999 },
});
assert(cfg2.startingBudget === 3000, 'override startingBudget');
assert(cfg2.sousChefBaseCost === 12500, 'bad value → default');
assert(cfg2.adBonuses.TV === 999, 'override TV');
assert(cfg2.adBonuses.Radio === 25000, 'untouched Radio');

assert(config.numberOrDefault('7', 0) === 7, 'numberOrDefault string');
assert(config.numberOrDefault(undefined, 5) === 5, 'numberOrDefault undefined');
assert(config.cleanString('  hi ') === 'hi', 'cleanString');

assert(config.PRODUCT_KEYS.length === 6, 'product keys len');
assert(config.CHEF_SPAWN_RATES.length === 5, 'spawn rates rounds');
for (const r of config.CHEF_SPAWN_RATES) {
  assert(near(r.novel + r.intermediate + r.advanced, 1.0), 'spawn rate sum = 1');
}

// ---------- chef-system ----------
// Chef output
const frenchAdv = { skillTier: 'advanced', specialties: ['croissant', 'coffee'] };
assert(chefSys.getChefOutputForProduct(frenchAdv, 'croissant') === 30 * 2.2, 'french adv croissant');
assert(chefSys.getChefOutputForProduct(frenchAdv, 'bagel') === 30 * 1.6, 'french adv bagel');
assert(chefSys.getChefOutputForProduct({ skillTier: 'base' }, 'croissant') === 30, 'base chef');

// Total output with sous chef (head chef = advanced french on croissant → 66; sous = 0.5×66 = 33)
const total = chefSys.calculateTotalProductOutput(
  'croissant',
  [frenchAdv],
  { croissant: 1 },
);
// base(30) + frenchAdv(66) + sous(33) = 129
assert(near(total, 129), `croissant total = ${total}`);

// No specialty chef → sous falls back to base chef (30) so sous = 15
const total2 = chefSys.calculateTotalProductOutput('matcha', [frenchAdv], { matcha: 1 });
// base(30) + frenchAdv on matcha (non-specialty, 30×1.6=48) + sous 0.5×30=15 (no matcha specialty on team) = 93
assert(near(total2, 93), `matcha total = ${total2}`);

// Kitchen cohesion
assert(chefSys.calculateChefSatisfactionScore(4, cfg) === 100, 'cohesion 4');
assert(chefSys.calculateChefSatisfactionScore(5, cfg) === 84, 'cohesion 5');
assert(chefSys.calculateChefSatisfactionScore(8, cfg) === 36, 'cohesion 8');
assert(chefSys.calculateChefSatisfactionScore(9, cfg) === 35, 'cohesion 9 floor');
assert(chefSys.calculateChefSatisfactionScore(100, cfg) === 35, 'cohesion huge floor');

// Effective output
assert(chefSys.calculateEffectiveOutput(200, 50) === 100, 'effective output');

// Sous chef hire cost
assert(chefSys.getSousChefCost(0, cfg) === 12500, 'sous 1 cost');         // 1.0 × 12500
assert(chefSys.getSousChefCost(1, cfg) === 18750, 'sous 2 cost');         // 1.5 × 12500
assert(chefSys.getSousChefCost(2, cfg) === 28125, 'sous 3 cost');         // 2.25 × 12500
assert(chefSys.getSousChefCost(3, cfg) === 37500, 'sous 4 cost');         // 3.0 × 12500
assert(chefSys.getSousChefCost(4, cfg) === (3.0 + 0.75) * 12500, 'sous 5 cost');
assert(chefSys.getSousChefCost(5, cfg) === (3.0 + 1.5) * 12500, 'sous 6 cost');
assert(near(chefSys.getTotalSousChefHireCost(4, cfg), 12500 + 18750 + 28125 + 37500), 'total hire 4');

// Auction
const chefPool = [
  { id: 'A' }, { id: 'B' }, { id: 'C' },
];
const bids = [
  { playerId: 'p1', chefId: 'A', amount: 100, submittedAt: 10 },
  { playerId: 'p2', chefId: 'A', amount: 100, submittedAt: 5 }, // earlier wins tiebreak
  { playerId: 'p1', chefId: 'B', amount: 50,  submittedAt: 1 },
  // C has no bids
];
const auc = chefSys.resolveChefAuction(chefPool, bids);
assert(auc.winners.get('p2').length === 1 && auc.winners.get('p2')[0].id === 'A', 'p2 wins A via earlier timestamp');
assert(auc.winners.get('p1').length === 1 && auc.winners.get('p1')[0].id === 'B', 'p1 wins B');
assert(auc.payments.get('p1') === 50 && auc.payments.get('p2') === 100, 'payments');

// Pool generation
const pool = chefSys.generateChefPool(1, cfg);
assert(pool.length >= 6 && pool.length <= 8, `pool size ${pool.length}`);
for (const c of pool) {
  assert(typeof c.id === 'string', 'chef id');
  assert(['novel', 'intermediate', 'advanced'].includes(c.skillTier), 'skill tier');
  assert(Array.isArray(c.specialties) && c.specialties.length === 2, 'specialties');
  assert(c.minBidFloor > 0, 'min bid floor');
}

// ---------- satisfaction ----------
assert(sat.calculateFillRate(60, 60) === 1, 'fill 1.0');
assert(sat.calculateFillRate(30, 60) === 0.5, 'fill 0.5');
assert(sat.calculateFillRate(10, 0) === 0, 'fill div0');

// Fill-rate → satisfaction tier boundaries
assert(sat.fillRateToSatisfactionPct(0) === 0, 'fr 0 → 0');
assert(near(sat.fillRateToSatisfactionPct(0.49), 0 + (0.49/0.50) * 20), 'critical mid');
assert(sat.fillRateToSatisfactionPct(0.50) === 21, 'fr 0.50 → 21 (start of poor)');
// fr 0.60: poor band [0.50, 0.70), position 0.5 → 21 + 0.5×(45-21) = 33
assert(near(sat.fillRateToSatisfactionPct(0.60), 33), 'poor mid 33');
// Fill rate 1.0 enters the excellent band (Infinity upper bound → position 0 → minSat 86)
assert(sat.fillRateToSatisfactionPct(1.00) === 86, 'fr 1.0 → start of excellent (86)');
// Fill rate far above 1.0: our impl returns minSat because band size is Infinity (position → 0)
// and also surplus should never penalize. Both behaviors are acceptable; verify it's in excellent.
const surplus = sat.fillRateToSatisfactionPct(2.00);
assert(surplus >= 86 && surplus <= 100, `fr 2.0 in excellent (got ${surplus})`);

// Per product + aggregate
const playerState = {
  menu: { croissant: true, coffee: true, cookie: true, bagel: false, sandwich: false, matcha: false },
  effectiveOutputs: { croissant: 60, coffee: 42, cookie: 50 }, // fill rates: 1.0, 0.6, 1.0
};
const pps = sat.calculatePerProductSatisfaction(playerState);
// fill rate 1.0 → enters excellent band at 86
assert(pps.croissant.satisfactionPct === 86, `croissant 86 got ${pps.croissant.satisfactionPct}`);
assert(pps.croissant.tier === 'excellent', 'croissant tier excellent');
// coffee fill rate 0.6 → poor band, midpoint → 33
assert(near(pps.coffee.satisfactionPct, 33), `coffee 33 got ${pps.coffee.satisfactionPct}`);
assert(pps.coffee.tier === 'poor', 'coffee tier poor');
assert(pps.cookie.satisfactionPct === 86, 'cookie 86');
assert(pps.bagel === null, 'bagel null');

const agg = sat.calculateAggregateSatisfaction(pps);
// weights: croissant 1.2, coffee 1.5, cookie 1.0 → total 3.7
// weighted = 86×1.2 + 33×1.5 + 86×1.0
const expectedAgg = (86 * 1.2 + 33 * 1.5 + 86 * 1.0) / 3.7;
void expectedAgg;
assert(near(agg.aggregateSatisfactionPct, expectedAgg, 1e-4), `aggregate ${agg.aggregateSatisfactionPct}`);

// Foot traffic modifier — satisfaction 100%, croissant excellent (+10%), 3 products (no variety), 2 sous (+10%)
const ftm = sat.getFootTrafficModifier(100, pps, 3, 2);
// satMod = (100-50)/50 * 0.4 = 0.4; premium = 0.10 (croissant at 86 = excellent); variety = 0; sous = 0.10
assert(near(ftm, 0.4 + 0.10 + 0 + 0.10), `ftm ${ftm}`);

// Returning customers
assert(near(sat.getReturningCustomerBonus(90, 100, cfg), 15), 'excellent returning');
assert(near(sat.getReturningCustomerBonus(70, 100, cfg), 8), 'good returning');
assert(sat.getReturningCustomerBonus(50, 100, cfg) === 0, 'adequate returning 0');

// Sell-out
const ppsForSellout = {
  croissant: { fillRate: 1.2, satisfactionPct: 100, tier: 'excellent' },
  coffee: { fillRate: 0.5, satisfactionPct: 21, tier: 'poor' },
  cookie: null,
};
const so = sat.applySellOut(
  ppsForSellout,
  { croissant: 50, coffee: 70 },
  { croissant: 50, coffee: 35 }, // croissant sold out; coffee didn't
);
assert(so.perProductSatisfaction.croissant.satisfactionPct === 45, 'croissant capped');
assert(so.perProductSatisfaction.croissant.tier === 'poor', 'croissant tier poor');
assert(so.selloutFlags.croissant === true, 'croissant sellout flag');
assert(so.perProductSatisfaction.coffee.satisfactionPct === 21, 'coffee unchanged');
assert(so.selloutFlags.coffee === false, 'coffee not sold out');
assert(so.perProductSatisfaction.cookie === null, 'cookie null preserved');

console.log('ALL SMOKE TESTS PASSED');
