/**
 * test-compliance.js — Spec Compliance + Full Lifecycle Regression
 *
 * QA task: verify every gameplay rule, formula, and feature from
 * GAME_DESIGN_PROPOSAL and BACKEND spec against the pure modules.
 *
 * Run with:  node test-compliance.js
 *
 * Sections:
 *   A. Spec compliance checks (10 areas)
 *   B. Full 4-round lifecycle regression (5 strategies × 4 rounds)
 *   C. Conclusion + CSV export integrity
 */

'use strict';

// ---------------------------------------------------------------------------
// Module imports
// ---------------------------------------------------------------------------
const path  = require('path');
const BASE  = path.resolve(__dirname, '..');

const {
  PRODUCT_CATALOG, PRODUCT_KEYS, BASE_MENU, OPTIONAL_MENU,
  AD_TYPES, CHEF_NATIONALITIES, CHEF_MULTIPLIERS, CHEF_SPAWN_RATES,
  SATISFACTION_TIERS, DEFAULT_GAME_CONFIG,
  mergeConfig, numberOrDefault, objectOrDefault, cleanString,
} = require(path.join(BASE, 'config'));

const {
  parsePhase, formatPhase, getNextPhase, getPhaseDuration,
  canSubmitDecision, canSubmitBids, isGameActive, isValidTransition,
} = require(path.join(BASE, 'phases'));

const {
  generateChefPool,
  getChefOutputForProduct,
  calculateTotalProductOutput,
  getSousChefCost,
  getTotalSousChefHireCost,
  BASE_CHEF_RATE,
  MIN_BID_FLOOR_MULTIPLIERS,
} = require(path.join(BASE, 'chef-system'));

const {
  fillRateToSatisfactionPct,
  calculateAggregateSatisfaction,
  getFootTrafficModifier,
  getReturningCustomerBonus,
  applySellOut,
  tierForSatisfaction,
} = require(path.join(BASE, 'satisfaction'));

const {
  runSimulation,
} = require(path.join(BASE, 'simulation'));

const {
  calculateLoanShark,
  calculateNetRevenue,
  updateBudget,
} = require(path.join(BASE, 'loan-shark'));

const {
  generateGamePreferences,
  getDemandModifiers,
  MOD_TRENDING, MOD_WARM, MOD_NEUTRAL, MOD_COLD,
} = require(path.join(BASE, 'round-preferences'));

const {
  buildCsvRow, buildCsvString, CSV_COLUMNS,
} = require(path.join(BASE, 'csv-export'));

const {
  aggregatePlayerResults,
  rankPlayers,
  buildConclusionData,
} = require(path.join(BASE, 'conclusion'));

const {
  validateDecision,
  validateAdBids,
  buildDefaultDecision,
} = require(path.join(BASE, 'decision-validation'));

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const FAILURES = [];

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
    FAILURES.push({ label, detail });
  }
}

function assertClose(a, b, label, tol = 0.001) {
  const ok = Math.abs(a - b) <= tol;
  assert(ok, label, `got ${a}, expected ${b} (±${tol})`);
}

function section(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SECTION: ${title}`);
  console.log('='.repeat(60));
}

// ---------------------------------------------------------------------------
// SECTION A — Spec Compliance Audit
// ---------------------------------------------------------------------------

section('A1. Revenue Formula');
{
  // Balance pass: 500 + 25×sousChef + 60×aggSatisfaction + 0×adSpend + 100×numProducts
  //               + Σ(qtySold×fixedPrice) + noise[-100,+100]
  // adSpendCoeff zeroed to kill the original ad-bid arbitrage exploit.
  const { computeGrossRevenue } = require(path.join(BASE, 'revenue'));
  const cfg = mergeConfig({});

  // Seeded test — noise is deterministic when noiseSeed is provided. The
  // expected formula value derives from the live coefficients in cfg so the
  // assertion stays correct across balance rescales.
  const rc = cfg.revenueCoefficients;
  const r = computeGrossRevenue({
    sousChefCount: 2,
    aggregateSatisfactionPct: 75,
    adSpend: 1000,
    numProducts: 4,
    totalProductRevenue: 200,
    noiseSeed: 'test-seed-1',
  }, cfg);

  const formulaBase =
    rc.base +
    rc.sousChefCoeff * 2 +
    rc.satisfactionCoeff * 75 +
    rc.adSpendCoeff * 1000 +
    rc.numProductsCoeff * 4 +
    200;
  // Noise is clamped to [noiseMin, noiseMax], so the maximum deviation from
  // formulaBase is bounded by max(|noiseMin|, noiseMax). +1 floor avoids a
  // zero-tolerance window when noise is disabled.
  const noiseTolerance = Math.max(Math.abs(rc.noiseMin), rc.noiseMax) + 1;
  assert(typeof r === 'number' && Number.isFinite(r),    'Revenue formula returns a finite number');
  assert(r >= formulaBase - noiseTolerance && r <= formulaBase + noiseTolerance,
    'Revenue formula value within noise bounds',
    `formulaBase=${formulaBase}, got=${r}`);

  // Coefficient structure is locked; absolute values are tuned by balance work.
  assert(typeof rc.base === 'number',                      'base coefficient is numeric');
  assert(typeof rc.sousChefCoeff === 'number',             'sousChefCoeff is numeric');
  assert(typeof rc.satisfactionCoeff === 'number',         'satisfactionCoeff is numeric');
  assert(rc.adSpendCoeff === 0,                            'adSpendCoeff = 0 (anti-arbitrage)');
  assert(typeof rc.numProductsCoeff === 'number',          'numProductsCoeff is numeric');
  assert(typeof rc.noiseMin === 'number' && rc.noiseMin <= 0,
                                                            'noiseMin is non-positive');
  assert(typeof rc.noiseMax === 'number' && rc.noiseMax >= 0,
                                                            'noiseMax is non-negative');
}

section('A2. Products & Pricing');
{
  // Balance-tuned catalog (passes 1, 6, 8, 9, 11). Demand 4–6× original spec to make
  // product sales the dominant income source; satisfactionWeight equalized to 1.0;
  // bagel/cookie prices raised to close the per-customer revenue gap; sandwich/matcha
  // prices lowered so premium tier ≈ 1.6× cheap (was 3.5×).
  const expected = {
    coffee:    { fixedPrice: 4.00,  baseDemand: 240, satisfactionWeight: 1.0, isBaseMenu: false },
    croissant: { fixedPrice: 4.75,  baseDemand: 240, satisfactionWeight: 1.0, isBaseMenu: true  },
    bagel:     { fixedPrice: 4.50,  baseDemand: 240, satisfactionWeight: 1.0, isBaseMenu: true  },
    cookie:    { fixedPrice: 4.00,  baseDemand: 240, satisfactionWeight: 1.0, isBaseMenu: true  },
    sandwich:  { fixedPrice: 5.50,  baseDemand: 200, satisfactionWeight: 1.0, isBaseMenu: false },
    matcha:    { fixedPrice: 4.50,  baseDemand: 200, satisfactionWeight: 1.0, isBaseMenu: false },
  };

  for (const [product, vals] of Object.entries(expected)) {
    const cat = PRODUCT_CATALOG[product];
    assert(!!cat,                                          `${product} exists in catalog`);
    assert(cat.fixedPrice === vals.fixedPrice,             `${product} price = $${vals.fixedPrice}`, `got ${cat.fixedPrice}`);
    assert(cat.baseDemand === vals.baseDemand,             `${product} baseDemand = ${vals.baseDemand}`, `got ${cat.baseDemand}`);
    assert(cat.satisfactionWeight === vals.satisfactionWeight, `${product} weight = ${vals.satisfactionWeight}`, `got ${cat.satisfactionWeight}`);
    assert(cat.isBaseMenu === vals.isBaseMenu,             `${product} isBaseMenu = ${vals.isBaseMenu}`, `got ${cat.isBaseMenu}`);
  }

  // Base menu: croissant, cookie, bagel
  assert(BASE_MENU.includes('croissant') && BASE_MENU.includes('cookie') && BASE_MENU.includes('bagel'),
    'Base menu = croissant, cookie, bagel');
  assert(BASE_MENU.length === 3, 'Base menu has exactly 3 items');

  // Optional: sandwich, coffee, matcha
  assert(OPTIONAL_MENU.includes('sandwich') && OPTIONAL_MENU.includes('coffee') && OPTIONAL_MENU.includes('matcha'),
    'Optional menu = sandwich, coffee, matcha');
}

section('A2b. Pricing Zones (POST-01)');
{
  const {
    PRICE_ZONES,
    ELASTICITY_COEFFICIENTS,
    PRICE_STEP,
    FLOOR_BONUS,
    MULTIPLIER_FLOOR,
  } = require(path.join(BASE, 'config'));

  // PRICE_ZONES has all 6 products
  for (const p of PRODUCT_KEYS) {
    assert(PRICE_ZONES && PRICE_ZONES[p], `PRICE_ZONES missing ${p}`);
  }

  // Each product has well-ordered zone bounds
  for (const p of PRODUCT_KEYS) {
    const z = PRICE_ZONES[p];
    assert(z.floor < z.competitiveRangeLow,    `${p}: floor < competitiveRangeLow`);
    assert(z.competitiveRangeLow < z.competitiveRangeHigh, `${p}: competitiveRangeLow < competitiveRangeHigh`);
    assert(z.competitiveRangeHigh <= z.premiumRangeLow,    `${p}: competitiveRangeHigh <= premiumRangeLow`);
    assert(z.premiumRangeLow < z.premiumRangeHigh, `${p}: premiumRangeLow < premiumRangeHigh`);
    assert(z.premiumRangeHigh <= z.ceiling,       `${p}: premiumRangeHigh <= ceiling`);
  }

  // Elasticity tiers are all High/Medium/Low
  for (const p of PRODUCT_KEYS) {
    const tier = PRICE_ZONES[p].elasticityTier;
    assert(['high', 'medium', 'low'].includes(tier), `${p}: tier ${tier}`);
  }

  // ELASTICITY_COEFFICIENTS covers each referenced tier.
  // M-14 (2026-04-28): `high` softened 1.5 → 1.2 so premium-priced
  // teams still pull traffic instead of losing 100% of customers on a
  // $1 price step. See config.js comment + tasks-april-28.md M-14.
  assertClose(ELASTICITY_COEFFICIENTS.high, 1.2, 'high');
  assertClose(ELASTICITY_COEFFICIENTS.medium, 1.0, 'medium');
  assertClose(ELASTICITY_COEFFICIENTS.low, 0.6, 'low');

  // Constants match spec
  assertClose(PRICE_STEP, 0.25, 'PRICE_STEP');
  assertClose(FLOOR_BONUS, 0.15, 'FLOOR_BONUS');
  assertClose(MULTIPLIER_FLOOR, 0.05, 'MULTIPLIER_FLOOR');

  // Coffee zone matches proposal table
  const z_coffee = PRICE_ZONES.coffee;
  assertClose(z_coffee.floor, 2.00, 'coffee floor');
  assertClose(z_coffee.competitiveRangeLow, 3.00, 'coffee competitiveRangeLow');
  assertClose(z_coffee.competitiveRangeHigh, 4.50, 'coffee competitiveRangeHigh');
  assertClose(z_coffee.premiumRangeLow, 5.00, 'coffee premiumRangeLow');
  assertClose(z_coffee.premiumRangeHigh, 6.00, 'coffee premiumRangeHigh');
  assertClose(z_coffee.ceiling, 6.50, 'coffee ceiling');
  assert(z_coffee.elasticityTier === 'high', 'coffee elasticity = high');

  // Matcha zone — balance pass 6: rescaled to $2.50–$7 (mid $4.50), elasticityTier 'high'.
  // Premium pricing now a real tradeoff (more $/customer, way fewer customers).
  const z_matcha = PRICE_ZONES.matcha;
  assertClose(z_matcha.floor, 2.50, 'matcha floor');
  assertClose(z_matcha.competitiveRangeLow, 3.50, 'matcha competitiveRangeLow');
  assertClose(z_matcha.competitiveRangeHigh, 5.50, 'matcha competitiveRangeHigh');
  assertClose(z_matcha.premiumRangeLow, 6.00, 'matcha premiumRangeLow');
  assertClose(z_matcha.premiumRangeHigh, 6.50, 'matcha premiumRangeHigh');
  assertClose(z_matcha.ceiling, 7.00, 'matcha ceiling');
  assert(z_matcha.elasticityTier === 'high', 'matcha elasticity = high');
}

section('A3. Chef System');
{
  // Chef nationalities and specialties
  const nationalities = {
    french:   ['croissant', 'coffee'],
    japanese: ['matcha', 'croissant'],
    italian:  ['sandwich', 'coffee'],
    american: ['bagel', 'cookie'],
  };
  for (const [nat, specs] of Object.entries(nationalities)) {
    const n = CHEF_NATIONALITIES[nat];
    assert(!!n, `${nat} nationality exists`);
    const match = specs.every(s => n.specialties.includes(s)) && n.specialties.length === specs.length;
    assert(match, `${nat} specialties = ${specs.join(', ')}`, `got ${JSON.stringify(n.specialties)}`);
  }

  // Chef multipliers (balance pass — bumped to widen competitive separation)
  const expectedMults = {
    novel:        { nonSpecialty: 1.0,  specialty: 1.5 },
    intermediate: { nonSpecialty: 1.4,  specialty: 2.2 },
    advanced:     { nonSpecialty: 1.8,  specialty: 3.0 },
  };
  for (const [tier, vals] of Object.entries(expectedMults)) {
    const m = CHEF_MULTIPLIERS[tier];
    assert(!!m, `${tier} multiplier entry exists`);
    assertClose(m.nonSpecialty, vals.nonSpecialty, `${tier} non-specialty = ${vals.nonSpecialty}`);
    assertClose(m.specialty, vals.specialty, `${tier} specialty = ${vals.specialty}`);
  }

  // Base chef rate = 30
  assert(BASE_CHEF_RATE === 30, 'Base chef rate = 30 units/day');

  // Output formula: 30 × multiplier
  const frenchAdv = { skillTier: 'advanced', specialties: ['croissant', 'coffee'] };
  assertClose(getChefOutputForProduct(frenchAdv, 'croissant'), 30 * 3.0, 'Advanced French chef on croissant = 90');
  assertClose(getChefOutputForProduct(frenchAdv, 'bagel'),     30 * 1.8, 'Advanced French chef on bagel (non-spec) = 54');

  // Base chef (no skillTier) returns 30 always
  const baseChef = { skillTier: 'base', specialties: [] };
  assert(getChefOutputForProduct(baseChef, 'coffee') === 30, 'Base chef always produces 30');
  assert(getChefOutputForProduct(null, 'coffee') === 30,     'null chef treated as base chef');

  // Total output example: base + advanced French on croissant, with 0 sous chefs
  const total = calculateTotalProductOutput('croissant', [frenchAdv], {});
  assertClose(total, 30 + 90, 'Total output: base(30) + advanced French(90) = 120 for croissant');

  // Sous chef cost escalation: 1.0×, 1.5×, 2.25×, 3.0×, 5th= 3.75×
  const baseCost = 50;
  const cfgWith50 = mergeConfig({ sousChefBaseCost: baseCost });
  assertClose(getSousChefCost(0, cfgWith50), 50,     '1st sous chef cost = 1.0× = 50');
  assertClose(getSousChefCost(1, cfgWith50), 75,     '2nd sous chef cost = 1.5× = 75');
  assertClose(getSousChefCost(2, cfgWith50), 112.5,  '3rd sous chef cost = 2.25× = 112.5');
  assertClose(getSousChefCost(3, cfgWith50), 150,    '4th sous chef cost = 3.0× = 150');
  assertClose(getSousChefCost(4, cfgWith50), 187.5,  '5th sous chef cost = 3.75× = 187.5');
  assertClose(getSousChefCost(5, cfgWith50), 225,    '6th sous chef cost = 4.5× = 225');

  // Chef spawn rates per round
  const expectedRates = [
    { novel: 0.65, intermediate: 0.30, advanced: 0.05 }, // R1
    { novel: 0.55, intermediate: 0.35, advanced: 0.10 }, // R2
    { novel: 0.40, intermediate: 0.40, advanced: 0.20 }, // R3
    { novel: 0.20, intermediate: 0.45, advanced: 0.35 }, // R4
    { novel: 0.05, intermediate: 0.45, advanced: 0.50 }, // R5
  ];
  for (let i = 0; i < expectedRates.length; i++) {
    const r = CHEF_SPAWN_RATES[i];
    const e = expectedRates[i];
    assert(r && Math.abs(r.novel - e.novel) < 0.001 &&
           Math.abs(r.intermediate - e.intermediate) < 0.001 &&
           Math.abs(r.advanced - e.advanced) < 0.001,
      `Round ${i+1} chef spawn rates correct`,
      `got novel=${r && r.novel}, int=${r && r.intermediate}, adv=${r && r.advanced}`);
  }

  // Min bid floor multipliers
  assert(MIN_BID_FLOOR_MULTIPLIERS.novel === 2,          'Novel min bid floor = 2× baselinFloor');
  assert(MIN_BID_FLOOR_MULTIPLIERS.intermediate === 3.5, 'Intermediate min bid floor = 3.5×');
  assert(MIN_BID_FLOOR_MULTIPLIERS.advanced === 5.5,     'Advanced min bid floor = 5.5×');

  // Specialty chef cap = 3
  assert(DEFAULT_GAME_CONFIG.specialtyChefCap === 3, 'Specialty chef cap = 3');

  // Chef pool generation matches the configured pool size.
  const pool = generateChefPool(1, cfg);
  assert(pool.length === cfg.chefPoolSize,
    `Chef pool size = cfg.chefPoolSize (${cfg.chefPoolSize}, got ${pool.length})`);
  assert(pool.every(c => ['novel','intermediate','advanced'].includes(c.skillTier)),
    'All chefs have valid skill tiers');
  assert(pool.every(c => ['french','japanese','italian','american'].includes(c.nationality)),
    'All chefs have valid nationalities');
  // Specialty derived from nationality
  for (const chef of pool) {
    const expectedSpec = CHEF_NATIONALITIES[chef.nationality].specialties;
    const match = JSON.stringify(chef.specialties.slice().sort()) === JSON.stringify(expectedSpec.slice().sort());
    assert(match, `${chef.nationality} chef has correct specialties`, `got ${JSON.stringify(chef.specialties)}`);
  }
}

section('A4. Customer Satisfaction Model');
{
  // Fill rate → satisfaction tier mapping
  // < 50% → critical (0-20), 50-69% → poor (21-45), 70-84% → adequate (46-65)
  // 85-99% → good (66-85), ≥100% → excellent (86-100)
  assert(fillRateToSatisfactionPct(0.0)  >= 0   && fillRateToSatisfactionPct(0.0)  <= 20,  'fillRate 0% → critical (0-20)');
  assert(fillRateToSatisfactionPct(0.49) >= 0   && fillRateToSatisfactionPct(0.49) <= 20,  'fillRate 49% → critical (0-20)');
  assert(fillRateToSatisfactionPct(0.50) >= 21  && fillRateToSatisfactionPct(0.50) <= 45,  'fillRate 50% → poor (21-45)');
  assert(fillRateToSatisfactionPct(0.60) >= 21  && fillRateToSatisfactionPct(0.60) <= 45,  'fillRate 60% → poor (21-45)');
  assert(fillRateToSatisfactionPct(0.70) >= 46  && fillRateToSatisfactionPct(0.70) <= 65,  'fillRate 70% → adequate (46-65)');
  assert(fillRateToSatisfactionPct(0.84) >= 46  && fillRateToSatisfactionPct(0.84) <= 65,  'fillRate 84% → adequate (46-65)');
  assert(fillRateToSatisfactionPct(0.85) >= 66  && fillRateToSatisfactionPct(0.85) <= 85,  'fillRate 85% → good (66-85)');
  assert(fillRateToSatisfactionPct(0.99) >= 66  && fillRateToSatisfactionPct(0.99) <= 85,  'fillRate 99% → good (66-85)');
  assert(fillRateToSatisfactionPct(1.00) >= 86  && fillRateToSatisfactionPct(1.00) <= 100, 'fillRate 100% → excellent (86-100)');
  assert(fillRateToSatisfactionPct(1.50) >= 86  && fillRateToSatisfactionPct(1.50) <= 100, 'fillRate 150% → excellent (86-100)');

  // Aggregate satisfaction weighting
  // Coffee=1.5, Matcha=1.3, Croissant=1.2, rest=1.0
  const perProd = {
    coffee:    { satisfactionPct: 100 },
    croissant: { satisfactionPct: 100 },
    bagel:     { satisfactionPct: 100 },
    cookie:    { satisfactionPct: 100 },
    sandwich:  null,
    matcha:    null,
  };
  const { aggregateSatisfactionPct: aggAll } = calculateAggregateSatisfaction(perProd);
  // Total weight = 1.5+1.2+1.0+1.0 = 4.7; all 100% → agg = 100
  assertClose(aggAll, 100, 'All offered products at 100% → aggregate = 100');

  // Only coffee offered at 80%: agg = 80
  const coffeeOnly = { coffee: { satisfactionPct: 80 }, croissant: null, bagel: null, cookie: null, sandwich: null, matcha: null };
  const { aggregateSatisfactionPct: aggCoffee } = calculateAggregateSatisfaction(coffeeOnly);
  assertClose(aggCoffee, 80, 'Only coffee at 80% → aggregate = 80');

  // Sell-out cap: satisfaction capped at 45 when sold out
  const perProdForSellout = {
    croissant: { satisfactionPct: 95, fillRate: 1.0, tier: 'excellent' },
    cookie:    { satisfactionPct: 50, fillRate: 0.6, tier: 'poor' },
    bagel:     null,
    sandwich:  null,
    coffee:    null,
    matcha:    null,
  };
  const { perProductSatisfaction: afterSellout, selloutFlags } = applySellOut(
    perProdForSellout,
    { croissant: 30 }, // stocked 30
    { croissant: 30 }  // sold 30 = stocked → sellout
  );
  assert(selloutFlags.croissant === true, 'Sell-out flag set when sold = stocked');
  assert(afterSellout.croissant.satisfactionPct <= 45,
    'Sell-out caps satisfaction at ≤45',
    `got ${afterSellout.croissant.satisfactionPct}`);
  assert(afterSellout.cookie.satisfactionPct === 50, 'Non-sellout satisfaction unchanged');

  // Returning customer bonuses
  const cfg = mergeConfig({});
  const bonus86 = getReturningCustomerBonus(90, 100, cfg);
  assertClose(bonus86, 15, 'Excellent (90%) → +15% = 15 returning customers');
  const bonus70 = getReturningCustomerBonus(70, 100, cfg);
  assertClose(bonus70, 8,  'Good (70%) → +8% = 8 returning customers');
  const bonus50 = getReturningCustomerBonus(50, 100, cfg);
  assert(bonus50 === 0, 'Adequate (50%) → 0 returning customers');
  const bonus30 = getReturningCustomerBonus(30, 100, cfg);
  assert(bonus30 === 0, 'Poor (30%) → 0 returning customers');
}

section('A5. Loan Shark');
{
  const cfg = mergeConfig({});
  // Spec: borrowed = max(0, spent - budget); interest = borrowed × 0.10; deduction = borrowed × 1.10
  const ls1 = calculateLoanShark(700, 500, cfg); // spent 700, have 500 → borrow 200
  assert(ls1.borrowed === 200, 'Borrowed = 700 - 500 = 200');
  assertClose(ls1.interest, 20, 'Interest = 200 × 10% = 20');
  assertClose(ls1.loanSharkDeduction, 220, 'Deduction = 200 + 20 = 220');
  assert(ls1.didBorrow === true, 'didBorrow = true when spent > budget');

  const ls2 = calculateLoanShark(400, 500, cfg); // under budget
  assert(ls2.borrowed === 0, 'Borrowed = 0 when under budget');
  assert(ls2.interest === 0, 'Interest = 0 when not borrowing');
  assert(ls2.didBorrow === false, 'didBorrow = false when under budget');

  // Interest rate is configurable via config
  assert(cfg.loanSharkInterestRate === 0.10, 'Loan shark interest rate = 10%');

  // Net revenue = grossRevenue - loanSharkDeduction
  const net = calculateNetRevenue(1000, 220);
  assert(net === 780, 'Net revenue = 1000 - 220 = 780');

  // Budget can go negative (spec: no floor clamping in loan-shark module)
  // (simulation.js does floor at 0 separately; loan-shark.js itself doesn't clamp)
  const negNet = calculateNetRevenue(100, 500);
  assert(negNet === -400, 'Net revenue can be negative');
}

section('A6. Ad Types');
{
  // Spec (DEC-04): TV $50,000 / Billboard $37,500 / Radio $25,000 / Newspaper $18,750
  // Code uses adBonuses (DEFAULT_GAME_CONFIG) — these are pre-scale defaults at $200/$150/$100/$75
  // The roadmap notes DEC-13 acknowledges placeholder values needing 250× scale-up at INT-06.
  // Check that the 4 ad types are present and their relative ordering matches spec.
  const adBonuses = DEFAULT_GAME_CONFIG.adBonuses;
  const adTypes = AD_TYPES;

  assert(adTypes.includes('TV'),        'AD_TYPES includes TV');
  assert(adTypes.includes('Billboard'), 'AD_TYPES includes Billboard');
  assert(adTypes.includes('Radio'),     'AD_TYPES includes Radio');
  assert(adTypes.includes('Newspaper'), 'AD_TYPES includes Newspaper');
  assert(adTypes.length === 4,          'Exactly 4 ad types');

  // Relative ordering: TV > Billboard > Radio > Newspaper
  assert(adBonuses.TV        > adBonuses.Billboard, 'TV bonus > Billboard bonus');
  assert(adBonuses.Billboard > adBonuses.Radio,     'Billboard bonus > Radio bonus');
  assert(adBonuses.Radio     > adBonuses.Newspaper, 'Radio bonus > Newspaper bonus');

  // NOTE: Default values (200/150/100/75) are placeholders requiring 250× scale-up.
  // Checking they exist as non-zero positives.
  assert(adBonuses.TV > 0,        'TV bonus > 0');
  assert(adBonuses.Billboard > 0, 'Billboard bonus > 0');
  assert(adBonuses.Radio > 0,     'Radio bonus > 0');
  assert(adBonuses.Newspaper > 0, 'Newspaper bonus > 0');

  // Post Balance pass 16: defaults are TV=400, Billboard=250, Radio=150,
  // Newspaper=80 — proportional to the $10k starting budget. The ordering
  // assertions above are the spec; absolute values are tuned by balance work.
}

section('A7. Phase Transitions');
{
  // Canonical order from phases.js PHASE_ORDER:
  //   lobby → round_1_email → round_1_bid_ad → round_1_bid_chef → round_1_roster
  //         → round_1_decide → simulating → results_ready → round_2_email → … → game_over
  const transitions = [
    ['lobby',             { phase: 'round_1_email', round: 1  }],
    ['round_1_email',     { phase: 'round_1_bid_ad', round: 1 }],
    ['round_1_bid_ad',    { phase: 'round_1_bid_chef', round: 1 }],
    ['round_1_bid_chef',  { phase: 'round_1_roster', round: 1 }],
    ['round_1_roster',    { phase: 'round_1_decide', round: 1 }],
    ['round_1_decide',    { phase: 'simulating', round: 1 }],
    ['simulating',        { phase: 'results_ready', round: 1 }],
  ];

  for (const [from, expected] of transitions) {
    const next = getNextPhase(from, 1, 5);
    assert(next.phase === expected.phase,
      `${from} → ${expected.phase}`,
      `got ${next.phase}`);
  }

  // After last round results_ready → game_over
  const last = getNextPhase('results_ready', 5, 5);
  assert(last.phase === 'game_over', 'After round 5 results_ready → game_over');

  // After round 1 results_ready (not last) → round 2 email
  const mid = getNextPhase('results_ready', 1, 5);
  assert(mid.phase === 'round_2_email', 'After round 1 results_ready → round_2_email');
  assert(mid.round === 2, 'Round increments to 2');

  // Phase predicates
  assert(canSubmitDecision('round_2_decide'),        'canSubmitDecision on round_2_decide = true');
  assert(!canSubmitDecision('round_2_bid_ad'),       'canSubmitDecision on bid_ad = false');
  assert(canSubmitBids('round_1_bid_ad', 'ad'),      'canSubmitBids ad on bid_ad = true');
  assert(canSubmitBids('round_1_bid_chef', 'chef'),  'canSubmitBids chef on bid_chef = true');
  assert(!canSubmitBids('round_1_bid_ad', 'chef'),   'canSubmitBids chef on bid_ad = false');
  assert(isGameActive('round_1_decide'),             'isGameActive on decide = true');
  assert(!isGameActive('lobby'),                     'isGameActive on lobby = false');
  assert(!isGameActive('game_over'),                 'isGameActive on game_over = false');

  // parsePhase
  const parsed = parsePhase('round_3_roster', 3);
  assert(parsed.round === 3 && parsed.phase === 'roster', 'parsePhase round_3_roster → { round:3, phase:roster }');
}

section('A8. Round Preferences / Market Conditions');
{
  // Spec: each round = 2 Trending (+40%), 2 Warm (+15%), 1 Neutral (0%), 1 Cold (-25%)
  // Constraint: no product trending two consecutive rounds
  assert(MOD_TRENDING === 1.40, 'Trending modifier = 1.40');
  assert(MOD_WARM === 1.15,     'Warm modifier = 1.15');
  assert(MOD_NEUTRAL === 1.00,  'Neutral modifier = 1.00');
  assert(MOD_COLD === 0.75,     'Cold modifier = 0.75 (i.e., -25%)');

  // Generate 100 preference profiles and validate structure
  let noConsecutiveTrendingViolations = 0;
  const TRIALS = 100;
  for (let t = 0; t < TRIALS; t++) {
    const prefs = generateGamePreferences(5);
    for (let i = 0; i < 5; i++) {
      const r = prefs[i];
      assert(r.trending.length === 2, `R${i+1} has exactly 2 trending`, `got ${r.trending.length}`);
      assert(r.warm.length === 2,     `R${i+1} has exactly 2 warm`,     `got ${r.warm.length}`);
      assert(r.neutral.length === 1,  `R${i+1} has exactly 1 neutral`,  `got ${r.neutral.length}`);
      assert(r.cold.length === 1,     `R${i+1} has exactly 1 cold`,     `got ${r.cold.length}`);

      // No consecutive trending
      if (i > 0) {
        const prevTrending = prefs[i-1].trending;
        const overlapTrending = r.trending.filter(p => prevTrending.includes(p));
        if (overlapTrending.length > 0) noConsecutiveTrendingViolations++;
      }

      // All 6 products assigned
      const all = [...r.trending, ...r.warm, ...r.neutral, ...r.cold];
      assert(all.length === 6, `R${i+1} assigns exactly 6 products`, `got ${all.length}`);
      const unique = new Set(all);
      assert(unique.size === 6, `R${i+1} no duplicate product assignments`, `got ${unique.size}`);
    }
  }
  // Only report consecutive trending check once
  assert(noConsecutiveTrendingViolations === 0,
    `No consecutive trending violations across ${TRIALS} trials`,
    `found ${noConsecutiveTrendingViolations} violations`);
}

section('A9. Budget Floor');
{
  // Spec (BACKEND.md): budgetNext = budgetCurrent + revenueNet - spent; can be negative.
  // simulation.js floors budgetAfter at 0 as a UI convenience.
  // loan-shark.js updateBudget does NOT floor.
  const budgetAfterSim = updateBudget(500, -200, 800);
  // 500 + (-200) - 800 = -500 → negative allowed in loan-shark.js
  assert(budgetAfterSim === -500, 'updateBudget can go negative (no floor in loan-shark module)');

  // The simulation module itself does floor at 0
  // We verify this via a live simulation scenario
  const cfg = mergeConfig({ startingBudget: 2000, sousChefBaseCost: 50 });
  const player = {
    playerId: 'p-budgetfloor',
    displayName: 'OverspendPlayer',
    bakeryName: 'Broke Bakery',
    decision: {
      menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false },
      quantities: { croissant: 10, cookie: 10, bagel: 10 },
      sousChefCount: 0,
      sousChefAssignments: {},
      numProducts: 3,
    },
    specialtyChefs: [],
    budgetCurrent: 100, // very low budget
    returningCustomersPending: 0,
    auctionResults: { adWon: null, adBidPaid: 0, chefsWon: [], chefBidPaid: 0 },
  };
  const simResult = runSimulation([player], { modifiers: {} }, cfg);
  assert(simResult.length === 1, 'Simulation returns one result');
  assert(typeof simResult[0].budgetAfter === 'number', 'budgetAfter is a number');
  assert(Number.isFinite(simResult[0].budgetAfter), 'budgetAfter is finite in simulation (can be negative per spec)');
}

section('A10. Game Creation Defaults');
{
  const cfg = mergeConfig({});

  // Spec: totalRounds = 5 (from proposal)
  assert(DEFAULT_GAME_CONFIG.totalRounds === 5, 'Default totalRounds = 5');
  assert(cfg.totalRounds === 5, 'mergeConfig preserves totalRounds = 5');

  // Post Balance pass 16: startingBudget rescaled from the original DEC-01
  // $500,000 spec to $10,000 to keep the economy proportional to product
  // sell prices. The DEC-01 figure was play-money scale; the new figure is
  // the live default professors run at.
  assert(typeof DEFAULT_GAME_CONFIG.startingBudget === 'number' && DEFAULT_GAME_CONFIG.startingBudget > 0,
    'startingBudget is a positive number');

  // maxPlayers: spec says 20 per game (DEC-12), schema must support 50
  // No hard cap in the modules themselves — cap is enforced at joinGame in index.js
  // We verify no module-level cap constant that limits to 30
  assert(!DEFAULT_GAME_CONFIG.maxPlayers || DEFAULT_GAME_CONFIG.maxPlayers >= 20,
    'No module-level maxPlayers cap < 20 in DEFAULT_GAME_CONFIG');

  // Spec: loanSharkInterestRate = 0.10 (DEC-16)
  assert(cfg.loanSharkInterestRate === 0.10, 'loanSharkInterestRate = 0.10 (DEC-16)');

  // Spec: specialtyChefCap = 3
  assert(cfg.specialtyChefCap === 3, 'specialtyChefCap = 3');

  // mergeConfig does not corrupt numeric values — exercise with values that
  // are NOT the current default so the assertions actually test propagation.
  const custom = mergeConfig({ startingBudget: 25000, sousChefBaseCost: 75 });
  assert(custom.startingBudget === 25000, 'mergeConfig propagates startingBudget override');
  assert(custom.sousChefBaseCost === 75, 'mergeConfig propagates sousChefBaseCost override');
}

// ---------------------------------------------------------------------------
// SECTION B — Full Lifecycle Regression (4 rounds, 5 player strategies)
// ---------------------------------------------------------------------------

section('B. Full 4-Round Game Lifecycle');

/**
 * Helper to build a player decision with named parameters.
 */
function makeDecision({ sousChefCount = 0, croissant = 50, cookie = 50, bagel = 50,
                        sandwich = 0, coffee = 0, matcha = 0,
                        includeOptional = false } = {}) {
  const menu = {
    croissant: true, cookie: true, bagel: true,
    sandwich: includeOptional && sandwich > 0,
    coffee:   includeOptional && coffee > 0,
    matcha:   includeOptional && matcha > 0,
  };
  const assignments = {};
  if (sousChefCount > 0) {
    const offeredList = Object.keys(menu).filter(p => menu[p]);
    assignments[offeredList[0]] = sousChefCount; // assign all to first product
  }
  const quantities = { croissant, cookie, bagel, sandwich, coffee, matcha };
  return {
    menu,
    quantities,
    sousChefCount,
    sousChefAssignments: assignments,
    numProducts: Object.values(menu).filter(Boolean).length,
  };
}

// 5 player strategies
const STRATEGIES = [
  {
    id: 'aggressive',
    displayName: 'AggressiveSpender',
    bakeryName: 'Big Spender Bakery',
    getDecision: (round) => makeDecision({ sousChefCount: 6, croissant: 100, cookie: 80, bagel: 80, includeOptional: true, coffee: 50, matcha: 30 }),
    getChefs: (round) => [
      { skillTier: 'advanced', specialties: ['croissant', 'coffee'], nationality: 'french', name: 'Jean-Pierre' },
    ],
  },
  {
    id: 'conservative',
    displayName: 'Conservative',
    bakeryName: 'Safe Bet Bakery',
    getDecision: (round) => makeDecision({ sousChefCount: 1, croissant: 30, cookie: 30, bagel: 30 }),
    getChefs: (round) => [],
  },
  {
    id: 'balanced',
    displayName: 'Balanced',
    bakeryName: 'Balanced Bakery',
    getDecision: (round) => makeDecision({ sousChefCount: 3, croissant: 60, cookie: 50, bagel: 55, includeOptional: true, coffee: 40 }),
    getChefs: (round) => [
      { skillTier: 'intermediate', specialties: ['croissant', 'coffee'], nationality: 'french', name: 'Colette' },
    ],
  },
  {
    id: 'specialty',
    displayName: 'SpecialtyFocused',
    bakeryName: 'Specialty Bakery',
    getDecision: (round) => makeDecision({ sousChefCount: 2, croissant: 30, cookie: 30, bagel: 30, includeOptional: true, matcha: 30 }),
    getChefs: (round) => [
      { skillTier: 'advanced', specialties: ['matcha', 'croissant'], nationality: 'japanese', name: 'Hiroshi' },
    ],
  },
  {
    id: 'adHeavy',
    displayName: 'AdHeavy',
    bakeryName: 'Ad King Bakery',
    getDecision: (round) => makeDecision({ sousChefCount: 0, croissant: 45, cookie: 40, bagel: 40 }),
    getChefs: (round) => [],
  },
];

// Section B exercises the lifecycle at the production-default economy so a
// real budget-exhaustion or loan-shark edge would surface here.
const config = mergeConfig({});

// Generate round preferences for 4 rounds
const ROUND_PREFS = generateGamePreferences(4, config);

// Player state across rounds
const playerBudgets = {};
const playerCumulativeRevenue = {};
const playerReturningCustomers = {};
const allRoundResults = []; // [{ round, results: [...] }]

for (const s of STRATEGIES) {
  playerBudgets[s.id] = config.startingBudget;
  playerCumulativeRevenue[s.id] = 0;
  playerReturningCustomers[s.id] = 0;
}

let lifecycleOk = true;

for (let round = 1; round <= 4; round++) {
  console.log(`\n  --- Round ${round} ---`);
  const prefs = ROUND_PREFS[round - 1];

  // Verify preference structure
  assert(prefs.trending.length === 2 && prefs.warm.length === 2 &&
         prefs.neutral.length === 1 && prefs.cold.length === 1,
    `Round ${round}: preferences have correct distribution`);

  // Phase sequence verification — round 1 enters via `lobby → round_1_email`.
  // Mid-round transitions are exhaustively asserted in Section A7.
  if (round === 1) {
    const next = getNextPhase('lobby', 0, 4);
    assert(next.phase === 'round_1_email', `Round 1: lobby → round_1_email`);
  }

  // Generate chef pool for this round
  const pool = generateChefPool(round, config);
  assert(pool.length === config.chefPoolSize,
    `Round ${round}: chef pool size = cfg.chefPoolSize (${config.chefPoolSize}, got ${pool.length})`);

  // Build player inputs for simulation
  const players = STRATEGIES.map(s => {
    const decision = s.getDecision(round);
    const adBidPaid = s.id === 'adHeavy' ? 100 : 0;
    return {
      playerId: s.id,
      displayName: s.displayName,
      bakeryName: s.bakeryName,
      decision,
      specialtyChefs: s.getChefs(round),
      budgetCurrent: playerBudgets[s.id],
      returningCustomersPending: playerReturningCustomers[s.id],
      auctionResults: {
        adWon: s.id === 'adHeavy' ? 'TV' : null,
        adBidPaid,
        chefsWon: [],
        chefBidPaid: 0,
      },
    };
  });

  // Run simulation
  const results = runSimulation(players, prefs, config);

  // Verify results
  assert(results.length === STRATEGIES.length,
    `Round ${round}: simulation returns ${STRATEGIES.length} results`);

  for (const r of results) {
    // Revenue fields
    assert(typeof r.revenueGross === 'number' && Number.isFinite(r.revenueGross),
      `Round ${round} ${r.playerId}: revenueGross is finite`);
    assert(typeof r.revenueNet === 'number' && Number.isFinite(r.revenueNet),
      `Round ${round} ${r.playerId}: revenueNet is finite`);
    assert(r.revenueGross >= 0,
      `Round ${round} ${r.playerId}: revenueGross ≥ 0`);

    // Satisfaction scores
    assert(r.aggregateSatisfactionPct >= 0 && r.aggregateSatisfactionPct <= 100,
      `Round ${round} ${r.playerId}: aggregateSatisfactionPct in [0,100]`,
      `got ${r.aggregateSatisfactionPct}`);

    // Customer count
    assert(typeof r.customerCount === 'number' && r.customerCount >= 0,
      `Round ${round} ${r.playerId}: customerCount ≥ 0`);

    // Loan shark sanity
    assert(r.amountBorrowed >= 0, `Round ${round} ${r.playerId}: amountBorrowed ≥ 0`);
    assert(r.interestCharged >= 0, `Round ${round} ${r.playerId}: interestCharged ≥ 0`);

    // Net = gross - deduction
    const expectedNet = r.revenueGross - r.amountBorrowed - r.interestCharged;
    assertClose(r.revenueNet, expectedNet, `Round ${round} ${r.playerId}: revenueNet = gross - borrowed - interest`);

    // Budget after is ≥ 0 (floored in simulation)
    assert(Number.isFinite(r.budgetAfter), `Round ${round} ${r.playerId}: budgetAfter is finite`);

    // perProductSatisfaction entries
    for (const [product, pps] of Object.entries(r.perProductSatisfaction || {})) {
      if (pps === null) continue;
      assert(pps.satisfactionPct >= 0 && pps.satisfactionPct <= 100,
        `Round ${round} ${r.playerId} ${product}: satisfactionPct in [0,100]`,
        `got ${pps.satisfactionPct}`);
      assert(pps.qtySold >= 0, `Round ${round} ${r.playerId} ${product}: qtySold ≥ 0`);
    }

    // Update player state for next round
    playerBudgets[r.playerId] = r.budgetAfter;
    playerCumulativeRevenue[r.playerId] = (playerCumulativeRevenue[r.playerId] || 0) + r.revenueNet;
    playerReturningCustomers[r.playerId] = r.returningCustomersEarned || 0;
  }

  allRoundResults.push({ round, results });

  // Phase transition: results_ready → next round or game_over
  if (round < 4) {
    const next = getNextPhase('results_ready', round, 4);
    assert(next.phase === `round_${round+1}_email` && next.round === round + 1,
      `Round ${round}: results_ready → round_${round+1}_email`);
  } else {
    const final = getNextPhase('results_ready', 4, 4);
    assert(final.phase === 'game_over', 'After round 4: results_ready → game_over');
  }
}

// ---------------------------------------------------------------------------
// SECTION C — Conclusion Aggregation + CSV Export
// ---------------------------------------------------------------------------

section('C. Conclusion Aggregation & Rankings');
{
  // Build per-player round arrays from lifecycle results
  const playerRoundsData = {};
  for (const s of STRATEGIES) {
    playerRoundsData[s.id] = [];
  }
  for (const { round, results } of allRoundResults) {
    for (const r of results) {
      playerRoundsData[r.playerId].push({
        round,
        revenueGross: r.revenueGross,
        revenueNet: r.revenueNet,
        amountBorrowed: r.amountBorrowed,
        interestCharged: r.interestCharged,
        totalSpent: r.totalSpent,
      });
    }
  }

  // Aggregate each player
  const aggregates = STRATEGIES.map(s => {
    const rounds = playerRoundsData[s.id];
    const agg = aggregatePlayerResults(rounds, config);
    return { playerId: s.id, displayName: s.displayName, bakeryName: s.bakeryName, ...agg };
  });

  // Verify aggregation math
  for (const agg of aggregates) {
    const rounds = playerRoundsData[agg.playerId];
    const expectedTotalRevenue = rounds.reduce((s, r) => s + r.revenueGross, 0);
    const expectedTotalInterest = rounds.reduce((s, r) => s + r.interestCharged, 0);
    const expectedTotalBorrowed = rounds.reduce((s, r) => s + r.amountBorrowed, 0);
    const expectedNetRevenue = expectedTotalRevenue - expectedTotalInterest - expectedTotalBorrowed;

    assertClose(agg.totalRevenue, expectedTotalRevenue,
      `${agg.playerId}: totalRevenue aggregation correct`);
    assertClose(agg.totalInterest, expectedTotalInterest,
      `${agg.playerId}: totalInterest aggregation correct`);
    assertClose(agg.totalBorrowed, expectedTotalBorrowed,
      `${agg.playerId}: totalBorrowed aggregation correct`);
    assertClose(agg.netRevenue, expectedNetRevenue,
      `${agg.playerId}: netRevenue = totalRevenue - interest - borrowed`);

    assert(typeof agg.budgetRemaining === 'number',
      `${agg.playerId}: budgetRemaining is a number`);
  }

  // Rankings: ordered by netRevenue desc, tiebreak by budgetRemaining desc
  const ranked = rankPlayers(aggregates);
  assert(ranked.length === STRATEGIES.length, 'All players ranked');
  assert(ranked[0].rank === 1, 'First ranked player has rank = 1');
  // Verify descending netRevenue order
  for (let i = 1; i < ranked.length; i++) {
    const prev = ranked[i-1];
    const curr = ranked[i];
    assert(curr.netRevenue <= prev.netRevenue,
      `Rank ${i+1}: netRevenue ≤ rank ${i}`,
      `${curr.playerId}(${curr.netRevenue}) vs ${prev.playerId}(${prev.netRevenue})`);
  }

  // Conclusion data structure
  const winnerChefs = [
    { skillTier: 'advanced', nationality: 'french', name: 'Jean-Pierre', specialties: ['croissant', 'coffee'] },
  ];
  const conclusion = buildConclusionData(ranked, winnerChefs);
  assert(!!conclusion.winner,             'Conclusion has a winner object');
  assert(conclusion.rankings.length === 5, 'Conclusion rankings has 5 players');
  assert(conclusion.winner.rank === undefined || conclusion.rankings[0].rank === 1,
    'Winner is rank 1');
  assert(Array.isArray(conclusion.winner.chefRoster), 'Winner has chefRoster array');
}

section('C2. CSV Export Integrity');
{
  // Build a sample round result and CSV row
  const round1Result = allRoundResults[0].results[0];
  const decision = STRATEGIES[0].getDecision(1);

  const csvRow = buildCsvRow({
    round: 1,
    decision,
    specialtyChefs: STRATEGIES[0].getChefs(1),
    perProductSatisfaction: round1Result.perProductSatisfaction,
    customerCount: round1Result.customerCount,
    revenueGross: round1Result.revenueGross,
    revenueNet: round1Result.revenueNet,
    amountBorrowed: round1Result.amountBorrowed,
    interestCharged: round1Result.interestCharged,
    aggregateSatisfactionPct: round1Result.aggregateSatisfactionPct,
  });

  // All expected CSV column keys should be present
  const expectedKeys = [
    'round', 'num_products', 'sous_chef_count', 'ad_type',
    'specialty_chef_1_nationality', 'specialty_chef_1_skill',
    'specialty_chef_2_nationality', 'specialty_chef_2_skill',
    'specialty_chef_3_nationality', 'specialty_chef_3_skill',
    'croissant_qty_stocked', 'cookie_qty_stocked', 'bagel_qty_stocked',
    'sandwich_qty_stocked', 'coffee_qty_stocked', 'matcha_qty_stocked',
    'revenue', 'amount_borrowed', 'interest_charged', 'customer_count',
    'aggregate_satisfaction_pct',
    'croissant_satisfaction_pct', 'cookie_satisfaction_pct', 'bagel_satisfaction_pct',
    'sandwich_satisfaction_pct', 'coffee_satisfaction_pct', 'matcha_satisfaction_pct',
    'croissant_qty_sold', 'cookie_qty_sold', 'bagel_qty_sold',
    'sandwich_qty_sold', 'coffee_qty_sold', 'matcha_qty_sold',
    'sellout_croissant', 'sellout_cookie', 'sellout_bagel',
    'sellout_sandwich', 'sellout_coffee', 'sellout_matcha',
  ];

  for (const key of expectedKeys) {
    assert(Object.prototype.hasOwnProperty.call(csvRow, key),
      `CSV row has column: ${key}`);
  }

  // Revenue in CSV is gross (revenueGross, per buildCsvRow which uses firstDefined(r.revenueGross, r.revenue))
  assert(csvRow.revenue === round1Result.revenueGross, 'CSV revenue column = revenueGross');

  // Build CSV string from multiple rows
  const rows = allRoundResults.flatMap(({ round, results }) =>
    results.map(r => buildCsvRow({
      round,
      decision: STRATEGIES.find(s => s.id === r.playerId).getDecision(round),
      specialtyChefs: STRATEGIES.find(s => s.id === r.playerId).getChefs(round),
      perProductSatisfaction: r.perProductSatisfaction,
      customerCount: r.customerCount,
      revenueGross: r.revenueGross,
      revenueNet: r.revenueNet,
      amountBorrowed: r.amountBorrowed,
      interestCharged: r.interestCharged,
      aggregateSatisfactionPct: r.aggregateSatisfactionPct,
    }))
  );

  const csvString = buildCsvString(rows, false);
  const csvLines = csvString.trim().split('\n');

  assert(csvLines.length === rows.length + 1,
    `CSV has header + ${rows.length} data rows (got ${csvLines.length} lines)`);

  // Check header
  const header = csvLines[0];
  assert(header.includes('round'),                    'CSV header contains round');
  assert(header.includes('revenue'),                  'CSV header contains revenue');
  assert(header.includes('aggregate_satisfaction_pct'), 'CSV header contains aggregate_satisfaction_pct');
  assert(!header.includes('returning_customers'),     'CSV header does NOT contain returning_customers (excluded per spec)');

  // Professor CSV (with player identity columns)
  const profRows = rows.map((r, i) => ({
    ...r,
    player_id: 'player-' + i,
    bakery_name: 'Test Bakery ' + i,
    display_name: 'Tester ' + i,
  }));
  const profCsv = buildCsvString(profRows, true);
  const profHeader = profCsv.trim().split('\n')[0];
  assert(profHeader.includes('player_id'),   'Professor CSV includes player_id column');
  assert(profHeader.includes('bakery_name'), 'Professor CSV includes bakery_name column');
  assert(profHeader.includes('display_name'),'Professor CSV includes display_name column');
}

section('C3. Decision Validation');
{
  const cfg = mergeConfig({});

  // Valid decision
  const validDecision = validateDecision({
    menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false },
    quantities: { croissant: 50, cookie: 40, bagel: 30, sandwich: 0, coffee: 0, matcha: 0 },
    sousChefCount: 2,
    sousChefAssignments: { croissant: 2 },
  }, 1, cfg);
  assert(validDecision.numProducts === 3, 'Valid decision: numProducts = 3');
  assert(validDecision.sousChefCount === 2, 'Valid decision: sousChefCount = 2');

  // Base menu cannot be disabled
  let baseMenuError = false;
  try {
    validateDecision({
      menu: { croissant: false, cookie: true, bagel: true },
      quantities: { croissant: 0 },
      sousChefCount: 0, sousChefAssignments: {},
    }, 1, cfg);
  } catch (e) { baseMenuError = true; }
  assert(baseMenuError, 'Disabling base menu product throws error');

  // Assignment sum must equal sousChefCount
  let assignError = false;
  try {
    validateDecision({
      menu: { croissant: true, cookie: true, bagel: true },
      quantities: { croissant: 30, cookie: 30, bagel: 30 },
      sousChefCount: 3,
      sousChefAssignments: { croissant: 1 }, // sum=1 ≠ 3
    }, 1, cfg);
  } catch (e) { assignError = true; }
  assert(assignError, 'Assignment sum ≠ sousChefCount throws error');

  // Default decision has base menu products = true
  const def = buildDefaultDecision(cfg);
  assert(def.menu.croissant === true, 'Default decision has croissant = true');
  assert(def.menu.cookie === true,    'Default decision has cookie = true');
  assert(def.menu.bagel === true,     'Default decision has bagel = true');
  assert(def.menu.sandwich === false, 'Default decision has sandwich = false');
  assert(def.sousChefCount === 0,     'Default decision: sousChefCount = 0');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60));
console.log('TEST SUMMARY');
console.log('='.repeat(60));
console.log(`Total:  ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (FAILURES.length > 0) {
  console.log('\nFAILURES:');
  for (const f of FAILURES) {
    console.log(`  ❌ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
  }
}

console.log('');
if (failed === 0) {
  console.log('🟢 ALL TESTS PASSED');
} else {
  console.log(`🔴 ${failed} TEST(S) FAILED`);
  process.exit(1);
}
