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
const GAME_ID = "submit-decision-game";

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

async function seedGame(db, playerId) {
  await db.doc(`games/${GAME_ID}`).set({
    joinCode: "SUBMIT",
    phase: "round_1_decide",
    round: 1,
    currentRound: 1,
    totalRounds: 5,
    phaseEndsAt: null,
    phaseStartedAt: null,
    submittedCount: 0,
    totalPlayers: 1,
    paused: false,
    professorId: "uid_professor",
    professorUid: "uid_professor",
    createdAt: null,
    startedAt: null,
    endedAt: null,
  });

  await db.doc(`games/${GAME_ID}/config/params`).set({
    startingBudget: 500000,
    sousChefBaseCost: 12500,
    unitCostPerProduct: 1,
    revenueCoefficients: {
      base: 500,
      sousChefCoeff: 12,
      satisfactionCoeff: 8.0,
      adSpendCoeff: 0.8,
      numProductsCoeff: 50,
      noiseMin: 0,
      noiseMax: 0,
    },
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

  await db.doc(`games/${GAME_ID}/players/${playerId}`).set({
    uid: playerId,
    playerId,
    displayName: "Submit Scones",
    bakeryName: "Submit Scones",
    joinedAt: null,
    budgetCurrent: 500000,
    cumulativeRevenue: 0,
    specialtyChefs: [],
    sousChefCount: 0,
    pendingRosterAction: false,
    returningCustomersPending: 0,
    pendingDecision: {
      submitted: false,
      submittedAt: null,
      menu: {
        croissant: true,
        cookie: true,
        bagel: true,
        sandwich: false,
        coffee: false,
        matcha: false,
      },
      quantities: {
        croissant: 0,
        cookie: 0,
        bagel: 0,
        sandwich: 0,
        coffee: 0,
        matcha: 0,
      },
      sousChefCount: 0,
      sousChefAssignments: {},
    },
    pendingBids: {
      ad: null,
      chef: null,
    },
    lastRoundResult: null,
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
  const uid = anonymousUser.user.uid;
  await seedGame(db, uid);

  const submitDecision = httpsCallable(functions, "submitDecision");

  // Reject menu that disables a base product
  try {
    await submitDecision({
      gameId: GAME_ID,
      sousChefCount: 0,
      sousChefAssignments: {},
      menu: {
        croissant: false,
        cookie: true,
        bagel: true,
        sandwich: false,
        coffee: true,
        matcha: false,
      },
      quantities: {
        croissant: 0, cookie: 10, bagel: 10,
        sandwich: 0, coffee: 10, matcha: 0,
      },
    });
    throw new Error("Disabled base product submission unexpectedly succeeded.");
  } catch (error) {
    if (error.code !== "functions/invalid-argument") {
      throw error;
    }
  }

  // Valid submission
  const result = await submitDecision({
    gameId: GAME_ID,
    round: 1,
    sousChefCount: 0,
    sousChefAssignments: {},
    menu: {
      croissant: true,
      cookie: true,
      bagel: true,
      sandwich: false,
      coffee: true,
      matcha: false,
    },
    quantities: {
      croissant: 10,
      cookie: 10,
      bagel: 10,
      sandwich: 0,
      coffee: 10,
      matcha: 0,
    },
  });

  assertEqual(result.data.submitted, true, "submitDecision response mismatch.");
  assertEqual(result.data.roundId, "round_1", "submitDecision round mismatch.");

  const [decisionSnap, playerSnap] = await Promise.all([
    db.doc(`games/${GAME_ID}/players/${uid}/decisions/round_1`).get(),
    db.doc(`games/${GAME_ID}/players/${uid}`).get(),
  ]);

  if (!decisionSnap.exists) {
    throw new Error("submitDecision did not create a decision snapshot.");
  }

  assertEqual(decisionSnap.get("sousChefCount"), 0, "Decision sousChefCount mismatch.");
  assertEqual(decisionSnap.get("menu.coffee"), true, "Decision menu.coffee mismatch.");
  assertEqual(decisionSnap.get("menu.matcha"), false, "Decision menu.matcha mismatch.");
  assertEqual(decisionSnap.get("numProducts"), 4, "Decision product count mismatch.");
  assertEqual(playerSnap.get("pendingDecision.submitted"), true, "Pending state mismatch.");

  console.log("Submit decision flow passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
