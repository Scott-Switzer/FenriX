#!/usr/bin/env node
/**
 * BE-R01 / BE-R02 integration test: createTeam + getTeamsInLobby +
 * joinGame with explicit teamId.
 *
 * Scenarios:
 *   1. createTeam (happy path) — writes team doc, player doc, totalPlayers++
 *   2. createTeam duplicate name — `already-exists`
 *   3. createTeam when game not in lobby — `failed-precondition`
 *   4. getTeamsInLobby — returns every team with correct memberCount
 *   5. joinGame with explicit teamId — second player lands on the same
 *      team and appears in roleAssignments
 *   6. createTeam after phase != lobby (new uid) — `failed-precondition`
 *   7. getTeamsInLobby after phase != lobby (new uid) — `failed-precondition`
 *   8. getTeamsInLobby after phase != lobby (existing player) — still returns
 *      team list so rejoin path stays open
 */
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
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
const GAME_ID = 'create-join-test';
const JOIN_CODE = 'CRTJN2';
const PROFESSOR_UID = 'create-join-prof';
const CREATOR_A_UID = 'create-join-a';
const CREATOR_B_UID = 'create-join-b';
const JOINER_UID = 'create-join-joiner';

function callableAs(fnName, functionsRef) {
  return httpsCallable(functionsRef, fnName);
}

async function signIn(auth, adminAuth, uid) {
  const token = await adminAuth.createCustomToken(uid);
  await signInWithCustomToken(auth, token);
}

async function main() {
  initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore();
  const adminAuth = getAdminAuth();

  // Seed a lobby game directly (bypassing createGame) so the test focuses
  // on the new callables.
  const gameRef = db.collection('games').doc(GAME_ID);
  await gameRef.set({
    joinCode: JOIN_CODE,
    professorUid: PROFESSOR_UID,
    professorId: PROFESSOR_UID,
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
    startingBudget: 500000,
    playerCap: 20,
  });

  initClient({ apiKey: 'demo', projectId: PROJECT_ID, authDomain: 'demo', appId: 'demo' });
  const auth = getAuth();
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const functions = getFunctions();
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);

  // ------- 1. createTeam happy path -------
  await signIn(auth, adminAuth, CREATOR_A_UID);
  const createTeam = callableAs('createTeam', functions);
  const createA = await createTeam({
    joinCode: JOIN_CODE,
    teamName: 'Sourdough Squad',
    displayName: 'Alice',
  });
  assert.strictEqual(createA.data.gameId, GAME_ID, 'createTeam: gameId');
  assert.strictEqual(createA.data.playerId, CREATOR_A_UID, 'createTeam: playerId');
  assert.strictEqual(createA.data.teamId, 'sourdough-squad', 'createTeam: slug teamId');
  assert.strictEqual(createA.data.teamName, 'Sourdough Squad', 'createTeam: echoes name');

  const teamASnap = await gameRef.collection('teams').doc('sourdough-squad').get();
  assert.ok(teamASnap.exists, 'team doc created');
  assert.strictEqual(teamASnap.get('name'), 'Sourdough Squad');
  assert.strictEqual(teamASnap.get('memberCount'), 1);
  // BE-I04: teams with ≤2 members get `solo` so the sole creator can
  // still submit everything. The role flips to finance/advertising/
  // operations when the 3rd teammate joins.
  assert.strictEqual(
    teamASnap.get('roleAssignments')[CREATOR_A_UID],
    'solo',
    'creator of a one-person team gets the solo role'
  );

  const playerASnap = await gameRef.collection('players').doc(CREATOR_A_UID).get();
  assert.ok(playerASnap.exists, 'player A doc created');
  assert.strictEqual(playerASnap.get('teamId'), 'sourdough-squad');
  assert.strictEqual(playerASnap.get('bakeryName'), 'Sourdough Squad');
  assert.strictEqual(playerASnap.get('role'), 'solo');
  assert.strictEqual(playerASnap.get('pendingDecision').submitted, false);
  assert.strictEqual(playerASnap.get('pendingBids').ad, null);

  const gameAfterA = await gameRef.get();
  assert.strictEqual(gameAfterA.get('totalPlayers'), 1, 'totalPlayers incremented');

  // ------- 2. createTeam duplicate name rejected -------
  await signIn(auth, adminAuth, CREATOR_B_UID);
  try {
    await createTeam({
      joinCode: JOIN_CODE,
      teamName: 'Sourdough Squad',
      displayName: 'Bob',
    });
    assert.fail('expected duplicate-team-name to throw');
  } catch (err) {
    assert.match(
      err.code || err.message,
      /already-exists/,
      'duplicate name → already-exists'
    );
  }

  // Second creator can still create a different team.
  const createB = await createTeam({
    joinCode: JOIN_CODE,
    teamName: 'Croissant Crew',
    displayName: 'Bob',
  });
  assert.strictEqual(createB.data.teamId, 'croissant-crew');

  // ------- 3. getTeamsInLobby -------
  const getTeamsInLobby = callableAs('getTeamsInLobby', functions);
  const lobbyResult = await getTeamsInLobby({ joinCode: JOIN_CODE });
  const teams = lobbyResult.data.teams;
  assert.strictEqual(teams.length, 2, 'two teams in lobby');
  const sourdough = teams.find((t) => t.teamId === 'sourdough-squad');
  const croissant = teams.find((t) => t.teamId === 'croissant-crew');
  assert.ok(sourdough && croissant, 'both teams present');
  assert.strictEqual(sourdough.name, 'Sourdough Squad');
  assert.strictEqual(sourdough.memberCount, 1);
  assert.strictEqual(croissant.memberCount, 1);

  // ------- 4. joinGame with explicit teamId -------
  await signIn(auth, adminAuth, JOINER_UID);
  const joinGame = callableAs('joinGame', functions);
  await joinGame({
    joinCode: JOIN_CODE,
    displayName: 'Carol',
    teamId: 'sourdough-squad',
  });

  const teamAfterJoin = await gameRef.collection('teams').doc('sourdough-squad').get();
  assert.strictEqual(
    teamAfterJoin.get('memberCount'),
    2,
    'member count bumped on explicit-team join'
  );
  // BE-I04: both members of a ≤2-member team get `solo` so either one
  // can submit any decision while the team is short-staffed.
  assert.strictEqual(
    teamAfterJoin.get('roleAssignments')[CREATOR_A_UID],
    'solo',
    'creator still solo while team is 2 members'
  );
  assert.strictEqual(
    teamAfterJoin.get('roleAssignments')[JOINER_UID],
    'solo',
    '2nd joiner also gets solo — no specialist role yet'
  );

  const joinerPlayer = await gameRef.collection('players').doc(JOINER_UID).get();
  assert.strictEqual(joinerPlayer.get('teamId'), 'sourdough-squad');
  assert.strictEqual(
    joinerPlayer.get('bakeryName'),
    'Sourdough Squad',
    'joiner bakeryName mirrors team name'
  );

  // ------- 4b. BE-I04: 2 → 3 transition flips solo → specialists -------
  const THIRD_JOINER_UID = 'create-join-third';
  await signIn(auth, adminAuth, THIRD_JOINER_UID);
  await joinGame({
    joinCode: JOIN_CODE,
    displayName: 'Erin',
    teamId: 'sourdough-squad',
  });

  const teamAfterThird = await gameRef.collection('teams').doc('sourdough-squad').get();
  assert.strictEqual(
    teamAfterThird.get('memberCount'),
    3,
    'member count reaches 3 after third join'
  );
  const assignmentsAfterThird = teamAfterThird.get('roleAssignments');
  const assignedRoles = [
    assignmentsAfterThird[CREATOR_A_UID],
    assignmentsAfterThird[JOINER_UID],
    assignmentsAfterThird[THIRD_JOINER_UID],
  ];
  const specialistRoles = ['finance', 'advertising', 'operations'].sort();
  assert.deepStrictEqual(
    [...assignedRoles].sort(),
    specialistRoles,
    'every seat flips to a distinct specialist role when team hits 3 members'
  );
  // Mirror on the player docs too.
  for (const [uid, expected] of [
    [CREATOR_A_UID, assignmentsAfterThird[CREATOR_A_UID]],
    [JOINER_UID, assignmentsAfterThird[JOINER_UID]],
    [THIRD_JOINER_UID, assignmentsAfterThird[THIRD_JOINER_UID]],
  ]) {
    const pSnap = await gameRef.collection('players').doc(uid).get();
    assert.strictEqual(
      pSnap.get('role'),
      expected,
      `players/${uid}.role mirrors team roleAssignment after flip`
    );
  }

  // ------- 5. joinGame with bogus teamId → not-found -------
  try {
    await joinGame({
      joinCode: JOIN_CODE,
      displayName: 'Dave',
      teamId: 'no-such-team',
    });
    assert.fail('expected bogus teamId to throw');
  } catch (err) {
    assert.match(err.code || err.message, /not-found/, 'bogus teamId → not-found');
  }

  // ------- 6. createTeam after phase != lobby -------
  await gameRef.update({ phase: 'round_1_email', round: 1, currentRound: 1 });
  await signIn(auth, adminAuth, 'create-join-late');
  try {
    await createTeam({
      joinCode: JOIN_CODE,
      teamName: 'Late Team',
      displayName: 'Dave',
    });
    assert.fail('expected createTeam after lobby to throw');
  } catch (err) {
    assert.match(
      err.code || err.message,
      /failed-precondition/,
      'post-lobby create → failed-precondition'
    );
  }

  // ------- 7. getTeamsInLobby after phase != lobby (new caller) -------
  // Still signed in as 'create-join-late' — no player doc exists for this
  // uid, so the guard should fire.
  try {
    await getTeamsInLobby({ joinCode: JOIN_CODE });
    assert.fail('expected getTeamsInLobby after lobby to throw for new caller');
  } catch (err) {
    assert.match(
      err.code || err.message,
      /failed-precondition/,
      'post-lobby getTeamsInLobby (new caller) → failed-precondition'
    );
  }

  // ------- 8. getTeamsInLobby after phase != lobby (existing player) -------
  // Returning player should still be able to see the team list so they can
  // rejoin via joinGame's rejoin path.
  await signIn(auth, adminAuth, CREATOR_A_UID);
  const rejoinLobby = await getTeamsInLobby({ joinCode: JOIN_CODE });
  assert.strictEqual(
    rejoinLobby.data.teams.length,
    2,
    'existing player can list teams post-lobby'
  );

  console.log('PASS: createTeam + getTeamsInLobby + joinGame(teamId) all green');
}

main().catch((err) => { console.error(err); process.exit(1); });
