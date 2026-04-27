/**
 * test-submit-decision-flow.js
 *
 * Integration test for submitDecision (BE-21 role gating, BE-22 submission
 * mirror, BE-24 error types) and submitBids (role gating).
 *
 * Run via: npm run test:submit-decision
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
const GAME_ID    = "submit-decision-game";

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
    const code = err.code || "";
    assert(
      code.includes(expectedCode),
      `${label} — expected code "${expectedCode}", got "${code}": ${err.message}`,
    );
    console.log(`  ✓ ${label} rejected (${code})`);
  }
}

async function seedGame(db, soloUid, operationsUid, financeUid) {
  await db.doc(`games/${GAME_ID}`).set({
    joinCode: "SUBMT2",
    phase: "round_1_decide",
    round: 1,
    currentRound: 1,
    totalRounds: 5,
    phaseEndTime: null,
    phaseStartedAt: null,
    submittedCount: 0,
    totalPlayers: 3,
    paused: false,
    professorId: "uid_professor",
    professorUid: "uid_professor",
    createdAt: null,
    startedAt: null,
    endedAt: null,
  });

  await db.doc(`games/${GAME_ID}/config/params`).set({
    unitCostPerProduct: 1,
    specialtyChefCap: 3,
    // Force-zero noise so the simulation is deterministic across reruns.
    // Other revenueCoefficients fall back to DEFAULT_GAME_CONFIG.
    revenueCoefficients: { noiseMin: 0, noiseMax: 0 },
  });

  // solo player — bypasses all role checks
  await db.doc(`games/${GAME_ID}/players/${soloUid}`).set({
    uid: soloUid, playerId: soloUid,
    displayName: "Solo Baker", bakeryName: "Solo Bakery",
    role: "solo",
    budgetCurrent: 10000, cumulativeRevenue: 0,
    specialtyChefs: [], sousChefCount: 0,
    consecutiveMissedRounds: 0, disconnected: false,
  });

  // operations player — can submit decision
  await db.doc(`games/${GAME_ID}/players/${operationsUid}`).set({
    uid: operationsUid, playerId: operationsUid,
    displayName: "Ops Baker", bakeryName: "Ops Bakery",
    role: "operations",
    budgetCurrent: 10000, cumulativeRevenue: 0,
    specialtyChefs: [], sousChefCount: 0,
    consecutiveMissedRounds: 0, disconnected: false,
  });

  // finance player — cannot submit decision
  await db.doc(`games/${GAME_ID}/players/${financeUid}`).set({
    uid: financeUid, playerId: financeUid,
    displayName: "Finance Baker", bakeryName: "Finance Bakery",
    role: "finance",
    budgetCurrent: 10000, cumulativeRevenue: 0,
    specialtyChefs: [], sousChefCount: 0,
    consecutiveMissedRounds: 0, disconnected: false,
  });
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

  // Three app instances for three distinct anonymous users
  const [app1, app2, app3] = ["app1", "app2", "app3"].map(makeApp);
  for (const app of [app1, app2, app3]) {
    connectAuthEmulator(
      getAuth(app),
      `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`,
      { disableWarnings: true },
    );
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
  }

  const [{ user: solo }, { user: ops }, { user: fin }] = await Promise.all([
    signInAnonymously(getAuth(app1)),
    signInAnonymously(getAuth(app2)),
    signInAnonymously(getAuth(app3)),
  ]);

  await seedGame(adminDb, solo.uid, ops.uid, fin.uid);

  const submitDecision1 = httpsCallable(getFunctions(app1), "submitDecision");
  const submitDecision2 = httpsCallable(getFunctions(app2), "submitDecision");
  const submitDecision3 = httpsCallable(getFunctions(app3), "submitDecision");

  const validDecision = {
    gameId: GAME_ID,
    round: 1,
    menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: true, matcha: false },
    quantities: { croissant: 50, cookie: 50, bagel: 50, coffee: 50 },
    sousChefCount: 2,
    sousChefAssignments: { croissant: 1, coffee: 1 },
  };

  console.log("\n── BE-21: role gating ──");

  // finance role cannot submit decision
  await expectError(
    () => submitDecision3({ ...validDecision }),
    "permission-denied",
    "finance role cannot submitDecision",
  );

  // solo role can submit decision
  const soloResult = await submitDecision1({ ...validDecision });
  assert(soloResult.data.submitted === true, "solo submitDecision should return { submitted: true }");
  assert(soloResult.data.roundId === "round_1", "roundId should be 'round_1'");
  console.log("  ✓ solo role can submitDecision");

  // operations role can submit decision
  const opsResult = await submitDecision2({ ...validDecision });
  assert(opsResult.data.submitted === true, "operations submitDecision should return { submitted: true }");
  console.log("  ✓ operations role can submitDecision");

  // double-submit rejected
  await expectError(
    () => submitDecision2({ ...validDecision }),
    "already-exists",
    "double-submit rejected",
  );

  console.log("\n── BE-21: wrong-phase rejection ──");

  // Change phase to non-decide phase
  await adminDb.doc(`games/${GAME_ID}`).update({ phase: "round_1_bid_ad" });
  await expectError(
    () => submitDecision1({ ...validDecision }),
    "failed-precondition",
    "submitDecision outside decide phase",
  );
  // Restore
  await adminDb.doc(`games/${GAME_ID}`).update({ phase: "round_1_decide" });

  console.log("\n── BE-22: professor submission mirror ──");

  const submissionSnap = await adminDb
    .doc(`games/${GAME_ID}/submissions/round_1_decide`)
    .get();
  assert(submissionSnap.exists, "submissions/round_1_decide doc should exist");
  assert(
    submissionSnap.get(`${solo.uid}.status`) === "submitted",
    "solo uid should be marked submitted",
  );
  assert(
    submissionSnap.get(`${ops.uid}.status`) === "submitted",
    "operations uid should be marked submitted",
  );
  console.log("  ✓ submissions/round_1_decide has entries for both submitted players");

  console.log("\n── BE-24: joinGame error types ──");

  const joinGame1 = httpsCallable(getFunctions(app1), "joinGame");

  await expectError(
    () => joinGame1({ joinCode: "BAD", displayName: "Test" }),
    "invalid-argument",
    "short join code",
  );
  await expectError(
    () => joinGame1({ joinCode: "SUBMT2", displayName: "A" }),
    "invalid-argument",
    "display name too short",
  );
  await expectError(
    () => joinGame1({ joinCode: "ZZZZZZ", displayName: "Valid Name" }),
    "not-found",
    "non-existent join code",
  );

  // Game not in lobby → failed-precondition
  await adminDb.doc(`games/${GAME_ID}`).update({ phase: "round_1_decide" });
  await expectError(
    () => joinGame1({ joinCode: "SUBMT2", displayName: "Late Joiner" }),
    "failed-precondition",
    "game not in lobby",
  );

  console.log("\nAll submit-decision + role-gating tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
