const { initializeApp: initClient } = require('firebase/app');
const { connectFunctionsEmulator, getFunctions, httpsCallable } = require('firebase/functions');

const PROJECT_ID = 'bakery-bash-54d12';
const HOST = '127.0.0.1';

async function main() {
  const app = initClient({ projectId: PROJECT_ID, apiKey: 'demo-key' });
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, HOST, 5001);

  console.log('\n=== Pre-warm Test ===\n');

  // All 26 onCall handlers in functions/index.js. The pre-warm short-circuit
  // must be present on every one of them; missing coverage means a callable
  // would respond to T2.1's warmup ping with an auth error instead of a no-op.
  const callables = [
    'createGame', 'joinGame', 'createTeam', 'getTeamsInLobby',
    'startGame', 'advanceGamePhase', 'retryStuckSimulation',
    'submitDecision', 'submitPrices', 'submitBids',
    'layoffChef', 'continueFromRoster',
    'pauseGame', 'resumeGame', 'endGame', 'getConclusion',
    'exportPlayerCsv', 'exportProfessorCsv',
    'updateTeamName', 'setTeamRole',
    'extendPhase', 'purchaseCompetitorInsight', 'purchaseChefData',
    'resetGame', 'createSnapshot', 'restoreSnapshot',
  ];

  const failures = [];
  for (const name of callables) {
    try {
      const fn = httpsCallable(functions, name);
      const result = await fn({ _warmup: true });
      if (result.data && result.data.warm === true) {
        console.log(`  ✓ ${name}: warm`);
      } else {
        failures.push(`${name}: expected { warm: true }, got ${JSON.stringify(result.data)}`);
        console.log(`  ⚠ ${name}: bad warmup response`);
      }
    } catch (err) {
      failures.push(`${name}: threw ${err.code || err.message}`);
      console.log(`  ⚠ ${name}: threw ${err.code || err.message}`);
    }
  }

  if (failures.length > 0) {
    console.log(`\n❌ ${failures.length} callable(s) failed pre-warm:`);
    for (const f of failures) console.log(`  - ${f}`);
    throw new Error(`${failures.length} callable(s) missing or broken pre-warm`);
  }

  console.log(`\n=== Pre-warm Test PASSED — all ${callables.length} callables warm ===\n`);
}

main().catch(err => {
  console.error('\n❌ Pre-warm test failed:', err.message);
  process.exit(1);
});
