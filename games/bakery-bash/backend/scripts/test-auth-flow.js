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
const GAME_ID = "auth-flow-game";
const JOIN_CODE = "AUTH01";

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} must be set by Firebase emulators:exec.`);
  }
}

async function seedLobbyGame() {
  initializeAdminApp({
    projectId: PROJECT_ID,
  });

  const db = getFirestore();

  await db.doc(`games/${GAME_ID}`).set({
    joinCode: JOIN_CODE,
    phase: "lobby",
    currentRound: 1,
    totalRounds: 5,
    phaseEndTime: null,
    submittedCount: 0,
    totalPlayers: 0,
    paused: false,
    professorId: "uid_professor",
    createdAt: null,
    startedAt: null,
    endedAt: null,
  });

  await db.doc(`games/${GAME_ID}/config/params`).set({
    startingBudget: 2000,
    costPerStaffPerRound: 50,
    unitCostPerProduct: 1,
    credit: {
      overdraftEnabled: false,
      creditCostRate: null,
      chargeTiming: null,
    },
    staffingCost: {
      baseCostPerStaff: 50,
      escalationCurve: null,
    },
  });
}

async function main() {
  requireEnv("FIRESTORE_EMULATOR_HOST");
  requireEnv("FIREBASE_AUTH_EMULATOR_HOST");

  await seedLobbyGame();

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
  const uid = anonymousUser.user.uid;

  if (!uid) {
    throw new Error("Anonymous sign-in did not return a uid.");
  }

  const joinGame = httpsCallable(functions, "joinGame");
  const firstJoin = await joinGame({
    joinCode: JOIN_CODE,
    displayName: "The Rolling Scone",
  });

  if (firstJoin.data.uid !== uid || firstJoin.data.playerId !== uid) {
    throw new Error("joinGame did not return the authenticated user's uid.");
  }

  if (firstJoin.data.gameId !== GAME_ID) {
    throw new Error(`Expected gameId ${GAME_ID}, got ${firstJoin.data.gameId}.`);
  }

  const db = getFirestore();
  const playerRef = db.doc(`games/${GAME_ID}/players/${uid}`);
  const playerSnap = await playerRef.get();

  if (!playerSnap.exists) {
    throw new Error("joinGame did not create the player document.");
  }

  const player = playerSnap.data();

  if (player.uid !== uid) {
    throw new Error("Player document uid does not match Auth uid.");
  }

  if (
    player.budgetCurrent !== 500000 ||
    player.cumulativeRevenue !== 0
  ) {
    throw new Error("Player document was not initialized with expected state.");
  }

  const secondJoin = await joinGame({
    joinCode: JOIN_CODE,
    displayName: "Crumb Club",
  });

  if (secondJoin.data.uid !== uid) {
    throw new Error("Second join did not reuse the same Auth uid.");
  }

  const updatedPlayerSnap = await playerRef.get();
  const gameSnap = await db.doc(`games/${GAME_ID}`).get();

  if (updatedPlayerSnap.get("displayName") !== "Crumb Club") {
    throw new Error("Second join did not update the existing display name.");
  }

  if (gameSnap.get("totalPlayers") !== 1) {
    throw new Error("Repeated join incremented totalPlayers more than once.");
  }

  console.log("Anonymous Auth uid:", uid);
  console.log("Player document:", `games/${GAME_ID}/players/${uid}`);
  console.log("joinGame auth flow passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
