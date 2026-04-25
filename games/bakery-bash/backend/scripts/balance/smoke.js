/**
 * smoke.js — Quick smoke test of the balance harness.
 * Runs one full game with 3 teams and prints round-by-round numbers.
 */

'use strict';

const harness = require('./harness');
const strategies = require('./strategies');

function fmt(n) {
  if (typeof n !== 'number') return String(n);
  const s = Math.round(n).toLocaleString('en-US');
  return n < 0 ? `-$${s.slice(1)}` : `$${s}`;
}

function main() {
  const teams = [
    { id: 't-baseline',     name: 'Baseline',      strategy: { ...strategies.baseline,     play: strategies.baseline,     name: 'Baseline'     } },
    { id: 't-french',       name: 'FrenchStack',   strategy: { ...strategies.frenchStack,  play: strategies.frenchStack,  name: 'FrenchStack'  } },
    { id: 't-japanese',     name: 'JapaneseStack', strategy: { ...strategies.japaneseStack, play: strategies.japaneseStack, name: 'JapaneseStack' } },
  ];

  const result = harness.runOneGame(teams, {}, 42);

  console.log('Final ranks:');
  for (const t of result.teams) {
    console.log(`  #${t.rank} ${t.strategyName}: profit=${fmt(t.totalProfit)}, finalBudget=${fmt(t.finalBudget)}, customers=${t.totalCustomers}, avgSat=${t.avgSatisfaction.toFixed(1)}`);
  }

  console.log('\nProfit by round:');
  for (const t of result.teams) {
    console.log(`  ${t.strategyName}:`);
    t.profitByRound.forEach((p, i) => {
      console.log(`    R${i + 1}: profit=${fmt(p)} revNet=${fmt(t.revenueByRound[i])} cust=${t.customersByRound[i]} sat=${t.satisfactionByRound[i].toFixed(1)} adWins=${t.adWinsByRound[i].join(',') || '-'} sous=${t.sousChefByRound[i]}`);
    });
  }

  console.log('\nFinal chef rosters:');
  for (const t of result.teams) {
    const roster = t.chefRosterFinal.length === 0 ? '(none)' : t.chefRosterFinal.map((c) => `${c.skill}/${c.nat}[${c.specs.join(',')}]`).join(', ');
    console.log(`  ${t.strategyName}: ${roster}`);
  }
}

if (require.main === module) main();
