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
  const PLAYER_COUNT = 25;
  console.log('\n=== Sharded Counter Accuracy Test ===\n');

  // Create a separate Firebase app per player so each gets its own auth
  const players = [];
  for (let i = 0; i < PLAYER_COUNT; i++) {
    const app = initClient({ projectId: PROJECT_ID, apiKey: 'demo-key' }, `shard_p${i}_${Date.now()}`);
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${HOST}:9099`, { disableWarnings: true });
    const functions = getFunctions(app);
    connectFunctionsEmulator(functions, HOST, 5001);
    const { user } = await signInAnonymously(auth);
    players.push({ uid: user.uid, app, auth, functions });
  }
  console.log(`  ✓ Signed in ${PLAYER_COUNT} players`);

  // Professor creates game
  const profApp = initClient({ projectId: PROJECT_ID, apiKey: 'demo-key' }, `shard_prof_${Date.now()}`);
  const profAuth = getAuth(profApp);
  connectAuthEmulator(profAuth, `http://${HOST}:9099`, { disableWarnings: true });
  const profFunctions = getFunctions(profApp);
  connectFunctionsEmulator(profFunctions, HOST, 5001);
  const { user: profUser } = await signInAnonymously(profAuth);
  const profUid = profUser.uid;

  const gameId = `shardtest_${Date.now()}`;
  const gameRef = db.collection('games').doc(gameId);

  await gameRef.set({
    joinCode: 'ABCD23', phase: 'round_1_decide', currentRound: 1, totalRounds: 2,
    paused: false, professorId: profUid, totalPlayers: PLAYER_COUNT, submittedCount: 0,
  });
  await gameRef.collection('config').doc('params').set({});

  // Create player docs manually (so auth uids match player doc ids)
  for (const p of players) {
    await gameRef.collection('players').doc(p.uid).set({
      uid: p.uid, displayName: `P${p.uid.slice(0, 4)}`, bakeryName: `B${p.uid.slice(0, 4)}`,
      role: 'solo', budgetCurrent: 10000, cumulativeRevenue: 0,
      specialtyChefs: [], sousChefCount: 0,
    });
  }
  console.log(`  ✓ Seeded game + ${PLAYER_COUNT} player docs`);

  // Submit decisions concurrently
  const decision = {
    gameId,
    decision: {
      menu: { croissant: true, cookie: true, bagel: true },
      quantities: { croissant: 10, cookie: 10, bagel: 10 },
      sousChefCount: 0,
      sousChefAssignments: {},
    },
  };

  const start = Date.now();
  const results = await Promise.allSettled(
    players.map(async (p) => {
      const fn = httpsCallable(p.functions, 'submitDecision');
      return await fn(decision);
    })
  );
  const elapsed = Date.now() - start;

  const successes = results.filter(r => r.status === 'fulfilled').length;
  const failures = results.filter(r => r.status === 'rejected');
  console.log(`  ✓ ${successes}/${PLAYER_COUNT} submissions succeeded in ${elapsed}ms`);
  if (failures.length > 0) {
    console.log(`  ⚠ ${failures.length} failures:`, failures.slice(0, 3).map(f => f.reason?.code || f.reason?.message));
  }

  // Wait a bit for the trigger to aggregate
  await new Promise(r => setTimeout(r, 2000));

  // Verify submittedCount
  const gameSnap = await gameRef.get();
  const submittedCount = gameSnap.data().submittedCount || 0;
  console.log(`  → Game submittedCount: ${submittedCount}`);

  // Verify shards
  const shardsSnap = await gameRef.collection('submittedCountShards').doc('round_1').collection('shards').get();
  let distinctUids = 0;
  for (const shard of shardsSnap.docs) {
    const uids = shard.data().uids || {};
    distinctUids += Object.keys(uids).length;
  }
  console.log(`  → Distinct UIDs in shards: ${distinctUids}`);

  assert(distinctUids === successes, `expected ${successes} distinct UIDs in shards, got ${distinctUids}`);
  assert(submittedCount === successes, `expected submittedCount=${successes}, got ${submittedCount}`);
  console.log('  ✓ Sharded counter accurate');

  // Test idempotency: same players submit again
  const results2 = await Promise.allSettled(
    players.map(async (p) => {
      const fn = httpsCallable(p.functions, 'submitDecision');
      return await fn(decision);
    })
  );
  const successes2 = results2.filter(r => r.status === 'fulfilled').length;
  console.log(`  → Re-submit: ${successes2} succeeded (expected 0 since already submitted)`);

  await new Promise(r => setTimeout(r, 2000));
  const gameSnap2 = await gameRef.get();
  const submittedCount2 = gameSnap2.data().submittedCount || 0;
  assert(submittedCount2 === successes, `idempotency failed: count went from ${submittedCount} to ${submittedCount2}`);
  console.log('  ✓ Idempotency preserved');

  console.log('\n=== Sharded Counter Test PASSED ===\n');
}

main().catch(err => {
  console.error('\n❌ Sharded counter test failed:', err.message);
  process.exit(1);
});
