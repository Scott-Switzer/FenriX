/**
 * test-chef-cap-enforcement.js
 *
 * BE-I02 regression: advanceGamePhase must refuse to leave `roster` while any
 * player has more than `specialtyChefCap` chefs on the roster. The professor
 * is expected to lay off the surplus (via layoffChef, or the UI's "Force
 * Layoff") before continuing.
 *
 * Flow:
 *   1. Seed a 1-player game directly in round_1_roster with 5 specialty chefs
 *      on the player (cap is 3).
 *   2. Professor calls advanceGamePhase. Expect failed-precondition with a
 *      message naming the player/team and the chef count.
 *   3. Trim the player's chefs down to 3 (simulating a lay-off).
 *   4. Professor calls advanceGamePhase again. Expect success → decide phase.
 *
 * Run via: npm run test:chef-cap
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
const GAME_ID = "chef-cap-enforcement-game";

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} must be set by Firebase emulators:exec.`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`FAIL: ${message} — expected ${expected}, got ${actual}.`);
  }
}

async function cleanSlate(db) {
  await db.recursiveDelete(db.doc(`games/${GAME_ID}`));
}

async function seedRosterGame(db, professorUid, playerUid, chefCount) {
  await db.doc(`games/${GAME_ID}`).set({
    joinCode: "CHEFCP",
    phase: "round_1_roster",
    round: 1,
    currentRound: 1,
    totalRounds: 3,
    phaseStartedAt: Timestamp.fromMillis(Date.now()),
    phaseEndsAt: null,
    submittedCount: 0,
    totalPlayers: 1,
    paused: false,
    professorId: professorUid,
    professorUid,
    createdAt: Timestamp.fromMillis(Date.now()),
    startedAt: Timestamp.fromMillis(Date.now()),
    endedAt: null,
  });

  await db.doc(`games/${GAME_ID}/config/params`).set({
    unitCostPerProduct: 1,
    specialtyChefCap: 3,
    chefPoolSize: 12,
  });

  const chefs = [];
  for (let i = 0; i < chefCount; i += 1) {
    chefs.push({
      id: `chef_${i + 1}`,
      name: `Chef ${i + 1}`,
      nationality: "French",
      gender: "female",
      skillTier: "novel",
      specialties: ["croissant", "coffee"],
      minBidFloor: 500,
    });
  }

  await db.doc(`games/${GAME_ID}/players/${playerUid}`).set({
    uid: playerUid,
    playerId: playerUid,
    displayName: "Solo Player",
    bakeryName: "Chef-Cap Bakery",
    role: "solo",
    teamId: null,
    budgetCurrent: 10000,
    cumulativeRevenue: 0,
    specialtyChefs: chefs,
    sousChefCount: 0,
    consecutiveMissedRounds: 0,
    disconnected: false,
    pendingRosterAction: chefs.length > 3,
  });
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
  const professorUid = professor.uid;
  const playerUid = professorUid; // professor is also the solo player in this fixture

  await cleanSlate(db);
  await seedRosterGame(db, professorUid, playerUid, /* chefCount */ 5);

  const advanceGamePhase = httpsCallable(functions, "advanceGamePhase");

  // -----------------------------------------------------------------------
  // 1. Attempt to advance out of roster while over cap — expect reject.
  // -----------------------------------------------------------------------
  let threw = false;
  try {
    await advanceGamePhase({ gameId: GAME_ID });
  } catch (err) {
    threw = true;
    const code = err && err.code;
    const message = (err && err.message) || "";
    assertEqual(
      code,
      "functions/failed-precondition",
      `Expected 'functions/failed-precondition', got '${code}'`
    );
    assert(
      /chef cap|over cap|specialty/i.test(message),
      `Error message should mention chef cap; got "${message}"`
    );
    console.log(`  ✓ advance blocked while over cap: "${message}"`);
  }
  assert(threw, "advanceGamePhase should have thrown while player was over cap.");

  const gameStillRoster = await db.doc(`games/${GAME_ID}`).get();
  assertEqual(
    gameStillRoster.get("phase"),
    "round_1_roster",
    "Phase should still be round_1_roster after blocked advance."
  );
  console.log("  ✓ game phase unchanged after blocked advance");

  // -----------------------------------------------------------------------
  // 2. Trim chefs down to cap (simulate lay-off), then retry advance.
  // -----------------------------------------------------------------------
  const playerRef = db.doc(`games/${GAME_ID}/players/${playerUid}`);
  const playerSnap = await playerRef.get();
  const trimmed = (playerSnap.get("specialtyChefs") || []).slice(0, 3);
  await playerRef.update({
    specialtyChefs: trimmed,
    pendingRosterAction: false,
  });
  console.log(`  ✓ trimmed player roster to ${trimmed.length} specialty chefs`);

  const afterAdvance = await advanceGamePhase({ gameId: GAME_ID });
  assertEqual(
    afterAdvance.data.phase,
    "round_1_decide",
    "Phase should advance to round_1_decide after resolving cap."
  );
  console.log("  ✓ advanceGamePhase: round_1_roster → round_1_decide (after lay-off)");

  console.log("\nChef-cap enforcement flow passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
