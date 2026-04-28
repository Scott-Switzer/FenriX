/**
 * bot-engine unit tests — Personality Matrix edition
 *
 * Run with: node backend/functions/modules/__tests__/bot-engine-test.js
 */

'use strict';

const {
  generateBotDecisions,
  expectedAdValue,
  expectedChefValue,
  PRESETS,
  PERSONALITIES,
  DIFFICULTIES,
  buildOpponentModel,
  predictOpponentAdBids,
  mapLegacyDifficulty,
} = require('../bot-engine');
const { mergeConfig } = require('../config');

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ~${expected} ±${tolerance}, got ${actual}`);
  }
}

const TEST_CONFIG = mergeConfig({});

function makeBotState(overrides = {}) {
  return {
    budgetCurrent: 10000,
    specialtyChefs: [],
    chefPool: [],
    playerId: 'bot_test',
    round: 1,
    gameId: 'test_game',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
console.log('--- Presets ---');
{
  assert(PRESETS.risky_ricky.difficulty === 'hard', 'risky_ricky should be hard');
  assert(PRESETS.risky_ricky.personality === 'aggressive', 'risky_ricky should be aggressive');
  assert(PRESETS.perfect_patricia.difficulty === 'perfect', 'perfect_patricia should be perfect');
  assert(PRESETS.chaotic_charlie.difficulty === 'novice', 'chaotic_charlie should be novice');
  assert(PRESETS.chaotic_charlie.personality === 'random', 'chaotic_charlie should be random');
  console.log('  ✓ All presets map correctly');
}

// ---------------------------------------------------------------------------
// Legacy difficulty mapping
// ---------------------------------------------------------------------------
console.log('--- Legacy difficulty mapping ---');
{
  assert(mapLegacyDifficulty('easy') === 'easy', 'easy stays easy');
  assert(mapLegacyDifficulty('medium') === 'medium', 'medium stays medium');
  assert(mapLegacyDifficulty('hard') === 'hard', 'hard stays hard');
  assert(mapLegacyDifficulty('novice') === 'novice', 'novice recognized');
  assert(mapLegacyDifficulty('perfect') === 'perfect', 'perfect recognized');
  assert(mapLegacyDifficulty(undefined) === 'medium', 'undefined → medium');
  assert(mapLegacyDifficulty('invalid') === 'medium', 'invalid → medium');
  console.log('  ✓ Legacy mapping correct');
}

// ---------------------------------------------------------------------------
// expectedAdValue / expectedChefValue
// ---------------------------------------------------------------------------
console.log('--- expectedAdValue ---');
{
  const tvValue = expectedAdValue('TV', TEST_CONFIG);
  assert(tvValue > 0, 'TV ad value should be positive');
  assertClose(tvValue, 490, 50, 'TV expected value');

  const newspaperValue = expectedAdValue('Newspaper', TEST_CONFIG);
  assert(newspaperValue > 0, 'Newspaper ad value should be positive');
  assert(newspaperValue < tvValue, 'Newspaper should be cheaper than TV');
  console.log('  ✓ expectedAdValue computed correctly');
}

console.log('--- expectedChefValue ---');
{
  const advancedFrench = {
    nationality: 'french',
    skillTier: 'advanced',
    specialties: ['croissant', 'coffee'],
  };
  const val = expectedChefValue(advancedFrench, TEST_CONFIG);
  assert(val > 0, 'Advanced French chef should have positive value');
  assertClose(val, 480, 50, 'Advanced French chef value');

  const novelChef = {
    nationality: 'american',
    skillTier: 'novel',
    specialties: ['bagel'],
  };
  const novelVal = expectedChefValue(novelChef, TEST_CONFIG);
  assert(novelVal === 0, 'Novel chef should have zero extra value');
  console.log('  ✓ expectedChefValue computed correctly');
}

// ---------------------------------------------------------------------------
// Personality divergence
// ---------------------------------------------------------------------------
console.log('--- Personality divergence ---');
{
  const botState = makeBotState();
  const seed = 'test_seed_123';

  const agg = generateBotDecisions(botState, 'bid_ad', TEST_CONFIG, [], 'medium', 'aggressive', null, seed);
  const cons = generateBotDecisions(botState, 'bid_ad', TEST_CONFIG, [], 'medium', 'conservative', null, seed);

  const aggTotal = Object.values(agg.adBids).reduce((s, v) => s + v, 0);
  const consTotal = Object.values(cons.adBids).reduce((s, v) => s + v, 0);

  assert(aggTotal > consTotal, `Aggressive should bid more than conservative (${aggTotal} vs ${consTotal})`);
  console.log('  ✓ Aggressive bids > Conservative bids');

  const vol = generateBotDecisions(botState, 'decide', TEST_CONFIG, [], 'medium', 'volume', null, seed);
  const marg = generateBotDecisions(botState, 'decide', TEST_CONFIG, [], 'medium', 'margin', null, seed);

  let volTotal = 0;
  let margTotal = 0;
  for (const p of Object.keys(vol.quantities)) {
    volTotal += vol.quantities[p];
    margTotal += marg.quantities[p];
  }
  assert(volTotal > margTotal, `Volume should stock more than margin (${volTotal} vs ${margTotal})`);
  console.log('  ✓ Volume stocks > Margin stocks');

  // Prices: margin should price higher
  let volPriceSum = 0;
  let margPriceSum = 0;
  let priceCount = 0;
  for (const p of Object.keys(vol.productPrices)) {
    volPriceSum += vol.productPrices[p];
    margPriceSum += marg.productPrices[p];
    priceCount++;
  }
  assert(margPriceSum > volPriceSum, `Margin should price higher than volume`);
  console.log('  ✓ Margin prices > Volume prices');
}

// ---------------------------------------------------------------------------
// Difficulty noise
// ---------------------------------------------------------------------------
console.log('--- Difficulty noise ---');
{
  const botState = makeBotState();
  const noviceBids = [];
  const mediumBids = [];
  const perfectBids = [];

  // Distinct seed per iteration so each call uses an independent (but
  // deterministic) RNG stream. Without this, sample size 20 is too small
  // to reliably differentiate novice (0.50 noise) from medium (0.10 noise)
  // when both fall back to Math.random.
  for (let i = 0; i < 20; i++) {
    const n = generateBotDecisions(botState, 'bid_ad', TEST_CONFIG, [], 'novice', 'balanced', null, `noise-novice-${i}`);
    const m = generateBotDecisions(botState, 'bid_ad', TEST_CONFIG, [], 'medium', 'balanced', null, `noise-medium-${i}`);
    const p = generateBotDecisions(botState, 'bid_ad', TEST_CONFIG, [], 'perfect', 'balanced', null, `noise-perfect-${i}`);
    const nTv = typeof n.adBids.TV === 'number' ? n.adBids.TV : 0;
    const mTv = typeof m.adBids.TV === 'number' ? m.adBids.TV : 0;
    const pTv = typeof p.adBids.TV === 'number' ? p.adBids.TV : 0;
    noviceBids.push(nTv);
    mediumBids.push(mTv);
    perfectBids.push(pTv);
  }

  const noviceVar = Math.max(...noviceBids) - Math.min(...noviceBids);
  const mediumVar = Math.max(...mediumBids) - Math.min(...mediumBids);
  const perfectVar = Math.max(...perfectBids) - Math.min(...perfectBids);

  assert(noviceVar > mediumVar, `Novice should have more variance than medium (${noviceVar} vs ${mediumVar})`);
  assert(perfectVar === 0, `Perfect should have zero variance (${perfectVar})`);
  console.log('  ✓ Noise levels correct (novice > medium > perfect=0)');
}

// ---------------------------------------------------------------------------
// Mistake simulation
// ---------------------------------------------------------------------------
console.log('--- Mistake simulation ---');
{
  const botState = makeBotState();
  const trials = 30;

  // Measure variance across unseeded runs
  function variance(values) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  }

  const noviceQtys = [];
  const mediumQtys = [];
  const perfectQtys = [];

  for (let i = 0; i < trials; i++) {
    const n = generateBotDecisions(botState, 'decide', TEST_CONFIG, [], 'novice', 'balanced');
    const m = generateBotDecisions(botState, 'decide', TEST_CONFIG, [], 'medium', 'balanced');
    const p = generateBotDecisions(botState, 'decide', TEST_CONFIG, [], 'perfect', 'balanced');
    noviceQtys.push(n.quantities.croissant || 0);
    mediumQtys.push(m.quantities.croissant || 0);
    perfectQtys.push(p.quantities.croissant || 0);
  }

  const noviceVar = variance(noviceQtys);
  const mediumVar = variance(mediumQtys);
  const perfectVar = variance(perfectQtys);

  assert(noviceVar > mediumVar, `Novice variance should exceed medium (${noviceVar.toFixed(2)} vs ${mediumVar.toFixed(2)})`);
  assert(perfectVar === 0, `Perfect variance should be zero (${perfectVar})`);
  console.log(`  ✓ Variance ordering: novice(${noviceVar.toFixed(2)}) > medium(${mediumVar.toFixed(2)}) > perfect(${perfectVar})`);
}

// ---------------------------------------------------------------------------
// Random personality
// ---------------------------------------------------------------------------
console.log('--- Random personality ---');
{
  const botState = makeBotState();
  // Random personality should produce different results across calls
  let diffCount = 0;
  let d1, d2;
  for (let i = 0; i < 5; i++) {
    d1 = generateBotDecisions(botState, 'decide', TEST_CONFIG, [], 'novice', 'random');
    d2 = generateBotDecisions(botState, 'decide', TEST_CONFIG, [], 'perfect', 'random');
    for (const p of Object.keys(d1.quantities)) {
      if (d1.quantities[p] !== d2.quantities[p]) diffCount++;
    }
    if (diffCount > 0) break;
  }
  assert(diffCount > 0, 'Random personality should vary across calls');

  // But both should still be valid decisions
  assert(typeof d1.menu === 'object', 'random bot should return menu');
  assert(typeof d1.quantities === 'object', 'random bot should return quantities');
  assert(typeof d1.productPrices === 'object', 'random bot should return prices');
  console.log('  ✓ Random personality is chaotic but valid');
}

// ---------------------------------------------------------------------------
// Budget constraints
// ---------------------------------------------------------------------------
console.log('--- Budget constraints ---');
{
  const botState = makeBotState({ budgetCurrent: 500 });
  const hardDecisions = generateBotDecisions(botState, 'decide', TEST_CONFIG, [], 'hard', 'balanced');
  const stockCost = Object.values(hardDecisions.quantities).reduce((s, q) => s + q, 0) * TEST_CONFIG.unitCostPerProduct;
  const scCost = hardDecisions.sousChefCount * TEST_CONFIG.sousChefBaseCost;
  assert(stockCost + scCost <= 500, `Hard bot should stay within budget (cost ${stockCost + scCost})`);
  console.log('  ✓ Hard bot respects budget constraints');

  // Aggressive bot with tiny budget should still not exceed
  const aggDecisions = generateBotDecisions(botState, 'decide', TEST_CONFIG, [], 'hard', 'aggressive');
  const aggStockCost = Object.values(aggDecisions.quantities).reduce((s, q) => s + q, 0) * TEST_CONFIG.unitCostPerProduct;
  const aggScCost = aggDecisions.sousChefCount * TEST_CONFIG.sousChefBaseCost;
  assert(aggStockCost + aggScCost <= 500, `Aggressive bot should stay within budget`);
  console.log('  ✓ Aggressive bot respects budget constraints');
}

// ---------------------------------------------------------------------------
// Roster decisions
// ---------------------------------------------------------------------------
console.log('--- Roster decisions ---');
{
  const botState = makeBotState({
    specialtyChefs: [
      { id: 'c1', nationality: 'french', skillTier: 'advanced', specialties: ['croissant'] },
      { id: 'c2', nationality: 'japanese', skillTier: 'intermediate', specialties: ['matcha'] },
      { id: 'c3', nationality: 'italian', skillTier: 'novel', specialties: ['sandwich'] },
      { id: 'c4', nationality: 'american', skillTier: 'advanced', specialties: ['bagel', 'cookie'] },
    ],
  });

  // Seed easy bot calls so forget-phase / mistake chance does not flake the
  // assertion below. Hard tier already has near-zero forget/mistake, so
  // seeding is just for reproducibility.
  const easyRoster = generateBotDecisions(botState, 'roster', TEST_CONFIG, [], 'easy', 'balanced', null, 'roster-easy');
  assert(easyRoster.layoffs.length === 1, 'easy bot should lay off 1 chef (4→3)');
  console.log('  ✓ Easy bot roster');

  const hardRoster = generateBotDecisions(botState, 'roster', TEST_CONFIG, [], 'hard', 'balanced', null, 'roster-hard');
  assert(hardRoster.layoffs.length === 1, 'hard bot should lay off 1 chef (4→3)');
  assert(hardRoster.layoffs.includes('c3'), 'hard bot should lay off the least valuable chef (novel)');
  console.log('  ✓ Hard bot roster (value-sorted)');

  // Chef-focused should try to keep valuable chefs
  const chefRoster = generateBotDecisions(botState, 'roster', TEST_CONFIG, [], 'hard', 'chef_focused', null, 'roster-chef');
  assert(chefRoster.layoffs.length === 1, 'chef_focused bot should lay off 1 chef');
  console.log('  ✓ Chef-focused bot roster');
}

// ---------------------------------------------------------------------------
// Opponent modeling
// ---------------------------------------------------------------------------
console.log('--- Opponent modeling ---');
{
  const historicalBids = {
    opp1: [
      { round: 1, ad: { TV: 100, Billboard: 50 }, chef: [{ chefId: 'ch1', amount: 80, chefTier: 'intermediate' }] },
      { round: 2, ad: { TV: 120, Billboard: 60 }, chef: [{ chefId: 'ch2', amount: 90, chefTier: 'intermediate' }] },
    ],
  };

  const model = buildOpponentModel('opp1', historicalBids);
  assert(model != null, 'Model should be built from historical bids');
  assertClose(model.adBids.TV.mean, 110, 1, 'TV bid mean');
  assertClose(model.adBids.Billboard.mean, 55, 1, 'Billboard bid mean');
  assertClose(model.chefBids.intermediate.mean, 85, 1, 'Intermediate chef bid mean');
  console.log('  ✓ Opponent model built correctly');

  const predicted = predictOpponentAdBids({ uid: 'opp1' }, model, TEST_CONFIG);
  assert(predicted.TV > 0, 'Predicted TV bid should be positive');
  assert(predicted.TV < 120, 'Predicted TV bid should be conservative (below max)');
  console.log('  ✓ Opponent bid prediction works');
}

// ---------------------------------------------------------------------------
// Perfect bot shadow simulation
// ---------------------------------------------------------------------------
console.log('--- Perfect bot shadow simulation ---');
{
  const botState = makeBotState({
    specialtyChefs: [
      { id: 'c1', nationality: 'french', skillTier: 'advanced', specialties: ['croissant', 'coffee'] },
    ],
  });

  const perfectDecisions = generateBotDecisions(botState, 'decide', TEST_CONFIG, [], 'perfect', 'balanced');
  assert(typeof perfectDecisions.menu === 'object', 'perfect bot should return menu');
  assert(typeof perfectDecisions.quantities === 'object', 'perfect bot should return quantities');
  assert(typeof perfectDecisions.productPrices === 'object', 'perfect bot should return prices');

  // Perfect bot should offer croissant (has French chef)
  assert(perfectDecisions.menu.croissant === true, 'perfect bot should stock croissant');
  console.log('  ✓ Perfect bot makes valid operational decisions');

  // Perfect bot prices should be snapped
  for (const [product, price] of Object.entries(perfectDecisions.productPrices)) {
    const snapped = Math.round(price * 4) / 4;
    assert(price === snapped, `perfect bot price for ${product} should be snapped to $0.25 step`);
  }
  console.log('  ✓ Perfect bot prices snapped correctly');
}

// ---------------------------------------------------------------------------
// All combinations produce valid decisions
// ---------------------------------------------------------------------------
console.log('--- All combination validity ---');
{
  const difficulties = Object.keys(DIFFICULTIES);
  const personalities = Object.keys(PERSONALITIES);
  let comboCount = 0;

  for (const diff of difficulties) {
    for (const person of personalities) {
      const botState = makeBotState({
        chefPool: [
          { id: 'chef1', nationality: 'french', skillTier: 'advanced', specialties: ['croissant'], minBidFloor: 100 },
        ],
      });

      // Seed per combo so the test is deterministic across runs (otherwise
      // novice's 20% forget-phase chance flips the assertion below randomly).
      const seed = `combo:${diff}:${person}`;
      const forgetChance = DIFFICULTIES[diff].forgetPhaseChance || 0;

      // bid_ad
      const ad = generateBotDecisions(botState, 'bid_ad', TEST_CONFIG, [], diff, person, null, seed);
      assert(typeof ad.adBids === 'object', `${diff}/${person} adBids should be object`);
      // Random personality may skip some ads, and any difficulty with a
      // forget-phase chance may legitimately return no bids; all others
      // should define all 4.
      if (person !== 'random' && forgetChance === 0) {
        assert(Object.keys(ad.adBids).length === 4, `${diff}/${person} should bid on 4 ad types`);
      }

      // bid_chef
      const chef = generateBotDecisions(botState, 'bid_chef', TEST_CONFIG, [], diff, person, null, seed);
      assert(Array.isArray(chef.chefBids), `${diff}/${person} chefBids should be array`);

      // roster
      const roster = generateBotDecisions(botState, 'roster', TEST_CONFIG, [], diff, person, null, seed);
      assert(Array.isArray(roster.layoffs), `${diff}/${person} layoffs should be array`);

      // decide
      const dec = generateBotDecisions(botState, 'decide', TEST_CONFIG, [], diff, person, null, seed);
      assert(typeof dec.menu === 'object', `${diff}/${person} menu should be object`);
      assert(typeof dec.quantities === 'object', `${diff}/${person} quantities should be object`);
      assert(typeof dec.productPrices === 'object', `${diff}/${person} prices should be object`);
      assert(typeof dec.sousChefCount === 'number', `${diff}/${person} sousChefCount should be number`);

      comboCount++;
    }
  }

  console.log(`  ✓ All ${comboCount} combinations produce valid decisions`);
}

// ---------------------------------------------------------------------------
// Ad-focused and Chef-focused personalities
// ---------------------------------------------------------------------------
console.log('--- Specialized personalities ---');
{
  const botState = makeBotState();
  const seed = 'specialized_test';

  const adFocused = generateBotDecisions(botState, 'bid_ad', TEST_CONFIG, [], 'medium', 'ad_focused', null, seed);
  const chefFocused = generateBotDecisions(botState, 'bid_ad', TEST_CONFIG, [], 'medium', 'chef_focused', null, seed);

  const adTotal = Object.values(adFocused.adBids).reduce((s, v) => s + v, 0);
  const chefTotal = Object.values(chefFocused.adBids).reduce((s, v) => s + v, 0);

  assert(adTotal > chefTotal, `Ad-focused should bid more on ads than chef-focused`);
  console.log('  ✓ Ad-focused bids more on ads');

  const botStateWithPool = makeBotState({
    chefPool: [
      { id: 'chef1', nationality: 'french', skillTier: 'advanced', specialties: ['croissant'], minBidFloor: 100 },
      { id: 'chef2', nationality: 'italian', skillTier: 'intermediate', specialties: ['sandwich'], minBidFloor: 80 },
    ],
  });

  const adChefBids = generateBotDecisions(botStateWithPool, 'bid_chef', TEST_CONFIG, [], 'medium', 'ad_focused', null, seed);
  const chefChefBids = generateBotDecisions(botStateWithPool, 'bid_chef', TEST_CONFIG, [], 'medium', 'chef_focused', null, seed);

  const adChefTotal = adChefBids.chefBids.reduce((s, b) => s + b.amount, 0);
  const chefChefTotal = chefChefBids.chefBids.reduce((s, b) => s + b.amount, 0);

  assert(chefChefTotal > adChefTotal, `Chef-focused should bid more on chefs than ad-focused`);
  console.log('  ✓ Chef-focused bids more on chefs');
}

// ---------------------------------------------------------------------------
// Forget phase chance
// ---------------------------------------------------------------------------
console.log('--- Forget phase ---');
{
  const botState = makeBotState();
  let noviceForgetCount = 0;
  let mediumForgetCount = 0;
  const trials = 50;

  for (let i = 0; i < trials; i++) {
    const n = generateBotDecisions(botState, 'bid_ad', TEST_CONFIG, [], 'novice', 'balanced');
    const m = generateBotDecisions(botState, 'bid_ad', TEST_CONFIG, [], 'medium', 'balanced');
    const nTotal = Object.values(n.adBids).reduce((s, v) => s + v, 0);
    const mTotal = Object.values(m.adBids).reduce((s, v) => s + v, 0);
    if (nTotal === 0) noviceForgetCount++;
    if (mTotal === 0) mediumForgetCount++;
  }

  assert(noviceForgetCount > mediumForgetCount, `Novice should forget more than medium (${noviceForgetCount} vs ${mediumForgetCount})`);
  console.log(`  ✓ Novice forgets more than medium (${noviceForgetCount} vs ${mediumForgetCount})`);

  let perfectForgetCount = 0;
  for (let i = 0; i < trials; i++) {
    const d = generateBotDecisions(botState, 'bid_ad', TEST_CONFIG, [], 'perfect', 'balanced');
    const total = Object.values(d.adBids).reduce((s, v) => s + v, 0);
    if (total === 0) perfectForgetCount++;
  }
  assert(perfectForgetCount === 0, `Perfect should never forget phase`);
  console.log('  ✓ Perfect never forgets phase');
}

// ---------------------------------------------------------------------------
// Station unlocks (Apr 28 2026) — bots must respect unlockedProducts. Having
// a specialty chef for an OPTIONAL_MENU product is not enough to put that
// product on the menu; the team must have unlocked it via purchaseProduct.
// Without this guard, validateDecision rejects the bot's decision with
// 'failed-precondition' when the bot lists a locked product.
// ---------------------------------------------------------------------------
console.log('--- Station unlocks ---');
{
  const cookieChef = {
    id: 'c1',
    nationality: 'american',
    skillTier: 'advanced',
    specialties: ['cookie'],
  };

  // Medium balanced bot — chef for cookie but no unlock → cookie must NOT
  // be on menu. This is the canonical bug: a specialty chef makes the bot
  // want cookie on the menu, but the team hasn't unlocked the station.
  const lockedMediumState = makeBotState({ specialtyChefs: [cookieChef] });
  const lockedMedium = generateBotDecisions(
    lockedMediumState, 'decide', TEST_CONFIG, [], 'medium', 'balanced', null, 'unlock-locked-medium',
  );
  assert(lockedMedium.menu.cookie === false, 'medium bot must not menu cookie when locked, even with cookie chef');
  assert(lockedMedium.quantities.cookie === 0, 'medium bot must zero quantities.cookie when locked');
  // Base menu is always available even when no unlocks are present.
  assert(lockedMedium.menu.croissant === true, 'medium bot still menus base products when locked');
  console.log('  ✓ Medium balanced bot skips locked optional product despite specialty chef');

  // Medium balanced bot — chef for cookie AND cookie unlocked → cookie MUST
  // be on menu. Positive test: with the unlock present, the chef-driven
  // inclusion fires as before.
  const unlockedMediumState = makeBotState({
    specialtyChefs: [cookieChef],
    unlockedProducts: ['croissant', 'bagel', 'coffee', 'cookie'],
  });
  const unlockedMedium = generateBotDecisions(
    unlockedMediumState, 'decide', TEST_CONFIG, [], 'medium', 'balanced', null, 'unlock-unlocked-medium',
  );
  assert(unlockedMedium.menu.cookie === true, 'medium bot menus cookie when unlocked + chef');
  assert(unlockedMedium.quantities.cookie > 0, 'medium bot stocks cookie when unlocked + chef');
  console.log('  ✓ Medium balanced bot menus optional product when unlocked + chef');

  // Hard balanced bot — same constraint at the hard difficulty tier.
  const lockedHardState = makeBotState({ specialtyChefs: [cookieChef] });
  const lockedHard = generateBotDecisions(
    lockedHardState, 'decide', TEST_CONFIG, [], 'hard', 'balanced', null, 'unlock-locked-hard',
  );
  assert(lockedHard.menu.cookie === false, 'hard bot must not menu cookie when locked, even with cookie chef');
  assert(lockedHard.quantities.cookie === 0, 'hard bot must zero quantities.cookie when locked');
  console.log('  ✓ Hard balanced bot skips locked optional product despite specialty chef');

  // Volume personality — normally offers every product. Must still skip
  // locked optional products or validateDecision rejects the run.
  const lockedVolumeState = makeBotState();
  const lockedVolume = generateBotDecisions(
    lockedVolumeState, 'decide', TEST_CONFIG, [], 'medium', 'volume', null, 'unlock-locked-volume',
  );
  assert(lockedVolume.menu.cookie === false, 'volume bot must not menu cookie when locked');
  assert(lockedVolume.menu.sandwich === false, 'volume bot must not menu sandwich when locked');
  assert(lockedVolume.menu.matcha === false, 'volume bot must not menu matcha when locked');
  console.log('  ✓ Volume personality skips locked optional products');
}

console.log('\n========================================');
console.log('BOT ENGINE TESTS: ALL PASSED');
console.log(`Total combinations tested: ${Object.keys(DIFFICULTIES).length * Object.keys(PERSONALITIES).length}`);
console.log('========================================');
