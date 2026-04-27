/**
 * probes-deep.js — Deeper balance probes targeting specific theories.
 */

'use strict';

const path = require('path');
const harness = require('./harness');
const strategies = require('./strategies');
const cfgMod = require(path.join('..', '..', 'functions', 'modules', 'config'));
const cfg = cfgMod.mergeConfig(cfgMod.DEFAULT_GAME_CONFIG);

// Helper: ad bid as fraction of bonus (so probes stay sensible across rebalances).
const adBidAt = (type, frac = 0.825) => Math.round((cfg.adBonuses[type] || 0) * frac);

function fmt(n) {
  if (typeof n !== 'number') return String(n);
  const s = Math.round(n).toLocaleString('en-US');
  return n < 0 ? `-$${s.slice(1)}` : `$${s}`;
}

function pct(n) { return (n * 100).toFixed(1) + '%'; }
function avg(xs) { return xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length); }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function makeTeam(id, sn, fn) {
  const f = fn || strategies[sn];
  const wrapped = (ctx) => f(ctx);
  return { id, name: `${sn}-${id}`, strategy: { play: wrapped, name: sn, label: sn } };
}

function runMatch(setup, reps = 50, cfgOverride = {}) {
  // setup is array of { name, fn } or string strategy names.
  const wins = setup.map(() => 0);
  const profits = setup.map(() => []);
  for (let r = 0; r < reps; r++) {
    const teams = setup.map((s, i) => {
      const sn = typeof s === 'string' ? s : s.name;
      const fn = typeof s === 'string' ? strategies[s] : s.fn;
      return makeTeam(`t${i}-${sn}`, sn, fn);
    });
    const result = harness.runOneGame(teams, cfgOverride, r);
    for (let i = 0; i < teams.length; i++) {
      const row = result.teams.find((rr) => rr.teamId === teams[i].id);
      profits[i].push(row.totalProfit);
      if (row.rank === 1) wins[i] += 1;
    }
  }
  return setup.map((s, i) => ({
    name: typeof s === 'string' ? s : s.name,
    winRate: wins[i] / reps,
    avgProfit: Math.round(avg(profits[i])),
  }));
}

function logRows(title, rows) {
  console.log(`\n=== ${title} ===`);
  for (const r of rows) {
    console.log(`  ${pad(r.name, 22)} winRate=${pct(r.winRate)} avgProfit=${fmt(r.avgProfit)}`);
  }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

// What if NO team bids on ads at all? Can a player turn a profit by playing well?
function noAdsAcrossBoard() {
  const noAd = (orig) => (ctx) => {
    const m = orig(ctx);
    return { ...m, adBids: {} };
  };

  const setup = [
    { name: 'french-noad',     fn: noAd(strategies.frenchStack) },
    { name: 'japanese-noad',   fn: noAd(strategies.japaneseStack) },
    { name: 'minimal-noad',    fn: noAd(strategies.minimalist) },
  ];
  logRows('Engaged play with NO ads (everyone), 3 strategies', runMatch(setup, 50));

  const setup2 = [
    { name: 'fullmenu-noad',   fn: noAd(strategies.fullMenuBalanced) },
    { name: 'baseline-noad',   fn: noAd(strategies.baseline) },
    { name: 'minimal-noad',    fn: noAd(strategies.minimalist) },
  ];
  logRows('Full menu vs Baseline vs Minimalist with NO ads', runMatch(setup2, 50));
}

// What if teams ONLY bid the minimum on chef floor (cheap chef)?
function cheapChefOnly() {
  const cheapChef = (offered, sousChefCount) => (ctx) => {
    // pick cheapest chef in pool
    let cheapest = ctx.chefPool[0];
    for (const c of ctx.chefPool) {
      if (c.minBidFloor < cheapest.minBidFloor) cheapest = c;
    }
    const chefBids = ctx.specialtyChefs.length < 3 && cheapest
      ? [{ chefId: cheapest.id, amount: cheapest.minBidFloor }]
      : [];
    const out = strategies.baseline(ctx);
    return {
      ...out,
      chefBids,
      sousChefCount,
      menu: { croissant: true, cookie: true, bagel: true, coffee: true, sandwich: true, matcha: true },
      quantities: out.quantities,
      sousChefAssignments: { croissant: 1, cookie: 1, bagel: 1, coffee: 1 },
    };
  };

  const setup = [
    { name: 'CheapChef+4Sous',  fn: cheapChef(['croissant', 'cookie', 'bagel', 'coffee'], 4) },
    { name: 'CheapChef+0Sous',  fn: cheapChef(['croissant', 'cookie', 'bagel', 'coffee'], 0) },
    { name: 'Baseline',         fn: strategies.baseline },
  ];
  logRows('Cheap chef strategies (3-team)', runMatch(setup, 50));
}

// Foot traffic max — can we exploit the +92% modifier?
function footTrafficMax() {
  // 6 products + 5 sous + premium croissant+matcha at excellent
  const ftMax = (ctx) => {
    const offered = ['coffee', 'croissant', 'bagel', 'cookie', 'sandwich', 'matcha'];
    const target = ctx.chefPool.find((c) => c.specialties.includes('matcha') || c.specialties.includes('croissant'));
    const chefBids = target && ctx.specialtyChefs.length < 3
      ? [{ chefId: target.id, amount: target.minBidFloor }]
      : [];
    const baseDemand = { coffee: 70, croissant: 60, bagel: 55, cookie: 50, sandwich: 45, matcha: 25 };
    const qts = {};
    for (const p of offered) qts[p] = Math.round(baseDemand[p] * 1.5);
    return {
      adBids: { TV: adBidAt('TV') },
      chefBids,
      menu: { coffee: true, croissant: true, bagel: true, cookie: true, sandwich: true, matcha: true },
      quantities: qts,
      sousChefCount: 5,
      sousChefAssignments: { coffee: 1, croissant: 1, bagel: 1, cookie: 1, matcha: 1 },
      productPrices: {},
    };
  };
  const setup = [
    { name: 'FtMax', fn: ftMax },
    { name: 'Baseline', fn: strategies.baseline },
    { name: 'Minimal', fn: strategies.minimalist },
  ];
  logRows('Foot traffic maxer (6 products, 5 sous, croissant+matcha)', runMatch(setup, 50));
}

// All same strategy — fair contention test
function allSame(stratName) {
  const setup = [stratName, stratName, stratName];
  logRows(`Mirror match: ${stratName} × 3`, runMatch(setup, 50));
}

// Team size scaling — 2 teams vs 6 teams
function teamCountScaling() {
  const setup2 = ['baseline', 'baseline'];
  logRows('2-team baseline mirror', runMatch(setup2, 50));

  // 6 teams need a 6-team harness. Skip for now — just note.
}

// Scaling chef bid — does buying intermediate vs advanced matter?
function chefTierComparison() {
  const buyTier = (tier) => (ctx) => {
    const target = ctx.chefPool.find((c) => c.skillTier === tier);
    const chefBids = target && ctx.specialtyChefs.length < 3
      ? [{ chefId: target.id, amount: target.minBidFloor }]
      : [];
    const out = strategies.baseline(ctx);
    return {
      ...out,
      chefBids,
      menu: { croissant: true, cookie: true, bagel: true, coffee: true },
      sousChefCount: 4,
      sousChefAssignments: { croissant: 2, cookie: 1, bagel: 1 },
      adBids: { TV: adBidAt('TV') },
      quantities: { croissant: 90, cookie: 70, bagel: 80, coffee: 100 },
    };
  };
  const setup = [
    { name: 'BuyAdvanced',     fn: buyTier('advanced') },
    { name: 'BuyIntermediate', fn: buyTier('intermediate') },
    { name: 'BuyNovel',        fn: buyTier('novel') },
  ];
  logRows('Chef tier comparison: advanced vs intermediate vs novel', runMatch(setup, 50));
}

// ---------------------------------------------------------------------------

function main() {
  noAdsAcrossBoard();
  cheapChefOnly();
  footTrafficMax();
  allSame('baseline');
  allSame('minimalist');
  teamCountScaling();
  chefTierComparison();
}

if (require.main === module) main();
