const { initializeApp: initClient } = require('firebase/app');
const { connectFunctionsEmulator, getFunctions, httpsCallable } = require('firebase/functions');

const PROJECT_ID = 'bakery-bash-54d12';
const HOST = '127.0.0.1';

async function main() {
  const app = initClient({ projectId: PROJECT_ID, apiKey: 'demo-key' });
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, HOST, 5001);

  console.log('\n=== Pre-warm Test ===\n');

  const callables = [
    'joinGame', 'createTeam', 'startGame', 'advanceGamePhase',
    'submitDecision', 'submitPrices', 'submitBids',
    'createSnapshot', 'restoreSnapshot', 'pauseGame', 'resumeGame',
  ];

  for (const name of callables) {
    const fn = httpsCallable(functions, name);
    const result = await fn({ _warmup: true });
    assert(result.data.warm === true, `${name} should return warm=true`);
    console.log(`  ✓ ${name}: warm`);
  }

  console.log('\n=== Pre-warm Test PASSED ===\n');
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

main().catch(err => {
  console.error('\n❌ Pre-warm test failed:', err.message);
  process.exit(1);
});
