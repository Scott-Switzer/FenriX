/**
 * probes.js — Targeted balance probes.
 *
 * Each probe answers a specific question (e.g. "does ad arbitrage pay?").
 * Run all probes:    node scripts/balance/probes.js
 * Run one probe:     node scripts/balance/probes.js <name>
 */

'use strict';

const harness = require('./harness');
const strategies = require('./strategies');
const path = require('path');
const config = require(path.join('..', '..', 'functions', 'modules', 'config'));

const { PRODUCT_KEYS, PRODUCT_CATALOG, DEFAULT_GAME_CONFIG } = config;

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function fmt(n) {
  if (typeof n !== 'number') return String(n);
  const s = Math.round(n).toLocaleString('en-US');
  return n < 0 ? `-$${s.slice(1)}` : `$${s}`;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function makeTeam(id, sn) {
  const fn = strategies[sn];
  const wrapped = (ctx) => fn(ctx);
  return { id, name: `${sn}-${id}`, strategy: { play: wrapped, name: sn, label: sn } };
}

function avg(xs) { return xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length); }
function pct(n) { return (n * 100).toFixed(1) + '%'; }

function runMatch(stratNames, reps = 100, cfgOverride = {}) {
  const wins = stratNames.map(() => 0);
  const profits = stratNames.map(() => []);
  for (let r = 0; r < reps; r++) {
    const teams = stratNames.map((sn, i) => makeTeam(`t${i}`, sn));
    const result = harness.runOneGame(teams, cfgOverride, r);
    for (const row of result.teams) {
      const idx = teams.findIndex((t) => t.id === row.teamId);
      profits[idx].push(row.totalProfit);
      if (row.rank === 1) wins[idx] += 1;
    }
  }
  const out = stratNames.map((sn, i) => ({
    strategy: sn,
    winRate: wins[i] / reps,
    avgProfit: Math.round(avg(profits[i])),
    sample: profits[i].slice(0, 3),
  }));
  return out;
}

function logProbe(title, rows) {
  console.log(`\n=== ${title} ===`);
  for (const r of rows) {
    console.log(`  ${pad(r.strategy, 20)} winRate=${pct(r.winRate)} avgProfit=${fmt(r.avgProfit)}`);
  }
}

// ----------------------------------------------------------------------
// Probes
// ----------------------------------------------------------------------

const probes = {};

// Probe 1: AdSpam mirror — what happens when 3 teams all spam ads?
probes.adSpamMirror = () => {
  const rows = runMatch(['adSpam', 'adSpam', 'adSpam'], 50);
  logProbe('AdSpam vs AdSpam vs AdSpam (3 teams all spam ads)', rows);
};

// Probe 2: AdSpam vs Baseline vs Baseline — does AdSpam still win when 1v2?
probes.adSpamVsBaselines = () => {
  const rows = runMatch(['adSpam', 'baseline', 'baseline'], 50);
  logProbe('AdSpam vs Baseline vs Baseline', rows);
};

// Probe 3: Nationality dominance — does any single nationality win >50%?
probes.nationalityShowdown = () => {
  const rows = runMatch(['frenchStack', 'japaneseStack', 'italianStack'], 50);
  logProbe('French vs Japanese vs Italian', rows);
  const rows2 = runMatch(['frenchStack', 'americanStack', 'italianStack'], 50);
  logProbe('French vs American vs Italian', rows2);
};

// Probe 4: Pricing strategies head-to-head
probes.pricingShowdown = () => {
  const rows = runMatch(['floorPricing', 'ceilingPricing', 'baseline'], 50);
  logProbe('Floor vs Ceiling vs Default Pricing', rows);
};

// Probe 5: Sous chef sweet spot — 0 vs 4 vs 8
probes.sousChefSweetSpot = () => {
  // Quick custom strategies inline.
  const make = (count) => {
    const fn = (ctx) => {
      const offered = ['croissant', 'cookie', 'bagel', 'coffee'];
      const out = strategies.baseline(ctx);
      out.sousChefCount = count;
      out.sousChefAssignments = {};
      const offeredOK = offered.length;
      for (let i = 0; i < count; i++) {
        const p = offered[i % offeredOK];
        out.sousChefAssignments[p] = (out.sousChefAssignments[p] || 0) + 1;
      }
      out.menu = {};
      for (const p of PRODUCT_KEYS) out.menu[p] = offered.includes(p);
      return out;
    };
    return fn;
  };
  const orig = { ...strategies };
  strategies.sous0 = make(0);
  strategies.sous2 = make(2);
  strategies.sous4 = make(4);
  strategies.sous6 = make(6);
  strategies.sous8 = make(8);

  const rows = runMatch(['sous0', 'sous4', 'sous8'], 50);
  logProbe('0 vs 4 vs 8 sous chefs', rows);
  const rows2 = runMatch(['sous2', 'sous4', 'sous6'], 50);
  logProbe('2 vs 4 vs 6 sous chefs', rows2);

  Object.assign(strategies, orig);
};

// Probe 6: Ad bid arbitrage — does spending more on ads always pay back?
probes.adBidArbitrage = () => {
  const make = (bid) => {
    const fn = (ctx) => {
      const out = strategies.baseline(ctx);
      out.adBids = { TV: bid };
      return out;
    };
    return fn;
  };
  strategies.ad0    = make(0);
  strategies.ad10k  = make(10000);
  strategies.ad30k  = make(30000);
  strategies.ad49k  = make(49000);
  // Triple-mirror 49k vs 49k vs 49k — only one wins, but all bid.
  const rows = runMatch(['ad0', 'ad10k', 'ad30k'], 50);
  logProbe('Ad bid scaling: $0 vs $10k vs $30k', rows);
  const rows2 = runMatch(['ad0', 'ad49k', 'ad49k'], 50);
  logProbe('Ad mirror: $0 vs $49k vs $49k (only one wins)', rows2);
};

// Probe 7: Chef-buying ROI — Spend $X on chef vs not
probes.chefRoi = () => {
  const buyChef = (ctx) => {
    const out = strategies.baseline(ctx);
    const chef = ctx.chefPool.find((c) => c.skillTier === 'advanced');
    if (chef && ctx.specialtyChefs.length < 3) {
      out.chefBids = [{ chefId: chef.id, amount: chef.minBidFloor }];
    }
    out.sousChefCount = 4;
    out.sousChefAssignments = { croissant: 2, cookie: 1, bagel: 1 };
    out.menu = { croissant: true, cookie: true, bagel: true, coffee: true };
    return out;
  };
  const noChef = (ctx) => {
    const out = strategies.baseline(ctx);
    out.sousChefCount = 4;
    out.sousChefAssignments = { croissant: 2, cookie: 1, bagel: 1 };
    out.menu = { croissant: true, cookie: true, bagel: true, coffee: true };
    return out;
  };
  strategies.buyChef = buyChef;
  strategies.noChef  = noChef;

  const rows = runMatch(['buyChef', 'noChef', 'baseline'], 100);
  logProbe('BuyAdvancedChef vs NoChef vs Baseline (3-team)', rows);
};

// Probe 8: Customer pool sanity check — total pool size per round
probes.customerPoolSanity = () => {
  console.log('\n=== Total customer pool by round ===');
  for (let r = 1; r <= 5; r++) {
    const prefs = harness.ROUND_PREFERENCES[r - 1];
    let total = 0;
    for (const p of PRODUCT_KEYS) {
      total += PRODUCT_CATALOG[p].baseDemand * (prefs.modifiers[p] || 1.0);
    }
    console.log(`  R${r}: ${Math.round(total)} customers (modifiers: ${JSON.stringify(prefs.modifiers)})`);
  }
};

// Probe 9: Per-round revenue breakdown for adSpam (1 team game)
probes.adSpamBreakdown = () => {
  const teams = [makeTeam('t0', 'adSpam'), makeTeam('t1', 'baseline'), makeTeam('t2', 'baseline')];
  const result = harness.runOneGame(teams, {}, 0);
  console.log('\n=== AdSpam single-game breakdown ===');
  for (const t of result.teams) {
    console.log(`${t.strategyName}:`);
    t.profitByRound.forEach((p, i) => {
      console.log(`  R${i + 1}: profit=${fmt(p)} revNet=${fmt(t.revenueByRound[i])} cust=${t.customersByRound[i]} sat=${t.satisfactionByRound[i].toFixed(1)} adWins=${t.adWinsByRound[i].join(',') || '-'}`);
    });
    console.log(`  Final budget: ${fmt(t.finalBudget)} (profit ${fmt(t.totalProfit)})`);
  }
};

// Probe 10: Loan abuse — borrow heavily R1 → does it pay?
probes.loanAbuse = () => {
  const rows = runMatch(['loanAbuser', 'baseline', 'baseline'], 50);
  logProbe('LoanAbuser vs Baseline vs Baseline', rows);
};

// ----------------------------------------------------------------------
// Run
// ----------------------------------------------------------------------

function main() {
  const which = process.argv[2];
  if (which) {
    if (!probes[which]) { console.error(`No probe '${which}'. Available: ${Object.keys(probes).join(', ')}`); process.exit(2); }
    probes[which]();
    return;
  }
  for (const name of Object.keys(probes)) {
    probes[name]();
  }
}

if (require.main === module) main();

module.exports = { probes, runMatch, makeTeam };
