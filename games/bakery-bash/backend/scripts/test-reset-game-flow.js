#!/usr/bin/env node
/**
 * Integration test for resetGame Cloud Function.
 * Run via: npm run test:reset-game (uses firebase emulators:exec).
 */
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const {
  initializeApp: initClient,
} = require('firebase/app');
const {
  getAuth,
  signInWithCustomToken,
  connectAuthEmulator,
} = require('firebase/auth');
const {
  getFunctions,
  httpsCallable,
  connectFunctionsEmulator,
} = require('firebase/functions');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');
const assert = require('node:assert');

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

const PROJECT_ID = 'bakery-bash-54d12';
const GAME_ID = 'reset-test';
const PROFESSOR_UID = 'reset-test-professor';
const PLAYER_UID = 'reset-test-player';

async function main() {
  initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore();
  const adminAuth = getAdminAuth();

  // 1. Seed a game in mid-flight: round 3, with rounds/submissions/leaderboard
  //    docs and a player with non-default budget/cumulativeRevenue.
  const gameRef = db.collection('games').doc(GAME_ID);
  await gameRef.set({
    professorUid: PROFESSOR_UID,
    professorId: PROFESSOR_UID,
    phase: 'round_3_decide',
    currentRound: 3,
    round: 3,
    totalRounds: 5,
    paused: false,
    submittedCount: 2,
    startedAt: FieldValue.serverTimestamp(),
    endedAt: null,
  });
  await gameRef.collection('config').doc('params').set({
    startingBudget: 2000,
  });
  await gameRef.collection('rounds').doc('round_2').set({ stub: true });
  await gameRef.collection('submissions').doc('round_2_decide').set({ stub: true });
  await gameRef.collection('leaderboard').doc('round_2').set({ stub: true });
  await gameRef.collection('conclusion').doc('final').set({ stub: true });

  const playerRef = gameRef.collection('players').doc(PLAYER_UID);
  await playerRef.set({
    uid: PLAYER_UID,
    budgetCurrent: 1234,
    cumulativeRevenue: 4567,
    specialtyChefs: [{ chefId: 'french-f', skillLevel: 5 }],
    sousChefCount: 3,
    pendingDecision: { staffCount: 5 },
    pendingBids: { adBid: { amount: 100 } },
    pendingRosterAction: true,
    rosterCompleted: true,
    returningCustomersPending: 50,
    chefSatisfactionScores: { sc1: 80 },
    maintenanceBars: { cleanliness: 30, ovenHealth: 40, slicerHealth: 50, espressoHealth: 60 },
    lastRoundResult: { round: 2, revenue: 999 },
    consecutiveMissedRounds: 1,
    disconnected: false,
  });
  await playerRef.collection('decisions').doc('round_2').set({ stub: true });
  await playerRef.collection('rounds').doc('round_2').set({ stub: true });

  // 2. Call resetGame as the professor via the callable client SDK.
  initClient({
    apiKey: 'demo',
    projectId: PROJECT_ID,
    authDomain: 'demo',
    appId: 'demo',
  });
  const auth = getAuth();
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const functions = getFunctions();
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);

  const customToken = await adminAuth.createCustomToken(PROFESSOR_UID);
  await signInWithCustomToken(auth, customToken);

  const resetGame = httpsCallable(functions, 'resetGame');
  const result = await resetGame({ gameId: GAME_ID });

  // 3. Assert game state.
  const gAfter = await gameRef.get();
  assert.strictEqual(gAfter.get('phase'), 'lobby', 'phase reset');
  assert.strictEqual(gAfter.get('currentRound'), 0, 'currentRound reset');
  assert.strictEqual(gAfter.get('round'), 0, 'round reset');
  assert.strictEqual(gAfter.get('paused'), false, 'paused cleared');
  assert.strictEqual(gAfter.get('submittedCount'), 0, 'submittedCount reset');
  assert.strictEqual(gAfter.get('endedAt'), null, 'endedAt cleared');

  // 4. Assert subcollections wiped.
  const roundsSnap = await gameRef.collection('rounds').get();
  assert.strictEqual(roundsSnap.size, 0, 'rounds wiped');
  const subsSnap = await gameRef.collection('submissions').get();
  assert.strictEqual(subsSnap.size, 0, 'submissions wiped');
  const lbSnap = await gameRef.collection('leaderboard').get();
  assert.strictEqual(lbSnap.size, 0, 'leaderboard wiped');
  const conclusionSnap = await gameRef.collection('conclusion').get();
  assert.strictEqual(conclusionSnap.size, 0, 'conclusion wiped');

  // 5. Assert player reset.
  const pAfter = await playerRef.get();
  assert.strictEqual(pAfter.get('budgetCurrent'), 2000, 'budget reset to startingBudget');
  assert.strictEqual(pAfter.get('cumulativeRevenue'), 0, 'cumulativeRevenue cleared');
  assert.deepStrictEqual(pAfter.get('specialtyChefs'), [], 'specialtyChefs cleared');
  assert.strictEqual(pAfter.get('sousChefCount'), 0, 'sousChefCount cleared');
  assert.strictEqual(pAfter.get('pendingRosterAction'), false, 'pendingRosterAction cleared');
  assert.strictEqual(pAfter.get('rosterCompleted'), false, 'rosterCompleted cleared');
  assert.strictEqual(pAfter.get('disconnected'), false, 'disconnected cleared');
  assert.strictEqual(pAfter.get('consecutiveMissedRounds'), 0, 'consecutiveMissedRounds cleared');
  assert.strictEqual(pAfter.get('lastRoundResult'), undefined, 'lastRoundResult deleted');

  const pDecisions = await playerRef.collection('decisions').get();
  assert.strictEqual(pDecisions.size, 0, 'player decisions wiped');
  const pRounds = await playerRef.collection('rounds').get();
  assert.strictEqual(pRounds.size, 0, 'player rounds wiped');

  // 6. Assert response shape.
  assert.strictEqual(result.data.gameId, GAME_ID);
  assert.strictEqual(result.data.phase, 'lobby');

  console.log('PASS: resetGame wipes subcollections and resets players');
}

main().catch((err) => { console.error(err); process.exit(1); });
