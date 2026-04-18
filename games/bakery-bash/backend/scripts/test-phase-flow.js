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

function assertPhaseEndTime(value, message) {
  if (typeof value !== "number" || value <= Date.now()) {
    throw new Error(message);
  }
}

async function seedLobbyGame(db, professorId) {
  await db.doc(`games/${GAME_ID}`).set({
    joinCode: "PHASE1",
    phase: "lobby",
    currentRound: 1,
    totalRounds: 5,
    phaseEndTime: null,
    submittedCount: 0,
    totalPlayers: 0,
    paused: false,
    professorId,
    createdAt: null,
    startedAt: null,
    endedAt: null,
  });

  await db.doc(`games/${GAME_ID}/config/params`).set({
    phaseDurations: {
      email: 30,
      decide: 300,
      bid_ad: 60,
      bid_chef: 60,
      roster: 60,
      simulating: 30,
      results: 60,
    },
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

  const startResult = await startGame({ gameId: GAME_ID });
  assertEqual(startResult.data.phase, "round_1_email", "Start phase mismatch.");
  assertEqual(startResult.data.currentRound, 1, "Start round mismatch.");

  let gameSnap = await db.doc(`games/${GAME_ID}`).get();
  assertEqual(gameSnap.get("phase"), "round_1_email", "Stored start phase mismatch.");

  const decideResult = await advanceGamePhase({ gameId: GAME_ID });
  assertEqual(decideResult.data.phase, "round_1_decide", "Decide phase mismatch.");
  assertEqual(decideResult.data.currentRound, 1, "Decide round mismatch.");

  gameSnap = await db.doc(`games/${GAME_ID}`).get();
  assertEqual(gameSnap.get("phase"), "round_1_decide", "Stored decide phase mismatch.");

  console.log("Phase state machine flow passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
