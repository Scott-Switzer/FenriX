#!/usr/bin/env node
/**
 * verify-team-issues.js
 *
 * Reproduces the 4 issues reported by the player on the /team screen:
 *
 *   1. "Grab the role you want…" copy is shown to a 1-person team. (UI copy)
 *   2. When a 2nd person joins, the new joiner shows a "Solo" role badge
 *      individually rather than something that conveys shared control.
 *   3. When a 3rd person joins, no one can pick a role.
 *   4. "Teammates (1)" only shows the latest joiner; lobby shows only the
 *      latest player.
 *
 * Strategy: drive the same callable surface the FE does, then dump the
 * documents the FE is actually rendering from (team doc roleAssignments,
 * roster collection, and per-player `role` field) so we can confirm
 * where the bug lives.
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
const GAME_ID = 'verify-team-issues';
const JOIN_CODE = 'VRFY24';
const PROF_UID = 'prof-verify';
const UID_A = 'verify-creator';
const UID_B = 'verify-joiner-2';
const UID_C = 'verify-joiner-3';

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

async function dumpState(db, label) {
  console.log(`\n──────── State after: ${label} ────────`);
  const teamSnap = await db
    .collection('games')
    .doc(GAME_ID)
    .collection('teams')
    .doc('flour-power')
    .get();
  if (teamSnap.exists) {
    const data = teamSnap.data();
    console.log(`teams/flour-power memberCount=${data.memberCount}`);
    console.log(
      'teams/flour-power roleAssignments =',
      JSON.stringify(data.roleAssignments, null, 2),
    );
  } else {
    console.log('teams/flour-power: <does not exist>');
  }

  const rosterSnap = await db
    .collection('games')
    .doc(GAME_ID)
    .collection('roster')
    .get();
  console.log(`roster collection (${rosterSnap.size} entries):`);
  rosterSnap.docs.forEach((d) => {
    const data = d.data();
    console.log(
      `  ${d.id.padEnd(20)} displayName=${data.displayName} bakeryName=${data.bakeryName}`,
    );
  });

  const playersSnap = await db
    .collection('games')
    .doc(GAME_ID)
    .collection('players')
    .get();
  console.log(`players collection (${playersSnap.size} entries):`);
  playersSnap.docs.forEach((d) => {
    const data = d.data();
    console.log(
      `  ${d.id.padEnd(20)} role=${data.role} teamId=${data.teamId}`,
    );
  });
}

function simulateTeamPageRender(teamDoc, roster, playerId) {
  // Mirror the logic in TeamPage.tsx so we can see what the FE *would*
  // display given the current doc state. Pure function — no Firebase.
  if (!teamDoc) {
    return { waiting: true };
  }
  const PLAYER_ROLE_LABELS = {
    operations: 'Operations',
    advertising: 'Advertising',
    finance: 'Finance',
    solo: 'Solo',
  };
  const roleAssignments = teamDoc.roleAssignments || {};
  const memberRoster = Object.keys(roleAssignments).map((uid) => {
    const role = roleAssignments[uid] ?? null;
    return {
      uid,
      displayName: roster[uid]?.displayName ?? 'Teammate',
      isYou: uid === playerId,
      role,
      // Mirror the FE: hide the placeholder "solo" badge — only specialist
      // roles surface on the row.
      badge: role && role !== 'solo' ? PLAYER_ROLE_LABELS[role] ?? role : null,
    };
  });
  const memberCount = memberRoster.length;
  // Mirror the FE: only a 1-person team disables pickers now.
  const isSolo = memberCount <= 1;

  const claimedByOther = {};
  for (const [uid, r] of Object.entries(roleAssignments)) {
    if (uid !== playerId && r) claimedByOther[r] = uid;
  }
  const myRole = roleAssignments[playerId] ?? null;

  const PICKABLE = ['operations', 'advertising', 'finance'];
  const pickerRows = PICKABLE.map((r) => ({
    role: r,
    mine: myRole === r,
    takenBy: claimedByOther[r] ?? null,
    disabled: !!claimedByOther[r] || isSolo,
  }));

  const status =
    memberCount === 1
      ? "You're the first on your team — you have all three roles until teammates join."
      : memberCount === 2
      ? 'You and your teammate both control everything right now. Pick a role to split responsibilities.'
      : memberCount >= 3
      ? 'Your team is full. Each of you should pick a role.'
      : '';

  return {
    headerCount: memberCount,
    members: memberRoster,
    isSolo,
    pickerRows,
    status,
  };
}

async function main() {
  initAdmin({ projectId: PROJECT_ID });
  const db = getFirestore();
  const adminAuth = getAdminAuth();

  // Clean any prior run.
  console.log('Cleaning prior state…');
  const gameRef = db.collection('games').doc(GAME_ID);
  const subs = ['players', 'roster', 'teams', 'config', 'submissions', 'rounds'];
  for (const sub of subs) {
    const snap = await gameRef.collection(sub).get();
    for (const d of snap.docs) await d.ref.delete();
  }
  await gameRef.delete().catch(() => {});

  // Seed a lobby game.
  await gameRef.set({
    joinCode: JOIN_CODE,
    professorUid: PROF_UID,
    professorId: PROF_UID,
    phase: 'lobby',
    round: 0,
    currentRound: 0,
    totalRounds: 5,
    totalPlayers: 0,
    submittedCount: 0,
    paused: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  await gameRef.collection('config').doc('params').set({
    playerCap: 20,
  });

  const { fns: fnsA } = await clientForUid(UID_A, adminAuth, 'app-a');
  const { fns: fnsB } = await clientForUid(UID_B, adminAuth, 'app-b');
  const { fns: fnsC } = await clientForUid(UID_C, adminAuth, 'app-c');

  // Step 1: Player A creates "Flour Power" team.
  console.log('\nStep 1: Player A (Alice) creates team "Flour Power"…');
  const createTeam = httpsCallable(fnsA, 'createTeam');
  const created = await createTeam({
    joinCode: JOIN_CODE,
    teamName: 'Flour Power',
    displayName: 'Alice',
  });
  console.log(`  → teamId = ${created.data.teamId}`);
  await dumpState(db, 'A creates team');

  // What does Alice see?
  let teamDoc = (
    await gameRef.collection('teams').doc('flour-power').get()
  ).data();
  let roster = {};
  (await gameRef.collection('roster').get()).docs.forEach((d) => {
    roster[d.id] = d.data();
  });
  console.log('\nAlice sees on /team:');
  console.dir(simulateTeamPageRender(teamDoc, roster, UID_A), { depth: 4 });

  // Step 2: Player B joins via joinGame with explicit teamId.
  console.log('\nStep 2: Player B (Bob) joins "Flour Power"…');
  const joinGameB = httpsCallable(fnsB, 'joinGame');
  await joinGameB({
    joinCode: JOIN_CODE,
    displayName: 'Bob',
    teamId: 'flour-power',
  });
  await dumpState(db, 'B joins');

  teamDoc = (await gameRef.collection('teams').doc('flour-power').get()).data();
  roster = {};
  (await gameRef.collection('roster').get()).docs.forEach((d) => {
    roster[d.id] = d.data();
  });
  console.log('\nAlice sees on /team:');
  console.dir(simulateTeamPageRender(teamDoc, roster, UID_A), { depth: 4 });
  console.log('\nBob sees on /team:');
  console.dir(simulateTeamPageRender(teamDoc, roster, UID_B), { depth: 4 });

  // Step 3: Player C joins.
  console.log('\nStep 3: Player C (Carol) joins "Flour Power"…');
  const joinGameC = httpsCallable(fnsC, 'joinGame');
  await joinGameC({
    joinCode: JOIN_CODE,
    displayName: 'Carol',
    teamId: 'flour-power',
  });
  await dumpState(db, 'C joins (2 → 3 cascade)');

  teamDoc = (await gameRef.collection('teams').doc('flour-power').get()).data();
  roster = {};
  (await gameRef.collection('roster').get()).docs.forEach((d) => {
    roster[d.id] = d.data();
  });
  console.log('\nAlice sees on /team:');
  console.dir(simulateTeamPageRender(teamDoc, roster, UID_A), { depth: 4 });
  console.log('\nBob sees on /team:');
  console.dir(simulateTeamPageRender(teamDoc, roster, UID_B), { depth: 4 });
  console.log('\nCarol sees on /team:');
  console.dir(simulateTeamPageRender(teamDoc, roster, UID_C), { depth: 4 });

  console.log('\n✓ Verification script complete.');
}

main().catch((err) => {
  console.error('VERIFY FAILED:', err);
  process.exit(1);
});
