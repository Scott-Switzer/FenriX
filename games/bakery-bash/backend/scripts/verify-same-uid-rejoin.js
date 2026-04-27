#!/usr/bin/env node
/**
 * verify-same-uid-rejoin.js
 *
 * Reproduces the "Teammates (1) only shows the latest joiner" symptom
 * by simulating the realistic developer testing path: ONE browser,
 * multiple tabs, all sharing the same anonymous Firebase Auth UID via
 * IndexedDB. Each tab calls `joinGame` with a different displayName,
 * but the backend sees the same uid each time → rejoin path.
 */

const { initializeApp: initAdmin } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');
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

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

const PROJECT_ID = 'bakery-bash-54d12';
const GAME_ID = 'verify-same-uid';
const JOIN_CODE = 'SAMEU2';
const PROF_UID = 'prof-same';
const SHARED_UID = 'one-browser-tabs';

async function clientForUid(uid, adminAuth, label) {
  const app = initClient(
    { apiKey: 'demo', projectId: PROJECT_ID, authDomain: 'demo', appId: 'demo' },
    label,
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const fns = getFunctions(app);
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  const token = await adminAuth.createCustomToken(uid);
  await signInWithCustomToken(auth, token);
  return { fns };
}

async function dump(db, label) {
  console.log(`\n──────── ${label} ────────`);
  const team = await db
    .collection('games').doc(GAME_ID)
    .collection('teams').doc('flour-power').get();
  console.log('teams/flour-power:', JSON.stringify(team.data(), null, 2));
  const roster = await db
    .collection('games').doc(GAME_ID)
    .collection('roster').get();
  console.log(`roster (${roster.size}):`);
  roster.docs.forEach(d => console.log(`  ${d.id}:`, JSON.stringify(d.data())));
}

async function main() {
  initAdmin({ projectId: PROJECT_ID });
  const db = getFirestore();
  const adminAuth = getAdminAuth();

  const gameRef = db.collection('games').doc(GAME_ID);
  for (const sub of ['players', 'roster', 'teams', 'config']) {
    const snap = await gameRef.collection(sub).get();
    for (const d of snap.docs) await d.ref.delete();
  }
  await gameRef.delete().catch(() => {});

  await gameRef.set({
    joinCode: JOIN_CODE, professorUid: PROF_UID, professorId: PROF_UID,
    phase: 'lobby', round: 0, currentRound: 0, totalRounds: 5,
    totalPlayers: 0, submittedCount: 0, paused: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  await gameRef.collection('config').doc('params').set({ playerCap: 20 });

  // SHARED_UID is the same across all "tabs"
  const { fns } = await clientForUid(SHARED_UID, adminAuth, 'shared-tabs');

  console.log('Tab 1: createTeam("Flour Power") as Alice');
  const createTeam = httpsCallable(fns, 'createTeam');
  await createTeam({ joinCode: JOIN_CODE, teamName: 'Flour Power', displayName: 'Alice' });
  await dump(db, 'After Tab 1: createTeam(Alice)');

  console.log('\nTab 2: same UID joins same team as "Bob"');
  const joinGame = httpsCallable(fns, 'joinGame');
  await joinGame({ joinCode: JOIN_CODE, displayName: 'Bob', teamId: 'flour-power' });
  await dump(db, 'After Tab 2: joinGame(Bob, flour-power)');

  console.log('\nTab 3: same UID tries to join same team as "Carol"');
  await joinGame({ joinCode: JOIN_CODE, displayName: 'Carol', teamId: 'flour-power' });
  await dump(db, 'After Tab 3: joinGame(Carol, flour-power)');

  console.log('\n→ Expected if same UID: only 1 entry in roleAssignments, roster shows latest displayName.');
}

main().catch((err) => { console.error(err); process.exit(1); });
