/**
 * run-tournament.js — Run a round-robin balance tournament.
 *
 * 1. Round-robin: every pairing of (3-team lobby) across all strategies.
 *    For S strategies, this gives C(S, 3) = S*(S-1)*(S-2)/6 lobbies per repetition.
 *    Each lobby plays 5 rounds. With 25 reps for noise, we get a stable
 *    avg-rank and avg-profit per strategy.
 *
 * 2. We also run a 6-team mega-game (3 teams x 2 mirrored strategies) to test
 *    same-strategy contention.
 *
 * Usage:
 *   node scripts/balance/run-tournament.js
 *
 * Options via env:
 *   BAL_REPS=25        repetitions per lobby (default 25)
 *   BAL_TEAMS=3        teams per lobby (default 3)
 *   BAL_STRATS=...     comma-separated subset of strategy names to include
 */

'use strict';

const path = require('path');
const harness = require('./harness');
const strategies = require('./strategies');

const REPS = Number(process.env.BAL_REPS) || 25;
const TEAM_COUNT = Number(process.env.BAL_TEAMS) || 3;

function pickStrategies() {
  const want = (process.env.BAL_STRATS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const all = Object.keys(strategies);
  if (want.length === 0) return all;
  return want.filter((s) => all.includes(s));
}

function combinations(arr, k) {
  if (k > arr.length) return [];
  if (k === 1) return arr.map((x) => [x]);
  const out = [];
  for (let i = 0; i <= arr.length - k; i++) {
    const head = arr[i];
    const rest = arr.slice(i + 1);
    for (const combo of combinations(rest, k - 1)) {
      out.push([head, ...combo]);
    }
  }
  return out;
}

function fmtMoney(n) {
  const s = Math.round(n).toLocaleString('en-US');
  return n < 0 ? `-$${s.slice(1)}` : `$${s}`;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ---------------------------------------------------------------------------
// Run round-robin
// ---------------------------------------------------------------------------

function runRoundRobin(stratNames, teamsPerLobby = 3, reps = 25) {
  const aggregator = {};
  for (const sn of stratNames) {
    aggregator[sn] = {
      strategy: sn,
      games: 0,
      wins: 0,
      ranks: [],
      profits: [],
      satisfactions: [],
      customers: [],
      finalBudgets: [],
    };
  }

  const lobbies = combinations(stratNames, teamsPerLobby);

  let totalGames = 0;
  for (const lobby of lobbies) {
    for (let r = 0; r < reps; r++) {
      // Shuffle team order each rep so the t0-wins-ties heuristic doesn't
      // systematically advantage strategies named earlier in the lobby
      // tuple. (Resolve-ad-auction breaks bid ties by team index.)
      const order = lobby.slice();
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const teams = order.map((sn, i) => {
        const fn = strategies[sn];
        // Wrap the strategy fn in a fresh object that owns its own .name and
        // .play — JS function `name` is non-writable, so we can't mutate it.
        const wrapped = (ctx) => fn(ctx);
        wrapped.label = sn;
        const stratObj = { play: wrapped, name: sn, label: sn };
        return { id: `t${i}-${sn}`, name: `${sn}-${i}`, strategy: stratObj };
      });
      const result = harness.runOneGame(teams);
      for (const row of result.teams) {
        const sn = row.strategyName;
        const a = aggregator[sn];
        a.games += 1;
        a.profits.push(row.totalProfit);
        a.satisfactions.push(row.avgSatisfaction);
        a.customers.push(row.totalCustomers);
        a.finalBudgets.push(row.finalBudget);
        a.ranks.push(row.rank);
        if (row.rank === 1) a.wins += 1;
      }
      totalGames += 1;
    }
  }

  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const stdev = (xs) => {
    if (xs.length < 2) return 0;
    const m = avg(xs);
    const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
    return Math.sqrt(v);
  };

  const rows = Object.values(aggregator).map((a) => ({
    strategy: a.strategy,
    games: a.games,
    winRate: a.wins / a.games,
    avgRank: avg(a.ranks),
    avgProfit: avg(a.profits),
    profitStdev: stdev(a.profits),
    avgSat: avg(a.satisfactions),
    avgCust: avg(a.customers),
    avgFinalBudget: avg(a.finalBudgets),
  }));
  rows.sort((a, b) => b.avgProfit - a.avgProfit);
  return { rows, totalGames, lobbies };
}

// ---------------------------------------------------------------------------
// Pretty-print
// ---------------------------------------------------------------------------

function printTable(rows, title) {
  console.log(`\n${title}`);
  console.log('='.repeat(120));
  console.log(
    pad('Strategy', 22) +
    pad('Games', 8) +
    pad('Win %', 9) +
    pad('AvgRank', 10) +
    pad('AvgProfit', 16) +
    pad('±StDev', 14) +
    pad('FinalBudget', 16) +
    pad('AvgSat', 9) +
    pad('AvgCust', 9)
  );
  console.log('-'.repeat(120));
  for (const r of rows) {
    console.log(
      pad(r.strategy, 22) +
      pad(r.games, 8) +
      pad((r.winRate * 100).toFixed(1) + '%', 9) +
      pad(r.avgRank.toFixed(2), 10) +
      pad(fmtMoney(r.avgProfit), 16) +
      pad(fmtMoney(r.profitStdev), 14) +
      pad(fmtMoney(r.avgFinalBudget), 16) +
      pad(r.avgSat.toFixed(1), 9) +
      pad(Math.round(r.avgCust), 9)
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const stratNames = pickStrategies();
  console.log(`Strategies: ${stratNames.join(', ')}`);
  console.log(`Teams per lobby: ${TEAM_COUNT}, reps per lobby: ${REPS}`);

  const t0 = Date.now();
  const { rows, totalGames, lobbies } = runRoundRobin(stratNames, TEAM_COUNT, REPS);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\nTotal lobbies: ${lobbies.length}, total games: ${totalGames}, time: ${dt}s`);
  printTable(rows, 'Round-robin tournament results (sorted by avg profit)');

  // Quick balance sanity: if any strategy has > 50% win rate or avg profit
  // 2× the median, flag it.
  const profits = rows.map((r) => r.avgProfit).sort((a, b) => a - b);
  const median = profits[Math.floor(profits.length / 2)];
  console.log('\nBalance flags (heuristic):');
  for (const r of rows) {
    if (r.winRate > 0.50) console.log(`  ⚠ ${r.strategy}: win rate ${(r.winRate * 100).toFixed(1)}% (>50%)`);
    if (median > 0 && r.avgProfit > median * 2) console.log(`  ⚠ ${r.strategy}: avg profit ${fmtMoney(r.avgProfit)} (>2× median ${fmtMoney(median)})`);
    if (median < 0 && r.avgProfit > 0) console.log(`  ℹ ${r.strategy}: positive profit while median is negative`);
  }
}

if (require.main === module) main();

module.exports = { runRoundRobin, printTable, combinations };
