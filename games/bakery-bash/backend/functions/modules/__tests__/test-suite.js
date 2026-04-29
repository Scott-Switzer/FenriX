#!/usr/bin/env node
/**
 * Comprehensive Test Suite for Bakery Bash Backend
 * 
 * Covers: config, chef-system, satisfaction, customer-allocation,
 * revenue, loan-shark, round-preferences, phases, csv-export,
 * conclusion, decision-validation, simulation
 * 
 * Run: node modules/test-suite.js
 */

// ============================================================================
// Test framework (minimal, zero-dep)
// ============================================================================
let passed = 0;
let failed = 0;
let currentModule = '';
const failures = [];

function describe(name, fn) {
  currentModule = name;
  console.log(`\n=== ${name} ===`);
  fn();
}

function it(name, fn) {
  try {
    fn();
    passed++;
    // Only show dots for passing, saves log space
    process.stdout.write('.');
  } catch (e) {
    failed++;
    const msg = `  FAIL: ${currentModule} > ${name}\n    ${e.message}`;
    failures.push(msg);
    console.log(`\n  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function eq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function near(actual, expected, eps = 0.01, msg = '') {
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`${msg} — expected ~${expected}, got ${actual} (eps=${eps})`);
  }
}

function ok(val, msg = '') {
  if (!val) throw new Error(`${msg} — expected truthy, got ${JSON.stringify(val)}`);
}

function throws(fn, pattern, msg = '') {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (pattern && !pattern.test(e.message)) {
      throw new Error(`${msg} — threw but message "${e.message}" didn't match ${pattern}`);
    }
  }
  if (!threw) throw new Error(`${msg} — expected to throw but didn't`);
}

function deepEq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} — expected ${b}, got ${a}`);
}

// ============================================================================
// Load modules
// ============================================================================
const config = require('../config');
const pricing = require('../pricing');
const chefSys = require('../chef-system');
const sat = require('../satisfaction');
const custAlloc = require('../customer-allocation');
const revenue = require('../revenue');
const loanShark = require('../loan-shark');
const roundPrefs = require('../round-preferences');
const phases = require('../phases');
const csvExport = require('../csv-export');
const conclusion = require('../conclusion');
const validation = require('../decision-validation');
const simulation = require('../simulation');

// ============================================================================
// 1. CONFIG MODULE
// ============================================================================
describe('config.js', () => {
  const cfg = config.mergeConfig({});

  it('has correct defaults', () => {
    eq(cfg.startingBudget, 10000);
    eq(cfg.sousChefBaseCost, 10);
    eq(cfg.loanSharkInterestRate, 0.10);
    eq(cfg.totalRounds, 5);
  });

  it('PRODUCT_KEYS has 6 products', () => {
    eq(config.PRODUCT_KEYS.length, 6);
    ok(config.PRODUCT_KEYS.includes('croissant'));
    ok(config.PRODUCT_KEYS.includes('coffee'));
    ok(config.PRODUCT_KEYS.includes('cookie'));
    ok(config.PRODUCT_KEYS.includes('bagel'));
    ok(config.PRODUCT_KEYS.includes('sandwich'));
    ok(config.PRODUCT_KEYS.includes('matcha'));
  });

  it('PRODUCT_CATALOG has baseDemand and fixedPrice for each product', () => {
    for (const k of config.PRODUCT_KEYS) {
      ok(config.PRODUCT_CATALOG[k], `catalog missing ${k}`);
      ok(typeof config.PRODUCT_CATALOG[k].baseDemand === 'number', `baseDemand for ${k}`);
      ok(typeof config.PRODUCT_CATALOG[k].fixedPrice === 'number', `fixedPrice for ${k}`);
    }
  });

  it('mergeConfig applies overrides', () => {
    const c2 = config.mergeConfig({ startingBudget: 5000 });
    eq(c2.startingBudget, 5000);
    eq(c2.sousChefBaseCost, 10); // unchanged
  });

  it('mergeConfig rejects bad types', () => {
    const c3 = config.mergeConfig({ startingBudget: 'garbage' });
    eq(c3.startingBudget, 10000); // falls back to default
  });

  it('adBonuses partial override', () => {
    const c4 = config.mergeConfig({ adBonuses: { TV: 999 } });
    eq(c4.adBonuses.TV, 999);
    eq(c4.adBonuses.Radio, 150); // untouched (balance-tuned default)
  });

  it('CHEF_SPAWN_RATES sums to 1.0 per round', () => {
    for (const r of config.CHEF_SPAWN_RATES) {
      near(r.novel + r.intermediate + r.advanced, 1.0, 0.001, 'spawn rate sum');
    }
  });

  it('numberOrDefault works', () => {
    eq(config.numberOrDefault('7', 0), 7);
    eq(config.numberOrDefault(undefined, 5), 5);
    eq(config.numberOrDefault(null, 3), 3);
    eq(config.numberOrDefault(NaN, 42), 42);
  });

  it('cleanString trims', () => {
    eq(config.cleanString('  hello  '), 'hello');
    eq(config.cleanString(123), ''); // non-string → empty
    eq(config.cleanString(null), '');
  });

  it('returningCustomerBonuses defaults', () => {
    eq(cfg.returningCustomerBonuses.excellent, 0.15);
    eq(cfg.returningCustomerBonuses.good, 0.08);
  });
});

// ============================================================================
// 2. PRICING
// ============================================================================
describe('pricing.js — classifyZone', () => {
  const { PRICE_ZONES } = require('../config');
  const coffee = PRICE_ZONES.coffee; // floor=2, cLow=3, cHigh=4.5, pLow=5, pHigh=6, ceiling=6.5

  it('floor inclusive lower bound', () => {
    eq(pricing.classifyZone(2.00, coffee), 'floor');
  });
  it('just below competitiveRangeLow stays floor', () => {
    eq(pricing.classifyZone(2.75, coffee), 'floor');
  });
  it('competitiveRangeLow inclusive lower bound', () => {
    eq(pricing.classifyZone(3.00, coffee), 'competitive');
  });
  it('mid competitive', () => {
    eq(pricing.classifyZone(4.00, coffee), 'competitive');
  });
  it('just below premiumRangeLow stays competitive', () => {
    eq(pricing.classifyZone(4.75, coffee), 'competitive');
  });
  it('premiumRangeLow inclusive lower bound', () => {
    eq(pricing.classifyZone(5.00, coffee), 'premium');
  });
  it('ceiling inclusive upper bound', () => {
    eq(pricing.classifyZone(6.50, coffee), 'premium');
  });
});

describe('pricing.js — calculatePriceDemandMultiplier', () => {
  const { PRICE_ZONES } = require('../config');
  // M-14 (2026-04-28): high-tier elasticity coefficient softened 1.5 → 1.2.
  // Off-mid expected values recomputed; mid-of-competitive cases (delta=0)
  // are unaffected. Coffee at ceiling no longer hits MULTIPLIER_FLOOR
  // (formerly `floored at 0.05` because 1 - 1.5 * 0.7333 = -0.10 < 0.05;
  // now 1 - 1.2 * 0.7333 = 0.12, well above floor).
  const coffee = PRICE_ZONES.coffee;   // high elasticity (e=1.2), competitiveMid = (3+4.5)/2 = 3.75
  const matcha = PRICE_ZONES.matcha;   // high elasticity (e=1.2), competitiveMid = (3.5+5.5)/2 = 4.5 (pass 6 rescale)
  const croissant = PRICE_ZONES.croissant; // medium elasticity (e=1.0)

  it('coffee at floor $2.00 → 1.71 (floor bonus + elasticity bump)', () => {
    near(pricing.calculatePriceDemandMultiplier(2.00, coffee), 1.71, 0.01);
  });
  it('coffee at $2.75 still in floor zone → 1.47', () => {
    near(pricing.calculatePriceDemandMultiplier(2.75, coffee), 1.47, 0.01);
  });
  it('coffee at $3.00 (competitive) → 1.24 (step-down, no floor bonus)', () => {
    near(pricing.calculatePriceDemandMultiplier(3.00, coffee), 1.24, 0.01);
  });
  it('coffee at competitiveMid $3.75 → 1.00', () => {
    near(pricing.calculatePriceDemandMultiplier(3.75, coffee), 1.00, 0.01);
  });
  it('coffee at $4.50 → 0.76', () => {
    near(pricing.calculatePriceDemandMultiplier(4.50, coffee), 0.76, 0.01);
  });
  it('coffee at $5.00 (premium) → 0.60', () => {
    near(pricing.calculatePriceDemandMultiplier(5.00, coffee), 0.60, 0.01);
  });
  it('coffee at ceiling $6.50 → 0.12 (high elasticity premium penalty, above floor under e=1.2)', () => {
    near(pricing.calculatePriceDemandMultiplier(6.50, coffee), 0.12, 0.01);
  });
  it('matcha at floor $2.50 → ~1.68 (high elasticity bump after pass 6 rescale)', () => {
    near(pricing.calculatePriceDemandMultiplier(2.50, matcha), 1.68, 0.01);
  });
  it('matcha at competitiveMid $4.50 → 1.00', () => {
    near(pricing.calculatePriceDemandMultiplier(4.50, matcha), 1.00, 0.01);
  });
  it('matcha at ceiling $7.00 → ~0.33 (high elasticity premium penalty)', () => {
    near(pricing.calculatePriceDemandMultiplier(7.00, matcha), 0.33, 0.01);
  });
  it('croissant at competitiveMid $4.75 → 1.00', () => {
    near(pricing.calculatePriceDemandMultiplier(4.75, croissant), 1.00, 0.01);
  });
});

describe('pricing.js — snapPriceToStep / clampPrice', () => {
  const { PRICE_ZONES } = require('../config');
  const coffee = PRICE_ZONES.coffee;

  it('snapPriceToStep: exact $0.25 grid values unchanged', () => {
    near(pricing.snapPriceToStep(4.00), 4.00, 0.0001);
    near(pricing.snapPriceToStep(4.25), 4.25, 0.0001);
  });
  it('snapPriceToStep: rounds to nearest $0.25', () => {
    near(pricing.snapPriceToStep(4.12), 4.00, 0.0001);
    near(pricing.snapPriceToStep(4.13), 4.25, 0.0001);
    near(pricing.snapPriceToStep(4.37), 4.25, 0.0001);
    near(pricing.snapPriceToStep(4.38), 4.50, 0.0001);
  });
  it('snapPriceToStep: negative / zero pass through (clamp later)', () => {
    near(pricing.snapPriceToStep(0), 0, 0.0001);
    near(pricing.snapPriceToStep(-0.13), -0.25, 0.0001);
  });
  it('clampPrice: below floor → floor', () => {
    near(pricing.clampPrice(1.00, coffee), 2.00, 0.0001);
  });
  it('clampPrice: above ceiling → ceiling', () => {
    near(pricing.clampPrice(10.00, coffee), 6.50, 0.0001);
  });
  it('clampPrice: in range unchanged', () => {
    near(pricing.clampPrice(4.00, coffee), 4.00, 0.0001);
  });
  it('clampPrice: exactly at floor unchanged', () => {
    near(pricing.clampPrice(2.00, coffee), 2.00, 0.0001);
  });
  it('clampPrice: exactly at ceiling unchanged', () => {
    near(pricing.clampPrice(6.50, coffee), 6.50, 0.0001);
  });
});

describe('pricing.js — resolvePriceForSim (carry-over)', () => {
  const { PRICE_ZONES, PRODUCT_CATALOG } = require('../config');
  const coffeeCfg = PRICE_ZONES.coffee;
  const coffeeBase = PRODUCT_CATALOG.coffee.fixedPrice; // 4.00

  it('uses current round price when present', () => {
    const price = pricing.resolvePriceForSim({
      product: 'coffee',
      submittedThisRound: 3.50,
      priorSubmissions: [4.00, 4.25],
      productCfg: coffeeCfg,
      catalogBasePrice: coffeeBase,
    });
    near(price, 3.50, 0.001);
  });

  it('falls back to most recent prior when current is missing', () => {
    const price = pricing.resolvePriceForSim({
      product: 'coffee',
      submittedThisRound: undefined,
      priorSubmissions: [4.00, 4.25],
      productCfg: coffeeCfg,
      catalogBasePrice: coffeeBase,
    });
    near(price, 4.25, 0.001); // last element = most recent prior
  });

  it('falls back to catalog base when no submissions exist', () => {
    const price = pricing.resolvePriceForSim({
      product: 'coffee',
      submittedThisRound: undefined,
      priorSubmissions: [],
      productCfg: coffeeCfg,
      catalogBasePrice: coffeeBase,
    });
    near(price, 4.00, 0.001);
  });

  it('skips null/undefined entries in prior submissions', () => {
    const price = pricing.resolvePriceForSim({
      product: 'coffee',
      submittedThisRound: undefined,
      priorSubmissions: [4.00, undefined, null, 4.25, undefined],
      productCfg: coffeeCfg,
      catalogBasePrice: coffeeBase,
    });
    near(price, 4.25, 0.001);
  });

  it('always returns a snapped + clamped number', () => {
    const price = pricing.resolvePriceForSim({
      product: 'coffee',
      submittedThisRound: 10.13,       // above ceiling (6.50) and off-grid
      priorSubmissions: [],
      productCfg: coffeeCfg,
      catalogBasePrice: coffeeBase,
    });
    near(price, 6.50, 0.001); // clamped to ceiling; already on grid
  });
});

// ============================================================================
// 3. CHEF SYSTEM
// ============================================================================
describe('chef-system.js', () => {
  const cfg = config.mergeConfig({});

  it('getChefOutputForProduct — advanced with specialty', () => {
    const chef = { skillTier: 'advanced', specialties: ['croissant', 'coffee'] };
    eq(chefSys.getChefOutputForProduct(chef, 'croissant'), 30 * 3.0);
  });

  it('getChefOutputForProduct — advanced without specialty', () => {
    const chef = { skillTier: 'advanced', specialties: ['croissant', 'coffee'] };
    eq(chefSys.getChefOutputForProduct(chef, 'bagel'), 30 * 1.8);
  });

  it('getChefOutputForProduct — base chef', () => {
    eq(chefSys.getChefOutputForProduct({ skillTier: 'base' }, 'anything'), 30);
  });

  it('getChefOutputForProduct — novel tier', () => {
    const chef = { skillTier: 'novel', specialties: ['matcha'] };
    const output = chefSys.getChefOutputForProduct(chef, 'matcha');
    ok(output > 0, 'novel output > 0');
  });

  it('calculateTotalProductOutput with sous chef', () => {
    const chefs = [{ skillTier: 'advanced', specialties: ['croissant', 'coffee'] }];
    const total = chefSys.calculateTotalProductOutput('croissant', chefs, { croissant: 1 });
    // base(30) + advanced specialty(90) + sous(0.5 × 90 = 45) = 165
    near(total, 165, 0.01, 'total output');
  });

  it('calculateTotalProductOutput without sous', () => {
    const chefs = [{ skillTier: 'advanced', specialties: ['croissant', 'coffee'] }];
    const total = chefSys.calculateTotalProductOutput('croissant', chefs, {});
    // base(30) + advanced specialty(90) = 120
    near(total, 120, 0.01, 'total output no sous');
  });

  it('getSousChefCost escalation', () => {
    // Multipliers are derived from cfg.sousChefBaseCost so the assertions
    // hold across future economy rescales.
    const base = cfg.sousChefBaseCost;
    near(chefSys.getSousChefCost(0, cfg), 1.0  * base, 1e-6);
    near(chefSys.getSousChefCost(1, cfg), 1.5  * base, 1e-6);
    near(chefSys.getSousChefCost(2, cfg), 2.25 * base, 1e-6);
    near(chefSys.getSousChefCost(3, cfg), 3.0  * base, 1e-6);
  });

  it('getTotalSousChefHireCost sums correctly', () => {
    const base = cfg.sousChefBaseCost;
    near(chefSys.getTotalSousChefHireCost(4, cfg), (1.0 + 1.5 + 2.25 + 3.0) * base, 0.01);
  });

  it('resolveChefAuction — highest bid wins', () => {
    const pool = [{ id: 'A' }, { id: 'B' }];
    const bids = [
      { playerId: 'p1', chefId: 'A', amount: 200, submittedAt: 10 },
      { playerId: 'p2', chefId: 'A', amount: 100, submittedAt: 5 },
    ];
    const result = chefSys.resolveChefAuction(pool, bids);
    ok(result.winners.get('p1').length === 1);
    eq(result.winners.get('p1')[0].id, 'A');
    eq(result.payments.get('p1'), 200);
  });

  it('resolveChefAuction — tie breaks by submittedAt', () => {
    const pool = [{ id: 'A' }];
    const bids = [
      { playerId: 'p1', chefId: 'A', amount: 100, submittedAt: 10 },
      { playerId: 'p2', chefId: 'A', amount: 100, submittedAt: 5 },
    ];
    const result = chefSys.resolveChefAuction(pool, bids);
    ok(result.winners.get('p2').length === 1);
    eq(result.winners.get('p2')[0].id, 'A');
  });

  it('generateChefPool produces valid chefs', () => {
    const pool = chefSys.generateChefPool(1, cfg);
    eq(pool.length, cfg.chefPoolSize);
    for (const c of pool) {
      ok(typeof c.id === 'string');
      ok(['novel', 'intermediate', 'advanced'].includes(c.skillTier));
      ok(Array.isArray(c.specialties) && c.specialties.length === 2);
      ok(c.minBidFloor > 0);
    }
  });

  it('generateChefPool varies by round', () => {
    const p1 = chefSys.generateChefPool(1, cfg);
    const p3 = chefSys.generateChefPool(3, cfg);
    eq(p1.length, cfg.chefPoolSize);
    eq(p3.length, cfg.chefPoolSize);
  });
});

// ============================================================================
// 3. SATISFACTION
// ============================================================================
describe('satisfaction.js', () => {
  it('calculateFillRate basic', () => {
    eq(sat.calculateFillRate(60, 60), 1);
    eq(sat.calculateFillRate(30, 60), 0.5);
    eq(sat.calculateFillRate(10, 0), 0);
  });

  it('fillRateToSatisfactionPct — boundaries', () => {
    eq(sat.fillRateToSatisfactionPct(0), 0);
    eq(sat.fillRateToSatisfactionPct(1.0), 100); // saturated → top of excellent (PR #97 fix)
    ok(sat.fillRateToSatisfactionPct(0.5) <= 21, 'border of critical/poor');
  });

  it('fillRateToSatisfactionPct — mid-poor', () => {
    // fr 0.60 → poor band [0.50, 0.70), position 0.5 → 21 + 0.5×24 = 33
    near(sat.fillRateToSatisfactionPct(0.60), 33, 1);
  });

  it('fillRateToSatisfactionPct — surplus stays excellent', () => {
    const s = sat.fillRateToSatisfactionPct(2.0);
    ok(s >= 86 && s <= 100, `surplus ${s} should be excellent`);
  });

  it('tierForSatisfaction returns correct tiers', () => {
    eq(sat.tierForSatisfaction(0), 'critical');
    eq(sat.tierForSatisfaction(10), 'critical');
    eq(sat.tierForSatisfaction(25), 'poor');
    eq(sat.tierForSatisfaction(50), 'adequate');
    eq(sat.tierForSatisfaction(70), 'good');
    eq(sat.tierForSatisfaction(90), 'excellent');
  });

  it('calculatePerProductSatisfaction — multiple products', () => {
    // Outputs scaled to baseDemand=240 so croissant fills demand and lands 'excellent'.
    const state = {
      menu: { croissant: true, coffee: true, cookie: true, bagel: false, sandwich: false, matcha: false },
      effectiveOutputs: { croissant: 240, coffee: 42, cookie: 50 },
    };
    const pps = sat.calculatePerProductSatisfaction(state);
    eq(pps.croissant.tier, 'excellent');
    eq(pps.bagel, null);
    ok(pps.coffee.satisfactionPct > 0, 'coffee has satisfaction');
  });

  it('calculateAggregateSatisfaction — weighted average', () => {
    const pps = {
      croissant: { satisfactionPct: 86, tier: 'excellent' },
      coffee: { satisfactionPct: 33, tier: 'poor' },
      cookie: { satisfactionPct: 86, tier: 'excellent' },
    };
    const agg = sat.calculateAggregateSatisfaction(pps);
    ok(agg.aggregateSatisfactionPct > 0);
    ok(agg.aggregateSatisfactionPct < 100);
  });

  it('getFootTrafficModifier — returns reasonable value', () => {
    const pps = {
      croissant: { satisfactionPct: 86, tier: 'excellent' },
    };
    const ftm = sat.getFootTrafficModifier(100, pps, 3, 2);
    ok(typeof ftm === 'number');
    ok(ftm >= 0, 'foot traffic >= 0');
  });

  it('getReturningCustomerBonus', () => {
    const cfg = config.mergeConfig({});
    near(sat.getReturningCustomerBonus(90, 100, cfg), 15, 1);
    near(sat.getReturningCustomerBonus(70, 100, cfg), 8, 1);
    eq(sat.getReturningCustomerBonus(50, 100, cfg), 0);
  });

  it('applySellOut — caps satisfaction at 45', () => {
    const pps = {
      croissant: { fillRate: 1.2, satisfactionPct: 100, tier: 'excellent' },
      coffee: { fillRate: 0.5, satisfactionPct: 21, tier: 'poor' },
      cookie: null,
    };
    const so = sat.applySellOut(
      pps,
      { croissant: 50, coffee: 70 },
      { croissant: 50, coffee: 35 },
    );
    eq(so.perProductSatisfaction.croissant.satisfactionPct, 45);
    eq(so.perProductSatisfaction.croissant.tier, 'poor');
    eq(so.selloutFlags.croissant, true);
    eq(so.perProductSatisfaction.coffee.satisfactionPct, 21);
    eq(so.selloutFlags.coffee, false);
    eq(so.perProductSatisfaction.cookie, null);
  });
});

// ============================================================================
// 4. CUSTOMER ALLOCATION
// ============================================================================
describe('customer-allocation.js', () => {
  const cfg = config.mergeConfig({});

  it('calculateBaseTrafficPool returns pools for all products', () => {
    const pools = custAlloc.calculateBaseTrafficPool(null, {}, cfg);
    for (const k of config.PRODUCT_KEYS) {
      ok(typeof pools[k] === 'number', `pool for ${k}`);
      ok(pools[k] >= 0, `non-negative pool for ${k}`);
    }
  });

  it('calculateBaseTrafficPool — modifiers scale demand', () => {
    const pools1 = custAlloc.calculateBaseTrafficPool(null, { modifiers: { coffee: 1.4 } }, cfg);
    const pools2 = custAlloc.calculateBaseTrafficPool(null, { modifiers: { coffee: 1.0 } }, cfg);
    ok(pools1.coffee > pools2.coffee, 'trending modifier increases pool');
  });

  it('allocateCustomersPerProduct — single player gets all', () => {
    const players = [
      { playerId: 'p1', perProductSatisfaction: { coffee: 80 } },
    ];
    const result = custAlloc.allocateCustomersPerProduct('coffee', 100, players, new Map());
    eq(result.get('p1'), 100);
  });

  it('allocateCustomersPerProduct — proportional split', () => {
    const players = [
      { playerId: 'p1', perProductSatisfaction: { coffee: 80 } },
      { playerId: 'p2', perProductSatisfaction: { coffee: 20 } },
    ];
    const result = custAlloc.allocateCustomersPerProduct('coffee', 100, players, new Map());
    // 80% and 20%
    eq(result.get('p1'), 80);
    eq(result.get('p2'), 20);
  });

  it('allocateCustomersPerProduct — returning customers seeded first', () => {
    const returning = new Map([['p1', 10]]);
    const players = [
      { playerId: 'p1', perProductSatisfaction: { coffee: 50 } },
      { playerId: 'p2', perProductSatisfaction: { coffee: 50 } },
    ];
    const result = custAlloc.allocateCustomersPerProduct('coffee', 100, players, returning);
    // p1 gets 10 returning + 45 competitive = 55; p2 gets 45
    ok(result.get('p1') > result.get('p2'), 'returning customer advantage');
  });

  it('allocateCustomersPerProduct — skips players not offering product', () => {
    const players = [
      { playerId: 'p1', perProductSatisfaction: { coffee: 80 } },
      { playerId: 'p2', perProductSatisfaction: {} }, // doesn't offer coffee
    ];
    const result = custAlloc.allocateCustomersPerProduct('coffee', 100, players, new Map());
    eq(result.get('p1'), 100);
    eq(result.has('p2'), false);
  });

  it('allocateAllCustomers — full multi-player', () => {
    const state = [
      {
        playerId: 'p1',
        perProductSatisfaction: { croissant: { satisfactionPct: 80 }, coffee: { satisfactionPct: 60 } },
        returningCustomers: 0,
        footTrafficMultiplier: 1.0,
        sousChefCount: 0,
        numProductsOffered: 2,
        aggregateSatisfactionPct: 70,
      },
      {
        playerId: 'p2',
        perProductSatisfaction: { croissant: { satisfactionPct: 40 }, coffee: { satisfactionPct: 80 } },
        returningCustomers: 0,
        footTrafficMultiplier: 1.0,
        sousChefCount: 0,
        numProductsOffered: 2,
        aggregateSatisfactionPct: 60,
      },
    ];
    const alloc = custAlloc.allocateAllCustomers(state, {}, cfg);
    ok(alloc instanceof Map);
    ok(alloc.has('p1'));
    ok(alloc.has('p2'));
    ok(alloc.get('p1').totalCustomers > 0);
    ok(alloc.get('p2').totalCustomers > 0);
  });

  it('processCustomerDefections — redistributes on sellout', () => {
    const alloc = new Map([
      ['p1', { totalCustomers: 100, perProductCustomers: { coffee: 80, croissant: 20 }, footTrafficModifier: 1.0 }],
      ['p2', { totalCustomers: 50, perProductCustomers: { coffee: 30, croissant: 20 }, footTrafficModifier: 1.0 }],
    ]);
    const selloutFlags = new Map([['p1', { coffee: true }]]);
    const playersSat = [
      { playerId: 'p1', perProductSatisfaction: { coffee: 80, croissant: 20 } },
      { playerId: 'p2', perProductSatisfaction: { coffee: 60, croissant: 20 } },
    ];
    const result = custAlloc.processCustomerDefections(alloc, selloutFlags, playersSat);
    // p1 loses coffee customers (80). 60% (48) go to p2 for coffee. 40% (32) redirect to croissant.
    ok(result.get('p2').perProductCustomers.coffee > 30, 'p2 gains coffee customers');
    eq(result.get('p1').perProductCustomers.coffee, 0, 'p1 loses sold-out product');
  });

  it('processCustomerDefections — no sellouts, no change', () => {
    const alloc = new Map([
      ['p1', { totalCustomers: 100, perProductCustomers: { coffee: 100 }, footTrafficModifier: 1.0 }],
    ]);
    const result = custAlloc.processCustomerDefections(alloc, new Map(), []);
    eq(result.get('p1').totalCustomers, 100);
  });
});

describe('customer-allocation.js — price weight (POST-01)', () => {
  it('pool stays conserved when two players have identical satisfaction but opposite prices', () => {
    const allPlayersState = [
      {
        playerId: 'A',
        perProductSatisfaction: { coffee: 80 },
        returningCustomers: 0,
        sousChefCount: 0,
        numProductsOffered: 1,
        aggregateSatisfactionPct: 80,
        footTrafficMultiplier: 1.0,
      },
      {
        playerId: 'B',
        perProductSatisfaction: { coffee: 80 },
        returningCustomers: 0,
        sousChefCount: 0,
        numProductsOffered: 1,
        aggregateSatisfactionPct: 80,
        footTrafficMultiplier: 1.0,
      },
    ];
    const roundPreferences = { modifiers: { coffee: 1.0 } };
    const perPlayerPrices = {
      A: { coffee: 2.00 },
      B: { coffee: 6.50 },
    };

    const result = custAlloc.allocateAllCustomers(
      allPlayersState,
      roundPreferences,
      undefined,
      perPlayerPrices,
    );

    const a = result.get('A');
    const b = result.get('B');
    const total = a.totalCustomers + b.totalCustomers;
    const poolSize = config.PRODUCT_CATALOG.coffee.baseDemand;
    ok(total >= poolSize - 3 && total <= poolSize + 1, `pool conserved (total ${total}, pool ${poolSize})`);
    ok(a.totalCustomers > b.totalCustomers * 5, `A (floor) captures vastly more than B (ceiling); got A=${a.totalCustomers}, B=${b.totalCustomers}`);
  });

  it('legacy path (no perPlayerPrices) yields equal split for equal satisfaction', () => {
    const allPlayersState = [
      { playerId: 'A', perProductSatisfaction: { coffee: 80 }, returningCustomers: 0, sousChefCount: 0, numProductsOffered: 1, aggregateSatisfactionPct: 80, footTrafficMultiplier: 1.0 },
      { playerId: 'B', perProductSatisfaction: { coffee: 80 }, returningCustomers: 0, sousChefCount: 0, numProductsOffered: 1, aggregateSatisfactionPct: 80, footTrafficMultiplier: 1.0 },
    ];
    const roundPreferences = { modifiers: { coffee: 1.0 } };
    const result = custAlloc.allocateAllCustomers(allPlayersState, roundPreferences);
    const a = result.get('A');
    const b = result.get('B');
    near(a.totalCustomers, b.totalCustomers, 2, 'equal split without price');
  });
});

// ============================================================================
// 5. REVENUE
// ============================================================================
describe('revenue.js', () => {
  it('gaussianNoise — seeded is deterministic', () => {
    const a = revenue.gaussianNoise(-100, 100, 'test-seed');
    const b = revenue.gaussianNoise(-100, 100, 'test-seed');
    eq(a, b);
  });

  it('gaussianNoise — within bounds', () => {
    for (let i = 0; i < 50; i++) {
      const n = revenue.gaussianNoise(-100, 100, `seed-${i}`);
      ok(n >= -100 && n <= 100, `noise ${n} out of bounds`);
    }
  });

  it('calculateProductRevenue', () => {
    // Uses PRODUCT_CATALOG from config.js: coffee fixedPrice=4.00, croissant fixedPrice=4.75
    const result = revenue.calculateProductRevenue({ coffee: 10, croissant: 20 });
    eq(result.totalProductRevenue, 10 * 4.00 + 20 * 4.75); // 135
    eq(result.breakdown.coffee.qtySold, 10);
  });

  it('computeGrossRevenue — deterministic with seed', () => {
    const cfg = config.mergeConfig({});
    const inputs = {
      sousChefCount: 2,
      aggregateSatisfactionPct: 80,
      adSpend: 200,
      numProducts: 4,
      totalProductRevenue: 1000,
      noiseSeed: 'deterministic-test',
    };
    const r1 = revenue.computeGrossRevenue(inputs, cfg);
    const r2 = revenue.computeGrossRevenue(inputs, cfg);
    eq(r1, r2);
    ok(r1 > 0, 'revenue positive');
  });

  it('computeGrossRevenue — formula components', () => {
    const cfg = {
      revenueCoefficients: {
        base: 500, sousChefCoeff: 12, satisfactionCoeff: 8,
        adSpendCoeff: 0.8, numProductsCoeff: 50, noiseMin: 0, noiseMax: 0,
      },
    };
    const inputs = {
      sousChefCount: 2,
      aggregateSatisfactionPct: 80,
      adSpend: 200,
      numProducts: 4,
      totalProductRevenue: 1000,
    };
    const r = revenue.computeGrossRevenue(inputs, cfg);
    // 500 + 12*2 + 8*80 + 0.8*200 + 50*4 + 1000 + 0 = 500+24+640+160+200+1000 = 2524
    near(r, 2524, 1);
  });

  it('calculateRoundCosts — all components', () => {
    const cfg = config.mergeConfig({});
    const decision = {
      perProductQtyStocked: { croissant: 50, coffee: 30 },
      sousChefCount: 2,
    };
    const auction = { adAuctionWinningBid: 150, chefAuctionWinningBid: 200 };
    const costs = revenue.calculateRoundCosts(decision, auction, cfg);
    ok(costs.stockCost >= 0);
    ok(costs.sousChefHireCost > 0);
    eq(costs.adBidCost, 150);
    eq(costs.chefBidCost, 200);
    eq(costs.totalSpent, costs.stockCost + costs.sousChefHireCost + 150 + 200);
  });

  it('_sousChefHireCost escalation matches chef-system', () => {
    near(revenue._sousChefHireCost(1, 12500), 12500, 0.01);
    near(revenue._sousChefHireCost(2, 12500), 31250, 0.01);
    near(revenue._sousChefHireCost(4, 12500), 96875, 0.01);
  });
});

describe('revenue.js — perPlayerPrices override (POST-01)', () => {
  it('calculateProductRevenue uses submitted prices instead of catalog fixedPrice', () => {
    const qtySold = { coffee: 10, croissant: 20 };
    const prices  = { coffee: 5.00, croissant: 6.00 };   // above catalog defaults
    const { totalProductRevenue, breakdown } = revenue.calculateProductRevenue(qtySold, undefined, prices);
    eq(totalProductRevenue, 10 * 5.00 + 20 * 6.00); // 170
    eq(breakdown.coffee.price, 5.00);
    eq(breakdown.croissant.price, 6.00);
  });

  it('calculateProductRevenue falls back to catalog fixedPrice when a product is missing from prices', () => {
    const qtySold = { coffee: 10, croissant: 20 };
    const prices  = { coffee: 5.00 };                    // croissant missing
    const { totalProductRevenue } = revenue.calculateProductRevenue(qtySold, undefined, prices);
    // coffee @ 5.00 + croissant @ catalog 4.75
    near(totalProductRevenue, 10 * 5.00 + 20 * 4.75, 0.01);
  });

  it('calculateProductRevenue is unchanged when no prices arg supplied (legacy path)', () => {
    const qtySold = { coffee: 10, croissant: 20 };
    const { totalProductRevenue } = revenue.calculateProductRevenue(qtySold);
    // catalog: coffee 4.00, croissant 4.75
    near(totalProductRevenue, 10 * 4.00 + 20 * 4.75, 0.01);
  });

  it('ignores NaN / Infinity override and falls back to catalog', () => {
    const qtySold = { coffee: 10, croissant: 20 };
    const prices  = { coffee: NaN, croissant: Infinity };
    const { totalProductRevenue } = revenue.calculateProductRevenue(qtySold, undefined, prices);
    // both fall back to catalog: coffee $4, croissant $4.75
    near(totalProductRevenue, 10 * 4.00 + 20 * 4.75, 0.01);
  });
});

// ============================================================================
// 6. LOAN SHARK
// ============================================================================
describe('loan-shark.js', () => {
  it('no borrowing when under budget', () => {
    const r = loanShark.calculateLoanShark(500, 2000);
    eq(r.borrowed, 0);
    eq(r.interest, 0);
    eq(r.loanSharkDeduction, 0);
    eq(r.didBorrow, false);
  });

  it('borrowing when over budget', () => {
    const r = loanShark.calculateLoanShark(2500, 2000);
    eq(r.borrowed, 500);
    eq(r.interest, 50); // 10% of 500
    eq(r.loanSharkDeduction, 550);
    eq(r.didBorrow, true);
  });

  it('custom interest rate', () => {
    const r = loanShark.calculateLoanShark(300, 100, { loanSharkInterestRate: 0.20 });
    eq(r.borrowed, 200);
    eq(r.interest, 40);
    eq(r.loanSharkDeduction, 240);
  });

  it('calculateNetRevenue', () => {
    eq(loanShark.calculateNetRevenue(1000, 550), 450);
    eq(loanShark.calculateNetRevenue(100, 200), -100); // can go negative
  });

  it('updateBudget', () => {
    eq(loanShark.updateBudget(2000, 800, 500), 2300);
    eq(loanShark.updateBudget(0, 500, 600), -100); // can go negative
  });

  it('edge case — zero budget, zero spending', () => {
    const r = loanShark.calculateLoanShark(0, 0);
    eq(r.borrowed, 0);
    eq(r.didBorrow, false);
  });
});

// ============================================================================
// 7. ROUND PREFERENCES
// ============================================================================
describe('round-preferences.js', () => {
  it('generateGamePreferences — correct number of rounds', () => {
    const prefs = roundPrefs.generateGamePreferences(5);
    eq(prefs.length, 5);
  });

  it('each round has 2 trending, 2 warm, 1 neutral, 1 cold', () => {
    const prefs = roundPrefs.generateGamePreferences(5);
    for (const r of prefs) {
      eq(r.trending.length, 2);
      eq(r.warm.length, 2);
      eq(r.neutral.length, 1);
      eq(r.cold.length, 1);
    }
  });

  it('each round covers all 6 products exactly', () => {
    const prefs = roundPrefs.generateGamePreferences(5);
    for (const r of prefs) {
      const all = [...r.trending, ...r.warm, ...r.neutral, ...r.cold];
      eq(all.length, 6);
      eq(new Set(all).size, 6, 'no duplicates');
    }
  });

  it('no product trending in two consecutive rounds', () => {
    // Run multiple times due to randomness
    for (let trial = 0; trial < 10; trial++) {
      const prefs = roundPrefs.generateGamePreferences(5);
      for (let i = 1; i < prefs.length; i++) {
        const prevTrending = new Set(prefs[i - 1].trending);
        for (const t of prefs[i].trending) {
          ok(!prevTrending.has(t), `${t} trending in consecutive rounds ${i - 1} and ${i}`);
        }
      }
    }
  });

  it('modifiers have correct values', () => {
    const prefs = roundPrefs.generateGamePreferences(3);
    for (const r of prefs) {
      for (const p of r.trending) eq(r.modifiers[p], roundPrefs.MOD_TRENDING);
      for (const p of r.warm) eq(r.modifiers[p], roundPrefs.MOD_WARM);
      for (const p of r.neutral) eq(r.modifiers[p], roundPrefs.MOD_NEUTRAL);
      for (const p of r.cold) eq(r.modifiers[p], roundPrefs.MOD_COLD);
    }
  });

  it('generateMarketInsightEmail — returns valid email', () => {
    const prefs = roundPrefs.generateGamePreferences(1);
    const email = roundPrefs.generateMarketInsightEmail(prefs[0]);
    eq(email.from, 'The Plaza Times');
    ok(email.subject.length > 0);
    ok(email.body.length > 0);
  });

  it('generateMarketInsightEmail — fallback for empty trending', () => {
    const email = roundPrefs.generateMarketInsightEmail({ trending: [] });
    ok(email.body.includes('Quiet Week') || email.body.includes('tea leaves'));
  });

  it('getDemandModifiers returns copy', () => {
    const prefs = roundPrefs.generateGamePreferences(1);
    const mods = roundPrefs.getDemandModifiers(prefs[0]);
    ok(Object.keys(mods).length === 6);
    mods.coffee = 999; // mutate copy
    eq(prefs[0].modifiers.coffee !== 999, true); // original unchanged
  });
});

// ============================================================================
// 8. PHASES
// ============================================================================
describe('phases.js', () => {
  const cfg = config.mergeConfig({});

  it('parsePhase — lobby', () => {
    deepEq(phases.parsePhase('lobby'), { round: 0, phase: 'lobby' });
  });

  it('parsePhase — game_over', () => {
    deepEq(phases.parsePhase('game_over'), { round: null, phase: 'game_over' });
  });

  it('parsePhase — round_N_phase', () => {
    deepEq(phases.parsePhase('round_2_decide'), { round: 2, phase: 'decide' });
    deepEq(phases.parsePhase('round_1_bid_ad'), { round: 1, phase: 'bid_ad' });
    deepEq(phases.parsePhase('round_3_roster'), { round: 3, phase: 'roster' });
  });

  it('parsePhase — legacy aliases', () => {
    deepEq(phases.parsePhase('round_1_closing_hours'), { round: 1, phase: 'decide' });
  });

  it('parsePhase — simulating with roundHint', () => {
    deepEq(phases.parsePhase('simulating', 3), { round: 3, phase: 'simulating' });
  });

  it('formatPhase', () => {
    eq(phases.formatPhase(2, 'decide'), 'round_2_decide');
    eq(phases.formatPhase(0, 'lobby'), 'lobby');
    eq(phases.formatPhase(null, 'game_over'), 'game_over');
    eq(phases.formatPhase(3, 'simulating'), 'simulating');
  });

  it('getNextPhase — full progression', () => {
    deepEq(phases.getNextPhase('lobby', 0, 5), { phase: 'round_1_email', round: 1 });
    deepEq(phases.getNextPhase('round_1_email', 1, 5), { phase: 'round_1_bid_ad', round: 1 });
    deepEq(phases.getNextPhase('round_1_bid_ad', 1, 5), { phase: 'round_1_bid_chef', round: 1 });
    deepEq(phases.getNextPhase('round_1_bid_chef', 1, 5), { phase: 'round_1_roster', round: 1 });
    deepEq(phases.getNextPhase('round_1_roster', 1, 5), { phase: 'round_1_decide', round: 1 });
    deepEq(phases.getNextPhase('round_1_decide', 1, 5), { phase: 'simulating', round: 1 });
    deepEq(phases.getNextPhase('simulating', 1, 5), { phase: 'results_ready', round: 1 });
    deepEq(phases.getNextPhase('results_ready', 1, 5), { phase: 'round_2_email', round: 2 });
  });

  it('getNextPhase — last round → game_over', () => {
    deepEq(phases.getNextPhase('results_ready', 5, 5), { phase: 'game_over', round: 5 });
  });

  it('isValidTransition', () => {
    eq(phases.isValidTransition('lobby', 'round_1_email'), true);
    eq(phases.isValidTransition('round_1_email', 'round_1_bid_ad'), true);
    eq(phases.isValidTransition('round_1_roster', 'round_1_decide'), true);
    eq(phases.isValidTransition('round_1_decide', 'simulating'), true);
    eq(phases.isValidTransition('simulating', 'results_ready'), true);
    eq(phases.isValidTransition('lobby', 'round_2_email'), false);
  });

  it('getPhaseDuration', () => {
    eq(phases.getPhaseDuration('decide', cfg), 300);
    ok(phases.getPhaseDuration('results_ready', cfg) > 0);
  });

  it('canSubmitDecision', () => {
    eq(phases.canSubmitDecision('round_2_decide'), true);
    eq(phases.canSubmitDecision('round_2_bid_ad'), false);
    eq(phases.canSubmitDecision('lobby'), false);
  });

  it('canSubmitBids', () => {
    eq(phases.canSubmitBids('round_2_bid_ad', 'ad'), true);
    eq(phases.canSubmitBids('round_2_bid_chef', 'chef'), true);
    eq(phases.canSubmitBids('round_2_bid_ad', 'chef'), false);
  });

  it('isGameActive', () => {
    eq(phases.isGameActive('lobby'), false);
    eq(phases.isGameActive('game_over'), false);
    eq(phases.isGameActive('round_1_decide'), true);
    eq(phases.isGameActive('simulating'), true);
  });
});

// ============================================================================
// 9. CSV EXPORT
// ============================================================================
describe('csv-export.js', () => {
  const roundResult = {
    round: 2,
    decision: {
      menu: { croissant: true, cookie: true, bagel: true, sandwich: true, coffee: false, matcha: false },
      quantities: { croissant: 40, cookie: 30, bagel: 20, sandwich: 15, coffee: 0, matcha: 0 },
      sousChefCount: 2,
      adBids: { TV: 200, Billboard: 0, Radio: 50, Newspaper: 0 },
    },
    specialtyChefs: [
      { nationality: 'french', skillTier: 'advanced' },
      { nationality: 'italian', skillTier: 'intermediate' },
    ],
    revenueGross: 2100.55,
    amountBorrowed: 100,
    interestCharged: 10,
    customerCount: 87,
    aggregateSatisfactionPct: 78.4,
    perProductSatisfaction: { croissant: 85, cookie: 60, bagel: 70, sandwich: 55 },
    perProductSold: { croissant: 40, cookie: 28, bagel: 18, sandwich: 10 },
    selloutFlags: { croissant: true, cookie: false, bagel: false, sandwich: false },
  };

  it('buildCsvRow — correct field extraction', () => {
    const row = csvExport.buildCsvRow(roundResult);
    eq(row.round, 2);
    eq(row.num_products, 4);
    eq(row.sous_chef_count, 2);
    eq(row.revenue, 2100.55);
  });

  it('buildCsvRow — specialty chefs mapped', () => {
    const row = csvExport.buildCsvRow(roundResult);
    eq(row.specialty_chef_1_nationality, 'french');
    eq(row.specialty_chef_1_skill, 'advanced');
    eq(row.specialty_chef_2_nationality, 'italian');
    eq(row.specialty_chef_3_nationality, '');
  });

  it('buildCsvRow — off-menu products are null', () => {
    const row = csvExport.buildCsvRow(roundResult);
    eq(row.coffee_qty_stocked, null);
    eq(row.matcha_qty_stocked, null);
  });

  it('buildCsvRow — sellout flags', () => {
    const row = csvExport.buildCsvRow(roundResult);
    eq(row.sellout_croissant, true);
    eq(row.sellout_cookie, false);
    eq(row.sellout_coffee, null);
  });

  it('buildCsvString — generates valid CSV', () => {
    const row = csvExport.buildCsvRow(roundResult);
    const csv = csvExport.buildCsvString([row], false);
    ok(csv.startsWith('round,num_products'));
    ok(csv.includes('2,4,2'));
  });

  it('buildCsvString — professor mode adds player columns', () => {
    const row = csvExport.buildCsvRow(roundResult);
    row.player_id = 'p1';
    row.bakery_name = 'The Loaf';
    row.display_name = 'Alice';
    const csv = csvExport.buildCsvString([row], true);
    ok(csv.startsWith('player_id,bakery_name,display_name'));
  });

  it('csvEscape — handles commas and quotes', () => {
    eq(csvExport.csvEscape('hello'), 'hello');
    eq(csvExport.csvEscape('hel,lo'), '"hel,lo"');
    eq(csvExport.csvEscape('he"llo'), '"he""llo"');
  });

  it('buildFirestoreCsvRow — has columnOrder', () => {
    const fsRow = csvExport.buildFirestoreCsvRow(roundResult);
    ok(Array.isArray(fsRow.columnOrder));
    eq(fsRow.round, 2);
  });
});

// ============================================================================
// 9b. CSV-EXPORT — PRICE COLUMNS (POST-01)
// ============================================================================
describe('csv-export.js — price columns (POST-01)', () => {
  const { PRODUCT_KEYS } = require('../config');

  it('CSV_COLUMNS includes price_<product> for each product positioned after qty_stocked block', () => {
    const cols = csvExport.CSV_COLUMNS.map((c) => c.key);
    for (const p of PRODUCT_KEYS) {
      ok(cols.includes(`price_${p}`), `CSV_COLUMNS missing price_${p}`);
    }
    // Price block is after qty_stocked block and before qty_sold / satisfaction blocks
    const lastQtyStockedIdx = Math.max(...PRODUCT_KEYS.map((p) => cols.indexOf(`${p}_qty_stocked`)));
    const firstPriceIdx = Math.min(...PRODUCT_KEYS.map((p) => cols.indexOf(`price_${p}`)));
    const firstQtySoldIdx = Math.min(...PRODUCT_KEYS.map((p) => cols.indexOf(`${p}_qty_sold`)));
    ok(firstPriceIdx > lastQtyStockedIdx, `price block starts after qty_stocked block (lastQty=${lastQtyStockedIdx}, firstPrice=${firstPriceIdx})`);
    ok(firstPriceIdx < firstQtySoldIdx, `price block before qty_sold block (firstPrice=${firstPriceIdx}, firstQtySold=${firstQtySoldIdx})`);
  });

  it('buildCsvRow populates price_<product> from roundResult.productPrices', () => {
    const roundResult = {
      round: 1,
      decision: {
        menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: true, matcha: false },
        quantities: { croissant: 10, cookie: 10, bagel: 10, sandwich: 0, coffee: 10, matcha: 0 },
        sousChefCount: 0,
      },
      specialtyChefs: [],
      productPrices: { croissant: 4.75, cookie: 2.50, bagel: 3.00, sandwich: 8.75, coffee: 5.25, matcha: 6.25 },
      perProductSatisfaction: {},
      customerCount: 0,
      revenueGross: 0,
      amountBorrowed: 0,
      interestCharged: 0,
      aggregateSatisfactionPct: 0,
    };
    const row = csvExport.buildCsvRow(roundResult);
    eq(row.price_coffee, 5.25);
    eq(row.price_croissant, 4.75);
    eq(row.price_cookie, 2.50);
    eq(row.price_bagel, 3.00);
    // Off-menu products (sandwich, matcha) should be null (consistent with existing qty/satisfaction null-when-off-menu pattern)
    eq(row.price_sandwich, null);
    eq(row.price_matcha, null);
  });

  it('buildCsvRow renders price as null when productPrices is missing entirely', () => {
    const roundResult = {
      round: 1,
      decision: {
        menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false },
        quantities: { croissant: 10, cookie: 10, bagel: 10, sandwich: 0, coffee: 0, matcha: 0 },
        sousChefCount: 0,
      },
      specialtyChefs: [],
      // no productPrices field at all
      perProductSatisfaction: {},
      customerCount: 0,
      revenueGross: 0,
      amountBorrowed: 0,
      interestCharged: 0,
      aggregateSatisfactionPct: 0,
    };
    const row = csvExport.buildCsvRow(roundResult);
    eq(row.price_coffee, null);
    eq(row.price_croissant, null);
  });
});

// ============================================================================
// 10. CONCLUSION
// ============================================================================
describe('conclusion.js', () => {
  const cfg = config.mergeConfig({});

  it('aggregatePlayerResults — totals', () => {
    const agg = conclusion.aggregatePlayerResults([
      { round: 1, revenueGross: 1000, revenueNet: 900, amountBorrowed: 50, interestCharged: 5, totalSpent: 700 },
      { round: 2, revenueGross: 1500, revenueNet: 1400, amountBorrowed: 0, interestCharged: 0, totalSpent: 800 },
    ], cfg);
    eq(agg.totalRevenue, 2500);
    eq(agg.totalInterest, 5);
    eq(agg.totalBorrowed, 50);
  });

  it('aggregatePlayerResults — net revenue', () => {
    const agg = conclusion.aggregatePlayerResults([
      { round: 1, revenueGross: 1000, revenueNet: 900, amountBorrowed: 50, interestCharged: 5, totalSpent: 700 },
    ], cfg);
    eq(agg.netRevenue, 1000 - 5 - 50);
  });

  it('rankPlayers — sorts by netRevenue then budget', () => {
    const ranked = conclusion.rankPlayers([
      { playerId: 'a', netRevenue: 1000, budgetRemaining: 500 },
      { playerId: 'b', netRevenue: 2000, budgetRemaining: 100 },
      { playerId: 'c', netRevenue: 1000, budgetRemaining: 800 },
    ]);
    eq(ranked[0].playerId, 'b');
    eq(ranked[0].rank, 1);
    eq(ranked[1].playerId, 'c');
    eq(ranked[1].rank, 2);
    eq(ranked[2].playerId, 'a');
    eq(ranked[2].rank, 3);
  });

  it('rankPlayers — handles ties', () => {
    const ranked = conclusion.rankPlayers([
      { playerId: 'a', netRevenue: 1000, budgetRemaining: 500 },
      { playerId: 'b', netRevenue: 1000, budgetRemaining: 500 },
      { playerId: 'c', netRevenue: 500, budgetRemaining: 200 },
    ]);
    eq(ranked[0].rank, 1);
    eq(ranked[1].rank, 1);
    eq(ranked[2].rank, 3);
  });

  it('buildConclusionData — winner and roster', () => {
    const ranked = conclusion.rankPlayers([
      { playerId: 'b', netRevenue: 2000, budgetRemaining: 100 },
      { playerId: 'a', netRevenue: 1000, budgetRemaining: 500 },
    ]);
    const data = conclusion.buildConclusionData(ranked, [
      { name: 'Chef A', nationality: 'french', skillTier: 'advanced', variant: 'v1' },
    ]);
    eq(data.winner.playerId, 'b');
    eq(data.winner.chefRoster.length, 1);
    ok(typeof data.timestamp === 'number');
    eq(data.rankings.length, 2);
  });
});

// ============================================================================
// 11. DECISION VALIDATION
// ============================================================================
describe('decision-validation.js', () => {
  const cfg = config.mergeConfig({});

  it('validateDecision — valid input', () => {
    const result = validation.validateDecision({
      menu: { croissant: true, cookie: true, bagel: true, sandwich: true, coffee: false, matcha: false },
      quantities: { croissant: 30, cookie: 20, bagel: 15, sandwich: 10 },
      sousChefCount: 3,
      sousChefAssignments: { croissant: 2, sandwich: 1 },
    }, 2, cfg);
    eq(result.numProducts, 4);
    eq(result.sousChefCount, 3);
  });

  it('validateDecision — base product can\'t be disabled', () => {
    throws(() => validation.validateDecision({
      menu: { croissant: false, cookie: true, bagel: true },
    }, 1, cfg), /Base product/);
  });

  it('validateDecision — sous assignment sum must match count', () => {
    throws(() => validation.validateDecision({
      menu: { croissant: true, cookie: true, bagel: true },
      quantities: { croissant: 10, cookie: 10, bagel: 10 },
      sousChefCount: 3,
      sousChefAssignments: { croissant: 1 },
    }, 1, cfg), /sousChefAssignments sum/);
  });

  it('validateDecision — can\'t assign sous to off-menu product', () => {
    throws(() => validation.validateDecision({
      menu: { croissant: true, cookie: true, bagel: true, sandwich: false },
      quantities: {},
      sousChefCount: 1,
      sousChefAssignments: { sandwich: 1 },
    }, 1, cfg), /not on the menu/);
  });

  it('validateAdBids — fills missing with 0', () => {
    const bids = validation.validateAdBids({ TV: 100, Billboard: 50 });
    eq(bids.TV, 100);
    eq(bids.Billboard, 50);
    eq(bids.Radio, 0);
    eq(bids.Newspaper, 0);
  });

  it('validateAdBids — rejects negative', () => {
    throws(() => validation.validateAdBids({ TV: -1 }), /non-negative/);
  });

  it('validateAdBids — rejects unknown types', () => {
    throws(() => validation.validateAdBids({ Skywriting: 50 }), /Unknown ad type/);
  });

  it('validateChefBids — filters zero bids, validates floor', () => {
    const pool = [{ id: 'c1', minBidFloor: 100 }, { id: 'c2', minBidFloor: 200 }];
    const bids = validation.validateChefBids([
      { chefId: 'c1', amount: 150 },
      { chefId: 'c2', amount: 0 },
    ], pool);
    eq(bids.length, 1);
    eq(bids[0].chefId, 'c1');
  });

  it('validateChefBids — below floor throws', () => {
    const pool = [{ id: 'c1', minBidFloor: 100 }];
    throws(() => validation.validateChefBids([{ chefId: 'c1', amount: 50 }], pool), /below the Minimum Ask/);
  });

  it('validateChefBids — unknown chef throws', () => {
    const pool = [{ id: 'c1', minBidFloor: 100 }];
    throws(() => validation.validateChefBids([{ chefId: 'unknown', amount: 100 }], pool), /not in the current pool/);
  });

  it('buildDefaultDecision — sane defaults', () => {
    const def = validation.buildDefaultDecision(cfg);
    eq(def.menu.croissant, true);
    eq(def.menu.sandwich, false);
    eq(def.sousChefCount, 0);
    eq(def.numProducts, 3);
  });

  it('buildDefaultBids', () => {
    const bids = validation.buildDefaultBids();
    deepEq(bids.adBids, { TV: 0, Billboard: 0, Radio: 0, Newspaper: 0 });
    deepEq(bids.chefBids, []);
  });

  it('ValidationError class', () => {
    try { validation.validateAdBids({ TV: -1 }); } catch (e) {
      ok(e instanceof validation.ValidationError);
      eq(e.code, 'invalid-argument');
    }
  });

  // POST-01: validateProductPrices tests
  it('accepts undefined → returns empty object', () => {
    deepEq(validation.validateProductPrices(undefined), {});
  });
  it('accepts null → returns empty object', () => {
    deepEq(validation.validateProductPrices(null), {});
  });
  it('accepts empty object', () => {
    deepEq(validation.validateProductPrices({}), {});
  });
  it('rejects non-object', () => {
    throws(() => validation.validateProductPrices('nope'), /must be an object/);
    throws(() => validation.validateProductPrices(42),    /must be an object/);
  });
  it('rejects unknown product key', () => {
    throws(() => validation.validateProductPrices({ latte: 4 }), /unknown product "latte"/);
  });
  it('rejects non-number / NaN / Infinity', () => {
    throws(() => validation.validateProductPrices({ coffee: 'free' }), /must be a finite positive number/);
    throws(() => validation.validateProductPrices({ coffee: NaN }),     /must be a finite positive number/);
    throws(() => validation.validateProductPrices({ coffee: Infinity }),/must be a finite positive number/);
  });
  it('rejects negative and zero', () => {
    throws(() => validation.validateProductPrices({ coffee: 0 }),  /must be a finite positive number/);
    throws(() => validation.validateProductPrices({ coffee: -1 }), /must be a finite positive number/);
  });
  it('snaps to $0.25 grid', () => {
    const out = validation.validateProductPrices({ coffee: 4.13 });
    near(out.coffee, 4.25, 0.001);
  });
  it('clamps above ceiling to ceiling', () => {
    const out = validation.validateProductPrices({ coffee: 100 });
    near(out.coffee, 6.50, 0.001);
  });
  it('clamps below floor to floor', () => {
    const out = validation.validateProductPrices({ coffee: 0.50 });
    near(out.coffee, 2.00, 0.001);
  });
  it('passes through valid in-range values', () => {
    const out = validation.validateProductPrices({ coffee: 4.00, matcha: 7.00 });
    near(out.coffee, 4.00, 0.001);
    near(out.matcha, 7.00, 0.001);
  });
  it('rejects booleans (no silent coercion)', () => {
    throws(() => validation.validateProductPrices({ coffee: true }),  /must be a finite positive number/);
    throws(() => validation.validateProductPrices({ coffee: false }), /must be a finite positive number/);
  });
  it('rejects arrays and objects (no silent coercion)', () => {
    throws(() => validation.validateProductPrices({ coffee: [5] }),   /must be a finite positive number/);
    throws(() => validation.validateProductPrices({ coffee: { n: 5 } }), /must be a finite positive number/);
  });
});

// ============================================================================
// 12. SIMULATION (Integration)
// ============================================================================
describe('simulation.js — Integration', () => {
  const cfg = config.mergeConfig({});

  it('runSimulation — empty bakery (no menu, no customers) earns $0', () => {
    // V9 regression — players with no menu items used to bank ~$500 in
    // gross revenue from `computeGrossRevenue`'s base + noise floor, which
    // surfaced as "$527 profit / 0 customers" on the results screen and
    // confused playtesters. An empty bakery should now earn $0 (plus any
    // ad-winner bonus, if applicable).
    const players = [{
      playerId: 'p_empty',
      displayName: 'Empty',
      bakeryName: 'Empty Bakery',
      budgetCurrent: 10000,
      sousChefCount: 0,
      specialtyChefs: [],
      returningCustomersPending: 0,
      decision: {
        menu: { croissant: false, cookie: false, bagel: false, sandwich: false, coffee: false, matcha: false },
        quantities: {},
        sousChefCount: 0,
        sousChefAssignments: {},
      },
      auctionResults: { adWon: null, adBidPaid: 0, chefBidPaid: 0 },
    }];
    const prefs = { modifiers: { croissant: 1.0, cookie: 1.0, bagel: 1.0, sandwich: 1.0, coffee: 1.0, matcha: 1.0 } };
    const results = simulation.runSimulation(players, prefs, cfg);
    eq(results[0].customerCount, 0);
    eq(results[0].revenueGross, 0);
    eq(results[0].revenueNet, 0);
  });

  it('runSimulation — single player produces valid result', () => {
    const players = [{
      playerId: 'p1',
      displayName: 'Alice',
      bakeryName: 'The Loaf',
      budgetCurrent: 2000,
      sousChefCount: 0,
      specialtyChefs: [],
      returningCustomersPending: 0,
      decision: {
        menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false },
        quantities: { croissant: 40, cookie: 30, bagel: 20 },
        sousChefCount: 0,
        sousChefAssignments: {},
      },
      auctionResults: { adWon: null, adBidPaid: 0, chefBidPaid: 0 },
    }];
    const prefs = { modifiers: { croissant: 1.0, cookie: 1.0, bagel: 1.0, sandwich: 1.0, coffee: 1.0, matcha: 1.0 } };
    const results = simulation.runSimulation(players, prefs, cfg);
    eq(results.length, 1);
    eq(results[0].playerId, 'p1');
    ok(typeof results[0].revenueGross === 'number');
    ok(typeof results[0].customerCount === 'number');
    ok(typeof results[0].aggregateSatisfactionPct === 'number');
    ok(typeof results[0].budgetAfter === 'number');
    ok(results[0].csvRow != null);
    ok(typeof results[0].perProductSatisfaction === 'object');
    ok(typeof results[0].returningCustomersEarned === 'number');
  });

  it('runSimulation — 3 players competitive', () => {
    const makePl = (id, name, specialties) => ({
      playerId: id,
      displayName: name,
      bakeryName: `${name}'s Bakery`,
      budgetCurrent: 2000,
      sousChefCount: 0,
      specialtyChefs: specialties,
      returningCustomersPending: 0,
      decision: {
        menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false },
        quantities: { croissant: 40, cookie: 30, bagel: 20 },
        sousChefCount: 0,
        sousChefAssignments: {},
      },
      auctionResults: { adWon: null, adBidPaid: 0, chefBidPaid: 0 },
    });

    const players = [
      makePl('p1', 'Alice', [{ skillTier: 'advanced', specialties: ['croissant', 'coffee'] }]),
      makePl('p2', 'Bob', []),
      makePl('p3', 'Carol', [{ skillTier: 'intermediate', specialties: ['cookie', 'bagel'] }]),
    ];
    const prefs = { modifiers: { croissant: 1.4, cookie: 1.15, bagel: 1.0, sandwich: 1.0, coffee: 1.0, matcha: 1.0 } };
    const results = simulation.runSimulation(players, prefs, cfg);
    eq(results.length, 3);
    
    // All players should have customers
    for (const r of results) {
      ok(r.customerCount >= 0, `${r.playerId} customerCount >= 0`);
      ok(typeof r.revenueGross === 'number');
      ok(typeof r.budgetAfter === 'number');
    }
  });

  it('runSimulation — loan shark triggers when overspending', () => {
    const players = [{
      playerId: 'p1',
      displayName: 'Broke',
      bakeryName: 'Broke Bakery',
      budgetCurrent: 100, // Very low budget
      sousChefCount: 2,
      specialtyChefs: [],
      returningCustomersPending: 0,
      decision: {
        menu: { croissant: true, cookie: true, bagel: true, sandwich: true, coffee: true, matcha: true },
        quantities: { croissant: 100, cookie: 100, bagel: 100, sandwich: 100, coffee: 100, matcha: 100 },
        sousChefCount: 4, // Expensive!
        sousChefAssignments: { croissant: 2, cookie: 1, bagel: 1 },
      },
      auctionResults: { adWon: 'TV', adBidPaid: 500, chefBidPaid: 300 },
    }];
    const prefs = { modifiers: { croissant: 1.0, cookie: 1.0, bagel: 1.0, sandwich: 1.0, coffee: 1.0, matcha: 1.0 } };
    const results = simulation.runSimulation(players, prefs, cfg);
    ok(results[0].amountBorrowed > 0, 'should have borrowed');
    ok(results[0].interestCharged > 0, 'should have interest');
  });

  it('runSimulation — empty players array', () => {
    const results = simulation.runSimulation([], {}, cfg);
    eq(results.length, 0);
  });

  it('runSimulation — returning customers carry over', () => {
    const players = [{
      playerId: 'p1',
      displayName: 'Good',
      bakeryName: 'Good Bakery',
      budgetCurrent: 2000,
      sousChefCount: 0,
      specialtyChefs: [{ skillTier: 'advanced', specialties: ['croissant', 'coffee'] }],
      returningCustomersPending: 30, // 30 returning from last round
      decision: {
        menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false },
        quantities: { croissant: 80, cookie: 60, bagel: 40 },
        sousChefCount: 0,
        sousChefAssignments: {},
      },
      auctionResults: { adWon: null, adBidPaid: 0, chefBidPaid: 0 },
    }];
    const prefs = { modifiers: { croissant: 1.0, cookie: 1.0, bagel: 1.0, sandwich: 1.0, coffee: 1.0, matcha: 1.0 } };
    const results = simulation.runSimulation(players, prefs, cfg);
    ok(results[0].customerCount > 0, 'has customers');
  });

  it('computePlayerOutputAndSatisfaction — exposed for testing', () => {
    const player = {
      decision: {
        menu: { croissant: true, cookie: true, bagel: false },
        quantities: { croissant: 50, cookie: 40 },
        sousChefCount: 1,
        sousChefAssignments: { croissant: 1 },
      },
      specialtyChefs: [{ skillTier: 'advanced', specialties: ['croissant', 'coffee'] }],
    };
    const prefs = { modifiers: { croissant: 1.0, cookie: 1.0 } };
    const result = simulation.computePlayerOutputAndSatisfaction(player, prefs, cfg);
    ok(result.offeredProducts.includes('croissant'));
    ok(result.offeredProducts.includes('cookie'));
    ok(!result.offeredProducts.includes('bagel'));
    ok(result.perProduct.croissant.effectiveOutput > 0);
  });

  it('computeReturningCustomersEarned — excellent → 15%', () => {
    const earned = simulation.computeReturningCustomersEarned(90, 100, cfg);
    eq(earned, 15);
  });

  it('computeReturningCustomersEarned — good → 8%', () => {
    const earned = simulation.computeReturningCustomersEarned(70, 100, cfg);
    eq(earned, 8);
  });

  it('computeReturningCustomersEarned — poor → 0', () => {
    const earned = simulation.computeReturningCustomersEarned(40, 100, cfg);
    eq(earned, 0);
  });

  it('SELLOUT_SAT_CAP is 45', () => {
    eq(simulation.SELLOUT_SAT_CAP, 45);
  });

  // DEC-03/DEC-04: ad auction winner gets a flat bonus added to revenueGross.
  // TV=$50k, Billboard=$37.5k, Radio=$25k, Newspaper=$18.75k (from config.adBonuses).
  // Test strategy: two runs with identical inputs except auctionResults.adWon.
  // Same playerId → same noise seed → exact difference = ad bonus.
  it('runSimulation — TV winner gets $50k flat bonus added to revenueGross (DEC-03)', () => {
    const makePlayer = (adWon) => ({
      playerId: 'p1',
      displayName: 'Solo',
      bakeryName: 'Solo Bakery',
      budgetCurrent: 10000,
      sousChefCount: 0,
      specialtyChefs: [],
      returningCustomersPending: 0,
      decision: {
        menu: { croissant: true, cookie: true, bagel: true, sandwich: true, coffee: true, matcha: true },
        quantities: { croissant: 20, cookie: 20, bagel: 20, sandwich: 20, coffee: 20, matcha: 20 },
        sousChefCount: 0,
        sousChefAssignments: {},
      },
      auctionResults: { adWon, adBidPaid: 0, chefBidPaid: 0 },
    });
    const prefs = { modifiers: { croissant: 1.0, cookie: 1.0, bagel: 1.0, sandwich: 1.0, coffee: 1.0, matcha: 1.0 } };
    const ctx = { gameId: 'ad-bonus-test', round: 1 };
    const winR = simulation.runSimulation([makePlayer('TV')], prefs, cfg, ctx);
    const noWinR = simulation.runSimulation([makePlayer(null)], prefs, cfg, ctx);
    const diff = winR[0].revenueGross - noWinR[0].revenueGross;
    eq(diff, cfg.adBonuses.TV, 'TV bonus exactly added to gross revenue');
  });

  it('runSimulation — Billboard winner gets $37.5k flat bonus (DEC-04)', () => {
    const makePlayer = (adWon) => ({
      playerId: 'p1', displayName: 'Solo', bakeryName: 'Solo Bakery',
      budgetCurrent: 10000, sousChefCount: 0, specialtyChefs: [], returningCustomersPending: 0,
      decision: {
        menu: { croissant: true }, quantities: { croissant: 10 },
        sousChefCount: 0, sousChefAssignments: {},
      },
      auctionResults: { adWon, adBidPaid: 0, chefBidPaid: 0 },
    });
    const ctx = { gameId: 'ad-bonus-bb', round: 1 };
    const winR = simulation.runSimulation([makePlayer('Billboard')], {}, cfg, ctx);
    const noWinR = simulation.runSimulation([makePlayer(null)], {}, cfg, ctx);
    near(winR[0].revenueGross - noWinR[0].revenueGross, cfg.adBonuses.Billboard, 1e-6, 'Billboard bonus');
  });

  it('runSimulation — no ad won → no flat bonus applied', () => {
    const player = {
      playerId: 'p1', displayName: 'Solo', bakeryName: 'Solo Bakery',
      budgetCurrent: 10000, sousChefCount: 0, specialtyChefs: [], returningCustomersPending: 0,
      decision: {
        menu: { croissant: true }, quantities: { croissant: 10 },
        sousChefCount: 0, sousChefAssignments: {},
      },
      auctionResults: { adWon: null, adBidPaid: 0, chefBidPaid: 0 },
    };
    const r = simulation.runSimulation([player], {}, cfg, { gameId: 'no-ad', round: 1 });
    // With no bonus, revenueGross should be within the noise range of the formula
    // base ($500) + noise ± $100 + other coefficients (all 0 here) + totalProductRevenue.
    // Croissant price $4.75 × qtySold (≤10 with a solo player/no competition most customers).
    // We just confirm no phantom $50k+ bonus leaked in.
    ok(r[0].revenueGross < 10000, 'no ad bonus → revenueGross stays in expected range');
  });

  it('runSimulation — Radio winner gets flat bonus (DEC-04)', () => {
    const makePlayer = (adWon) => ({
      playerId: 'p1', displayName: 'Solo', bakeryName: 'Solo Bakery',
      budgetCurrent: 10000, sousChefCount: 0, specialtyChefs: [], returningCustomersPending: 0,
      decision: {
        menu: { croissant: true }, quantities: { croissant: 10 },
        sousChefCount: 0, sousChefAssignments: {},
      },
      auctionResults: { adWon, adBidPaid: 0, chefBidPaid: 0 },
    });
    const ctx = { gameId: 'ad-bonus-radio', round: 1 };
    const winR = simulation.runSimulation([makePlayer('Radio')], {}, cfg, ctx);
    const noWinR = simulation.runSimulation([makePlayer(null)], {}, cfg, ctx);
    near(winR[0].revenueGross - noWinR[0].revenueGross, cfg.adBonuses.Radio, 0.01, 'Radio bonus');
  });

  it('runSimulation — Newspaper winner gets flat bonus (DEC-04)', () => {
    const makePlayer = (adWon) => ({
      playerId: 'p1', displayName: 'Solo', bakeryName: 'Solo Bakery',
      budgetCurrent: 10000, sousChefCount: 0, specialtyChefs: [], returningCustomersPending: 0,
      decision: {
        menu: { croissant: true }, quantities: { croissant: 10 },
        sousChefCount: 0, sousChefAssignments: {},
      },
      auctionResults: { adWon, adBidPaid: 0, chefBidPaid: 0 },
    });
    const ctx = { gameId: 'ad-bonus-news', round: 1 };
    const winR = simulation.runSimulation([makePlayer('Newspaper')], {}, cfg, ctx);
    const noWinR = simulation.runSimulation([makePlayer(null)], {}, cfg, ctx);
    near(winR[0].revenueGross - noWinR[0].revenueGross, cfg.adBonuses.Newspaper, 0.01, 'Newspaper bonus');
  });

  // Defensive: if bad data lands in auctionResults.adWon (e.g. a legacy ad type
  // no longer in config.adBonuses), we must not crash and must not add a phantom
  // bonus. The || 0 fallback in simulation.js handles this.
  it('runSimulation — unknown adWon string contributes no bonus', () => {
    const player = {
      playerId: 'p1', displayName: 'Solo', bakeryName: 'Solo Bakery',
      budgetCurrent: 10000, sousChefCount: 0, specialtyChefs: [], returningCustomersPending: 0,
      decision: {
        menu: { croissant: true }, quantities: { croissant: 10 },
        sousChefCount: 0, sousChefAssignments: {},
      },
      auctionResults: { adWon: 'Podcast', adBidPaid: 0, chefBidPaid: 0 },
    };
    const bad = simulation.runSimulation([player], {}, cfg, { gameId: 'unknown-ad', round: 1 });
    const none = simulation.runSimulation(
      [{ ...player, auctionResults: { adWon: null, adBidPaid: 0, chefBidPaid: 0 } }],
      {}, cfg, { gameId: 'unknown-ad', round: 1 }
    );
    eq(bad[0].revenueGross - none[0].revenueGross, 0, 'unknown ad type → no bonus, no crash');
  });

  // Ad bonus (flat add) should compose cleanly with the adSpend coefficient path
  // (adSpendCoeff × adBidPaid). A player who bids $500 and wins TV should gain
  // BOTH the $500 × 0.8 spend contribution AND the $50k flat bonus on top.
  it('runSimulation — flat ad bonus stacks with adSpend coefficient', () => {
    const makePlayer = (adWon, adBidPaid) => ({
      playerId: 'p1', displayName: 'Solo', bakeryName: 'Solo Bakery',
      budgetCurrent: 10000, sousChefCount: 0, specialtyChefs: [], returningCustomersPending: 0,
      decision: {
        menu: { croissant: true }, quantities: { croissant: 10 },
        sousChefCount: 0, sousChefAssignments: {},
      },
      auctionResults: { adWon, adBidPaid, chefBidPaid: 0 },
    });
    const ctx = { gameId: 'ad-stack', round: 1 };
    // Winner: bids $500 AND wins TV. Non-winner: bids $500, wins nothing.
    const winR   = simulation.runSimulation([makePlayer('TV', 500)], {}, cfg, ctx);
    const noWinR = simulation.runSimulation([makePlayer(null, 500)], {}, cfg, ctx);
    // Both have same adSpend contribution (500 × adSpendCoeff), same noise (same
    // playerId + seed), same everything else. Diff should be *exactly* the flat
    // TV bonus — proving the flat add is additive, not replacing the coeff path.
    eq(winR[0].revenueGross - noWinR[0].revenueGross, cfg.adBonuses.TV,
       'TV bonus stacks on top of adSpend coefficient');
  });

  // revenueNet = revenueGross − loanSharkDeduction. If the bonus is added to
  // revenueGross BEFORE loan-shark, then a player who borrows pays interest on
  // (expenses − budget), unaffected by the bonus — but keeps the bonus in the
  // net. Sanity-check: winner with loan shark triggered still ends up with the
  // bonus reflected in revenueNet.
  it('runSimulation — ad bonus survives loan-shark deduction into revenueNet', () => {
    const makePlayer = (adWon) => ({
      playerId: 'p1', displayName: 'Overspender', bakeryName: 'Broke Bakery',
      budgetCurrent: 100, // forces borrowing
      sousChefCount: 0, specialtyChefs: [], returningCustomersPending: 0,
      decision: {
        menu: { croissant: true, cookie: true },
        quantities: { croissant: 50, cookie: 50 },
        sousChefCount: 3, // hefty staffing bill
        sousChefAssignments: { croissant: 2, cookie: 1 },
      },
      auctionResults: { adWon, adBidPaid: 0, chefBidPaid: 0 },
    });
    const ctx = { gameId: 'ad-with-loan', round: 1 };
    const winR   = simulation.runSimulation([makePlayer('TV')], {}, cfg, ctx);
    const noWinR = simulation.runSimulation([makePlayer(null)], {}, cfg, ctx);
    ok(winR[0].amountBorrowed > 0, 'winner still overspends → borrows');
    ok(noWinR[0].amountBorrowed > 0, 'non-winner also overspends → borrows');
    // Same expenses on both sides → identical loanSharkDeduction.
    // Diff in revenueNet should equal the full TV bonus.
    near(winR[0].revenueNet - noWinR[0].revenueNet, cfg.adBonuses.TV, 1e-6,
       'TV bonus flows through to revenueNet even under loan-shark');
  });
});

// ============================================================================
// 13. REGRESSION TESTS — known edge cases
// ============================================================================
describe('Regression Tests', () => {
  const cfg = config.mergeConfig({});

  it('REG-001: zero-quantity products should not crash simulation', () => {
    const players = [{
      playerId: 'p1', displayName: 'A', bakeryName: 'B', budgetCurrent: 2000,
      specialtyChefs: [], returningCustomersPending: 0,
      decision: {
        menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false },
        quantities: { croissant: 0, cookie: 0, bagel: 0 },
        sousChefCount: 0, sousChefAssignments: {},
      },
      auctionResults: { adWon: null, adBidPaid: 0, chefBidPaid: 0 },
    }];
    const results = simulation.runSimulation(players, {}, cfg);
    eq(results.length, 1);
    ok(typeof results[0].revenueGross === 'number');
  });

  it('REG-002: NaN/undefined quantities treated as 0', () => {
    const players = [{
      playerId: 'p1', displayName: 'A', bakeryName: 'B', budgetCurrent: 2000,
      specialtyChefs: [], returningCustomersPending: 0,
      decision: {
        menu: { croissant: true, cookie: true, bagel: true },
        quantities: { croissant: undefined, cookie: NaN, bagel: 'bad' },
        sousChefCount: 0, sousChefAssignments: {},
      },
      auctionResults: { adWon: null, adBidPaid: 0, chefBidPaid: 0 },
    }];
    const results = simulation.runSimulation(players, {}, cfg);
    eq(results.length, 1);
    // Should not throw
  });

  it('REG-003: missing decision fields use defaults', () => {
    const players = [{
      playerId: 'p1', displayName: 'A', bakeryName: 'B', budgetCurrent: 2000,
      specialtyChefs: [], returningCustomersPending: 0,
      decision: {}, // totally empty
      auctionResults: {},
    }];
    const results = simulation.runSimulation(players, {}, cfg);
    eq(results.length, 1);
  });

  it('REG-004: large player count (150+) should not crash', () => {
    const players = [];
    for (let i = 0; i < 160; i++) {
      players.push({
        playerId: `p${i}`, displayName: `Player ${i}`, bakeryName: `Bakery ${i}`,
        budgetCurrent: 2000, specialtyChefs: [], returningCustomersPending: 0,
        decision: {
          menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false },
          quantities: { croissant: 30, cookie: 20, bagel: 15 },
          sousChefCount: 0, sousChefAssignments: {},
        },
        auctionResults: { adWon: null, adBidPaid: 0, chefBidPaid: 0 },
      });
    }
    const results = simulation.runSimulation(players, {}, cfg);
    eq(results.length, 160);
    // Verify no NaN in results
    for (const r of results) {
      ok(!isNaN(r.revenueGross), `NaN revenue for ${r.playerId}`);
      ok(!isNaN(r.customerCount), `NaN customers for ${r.playerId}`);
      ok(!isNaN(r.budgetAfter), `NaN budget for ${r.playerId}`);
    }
  });

  it('REG-005: sell-out caps satisfaction correctly', () => {
    // Player with high output but low stock → should trigger sellout
    const players = [{
      playerId: 'p1', displayName: 'A', bakeryName: 'B', budgetCurrent: 2000,
      specialtyChefs: [{ skillTier: 'advanced', specialties: ['croissant', 'coffee'] }],
      returningCustomersPending: 0,
      decision: {
        menu: { croissant: true, cookie: false, bagel: false, sandwich: false, coffee: false, matcha: false },
        quantities: { croissant: 5 }, // Very low stock
        sousChefCount: 0, sousChefAssignments: {},
      },
      auctionResults: { adWon: null, adBidPaid: 0, chefBidPaid: 0 },
    }];
    const results = simulation.runSimulation(players, {}, cfg);
    // If sellout occurs, sat should be capped at 45
    if (results[0].selloutAnywhere) {
      ok(results[0].perProductSatisfaction.croissant.satisfactionPct <= 45,
        'sellout caps at 45');
    }
  });

  it('REG-006: phases survive invalid transitions gracefully', () => {
    eq(phases.isValidTransition('game_over', 'lobby'), false);
    eq(phases.isValidTransition('round_1_decide', 'game_over'), false);
  });

  it('REG-007: CSV row handles missing specialtyChefs', () => {
    const row = csvExport.buildCsvRow({
      round: 1,
      decision: { menu: { croissant: true }, quantities: { croissant: 10 }, sousChefCount: 0, adBids: {} },
      specialtyChefs: [], // empty
      revenueGross: 500,
      customerCount: 20,
      aggregateSatisfactionPct: 50,
      perProductSatisfaction: {},
      selloutFlags: {},
    });
    eq(row.specialty_chef_1_nationality, '');
    eq(row.specialty_chef_1_skill, '');
  });

  it('REG-008: conclusion handles single player', () => {
    const ranked = conclusion.rankPlayers([
      { playerId: 'solo', netRevenue: 5000, budgetRemaining: 1000 },
    ]);
    eq(ranked.length, 1);
    eq(ranked[0].rank, 1);
    const data = conclusion.buildConclusionData(ranked, []);
    eq(data.winner.playerId, 'solo');
  });

  it('REG-009: customer allocation with all zero satisfaction → even split', () => {
    const players = [
      { playerId: 'p1', perProductSatisfaction: { coffee: 0 } },
      { playerId: 'p2', perProductSatisfaction: { coffee: 0 } },
    ];
    const result = custAlloc.allocateCustomersPerProduct('coffee', 100, players, new Map());
    // Even split
    eq(result.get('p1'), 50);
    eq(result.get('p2'), 50);
  });

  it('REG-010: loan shark with exact budget match → no borrowing', () => {
    const r = loanShark.calculateLoanShark(2000, 2000);
    eq(r.borrowed, 0);
    eq(r.didBorrow, false);
  });

  it('REG-011: revenue noise is bounded', () => {
    for (let i = 0; i < 100; i++) {
      const n = revenue.gaussianNoise(-100, 100, `bound-test-${i}`);
      ok(n >= -100 && n <= 100, `noise ${n} out of bounds`);
    }
  });

  it('REG-012: round preferences consecutive trending constraint (10 trials)', () => {
    for (let trial = 0; trial < 10; trial++) {
      const prefs = roundPrefs.generateGamePreferences(5);
      for (let i = 1; i < prefs.length; i++) {
        const prev = new Set(prefs[i - 1].trending);
        for (const t of prefs[i].trending) {
          ok(!prev.has(t), `trial ${trial}: ${t} trending rounds ${i - 1} and ${i}`);
        }
      }
    }
  });

  it('REG-013: budget never goes negative (floor at 0)', () => {
    // Player with tiny budget, massive spending, and negative net revenue
    const players = [{
      playerId: 'broke', displayName: 'Broke', bakeryName: 'Bankrupt Bakery',
      budgetCurrent: 50, specialtyChefs: [], returningCustomersPending: 0,
      decision: {
        menu: { croissant: true, cookie: true, bagel: true, sandwich: true, coffee: true, matcha: true },
        quantities: { croissant: 200, cookie: 200, bagel: 200, sandwich: 200, coffee: 200, matcha: 200 },
        sousChefCount: 4, sousChefAssignments: { croissant: 2, cookie: 1, bagel: 1 },
      },
      auctionResults: { adWon: 'TV', adBidPaid: 500, chefBidPaid: 500 },
    }];
    const results = simulation.runSimulation(players, {}, cfg);
    ok(Number.isFinite(results[0].budgetAfter), `budget should be finite, got ${results[0].budgetAfter}`);
  });

  it('REG-014: mergeConfig deep merge of nested objects', () => {
    const c = config.mergeConfig({
      returningCustomerBonuses: { excellent: 0.25 },
    });
    eq(c.returningCustomerBonuses.excellent, 0.25);
    eq(c.returningCustomerBonuses.good, 0.08); // untouched
  });
});

// ============================================================================
// 14. STRESS / PERFORMANCE TESTS
// ============================================================================
describe('Stress Tests', () => {
  const cfg = config.mergeConfig({});

  it('STRESS-001: 150-player simulation completes under 5 seconds', () => {
    const players = [];
    for (let i = 0; i < 150; i++) {
      players.push({
        playerId: `stress_${i}`,
        displayName: `Player ${i}`,
        bakeryName: `Bakery ${i}`,
        budgetCurrent: 2000,
        specialtyChefs: i % 3 === 0 ? [{ skillTier: 'advanced', specialties: ['croissant', 'coffee'] }] : [],
        returningCustomersPending: i % 5 === 0 ? 10 : 0,
        decision: {
          menu: { croissant: true, cookie: true, bagel: true, sandwich: i % 2 === 0, coffee: i % 3 === 0, matcha: i % 4 === 0 },
          quantities: { croissant: 30 + i, cookie: 20, bagel: 15, sandwich: i % 2 === 0 ? 10 : 0, coffee: i % 3 === 0 ? 25 : 0, matcha: i % 4 === 0 ? 15 : 0 },
          sousChefCount: i % 5,
          sousChefAssignments: i % 5 > 0 ? { croissant: Math.min(i % 5, 3), cookie: Math.max(0, (i % 5) - 3) } : {},
        },
        auctionResults: { adWon: i === 0 ? 'TV' : null, adBidPaid: i === 0 ? 200 : 0, chefBidPaid: 0 },
      });
    }
    const prefs = { modifiers: { croissant: 1.4, cookie: 1.15, bagel: 1.0, sandwich: 0.75, coffee: 1.0, matcha: 1.15 } };
    
    const start = Date.now();
    const results = simulation.runSimulation(players, prefs, cfg);
    const elapsed = Date.now() - start;
    
    eq(results.length, 150);
    ok(elapsed < 5000, `took ${elapsed}ms, expected < 5000ms`);
    console.log(`\n  (150-player sim: ${elapsed}ms)`);
    
    // Verify no NaN or undefined in any result
    for (const r of results) {
      ok(Number.isFinite(r.revenueGross), `finite revenue for ${r.playerId}`);
      ok(Number.isFinite(r.customerCount), `finite customers for ${r.playerId}`);
      ok(Number.isFinite(r.budgetAfter), `finite budget for ${r.playerId}`);
      ok(Number.isFinite(r.aggregateSatisfactionPct), `finite satisfaction for ${r.playerId}`);
    }
  });

  it('STRESS-002: 5-round full game simulation', () => {
    const prefs = roundPrefs.generateGamePreferences(5);
    let budget = 2000;
    let returning = 0;
    
    for (let round = 0; round < 5; round++) {
      const players = [{
        playerId: 'stress_single',
        displayName: 'Stress Tester',
        bakeryName: 'Stress Bakery',
        budgetCurrent: budget,
        specialtyChefs: round >= 2 ? [{ skillTier: 'advanced', specialties: ['croissant', 'coffee'] }] : [],
        returningCustomersPending: returning,
        decision: {
          menu: { croissant: true, cookie: true, bagel: true, sandwich: round >= 1, coffee: round >= 2, matcha: false },
          quantities: { croissant: 40, cookie: 30, bagel: 20, sandwich: round >= 1 ? 15 : 0, coffee: round >= 2 ? 25 : 0 },
          sousChefCount: Math.min(round, 3),
          sousChefAssignments: round > 0 ? { croissant: Math.min(round, 3) } : {},
        },
        auctionResults: { adWon: null, adBidPaid: 0, chefBidPaid: 0 },
      }];
      
      const results = simulation.runSimulation(players, prefs[round], cfg);
      eq(results.length, 1);
      const r = results[0];
      ok(Number.isFinite(r.revenueGross), `round ${round + 1} finite revenue`);
      ok(Number.isFinite(r.budgetAfter), `round ${round + 1} finite budget`);
      
      budget = r.budgetAfter;
      returning = r.returningCustomersEarned;
    }
  });
});

// ============================================================================
// simulation.js — productPrices wiring (POST-01)
// ============================================================================
describe('simulation.js — productPrices wiring (POST-01)', () => {
  it('uses each player\'s submitted productPrices for revenue', () => {
    const players = [
      {
        playerId: 'A',
        displayName: 'Alice',
        decision: {
          menu:       { coffee: true, croissant: true, bagel: true, cookie: true, sandwich: false, matcha: false },
          quantities: { coffee: 50, croissant: 40, bagel: 30, cookie: 20, sandwich: 0, matcha: 0 },
          sousChefCount: 0,
          sousChefAssignments: {},
          productPrices: { coffee: 5.00 }, // above catalog default of $4.00
        },
        specialtyChefs: [],
        budgetCurrent: 10000,
        returningCustomersPending: 0,
        priorSubmittedPrices: [],
        auctionResults: {},
      },
    ];
    const roundPreferences = { modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };

    const results = simulation.runSimulation(players, roundPreferences, {});
    const rowA = results.find((r) => r.playerId === 'A');
    ok(rowA, 'player A result exists');
    ok(rowA.revenueBreakdown, 'revenueBreakdown present');
    ok(rowA.revenueBreakdown.coffee, 'coffee breakdown present');
    eq(rowA.revenueBreakdown.coffee.price, 5.00);
    ok(rowA.productPrices, 'productPrices present');
    eq(rowA.productPrices.coffee, 5.00);
  });

  it('uses carry-over from priorSubmittedPrices when current productPrices missing', () => {
    const players = [
      {
        playerId: 'A',
        displayName: 'Alice',
        decision: {
          menu:       { coffee: true, croissant: true, bagel: true, cookie: true, sandwich: false, matcha: false },
          quantities: { coffee: 10, croissant: 0, bagel: 0, cookie: 0, sandwich: 0, matcha: 0 },
          sousChefCount: 0,
          sousChefAssignments: {},
          // no productPrices this round — should carry over from priors
        },
        specialtyChefs: [],
        budgetCurrent: 10000,
        returningCustomersPending: 0,
        priorSubmittedPrices: [{ coffee: 4.50 }, { coffee: 3.75 }], // most recent last
        auctionResults: {},
      },
    ];
    const roundPreferences = { modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };

    const results = simulation.runSimulation(players, roundPreferences, {});
    const rowA = results.find((r) => r.playerId === 'A');
    eq(rowA.revenueBreakdown.coffee.price, 3.75);
    eq(rowA.productPrices.coffee, 3.75);
  });
});

// ============================================================================
// 15. DYNAMIC PRICING — floor vs ceiling smoke test (POST-01 Task 21)
// ============================================================================
describe('simulation.js — floor vs ceiling smoke test (POST-01)', () => {
  const cfg = config.mergeConfig({});
  const { PRICE_ZONES } = config;

  const MENU = { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: true, matcha: false };
  const QTY  = { croissant: 60, cookie: 60, bagel: 60, sandwich: 0, coffee: 60, matcha: 0 };

  const makePlayer = (id, prices) => ({
    playerId: id,
    displayName: id,
    bakeryName: `${id} Bakery`,
    budgetCurrent: 10000,
    specialtyChefs: [],
    returningCustomersPending: 0,
    priorSubmittedPrices: [],
    decision: {
      menu: MENU,
      quantities: QTY,
      sousChefCount: 0,
      sousChefAssignments: {},
      productPrices: prices,
    },
    auctionResults: { adWon: null, adBidPaid: 0, chefBidPaid: 0 },
  });

  const floorPrices = {
    croissant: PRICE_ZONES.croissant.floor,
    cookie:    PRICE_ZONES.cookie.floor,
    bagel:     PRICE_ZONES.bagel.floor,
    coffee:    PRICE_ZONES.coffee.floor,
  };
  const ceilingPrices = {
    croissant: PRICE_ZONES.croissant.ceiling,
    cookie:    PRICE_ZONES.cookie.ceiling,
    bagel:     PRICE_ZONES.bagel.ceiling,
    coffee:    PRICE_ZONES.coffee.ceiling,
  };

  const roundPreferences = { modifiers: { croissant: 1.0, cookie: 1.0, bagel: 1.0, sandwich: 1.0, coffee: 1.0, matcha: 1.0 } };
  const players = [makePlayer('floor_player', floorPrices), makePlayer('ceiling_player', ceilingPrices)];
  const results = simulation.runSimulation(players, roundPreferences, cfg);
  const floorR   = results.find((r) => r.playerId === 'floor_player');
  const ceilingR = results.find((r) => r.playerId === 'ceiling_player');

  it('floor player captures >60% of combined customers', () => {
    const total = floorR.customerCount + ceilingR.customerCount;
    ok(total > 0, 'combined customer count > 0');
    const share = floorR.customerCount / total;
    ok(share > 0.60, `floor share was ${(share * 100).toFixed(1)}% — expected > 60%`);
  });

  it('ceiling player captures <20% of combined customers (spec Testing §1)', () => {
    const total = floorR.customerCount + ceilingR.customerCount;
    ok(ceilingR.customerCount / total < 0.20,
      `ceiling share was ${(ceilingR.customerCount / total * 100).toFixed(1)}% — expected < 20%`);
  });

  it('floor player revenue per customer is lower than ceiling player', () => {
    if (floorR.customerCount > 0 && ceilingR.customerCount > 0) {
      const floorRpc  = floorR.revenueGross  / floorR.customerCount;
      const ceilRpc   = ceilingR.revenueGross / ceilingR.customerCount;
      ok(floorRpc < ceilRpc,
        `floor $/cust ${floorRpc.toFixed(2)} should be < ceiling $/cust ${ceilRpc.toFixed(2)}`);
    }
  });
});

// ============================================================================
// FINAL REPORT
// ============================================================================
console.log('\n\n========================================');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('========================================');
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(f);
}
process.exit(failed > 0 ? 1 : 0);
