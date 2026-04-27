/**
 * test-revenue-flow.js
 *
 * Integration test for the revenue simulation flow.
 * Seeds a game at round_1_roster, writes decisions, calls advanceGamePhase
 * to trigger simulation, and verifies results are persisted correctly.
 */

const { initializeApp: initializeAdminApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
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
const GAME_ID = "revenue-flow-game";
const ROUND_ID = "round_1";
const PLAYER_A = "uid_player_a";
const PLAYER_B = "uid_player_b";

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} must be set by Firebase emulators:exec.`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} Expected ${expected}, got ${actual}.`);
  }
}

function assertNumber(value, message) {
  if (typeof value !== "number" || isNaN(value)) {
    throw new Error(`${message} Expected a number, got ${JSON.stringify(value)}.`);
  }
}

async function seedGame(db, professorId) {
  await db.doc(`games/${GAME_ID}`).set({
    joinCode: "REV234",
    phase: "round_1_roster",
    round: 1,
    currentRound: 1,
    totalRounds: 3,
    phaseEndTime: null,
    submittedCount: 2,
    totalPlayers: 2,
    paused: false,
    professorId,
    professorUid: professorId,
    createdAt: null,
    startedAt: null,
    endedAt: null,
  });

  await db.doc(`games/${GAME_ID}/config/params`).set({
    unitCostPerProduct: 1,
    specialtyChefCap: 3,
    // Force-zero noise so the simulation is deterministic across reruns;
    // other coefficients fall back to DEFAULT_GAME_CONFIG.
    revenueCoefficients: { noiseMin: 0, noiseMax: 0 },
  });

  for (const [uid, name] of [[PLAYER_A, "Rolling Scone"], [PLAYER_B, "Bagel Bros"]]) {
    await db.doc(`games/${GAME_ID}/players/${uid}`).set({
      uid,
      playerId: uid,
      displayName: name,
      bakeryName: `${name} Bakery`,
      role: "solo",
      budgetCurrent: 10000,
      cumulativeRevenue: 0,
      specialtyChefs: [],
      sousChefCount: 0,
      consecutiveMissedRounds: 0,
      disconnected: false,
    });

    await db.doc(`games/${GAME_ID}/players/${uid}/decisions/${ROUND_ID}`).set({
      round: 1,
      submittedAt: Timestamp.fromMillis(Date.now()),
      menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: true, matcha: false },
      quantities: { croissant: 50, cookie: 50, bagel: 50, coffee: 50 },
      sousChefCount: 2,
      sousChefAssignments: { croissant: 1, coffee: 1 },
    });
  }
}

async function main() {
  requireEnv("FIRESTORE_EMULATOR_HOST");
  requireEnv("FIREBASE_AUTH_EMULATOR_HOST");

  initializeAdminApp({ projectId: PROJECT_ID });
  const db = getFirestore();

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

  const { user: professor } = await signInAnonymously(auth);
  await seedGame(db, professor.uid);

  const advanceGamePhase = httpsCallable(functions, "advanceGamePhase");

  // Advance from round_1_roster → simulating (triggers simulation synchronously)
  const result = await advanceGamePhase({ gameId: GAME_ID });
  assertEqual(result.data.phase, "results_ready", "Phase after simulation should be results_ready.");
  console.log("  ✓ advanceGamePhase: round_1_roster → simulating → results_ready");

  const [
    playerASnap,
    playerBSnap,
    resultASnap,
    resultBSnap,
    roundSnap,
    leaderboardSnap,
    csvASnap,
  ] = await Promise.all([
    db.doc(`games/${GAME_ID}/players/${PLAYER_A}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_B}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_A}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_B}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/leaderboard/latest`).get(),
    db.doc(`games/${GAME_ID}/csvRows/${PLAYER_A}/rounds/${ROUND_ID}`).get(),
  ]);

  // Round doc
  assertEqual(roundSnap.get("simulationStatus"), "complete", "Round simulationStatus should be 'complete'.");
  console.log("  ✓ rounds/round_1.simulationStatus = 'complete'");

  // Player round docs exist and have numeric results
  if (!resultASnap.exists) throw new Error("FAIL: players/PLAYER_A/rounds/round_1 doc missing.");
  if (!resultBSnap.exists) throw new Error("FAIL: players/PLAYER_B/rounds/round_1 doc missing.");
  assertNumber(resultASnap.get("revenueGross"), "Player A revenueGross");
  assertNumber(resultASnap.get("budgetAfter"), "Player A budgetAfter");
  assertNumber(resultBSnap.get("revenueGross"), "Player B revenueGross");
  assertNumber(resultBSnap.get("budgetAfter"), "Player B budgetAfter");
  console.log("  ✓ players/{uid}/rounds/round_1 docs written with revenueGross and budgetAfter");

  // Player live budget updated
  assertNumber(playerASnap.get("budgetCurrent"), "Player A budgetCurrent");
  assertNumber(playerBSnap.get("budgetCurrent"), "Player B budgetCurrent");
  console.log("  ✓ players/{uid}.budgetCurrent updated after simulation");

  // Leaderboard
  if (!leaderboardSnap.exists) throw new Error("FAIL: leaderboard/latest doc missing.");
  const rankings = leaderboardSnap.data().rankings;
  if (!Array.isArray(rankings) || rankings.length !== 2) {
    throw new Error(`FAIL: leaderboard rankings should have 2 entries, got ${rankings && rankings.length}.`);
  }
  console.log("  ✓ leaderboard/latest written with 2 rankings");

  // CSV rows
  if (!csvASnap.exists) throw new Error("FAIL: csvRows/PLAYER_A/rounds/round_1 doc missing.");
  assertNumber(csvASnap.get("row.revenue"), "CSV row revenue");
  console.log("  ✓ csvRows/{uid}/rounds/round_1 written");

  console.log("\nRevenue simulation flow passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
