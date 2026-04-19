/**
 * test-team-roles.js
 *
 * Verifies updateTeamName and setTeamRole callables against the emulator.
 * Run via:  npm run test:team-roles
 */

const { initializeApp: initializeAdminApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase/app");
const {
  connectAuthEmulator,
  getAuth,
  signInAnonymously,
} = require("firebase/auth");
const {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
} = require("firebase/functions");

const PROJECT_ID = "bakery-bash-54d12";
const GAME_ID    = "team-roles-test-game";
const TEAM_ID    = "team-alpha";

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`${name} must be set by Firebase emulators:exec.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function seed(adminDb, uid1, uid2) {
  await adminDb.doc(`games/${GAME_ID}`).set({
    joinCode: "TEAM01",
    phase: "lobby",
    round: 0,
    currentRound: 0,
    totalRounds: 5,
    professorId: "uid_professor",
    professorUid: "uid_professor",
    paused: false,
    totalPlayers: 2,
    submittedCount: 0,
    createdAt: null,
    startedAt: null,
    endedAt: null,
  });

  // Seed two player docs
  for (const uid of [uid1, uid2]) {
    await adminDb.doc(`games/${GAME_ID}/players/${uid}`).set({
      uid,
      playerId: uid,
      displayName: `Player-${uid.slice(0, 6)}`,
      bakeryName: `Bakery-${uid.slice(0, 6)}`,
      budgetCurrent: 500000,
      cumulativeRevenue: 0,
      specialtyChefs: [],
      sousChefCount: 0,
      role: null,
    });
  }

  // Seed team doc — both players are members (null role = no role yet)
  await adminDb.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).set({
    name: "Alpha Squad",
    roleAssignments: { [uid1]: null, [uid2]: null },
  });
}

async function expectError(fn, expectedCode, label) {
  try {
    await fn();
    throw new Error(`FAIL: ${label} — expected error with code "${expectedCode}" but call succeeded.`);
  } catch (err) {
    const code = err.code || (err.details && err.details.code);
    // httpsCallable errors wrap the code as "functions/already-exists" etc.
    assert(
      code && code.includes(expectedCode),
      `${label} — expected code "${expectedCode}", got "${code}": ${err.message}`,
    );
    console.log(`  ✓ ${label} correctly rejected (${code})`);
  }
}

async function main() {
  requireEnv("FIRESTORE_EMULATOR_HOST");
  requireEnv("FIREBASE_AUTH_EMULATOR_HOST");

  // Admin SDK — used for seeding and post-call verification
  initializeAdminApp({ projectId: PROJECT_ID });
  const adminDb = getFirestore();

  // Client SDK — two anonymous users
  const app = initializeApp({
    apiKey: "demo-key",
    authDomain: `${PROJECT_ID}.firebaseapp.com`,
    projectId: PROJECT_ID,
  });

  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, {
    disableWarnings: true,
  });
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);

  // Sign in as player 1
  const { user: user1 } = await signInAnonymously(auth);
  const uid1 = user1.uid;

  // Sign in as player 2 via a second app instance
  const app2 = initializeApp(
    { apiKey: "demo-key", authDomain: `${PROJECT_ID}.firebaseapp.com`, projectId: PROJECT_ID },
    "app2",
  );
  const auth2 = getAuth(app2);
  connectAuthEmulator(auth2, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, {
    disableWarnings: true,
  });
  const functions2 = getFunctions(app2);
  connectFunctionsEmulator(functions2, "127.0.0.1", 5001);

  const { user: user2 } = await signInAnonymously(auth2);
  const uid2 = user2.uid;

  console.log(`Player 1: ${uid1}`);
  console.log(`Player 2: ${uid2}`);

  await seed(adminDb, uid1, uid2);

  const updateTeamName = httpsCallable(functions, "updateTeamName");
  const setTeamRole    = httpsCallable(functions, "setTeamRole");
  const setTeamRole2   = httpsCallable(functions2, "setTeamRole");

  console.log("\n── updateTeamName ──");

  // Happy path
  const renameResult = await updateTeamName({ gameId: GAME_ID, teamId: TEAM_ID, name: "Beta Force" });
  assert(renameResult.data.success === true, "updateTeamName should return { success: true }");
  const teamSnap = await adminDb.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  assert(teamSnap.get("name") === "Beta Force", "Team name was not updated in Firestore.");
  console.log("  ✓ team name updated to 'Beta Force'");

  // Non-member rejection — create a third anonymous user not in the team
  const app3 = initializeApp(
    { apiKey: "demo-key", authDomain: `${PROJECT_ID}.firebaseapp.com`, projectId: PROJECT_ID },
    "app3",
  );
  const auth3 = getAuth(app3);
  connectAuthEmulator(auth3, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, {
    disableWarnings: true,
  });
  const functions3 = getFunctions(app3);
  connectFunctionsEmulator(functions3, "127.0.0.1", 5001);
  const { user: user3 } = await signInAnonymously(auth3);
  const uid3 = user3.uid;
  // Give user3 a player doc but NOT a team membership
  await adminDb.doc(`games/${GAME_ID}/players/${uid3}`).set({
    uid: uid3, playerId: uid3, displayName: "Outsider", bakeryName: "Outsider Bakery",
    budgetCurrent: 500000, cumulativeRevenue: 0, specialtyChefs: [], sousChefCount: 0, role: null,
  });
  const updateTeamName3 = httpsCallable(functions3, "updateTeamName");
  await expectError(
    () => updateTeamName3({ gameId: GAME_ID, teamId: TEAM_ID, name: "Hacked Name" }),
    "permission-denied",
    "non-member rename attempt",
  );

  // Name too long
  await expectError(
    () => updateTeamName({ gameId: GAME_ID, teamId: TEAM_ID, name: "x".repeat(65) }),
    "invalid-argument",
    "name > 64 chars",
  );

  console.log("\n── setTeamRole ──");

  // Happy path — player 1 takes "CEO"
  const roleResult = await setTeamRole({ gameId: GAME_ID, teamId: TEAM_ID, role: "CEO" });
  assert(roleResult.data.success === true, "setTeamRole should return { success: true }");

  const teamSnap2 = await adminDb.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  assert(
    teamSnap2.get(`roleAssignments.${uid1}`) === "CEO",
    `roleAssignments.${uid1} should be "CEO"`,
  );
  console.log(`  ✓ roleAssignments[${uid1.slice(0, 6)}] = "CEO"`);

  const playerSnap1 = await adminDb.doc(`games/${GAME_ID}/players/${uid1}`).get();
  assert(playerSnap1.get("role") === "CEO", "players/{uid1}.role should mirror to 'CEO'");
  console.log(`  ✓ players/${uid1.slice(0, 6)}.role mirrored to "CEO"`);

  // Conflict — player 2 tries to take "CEO" (already held by player 1)
  await expectError(
    () => setTeamRole2({ gameId: GAME_ID, teamId: TEAM_ID, role: "CEO" }),
    "already-exists",
    "duplicate role claim",
  );

  // Player 2 takes a different role "CFO" — should succeed
  await setTeamRole2({ gameId: GAME_ID, teamId: TEAM_ID, role: "CFO" });
  const teamSnap3 = await adminDb.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  assert(teamSnap3.get(`roleAssignments.${uid2}`) === "CFO", `roleAssignments[uid2] should be "CFO"`);
  console.log(`  ✓ roleAssignments[${uid2.slice(0, 6)}] = "CFO"`);

  // Player 1 switches from "CEO" to "CFO" — should fail because uid2 holds "CFO"
  await expectError(
    () => setTeamRole({ gameId: GAME_ID, teamId: TEAM_ID, role: "CFO" }),
    "already-exists",
    "switch to role already held by teammate",
  );

  // Player 2 switches from "CFO" to "CEO" — now uid1 holds "CEO", should fail
  await expectError(
    () => setTeamRole2({ gameId: GAME_ID, teamId: TEAM_ID, role: "CEO" }),
    "already-exists",
    "player 2 takes CEO held by player 1",
  );

  // Player 1 switches from "CEO" to "CMO" — should succeed (clears CEO, opens it for others)
  await setTeamRole({ gameId: GAME_ID, teamId: TEAM_ID, role: "CMO" });
  const teamSnap4 = await adminDb.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  assert(teamSnap4.get(`roleAssignments.${uid1}`) === "CMO", `uid1 should now hold "CMO"`);
  console.log(`  ✓ player 1 switched from "CEO" to "CMO" (previous role cleared)`);

  // Now player 2 can take "CEO" since player 1 released it
  await setTeamRole2({ gameId: GAME_ID, teamId: TEAM_ID, role: "CEO" });
  const teamSnap5 = await adminDb.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  assert(teamSnap5.get(`roleAssignments.${uid2}`) === "CEO", `uid2 should now hold "CEO"`);
  console.log(`  ✓ player 2 claimed "CEO" after player 1 released it`);

  // Non-member role claim
  const setTeamRole3 = httpsCallable(functions3, "setTeamRole");
  await expectError(
    () => setTeamRole3({ gameId: GAME_ID, teamId: TEAM_ID, role: "COO" }),
    "permission-denied",
    "non-member role claim",
  );

  console.log("\nAll team-roles tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
