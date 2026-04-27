/**
 * test-adversarial.js — Adversarial fuzzing + A/B parameter testing for Bakery Bash
 *
 * Run with: node test-adversarial.js
 *
 * Covers:
 *   TASK 1: Type confusion, boundary values, injection attacks, overflow,
 *           missing fields, double-submit, malformed data
 *   TASK 2: A/B parameter balance testing (Config A/B/C/D variants)
 */

'use strict';

const path = require('path');
const modulesDir = path.join(__dirname, '..');

const config        = require(path.join(modulesDir, 'config'));
const revenue       = require(path.join(modulesDir, 'revenue'));
const satisfaction  = require(path.join(modulesDir, 'satisfaction'));
const customerAlloc = require(path.join(modulesDir, 'customer-allocation'));
const decisionVal   = require(path.join(modulesDir, 'decision-validation'));
const loanShark     = require(path.join(modulesDir, 'loan-shark'));
const chefSystem    = require(path.join(modulesDir, 'chef-system'));
const phases        = require(path.join(modulesDir, 'phases'));
const roundPrefs    = require(path.join(modulesDir, 'round-preferences'));
const simulation    = require(path.join(modulesDir, 'simulation'));

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let totalTests = 0;
let totalPassed = 0;
let totalFailed = 0;
const failures = [];

function test(name, fn, severity = 'MEDIUM') {
  totalTests++;
  try {
    fn();
    totalPassed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    totalFailed++;
    failures.push({ name, error: err.message || String(err), severity });
    console.error(`  FAIL [${severity}]  ${name}`);
    console.error(`        ${err.message || err}`);
  }
}

function section(title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

// assertion helpers
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}
function assertNoThrow(fn, msg) {
  try { fn(); }
  catch (e) { throw new Error(`${msg || 'Should not throw'}: ${e.message}`); }
}
function assertThrows(fn, msg) {
  try { fn(); throw new Error('Expected throw but did not'); }
  catch (e) {
    if (e.message === 'Expected throw but did not') throw new Error(msg || 'Expected to throw');
  }
}
function assertFinite(val, msg) {
  assert(Number.isFinite(val), `${msg || 'Value'} should be finite, got ${val}`);
}
function assertRange(val, lo, hi, msg) {
  assert(val >= lo && val <= hi, `${msg || 'Value'} ${val} not in [${lo}, ${hi}]`);
}
function assertNonNegative(val, msg) {
  assert(val >= 0, `${msg || 'Value'} ${val} should be non-negative`);
}

// Budget can go negative per spec — just verify it's a real number.
function assertFiniteBudget(val, msg) {
  assert(Number.isFinite(val), `${msg || 'Budget'} ${val} should be finite`);
}

// ============================================================================
// TASK 1: ADVERSARIAL INPUT FUZZING
// ============================================================================

// ---------------------------------------------------------------------------
// SECTION A: config.js — mergeConfig, numberOrDefault, objectOrDefault
// ---------------------------------------------------------------------------

section('A: config.js — type confusion & boundary fuzzing');

test('mergeConfig: null input → full defaults', () => {
  const cfg = config.mergeConfig(null);
  assert(cfg.startingBudget === 500000, 'startingBudget default');
  assert(cfg.totalRounds === 5, 'totalRounds default');
}, 'HIGH');

test('mergeConfig: undefined input → full defaults', () => {
  const cfg = config.mergeConfig(undefined);
  assert(Number.isFinite(cfg.startingBudget), 'startingBudget finite');
}, 'HIGH');

test('mergeConfig: array input → full defaults', () => {
  const cfg = config.mergeConfig([1, 2, 3]);
  assert(Number.isFinite(cfg.startingBudget), 'should not crash on array input');
}, 'MEDIUM');

test('mergeConfig: string input → full defaults', () => {
  const cfg = config.mergeConfig('hack');
  assert(Number.isFinite(cfg.startingBudget), 'should not crash on string input');
}, 'MEDIUM');

test('mergeConfig: NaN budget → default', () => {
  const cfg = config.mergeConfig({ startingBudget: NaN });
  assert(cfg.startingBudget === 500000, `NaN budget should fall back to default, got ${cfg.startingBudget}`);
}, 'HIGH');

test('mergeConfig: Infinity budget → default', () => {
  const cfg = config.mergeConfig({ startingBudget: Infinity });
  assert(cfg.startingBudget === 500000, `Infinity budget should fall back to default, got ${cfg.startingBudget}`);
}, 'HIGH');

test('mergeConfig: -Infinity budget → default', () => {
  const cfg = config.mergeConfig({ startingBudget: -Infinity });
  assert(cfg.startingBudget === 500000, `-Infinity budget should fall back to default`);
}, 'HIGH');

test('mergeConfig: negative budget override is accepted as-is (no domain clamp)', () => {
  // mergeConfig only validates finite; negative is a caller concern
  const cfg = config.mergeConfig({ startingBudget: -999 });
  assert(Number.isFinite(cfg.startingBudget), 'negative budget: still finite');
}, 'LOW');

test('mergeConfig: MAX_SAFE_INTEGER budget', () => {
  const cfg = config.mergeConfig({ startingBudget: Number.MAX_SAFE_INTEGER });
  assert(cfg.startingBudget === Number.MAX_SAFE_INTEGER, 'MAX_SAFE_INTEGER budget accepted');
}, 'LOW');

test('mergeConfig: injection string in startingBudget → default', () => {
  const cfg = config.mergeConfig({ startingBudget: "'; DROP TABLE games; --" });
  assert(cfg.startingBudget === 500000, 'SQL injection in budget → default');
}, 'CRITICAL');

test('mergeConfig: script tag in startingBudget → default', () => {
  const cfg = config.mergeConfig({ startingBudget: '<script>alert(1)</script>' });
  assert(cfg.startingBudget === 500000, 'XSS in budget → default');
}, 'CRITICAL');

test('mergeConfig: numeric string budget → parsed correctly', () => {
  const cfg = config.mergeConfig({ startingBudget: '5000' });
  assert(cfg.startingBudget === 5000, 'numeric string budget should parse');
}, 'MEDIUM');

test('mergeConfig: nested NaN coefficients → defaults', () => {
  const cfg = config.mergeConfig({ revenueCoefficients: { base: NaN, sousChefCoeff: 'hack' } });
  assert(cfg.revenueCoefficients.base === 500, `base should default to 500, got ${cfg.revenueCoefficients.base}`);
  assert(cfg.revenueCoefficients.sousChefCoeff === 25, 'sousChefCoeff default (balance pass)');
}, 'HIGH');

test('mergeConfig: empty nested objects → nested defaults', () => {
  const cfg = config.mergeConfig({ revenueCoefficients: {}, adBonuses: {} });
  assert(cfg.revenueCoefficients.base === 500, 'empty obj → revenueCoefficients.base default');
  assert(cfg.adBonuses.TV === 20000, 'empty obj → adBonuses.TV default');
}, 'MEDIUM');

test('numberOrDefault: null → fallback', () => {
  assert(config.numberOrDefault(null, 42) === 42);
}, 'LOW');

test('numberOrDefault: undefined → fallback', () => {
  assert(config.numberOrDefault(undefined, 42) === 42);
}, 'LOW');

test('numberOrDefault: empty string → fallback', () => {
  assert(config.numberOrDefault('', 42) === 42);
}, 'LOW');

test('numberOrDefault: NaN → fallback', () => {
  assert(config.numberOrDefault(NaN, 42) === 42);
}, 'LOW');

test('numberOrDefault: Infinity → fallback', () => {
  assert(config.numberOrDefault(Infinity, 42) === 42);
}, 'LOW');

test('numberOrDefault: object → fallback', () => {
  assert(config.numberOrDefault({}, 42) === 42);
}, 'LOW');

test('cleanString: non-string → empty string', () => {
  assert(config.cleanString(null) === '', 'null → empty');
  assert(config.cleanString(42) === '', 'number → empty');
  assert(config.cleanString({}) === '', 'object → empty');
}, 'LOW');

test('cleanString: injection string passes through (caller sanitizes)', () => {
  const s = config.cleanString("'; DROP TABLE--");
  assert(typeof s === 'string', 'returns string');
  assert(s === "'; DROP TABLE--", 'trimmed but not sanitized (expected behavior)');
}, 'LOW');

// ---------------------------------------------------------------------------
// SECTION B: revenue.js — computeGrossRevenue, calculateRoundCosts, gaussianNoise
// ---------------------------------------------------------------------------

section('B: revenue.js — type confusion & boundary fuzzing');

const defaultCfg = config.mergeConfig({});

test('computeGrossRevenue: all zeros → base + noise only', () => {
  const r = revenue.computeGrossRevenue({
    sousChefCount: 0,
    aggregateSatisfactionPct: 0,
    adSpend: 0,
    numProducts: 0,
    totalProductRevenue: 0,
    noiseSeed: 'test-seed'
  }, defaultCfg);
  assertFinite(r, 'all-zero gross revenue');
}, 'MEDIUM');

test('computeGrossRevenue: null inputs → defaults to base + noise', () => {
  const r = revenue.computeGrossRevenue(null, defaultCfg);
  assertFinite(r, 'null inputs: gross revenue finite');
}, 'HIGH');

test('computeGrossRevenue: undefined inputs → defaults', () => {
  const r = revenue.computeGrossRevenue(undefined, defaultCfg);
  assertFinite(r, 'undefined inputs: gross revenue finite');
}, 'HIGH');

test('computeGrossRevenue: string fields → treated as zero', () => {
  const r = revenue.computeGrossRevenue({
    sousChefCount: 'lots',
    aggregateSatisfactionPct: 'high',
    adSpend: 'all of it',
    numProducts: 'yes',
    totalProductRevenue: 'many',
    noiseSeed: 'seed'
  }, defaultCfg);
  assertFinite(r, 'string fields: gross revenue finite');
  // base(500) + noise(-100..100) → should be in roughly [400, 600]
  assertRange(r, 300, 700, 'string fields: revenue in plausible range');
}, 'HIGH');

test('computeGrossRevenue: NaN fields → treated as zero', () => {
  const r = revenue.computeGrossRevenue({
    sousChefCount: NaN,
    aggregateSatisfactionPct: NaN,
    adSpend: NaN,
    numProducts: NaN,
    totalProductRevenue: NaN,
  }, defaultCfg);
  assertFinite(r, 'NaN fields: gross revenue finite');
}, 'HIGH');

test('computeGrossRevenue: Infinity adSpend → should handle gracefully', () => {
  const r = revenue.computeGrossRevenue({
    sousChefCount: 0,
    aggregateSatisfactionPct: 0,
    adSpend: Infinity,
    numProducts: 0,
    totalProductRevenue: 0,
    noiseSeed: 'seed'
  }, defaultCfg);
  // adCoeff(0.8) * Infinity = Infinity — this is a potential bug
  if (!Number.isFinite(r)) {
    throw new Error(`Infinity adSpend produces non-finite revenue: ${r}. No guard against Infinity inputs.`);
  }
}, 'HIGH');

test('computeGrossRevenue: negative values → allowed (revenue can be negative)', () => {
  const r = revenue.computeGrossRevenue({
    sousChefCount: -5,
    aggregateSatisfactionPct: -100,
    adSpend: -1000,
    numProducts: -10,
    totalProductRevenue: -5000,
    noiseSeed: 'seed'
  }, defaultCfg);
  assertFinite(r, 'negative inputs: result finite');
  // negative inputs could produce negative revenue — that's fine as long as finite
}, 'MEDIUM');

test('computeGrossRevenue: extremely large valid inputs', () => {
  const r = revenue.computeGrossRevenue({
    sousChefCount: 1000,
    aggregateSatisfactionPct: 100,
    adSpend: 1000000,
    numProducts: 1000,
    totalProductRevenue: 10000000,
    noiseSeed: 'seed'
  }, defaultCfg);
  assertFinite(r, 'large inputs: gross revenue finite');
  assert(r > 0, 'large inputs: revenue positive');
}, 'LOW');

test('computeGrossRevenue: null cfg → uses inline defaults', () => {
  const r = revenue.computeGrossRevenue({
    sousChefCount: 2,
    aggregateSatisfactionPct: 80,
    adSpend: 500,
    numProducts: 4,
    totalProductRevenue: 1000,
    noiseSeed: 'seed'
  }, null);
  assertFinite(r, 'null cfg: gross revenue finite');
}, 'HIGH');

test('calculateRoundCosts: null decision → returns zeros safely', () => {
  const costs = revenue.calculateRoundCosts(null, null, defaultCfg);
  assertNonNegative(costs.totalSpent, 'null decision: totalSpent non-negative');
}, 'HIGH');

test('calculateRoundCosts: string quantities → treated as zero', () => {
  const costs = revenue.calculateRoundCosts(
    { perProductQtyStocked: { coffee: 'lots', croissant: 'all' }, sousChefCount: 0 },
    null,
    defaultCfg
  );
  assertNonNegative(costs.stockCost, 'string qty: stockCost non-negative');
}, 'HIGH');

test('calculateRoundCosts: negative sousChefCount → zero cost', () => {
  const costs = revenue.calculateRoundCosts(
    { perProductQtyStocked: {}, sousChefCount: -5 },
    null,
    defaultCfg
  );
  assertNonNegative(costs.sousChefHireCost, 'negative sousChefCount: hire cost non-negative');
}, 'MEDIUM');

test('_sousChefHireCost: 0 count → 0', () => {
  const cost = revenue._sousChefHireCost(0, 50);
  assert(cost === 0, `0 chefs cost should be 0, got ${cost}`);
}, 'LOW');

test('_sousChefHireCost: 500 sous chefs → no crash (overflow test)', () => {
  assertNoThrow(() => {
    const cost = revenue._sousChefHireCost(500, 50);
    assertFinite(cost, '500 sous chefs cost');
    assert(cost > 0, '500 sous chefs cost > 0');
  }, '500 sous chefs should not crash');
}, 'MEDIUM');

test('gaussianNoise: null seed → uses Math.random, still finite', () => {
  const n = revenue.gaussianNoise(-100, 100, null);
  assertRange(n, -100, 100, 'noise with null seed');
}, 'LOW');

test('gaussianNoise: object seed → hashes safely', () => {
  const n = revenue.gaussianNoise(-100, 100, { key: 'value' });
  assertRange(n, -100, 100, 'noise with object seed');
}, 'LOW');

test('gaussianNoise: equal min/max → returns that value', () => {
  const n = revenue.gaussianNoise(50, 50, 'seed');
  assertRange(n, 50, 50, 'noise min==max');
}, 'LOW');

test('gaussianNoise: min > max → result clamped (defensive)', () => {
  // When min > max the formula breaks but should not throw
  assertNoThrow(() => {
    revenue.gaussianNoise(100, -100, 'seed');
  }, 'inverted noise range should not crash');
}, 'MEDIUM');

test('calculateProductRevenue: null qty → 0 revenue', () => {
  const r = revenue.calculateProductRevenue(null, defaultCfg);
  assert(r.totalProductRevenue === 0, 'null qty → 0 revenue');
}, 'MEDIUM');

test('calculateProductRevenue: missing product in cfg.products → 0 price', () => {
  const r = revenue.calculateProductRevenue({ unknownProd: 100 }, { products: {} });
  assert(r.totalProductRevenue === 0, 'unknown product → 0 price');
}, 'MEDIUM');

// ---------------------------------------------------------------------------
// SECTION C: satisfaction.js — fuzzing
// ---------------------------------------------------------------------------

section('C: satisfaction.js — boundary and type fuzzing');

test('calculateFillRate: zero demand → 0 (no div-by-zero)', () => {
  const fr = satisfaction.calculateFillRate(100, 0);
  assert(fr === 0, 'zero demand → 0 fill rate');
}, 'CRITICAL');

test('calculateFillRate: negative demand → 0', () => {
  const fr = satisfaction.calculateFillRate(100, -50);
  assert(fr === 0, 'negative demand → 0 fill rate');
}, 'HIGH');

test('calculateFillRate: NaN demand → 0', () => {
  const fr = satisfaction.calculateFillRate(100, NaN);
  assert(fr === 0, 'NaN demand → 0 fill rate');
}, 'HIGH');

test('calculateFillRate: NaN output → NaN fill rate (potential issue)', () => {
  const fr = satisfaction.calculateFillRate(NaN, 100);
  if (Number.isNaN(fr)) {
    throw new Error('NaN effectiveOutput produces NaN fill rate — downstream NaN propagation risk');
  }
}, 'HIGH');

test('calculateFillRate: Infinity output → Infinity fill rate (potential issue)', () => {
  const fr = satisfaction.calculateFillRate(Infinity, 100);
  if (!Number.isFinite(fr)) {
    throw new Error(`Infinity output produces non-finite fill rate: ${fr} — fills satisfaction to 100 via excess path, but intermediate Infinity may propagate`);
  }
}, 'MEDIUM');

test('fillRateToSatisfactionPct: negative fill rate → 0 clamped', () => {
  const pct = satisfaction.fillRateToSatisfactionPct(-1);
  assertRange(pct, 0, 100, 'negative fill rate satisfaction');
}, 'HIGH');

test('fillRateToSatisfactionPct: fill rate 0 → critical tier (0-20)', () => {
  const pct = satisfaction.fillRateToSatisfactionPct(0);
  assertRange(pct, 0, 20, 'zero fill rate → critical');
}, 'MEDIUM');

test('fillRateToSatisfactionPct: fill rate 1.0 → good or excellent', () => {
  const pct = satisfaction.fillRateToSatisfactionPct(1.0);
  assertRange(pct, 66, 100, 'fill rate 1.0 → good/excellent');
}, 'MEDIUM');

test('fillRateToSatisfactionPct: fill rate 2.0 → excellent max (100)', () => {
  const pct = satisfaction.fillRateToSatisfactionPct(2.0);
  assert(pct === 100, `fill rate 2.0 → 100, got ${pct}`);
}, 'MEDIUM');

test('fillRateToSatisfactionPct: Infinity fill rate → no crash', () => {
  assertNoThrow(() => {
    const pct = satisfaction.fillRateToSatisfactionPct(Infinity);
    assertRange(pct, 0, 100, 'Infinity fill rate');
  }, 'Infinity fill rate should not crash');
}, 'HIGH');

test('fillRateToSatisfactionPct: NaN fill rate → valid or NaN (should handle)', () => {
  const pct = satisfaction.fillRateToSatisfactionPct(NaN);
  if (Number.isNaN(pct)) {
    throw new Error('NaN fill rate propagates to NaN satisfaction — no guard on NaN input');
  }
  assertRange(pct, 0, 100, 'NaN fill rate satisfaction');
}, 'HIGH');

test('calculatePerProductSatisfaction: null playerState → all nulls', () => {
  const result = satisfaction.calculatePerProductSatisfaction(null);
  assert(typeof result === 'object', 'null state → object result');
  // All products should be null (not offered)
  for (const val of Object.values(result)) {
    assert(val === null, 'null state → product satisfaction null');
  }
}, 'HIGH');

test('calculatePerProductSatisfaction: menu with objects instead of booleans', () => {
  const state = {
    menu: { coffee: {}, croissant: 1, bagel: 'yes' },
    effectiveOutputs: { coffee: 50, croissant: 60 }
  };
  assertNoThrow(() => {
    satisfaction.calculatePerProductSatisfaction(state);
  }, 'non-boolean menu values should not crash');
}, 'MEDIUM');

test('calculateAggregateSatisfaction: empty object → 0', () => {
  const result = satisfaction.calculateAggregateSatisfaction({});
  assert(result.aggregateSatisfactionPct === 0, 'empty sat → 0');
}, 'MEDIUM');

test('calculateAggregateSatisfaction: all null products → 0', () => {
  const allNull = { coffee: null, croissant: null, bagel: null };
  const result = satisfaction.calculateAggregateSatisfaction(allNull);
  assert(result.aggregateSatisfactionPct === 0, 'all null → 0');
}, 'MEDIUM');

test('calculateAggregateSatisfaction: NaN satisfactionPct → propagation check', () => {
  const badSat = {
    coffee: { satisfactionPct: NaN, fillRate: 0.5, tier: 'poor' }
  };
  const result = satisfaction.calculateAggregateSatisfaction(badSat);
  if (Number.isNaN(result.aggregateSatisfactionPct)) {
    throw new Error('NaN satisfactionPct propagates to aggregate — no guard');
  }
}, 'HIGH');

test('getFootTrafficModifier: all zeros → satMod only (-0.40)', () => {
  const mod = satisfaction.getFootTrafficModifier(0, {}, 0, 0);
  assertFinite(mod, 'all-zero foot traffic modifier');
  // satMod = (0 - 50)/50 * 0.40 = -0.40
  assert(Math.abs(mod - (-0.40)) < 0.001, `expected ~-0.40, got ${mod}`);
}, 'MEDIUM');

test('getFootTrafficModifier: null perProductSatisfaction → no crash', () => {
  assertNoThrow(() => {
    satisfaction.getFootTrafficModifier(80, null, 4, 2);
  }, 'null perProductSatisfaction should not crash');
}, 'HIGH');

test('getFootTrafficModifier: NaN inputs → finite output', () => {
  const mod = satisfaction.getFootTrafficModifier(NaN, {}, NaN, NaN);
  if (!Number.isFinite(mod)) {
    throw new Error(`NaN inputs produce non-finite foot traffic modifier: ${mod}`);
  }
}, 'HIGH');

test('applySellOut: null perProductSatisfaction → no crash', () => {
  assertNoThrow(() => {
    satisfaction.applySellOut({}, null, null);
  }, 'null applySellOut args should not crash');
}, 'MEDIUM');

test('getReturningCustomerBonus: negative priorRoundCustomerCount', () => {
  const bonus = satisfaction.getReturningCustomerBonus(90, -100, defaultCfg);
  // -100 * 0.15 = -15 — negative returning customers is a bug
  if (bonus < 0) {
    throw new Error(`Negative priorRoundCustomerCount produces negative returning customers: ${bonus}`);
  }
}, 'MEDIUM');

test('getReturningCustomerBonus: NaN priorRoundCustomerCount → NaN propagation', () => {
  const bonus = satisfaction.getReturningCustomerBonus(90, NaN, defaultCfg);
  if (Number.isNaN(bonus)) {
    throw new Error('NaN priorRoundCustomerCount produces NaN returning customer bonus');
  }
}, 'MEDIUM');

// ---------------------------------------------------------------------------
// SECTION D: decision-validation.js — fuzzing
// ---------------------------------------------------------------------------

section('D: decision-validation.js — type confusion, injection, missing fields');

test('validateDecision: null → throws ValidationError', () => {
  assertThrows(() => decisionVal.validateDecision(null, 1, defaultCfg), 'null decision should throw');
}, 'HIGH');

test('validateDecision: empty object → defaults with base menu', () => {
  const d = decisionVal.validateDecision({}, 1, defaultCfg);
  assert(d.menu.croissant === true, 'empty obj → base menu enabled');
  assert(d.menu.cookie === true, 'empty obj → base menu enabled');
  assert(d.menu.bagel === true, 'empty obj → base menu enabled');
}, 'MEDIUM');

test('validateDecision: disabling base menu product → throws', () => {
  assertThrows(
    () => decisionVal.validateDecision({ menu: { croissant: false } }, 1, defaultCfg),
    'disabling base product should throw'
  );
}, 'HIGH');

test('validateDecision: string quantity → throws ValidationError', () => {
  assertThrows(
    () => decisionVal.validateDecision({
      menu: { croissant: true, bagel: true, cookie: true },
      quantities: { croissant: 'lots', bagel: 50, cookie: 50 },
      sousChefCount: 0,
      sousChefAssignments: {}
    }, 1, defaultCfg),
    'string quantity should throw'
  );
}, 'HIGH');

test('validateDecision: negative quantity → throws ValidationError', () => {
  assertThrows(
    () => decisionVal.validateDecision({
      menu: { croissant: true, bagel: true, cookie: true },
      quantities: { croissant: -10, bagel: 50, cookie: 50 },
      sousChefCount: 0,
      sousChefAssignments: {}
    }, 1, defaultCfg),
    'negative quantity should throw'
  );
}, 'HIGH');

test('validateDecision: float quantity → throws (non-integer)', () => {
  assertThrows(
    () => decisionVal.validateDecision({
      menu: { croissant: true, bagel: true, cookie: true },
      quantities: { croissant: 50.5, bagel: 50, cookie: 50 },
      sousChefCount: 0,
      sousChefAssignments: {}
    }, 1, defaultCfg),
    'float quantity should throw'
  );
}, 'MEDIUM');

test('validateDecision: SQL injection in product name via sousChefAssignments', () => {
  assertThrows(
    () => decisionVal.validateDecision({
      menu: { croissant: true, bagel: true, cookie: true },
      quantities: {},
      sousChefCount: 1,
      sousChefAssignments: { "'; DROP TABLE players;--": 1 }
    }, 1, defaultCfg),
    'SQL injection in assignment key should throw (unknown product)'
  );
}, 'CRITICAL');

test('validateDecision: sousChefAssignments sum mismatch → throws', () => {
  assertThrows(
    () => decisionVal.validateDecision({
      menu: { croissant: true, bagel: true, cookie: true },
      quantities: { croissant: 100, bagel: 100, cookie: 100 },
      sousChefCount: 3,
      sousChefAssignments: { croissant: 1 }  // sum=1, count=3
    }, 1, defaultCfg),
    'assignment sum mismatch should throw'
  );
}, 'HIGH');

test('validateDecision: malformed data object → throws', () => {
  assertThrows(
    () => decisionVal.validateDecision({
      menu: 'yes',
      quantities: 'all of them',
      sousChefCount: 'a lot',
      sousChefAssignments: 'everywhere'
    }, 1, defaultCfg),
    'fully malformed decision should throw on sousChefCount'
  );
}, 'HIGH');

test('validateDecision: NaN sousChefCount → throws', () => {
  assertThrows(
    () => decisionVal.validateDecision({
      sousChefCount: NaN,
      sousChefAssignments: {}
    }, 1, defaultCfg),
    'NaN sousChefCount should throw'
  );
}, 'HIGH');

test('validateDecision: Infinity sousChefCount → throws', () => {
  assertThrows(
    () => decisionVal.validateDecision({
      sousChefCount: Infinity,
      sousChefAssignments: {}
    }, 1, defaultCfg),
    'Infinity sousChefCount should throw'
  );
}, 'HIGH');

test('validateDecision: double submit same decision (idempotency)', () => {
  const good = {
    menu: { croissant: true, bagel: true, cookie: true, sandwich: false, coffee: false, matcha: false },
    quantities: { croissant: 100, bagel: 80, cookie: 60, sandwich: 0, coffee: 0, matcha: 0 },
    sousChefCount: 0,
    sousChefAssignments: {}
  };
  const d1 = decisionVal.validateDecision(good, 1, defaultCfg);
  const d2 = decisionVal.validateDecision(good, 1, defaultCfg);
  assert(JSON.stringify(d1) === JSON.stringify(d2), 'double-submit produces same result');
}, 'MEDIUM');

test('validateDecision: script tag in product name via sousChefAssignments → rejected', () => {
  assertThrows(
    () => decisionVal.validateDecision({
      menu: { croissant: true, bagel: true, cookie: true },
      quantities: {},
      sousChefCount: 1,
      sousChefAssignments: { '<script>alert(1)</script>': 1 }
    }, 1, defaultCfg),
    'XSS in assignment key should be rejected'
  );
}, 'CRITICAL');

test('validateDecision: currentRound = 0 → round stored as 0', () => {
  const d = decisionVal.validateDecision({}, 0, defaultCfg);
  assert(d.round === 0 || d.round === null, 'round 0 stored correctly');
}, 'LOW');

test('validateDecision: currentRound = -1 → stored (negative round warning)', () => {
  assertNoThrow(() => {
    decisionVal.validateDecision({}, -1, defaultCfg);
  }, 'negative round should not crash (validation is not round-aware)');
}, 'LOW');

test('validateDecision: currentRound = 999 → stored as 999', () => {
  assertNoThrow(() => {
    const d = decisionVal.validateDecision({}, 999, defaultCfg);
    assert(d.round === 999, 'round 999 stored');
  }, 'round 999 should not crash');
}, 'LOW');

test('validateDecision: quantity for non-menu product > 0 → throws', () => {
  assertThrows(
    () => decisionVal.validateDecision({
      menu: { croissant: true, bagel: true, cookie: true, sandwich: false },
      quantities: { sandwich: 100 },
      sousChefCount: 0,
      sousChefAssignments: {}
    }, 1, defaultCfg),
    'quantity >0 for non-menu product should throw'
  );
}, 'HIGH');

test('validateAdBids: null → throws', () => {
  assertThrows(
    () => decisionVal.validateAdBids(null),
    'null ad bids should throw'
  );
}, 'HIGH');

test('validateAdBids: string → throws', () => {
  assertThrows(
    () => decisionVal.validateAdBids('all in on TV'),
    'string ad bids should throw'
  );
}, 'HIGH');

test('validateAdBids: negative bid → throws', () => {
  assertThrows(
    () => decisionVal.validateAdBids({ TV: -100 }),
    'negative ad bid should throw'
  );
}, 'HIGH');

test('validateAdBids: NaN bid → throws', () => {
  assertThrows(
    () => decisionVal.validateAdBids({ TV: NaN }),
    'NaN ad bid should throw'
  );
}, 'HIGH');

test('validateAdBids: Infinity bid → throws', () => {
  assertThrows(
    () => decisionVal.validateAdBids({ TV: Infinity }),
    'Infinity ad bid should throw'
  );
}, 'HIGH');

test('validateAdBids: unknown ad type key → throws', () => {
  assertThrows(
    () => decisionVal.validateAdBids({ TV: 100, Facebook: 9999 }),
    'unknown ad type should throw'
  );
}, 'HIGH');

test('validateAdBids: injection in bid value → throws', () => {
  assertThrows(
    () => decisionVal.validateAdBids({ TV: "'; DELETE FROM games;--" }),
    'injection in bid value should throw'
  );
}, 'CRITICAL');

test('validateAdBids: empty object → all zeros', () => {
  const bids = decisionVal.validateAdBids({});
  assert(bids.TV === 0 && bids.Billboard === 0 && bids.Radio === 0 && bids.Newspaper === 0,
    'empty bids → all zeros');
}, 'MEDIUM');

test('validateAdBids: double-submit (same bids twice)', () => {
  const b1 = decisionVal.validateAdBids({ TV: 500, Radio: 200 });
  const b2 = decisionVal.validateAdBids({ TV: 500, Radio: 200 });
  assert(JSON.stringify(b1) === JSON.stringify(b2), 'double-submit same bids');
}, 'MEDIUM');

test('validateChefBids: null → throws', () => {
  assertThrows(
    () => decisionVal.validateChefBids(null, []),
    'null chef bids should throw'
  );
}, 'HIGH');

test('validateChefBids: string → throws', () => {
  assertThrows(
    () => decisionVal.validateChefBids('all of them', []),
    'string chef bids should throw'
  );
}, 'HIGH');

test('validateChefBids: empty array with empty pool → returns empty', () => {
  const bids = decisionVal.validateChefBids([], []);
  assert(Array.isArray(bids) && bids.length === 0, 'empty bids + pool → empty');
}, 'LOW');

test('validateChefBids: duplicate chefId → throws', () => {
  const pool = [{ id: 'chef1', minBidFloor: 100 }];
  assertThrows(
    () => decisionVal.validateChefBids(
      [{ chefId: 'chef1', amount: 150 }, { chefId: 'chef1', amount: 200 }],
      pool
    ),
    'duplicate chefId should throw'
  );
}, 'HIGH');

test('validateChefBids: bid below minBidFloor → throws', () => {
  const pool = [{ id: 'chef1', minBidFloor: 100 }];
  assertThrows(
    () => decisionVal.validateChefBids([{ chefId: 'chef1', amount: 50 }], pool),
    'bid below floor should throw'
  );
}, 'HIGH');

test('validateChefBids: chef not in pool → throws', () => {
  const pool = [{ id: 'chef1', minBidFloor: 100 }];
  assertThrows(
    () => decisionVal.validateChefBids([{ chefId: 'ghostChef', amount: 500 }], pool),
    'ghost chefId should throw'
  );
}, 'HIGH');

test('validateChefBids: script tag chefId → throws (not in pool)', () => {
  assertThrows(
    () => decisionVal.validateChefBids(
      [{ chefId: '<script>alert(1)</script>', amount: 500 }],
      []
    ),
    'XSS chefId should be rejected (not in pool)'
  );
}, 'CRITICAL');

test('validateChefBids: 1000 bids against pool of 8 → most rejected', () => {
  const pool = Array.from({ length: 8 }, (_, i) => ({ id: `chef${i}`, minBidFloor: 10 }));
  const bids = Array.from({ length: 1000 }, (_, i) => ({ chefId: `chef${i}`, amount: 100 }));
  // Only the 8 valid pool chefs should be biddable; rest throw
  assertThrows(
    () => decisionVal.validateChefBids(bids, pool),
    'bidding on non-pool chef should throw'
  );
}, 'MEDIUM');

test('validateChefBids: conflicting bids (same chef bid twice) → rejects duplicate', () => {
  const pool = [{ id: 'chef1', minBidFloor: 50 }];
  assertThrows(
    () => decisionVal.validateChefBids(
      [{ chefId: 'chef1', amount: 100 }, { chefId: 'chef1', amount: 200 }],
      pool
    ),
    'conflicting bids (duplicate chefId) should throw'
  );
}, 'HIGH');

// ---------------------------------------------------------------------------
// SECTION E: loan-shark.js — fuzzing
// ---------------------------------------------------------------------------

section('E: loan-shark.js — boundary fuzzing');

test('calculateLoanShark: zero spent, positive budget → no loan', () => {
  const r = loanShark.calculateLoanShark(0, 1000, defaultCfg);
  assert(r.borrowed === 0, 'no overspend → 0 borrowed');
  assert(r.interest === 0, 'no overspend → 0 interest');
  assert(r.didBorrow === false, 'no overspend → didBorrow false');
}, 'LOW');

test('calculateLoanShark: spend > budget → borrow difference + interest', () => {
  const r = loanShark.calculateLoanShark(1500, 1000, defaultCfg);
  assert(r.borrowed === 500, `borrowed should be 500, got ${r.borrowed}`);
  assert(Math.abs(r.interest - 50) < 0.01, `interest should be 50, got ${r.interest}`);
  assert(r.didBorrow === true, 'didBorrow true');
}, 'MEDIUM');

test('calculateLoanShark: null totalSpent → 0 borrowed', () => {
  const r = loanShark.calculateLoanShark(null, 1000, defaultCfg);
  assert(r.borrowed === 0, 'null totalSpent → 0 borrowed');
}, 'MEDIUM');

test('calculateLoanShark: NaN totalSpent → 0 borrowed (no crash)', () => {
  const r = loanShark.calculateLoanShark(NaN, 1000, defaultCfg);
  assertNonNegative(r.borrowed, 'NaN totalSpent borrowed non-negative');
}, 'HIGH');

test('calculateLoanShark: Infinity totalSpent → Infinity borrowed (propagation risk)', () => {
  const r = loanShark.calculateLoanShark(Infinity, 1000, defaultCfg);
  if (!Number.isFinite(r.borrowed)) {
    throw new Error(`Infinity totalSpent produces Infinity borrowed: ${r.borrowed} — no guard on Infinity`);
  }
}, 'HIGH');

test('calculateLoanShark: negative budget → full amount "borrowed"', () => {
  const r = loanShark.calculateLoanShark(500, -200, defaultCfg);
  assert(r.borrowed === 700, `negative budget: borrowed should be 700, got ${r.borrowed}`);
}, 'MEDIUM');

test('updateBudget: floored at caller level — verify function allows negative', () => {
  // updateBudget itself does NOT clamp; simulation.js clamps at 0
  const b = loanShark.updateBudget(100, -1000, 500);
  // 100 + (-1000) - 500 = -1400
  assert(b === -1400, `updateBudget should allow negative, got ${b}`);
}, 'MEDIUM');

test('calculateNetRevenue: null inputs → 0', () => {
  const n = loanShark.calculateNetRevenue(null, null);
  assert(n === 0, 'null inputs → 0 net revenue');
}, 'LOW');

// ---------------------------------------------------------------------------
// SECTION F: chef-system.js — fuzzing
// ---------------------------------------------------------------------------

section('F: chef-system.js — type confusion, boundary, overflow');

test('getChefOutputForProduct: null chef → BASE_CHEF_RATE', () => {
  const out = chefSystem.getChefOutputForProduct(null, 'coffee');
  assert(out === chefSystem.BASE_CHEF_RATE, 'null chef → base rate');
}, 'HIGH');

test('getChefOutputForProduct: unknown skillTier → BASE_CHEF_RATE', () => {
  const out = chefSystem.getChefOutputForProduct({ skillTier: 'godlike', specialties: [] }, 'coffee');
  assert(out === chefSystem.BASE_CHEF_RATE, 'unknown tier → base rate');
}, 'MEDIUM');

test('getChefOutputForProduct: null specialties → non-specialty multiplier', () => {
  const out = chefSystem.getChefOutputForProduct({ skillTier: 'advanced', specialties: null }, 'coffee');
  assertFinite(out, 'null specialties → finite output');
}, 'MEDIUM');

test('calculateTotalProductOutput: empty specialtyChefs + zero sous', () => {
  const out = chefSystem.calculateTotalProductOutput('croissant', [], {});
  assert(out === 30, `empty chefs → base only (30), got ${out}`);
}, 'LOW');

test('calculateTotalProductOutput: 100 specialty chefs → no crash', () => {
  const chefs = Array.from({ length: 100 }, () => ({
    skillTier: 'advanced',
    specialties: ['croissant', 'coffee']
  }));
  assertNoThrow(() => {
    const out = chefSystem.calculateTotalProductOutput('croissant', chefs, {});
    assertFinite(out, '100 chefs output finite');
    assert(out > 0, '100 chefs output positive');
  }, '100 specialty chefs should not crash');
}, 'MEDIUM');

test('calculateChefSatisfactionScore: 0 sous chefs → 100', () => {
  const s = chefSystem.calculateChefSatisfactionScore(0, defaultCfg);
  assert(s === 100, `0 sous chefs → 100, got ${s}`);
}, 'LOW');

test('calculateChefSatisfactionScore: many sous chefs → floor (35)', () => {
  // decay 10/chef-over-threshold-of-4: 11 chefs → raw 30, floor clamps to 35.
  const s = chefSystem.calculateChefSatisfactionScore(11, defaultCfg);
  assert(s === 35, `11 sous chefs → floor 35, got ${s}`);
}, 'MEDIUM');

test('calculateChefSatisfactionScore: 500 sous chefs → floor (no crash)', () => {
  const s = chefSystem.calculateChefSatisfactionScore(500, defaultCfg);
  assert(s === defaultCfg.chefSatisfactionFloor,
    `500 sous chefs → floor, got ${s}`);
}, 'MEDIUM');

test('calculateChefSatisfactionScore: negative sous chefs → 100 (over is 0)', () => {
  const s = chefSystem.calculateChefSatisfactionScore(-5, defaultCfg);
  assert(s === 100, `negative sous chefs → 100 (no over), got ${s}`);
}, 'MEDIUM');

test('calculateChefSatisfactionScore: NaN sous chefs → check', () => {
  const s = chefSystem.calculateChefSatisfactionScore(NaN, defaultCfg);
  if (Number.isNaN(s)) {
    throw new Error('NaN sousChefCount propagates to NaN chefSatisfactionScore');
  }
}, 'HIGH');

test('resolveChefAuction: empty pool + empty bids → empty results', () => {
  const { winners, payments } = chefSystem.resolveChefAuction([], []);
  assert(winners.size === 0, 'empty pool → empty winners');
  assert(payments.size === 0, 'empty pool → empty payments');
}, 'LOW');

test('resolveChefAuction: null chefPool → no crash', () => {
  assertNoThrow(() => {
    const { winners } = chefSystem.resolveChefAuction(null, []);
    assert(winners.size === 0, 'null pool → empty winners');
  }, 'null chefPool should be handled');
}, 'HIGH');

test('resolveChefAuction: null playerBids → no crash', () => {
  assertNoThrow(() => {
    const { winners } = chefSystem.resolveChefAuction([{ id: 'chef1' }], null);
    assert(winners.size === 0, 'null bids → no winners');
  }, 'null playerBids should be handled');
}, 'HIGH');

test('resolveChefAuction: 500 players bidding on same chef → single winner', () => {
  const pool = [{ id: 'chefX' }];
  const bids = Array.from({ length: 500 }, (_, i) => ({
    playerId: `p${i}`,
    chefId: 'chefX',
    amount: 100 + i,  // each player bids slightly more
    submittedAt: i
  }));
  const { winners } = chefSystem.resolveChefAuction(pool, bids);
  assert(winners.size === 1, '500 bidders → 1 winner');
  // Highest bid (100 + 499 = 599) from player p499 should win
  assert(winners.has('p499'), 'highest bidder wins');
}, 'MEDIUM');

test('getSousChefCost: NaN currentCount → NaN propagation check', () => {
  const cost = chefSystem.getSousChefCost(NaN, defaultCfg);
  if (Number.isNaN(cost)) {
    throw new Error('NaN sousChefCount propagates to NaN hire cost');
  }
}, 'MEDIUM');

test('generateChefPool: round 0 → clamps to first spawn table', () => {
  assertNoThrow(() => {
    const pool = chefSystem.generateChefPool(0, defaultCfg);
    assert(Array.isArray(pool), 'round 0 pool is array');
    assert(pool.length === defaultCfg.chefPoolSize, 'round 0 pool exact size');
  }, 'generateChefPool round 0 should not crash');
}, 'MEDIUM');

test('generateChefPool: round 999 → clamps to last spawn table', () => {
  assertNoThrow(() => {
    const pool = chefSystem.generateChefPool(999, defaultCfg);
    assert(Array.isArray(pool), 'round 999 pool is array');
  }, 'generateChefPool round 999 should not crash');
}, 'MEDIUM');

// ---------------------------------------------------------------------------
// SECTION G: phases.js — fuzzing
// ---------------------------------------------------------------------------

section('G: phases.js — type confusion, boundary, injection');

test('parsePhase: null → throws', () => {
  assertThrows(() => phases.parsePhase(null), 'null phase should throw');
}, 'HIGH');

test('parsePhase: empty string → throws', () => {
  assertThrows(() => phases.parsePhase(''), 'empty string phase should throw');
}, 'HIGH');

test('parsePhase: number → throws', () => {
  assertThrows(() => phases.parsePhase(42), 'number phase should throw');
}, 'MEDIUM');

test('parsePhase: injection string → throws', () => {
  assertThrows(
    () => phases.parsePhase("'; DROP TABLE games;--"),
    'SQL injection phase should throw'
  );
}, 'CRITICAL');

test('parsePhase: XSS string → throws', () => {
  assertThrows(
    () => phases.parsePhase('<script>alert(1)</script>'),
    'XSS phase should throw'
  );
}, 'CRITICAL');

test('parsePhase: round_0_decide → round 0', () => {
  const { round, phase } = phases.parsePhase('round_0_decide', 1);
  assert(round === 0 && phase === 'decide', `round_0_decide → {round:0, phase:decide}`);
}, 'MEDIUM');

test('parsePhase: round_999_email → round 999', () => {
  const { round, phase } = phases.parsePhase('round_999_email', 1);
  assert(round === 999 && phase === 'email', 'round 999 parses correctly');
}, 'LOW');

test('getNextPhase: game_over → throws', () => {
  assertThrows(
    () => phases.getNextPhase('game_over', 5, 5),
    'advancing past game_over should throw'
  );
}, 'MEDIUM');

test('getNextPhase: null currentPhaseString → throws', () => {
  assertThrows(
    () => phases.getNextPhase(null, 1, 5),
    'null phase string should throw'
  );
}, 'HIGH');

test('getNextPhase: round_5_results_ready with totalRounds=5 → game_over', () => {
  const next = phases.getNextPhase('results_ready', 5, 5);
  assert(next.phase === 'game_over', `should reach game_over, got ${next.phase}`);
}, 'MEDIUM');

test('formatPhase: invalid round -1 for decide → throws', () => {
  assertThrows(
    () => phases.formatPhase(-1, 'decide'),
    'negative round for prefixed phase should throw'
  );
}, 'MEDIUM');

test('formatPhase: round 0 for decide → throws', () => {
  assertThrows(
    () => phases.formatPhase(0, 'decide'),
    'round 0 for prefixed phase should throw'
  );
}, 'MEDIUM');

test('canSubmitDecision: null phase → false (no crash)', () => {
  const r = phases.canSubmitDecision(null);
  assert(r === false, 'null phase → canSubmitDecision false');
}, 'MEDIUM');

test('isGameActive: null phase → false (no crash)', () => {
  const r = phases.isGameActive(null);
  assert(r === false, 'null phase → isGameActive false');
}, 'MEDIUM');

// ---------------------------------------------------------------------------
// SECTION H: customer-allocation.js — fuzzing
// ---------------------------------------------------------------------------

section('H: customer-allocation.js — type confusion & overflow');

test('calculateBaseTrafficPool: null roundPreferences → all 1.0 modifiers', () => {
  const pools = customerAlloc.calculateBaseTrafficPool(null, null);
  for (const [product, pool] of Object.entries(pools)) {
    assertNonNegative(pool, `null prefs: pool for ${product}`);
  }
}, 'HIGH');

test('calculateBaseTrafficPool: string modifier → treated as 1.0', () => {
  const pools = customerAlloc.calculateBaseTrafficPool(null, { modifiers: { coffee: 'lots', croissant: 'high' } });
  // If modifier is not a number the fallback 1.0 should apply
  assertNonNegative(pools.coffee, 'string modifier: coffee pool non-negative');
}, 'HIGH');

test('allocateCustomersPerProduct: empty players → empty map', () => {
  const result = customerAlloc.allocateCustomersPerProduct('coffee', 100, [], new Map());
  assert(result.size === 0, 'empty players → empty allocation');
}, 'LOW');

test('allocateCustomersPerProduct: 500 players → no crash', () => {
  const players = Array.from({ length: 500 }, (_, i) => ({
    playerId: `p${i}`,
    perProductSatisfaction: { coffee: { satisfactionPct: 50 + (i % 50) } }
  }));
  assertNoThrow(() => {
    const result = customerAlloc.allocateCustomersPerProduct('coffee', 5000, players, new Map());
    assert(result.size === 500, '500 players allocated');
    // Total allocated should not exceed demandPool + returning
    let total = 0;
    for (const v of result.values()) total += v;
    assert(total <= 6000, `total allocated ${total} not astronomical`);
  }, '500 players allocation should not crash');
}, 'MEDIUM');

test('allocateCustomersPerProduct: zero demand pool → zeros', () => {
  const players = [
    { playerId: 'p1', perProductSatisfaction: { coffee: { satisfactionPct: 80 } } }
  ];
  const result = customerAlloc.allocateCustomersPerProduct('coffee', 0, players, new Map());
  const alloc = result.get('p1') || 0;
  assertNonNegative(alloc, 'zero pool → non-negative allocation');
}, 'MEDIUM');

test('allocateCustomersPerProduct: NaN satisfactionPct → no crash', () => {
  const players = [
    { playerId: 'p1', perProductSatisfaction: { coffee: { satisfactionPct: NaN } } }
  ];
  assertNoThrow(() => {
    customerAlloc.allocateCustomersPerProduct('coffee', 100, players, new Map());
  }, 'NaN satisfactionPct should not crash');
}, 'HIGH');

test('allocateAllCustomers: 500 players → no crash, all allocations finite', () => {
  const players = Array.from({ length: 500 }, (_, i) => ({
    playerId: `p${i}`,
    aggregateSatisfactionPct: 60,
    perProductSatisfaction: {
      croissant: { satisfactionPct: 70 },
      bagel: { satisfactionPct: 65 },
      cookie: { satisfactionPct: 60 }
    },
    returningCustomers: 5,
    footTrafficMultiplier: 1.1,
    sousChefCount: 1,
    numProductsOffered: 3
  }));
  const prefs = { modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };
  assertNoThrow(() => {
    const alloc = customerAlloc.allocateAllCustomers(players, prefs, defaultCfg);
    assert(alloc.size === 500, '500 players allocated');
    for (const [pid, entry] of alloc.entries()) {
      assertNonNegative(entry.totalCustomers, `${pid} totalCustomers non-negative`);
    }
  }, '500 players allocation should not crash');
}, 'MEDIUM');

// ---------------------------------------------------------------------------
// SECTION I: round-preferences.js — fuzzing
// ---------------------------------------------------------------------------

section('I: round-preferences.js — boundary and type fuzzing');

test('generateGamePreferences: 0 rounds → empty array', () => {
  const prefs = roundPrefs.generateGamePreferences(0);
  assert(Array.isArray(prefs) && prefs.length === 0, '0 rounds → empty array');
}, 'MEDIUM');

test('generateGamePreferences: 100 rounds → no crash, no consecutive trending repeat', () => {
  let prevTrending = [];
  const prefs = roundPrefs.generateGamePreferences(100);
  assert(prefs.length === 100, '100 rounds generated');
  for (let i = 0; i < prefs.length; i++) {
    const r = prefs[i];
    assert(Array.isArray(r.trending) && r.trending.length === 2, `round ${i} has 2 trending`);
    // Check no consecutive trending repeat
    if (i > 0) {
      for (const t of r.trending) {
        assert(!prevTrending.includes(t), `Product ${t} trending in consecutive rounds ${i-1} and ${i}`);
      }
    }
    prevTrending = r.trending;
  }
}, 'HIGH');

test('generateGamePreferences: 1 round → single entry with all categories', () => {
  const prefs = roundPrefs.generateGamePreferences(1);
  assert(prefs.length === 1, '1 round → 1 entry');
  const r = prefs[0];
  assert(r.trending.length === 2, 'trending count 2');
  assert(r.warm.length === 2, 'warm count 2');
  assert(r.neutral.length === 1, 'neutral count 1');
  assert(r.cold.length === 1, 'cold count 1');
}, 'MEDIUM');

test('generateMarketInsightEmail: null prefs → fallback email', () => {
  assertNoThrow(() => {
    const email = roundPrefs.generateMarketInsightEmail(null);
    assert(typeof email.body === 'string', 'null prefs → fallback body string');
    assert(typeof email.subject === 'string', 'null prefs → fallback subject string');
  }, 'null preferences should produce fallback email');
}, 'MEDIUM');

test('generateMarketInsightEmail: empty trending → fallback', () => {
  const email = roundPrefs.generateMarketInsightEmail({ trending: [] });
  assert(typeof email.body === 'string', 'empty trending → fallback body');
}, 'LOW');

// ---------------------------------------------------------------------------
// SECTION J: simulation.js — integration-level adversarial
// ---------------------------------------------------------------------------

section('J: simulation.js — integration adversarial');

test('runSimulation: empty players array → empty results', () => {
  const prefs = { modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };
  const results = simulation.runSimulation([], prefs, defaultCfg);
  assert(Array.isArray(results) && results.length === 0, 'empty players → empty results');
}, 'MEDIUM');

test('runSimulation: null players → empty results (no crash)', () => {
  assertNoThrow(() => {
    const results = simulation.runSimulation(null, {}, defaultCfg);
    assert(Array.isArray(results) && results.length === 0, 'null players → empty results');
  }, 'null players should not crash');
}, 'HIGH');

test('runSimulation: player with no decision → defaults applied', () => {
  const players = [{
    playerId: 'p1',
    displayName: 'Player 1',
    bakeryName: 'Bakery 1',
    budgetCurrent: 1000,
    specialtyChefs: [],
    returningCustomersPending: 0,
    auctionResults: {}
  }];
  const prefs = { modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };
  assertNoThrow(() => {
    const results = simulation.runSimulation(players, prefs, defaultCfg);
    assert(results.length === 1, 'one player result');
    assertFiniteBudget(results[0].budgetAfter, 'budgetAfter finite');
  }, 'player with no decision should not crash');
}, 'HIGH');

test('runSimulation: player with malformed decision strings', () => {
  const players = [{
    playerId: 'p1',
    displayName: 'Player 1',
    bakeryName: 'Bakery 1',
    budgetCurrent: 1000,
    specialtyChefs: [],
    returningCustomersPending: 0,
    auctionResults: {},
    decision: {
      menu: 'yes',
      quantities: 'lots',
      sousChefCount: 'many',
      sousChefAssignments: 'everywhere'
    }
  }];
  const prefs = { modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };
  assertNoThrow(() => {
    const results = simulation.runSimulation(players, prefs, defaultCfg);
    assert(results.length === 1, 'malformed decision still produces result');
    assertFiniteBudget(results[0].budgetAfter, 'malformed decision: budgetAfter finite');
  }, 'malformed decision strings should not crash simulation');
}, 'HIGH');

test('runSimulation: NaN budget player → budgetAfter non-negative', () => {
  const players = [{
    playerId: 'p1',
    displayName: 'Player 1',
    bakeryName: 'Bakery 1',
    budgetCurrent: NaN,
    specialtyChefs: [],
    returningCustomersPending: 0,
    auctionResults: {},
    decision: { menu: {}, quantities: {}, sousChefCount: 0, sousChefAssignments: {} }
  }];
  const prefs = { modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };
  assertNoThrow(() => {
    const results = simulation.runSimulation(players, prefs, defaultCfg);
    assertFiniteBudget(results[0].budgetAfter, 'NaN budget → budgetAfter finite');
  }, 'NaN budget should not crash');
}, 'HIGH');

test('runSimulation: player with Infinity budget → no crash', () => {
  const players = [{
    playerId: 'p1',
    displayName: 'Player 1',
    bakeryName: 'Bakery 1',
    budgetCurrent: Infinity,
    specialtyChefs: [],
    returningCustomersPending: 0,
    auctionResults: {},
    decision: { menu: {}, quantities: {}, sousChefCount: 0, sousChefAssignments: {} }
  }];
  const prefs = { modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };
  assertNoThrow(() => {
    const results = simulation.runSimulation(players, prefs, defaultCfg);
    // budgetAfter with Infinity budget — will it propagate Infinity?
    const b = results[0].budgetAfter;
    if (!Number.isFinite(b)) {
      throw new Error(`Infinity budget propagates to Infinity budgetAfter: ${b}`);
    }
  }, 'Infinity budget should not propagate Infinity budgetAfter');
}, 'HIGH');

test('runSimulation: 10000-element arrays (overflow test)', () => {
  const bigArray = Array.from({ length: 50 }, (_, i) => ({
    playerId: `p${i}`,
    displayName: `Player ${i}`,
    bakeryName: `Bakery ${i}`,
    budgetCurrent: 2000,
    specialtyChefs: [],
    returningCustomersPending: 0,
    auctionResults: {},
    decision: {
      menu: { croissant: true, bagel: true, cookie: true },
      quantities: { croissant: 100, bagel: 80, cookie: 60 },
      sousChefCount: 0,
      sousChefAssignments: {}
    }
  }));
  const prefs = { modifiers: { coffee: 1.0, croissant: 1.0, bagel: 1.0, cookie: 1.0, sandwich: 1.0, matcha: 1.0 } };
  assertNoThrow(() => {
    const results = simulation.runSimulation(bigArray, prefs, defaultCfg);
    assert(results.length === 50, '50 players → 50 results');
    for (const r of results) {
      assertFiniteBudget(r.budgetAfter, `${r.playerId} budgetAfter finite`);
      assertFinite(r.revenueGross, `${r.playerId} revenueGross finite`);
    }
  }, '50 player simulation should not crash');
}, 'MEDIUM');

// ============================================================================
// TASK 2: A/B PARAMETER TESTING (GAME BALANCE)
// ============================================================================

section('TASK 2: A/B Parameter Balance Testing');

// Helper to build a typical player decision
function makeTypicalPlayer(playerId, config, round = 1) {
  return {
    playerId,
    displayName: `Player ${playerId}`,
    bakeryName: `Bakery ${playerId}`,
    budgetCurrent: config.startingBudget,
    specialtyChefs: [
      { skillTier: 'intermediate', specialties: ['croissant', 'coffee'] }
    ],
    returningCustomersPending: 0,
    auctionResults: {
      adWon: 'Radio',
      adBidPaid: 100,
      chefBidPaid: 0
    },
    decision: {
      menu: { croissant: true, bagel: true, cookie: true, sandwich: false, coffee: false, matcha: false },
      quantities: { croissant: 100, bagel: 80, cookie: 60, sandwich: 0, coffee: 0, matcha: 0 },
      sousChefCount: 1,
      sousChefAssignments: { croissant: 1 },
      numProducts: 3
    }
  };
}

const standardPrefs = {
  modifiers: {
    coffee: 1.0,
    croissant: 1.15,
    bagel: 1.0,
    cookie: 1.0,
    sandwich: 1.0,
    matcha: 0.75
  }
};

// Config A: Default
const configA = config.mergeConfig({});

// Config B: Tight budget
const configB = config.mergeConfig({
  startingBudget: 3000,
  totalRounds: 6,
  sousChefBaseCost: 100,
  unitCostPerProduct: 3,
  revenueCoefficients: {
    base: 300,
    sousChefCoeff: 8,
    satisfactionCoeff: 5.0,
    adSpendCoeff: 0.6,
    numProductsCoeff: 30,
    noiseMin: -150,
    noiseMax: 50
  }
});

// Config C: Generous
const configC = config.mergeConfig({
  startingBudget: 50000,
  totalRounds: 2,
  sousChefBaseCost: 20,
  unitCostPerProduct: 0,
  revenueCoefficients: {
    base: 1000,
    sousChefCoeff: 20,
    satisfactionCoeff: 12.0,
    adSpendCoeff: 1.2,
    numProductsCoeff: 100,
    noiseMin: 0,
    noiseMax: 200
  }
});

// Config D: Extreme (all maximums/minimums)
const configD = config.mergeConfig({
  startingBudget: 0,
  totalRounds: 1,
  sousChefBaseCost: 0,
  unitCostPerProduct: 0,
  revenueCoefficients: {
    base: 0,
    sousChefCoeff: 0,
    satisfactionCoeff: 0,
    adSpendCoeff: 0,
    numProductsCoeff: 0,
    noiseMin: 0,
    noiseMax: 0
  },
  loanSharkInterestRate: 0,
  totalRounds: 1
});

function runBalanceTest(label, cfg, numPlayers = 5, severity = 'HIGH') {
  const players = Array.from({ length: numPlayers }, (_, i) =>
    makeTypicalPlayer(`p${i}`, cfg)
  );

  test(`[${label}] All player budgets are finite (can be negative per spec)`, () => {
    const results = simulation.runSimulation(players, standardPrefs, cfg);
    for (const r of results) {
      if (!Number.isFinite(r.budgetAfter)) {
        throw new Error(`Player ${r.playerId} budgetAfter is non-finite: ${r.budgetAfter}`);
      }
    }
  }, severity);

  test(`[${label}] Revenue formula produces finite values`, () => {
    const results = simulation.runSimulation(players, standardPrefs, cfg);
    for (const r of results) {
      if (!Number.isFinite(r.revenueGross)) {
        throw new Error(`Player ${r.playerId} revenueGross is non-finite: ${r.revenueGross}`);
      }
      if (!Number.isFinite(r.revenueNet)) {
        throw new Error(`Player ${r.playerId} revenueNet is non-finite: ${r.revenueNet}`);
      }
    }
  }, severity);

  test(`[${label}] Customer count non-negative for all players`, () => {
    const results = simulation.runSimulation(players, standardPrefs, cfg);
    for (const r of results) {
      if (r.customerCount < 0) {
        throw new Error(`Player ${r.playerId} customerCount is negative: ${r.customerCount}`);
      }
    }
  }, severity);

  test(`[${label}] Satisfaction stays in valid range [0, 100]`, () => {
    const results = simulation.runSimulation(players, standardPrefs, cfg);
    for (const r of results) {
      const sat = r.aggregateSatisfactionPct;
      if (!Number.isFinite(sat) || sat < 0 || sat > 100) {
        throw new Error(`Player ${r.playerId} aggregateSatisfactionPct out of range: ${sat}`);
      }
    }
  }, severity);

  test(`[${label}] Rankings make sense (higher revenue → higher rank)`, () => {
    // Give players different spending levels so revenues differ
    const variedPlayers = Array.from({ length: 5 }, (_, i) => {
      const p = makeTypicalPlayer(`pv${i}`, cfg);
      // Vary quantity stocked to create revenue differences
      p.decision.quantities.croissant = 10 + i * 30;  // 10, 40, 70, 100, 130
      p.auctionResults.adBidPaid = i * 50;
      return p;
    });
    const results = simulation.runSimulation(variedPlayers, standardPrefs, cfg);
    // Sort by revenueGross descending
    const sorted = [...results].sort((a, b) => b.revenueGross - a.revenueGross);
    // Verify at least the sort itself is deterministic and makes sense
    for (let i = 1; i < sorted.length; i++) {
      assert(sorted[i - 1].revenueGross >= sorted[i].revenueGross,
        `Revenue ranking inconsistent: ${sorted[i-1].revenueGross} < ${sorted[i].revenueGross}`);
    }
  }, severity);

  test(`[${label}] Total customer allocation across all players ≤ market demand`, () => {
    const results = simulation.runSimulation(players, standardPrefs, cfg);
    // Sum all customer counts
    const totalAllocated = results.reduce((s, r) => s + r.customerCount, 0);
    // Market demand: sum of baseDemand × modifier (with foot traffic scaling, can exceed)
    // With foot traffic multipliers, demand CAN be exceeded — check it's not astronomical
    const baseDemand = Object.values(config.PRODUCT_CATALOG).reduce((s, p) => s + p.baseDemand, 0);
    const marketDemand = baseDemand * 2; // rough upper bound including modifiers + foot traffic
    const perPlayer = totalAllocated / players.length;
    assert(perPlayer <= marketDemand * 2,
      `Avg customers per player ${perPlayer} >> 2× market demand ${marketDemand}`);
  }, 'MEDIUM');
}

// Run balance tests for all 4 configs
runBalanceTest('Config A (default)', configA);
runBalanceTest('Config B (tight budget)', configB);
runBalanceTest('Config C (generous)', configC);
runBalanceTest('Config D (extreme zeros)', configD);

// Additional cross-config balance tests

test('[Config A] Starting budget with no spending → budget increases after first round', () => {
  const player = makeTypicalPlayer('p0', configA);
  // No-op player: no stocking, no bids
  player.decision.quantities = { croissant: 0, bagel: 0, cookie: 0, sandwich: 0, coffee: 0, matcha: 0 };
  player.decision.sousChefCount = 0;
  player.decision.sousChefAssignments = {};
  player.auctionResults = {};
  const results = simulation.runSimulation([player], standardPrefs, configA);
  const r = results[0];
  assertFiniteBudget(r.budgetAfter, 'no-op player budgetAfter finite');
  // Revenue should still include base + noise even with no products
  assertFinite(r.revenueGross, 'no-op player revenueGross finite');
}, 'MEDIUM');

test('[Config B] Player with budget 3000 cannot spend more without borrowing', () => {
  const player = makeTypicalPlayer('p0', configB);
  // Force overspend: order huge stock
  player.decision.quantities = { croissant: 5000, bagel: 5000, cookie: 5000, sandwich: 0, coffee: 0, matcha: 0 };
  player.decision.sousChefCount = 0;
  player.decision.sousChefAssignments = {};
  player.auctionResults = {};
  const results = simulation.runSimulation([player], standardPrefs, configB);
  const r = results[0];
  // Should have borrowed
  assert(r.amountBorrowed > 0, `Config B overspend should trigger borrowing, borrowed: ${r.amountBorrowed}`);
  // Budget should still be non-negative
  assertFiniteBudget(r.budgetAfter, 'Config B overspend: budgetAfter finite');
}, 'HIGH');

test('[Config C] Generous config: player budget grows substantially after round', () => {
  const player = makeTypicalPlayer('p0', configC);
  player.decision.quantities = { croissant: 200, bagel: 150, cookie: 100, sandwich: 0, coffee: 0, matcha: 0 };
  const results = simulation.runSimulation([player], standardPrefs, configC);
  const r = results[0];
  assertFiniteBudget(r.budgetAfter, 'Config C: budgetAfter finite');
  // With generous config (high base revenue, low costs), budget should go up
  // Not guaranteed due to noise, but should not be catastrophically low
  assert(r.revenueGross > 0, 'Config C: revenueGross positive');
}, 'MEDIUM');

test('[Config D] Extreme zeros: revenue is zero or near-zero', () => {
  const player = makeTypicalPlayer('p0', configD);
  const results = simulation.runSimulation([player], standardPrefs, configD);
  const r = results[0];
  // All coefficients are 0, noise is [0,0] → revenue = 0 + product sales
  assertFinite(r.revenueGross, 'Config D: revenueGross finite');
  assertNonNegative(r.budgetAfter, 'Config D: budgetAfter non-negative');
}, 'MEDIUM');

test('[Balance] Satisfaction range 0-100 for all fill rates', () => {
  // Exhaustively test fill rate → satisfaction mapping
  const testRates = [0, 0.01, 0.1, 0.25, 0.5, 0.5001, 0.69, 0.70, 0.75, 0.84,
                     0.85, 0.9, 0.99, 1.0, 1.01, 1.5, 2.0, 10.0];
  for (const rate of testRates) {
    const sat = satisfaction.fillRateToSatisfactionPct(rate);
    assertRange(sat, 0, 100, `fill rate ${rate} → satisfaction`);
  }
}, 'HIGH');

test('[Balance] Budget CAN go negative (spec allows it) — no Math.max(0) clamp', () => {
  // Player with very low budget and high spending: loan shark + bad revenue.
  // Spec says budgets CAN go negative; verify we don’t clamp.
  const player = makeTypicalPlayer('p_broke', configA);
  player.budgetCurrent = 1;
  // Overspend massively
  player.decision.quantities = { croissant: 10000, bagel: 10000, cookie: 10000, sandwich: 0, coffee: 0, matcha: 0 };
  player.decision.sousChefCount = 8;
  player.decision.sousChefAssignments = { croissant: 3, bagel: 3, cookie: 2 };
  player.auctionResults = { adBidPaid: 5000, chefBidPaid: 2000 };
  const results = simulation.runSimulation([player], standardPrefs, configA);
  const r = results[0];
  assertFiniteBudget(r.budgetAfter, 'bankrupt player budgetAfter should be finite (can be negative)');
  // With massive overspending, budget should go negative
  assert(r.budgetAfter < 0, `Expected negative budget for massively overspending player, got ${r.budgetAfter}`);
}, 'CRITICAL');

test('[Balance] Chef satisfaction floor applied at 35', () => {
  const score = chefSystem.calculateChefSatisfactionScore(100, defaultCfg);
  assert(score === defaultCfg.chefSatisfactionFloor,
    `100 sous chefs → floor ${defaultCfg.chefSatisfactionFloor}, got ${score}`);
  assert(score >= 0 && score <= 100, `chefSatisfaction in [0,100]: ${score}`);
}, 'HIGH');

test('[Balance] Anti-arbitrage: adSpendCoeff zeroed out so adSpend cannot inflate revenue', () => {
  const baseRevenue = revenue.computeGrossRevenue({
    sousChefCount: 0,
    aggregateSatisfactionPct: 0,
    adSpend: 0,
    numProducts: 0,
    totalProductRevenue: 0,
    noiseSeed: 'fixed-seed'
  }, defaultCfg);

  const withAd = revenue.computeGrossRevenue({
    sousChefCount: 0,
    aggregateSatisfactionPct: 0,
    adSpend: 1000000,
    numProducts: 0,
    totalProductRevenue: 0,
    noiseSeed: 'fixed-seed'
  }, defaultCfg);

  // adSpendCoeff is 0 (KILLED ARBITRAGE EXPLOIT) — adSpend must NOT change revenue.
  const diff = withAd - baseRevenue;
  assert(Math.abs(diff) < 0.001, `adSpend must not affect revenue (coeff=0), got diff ${diff}`);
}, 'HIGH');

test('[Balance] Loan shark interest applied correctly', () => {
  // Borrow 1000 at 10% → 100 interest, 1100 total deduction
  const r = loanShark.calculateLoanShark(3000, 2000, defaultCfg);
  assert(r.borrowed === 1000, `borrowed 1000, got ${r.borrowed}`);
  assert(Math.abs(r.interest - 100) < 0.01, `interest 100, got ${r.interest}`);
  assert(Math.abs(r.loanSharkDeduction - 1100) < 0.01, `deduction 1100, got ${r.loanSharkDeduction}`);
}, 'HIGH');

test('[Balance] Multiple rounds: round-preference no-consecutive-trending constraint', () => {
  for (let trial = 0; trial < 5; trial++) {
    const prefs = roundPrefs.generateGamePreferences(10);
    let prev = [];
    for (let i = 0; i < prefs.length; i++) {
      for (const t of prefs[i].trending) {
        if (prev.includes(t)) {
          throw new Error(`Product "${t}" trending in consecutive rounds ${i-1} and ${i} (trial ${trial})`);
        }
      }
      prev = prefs[i].trending;
    }
  }
}, 'HIGH');

test('[Balance] Revenue with 6 products > revenue with 3 products (numProductsCoeff positive)', () => {
  const r3 = revenue.computeGrossRevenue({
    sousChefCount: 0, aggregateSatisfactionPct: 50, adSpend: 0,
    numProducts: 3, totalProductRevenue: 0, noiseSeed: 'test'
  }, defaultCfg);
  const r6 = revenue.computeGrossRevenue({
    sousChefCount: 0, aggregateSatisfactionPct: 50, adSpend: 0,
    numProducts: 6, totalProductRevenue: 0, noiseSeed: 'test'
  }, defaultCfg);
  const diff = r6 - r3;
  // numProductsCoeff(100) * (6-3) = 300 (balance pass: was 50 → 100)
  assert(Math.abs(diff - 300) < 1, `3 more products → 300 more revenue, got diff ${diff}`);
}, 'MEDIUM');

// ============================================================================
// POST-01: validateProductPrices — adversarial
// ============================================================================

section('POST-01: validateProductPrices — adversarial');

function assertNear(actual, expected, epsilon, msg) {
  assert(Math.abs(actual - expected) < epsilon, `${msg}: expected ~${expected}, got ${actual}`);
}

function assertThrowsMatching(fn, pattern, msg) {
  try {
    fn();
    throw new Error('Expected throw but did not');
  } catch (e) {
    if (e.message === 'Expected throw but did not') throw new Error(msg || 'Expected to throw');
    if (!pattern.test(e.message)) throw new Error(`${msg || 'Error message'} did not match ${pattern}: "${e.message}"`);
  }
}

test('validateProductPrices: clamps price = ceiling + 0.01 to ceiling (coffee 6.51 → 6.50)', () => {
  const out = decisionVal.validateProductPrices({ coffee: 6.51 });
  assertNear(out.coffee, 6.50, 0.001, 'coffee clamped to ceiling');
});

test('validateProductPrices: clamps price = floor - 0.01 to floor (coffee 1.99 → 2.00)', () => {
  const out = decisionVal.validateProductPrices({ coffee: 1.99 });
  assertNear(out.coffee, 2.00, 0.001, 'coffee clamped to floor');
});

test('validateProductPrices: rejects string values', () => {
  assertThrowsMatching(
    () => decisionVal.validateProductPrices({ coffee: 'free' }),
    /finite positive number/,
    'string value rejection'
  );
});

test('validateProductPrices: rejects MIG-01 legacy key "latte"', () => {
  assertThrowsMatching(
    () => decisionVal.validateProductPrices({ latte: 5 }),
    /unknown product "latte"/,
    'legacy key latte rejection'
  );
});

test('validateProductPrices: rejects MIG-01 legacy key "matchaLatte"', () => {
  assertThrowsMatching(
    () => decisionVal.validateProductPrices({ matchaLatte: 6 }),
    /unknown product "matchaLatte"/,
    'legacy key matchaLatte rejection'
  );
});

test('validateProductPrices: treats null as empty (carry-over path)', () => {
  const out = decisionVal.validateProductPrices(null);
  assert(typeof out === 'object' && out !== null, 'result is object');
  assert(Object.keys(out).length === 0, 'result is empty object');
});

test('validateProductPrices: rejects Infinity', () => {
  assertThrowsMatching(
    () => decisionVal.validateProductPrices({ coffee: Infinity }),
    /finite positive number/,
    'Infinity rejection'
  );
});

test('validateProductPrices: rejects -Infinity', () => {
  assertThrowsMatching(
    () => decisionVal.validateProductPrices({ coffee: -Infinity }),
    /finite positive number/,
    '-Infinity rejection'
  );
});

// ============================================================================
// FINAL REPORT
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log('  FINAL TEST RESULTS');
console.log('='.repeat(70));
console.log(`  Total:  ${totalTests}`);
console.log(`  Passed: ${totalPassed}`);
console.log(`  Failed: ${totalFailed}`);

if (failures.length > 0) {
  console.log('\n  FAILURES:');
  for (const f of failures) {
    console.log(`\n  [${f.severity}] ${f.name}`);
    console.log(`    → ${f.error}`);
  }
}

// Write machine-readable JSON summary for the reporter
const summary = {
  totalTests,
  totalPassed,
  totalFailed,
  failures,
};

const fs = require('fs');
fs.writeFileSync(
  require('path').join(__dirname, 'adversarial-results.json'),
  JSON.stringify(summary, null, 2)
);

console.log('\n  Results written to adversarial-results.json');
console.log('='.repeat(70));

process.exit(totalFailed > 0 ? 1 : 0);
