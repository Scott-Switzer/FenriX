/**
 * test-fallback-roles.js
 *
 * Integration test for FE-I15 — role-gated callables accept any teammate
 * when nobody on the team holds the specialist role. Covers the 2-player
 * team shape and the cleared-role case.
 *
 * Run via: npm run test:fallback-roles
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
const GAME_ID = "fallback-roles-game";
const TEAM_SMALL = "team-small";
const TEAM_FULL = "team-full";

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`${name} must be set by Firebase emulators:exec.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function expectError(fn, expectedCode, label) {
  try {
    await fn();
    throw new Error(`FAIL: ${label} — expected error "${expectedCode}" but call succeeded.`);
  } catch (err) {
    const code = err.code || (err.details && err.details.code) || "";
    assert(
      code.includes(expectedCode),
      `${label} — expected code "${expectedCode}", got "${code}": ${err.message}`,
    );
    console.log(`  ✓ ${label} rejected (${code})`);
  }
}

async function seed(db, small1, small2, fullOps, fullFin, fullAdv) {
  await db.doc(`games/${GAME_ID}`).set({
    joinCode: "FBACK2",
    phase: "round_1_decide",
    round: 1,
    currentRound: 1,
    totalRounds: 5,
    phaseEndTime: null,
    submittedCount: 0,
    totalPlayers: 5,
    paused: false,
    professorId: "uid_professor",
    professorUid: "uid_professor",
  });
  await db.doc(`games/${GAME_ID}/config/params`).set({
    unitCostPerProduct: 1,
    specialtyChefCap: 3,
    revenueCoefficients: { noiseMin: 0, noiseMax: 0 },
  });

  // TEAM_SMALL — 2 players. Both get `finance`/`advertising` — no
  // operations anywhere on the team. FE-I15 should let either one
  // call submitDecision (which normally requires operations).
  await db.doc(`games/${GAME_ID}/teams/${TEAM_SMALL}`).set({
    name: "Small Team",
    teamId: TEAM_SMALL,
    roleAssignments: { [small1]: "finance", [small2]: "advertising" },
    memberCount: 2,
  });
  for (const [uid, role] of [[small1, "finance"], [small2, "advertising"]]) {
    await db.doc(`games/${GAME_ID}/players/${uid}`).set({
      uid, playerId: uid,
      displayName: `Small ${role}`, bakeryName: "Small Bakery",
      teamId: TEAM_SMALL, role,
      budgetCurrent: 10000, cumulativeRevenue: 0,
      specialtyChefs: [], sousChefCount: 0,
      consecutiveMissedRounds: 0, disconnected: false,
    });
  }

  // TEAM_FULL — 3 players. All three specialist roles filled. FE-I15
  // fallback must NOT kick in — strict role gate still applies.
  await db.doc(`games/${GAME_ID}/teams/${TEAM_FULL}`).set({
    name: "Full Team",
    teamId: TEAM_FULL,
    roleAssignments: {
      [fullOps]: "operations",
      [fullFin]: "finance",
      [fullAdv]: "advertising",
    },
    memberCount: 3,
  });
  for (const [uid, role] of [
    [fullOps, "operations"],
    [fullFin, "finance"],
    [fullAdv, "advertising"],
  ]) {
    await db.doc(`games/${GAME_ID}/players/${uid}`).set({
      uid, playerId: uid,
      displayName: `Full ${role}`, bakeryName: "Full Bakery",
      teamId: TEAM_FULL, role,
      budgetCurrent: 10000, cumulativeRevenue: 0,
      specialtyChefs: [], sousChefCount: 0,
      consecutiveMissedRounds: 0, disconnected: false,
    });
  }
}

function makeApp(name) {
  return initializeApp(
    { apiKey: "demo-key", authDomain: `${PROJECT_ID}.firebaseapp.com`, projectId: PROJECT_ID },
    name,
  );
}

async function main() {
  requireEnv("FIRESTORE_EMULATOR_HOST");
  requireEnv("FIREBASE_AUTH_EMULATOR_HOST");

  initializeAdminApp({ projectId: PROJECT_ID });
  const adminDb = getFirestore();

  const apps = ["app1", "app2", "app3", "app4", "app5"].map(makeApp);
  for (const app of apps) {
    connectAuthEmulator(
      getAuth(app),
      `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`,
      { disableWarnings: true },
    );
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
  }

  const [small1, small2, fullOps, fullFin, fullAdv] = await Promise.all(
    apps.map((a) => signInAnonymously(getAuth(a)).then(({ user }) => user.uid)),
  );

  await seed(adminDb, small1, small2, fullOps, fullFin, fullAdv);

  const submitDecisionSmall1 = httpsCallable(getFunctions(apps[0]), "submitDecision");
  const submitDecisionSmall2 = httpsCallable(getFunctions(apps[1]), "submitDecision");
  const submitDecisionFullOps = httpsCallable(getFunctions(apps[2]), "submitDecision");
  const submitDecisionFullFin = httpsCallable(getFunctions(apps[3]), "submitDecision");

  const validDecision = {
    gameId: GAME_ID,
    round: 1,
    menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: true, matcha: false },
    quantities: { croissant: 50, cookie: 50, bagel: 50, coffee: 50 },
    sousChefCount: 2,
    sousChefAssignments: { croissant: 1, coffee: 1 },
  };

  console.log("\n── FE-I15: 2-player team (no operations) ──");

  // Finance teammate submits — normally blocked, but team has no operations.
  const smallResult = await submitDecisionSmall1({ ...validDecision });
  assert(smallResult.data.submitted === true,
    "finance role should submit when no teammate holds operations");
  console.log("  ✓ finance teammate can submitDecision when operations is vacant");

  // Advertising teammate on the same small team also passes the
  // role-gate. `submitDecision` stores per-player decision docs so
  // this is an independent submit — the point of the assertion is
  // that the role-gate doesn't throw `permission-denied`.
  const smallResult2 = await submitDecisionSmall2({ ...validDecision });
  assert(smallResult2.data.submitted === true,
    "advertising role should also submit when no teammate holds operations");
  console.log("  ✓ advertising teammate can submitDecision when operations is vacant");

  console.log("\n── FE-I15: 3-player team (all roles filled) ──");

  // Finance teammate in a fully-staffed team still cannot submitDecision.
  await expectError(
    () => submitDecisionFullFin({ ...validDecision }),
    "permission-denied",
    "finance role blocked when team has an operations player",
  );

  // Operations in the fully-staffed team succeeds.
  const fullResult = await submitDecisionFullOps({ ...validDecision });
  assert(fullResult.data.submitted === true,
    "operations role submits normally when team has all three specialists");
  console.log("  ✓ strict role-gate preserved in fully-staffed team");

  console.log("\n── FE-I15: cleared role opens the gate ──");

  // Reset the small team so we can rerun submitDecision, then clear
  // finance's role and confirm the fallback still works.
  await adminDb.doc(`games/${GAME_ID}/submissions/round_1_decide`).delete();
  for (const uid of [small1, small2]) {
    await adminDb.doc(`games/${GAME_ID}/players/${uid}`).update({
      pendingDecision: { submitted: false },
    });
    await adminDb
      .doc(`games/${GAME_ID}/players/${uid}/decisions/round_1`)
      .delete()
      .catch(() => { /* fine if it didn't exist */ });
  }
  // Clear finance assignment and also null the role on the player doc
  // to simulate a post-clear state.
  await adminDb.doc(`games/${GAME_ID}/teams/${TEAM_SMALL}`).update({
    [`roleAssignments.${small1}`]: null,
  });
  await adminDb.doc(`games/${GAME_ID}/players/${small1}`).update({ role: "solo" });

  // small1 is now solo — submit should pass trivially.
  const clearedResult = await submitDecisionSmall1({ ...validDecision });
  assert(clearedResult.data.submitted === true,
    "cleared teammate (role=solo) can still submitDecision");
  console.log("  ✓ cleared teammate (role=solo) submits successfully");

  console.log("\nAll fallback-role tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
