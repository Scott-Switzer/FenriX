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
const GAME_ID = "phase-flow-game";

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

async function seedLobbyGame(db, professorId) {
  await db.doc(`games/${GAME_ID}`).set({
    joinCode: "PHASE2",
    phase: "lobby",
    currentRound: 1,
    totalRounds: 5,
    phaseEndTime: null,
    submittedCount: 0,
    totalPlayers: 1,
    paused: false,
    professorId,
    professorUid: professorId,
    createdAt: null,
    startedAt: null,
    endedAt: null,
  });

  await db.doc(`games/${GAME_ID}/config/params`).set({
    phaseDurations: {
      email: 60,
      decide: 180,
      bid_ad: 90,
      bid_chef: 90,
      roster: 30,
      results_ready: 60,
    },
  });

  // Seed one player so startGame passes totalPlayers >= 1 check
  await db.doc(`games/${GAME_ID}/players/${professorId}`).set({
    uid: professorId,
    playerId: professorId,
    displayName: "Test Player",
    bakeryName: "Test Bakery",
    role: "solo",
    budgetCurrent: 10000,
    cumulativeRevenue: 0,
    specialtyChefs: [],
    sousChefCount: 0,
    consecutiveMissedRounds: 0,
    disconnected: false,
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

  const anonymousUser = await signInAnonymously(auth);
  const professorId = anonymousUser.user.uid;
  await seedLobbyGame(db, professorId);

  const startGame = httpsCallable(functions, "startGame");
  const advanceGamePhase = httpsCallable(functions, "advanceGamePhase");

  // startGame: lobby → round_1_email
  const startResult = await startGame({ gameId: GAME_ID });
  assertEqual(startResult.data.phase, "round_1_email", "Start phase mismatch.");
  assertEqual(startResult.data.round, 1, "Start round mismatch.");

  let gameSnap = await db.doc(`games/${GAME_ID}`).get();
  assertEqual(gameSnap.get("phase"), "round_1_email", "Stored start phase mismatch.");
  if (!gameSnap.get("phaseEndsAt")) {
    throw new Error("startGame did not store phaseEndsAt.");
  }
  console.log("  ✓ startGame: lobby → round_1_email");

  // advanceGamePhase: round_1_email → round_1_bid_ad
  const bidAdResult = await advanceGamePhase({ gameId: GAME_ID });
  assertEqual(bidAdResult.data.phase, "round_1_bid_ad", "Bid-ad phase mismatch.");
  assertEqual(bidAdResult.data.round, 1, "Bid-ad round mismatch.");

  gameSnap = await db.doc(`games/${GAME_ID}`).get();
  assertEqual(gameSnap.get("phase"), "round_1_bid_ad", "Stored bid-ad phase mismatch.");
  if (!gameSnap.get("phaseEndsAt")) {
    throw new Error("advanceGamePhase did not store phaseEndsAt for bid_ad.");
  }
  console.log("  ✓ advanceGamePhase: round_1_email → round_1_bid_ad");

  // advanceGamePhase: round_1_bid_ad → round_1_bid_chef
  const bidChefResult = await advanceGamePhase({ gameId: GAME_ID });
  assertEqual(bidChefResult.data.phase, "round_1_bid_chef", "Bid-chef phase mismatch.");
  console.log("  ✓ advanceGamePhase: round_1_bid_ad → round_1_bid_chef");

  // advanceGamePhase: round_1_bid_chef → round_1_roster
  const rosterResult = await advanceGamePhase({ gameId: GAME_ID });
  assertEqual(rosterResult.data.phase, "round_1_roster", "Roster phase mismatch.");
  console.log("  ✓ advanceGamePhase: round_1_bid_chef → round_1_roster");

  // advanceGamePhase: round_1_roster → round_1_decide
  const decideResult = await advanceGamePhase({ gameId: GAME_ID });
  assertEqual(decideResult.data.phase, "round_1_decide", "Decide phase mismatch.");
  assertEqual(decideResult.data.round, 1, "Decide round mismatch.");

  gameSnap = await db.doc(`games/${GAME_ID}`).get();
  assertEqual(gameSnap.get("phase"), "round_1_decide", "Stored decide phase mismatch.");
  if (!gameSnap.get("phaseEndsAt")) {
    throw new Error("advanceGamePhase did not store phaseEndsAt for decide.");
  }
  console.log("  ✓ advanceGamePhase: round_1_roster → round_1_decide");

  console.log("\nPhase state machine flow passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
