const { initializeApp: initAdmin } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { initializeApp: initClient } = require('firebase/app');
const { connectAuthEmulator, getAuth, signInAnonymously } = require('firebase/auth');
const { connectFunctionsEmulator, getFunctions, httpsCallable } = require('firebase/functions');

const PROJECT_ID = 'bakery-bash-54d12';
const HOST = '127.0.0.1';

process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:8080`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `${HOST}:9099`;

const adminApp = initAdmin({ projectId: PROJECT_ID });
const db = getFirestore(adminApp);

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function main() {
  const app = initClient({ projectId: PROJECT_ID, apiKey: 'demo-key' });
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${HOST}:9099`, { disableWarnings: true });
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, HOST, 5001);

  const { user: prof } = await signInAnonymously(auth);
  const uid = prof.uid;
  const gameId = `crosstest_${Date.now()}`;
  const gameRef = db.collection('games').doc(gameId);

  console.log('\n=== Cross-Feature Interaction Test ===\n');

  // 1. Create and start game
  await gameRef.set({
    joinCode: 'ABCD23', phase: 'lobby', currentRound: 0, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 1, submittedCount: 0,
  });
  await gameRef.collection('config').doc('params').set({});
  await gameRef.collection('players').doc(uid).set({
    uid, displayName: 'Prof', bakeryName: 'Prof Bakery', role: 'solo',
    budgetCurrent: 10000, cumulativeRevenue: 0, specialtyChefs: [], sousChefCount: 0,
  });

  const startGame = httpsCallable(functions, 'startGame');
  await startGame({ gameId });
  console.log('  ✓ Game started (auto-snapshot created)');

  // Wait for auto-snapshot
  await new Promise(r => setTimeout(r, 1500));
  const snaps1 = await gameRef.collection('snapshots').get();
  assert(snaps1.size === 1, `expected 1 auto-snapshot, got ${snaps1.size}`);
  console.log('  ✓ Auto-snapshot confirmed');

  // 2. Advance to decision phase
  const advanceGamePhase = httpsCallable(functions, 'advanceGamePhase');
  for (let i = 0; i < 4; i++) await advanceGamePhase({ gameId });
  const phaseSnap = await gameRef.get();
  assert(phaseSnap.data().phase === 'round_1_decide', `expected decide phase, got ${phaseSnap.data().phase}`);
  console.log('  ✓ Advanced to decision phase');

  // 3. Submit a decision
  const submitDecision = httpsCallable(functions, 'submitDecision');
  await submitDecision({
    gameId,
    decision: { menu: { croissant: true }, quantities: { croissant: 10 }, sousChefCount: 0, sousChefAssignments: {} },
  });
  await new Promise(r => setTimeout(r, 1500));
  const afterSubmit = await gameRef.get();
  assert(afterSubmit.data().submittedCount === 1, `expected submittedCount=1, got ${afterSubmit.data().submittedCount}`);
  console.log('  ✓ Decision submitted, sharded counter = 1');

  // 4. Pause the game
  const pauseGame = httpsCallable(functions, 'pauseGame');
  await pauseGame({ gameId });
  const afterPause = await gameRef.get();
  assert(afterPause.data().paused === true, 'game should be paused');
  console.log('  ✓ Game paused');

  // 5. Restore to the auto-snapshot (round 1 start)
  const snapshotId = snaps1.docs[0].id;
  const restoreSnapshot = httpsCallable(functions, 'restoreSnapshot');
  const restoreResult = await restoreSnapshot({ gameId, snapshotId });
  console.log(`  ✓ Restored: ${restoreResult.data.written} written, ${restoreResult.data.deleted} deleted`);

  // 6. Verify post-restore state
  const afterRestore = await gameRef.get();
  const data = afterRestore.data();
  assert(data.paused === true, 'game should still be paused after restore');
  assert(data.phase === 'round_1_email', `expected round_1_email, got ${data.phase}`);
  assert(data.submittedCount === 0, `submittedCount should be 0 after restore, got ${data.submittedCount}`);
  console.log('  ✓ Post-restore: paused=true, phase=round_1_email, submittedCount=0');

  // 7. Unpause, advance to decide, and verify submissions work again
  const resume = httpsCallable(functions, 'resumeGame');
  await resume({ gameId });
  for (let i = 0; i < 4; i++) await advanceGamePhase({ gameId });
  await submitDecision({
    gameId,
    decision: { menu: { croissant: true }, quantities: { croissant: 5 }, sousChefCount: 0, sousChefAssignments: {} },
  });
  await new Promise(r => setTimeout(r, 1500));
  const final = await gameRef.get();
  assert(final.data().submittedCount === 1, `expected submittedCount=1 after re-submit, got ${final.data().submittedCount}`);
  console.log('  ✓ Unpaused and re-submitted successfully');

  console.log('\n=== Cross-Feature Interaction Test PASSED ===\n');
}

main().catch(err => {
  console.error('\n❌ Cross-feature test failed:', err.message);
  process.exit(1);
});
