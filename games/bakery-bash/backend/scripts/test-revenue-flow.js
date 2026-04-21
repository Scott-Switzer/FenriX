const { initializeApp: initializeAdminApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require("firebase-admin/firestore");

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
    displayName,
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
        coffee: false,
        matcha: false,
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
  };
}

function decision(overrides = {}) {
  return {
    round: 1,
    submittedAt: FieldValue.serverTimestamp(),
    staffCount: 3,
    adSpend: 0,
    menu: {
      croissant: true,
      cookie: true,
      bagel: true,
      sandwich: false,
      coffee: false,
      matcha: false,
    },
    productPrices: {
      croissant: 5,
      cookie: 5,
      bagel: 5,
      sandwich: 0,
      coffee: 0,
      matcha: 0,
    },
    quantities: {
      croissant: 10,
      cookie: 10,
      bagel: 10,
      sandwich: 0,
      coffee: 0,
      matcha: 0,
    },
    adBid: {
      adType: null,
      amount: 0,
    },
    chefBid: {
      skillLevel: 0,
      amount: 0,
    },
    ...overrides,
  };
}

async function seedGame(db) {
  await db.doc(`games/${GAME_ID}`).set({
    joinCode: "REV001",
    phase: "closing_hours",
    currentRound: 1,
    totalRounds: 5,
    phaseEndTime: null,
    submittedCount: 0,
    totalPlayers: 2,
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
    revenueModel: {
      base: 500,
      staffCoefficient: 30,
      priceCoefficient: -15,
      adSpendCoefficient: 0.8,
      numProductsCoefficient: 50,
      noiseMin: 0,
      noiseMax: 0,
    },
    adBonuses: {
      TV: 200,
      Billboard: 150,
      Radio: 100,
      Newspaper: 75,
    },
    chefBonusPerPoint: 5,
    customerPoolMultiplier: 100,
  });

  await db
    .doc(`games/${GAME_ID}/players/${PLAYER_A}`)
    .set(basePlayer(PLAYER_A, "The Rolling Scone"));
  await db
    .doc(`games/${GAME_ID}/players/${PLAYER_B}`)
    .set(basePlayer(PLAYER_B, "Bagel Bros"));
}

async function waitForSimulation(db) {
  const deadline = Date.now() + 15000;
  const gameRef = db.doc(`games/${GAME_ID}`);

  while (Date.now() < deadline) {
    const gameSnap = await gameRef.get();
    if (gameSnap.get("phase") === "results") {
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

  initializeAdminApp({ projectId: PROJECT_ID });
  const db = getFirestore();

  await seedGame(db);

  await db
    .doc(`games/${GAME_ID}/players/${PLAYER_A}/decisions/${ROUND_ID}`)
    .set(
      decision({
        submittedAt: Timestamp.fromMillis(2000),
        staffCount: 3,
        adSpend: 100,
        adBid: { adType: "TV", amount: 50 },
        chefBid: { skillLevel: 80, amount: 100 },
      })
    );
  await db
    .doc(`games/${GAME_ID}/players/${PLAYER_B}/decisions/${ROUND_ID}`)
    .set(
      decision({
        submittedAt: Timestamp.fromMillis(1000),
        staffCount: 2,
        adBid: { adType: "TV", amount: 50 },
        chefBid: { skillLevel: 80, amount: 100 },
      })
    );

  await waitForSimulation(db);

  const [
    playerASnap,
    playerBSnap,
    resultASnap,
    resultBSnap,
    roundSnap,
    leaderboardSnap,
    csvSnap,
    emailSnap,
  ] = await Promise.all([
    db.doc(`games/${GAME_ID}/players/${PLAYER_A}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_B}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_A}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_B}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/leaderboard/latest`).get(),
    db.doc(`games/${GAME_ID}/csvRows/${PLAYER_A}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_A}/emails/round_2_data`).get(),
  ]);

  assertEqual(resultASnap.get("revenue"), 745, "Player A revenue mismatch.");
  assertEqual(resultASnap.get("budgetAfter"), 2465, "Player A budget mismatch.");
  assertEqual(resultASnap.get("headchefSkill"), 0, "Player A chef skill mismatch.");
  assertEqual(resultASnap.get("adTypeWon"), null, "Player A ad win mismatch.");
  assertEqual(resultBSnap.get("revenue"), 1235, "Player B revenue mismatch.");
  assertEqual(resultBSnap.get("budgetAfter"), 2955, "Player B budget mismatch.");
  assertEqual(resultBSnap.get("headchefSkill"), 80, "Player B chef skill mismatch.");
  assertEqual(resultBSnap.get("adTypeWon"), "TV", "Player B ad win mismatch.");
  assertEqual(playerASnap.get("budgetCurrent"), 2465, "Player A live budget mismatch.");
  assertEqual(playerBSnap.get("budgetCurrent"), 2955, "Player B live budget mismatch.");
  assertEqual(roundSnap.get("simulationStatus"), "complete", "Round status mismatch.");
  assertEqual(
    roundSnap.get("auctionResults.ads.TV.winnerId"),
    PLAYER_B,
    "Ad auction tie-breaker mismatch."
  );
  assertEqual(
    roundSnap.get("auctionResults.chef.winnerId"),
    PLAYER_B,
    "Chef auction tie-breaker mismatch."
  );
  assertEqual(
    roundSnap.get("auctionResults.ads.TV.tieBreaker"),
    "earliest_submission",
    "Ad auction tie-breaker label mismatch."
  );
  assertEqual(
    leaderboardSnap.data().rankings[0].playerId,
    PLAYER_B,
    "Leaderboard winner mismatch."
  );
  assertEqual(csvSnap.get("row.revenue"), 745, "CSV row revenue mismatch.");
  assertEqual(emailSnap.get("type"), "round_data_csv", "Email type mismatch.");
  assertEqual(emailSnap.get("round"), 2, "Email target round mismatch.");
  const emailAttachment = emailSnap.data().attachments[0];
  assertEqual(
    emailAttachment.contentType,
    "text/csv",
    "Email attachment content type mismatch."
  );
  assertEqual(
    emailAttachment.rowCount,
    1,
    "Email attachment row count mismatch."
  );

  const emailCsv = emailAttachment.csvText;
  if (!emailCsv.includes("day,revenue,num_products") || !emailCsv.includes("1,745,3")) {
    throw new Error("Email CSV attachment did not include the expected round row.");
  }

  console.log("Revenue simulation flow passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
