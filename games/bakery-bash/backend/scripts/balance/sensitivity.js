/**
 * sensitivity.js — Parameter sensitivity sweeps.
 *
 * Tests how robust the balance is to small changes in key parameters.
 * If the balance is razor-thin (winner flips with 5% perturbation), that's
 * fragile. If balance holds across 50% perturbations, it's robust.
 *
 * For each parameter:
 *   1. Run the round-robin tournament at default value
 *   2. Run at -25% and +25%
 *   3. Compare nationality win-rates and profits
 *   4. Flag if the rank order changes drastically
 */

'use strict';

const path = require('path');
const harness = require('./harness');
const strategies = require('./strategies');
const cfgMod = require(path.join('..', '..', 'functions', 'modules', 'config'));

function fmt(n) {
  const s = Math.round(n).toLocaleString('en-US');
  return n < 0 ? `-$${s.slice(1)}` : `$${s}`;
}
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function runRoundRobin(cfgOverride, reps = 10) {
  const stratNames = ['frenchStack', 'japaneseStack', 'italianStack', 'americanStack',
    'premiumMenu', 'baseline', 'minimalist'];
  const aggregator = {};
  for (const sn of stratNames) {
    aggregator[sn] = { strategy: sn, games: 0, wins: 0, profits: [] };
  }
  // All 3-strategy lobbies
  const lobbies = [];
  for (let i = 0; i < stratNames.length; i++) {
    for (let j = i + 1; j < stratNames.length; j++) {
      for (let k = j + 1; k < stratNames.length; k++) {
        lobbies.push([stratNames[i], stratNames[j], stratNames[k]]);
      }
    }
  }
  for (const lobby of lobbies) {
    for (let r = 0; r < reps; r++) {
      // Shuffle order
      const order = [0, 1, 2];
      for (let x = order.length - 1; x > 0; x--) {
        const y = Math.floor(Math.random() * (x + 1));
        [order[x], order[y]] = [order[y], order[x]];
      }
      const teams = order.map((origIdx, i) => {
        const sn = lobby[origIdx];
        const fn = strategies[sn];
        return { id: 't' + i + '-' + sn, name: sn, strategy: { play: fn, name: sn, label: sn } };
      });
      const result = harness.runOneGame(teams, cfgOverride, r);
      for (let i = 0; i < teams.length; i++) {
        const sn = lobby[order[i]];
        const a = aggregator[sn];
        const row = result.teams.find((rr) => rr.teamId === teams[i].id);
        a.games += 1;
        a.profits.push(row.totalProfit);
        if (row.rank === 1) a.wins += 1;
      }
    }
  }
  const rows = Object.values(aggregator).map((a) => ({
    strategy: a.strategy,
    games: a.games,
    winRate: a.wins / a.games,
    avgProfit: a.profits.reduce((s, x) => s + x, 0) / Math.max(1, a.profits.length),
  }));
  rows.sort((a, b) => b.avgProfit - a.avgProfit);
  return rows;
}

function logRows(title, rows) {
  console.log('\n' + title);
  console.log('-'.repeat(70));
  console.log(pad('Strategy', 20) + pad('Win %', 10) + pad('AvgProfit', 16));
  for (const r of rows) {
    console.log(
      pad(r.strategy, 20) +
      pad((r.winRate * 100).toFixed(1) + '%', 10) +
      pad(fmt(r.avgProfit), 16)
    );
  }
}

function rankOrder(rows) {
  return rows.map((r) => r.strategy).join(' > ');
}

function compareToBaseline(baselineRows, perturbedRows, label) {
  const baselineOrder = rankOrder(baselineRows);
  const perturbedOrder = rankOrder(perturbedRows);
  const change = baselineOrder === perturbedOrder ? 'no change' : 'CHANGED';
  const baselineMap = Object.fromEntries(baselineRows.map((r) => [r.strategy, r.avgProfit]));
  let maxShift = 0;
  for (const r of perturbedRows) {
    const shift = Math.abs(r.avgProfit - baselineMap[r.strategy]);
    if (shift > maxShift) maxShift = shift;
  }
  console.log(`  Order: ${change}`);
  console.log(`  Max profit shift: ${fmt(maxShift)}`);
  if (change === 'CHANGED') {
    console.log(`    baseline: ${baselineOrder}`);
    console.log(`    perturbed: ${perturbedOrder}`);
  }
}

// ---------------------------------------------------------------------------

function sweep(paramPath, baseValue, perturbations) {
  console.log('\n\n═══════════════════════════════════════════════════════════════════════');
  console.log(`SWEEP: ${paramPath} (baseline ${baseValue})`);
  console.log('═══════════════════════════════════════════════════════════════════════');

  // Run at baseline
  console.log('\n[Baseline run]');
  const baselineRows = runRoundRobin({}, 10);
  logRows('Baseline', baselineRows);

  for (const factor of perturbations) {
    const newValue = baseValue * factor;
    console.log(`\n[Perturbation ${(factor * 100 - 100).toFixed(0)}% — ${paramPath}=${newValue}]`);
    const override = {};
    // Walk path: e.g. "revenueCoefficients.satisfactionCoeff"
    const parts = paramPath.split('.');
    let target = override;
    for (let i = 0; i < parts.length - 1; i++) {
      target[parts[i]] = target[parts[i]] || {};
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = newValue;
    const rows = runRoundRobin(override, 10);
    logRows(`Perturbed`, rows);
    compareToBaseline(baselineRows, rows, paramPath);
  }
}

// ---------------------------------------------------------------------------

const cfg = cfgMod.mergeConfig(cfgMod.DEFAULT_GAME_CONFIG);

sweep('sousChefBaseCost', cfg.sousChefBaseCost, [0.5, 0.75, 1.25, 1.5, 2]);
sweep('revenueCoefficients.satisfactionCoeff', cfg.revenueCoefficients.satisfactionCoeff, [0.5, 0.75, 1.25, 1.5]);
sweep('adBonuses.TV', cfg.adBonuses.TV, [0.5, 0.75, 1.25, 1.5]);
sweep('startingBudget', cfg.startingBudget, [0.5, 0.75, 1.25, 1.5]);
sweep('chefSatisfactionDecay', cfg.chefSatisfactionDecay, [0.5, 1.5]);

console.log('\n\n═══════════════════════════════════════════════════════════════════════');
console.log('SENSITIVITY SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('If "Order: no change" appears for most perturbations, balance is robust.');
console.log('If "Order: CHANGED" appears, the parameter is on a critical balance edge.');
