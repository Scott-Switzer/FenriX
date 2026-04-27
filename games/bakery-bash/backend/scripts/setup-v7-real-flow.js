#!/usr/bin/env node
/**
 * setup-v7-real-flow.js
 *
 * Simulates a real-game flow up to round_1_roster WITH chef bids resolved
 * (player ends up with actual specialtyChefs assigned). Reproduces the V7
 * "decide screen still doesn't show after kitchen roster" bug as faithfully
 * as a script can — the only thing missing is a real browser tab, which the
 * caller drives separately via preview tools.
 *
 * Usage:
 *   node setup-v7-real-flow.js <browserUid>
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const { initializeApp: initAdmin } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');
const { initializeApp: initClient } = require('firebase/app');
const {
  getAuth, signInWithCustomToken, connectAuthEmulator,
} = require('firebase/auth');
const {
  getFunctions, httpsCallable, connectFunctionsEmulator,
} = require('firebase/functions');

const PROJECT_ID = 'bakery-bash-54d12';
const GAME_ID = 'v7-real';
const JOIN_CODE = 'V7REAL';
const PROF_UID = 'prof-v7-real';
const BROWSER_UID = process.argv[2] || 'placeholder-browser-uid';
const BOB_UID = 'v7-bob';

async function clientForUid(uid, adminAuth, label) {
  const app = initClient(
    { apiKey: 'demo', projectId: PROJECT_ID },
    label,
  );
  connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001);
  await signInWithCustomToken(getAuth(app), await adminAuth.createCustomToken(uid));
  return getFunctions(app);
}

async function clearGame(db, gid) {
  const gameRef = db.collection('games').doc(gid);
  for (const sub of ['players', 'roster', 'teams', 'config', 'rounds', 'submissions', 'marketInsights', 'leaderboard']) {
    const snap = await gameRef.collection(sub).get();
    for (const d of snap.docs) {
      for (const inner of ['bids', 'decisions']) {
        const subSnap = await d.ref.collection(inner).get().catch(() => ({ docs: [] }));
        for (const s of subSnap.docs) await s.ref.delete();
      }
      await d.ref.delete();
    }
  }
  await gameRef.delete().catch(() => {});
}

(async () => {
  initAdmin({ projectId: PROJECT_ID });
  const db = getFirestore();
  const adminAuth = getAdminAuth();

  console.log(`Wiping ${GAME_ID}…`);
  await clearGame(db, GAME_ID);

  const gameRef = db.collection('games').doc(GAME_ID);
  await gameRef.set({
    joinCode: JOIN_CODE,
    professorUid: PROF_UID, professorId: PROF_UID,
    phase: 'lobby', round: 0, currentRound: 0, totalRounds: 5,
    totalPlayers: 0, submittedCount: 0, paused: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  // Empty config = use DEFAULT_GAME_CONFIG from modules/config.js (post-rebalance:
  // $10k starting budget). Don't hardcode startingBudget here or it will override
  // the central default and re-introduce the $500k Monopoly-money scale.
  await gameRef.collection('config').doc('params').set({
    playerCap: 20,
  });

  const fnsBrowser = await clientForUid(BROWSER_UID, adminAuth, 'browser');
  const fnsBob = await clientForUid(BOB_UID, adminAuth, 'bob');
  const fnsP = await clientForUid(PROF_UID, adminAuth, 'prof');

  console.log('Browser creates Team Alpha, Bob creates Team Beta…');
  await httpsCallable(fnsBrowser, 'createTeam')({
    joinCode: JOIN_CODE, teamName: 'Team Alpha', displayName: 'Alice (browser)',
  });
  await httpsCallable(fnsBob, 'createTeam')({
    joinCode: JOIN_CODE, teamName: 'Team Beta', displayName: 'Bob',
  });

  await httpsCallable(fnsP, 'startGame')({ gameId: GAME_ID });
  const advance = httpsCallable(fnsP, 'advanceGamePhase');

  console.log('Advance email → bid_ad → bid_chef (skipping ad bids)…');
  await advance({ gameId: GAME_ID });
  await advance({ gameId: GAME_ID });

  console.log('Each team submits a chef bid…');
  const round1 = await gameRef.collection('rounds').doc('round_1').get();
  const pool = round1.data()?.chefPool || [];
  if (pool.length >= 2) {
    await httpsCallable(fnsBrowser, 'submitBids')({
      gameId: GAME_ID, bidType: 'chef',
      chefBids: [{ chefId: pool[0].id, amount: pool[0].minBidFloor + 100 }],
    });
    await httpsCallable(fnsBob, 'submitBids')({
      gameId: GAME_ID, bidType: 'chef',
      chefBids: [{ chefId: pool[1].id, amount: pool[1].minBidFloor + 100 }],
    });
  }

  console.log('Advance bid_chef → roster (chef auction resolves)…');
  await advance({ gameId: GAME_ID });

  const final = await gameRef.get();
  console.log(`\n✓ Game now in phase: ${final.get('phase')}`);
  const pdoc = await gameRef.collection('players').doc(BROWSER_UID).get();
  console.log(`Browser player: chefs=${(pdoc.get('specialtyChefs') || []).length} teamId=${pdoc.get('teamId')}`);

  console.log(`\nBrowser session JSON:`);
  console.log(JSON.stringify({
    gameId: GAME_ID,
    playerId: BROWSER_UID,
    gameCode: JOIN_CODE,
    role: 'solo',
    teamId: 'team-alpha',
  }));
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
