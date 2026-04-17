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
    phase: "closing_hours",
    currentRound: 1,
    totalRounds: 5,
    phaseEndTime: null,
    phaseStartedAt: null,
    submittedCount: 0,
    totalPlayers: 1,
    paused: false,
    professorId: "uid_professor",
    createdAt: null,
    startedAt: null,
    endedAt: null,
  });

  await db.doc(`games/${GAME_ID}/config/params`).set({
    revenueModel: {
      base: 500,
      staffCoefficient: 30,
      priceCoefficient: -15,
      adSpendCoefficient: 0.8,
      numProductsCoefficient: 50,
      noiseMin: 0,
      noiseMax: 0,
    },
    phaseDurations: {
      closing_hours: 180,
      auction: 90,
      open_for_business: 30,
      results: 60,
    },
  });

  await db.doc(`games/${GAME_ID}/players/${playerId}`).set({
    uid: playerId,
    displayName: "Submit Scones",
    joinedAt: null,
    budgetCurrent: 2000,
    creditBalance: 0,
    cumulativeRevenue: 0,
    pendingDecision: {
      submitted: false,
      submittedAt: null,
      staffCount: 3,
      adSpend: 0,
      menu: {
        croissant: true,
        cookie: true,
        bagel: true,
        sandwich: false,
        latte: false,
        matchaLatte: false,
      },
      productPrices: {},
      quantities: {},
    },
    pendingBids: {
      adBid: { adType: null, amount: 0 },
      chefBid: { skillLevel: 0, amount: 0 },
    },
    lastRoundResult: {
      round: 0,
      revenue: 0,
      customerCount: 0,
      customerSatisfaction: 0,
      headchefSkill: 0,
      adTypeWon: null,
      productsSold: {},
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
  const uid = anonymousUser.user.uid;
  await seedGame(db, uid);

  const submitDecision = httpsCallable(functions, "submitDecision");

  try {
    await submitDecision({
      gameId: GAME_ID,
      menu: {
        croissant: true,
        bagel: true,
        latte: false,
      },
      productPrices: {
        croissant: 5,
        bagel: 6,
      },
      quantities: {
        croissant: 10,
        bagel: 10,
      },
      staffCount: 3,
      adSpend: 0,
    });
    throw new Error("Invalid menu submission unexpectedly succeeded.");
  } catch (error) {
    if (error.code !== "functions/invalid-argument") {
      throw error;
    }
    if (!error.message.includes("at least one drink")) {
      throw new Error(`Unexpected validation message: ${error.message}`);
    }
  }

  try {
    await submitDecision({
      gameId: GAME_ID,
      menu: {
        croissant: true,
        bagel: true,
        latte: true,
      },
      productPrices: {
        croissant: 5,
        bagel: 6,
        latte: 4,
      },
      quantities: {
        croissant: 10,
        bagel: 10,
        latte: 10,
      },
      staffCount: 20,
      adSpend: 1200,
      adType: "tv",
      chefBid: {
        skillLevel: 50,
        amount: 100,
      },
    });
    throw new Error("Unaffordable decision unexpectedly succeeded.");
  } catch (error) {
    if (error.code !== "functions/failed-precondition") {
      throw error;
    }
    if (!error.message.includes("current budget")) {
      throw new Error(`Unexpected budget validation message: ${error.message}`);
    }
  }

  const result = await submitDecision({
    gameId: GAME_ID,
    round: 1,
    menu: {
      croissant: true,
      bagel: true,
      latte: true,
    },
    productPrices: {
      croissant: 5,
      bagel: 6,
      latte: 4,
    },
    quantities: {
      croissant: 10,
      bagel: 10,
      latte: 10,
    },
    staffCount: 3,
    adSpend: 25,
    adType: "tv",
    chefBid: {
      skillLevel: 50,
      amount: 0,
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

  assertEqual(decisionSnap.get("staffCount"), 3, "Decision staff count mismatch.");
  assertEqual(decisionSnap.get("adSpend"), 25, "Decision ad spend mismatch.");
  assertEqual(decisionSnap.get("adBid.adType"), "TV", "Decision ad type mismatch.");
  assertEqual(decisionSnap.get("menu.matchaLatte"), false, "Matcha default mismatch.");
  assertEqual(decisionSnap.get("numProducts"), 3, "Decision product count mismatch.");
  assertEqual(playerSnap.get("pendingDecision.submitted"), true, "Pending state mismatch.");

  console.log("Submit decision flow passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
