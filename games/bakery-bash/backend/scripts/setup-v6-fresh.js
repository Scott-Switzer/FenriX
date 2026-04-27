#!/usr/bin/env node
/**
 * setup-v6-fresh.js — Wipe v6-debug + create an empty game ready for
 * multi-tab manual playtest. Sets the professor custom claim too.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

const { initializeApp: initAdmin } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');

const PROJECT_ID = 'bakery-bash-54d12';
const GAME_ID = 'v6-debug';
const JOIN_CODE = 'V6DBUG';
const PROF_UID = 'prof-v6-debug';

(async () => {
  initAdmin({ projectId: PROJECT_ID });
  const db = getFirestore();
  const adminAuth = getAdminAuth();

  console.log(`Wiping ${GAME_ID}…`);
  const gameRef = db.collection('games').doc(GAME_ID);
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

  console.log('Creating fresh lobby…');
  await gameRef.set({
    joinCode: JOIN_CODE,
    professorUid: PROF_UID, professorId: PROF_UID,
    phase: 'lobby', round: 0, currentRound: 0, totalRounds: 5,
    totalPlayers: 0, submittedCount: 0, paused: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  await gameRef.collection('config').doc('params').set({
    // Empty startingBudget = inherit DEFAULT_GAME_CONFIG ($10k post-rebalance).
    playerCap: 20,
  });

  console.log('Ensuring professor user + custom claim…');
  try { await adminAuth.createUser({ uid: PROF_UID }); } catch (e) {
    if (e.code !== 'auth/uid-already-exists') throw e;
  }
  await adminAuth.setCustomUserClaims(PROF_UID, { professor: true });

  console.log('\n──────────────────────────────────────────────────────');
  console.log('  Game ready.');
  console.log('──────────────────────────────────────────────────────');
  console.log(`  Game ID  : ${GAME_ID}`);
  console.log(`  Join code: ${JOIN_CODE}`);
  console.log(`  Prof UID : ${PROF_UID} (custom claim: professor=true)`);
  console.log('──────────────────────────────────────────────────────');
})();
