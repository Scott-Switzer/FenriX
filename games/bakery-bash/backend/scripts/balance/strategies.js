/**
 * strategies.js — Concrete team strategies for balance probing.
 *
 * Each strategy is a function `play(ctx)` returning:
 *   { adBids, chefBids, quantities, menu, sousChefCount, sousChefAssignments,
 *     productPrices }
 *
 * Strategies are pure: they read ctx (round, budget, specialtyChefs,
 * returningCustomers, roundPrefs, chefPool, cfg) and emit a move.
 *
 * Goal: cover the strategy space well enough to expose dominant strategies.
 */

'use strict';

const path = require('path');
const config = require(path.join('..', '..', 'functions', 'modules', 'config'));

const { PRODUCT_KEYS, PRICE_ZONES, PRODUCT_CATALOG } = config;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pick the highest-skill chef in pool whose nationality is in `targets`. */
function pickBestChefByNationality(chefPool, targets) {
  const skillRank = { advanced: 3, intermediate: 2, novel: 1 };
  let best = null;
  for (const chef of chefPool) {
    if (!targets.includes(chef.nationality)) continue;
    if (!best || skillRank[chef.skillTier] > skillRank[best.skillTier]) {
      best = chef;
    }
  }
  return best;
}

/** Pick the highest-skill chef whose specialties include any of `products`. */
function pickBestChefForProducts(chefPool, products) {
  const skillRank = { advanced: 3, intermediate: 2, novel: 1 };
  let best = null;
  for (const chef of chefPool) {
    const overlap = chef.specialties.some((p) => products.includes(p));
    if (!overlap) continue;
    if (!best || skillRank[chef.skillTier] > skillRank[best.skillTier]) {
      best = chef;
    }
  }
  return best;
}

/** Build a default product price map (catalog price for each). */
function defaultPrices() {
  const out = {};
  for (const p of PRODUCT_KEYS) {
    out[p] = PRODUCT_CATALOG[p].fixedPrice;
  }
  return out;
}

/** Set every product price to its floor (max demand bonus from low prices). */
function floorPrices() {
  const out = {};
  for (const p of PRODUCT_KEYS) {
    out[p] = PRICE_ZONES[p].floor;
  }
  return out;
}

/** Set every product price to its ceiling (max margin per unit). */
function ceilingPrices() {
  const out = {};
  for (const p of PRODUCT_KEYS) {
    out[p] = PRICE_ZONES[p].ceiling;
  }
  return out;
}

/**
 * Reasonable stock for an offered product based on round preferences and
 * how many specialty chefs the team has on it.
 *   stock = baseDemand * roundModifier * 1.4 (ample but not exorbitant)
 */
function stockForOffered(offered, roundPrefs, multiplier = 1.4) {
  const out = {};
  const mods = roundPrefs.modifiers || {};
  for (const p of offered) {
    const baseDemand = PRODUCT_CATALOG[p].baseDemand;
    const mod = typeof mods[p] === 'number' ? mods[p] : 1.0;
    out[p] = Math.round(baseDemand * mod * multiplier);
  }
  return out;
}

/** Build a menu object from a list of offered products. */
function menuFromList(list) {
  const out = {};
  for (const p of PRODUCT_KEYS) out[p] = list.includes(p);
  return out;
}

/** Distribute N sous chefs across products (round-robin, priority list first). */
function distributeSous(n, priority) {
  const out = {};
  for (const p of priority) out[p] = 0;
  let i = 0;
  for (let k = 0; k < n; k++) {
    const p = priority[i % priority.length];
    out[p] = (out[p] || 0) + 1;
    i++;
  }
  return out;
}

/** Smallest bid above floor that we'll submit for a chef. */
function smartBidFor(chef, budget, fraction = 1.0) {
  if (!chef) return 0;
  const floor = chef.minBidFloor;
  const cap = Math.floor(budget * fraction);
  return Math.max(floor, Math.min(cap, floor + Math.floor(floor * 0.05)));
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/**
 * BASELINE — A reasonable but unspecialized player.
 * Stocks the base menu, hires 2 sous chefs, makes modest bids on TV+Billboard.
 * Updated to bid on multiple ads so opponents in the harness aren't trivially
 * outflanked by an "all-4-ads" candidate strategy.
 */
function baseline(ctx) {
  const offered = ['croissant', 'cookie', 'bagel'];
  const sousChefCount = 2;
  return {
    adBids: { TV: 16500, Billboard: 10500, Radio: 6500, Newspaper: 3500 },
    chefBids: [],
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.3),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, offered),
    productPrices: defaultPrices(),
  };
}
baseline.label = 'Baseline';

// --- A. Nationality stack: French (croissant + coffee specialty) ---
function frenchStack(ctx) {
  const offered = ['croissant', 'coffee', 'cookie', 'bagel'];
  const target = pickBestChefByNationality(ctx.chefPool, ['french']);
  const chefBids = target
    ? [{ chefId: target.id, amount: smartBidFor(target, ctx.budget, 0.25) }]
    : [];
  const sousChefCount = 4;
  return {
    adBids: { TV: 16500, Billboard: 10500, Radio: 6500, Newspaper: 3500 },
    chefBids,
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.4),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, ['croissant', 'coffee', 'bagel', 'cookie']),
    productPrices: defaultPrices(),
  };
}
frenchStack.label = 'FrenchStack';

// --- B. Nationality stack: Japanese (matcha + croissant) ---
function japaneseStack(ctx) {
  const offered = ['matcha', 'croissant', 'cookie', 'bagel'];
  const target = pickBestChefByNationality(ctx.chefPool, ['japanese']);
  const chefBids = target
    ? [{ chefId: target.id, amount: smartBidFor(target, ctx.budget, 0.25) }]
    : [];
  const sousChefCount = 4;
  return {
    adBids: { TV: 16500, Billboard: 10500, Radio: 6500, Newspaper: 3500 },
    chefBids,
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.4),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, ['matcha', 'croissant', 'bagel', 'cookie']),
    productPrices: defaultPrices(),
  };
}
japaneseStack.label = 'JapaneseStack';

// --- C. Italian stack (sandwich + coffee) ---
function italianStack(ctx) {
  const offered = ['sandwich', 'coffee', 'croissant', 'cookie'];
  const target = pickBestChefByNationality(ctx.chefPool, ['italian']);
  const chefBids = target
    ? [{ chefId: target.id, amount: smartBidFor(target, ctx.budget, 0.25) }]
    : [];
  const sousChefCount = 4;
  return {
    adBids: { TV: 16500, Billboard: 10500, Radio: 6500, Newspaper: 3500 },
    chefBids,
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.4),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, ['sandwich', 'coffee', 'croissant', 'cookie']),
    productPrices: defaultPrices(),
  };
}
italianStack.label = 'ItalianStack';

// --- D. American stack (bagel + cookie) ---
function americanStack(ctx) {
  const offered = ['bagel', 'cookie', 'croissant', 'coffee'];
  const target = pickBestChefByNationality(ctx.chefPool, ['american']);
  const chefBids = target
    ? [{ chefId: target.id, amount: smartBidFor(target, ctx.budget, 0.25) }]
    : [];
  const sousChefCount = 4;
  return {
    adBids: { TV: 16500, Billboard: 10500, Radio: 6500, Newspaper: 3500 },
    chefBids,
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.4),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, ['bagel', 'cookie', 'croissant', 'coffee']),
    productPrices: defaultPrices(),
  };
}
americanStack.label = 'AmericanStack';

// --- E. Premium-only menu (matcha + sandwich + croissant + coffee) ---
function premiumMenu(ctx) {
  const offered = ['matcha', 'sandwich', 'croissant', 'coffee'];
  const target = pickBestChefForProducts(ctx.chefPool, offered);
  const chefBids = target
    ? [{ chefId: target.id, amount: smartBidFor(target, ctx.budget, 0.25) }]
    : [];
  const sousChefCount = 4;
  return {
    adBids: { TV: 16500, Billboard: 10500, Radio: 6500, Newspaper: 3500 },
    chefBids,
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.4),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, offered),
    productPrices: defaultPrices(),
  };
}
premiumMenu.label = 'PremiumMenu';

// --- F. Floor pricing: stock everything at price floor for max demand mult ---
function floorPricing(ctx) {
  const offered = ['croissant', 'cookie', 'bagel', 'coffee', 'sandwich', 'matcha']; // all 6
  const sousChefCount = 4;
  return {
    adBids: { TV: 16500 },
    chefBids: [],
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.5),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, offered),
    productPrices: floorPrices(),
  };
}
floorPricing.label = 'FloorPricing';

// --- G. Ceiling pricing: max margin per unit ---
function ceilingPricing(ctx) {
  const offered = ['croissant', 'cookie', 'bagel'];
  const sousChefCount = 2;
  return {
    adBids: { TV: 16500 },
    chefBids: [],
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.3),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, offered),
    productPrices: ceilingPrices(),
  };
}
ceilingPricing.label = 'CeilingPricing';

// --- H. Ad spam: pour everything into ad bids, light operations ---
function adSpam(ctx) {
  const offered = ['croissant', 'cookie', 'bagel'];
  return {
    adBids: { TV: 49000, Billboard: 35000, Radio: 22000, Newspaper: 17000 },
    chefBids: [],
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.0),
    menu: menuFromList(offered),
    sousChefCount: 1,
    sousChefAssignments: distributeSous(1, offered),
    productPrices: defaultPrices(),
  };
}
adSpam.label = 'AdSpam';

// --- I. No-ad ghost: skip ads entirely, focus on chefs and stock ---
function noAdGhost(ctx) {
  const offered = ['croissant', 'cookie', 'bagel', 'coffee'];
  const target = pickBestChefForProducts(ctx.chefPool, offered);
  const chefBids = target
    ? [{ chefId: target.id, amount: smartBidFor(target, ctx.budget, 0.30) }]
    : [];
  const sousChefCount = 4;
  return {
    adBids: {},
    chefBids,
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.4),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, offered),
    productPrices: defaultPrices(),
  };
}
noAdGhost.label = 'NoAdGhost';

// --- J. Full menu, balanced (6 products, 4 sous, no chef bids, ad on Billboard) ---
function fullMenuBalanced(ctx) {
  const offered = ['croissant', 'cookie', 'bagel', 'coffee', 'sandwich', 'matcha'];
  const target = pickBestChefForProducts(ctx.chefPool, offered);
  const chefBids = target
    ? [{ chefId: target.id, amount: smartBidFor(target, ctx.budget, 0.20) }]
    : [];
  const sousChefCount = 4;
  return {
    adBids: { Billboard: 10500 },
    chefBids,
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.3),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, offered),
    productPrices: defaultPrices(),
  };
}
fullMenuBalanced.label = 'FullMenuBalanced';

// --- K. Cheap-loan abuse: borrow heavily R1 to stockpile chefs ---
function loanAbuser(ctx) {
  const offered = ['croissant', 'cookie', 'bagel', 'coffee'];
  // Aggressive on chefs round 1 even into red, then run cheap.
  let chefBids = [];
  if (ctx.round === 1 && ctx.specialtyChefs.length === 0) {
    const candidates = ctx.chefPool
      .filter((c) => c.skillTier === 'advanced' || c.skillTier === 'intermediate')
      .slice(0, 3);
    chefBids = candidates.map((c) => ({
      chefId: c.id,
      amount: smartBidFor(c, ctx.budget, 0.30),
    }));
  } else {
    const target = pickBestChefForProducts(ctx.chefPool, offered);
    if (target) chefBids = [{ chefId: target.id, amount: smartBidFor(target, ctx.budget, 0.20) }];
  }
  const sousChefCount = ctx.round >= 2 ? 4 : 2;
  return {
    adBids: ctx.round === 1 ? { Newspaper: 3500 } : { TV: 16500 },
    chefBids,
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.3),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, offered),
    productPrices: defaultPrices(),
  };
}
loanAbuser.label = 'LoanAbuser';

// --- L. Sous chef stacker: try max sous chefs (8+) ---
function sousChefStacker(ctx) {
  const offered = ['croissant', 'cookie', 'bagel', 'coffee'];
  const sousChefCount = 8;
  return {
    adBids: { TV: 16500 },
    chefBids: [],
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.5),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, offered),
    productPrices: defaultPrices(),
  };
}
sousChefStacker.label = 'SousChefStacker';

// --- M. Trend chaser: stock heavily on trending products only ---
function trendChaser(ctx) {
  const mods = ctx.roundPrefs.modifiers || {};
  // Pick top 3 products by modifier this round.
  const sorted = PRODUCT_KEYS
    .slice()
    .sort((a, b) => (mods[b] || 1.0) - (mods[a] || 1.0));
  const offered = sorted.slice(0, 3);
  // Also include base menu items if missing (croissant/cookie/bagel are always free to offer).
  for (const m of ['croissant', 'cookie', 'bagel']) {
    if (!offered.includes(m)) offered.push(m);
  }
  const target = pickBestChefForProducts(ctx.chefPool, offered);
  const chefBids = target
    ? [{ chefId: target.id, amount: smartBidFor(target, ctx.budget, 0.20) }]
    : [];
  const sousChefCount = 4;
  return {
    adBids: { TV: 16500 },
    chefBids,
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.5),
    menu: menuFromList(offered),
    sousChefCount,
    sousChefAssignments: distributeSous(sousChefCount, offered),
    productPrices: defaultPrices(),
  };
}
trendChaser.label = 'TrendChaser';

// --- N. Minimalist: base menu only, 0 sous chefs, no ads, lowest stock ---
function minimalist(ctx) {
  const offered = ['croissant', 'cookie', 'bagel'];
  return {
    adBids: {},
    chefBids: [],
    quantities: stockForOffered(offered, ctx.roundPrefs, 1.0),
    menu: menuFromList(offered),
    sousChefCount: 0,
    sousChefAssignments: {},
    productPrices: defaultPrices(),
  };
}
minimalist.label = 'Minimalist';

/**
 * ADVERSARIAL CEILING COUNTER — Strategy discovered by adversarial best-
 * response search. Bids high on all 4 ads to win cash bonuses + foot
 * traffic; uses ceiling pricing for max revenue per customer; skips sous
 * chefs entirely. Only profitable when opponents' ad bids are predictable.
 */
function adversarialCeilingCounter(ctx) {
  const offered = ['croissant', 'cookie', 'bagel'];
  // Try to find an American chef (their specialty matches offered products)
  const target = ctx.chefPool.find(c => c.nationality === 'american' && c.skillTier === 'advanced')
              || ctx.chefPool.find(c => c.nationality === 'american' && c.skillTier === 'intermediate')
              || ctx.chefPool.find(c => c.nationality === 'american');
  const chefBids = target && ctx.specialtyChefs.length < 3
    ? [{ chefId: target.id, amount: target.minBidFloor }]
    : [];
  const productPrices = {};
  for (const p of offered) productPrices[p] = PRICE_ZONES[p].ceiling;
  const quantities = stockForOffered(offered, ctx.roundPrefs, 1.4);
  return {
    adBids: { TV: 16500, Billboard: 10500, Radio: 6500, Newspaper: 3500 },
    chefBids,
    menu: menuFromList(offered),
    quantities,
    sousChefCount: 0,
    sousChefAssignments: {},
    productPrices,
  };
}
adversarialCeilingCounter.label = 'AdvCeilingCounter';

module.exports = {
  baseline,
  adversarialCeilingCounter,
  frenchStack,
  japaneseStack,
  italianStack,
  americanStack,
  premiumMenu,
  floorPricing,
  ceilingPricing,
  adSpam,
  noAdGhost,
  fullMenuBalanced,
  loanAbuser,
  sousChefStacker,
  trendChaser,
  minimalist,
};
