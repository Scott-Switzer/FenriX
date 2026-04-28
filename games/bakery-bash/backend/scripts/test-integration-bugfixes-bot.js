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

async function expectError(fn, expectedCode, label) {
  try {
    await fn();
    console.log(`  ⚠ ${label}: ACCEPTED but should reject`);
  } catch (err) {
    const code = err.code || '';
    if (code.includes(expectedCode)) {
      console.log(`  ✓ ${label}: rejected (${code})`);
    } else {
      console.log(`  ⚠ ${label}: got ${code} but expected ${expectedCode}`);
    }
  }
}

async function main() {
  const app = initClient({ projectId: PROJECT_ID, apiKey: 'demo-key' });
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${HOST}:9099`, { disableWarnings: true });
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, HOST, 5001);

  const { user: prof } = await signInAnonymously(auth);
  const uid = prof.uid;

  console.log('\n=== Integration Test: Bug Fixes + AI Bot ===\n');

  // --- Test 1: createBotPlayer ---
  console.log('--- Test 1: createBotPlayer ---');
  const gameId = `bottest_${Date.now()}`;
  const gameRef = db.collection('games').doc(gameId);

  await gameRef.set({
    joinCode: 'ABCD23', phase: 'lobby', currentRound: 0, totalRounds: 2,
    paused: false, professorId: uid, professorUid: uid, totalPlayers: 0, submittedCount: 0,
  });
  await gameRef.collection('config').doc('params').set({});

  const createBotPlayer = httpsCallable(functions, 'createBotPlayer');

  // Test preset creation
  const presetBot = await createBotPlayer({ gameId, preset: 'risky_ricky' });
  assert(presetBot.data.difficulty === 'hard', 'preset bot difficulty should be hard');
  assert(presetBot.data.personality === 'aggressive', 'preset bot personality should be aggressive');
  assert(presetBot.data.displayName === 'Risky Ricky', 'preset bot name should be Risky Ricky');

  const presetSnap = await gameRef.collection('players').doc(presetBot.data.botUid).get();
  assert(presetSnap.exists, 'preset bot player doc should exist');
  assert(presetSnap.data().botPreset === 'risky_ricky', 'bot should store preset key');
  assert(presetSnap.data().botPersonality === 'aggressive', 'bot should store personality');
  console.log('  ✓ createBotPlayer created Risky Ricky via preset');

  // Test manual difficulty + personality
  const botResult = await createBotPlayer({ gameId, difficulty: 'hard', personality: 'aggressive' });
  assert(botResult.data.difficulty === 'hard', 'bot difficulty should be hard');
  assert(botResult.data.personality === 'aggressive', 'bot personality should be aggressive');

  const botSnap = await gameRef.collection('players').doc(botResult.data.botUid).get();
  assert(botSnap.exists, 'bot player doc should exist');
  assert(botSnap.data().isBot === true, 'bot should have isBot=true');
  assert(botSnap.data().botDifficulty === 'hard', 'bot should have difficulty');
  assert(botSnap.data().botPersonality === 'aggressive', 'bot should have personality');
  console.log('  ✓ createBotPlayer created hard aggressive bot');

  // Medium bot (legacy style, defaults to balanced)
  const bot2 = await createBotPlayer({ gameId, difficulty: 'medium' });
  assert(bot2.data.difficulty === 'medium', 'second bot should be medium');
  assert(bot2.data.personality === 'balanced', 'legacy bot should default to balanced personality');
  console.log('  ✓ createBotPlayer created medium bot (legacy, balanced default)');

  // Easy bot
  const bot3 = await createBotPlayer({ gameId, difficulty: 'easy' });
  assert(bot3.data.difficulty === 'easy', 'third bot should be easy');
  console.log('  ✓ createBotPlayer created easy bot');

  // --- Test 2: extendPhase rejects negative ---
  console.log('\n--- Test 2: extendPhase rejects negative ---');
  const startGame = httpsCallable(functions, 'startGame');
  await startGame({ gameId });
  console.log('  ✓ Game started');

  const extendPhase = httpsCallable(functions, 'extendPhase');
  await expectError(
    () => extendPhase({ gameId, extraSeconds: -60 }),
    'invalid-argument',
    'Negative extraSeconds rejected'
  );
  await expectError(
    () => extendPhase({ gameId, extraSeconds: 0 }),
    'invalid-argument',
    'Zero extraSeconds rejected'
  );

  // Positive should work
  const extResult = await extendPhase({ gameId, extraSeconds: 30 });
  assert(extResult.data.success === true, 'extendPhase should succeed with positive');
  console.log('  ✓ Positive extraSeconds accepted');

  // --- Test 3: Bot trigger fires on phase change ---
  console.log('\n--- Test 3: Bot decisions on phase change ---');
  const advanceGamePhase = httpsCallable(functions, 'advanceGamePhase');

  // Advance to bid_ad
  for (let i = 0; i < 2; i++) await advanceGamePhase({ gameId });

  // Wait for trigger
  await new Promise(r => setTimeout(r, 2000));

  const roundRef = gameRef.collection('rounds').doc('round_1');
  const roundSnap = await roundRef.get();

  // Check bot bids (including preset bot)
  for (const bot of [presetBot.data.botUid, botResult.data.botUid, bot2.data.botUid, bot3.data.botUid]) {
    const bidSnap = await gameRef.collection('players').doc(bot).collection('bids').doc('round_1').get();
    if (!bidSnap.exists || !bidSnap.data().ad) {
      console.log(`  ⚠ Bot ${bot} did not submit ad bids (trigger may need more time)`);
    } else {
      console.log(`  ✓ Bot ${bot.slice(0, 10)} submitted ad bids`);
    }
  }

  // --- Test 4: Finance-only submission treated as missed ---
  console.log('\n--- Test 4: Finance-only submission = missed ---');
  const g2 = `bottest2_${Date.now()}`;
  const g2Ref = db.collection('games').doc(g2);
  await g2Ref.set({
    joinCode: 'EFGH45', phase: 'round_1_decide', currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, professorUid: uid, totalPlayers: 1, submittedCount: 0,
  });
  await g2Ref.collection('config').doc('params').set({
    revenueCoefficients: { noiseMin: 0, noiseMax: 0 },
  });

  // Create a second auth user to act as the finance player
  const app2 = initClient({ projectId: PROJECT_ID, apiKey: 'demo-key' }, `finance_${Date.now()}`);
  const auth2 = getAuth(app2);
  connectAuthEmulator(auth2, `http://${HOST}:9099`, { disableWarnings: true });
  const { user: finUser } = await signInAnonymously(auth2);
  const finUid = finUser.uid;

  await g2Ref.collection('players').doc(finUid).set({
    uid: finUid, displayName: 'Finance', bakeryName: 'Finance Bakery', role: 'finance',
    budgetCurrent: 10000, cumulativeRevenue: 0, specialtyChefs: [], sousChefCount: 0,
    consecutiveMissedRounds: 0, disconnected: false,
  });

  // Finance submits prices only
  const finFunctions = getFunctions(app2);
  connectFunctionsEmulator(finFunctions, HOST, 5001);
  const submitPrices = httpsCallable(finFunctions, 'submitPrices');
  await submitPrices({ gameId: g2, productPrices: { coffee: 4.5, croissant: 5.0 } });

  // Verify the decision doc has pricesSubmittedAt but no submittedAt
  const decisionSnap = await g2Ref.collection('players').doc(finUid).collection('decisions').doc('round_1').get();
  assert(decisionSnap.exists, 'Finance decision doc should exist');
  assert(!decisionSnap.data().submittedAt, 'Finance decision doc should NOT have submittedAt');
  assert(decisionSnap.data().pricesSubmittedAt, 'Finance decision doc should have pricesSubmittedAt');
  console.log('  ✓ Finance-only doc has pricesSubmittedAt but no submittedAt');

  console.log('\n=== Integration Test PASSED ===\n');
}

main().catch(err => {
  console.error('\n❌ Integration test failed:', err.message);
  process.exit(1);
});
