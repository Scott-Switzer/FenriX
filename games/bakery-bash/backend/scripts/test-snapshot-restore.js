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
  const gameId = `snaptest_${Date.now()}`;
  const gameRef = db.collection('games').doc(gameId);

  console.log('\n=== Snapshot / Restore Test ===\n');

  // 1. Seed game with state
  await gameRef.set({
    joinCode: 'ABCD23', phase: 'round_1_decide', currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 3, submittedCount: 1,
    someValue: 42,
  });
  await gameRef.collection('config').doc('params').set({ startingBudget: 5000 });
  await gameRef.collection('players').doc('p1').set({ displayName: 'Alice', budgetCurrent: 5000 });
  await gameRef.collection('players').doc('p2').set({ displayName: 'Bob', budgetCurrent: 4500 });
  await gameRef.collection('rounds').doc('round_1').set({ phase: 'decide', topBids: { ad: { TV: 100 } } });
  console.log('  ✓ Seeded game with state');

  // 2. Create snapshot
  const createSnapshot = httpsCallable(functions, 'createSnapshot');
  const snapResult = await createSnapshot({ gameId });
  assert(snapResult.data.snapshotId, 'snapshotId missing');
  assert(snapResult.data.totalDocs >= 4, `expected >=4 docs, got ${snapResult.data.totalDocs}`);
  console.log(`  ✓ Snapshot created: ${snapResult.data.snapshotId} (${snapResult.data.totalDocs} docs, ${snapResult.data.totalBytes} bytes)`);

  // 3. Mutate game state
  await gameRef.update({ phase: 'round_1_results', submittedCount: 3, someValue: 99 });
  await gameRef.collection('players').doc('p3').set({ displayName: 'Carol', budgetCurrent: 3000 });
  await gameRef.collection('decisions').doc('extra').set({ foo: 'bar' });
  console.log('  ✓ Mutated game state');

  // 4. Restore snapshot
  const restoreSnapshot = httpsCallable(functions, 'restoreSnapshot');
  const restoreResult = await restoreSnapshot({ gameId, snapshotId: snapResult.data.snapshotId });
  console.log(`  ✓ Restored: ${restoreResult.data.written} written, ${restoreResult.data.deleted} deleted`);

  // 5. Verify restored state
  const gameSnap = await gameRef.get();
  const gameData = gameSnap.data();
  assert(gameData.phase === 'round_1_decide', `phase should be 'round_1_decide', got ${gameData.phase}`);
  assert(gameData.submittedCount === 1, `submittedCount should be 1, got ${gameData.submittedCount}`);
  assert(gameData.someValue === 42, `someValue should be 42, got ${gameData.someValue}`);
  assert(gameData.paused === true, 'game should be paused after restore');
  console.log('  ✓ Game doc restored correctly (and paused)');

  const playersSnap = await gameRef.collection('players').get();
  assert(playersSnap.size === 2, `expected 2 players, got ${playersSnap.size}`);
  const names = playersSnap.docs.map(d => d.get('displayName')).sort();
  assert(JSON.stringify(names) === '["Alice","Bob"]', `players mismatch: ${JSON.stringify(names)}`);
  console.log('  ✓ Players restored correctly (Carol deleted)');

  const extraSnap = await gameRef.collection('decisions').doc('extra').get();
  assert(!extraSnap.exists, 'drift doc "extra" should be deleted');
  console.log('  ✓ Drift docs deleted');

  const roundsSnap = await gameRef.collection('rounds').doc('round_1').get();
  assert(roundsSnap.exists && roundsSnap.data().topBids.ad.TV === 100, 'round data restored');
  console.log('  ✓ Round data restored');

  console.log('\n=== Snapshot / Restore Test PASSED ===\n');
}

main().catch(err => {
  console.error('\n❌ Snapshot test failed:', err.message);
  process.exit(1);
});
