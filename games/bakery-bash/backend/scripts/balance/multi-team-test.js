/**
 * multi-team-test.js — Test balance with 2-team and 4-team configurations.
 */

'use strict';

const harness = require('./harness');
const strategies = require('./strategies');

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function fmt(n) {
  const s = Math.round(n).toLocaleString('en-US');
  return n < 0 ? `-$${s.slice(1)}` : `$${s}`;
}

function makeWrapped(sn) {
  const fn = strategies[sn];
  return { play: (ctx) => fn(ctx), name: sn, label: sn };
}

function runMatch(stratNames, reps = 50) {
  const wins = stratNames.map(() => 0);
  const profits = stratNames.map(() => []);
  for (let r = 0; r < reps; r++) {
    // Shuffle order per rep
    const order = stratNames.map((sn, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const teams = order.map((origIdx, i) => {
      const sn = stratNames[origIdx];
      return { id: 't' + i + '-' + sn, name: sn + i, strategy: makeWrapped(sn) };
    });
    const result = harness.runOneGame(teams, {}, r);
    for (let i = 0; i < teams.length; i++) {
      const row = result.teams.find((rr) => rr.teamId === teams[i].id);
      const origIdx = order[i];
      profits[origIdx].push(row.totalProfit);
      if (row.rank === 1) wins[origIdx] += 1;
    }
  }
  return stratNames.map((sn, i) => ({
    name: sn,
    avgProfit: Math.round(profits[i].reduce((s, x) => s + x, 0) / profits[i].length),
    winRate: wins[i] / reps,
  }));
}

function test2Team() {
  console.log('\n=== 2-team game: French vs American (50 reps) ===');
  const r1 = runMatch(['frenchStack', 'americanStack'], 50);
  for (const r of r1) {
    console.log(`  ${pad(r.name, 20)} winRate=${(r.winRate * 100).toFixed(1)}%  avgProfit=${fmt(r.avgProfit)}`);
  }
  console.log('\n=== 2-team game: French vs Premium (50 reps) ===');
  const r2 = runMatch(['frenchStack', 'premiumMenu'], 50);
  for (const r of r2) {
    console.log(`  ${pad(r.name, 20)} winRate=${(r.winRate * 100).toFixed(1)}%  avgProfit=${fmt(r.avgProfit)}`);
  }
}

function test4Team() {
  console.log('\n=== 4-team game: 4 nationalities (50 reps) ===');
  const r1 = runMatch(['frenchStack', 'japaneseStack', 'italianStack', 'americanStack'], 50);
  for (const r of r1) {
    console.log(`  ${pad(r.name, 20)} winRate=${(r.winRate * 100).toFixed(1)}%  avgProfit=${fmt(r.avgProfit)}`);
  }

  console.log('\n=== 4-team game: 2 ad spammers, 2 baselines ===');
  const r2 = runMatch(['adSpam', 'adSpam', 'baseline', 'baseline'], 50);
  for (const r of r2) {
    console.log(`  ${pad(r.name, 20)} winRate=${(r.winRate * 100).toFixed(1)}%  avgProfit=${fmt(r.avgProfit)}`);
  }

  console.log('\n=== 4-team game: 2 premium, 2 french ===');
  const r3 = runMatch(['premiumMenu', 'premiumMenu', 'frenchStack', 'frenchStack'], 50);
  for (const r of r3) {
    console.log(`  ${pad(r.name, 20)} winRate=${(r.winRate * 100).toFixed(1)}%  avgProfit=${fmt(r.avgProfit)}`);
  }
}

function test6Team() {
  console.log('\n=== 6-team game: all 4 nationalities + premium + baseline (50 reps) ===');
  const r = runMatch(['frenchStack', 'japaneseStack', 'italianStack', 'americanStack', 'premiumMenu', 'baseline'], 50);
  for (const row of r) {
    console.log(`  ${pad(row.name, 20)} winRate=${(row.winRate * 100).toFixed(1)}%  avgProfit=${fmt(row.avgProfit)}`);
  }
}

test2Team();
test4Team();
test6Team();
