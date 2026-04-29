/**
 * bot-engine.js — AI player decision engine for Bakery Bash.
 *
 * Pure module (no Firebase dependencies). Imports the same simulation
 * modules the backend uses so the bot can evaluate decisions locally.
 *
 * Two-layer architecture:
 *   - Personality = strategic target vector (what the bot wants)
 *   - Difficulty  = execution-quality modifier (how well it achieves the target)
 *
 * Named presets give professors character-driven bot selection.
 */

'use strict';

const {
  PRODUCT_CATALOG,
  PRODUCT_KEYS,
  PRICE_ZONES,
  AD_TYPES,
  CHEF_NATIONALITIES,
} = require('./config');

const { calculateTotalProductOutput } = require('./chef-system');
const { runSimulation } = require('./simulation');

// ---------------------------------------------------------------------------
// Named presets (professor-friendly characters)
// ---------------------------------------------------------------------------

const PRESETS = {
  chaotic_charlie:  { difficulty: 'novice', personality: 'random',        name: 'Chaotic Charlie' },
  unlucky_larry:    { difficulty: 'novice', personality: 'balanced',      name: 'Unlucky Larry' },
  balanced_bob:     { difficulty: 'medium', personality: 'balanced',      name: 'Balanced Bob' },
  cautious_carla:   { difficulty: 'medium', personality: 'conservative',  name: 'Cautious Carla' },
  risky_ricky:      { difficulty: 'hard',   personality: 'aggressive',    name: 'Risky Ricky' },
  chef_pierre:      { difficulty: 'hard',   personality: 'chef_focused',  name: 'Chef Pierre' },
  marketing_molly:  { difficulty: 'hard',   personality: 'ad_focused',    name: 'Marketing Molly' },
  perfect_patricia: { difficulty: 'perfect',personality: 'balanced',      name: 'Perfect Patricia' },
};

// ---------------------------------------------------------------------------
// Personality configs (strategic targets)
// ---------------------------------------------------------------------------

const PERSONALITIES = {
  balanced: {
    adBidPct: 0.60,
    chefBidPct: 0.70,
    priceZoneTarget: 'competitiveMid',
    stockMult: 1.0,
    sousChefTarget: 3,
    chefPriority: 0.5,
    adPriority: 0.5,
    budgetBuffer: 0.10,
  },
  aggressive: {
    adBidPct: 0.90,
    chefBidPct: 0.90,
    priceZoneTarget: 'premiumLow',
    stockMult: 1.25,
    sousChefTarget: 4,
    chefPriority: 0.7,
    adPriority: 0.8,
    budgetBuffer: 0.00,
  },
  conservative: {
    adBidPct: 0.35,
    chefBidPct: 0.45,
    priceZoneTarget: 'floor',
    stockMult: 0.85,
    sousChefTarget: 2,
    chefPriority: 0.3,
    adPriority: 0.2,
    budgetBuffer: 0.20,
  },
  random: {
    // Special — pure chaos, ignores all strategy
  },
  chef_focused: {
    adBidPct: 0.20,
    chefBidPct: 0.95,
    priceZoneTarget: 'competitiveMid',
    stockMult: 1.0,
    sousChefTarget: 4,
    chefPriority: 1.0,
    adPriority: 0.1,
    budgetBuffer: 0.10,
  },
  ad_focused: {
    adBidPct: 0.95,
    chefBidPct: 0.30,
    priceZoneTarget: 'competitiveLow',
    stockMult: 1.1,
    sousChefTarget: 3,
    chefPriority: 0.1,
    adPriority: 1.0,
    budgetBuffer: 0.05,
  },
  volume: {
    adBidPct: 0.50,
    chefBidPct: 0.60,
    priceZoneTarget: 'floor',
    stockMult: 1.35,
    sousChefTarget: 5,
    chefPriority: 0.4,
    adPriority: 0.4,
    budgetBuffer: 0.05,
  },
  margin: {
    adBidPct: 0.40,
    chefBidPct: 0.50,
    priceZoneTarget: 'premiumLow',
    stockMult: 0.70,
    sousChefTarget: 2,
    chefPriority: 0.4,
    adPriority: 0.3,
    budgetBuffer: 0.15,
  },
};

// ---------------------------------------------------------------------------
// Difficulty configs (execution quality)
// ---------------------------------------------------------------------------

const DIFFICULTIES = {
  novice: {
    bidNoise: 0.50,
    mistakeChance: 0.30,
    forgetPhaseChance: 0.20,
    budgetSlop: 0.20,
    shadowSimDepth: 0,
    opponentModel: 'none',
  },
  easy: {
    bidNoise: 0.25,
    mistakeChance: 0.15,
    forgetPhaseChance: 0.10,
    budgetSlop: 0.10,
    shadowSimDepth: 0,
    opponentModel: 'none',
  },
  medium: {
    bidNoise: 0.10,
    mistakeChance: 0.05,
    forgetPhaseChance: 0.05,
    budgetSlop: 0.05,
    shadowSimDepth: 0,
    opponentModel: 'none',
  },
  hard: {
    bidNoise: 0.05,
    mistakeChance: 0.01,
    forgetPhaseChance: 0.02,
    budgetSlop: 0.02,
    shadowSimDepth: 0,
    opponentModel: 'current',
  },
  perfect: {
    bidNoise: 0,
    mistakeChance: 0,
    forgetPhaseChance: 0,
    budgetSlop: 0,
    shadowSimDepth: 5,
    opponentModel: 'historical',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function snapPrice(price) {
  return Math.round(price / 0.25) * 0.25;
}

/**
 * Build the set of products this bot is allowed to put on the menu.
 *
 * Apr 28 2026 — station unlocks. Optional products (cookie, sandwich, matcha)
 * must be unlocked via `purchaseProduct` before they can be on the menu.
 * `validateDecision` rejects locked products with `failed-precondition`, so
 * the bot must respect the same constraint or the whole decision is dropped.
 *
 * Base menu products (`isBaseMenu === true`) are always available — they're
 * checked separately in each menu-building branch and don't need to be in
 * `botState.unlockedProducts`. When `unlockedProducts` is missing the bot
 * falls back to BASE_MENU only, matching `validateDecision`'s default.
 */
function getUnlockedSet(botState) {
  const list = botState && Array.isArray(botState.unlockedProducts)
    ? botState.unlockedProducts
    : [];
  return new Set(list.filter((p) => typeof p === 'string'));
}

function getZonePrice(product, target) {
  const z = PRICE_ZONES[product];
  if (!z) return PRODUCT_CATALOG[product].fixedPrice || 4.0;
  switch (target) {
    case 'floor': return z.floor;
    case 'competitiveLow': return z.competitiveRangeLow;
    case 'competitiveMid': return (z.competitiveRangeLow + z.competitiveRangeHigh) / 2;
    case 'competitiveHigh': return z.competitiveRangeHigh;
    case 'premiumLow': return z.premiumRangeLow;
    case 'premiumHigh': return z.premiumRangeHigh;
    case 'ceiling': return z.ceiling;
    default: return (z.competitiveRangeLow + z.competitiveRangeHigh) / 2;
  }
}

function mapLegacyDifficulty(d) {
  if (DIFFICULTIES[d]) return d;
  // Old schema only had easy/medium/hard
  if (d === 'easy') return 'easy';
  if (d === 'hard') return 'hard';
  return 'medium';
}

// ---------------------------------------------------------------------------
// Seeded RNG (Mulberry32) — deterministic for tests, optional seed param
// ---------------------------------------------------------------------------

function _hashStringToInt(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function _mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  if (seed != null) return _mulberry32(_hashStringToInt(String(seed)));
  return Math.random;
}

// ---------------------------------------------------------------------------
// Noise & mistake application
// ---------------------------------------------------------------------------

function applyNoise(value, noiseLevel, rng) {
  if (noiseLevel <= 0) return value;
  const noise = (rng() * 2 - 1) * noiseLevel;
  return value * (1 + noise);
}

function maybeForgetPhase(forgetPhaseChance, rng) {
  return rng() < forgetPhaseChance;
}

function applyMistakeToAdBids(bids, mistakeChance, rng) {
  if (rng() >= mistakeChance) return bids;
  const copy = { ...bids };
  const keys = Object.keys(copy);
  if (keys.length === 0) return copy;
  const target = keys[Math.floor(rng() * keys.length)];
  // Mistake: either skip this bid or bid $1
  if (rng() < 0.5) {
    copy[target] = 0;
  } else {
    copy[target] = 1;
  }
  return copy;
}

function applyMistakeToChefBids(bids, mistakeChance, rng) {
  if (rng() >= mistakeChance || bids.length === 0) return bids;
  const copy = bids.map((b) => ({ ...b }));
  const idx = Math.floor(rng() * copy.length);
  if (rng() < 0.5) {
    copy.splice(idx, 1); // drop a bid
  } else {
    copy[idx].amount = Math.max(1, Math.floor(copy[idx].amount * 0.5)); // underbid
  }
  return copy;
}

function applyMistakeToDecide(decisions, mistakeChance, rng) {
  if (rng() >= mistakeChance) return decisions;
  const copy = {
    menu: { ...decisions.menu },
    quantities: { ...decisions.quantities },
    productPrices: { ...decisions.productPrices },
    sousChefCount: decisions.sousChefCount,
    sousChefAssignments: decisions.sousChefAssignments,
    staffCounts: decisions.staffCounts,
    maintenanceTasks: decisions.maintenanceTasks,
  };
  const products = PRODUCT_KEYS.filter(() => rng() < 0.3);
  for (const p of products) {
    if (rng() < 0.5) {
      // Forget to stock this product
      copy.quantities[p] = 0;
      copy.menu[p] = false;
    } else {
      // Price mistake: snap to floor or ceiling
      const z = PRICE_ZONES[p];
      copy.productPrices[p] = snapPrice(rng() < 0.5 ? z.floor : z.ceiling);
    }
  }
  return copy;
}

// ---------------------------------------------------------------------------
// EV helpers (kept from original)
// ---------------------------------------------------------------------------

function expectedAdValue(adType, config) {
  const adBonuses = (config && config.adBonuses) || {};
  const adTraffic = (config && config.adFootTrafficBonuses) || {};
  const bonus = _num(adBonuses[adType]);
  const trafficPct = _num(adTraffic[adType]);
  const expectedCustomers = 150;
  const avgMargin = 4.0;
  const trafficValue = trafficPct * expectedCustomers * avgMargin;
  return bonus + trafficValue;
}

function expectedChefValue(chef, config) {
  if (!chef || !chef.specialties) return 0;
  const tierMult = { novel: 1.0, intermediate: 2.0, advanced: 3.0 }[chef.skillTier] || 1.0;
  const baseOutput = 30;
  const margin = 4.0;
  return chef.specialties.length * baseOutput * (tierMult - 1) * margin;
}

// ---------------------------------------------------------------------------
// Opponent modeling (for perfect / hard tiers)
// ---------------------------------------------------------------------------

function buildOpponentModel(playerId, historicalBids) {
  const bids = (historicalBids && historicalBids[playerId]) || [];
  if (bids.length === 0) return null;

  const model = { adBids: {}, chefBids: {} };

  for (const ad of AD_TYPES) {
    const values = bids
      .filter((b) => b.ad && typeof b.ad[ad] === 'number')
      .map((b) => b.ad[ad]);
    if (values.length > 0) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const max = Math.max(...values);
      model.adBids[ad] = { mean, max, count: values.length };
    }
  }

  // Chef bids grouped by skillTier
  const chefValuesByTier = { novel: [], intermediate: [], advanced: [] };
  for (const b of bids) {
    if (Array.isArray(b.chef)) {
      for (const cb of b.chef) {
        if (cb && typeof cb.amount === 'number' && cb.chefTier) {
          chefValuesByTier[cb.chefTier].push(cb.amount);
        }
      }
    }
  }
  for (const tier of ['novel', 'intermediate', 'advanced']) {
    const values = chefValuesByTier[tier];
    if (values.length > 0) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      model.chefBids[tier] = { mean, max: Math.max(...values), count: values.length };
    }
  }

  return model;
}

function predictOpponentAdBids(opponent, model, config) {
  const bids = {};
  for (const ad of AD_TYPES) {
    if (model && model.adBids[ad]) {
      // Predict slightly below historical mean (opponents tend to repeat)
      bids[ad] = Math.max(0, Math.floor(model.adBids[ad].mean * 0.95));
    } else {
      const ev = expectedAdValue(ad, config);
      bids[ad] = Math.floor(ev * 0.5); // fallback: medium/balanced
    }
  }
  return bids;
}

function predictOpponentChefBids(opponent, chefPool, model, config) {
  const bids = [];
  for (const chef of chefPool) {
    const ev = expectedChefValue(chef, config);
    const floor = _num(chef.minBidFloor);
    let predicted;
    if (model && model.chefBids[chef.skillTier]) {
      predicted = Math.max(floor, Math.floor(model.chefBids[chef.skillTier].mean * 0.95));
    } else {
      predicted = Math.max(floor, Math.floor(ev * 0.5));
    }
    bids.push({ chefId: chef.id, amount: predicted });
  }
  return bids;
}

// ---------------------------------------------------------------------------
// Budget helpers
// ---------------------------------------------------------------------------

function estimateStockCost(quantities, config) {
  const totalQty = Object.values(quantities).reduce((s, q) => s + _num(q), 0);
  return totalQty * _num(config.unitCostPerProduct);
}

function estimateSousChefCost(count, config) {
  // Escalating cost: base + (count-1) * escalation
  const base = _num(config.sousChefBaseCost);
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += base * (1 + i * 0.15);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Core decision logic per phase
// ---------------------------------------------------------------------------

function decideAdBids(botState, config, personality, difficulty, rng, opponents, historicalBids) {
  const budget = _num(botState.budgetCurrent);
  const diffCfg = DIFFICULTIES[difficulty];
  const personCfg = PERSONALITIES[personality] || PERSONALITIES.balanced;

  // Build opponent model if needed
  let opponentModels = {};
  if (diffCfg.opponentModel === 'historical' && historicalBids) {
    for (const opp of (opponents || [])) {
      if (opp.uid || opp.playerId) {
        opponentModels[opp.uid || opp.playerId] = buildOpponentModel(opp.uid || opp.playerId, historicalBids);
      }
    }
  }

  const bids = {};
  for (const ad of AD_TYPES) {
    const ev = expectedAdValue(ad, config);
    let bidAmount = Math.floor(ev * personCfg.adBidPct);

    // Hard/perfect: try to outbid predicted opponents
    if ((diffCfg.opponentModel === 'current' || diffCfg.opponentModel === 'historical') && opponents) {
      let predictedSecondHighest = 0;
      for (const opp of opponents) {
        const model = opponentModels[opp.uid || opp.playerId];
        const predictedBid = predictOpponentAdBids(opp, model, config)[ad];
        if (predictedBid > predictedSecondHighest) {
          predictedSecondHighest = predictedBid;
        }
      }
      if (predictedSecondHighest > 0) {
        // Bid $1 above predicted second highest, capped at EV. Floor at the
        // personality target so an aggressive bot does not get pushed below it.
        bidAmount = Math.min(Math.floor(ev), Math.max(bidAmount, predictedSecondHighest + 1));
      }
    }

    // Noise
    bidAmount = Math.floor(applyNoise(bidAmount, diffCfg.bidNoise, rng));
    bidAmount = Math.max(0, bidAmount);

    // Budget cap with buffer
    const maxAdSpend = budget * (1 - personCfg.budgetBuffer);
    if (Object.values(bids).reduce((s, v) => s + v, 0) + bidAmount > maxAdSpend) {
      bidAmount = Math.max(0, Math.floor(maxAdSpend - Object.values(bids).reduce((s, v) => s + v, 0)));
    }

    bids[ad] = bidAmount;
  }

  return applyMistakeToAdBids(bids, diffCfg.mistakeChance, rng);
}

function decideChefBids(botState, config, personality, difficulty, rng, opponents, historicalBids) {
  const budget = _num(botState.budgetCurrent);
  const diffCfg = DIFFICULTIES[difficulty];
  const personCfg = PERSONALITIES[personality] || PERSONALITIES.balanced;
  const pool = botState.chefPool || [];

  let opponentModels = {};
  if (diffCfg.opponentModel === 'historical' && historicalBids) {
    for (const opp of (opponents || [])) {
      if (opp.uid || opp.playerId) {
        opponentModels[opp.uid || opp.playerId] = buildOpponentModel(opp.uid || opp.playerId, historicalBids);
      }
    }
  }

  const bids = [];
  for (const chef of pool) {
    const ev = expectedChefValue(chef, config);
    const floor = _num(chef.minBidFloor);
    let bidAmount = Math.max(floor, Math.floor(ev * personCfg.chefBidPct));

    // Hard/perfect: outbid predicted opponents
    if ((diffCfg.opponentModel === 'current' || diffCfg.opponentModel === 'historical') && opponents) {
      let predictedSecondHighest = 0;
      for (const opp of opponents) {
        const model = opponentModels[opp.uid || opp.playerId];
        const oppBids = predictOpponentChefBids(opp, [chef], model, config);
        const predictedBid = oppBids.find((b) => b.chefId === chef.id);
        if (predictedBid && predictedBid.amount > predictedSecondHighest) {
          predictedSecondHighest = predictedBid.amount;
        }
      }
      if (predictedSecondHighest > 0) {
        // Bid $1 above predicted second highest, capped at EV. Floor at the
        // personality target so an aggressive bot does not get pushed below it.
        bidAmount = Math.min(Math.floor(ev), Math.max(bidAmount, predictedSecondHighest + 1));
        bidAmount = Math.max(floor, bidAmount);
      }
    }

    // Noise
    bidAmount = Math.floor(applyNoise(bidAmount, diffCfg.bidNoise, rng));
    bidAmount = Math.max(floor, bidAmount);

    // Budget cap with buffer
    const maxChefSpend = budget * (1 - personCfg.budgetBuffer);
    const spentSoFar = bids.reduce((s, b) => s + b.amount, 0);
    if (spentSoFar + bidAmount > maxChefSpend) {
      bidAmount = Math.max(floor, Math.floor(maxChefSpend - spentSoFar));
    }

    if (bidAmount > 0 && budget >= bidAmount) {
      bids.push({ chefId: chef.id, amount: bidAmount });
    }
  }

  return applyMistakeToChefBids(bids, diffCfg.mistakeChance, rng);
}

function decideRoster(botState, config, personality, difficulty, rng) {
  const chefs = Array.isArray(botState.specialtyChefs) ? botState.specialtyChefs : [];
  const cap = _num(config.specialtyChefCap);
  if (chefs.length <= cap) return { layoffs: [] };

  const diffCfg = DIFFICULTIES[difficulty];
  const personCfg = PERSONALITIES[personality] || PERSONALITIES.balanced;

  // Sort by value (descending), keep the most valuable
  const sorted = [...chefs].sort((a, b) => expectedChefValue(b, config) - expectedChefValue(a, config));

  // Personality override: chef_focused keeps more chefs if possible
  let keepCount = cap;
  if (personality === 'chef_focused') {
    keepCount = Math.min(chefs.length, cap + 1); // try to keep 1 extra (will still need to layoff)
    keepCount = Math.min(keepCount, cap); // respect cap
  }

  const toLayoff = sorted.slice(keepCount);

  // Mistake: novice/easy might lay off the wrong chef
  if (rng() < diffCfg.mistakeChance && toLayoff.length > 0) {
    // Randomly swap one keep with one layoff
    const keepIdx = Math.floor(rng() * keepCount);
    const layoffIdx = Math.floor(rng() * toLayoff.length);
    if (keepIdx < sorted.length && layoffIdx < toLayoff.length) {
      const temp = toLayoff[layoffIdx];
      toLayoff[layoffIdx] = sorted[keepIdx];
      sorted[keepIdx] = temp;
    }
  }

  return { layoffs: toLayoff.map((c) => c.id) };
}

// ---------------------------------------------------------------------------
// Decide phase — operational decisions
// ---------------------------------------------------------------------------

function decideOperations(botState, config, personality, difficulty, rng, opponents, historicalBids) {
  const personCfg = PERSONALITIES[personality] || PERSONALITIES.balanced;
  const diffCfg = DIFFICULTIES[difficulty];
  const budget = _num(botState.budgetCurrent);

  // Build menu based on chef specialties
  const chefs = Array.isArray(botState.specialtyChefs) ? botState.specialtyChefs : [];
  const chefProducts = new Set();
  for (const chef of chefs) {
    for (const sp of (chef.specialties || [])) {
      chefProducts.add(sp);
    }
  }
  // Apr 28 2026 — station unlocks. A specialty chef makes us *want* an
  // optional product, but the team still has to have purchased the unlock
  // before the validator will accept it on the menu.
  const unlockedSet = getUnlockedSet(botState);

  const menu = {};
  for (const product of PRODUCT_KEYS) {
    const catalog = PRODUCT_CATALOG[product];
    const hasChef = chefProducts.has(product);
    const eligible = catalog.isBaseMenu || unlockedSet.has(product);
    // Base menu + chef specialties + personality extras, all gated on unlock.
    let onMenu = catalog.isBaseMenu || (hasChef && unlockedSet.has(product));
    if (personality === 'volume') onMenu = eligible; // volume offers everything it can
    if (personality === 'margin' && !catalog.isBaseMenu && !hasChef) {
      onMenu = false; // margin only offers high-margin items
    }
    menu[product] = onMenu;
  }

  // Prices
  const productPrices = {};
  for (const product of PRODUCT_KEYS) {
    const basePrice = getZonePrice(product, personCfg.priceZoneTarget);
    let price = snapPrice(basePrice);
    // Noise
    price = snapPrice(applyNoise(price, diffCfg.bidNoise, rng));
    // Clamp to valid range
    const z = PRICE_ZONES[product];
    price = clamp(price, z.floor, z.ceiling);
    productPrices[product] = snapPrice(price);
  }

  // Quantities
  const quantities = {};
  for (const product of PRODUCT_KEYS) {
    if (!menu[product]) {
      quantities[product] = 0;
      continue;
    }
    const catalog = PRODUCT_CATALOG[product];
    const dailyDemand = catalog.baseDemand / 30;
    let qty = Math.round(dailyDemand * personCfg.stockMult);
    qty = Math.floor(applyNoise(qty, diffCfg.bidNoise, rng));
    quantities[product] = Math.max(0, qty);
  }

  // Sous chefs
  let sousChefCount = personCfg.sousChefTarget;
  sousChefCount = Math.round(applyNoise(sousChefCount, diffCfg.bidNoise, rng));
  sousChefCount = clamp(sousChefCount, 0, 8);

  // Budget check and scale down if needed
  const stockCost = estimateStockCost(quantities, config);
  const scCost = estimateSousChefCost(sousChefCount, config);
  const totalCost = stockCost + scCost;
  const maxSpend = budget * (1 - personCfg.budgetBuffer);

  if (totalCost > maxSpend) {
    // Scale down quantities proportionally
    const scale = Math.max(0.1, (maxSpend - scCost) / stockCost);
    for (const product of PRODUCT_KEYS) {
      quantities[product] = Math.floor(quantities[product] * scale);
    }
  }

  const decisions = {
    menu,
    quantities,
    productPrices,
    sousChefCount,
    sousChefAssignments: {},
    staffCounts: {},
    maintenanceTasks: [],
  };

  return applyMistakeToDecide(decisions, diffCfg.mistakeChance, rng);
}

// ---------------------------------------------------------------------------
// Perfect bot shadow simulation (decide phase only)
// ---------------------------------------------------------------------------

function perfectBotDecide(botState, config, opponents, historicalBids, personality) {
  const personCfg = PERSONALITIES[personality] || PERSONALITIES.balanced;
  const budget = _num(botState.budgetCurrent);

  // Start with personality baseline
  const baseline = decideOperations(botState, config, personality, 'perfect', () => 0.5, opponents, historicalBids);

  // If no runSimulation available or no opponents, return baseline
  if (typeof runSimulation !== 'function' || !opponents || opponents.length === 0) {
    return baseline;
  }

  // Build predicted opponent decisions
  const opponentDecisions = [];
  for (const opp of opponents) {
    const model = historicalBids ? buildOpponentModel(opp.uid || opp.playerId, historicalBids) : null;
    const predicted = predictOpponentFullDecisions(opp, model, config);
    opponentDecisions.push(predicted);
  }

  // Candidate generation: coordinate descent over prices and quantities
  const priceOptions = ['floor', 'competitiveMid', 'premiumLow'];
  const qtyMults = [0.85, 1.0, 1.15];

  let best = baseline;
  let bestScore = evaluateCandidate(botState, baseline, opponentDecisions, config);

  // Optimize each product's price independently
  for (const product of PRODUCT_KEYS) {
    if (!baseline.menu[product]) continue;
    for (const zone of priceOptions) {
      const candidate = deepCopyDecisions(best);
      candidate.productPrices[product] = snapPrice(getZonePrice(product, zone));
      const score = evaluateCandidate(botState, candidate, opponentDecisions, config);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }

  // Optimize each product's quantity independently
  for (const product of PRODUCT_KEYS) {
    if (!best.menu[product]) continue;
    const catalog = PRODUCT_CATALOG[product];
    const dailyDemand = catalog.baseDemand / 30;
    for (const mult of qtyMults) {
      const candidate = deepCopyDecisions(best);
      candidate.quantities[product] = Math.round(dailyDemand * mult);
      const score = evaluateCandidate(botState, candidate, opponentDecisions, config);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }

  // Fine-tune sous chef count
  for (const sc of [2, 3, 4, 5]) {
    const candidate = deepCopyDecisions(best);
    candidate.sousChefCount = sc;
    const score = evaluateCandidate(botState, candidate, opponentDecisions, config);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

function predictOpponentFullDecisions(opponent, model, config) {
  // Predict opponent's full decision based on historical patterns
  // Fallback: assume medium/balanced behavior
  const chefs = Array.isArray(opponent.specialtyChefs) ? opponent.specialtyChefs : [];
  const chefProducts = new Set();
  for (const chef of chefs) {
    for (const sp of (chef.specialties || [])) chefProducts.add(sp);
  }

  const menu = {};
  const quantities = {};
  const productPrices = {};
  for (const product of PRODUCT_KEYS) {
    const catalog = PRODUCT_CATALOG[product];
    menu[product] = catalog.isBaseMenu || chefProducts.has(product);
    quantities[product] = menu[product] ? Math.round(catalog.baseDemand / 30) : 0;
    const z = PRICE_ZONES[product];
    productPrices[product] = snapPrice((z.competitiveRangeLow + z.competitiveRangeHigh) / 2);
  }

  return {
    playerId: opponent.uid || opponent.playerId,
    decision: {
      menu,
      quantities,
      productPrices,
      sousChefCount: 3,
      sousChefAssignments: {},
      staffCounts: {},
      maintenanceTasks: [],
    },
    specialtyChefs: chefs,
    sousChefCount: 3,
    budgetCurrent: _num(opponent.budgetCurrent),
    priorSubmittedPrices: [],
    adWins: [],
    chefsWon: [],
  };
}

function deepCopyDecisions(d) {
  return {
    menu: { ...d.menu },
    quantities: { ...d.quantities },
    productPrices: { ...d.productPrices },
    sousChefCount: d.sousChefCount,
    sousChefAssignments: { ...d.sousChefAssignments },
    staffCounts: { ...d.staffCounts },
    maintenanceTasks: Array.isArray(d.maintenanceTasks) ? [...d.maintenanceTasks] : [],
  };
}

function evaluateCandidate(botState, candidate, opponentDecisions, config) {
  try {
    const players = [
      {
        playerId: botState.playerId || 'bot',
        decision: {
          menu: candidate.menu,
          quantities: candidate.quantities,
          productPrices: candidate.productPrices,
          sousChefCount: candidate.sousChefCount,
          sousChefAssignments: candidate.sousChefAssignments,
          staffCounts: candidate.staffCounts,
          maintenanceTasks: candidate.maintenanceTasks,
        },
        specialtyChefs: botState.specialtyChefs || [],
        sousChefCount: candidate.sousChefCount,
        budgetCurrent: _num(botState.budgetCurrent),
        priorSubmittedPrices: botState.priorSubmittedPrices || [],
        adWins: botState.adWins || [],
        chefsWon: botState.chefsWon || [],
      },
      ...opponentDecisions,
    ];

    const roundPreferences = botState.roundPreferences || { modifiers: {} };
    const results = runSimulation(players, roundPreferences, config, {
      gameId: botState.gameId || 'shadow',
      round: botState.round || 1,
      skipCostAccounting: false,
    });

    const myResult = results.find((r) => r.playerId === (botState.playerId || 'bot'));
    if (!myResult) return -Infinity;

    // Score = net profit + budget trajectory bonus
    const profit = _num(myResult.revenue) - _num(myResult.totalCost);
    const budgetLeft = _num(myResult.endingBudget);
    return profit + budgetLeft * 0.1; // weight remaining budget lightly
  } catch (err) {
    // Shadow sim failed, fall back to heuristic score
    return heuristicScore(candidate, botState, config);
  }
}

function heuristicScore(candidate, botState, config) {
  // Fast local estimate when runSimulation fails
  let revenue = 0;
  let cost = 0;
  for (const product of PRODUCT_KEYS) {
    if (!candidate.menu[product]) continue;
    const qty = _num(candidate.quantities[product]);
    const price = _num(candidate.productPrices[product]);
    const unitCost = _num(config.unitCostPerProduct);
    // Rough: assume 80% of stock sells at listed price
    revenue += qty * price * 0.8;
    cost += qty * unitCost;
  }
  cost += estimateSousChefCost(candidate.sousChefCount, config);
  return revenue - cost;
}

// ---------------------------------------------------------------------------
// Random personality (chaos monkey)
// ---------------------------------------------------------------------------

function randomBotDecisions(botState, phase, config, rng) {
  const budget = _num(botState.budgetCurrent);

  if (phase === 'bid_ad') {
    const bids = {};
    for (const ad of AD_TYPES) {
      bids[ad] = rng() < 0.4 ? Math.floor(rng() * Math.min(500, budget * 0.3)) : 0;
    }
    return { adBids: bids };
  }

  if (phase === 'bid_chef') {
    const pool = botState.chefPool || [];
    const bids = [];
    for (const chef of pool) {
      const floor = _num(chef.minBidFloor);
      if (rng() < 0.5 && budget >= floor) {
        bids.push({ chefId: chef.id, amount: Math.floor(floor + rng() * 50) });
      }
    }
    return { chefBids: bids };
  }

  if (phase === 'roster') {
    const chefs = Array.isArray(botState.specialtyChefs) ? botState.specialtyChefs : [];
    const cap = 3;
    let toLayoff = [];
    if (chefs.length > cap) {
      // Must lay off down to cap — pick the lowest-rated extras
      const sorted = [...chefs].sort((a, b) => (a.rating || 0) - (b.rating || 0));
      toLayoff = sorted.slice(0, chefs.length - cap);
    }
    return { layoffs: toLayoff.map((c) => c.id) };
  }

  if (phase === 'decide') {
    const unlockedSet = getUnlockedSet(botState);
    const menu = {};
    const quantities = {};
    const productPrices = {};
    for (const product of PRODUCT_KEYS) {
      const catalog = PRODUCT_CATALOG[product];
      // A locked optional product fails validation regardless of how
      // chaotic the personality wants to be — gate inclusion on the unlock.
      const eligible = catalog.isBaseMenu || unlockedSet.has(product);
      const onMenu = eligible && rng() < 0.7;
      menu[product] = onMenu;
      const z = PRICE_ZONES[product];
      quantities[product] = onMenu ? Math.floor(5 + rng() * 20) : 0;
      // Random price anywhere in valid range
      productPrices[product] = snapPrice(z.floor + rng() * (z.ceiling - z.floor));
    }
    return {
      menu,
      quantities,
      productPrices,
      sousChefCount: Math.floor(rng() * 6),
      sousChefAssignments: {},
      staffCounts: {},
      maintenanceTasks: [],
    };
  }

  return {};
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate bot decisions for the current phase.
 *
 * @param {object} botState       { budgetCurrent, specialtyChefs, chefPool, unlockedProducts, playerId, round, gameId, ... }
 * @param {string} phase          'bid_ad' | 'bid_chef' | 'roster' | 'decide'
 * @param {object} config         merged game config
 * @param {Array}  opponents      array of opponent player states
 * @param {string} difficulty     'novice' | 'easy' | 'medium' | 'hard' | 'perfect'
 * @param {string} personality    'balanced' | 'aggressive' | 'conservative' | 'random' |
 *                                'chef_focused' | 'ad_focused' | 'volume' | 'margin'
 * @param {object} historicalBids { [playerId]: [{ round, ad, chef }] }
 * @param {string} seed           optional seed for deterministic RNG (tests)
 * @returns {object} decisions for the current phase
 */
function generateBotDecisions(
  botState,
  phase,
  config,
  opponents,
  difficulty,
  personality,
  historicalBids,
  seed,
) {
  const diffKey = mapLegacyDifficulty(difficulty || 'medium');
  const personKey = PERSONALITIES[personality] ? personality : 'balanced';
  const diffCfg = DIFFICULTIES[diffKey];
  const rng = makeRng(seed);

  // Forget phase entirely?
  if (maybeForgetPhase(diffCfg.forgetPhaseChance, rng)) {
    if (phase === 'bid_ad') return { adBids: {} };
    if (phase === 'bid_chef') return { chefBids: [] };
    if (phase === 'roster') return { layoffs: [] };
    if (phase === 'decide') {
      return {
        menu: {},
        quantities: {},
        productPrices: {},
        sousChefCount: 0,
        sousChefAssignments: {},
        staffCounts: {},
        maintenanceTasks: [],
      };
    }
    return {};
  }

  // Random personality short-circuit
  if (personKey === 'random') {
    return randomBotDecisions(botState, phase, config, rng);
  }

  switch (phase) {
    case 'bid_ad':
      return { adBids: decideAdBids(botState, config, personKey, diffKey, rng, opponents, historicalBids) };
    case 'bid_chef':
      return { chefBids: decideChefBids(botState, config, personKey, diffKey, rng, opponents, historicalBids) };
    case 'roster':
      return decideRoster(botState, config, personKey, diffKey, rng);
    case 'decide': {
      if (diffKey === 'perfect') {
        return perfectBotDecide(botState, config, opponents, historicalBids, personKey);
      }
      return decideOperations(botState, config, personKey, diffKey, rng, opponents, historicalBids);
    }
    default:
      return {};
  }
}

module.exports = {
  generateBotDecisions,
  expectedAdValue,
  expectedChefValue,
  PRESETS,
  PERSONALITIES,
  DIFFICULTIES,
  buildOpponentModel,
  predictOpponentAdBids,
  mapLegacyDifficulty,
};
