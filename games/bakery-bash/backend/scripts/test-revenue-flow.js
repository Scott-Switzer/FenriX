const { initializeApp: initializeAdminApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require("firebase-admin/firestore");
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

function basePlayer(uid, displayName) {
  return {
    uid,
    playerId: uid,
    displayName,
    bakeryName: displayName,
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
  };
}

function decision(overrides = {}) {
  return {
    round: 1,
    submittedAt: FieldValue.serverTimestamp(),
    sousChefCount: 0,
    sousChefAssignments: {},
    menu: {
      croissant: true,
      cookie: true,
      bagel: true,
      sandwich: false,
      coffee: false,
      matcha: false,
    },
    quantities: {
      croissant: 10,
      cookie: 10,
      bagel: 10,
      sandwich: 0,
      coffee: 0,
      matcha: 0,
    },
    numProducts: 3,
    ...overrides,
  };
}

async function seedGame(db) {
  await db.doc(`games/${GAME_ID}`).set({
    joinCode: "REV001",
    phase: "round_1_decide",
    round: 1,
    currentRound: 1,
    totalRounds: 5,
    phaseEndsAt: null,
    submittedCount: 0,
    totalPlayers: 2,
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
    adBonuses: {
      TV: 50000,
      Billboard: 37500,
      Radio: 25000,
      Newspaper: 18750,
    },
    chefBidFloors: {
      novel: 25000,
      intermediate: 43750,
      advanced: 68750,
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

  await db
    .doc(`games/${GAME_ID}/players/${PLAYER_A}`)
    .set(basePlayer(PLAYER_A, "The Rolling Scone"));
  await db
    .doc(`games/${GAME_ID}/players/${PLAYER_B}`)
    .set(basePlayer(PLAYER_B, "Bagel Bros"));
}

async function waitForResultsReady(db) {
  const deadline = Date.now() + 30000;
  const gameRef = db.doc(`games/${GAME_ID}`);

  while (Date.now() < deadline) {
    const gameSnap = await gameRef.get();
    if (gameSnap.get("phase") === "results_ready") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Revenue simulation did not complete before timeout.");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} Expected ${expected}, got ${actual}.`);
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

  await seedGame(db);

  // Seed decision docs directly (bypassing the callable so we can test
  // the simulation engine in isolation from the decision submit flow).
  await db
    .doc(`games/${GAME_ID}/players/${PLAYER_A}/decisions/${ROUND_ID}`)
    .set(
      decision({
        submittedAt: Timestamp.fromMillis(2000),
        sousChefCount: 0,
      })
    );
  await db
    .doc(`games/${GAME_ID}/players/${PLAYER_B}/decisions/${ROUND_ID}`)
    .set(
      decision({
        submittedAt: Timestamp.fromMillis(1000),
        sousChefCount: 0,
      })
    );

  // Advance through bid phases to trigger simulation.
  const professorAuth = await signInAnonymously(auth);
  await db.doc(`games/${GAME_ID}`).update({ professorUid: professorAuth.user.uid, professorId: professorAuth.user.uid });

  const advanceGamePhase = httpsCallable(functions, "advanceGamePhase");

  // round_1_decide → round_1_bid_ad → round_1_bid_chef → round_1_roster → simulating → results_ready
  await advanceGamePhase({ gameId: GAME_ID }); // → bid_ad
  await advanceGamePhase({ gameId: GAME_ID }); // → bid_chef
  await advanceGamePhase({ gameId: GAME_ID }); // → roster
  await advanceGamePhase({ gameId: GAME_ID }); // → simulating → results_ready

  await waitForResultsReady(db);

  const [
    playerASnap,
    playerBSnap,
    resultASnap,
    resultBSnap,
    roundSnap,
    leaderboardSnap,
    csvSnap,
  ] = await Promise.all([
    db.doc(`games/${GAME_ID}/players/${PLAYER_A}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_B}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_A}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_B}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/leaderboard/latest`).get(),
    db.doc(`games/${GAME_ID}/csvRows/${PLAYER_A}/rounds/${ROUND_ID}`).get(),
  ]);

  if (typeof resultASnap.get("revenueGross") !== "number") {
    throw new Error("Player A revenueGross is not a number.");
  }
  if (typeof resultASnap.get("budgetAfter") !== "number") {
    throw new Error("Player A budgetAfter is not a number.");
  }
  if (typeof resultBSnap.get("revenueGross") !== "number") {
    throw new Error("Player B revenueGross is not a number.");
  }
  if (typeof resultBSnap.get("budgetAfter") !== "number") {
    throw new Error("Player B budgetAfter is not a number.");
  }
  if (typeof playerASnap.get("budgetCurrent") !== "number") {
    throw new Error("Player A live budgetCurrent is not a number.");
  }
  if (typeof playerBSnap.get("budgetCurrent") !== "number") {
    throw new Error("Player B live budgetCurrent is not a number.");
  }
  assertEqual(roundSnap.get("simulationStatus"), "complete", "Round status mismatch.");
  if (!leaderboardSnap.exists) {
    throw new Error("Leaderboard doc not found.");
  }
  const rankings = leaderboardSnap.data().rankings;
  if (!Array.isArray(rankings) || rankings.length === 0) {
    throw new Error("Leaderboard rankings are empty.");
  }
  if (typeof csvSnap.get("row.revenue") !== "number" && typeof csvSnap.get("row") !== "object") {
    throw new Error("CSV row not found.");
  }

  console.log("Revenue simulation flow passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
