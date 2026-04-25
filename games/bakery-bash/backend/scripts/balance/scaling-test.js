/**
 * scaling-test.js — Test balance at 2/3/4/5/6/8 teams.
 *
 * The customer pool is fixed (~1320/round). More teams means smaller share
 * per team. Tests whether all-nationality match-ups remain balanced as team
 * count varies.
 */

'use strict';

const harness = require('./harness');
const strategies = require('./strategies');

function fmt(n) {
  const s = Math.round(n).toLocaleString('en-US');
  return n < 0 ? `-$${s.slice(1)}` : `$${s}`;
}
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function pct(x) { return (x * 100).toFixed(1) + '%'; }

function makeWrapped(sn) {
  const fn = strategies[sn];
  return { play: fn, name: sn, label: sn };
}

function runMatch(stratNames, reps = 100) {
  const profits = stratNames.map(() => []);
  const wins = stratNames.map(() => 0);
  const ranks = stratNames.map(() => []);
  for (let r = 0; r < reps; r++) {
    // Shuffle order per rep
    const order = stratNames.map((_, i) => i);
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
      const origIdx = order[i];
      const row = result.teams.find((rr) => rr.teamId === teams[i].id);
      profits[origIdx].push(row.totalProfit);
      ranks[origIdx].push(row.rank);
      if (row.rank === 1) wins[origIdx] += 1;
    }
  }
  return stratNames.map((sn, i) => ({
    name: sn,
    avgProfit: profits[i].reduce((s, x) => s + x, 0) / profits[i].length,
    winRate: wins[i] / reps,
    avgRank: ranks[i].reduce((s, x) => s + x, 0) / ranks[i].length,
  }));
}

function logResults(label, rows) {
  console.log('\n' + label);
  console.log('-'.repeat(70));
  console.log(pad('Strategy', 22) + pad('AvgRank', 10) + pad('Win %', 9) + pad('AvgProfit', 14));
  // Sort by avgProfit desc
  const sorted = rows.slice().sort((a, b) => b.avgProfit - a.avgProfit);
  for (const r of sorted) {
    console.log(
      pad(r.name, 22) +
      pad(r.avgRank.toFixed(2), 10) +
      pad(pct(r.winRate), 9) +
      pad(fmt(r.avgProfit), 14)
    );
  }
}

function spread(rows) {
  const profits = rows.map(r => r.avgProfit);
  const max = Math.max(...profits);
  const min = Math.min(...profits);
  return { range: max - min, max, min, ratio: max / Math.max(1, Math.abs(min)) };
}

// ---------------------------------------------------------------------------
// Run scaling tests
// ---------------------------------------------------------------------------

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('SCALING TEST: 4 nationalities at varying team counts');
console.log('═══════════════════════════════════════════════════════════════════════');

// 2 teams: pick 2 nationalities at a time
console.log('\n--- 2 teams ---');
const pairs = [
  ['frenchStack', 'japaneseStack'],
  ['frenchStack', 'italianStack'],
  ['frenchStack', 'americanStack'],
  ['japaneseStack', 'italianStack'],
  ['japaneseStack', 'americanStack'],
  ['italianStack', 'americanStack'],
];
for (const pair of pairs) {
  const rows = runMatch(pair, 50);
  console.log(`  ${pair[0]} vs ${pair[1]}: ` +
    rows.map(r => `${r.name}=${fmt(r.avgProfit)}`).join(', '));
}

// 3 teams (samples — full round-robin would be many)
console.log('\n--- 3 teams (samples) ---');
const triples = [
  ['frenchStack', 'japaneseStack', 'italianStack'],
  ['frenchStack', 'americanStack', 'italianStack'],
  ['frenchStack', 'japaneseStack', 'americanStack'],
  ['japaneseStack', 'italianStack', 'americanStack'],
];
for (const triple of triples) {
  const rows = runMatch(triple, 50);
  console.log(`  ${triple.join(', ')}:`);
  for (const r of rows) {
    console.log(`    ${pad(r.name, 16)} ${pct(r.winRate)} ${fmt(r.avgProfit)}`);
  }
}

// 4 teams: all 4 nationalities
console.log('\n--- 4 teams: all nationalities ---');
const fourRows = runMatch(['frenchStack', 'japaneseStack', 'italianStack', 'americanStack'], 100);
logResults('4-team mirror (50 reps × 4 nationalities)', fourRows);
const s4 = spread(fourRows);
console.log(`  Spread: ${fmt(s4.range)} (${fmt(s4.min)} to ${fmt(s4.max)})`);

// 5 teams: 4 nationalities + premium
console.log('\n--- 5 teams: 4 nationalities + premiumMenu ---');
const fiveRows = runMatch(['frenchStack', 'japaneseStack', 'italianStack', 'americanStack', 'premiumMenu'], 100);
logResults('5-team', fiveRows);
const s5 = spread(fiveRows);
console.log(`  Spread: ${fmt(s5.range)} (${fmt(s5.min)} to ${fmt(s5.max)})`);

// 6 teams: 4 nationalities + premium + baseline
console.log('\n--- 6 teams: 4 nationalities + premium + baseline ---');
const sixRows = runMatch(['frenchStack', 'japaneseStack', 'italianStack', 'americanStack', 'premiumMenu', 'baseline'], 100);
logResults('6-team', sixRows);
const s6 = spread(sixRows);
console.log(`  Spread: ${fmt(s6.range)} (${fmt(s6.min)} to ${fmt(s6.max)})`);

// 8 teams: 4 nationalities × 2 + premium + baseline
console.log('\n--- 8 teams: 4 nationalities × 2 + premium + baseline ---');
const eightRows = runMatch(
  ['frenchStack', 'frenchStack', 'japaneseStack', 'japaneseStack',
   'italianStack', 'americanStack', 'premiumMenu', 'baseline'],
  50
);
// Aggregate same strategies
const agg = {};
for (const r of eightRows) {
  if (!agg[r.name]) agg[r.name] = { name: r.name, profits: [], wins: 0, ranks: [], n: 0 };
  agg[r.name].profits.push(r.avgProfit);
  agg[r.name].wins += r.winRate * 50;
  agg[r.name].n += 50;
}
const aggRows = Object.values(agg).map((a) => ({
  name: a.name,
  avgProfit: a.profits.reduce((s, x) => s + x, 0) / a.profits.length,
  winRate: a.wins / a.n,
  avgRank: 0,
}));
logResults('8-team (aggregated by strategy)', aggRows);
const s8 = spread(aggRows);
console.log(`  Spread: ${fmt(s8.range)} (${fmt(s8.min)} to ${fmt(s8.max)})`);

console.log('\n═══════════════════════════════════════════════════════════════════════');
console.log('SCALING SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log(`4-team spread: ${fmt(s4.range)}`);
console.log(`5-team spread: ${fmt(s5.range)}`);
console.log(`6-team spread: ${fmt(s6.range)}`);
console.log(`8-team spread: ${fmt(s8.range)}`);

if (s4.range > 30000) console.log('⚠ 4-team spread exceeds $30k — possible imbalance');
if (s5.range > 30000) console.log('⚠ 5-team spread exceeds $30k — possible imbalance');
if (s6.range > 30000) console.log('⚠ 6-team spread exceeds $30k — possible imbalance');
if (s8.range > 30000) console.log('⚠ 8-team spread exceeds $30k — possible imbalance');
