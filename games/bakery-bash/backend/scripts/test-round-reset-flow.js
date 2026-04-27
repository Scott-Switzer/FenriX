#!/usr/bin/env node
/**
 * BE-R04 integration test: advancing past `results_ready` into the next
 * round's `email` phase must clear every player's round-scoped pending
 * state (submitted flag, bids, quantities, etc.) so Round N doesn't
 * surface Round N-1 data. `pendingDecision.productPrices` must survive.
 */
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { initializeApp: initClient } = require('firebase/app');
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
const GAME_ID = 'round-reset-test';
const PROFESSOR_UID = 'round-reset-professor';
const PLAYER_UIDS = ['round-reset-p1', 'round-reset-p2'];

async function main() {
  initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore();
  const adminAuth = getAdminAuth();

  // 1. Seed a game at results_ready for round 1, with each player holding
  //    Round-1 pendingDecision (submitted) and pendingBids (ad + chef).
  const gameRef = db.collection('games').doc(GAME_ID);
  await gameRef.set({
    joinCode: 'RESET01',
    professorUid: PROFESSOR_UID,
    professorId: PROFESSOR_UID,
    phase: 'results_ready',
    currentRound: 1,
    round: 1,
    totalRounds: 5,
    paused: false,
    submittedCount: PLAYER_UIDS.length,
    totalPlayers: PLAYER_UIDS.length,
    phaseEndsAt: Timestamp.fromMillis(Date.now() + 60_000),
    startedAt: FieldValue.serverTimestamp(),
    endedAt: null,
  });
  await gameRef.collection('config').doc('params').set({
    phaseDurations: {
      email: 60, decide: 180, bid_ad: 90, bid_chef: 90,
      roster: 30, results_ready: 60,
    },
  });

  const dirtyPendingDecision = {
    submitted: true,
    submittedAt: Timestamp.now(),
    round: 1,
    menu: { croissant: true, cookie: true, bagel: true },
    quantities: { croissant: 50, cookie: 30, bagel: 20 },
    sousChefCount: 2,
    sousChefAssignments: { croissant: 1, cookie: 1 },
    productPrices: { croissant: 4.25, cookie: 3.5 }, // must survive!
  };
  const dirtyPendingBids = {
    ad: { TV: 2000, Billboard: 0, Radio: 500, Newspaper: 0 },
    chef: [{ chefId: 'french-m-1-abcd', amount: 15000 }],
  };

  for (const uid of PLAYER_UIDS) {
    await gameRef.collection('players').doc(uid).set({
      uid,
      playerId: uid,
      displayName: `Player ${uid}`,
      bakeryName: `Bakery ${uid}`,
      role: 'solo',
      budgetCurrent: 450000,
      cumulativeRevenue: 50000,
      specialtyChefs: [],
      sousChefCount: 2,
      pendingDecision: dirtyPendingDecision,
      pendingBids: dirtyPendingBids,
      pendingRosterAction: true,
      consecutiveMissedRounds: 0,
      disconnected: false,
      lastRoundResult: { round: 1, revenueNet: 12345 },
    });
  }

  // 2. Sign in as the professor and advance the phase.
  initClient({
    apiKey: 'demo', projectId: PROJECT_ID, authDomain: 'demo', appId: 'demo',
  });
  const auth = getAuth();
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const functions = getFunctions();
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  const customToken = await adminAuth.createCustomToken(PROFESSOR_UID);
  await signInWithCustomToken(auth, customToken);

  const advanceGamePhase = httpsCallable(functions, 'advanceGamePhase');
  const result = await advanceGamePhase({ gameId: GAME_ID });

  // 3. Assert we landed in round_2_email.
  assert.strictEqual(result.data.phase, 'round_2_email', 'advanced to round_2_email');
  assert.strictEqual(result.data.round, 2, 'currentRound incremented to 2');

  // 4. Every player should have their pending fields reset, EXCEPT
  //    productPrices (POST-01 carry-over).
  for (const uid of PLAYER_UIDS) {
    const snap = await gameRef.collection('players').doc(uid).get();
    const pd = snap.get('pendingDecision') || {};
    const pb = snap.get('pendingBids') || {};

    assert.strictEqual(pd.submitted, false, `${uid}: pendingDecision.submitted reset`);
    assert.strictEqual(pd.submittedAt, null, `${uid}: submittedAt cleared`);
    assert.strictEqual(pd.round, null, `${uid}: pendingDecision.round cleared`);
    assert.deepStrictEqual(pd.menu, {}, `${uid}: pendingDecision.menu cleared`);
    assert.deepStrictEqual(pd.quantities, {}, `${uid}: quantities cleared`);
    assert.strictEqual(pd.sousChefCount, 0, `${uid}: sousChefCount cleared`);
    assert.deepStrictEqual(pd.sousChefAssignments, {}, `${uid}: sousChefAssignments cleared`);
    // productPrices must survive (POST-01).
    assert.deepStrictEqual(
      pd.productPrices,
      { croissant: 4.25, cookie: 3.5 },
      `${uid}: productPrices preserved`,
    );

    assert.strictEqual(pb.ad, null, `${uid}: pendingBids.ad cleared`);
    assert.strictEqual(pb.chef, null, `${uid}: pendingBids.chef cleared`);

    assert.strictEqual(
      snap.get('pendingRosterAction'), false,
      `${uid}: pendingRosterAction cleared`,
    );
    // Cumulative / roster state unaffected.
    assert.strictEqual(
      snap.get('cumulativeRevenue'), 50000,
      `${uid}: cumulativeRevenue preserved across round`,
    );
  }

  console.log('PASS: advancing into round_2_email clears pending round-scoped state');
}

main().catch((err) => { console.error(err); process.exit(1); });
