/**
 * P0-1 regression test: snapshot/restore must preserve csvRows.
 *
 * The CSV writer creates `games/{gameId}/csvRows/{playerId}/rounds/{roundId}`
 * but never materialises the `csvRows/{playerId}` parent doc. When
 * dumpCollection used `collRef.get()`, the ghost parent was missed and the
 * restore "clean" pass then DELETED every live csvRow because nothing in the
 * snapshot referenced its path.
 *
 * This script seeds a ghost-parent csvRow path and asserts it survives a
 * snapshot + restore round trip.
 */

const { initializeApp: initAdmin } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
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
  const gameId = `csvtest_${Date.now()}`;
  const gameRef = db.collection('games').doc(gameId);

  console.log('\n=== Snapshot preserves csvRows (ghost parent) ===\n');

  // 1. Seed the game + a ghost-parent csvRow path. Mirrors what
  //    advanceGamePhase writes in production at functions/index.js:2316.
  await gameRef.set({
    joinCode: 'CSV001', phase: 'round_1_email', currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 1, submittedCount: 1,
  });
  const csvParentRef = gameRef.collection('csvRows').doc('player_a');
  const csvRoundRef = csvParentRef.collection('rounds').doc('round_1');
  await csvRoundRef.set({
    round: 1,
    playerId: 'player_a',
    row: { player_id: 'player_a', display_name: 'Alice', revenue: 1234 },
  });
  console.log('  ✓ Seeded csvRows/player_a/rounds/round_1');

  // 2. Confirm the ghost parent really is empty (not just missing data).
  const parentSnap = await csvParentRef.get();
  assert(!parentSnap.exists, 'precondition: csvRows/player_a should be a ghost parent');
  const roundSnap = await csvRoundRef.get();
  assert(roundSnap.exists, 'precondition: csvRows/player_a/rounds/round_1 should exist');
  console.log('  ✓ Confirmed ghost-parent layout');

  // 3. Capture a snapshot.
  const createSnapshot = httpsCallable(functions, 'createSnapshot');
  const snapResult = await createSnapshot({ gameId });
  console.log(`  ✓ Snapshot created: ${snapResult.data.snapshotId} (${snapResult.data.totalDocs} docs)`);

  // 4. Restore (no mutation needed — the bug is that the "clean" pass
  //    treats the live csvRow as drift because the snapshot never saw it).
  const restoreSnapshot = httpsCallable(functions, 'restoreSnapshot');
  const restoreResult = await restoreSnapshot({ gameId, snapshotId: snapResult.data.snapshotId });
  console.log(`  ✓ Restored: ${restoreResult.data.written} written, ${restoreResult.data.deleted} deleted`);

  // 5. The csvRow leaf must still exist after restore.
  const afterRoundSnap = await csvRoundRef.get();
  assert(
    afterRoundSnap.exists,
    'csvRows/player_a/rounds/round_1 was wiped by restore — ghost-parent csvRows lost',
  );
  const afterData = afterRoundSnap.data();
  assert(
    afterData && afterData.row && afterData.row.revenue === 1234,
    `csvRow data corrupted after restore: ${JSON.stringify(afterData)}`,
  );
  console.log('  ✓ csvRow round doc survived restore with intact data');

  console.log('\n=== Snapshot csvRows test PASSED ===\n');
}

main().catch((err) => {
  console.error('\n❌ Snapshot csvRows test failed:', err.message);
  process.exit(1);
});
