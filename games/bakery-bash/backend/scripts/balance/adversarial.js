/**
 * adversarial.js — Best-response search.
 *
 * Given two opponents using a known strategy, search the space of moves
 * for a single team to find the move that MAXIMIZES profit. This finds
 * dominant strategies that human strategy designers might not invent.
 *
 * Search space (per move):
 *   - menu: subset of 6 products → 64 combinations, but we restrict to 1-6 products → 63
 *   - sousChefCount: 0-8
 *   - chef purchase: best-available chef of each nationality, plus "skip"
 *   - ad bids: combinations of {0, $1k, $5k, $10k, $20k, $40k} for each of 4 ads
 *   - product prices: floor / competitive-mid / ceiling
 *
 * Full enumeration is intractable. Use a 2-stage greedy/grid search:
 *   Stage 1: pick best menu (with default sous, ads, prices)
 *   Stage 2: pick best sous count for that menu
 *   Stage 3: pick best ad bid combination
 *   Stage 4: pick best chef target
 *   Stage 5: pick best price tier
 *
 * Run several thousand games per candidate to average out RNG.
 *
 * If the best-response profit substantially exceeds the typical
 * tournament-strategy profit, we've found a new dominant strategy.
 */

'use strict';

const path = require('path');
const harness = require('./harness');
const strategies = require('./strategies');
const cfgMod = require(path.join('..', '..', 'functions', 'modules', 'config'));

const cfg = cfgMod.mergeConfig(cfgMod.DEFAULT_GAME_CONFIG);
const { PRODUCT_KEYS, PRODUCT_CATALOG, PRICE_ZONES } = cfgMod;

function fmt(n) {
  const s = Math.round(n).toLocaleString('en-US');
  return n < 0 ? `-$${s.slice(1)}` : `$${s}`;
}
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

// ---------------------------------------------------------------------------
// Move space
// ---------------------------------------------------------------------------

// Menu: pick subset of products. Generate all 63 non-empty subsets.
function generateMenuOptions() {
  const opts = [];
  for (let mask = 1; mask < 64; mask++) {
    const offered = [];
    for (let bit = 0; bit < 6; bit++) {
      if (mask & (1 << bit)) offered.push(PRODUCT_KEYS[bit]);
    }
    opts.push(offered);
  }
  return opts;
}

// Test only meaningful menus (1, 3, 4, 5, 6 products) to reduce search time
function generateMenuOptionsFiltered() {
  const all = generateMenuOptions();
  return all.filter((m) => m.length >= 3 && m.length <= 6);
}

const SOUS_OPTIONS = [0, 2, 3, 4, 5, 6, 8];

const AD_BID_LEVELS = {
  // Updated post-balance pass 14: minimums = bonus values (20k/12.5k/7.5k/4k).
  // Below-min bids auto-dropped. Bids = bonus give zero cash margin.
  // Bidding above bonus is intentional over-bidding (you'd lose money on cash
  // but gain foot traffic) — included so the search can discover that
  // strategy if it dominates.
  TV:        [0, 20000, 25000, 35000, 50000],
  Billboard: [0, 12500, 16000, 22000, 35000],
  Radio:     [0, 7500, 10000, 15000],
  Newspaper: [0, 4000, 6000, 8000],
};

// Smart-bid for chef: floor of nation-best chef, or 0 (no purchase).
const CHEF_TARGETS = ['none', 'french-best', 'japanese-best', 'italian-best', 'american-best'];

const PRICE_TIERS = ['catalog', 'floor', 'competitiveMid', 'ceiling'];

// ---------------------------------------------------------------------------
// Move builder
// ---------------------------------------------------------------------------

function buildStrategy({ offered, sousCount, adBids, chefTarget, priceTier }) {
  return (ctx) => {
    // Quantities: stock at baseDemand × roundModifier × 1.4
    const quantities = {};
    const menu = {};
    for (const p of PRODUCT_KEYS) {
      if (offered.includes(p)) {
        menu[p] = true;
        const base = PRODUCT_CATALOG[p].baseDemand;
        const mod = ctx.roundPrefs.modifiers[p] || 1.0;
        quantities[p] = Math.round(base * mod * 1.4);
      } else {
        menu[p] = false;
        quantities[p] = 0;
      }
    }
    // Sous distribution: round-robin across offered
    const sousAssign = {};
    for (let i = 0; i < sousCount; i++) {
      const p = offered[i % offered.length];
      sousAssign[p] = (sousAssign[p] || 0) + 1;
    }
    // Chef
    let chefBids = [];
    if (chefTarget !== 'none' && ctx.specialtyChefs.length < 3) {
      const nat = chefTarget.split('-')[0];
      const skillRank = { advanced: 3, intermediate: 2, novel: 1 };
      let best = null;
      for (const c of ctx.chefPool) {
        if (c.nationality !== nat) continue;
        if (!best || skillRank[c.skillTier] > skillRank[best.skillTier]) best = c;
      }
      if (best) chefBids = [{ chefId: best.id, amount: best.minBidFloor }];
    }
    // Prices
    const productPrices = {};
    for (const p of offered) {
      const z = PRICE_ZONES[p];
      if (!z) continue;
      if (priceTier === 'floor') productPrices[p] = z.floor;
      else if (priceTier === 'ceiling') productPrices[p] = z.ceiling;
      else if (priceTier === 'competitiveMid') productPrices[p] = (z.competitiveRangeLow + z.competitiveRangeHigh) / 2;
      else productPrices[p] = PRODUCT_CATALOG[p].fixedPrice;
    }
    return {
      adBids,
      chefBids,
      quantities,
      menu,
      sousChefCount: sousCount,
      sousChefAssignments: sousAssign,
      productPrices,
    };
  };
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

function evaluate(candidateFn, opponentName, reps = 30) {
  const oppFn = strategies[opponentName];
  let totalProfit = 0;
  let wins = 0;
  for (let r = 0; r < reps; r++) {
    const teams = [
      { id: 't0', name: 'candidate', strategy: { play: candidateFn, name: 'candidate', label: 'candidate' } },
      { id: 't1', name: 'opp1', strategy: { play: oppFn, name: opponentName, label: opponentName } },
      { id: 't2', name: 'opp2', strategy: { play: oppFn, name: opponentName, label: opponentName } },
    ];
    const result = harness.runOneGame(teams, {}, r);
    const me = result.teams.find((rr) => rr.teamId === 't0');
    totalProfit += me.totalProfit;
    if (me.rank === 1) wins++;
  }
  return { avgProfit: totalProfit / reps, winRate: wins / reps };
}

// ---------------------------------------------------------------------------
// Greedy search
// ---------------------------------------------------------------------------

async function searchBestResponse(opponentName) {
  console.log(`\n>>> Best-response vs ${opponentName} <<<`);

  // Defaults
  let bestMenu = ['croissant', 'cookie', 'bagel', 'coffee'];
  let bestSous = 4;
  let bestAds = { TV: 8000 };
  let bestChef = 'french-best';
  let bestPrice = 'catalog';

  const fixedDefault = () => buildStrategy({
    offered: bestMenu, sousCount: bestSous, adBids: bestAds, chefTarget: bestChef, priceTier: bestPrice
  });
  let best = evaluate(fixedDefault(), opponentName, 30);
  console.log(`  Initial: profit=${fmt(best.avgProfit)} winRate=${(best.winRate * 100).toFixed(0)}%`);

  // Stage 1: best menu
  for (const m of generateMenuOptionsFiltered()) {
    const fn = buildStrategy({
      offered: m, sousCount: bestSous, adBids: bestAds, chefTarget: bestChef, priceTier: bestPrice
    });
    const r = evaluate(fn, opponentName, 20);
    if (r.avgProfit > best.avgProfit) {
      best = r; bestMenu = m;
    }
  }
  console.log(`  Best menu (${bestMenu.length} prods, ${bestMenu.join('+')}): profit=${fmt(best.avgProfit)}`);

  // Stage 2: best sous count
  for (const s of SOUS_OPTIONS) {
    const fn = buildStrategy({
      offered: bestMenu, sousCount: s, adBids: bestAds, chefTarget: bestChef, priceTier: bestPrice
    });
    const r = evaluate(fn, opponentName, 30);
    if (r.avgProfit > best.avgProfit) {
      best = r; bestSous = s;
    }
  }
  console.log(`  Best sous=${bestSous}: profit=${fmt(best.avgProfit)}`);

  // Stage 3: best ad bid combo
  for (const tv of AD_BID_LEVELS.TV) {
    for (const bb of AD_BID_LEVELS.Billboard) {
      for (const ra of AD_BID_LEVELS.Radio) {
        for (const np of AD_BID_LEVELS.Newspaper) {
          const ad = {};
          if (tv > 0) ad.TV = tv;
          if (bb > 0) ad.Billboard = bb;
          if (ra > 0) ad.Radio = ra;
          if (np > 0) ad.Newspaper = np;
          const fn = buildStrategy({
            offered: bestMenu, sousCount: bestSous, adBids: ad, chefTarget: bestChef, priceTier: bestPrice
          });
          const r = evaluate(fn, opponentName, 15);
          if (r.avgProfit > best.avgProfit) {
            best = r; bestAds = ad;
          }
        }
      }
    }
  }
  console.log(`  Best ads ${JSON.stringify(bestAds)}: profit=${fmt(best.avgProfit)}`);

  // Stage 4: best chef target
  for (const ct of CHEF_TARGETS) {
    const fn = buildStrategy({
      offered: bestMenu, sousCount: bestSous, adBids: bestAds, chefTarget: ct, priceTier: bestPrice
    });
    const r = evaluate(fn, opponentName, 30);
    if (r.avgProfit > best.avgProfit) {
      best = r; bestChef = ct;
    }
  }
  console.log(`  Best chef=${bestChef}: profit=${fmt(best.avgProfit)}`);

  // Stage 5: best price tier
  for (const pt of PRICE_TIERS) {
    const fn = buildStrategy({
      offered: bestMenu, sousCount: bestSous, adBids: bestAds, chefTarget: bestChef, priceTier: pt
    });
    const r = evaluate(fn, opponentName, 30);
    if (r.avgProfit > best.avgProfit) {
      best = r; bestPrice = pt;
    }
  }
  console.log(`  Best price=${bestPrice}: profit=${fmt(best.avgProfit)} winRate=${(best.winRate * 100).toFixed(0)}%`);

  return {
    opponent: opponentName,
    bestProfit: best.avgProfit,
    bestWinRate: best.winRate,
    config: { menu: bestMenu, sous: bestSous, ads: bestAds, chef: bestChef, price: bestPrice },
  };
}

async function main() {
  const opponents = ['frenchStack', 'japaneseStack', 'italianStack', 'americanStack',
                     'baseline', 'minimalist', 'premiumMenu'];

  const results = [];
  for (const opp of opponents) {
    const r = await searchBestResponse(opp);
    results.push(r);
  }

  console.log('\n\n═══════════════════════════════════════════════════════════════════════');
  console.log('BEST-RESPONSE SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(pad('Opponent (×2)', 20) + pad('Best counter profit', 22) + pad('WinRate', 10) + 'Config');
  console.log('-'.repeat(110));
  for (const r of results) {
    console.log(
      pad(r.opponent, 20) +
      pad(fmt(r.bestProfit), 22) +
      pad((r.bestWinRate * 100).toFixed(0) + '%', 10) +
      `menu=${r.config.menu.length}p sous=${r.config.sous} chef=${r.config.chef} price=${r.config.price}`
    );
  }

  // Flag: if any best-response profit exceeds $50k, that's a new dominant strategy
  console.log('\nAlert: best-response profits exceeding $50k indicate new dominant strategy candidates:');
  for (const r of results) {
    if (r.bestProfit > 50000) {
      console.log(`  ⚠ vs ${r.opponent}: best response profits $${Math.round(r.bestProfit / 1000)}k`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
