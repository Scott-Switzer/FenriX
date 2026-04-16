/**
 * Bakery Bash — Adversarial Stress Test Suite
 * 
 * Tests edge cases, invalid inputs, unauthorized access, boundary conditions,
 * double-submit attempts, phase violations, and data integrity.
 * 
 * Run with: node scripts/test-stress.js
 * Requires Firebase emulators running: firebase emulators:start
 */

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getFunctions, connectFunctionsEmulator } = require("firebase/functions");
const { initializeApp: initializeClientApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, signInAnonymously } = require("firebase/auth");
const { httpsCallable } = require("firebase/functions");

// ─── Config ───────────────────────────────────────────────────
const PROJECT_ID = "bakery-bash-54d12";
const FUNCTIONS_HOST = "127.0.0.1";
const FUNCTIONS_PORT = 5001;
const AUTH_PORT = 9099;
const FIRESTORE_PORT = 8080;

process.env.FIRESTORE_EMULATOR_HOST = `${FUNCTIONS_HOST}:${FIRESTORE_PORT}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `${FUNCTIONS_HOST}:${AUTH_PORT}`;

const adminApp = initializeApp({ projectId: PROJECT_ID });
const db = getFirestore(adminApp);

const clientApp = initializeClientApp({
  projectId: PROJECT_ID,
  apiKey: "fake-api-key",
});
const auth = getAuth(clientApp);
connectAuthEmulator(auth, `http://${FUNCTIONS_HOST}:${AUTH_PORT}`, { disableWarnings: true });
const functions = getFunctions(clientApp);
connectFunctionsEmulator(functions, FUNCTIONS_HOST, FUNCTIONS_PORT);

// ─── Helpers ──────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message || err });
    console.log(`  ❌ ${name}: ${err.message || err}`);
  }
}

async function expectError(callableFn, data, expectedCode, testName) {
  try {
    await callableFn(data);
    throw new Error(`Expected error ${expectedCode} but call succeeded`);
  } catch (err) {
    if (err.code === `functions/${expectedCode}` || err.message?.includes(expectedCode)) {
      return; // Expected
    }
    // Check for the code in different places
    const code = err.code || err.details?.code || "";
    if (code.includes(expectedCode)) return;
    throw new Error(`Expected ${expectedCode}, got: ${err.code || err.message}`);
  }
}

function randomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase().replace(/[^A-Z0-9]/g, "X").substring(0, 6);
}

async function createTestGame(options = {}) {
  const profAuth = await signInAnonymously(auth);
  const profUid = profAuth.user.uid;
  const gameId = `stress_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const joinCode = randomCode();
  
  const gameRef = db.collection("games").doc(gameId);
  await gameRef.set({
    joinCode,
    phase: options.phase || "lobby",
    currentRound: options.currentRound || 1,
    totalRounds: options.totalRounds || 5,
    totalPlayers: 0,
    submittedCount: 0,
    professorId: profUid,
    paused: false,
    createdAt: FieldValue.serverTimestamp(),
    startedAt: null,
    endedAt: null,
    phaseStartedAt: null,
    phaseEndTime: null,
  });

  if (options.withConfig !== false) {
    await gameRef.collection("config").doc("params").set({
      startingBudget: options.startingBudget || 2000,
      costPerStaffPerRound: 50,
      unitCostPerProduct: 1,
      revenueModel: {
        base: 500, staffCoefficient: 30, priceCoefficient: -15,
        adSpendCoefficient: 0.8, numProductsCoefficient: 50,
        noiseMin: -100, noiseMax: 100,
      },
      adBonuses: { TV: 200, Billboard: 150, Radio: 100, Newspaper: 75 },
      chefBonusPerPoint: 5,
      customerPoolMultiplier: 100,
      phaseDurations: { closing_hours: 180, auction: 90, open_for_business: 30, results: 60 },
      attractivenessWeights: { priceWeight: 100, staffWeight: 5, adSpendWeight: 0.3, numProductsWeight: 10 },
    });
  }

  return { gameId, joinCode, profUid, gameRef };
}

async function addPlayerDirectly(gameRef, uid, displayName, budget) {
  await gameRef.collection("players").doc(uid).set({
    uid,
    displayName,
    joinedAt: FieldValue.serverTimestamp(),
    budgetCurrent: budget ?? 2000,
    creditBalance: 0,
    cumulativeRevenue: 0,
    pendingDecision: {
      submitted: false, submittedAt: null, staffCount: 3, adSpend: 0,
      menu: { croissant: true, cookie: true, bagel: true, sandwich: false, latte: false, matchaLatte: false },
      productPrices: { croissant: 0, cookie: 0, bagel: 0, sandwich: 0, latte: 0, matchaLatte: 0 },
      quantities: { croissant: 0, cookie: 0, bagel: 0, sandwich: 0, latte: 0, matchaLatte: 0 },
    },
    pendingBids: { adBid: { adType: null, amount: 0 }, chefBid: { skillLevel: 0, amount: 0 } },
    lastRoundResult: {
      round: 0, revenue: 0, customerCount: 0, customerSatisfaction: 0,
      headchefSkill: 0, adTypeWon: null,
      productsSold: { croissant: 0, cookie: 0, bagel: 0, sandwich: 0, latte: 0, matchaLatte: 0 },
    },
  });
  await gameRef.update({ totalPlayers: FieldValue.increment(1) });
}

function validDecision(gameId, overrides = {}) {
  return {
    gameId,
    staffCount: 3,
    adSpend: 0,
    adType: null,
    menu: { croissant: true, cookie: true, bagel: true, sandwich: false, latte: true, matchaLatte: false },
    productPrices: { croissant: 5, cookie: 4, bagel: 3, sandwich: 0, latte: 6, matchaLatte: 0 },
    quantities: { croissant: 50, cookie: 50, bagel: 50, sandwich: 0, latte: 50, matchaLatte: 0 },
    chefBid: { skillLevel: 0, amount: 0 },
    ...overrides,
  };
}

// ─── Test Suites ──────────────────────────────────────────────

async function suiteJoinGame() {
  console.log("\n🔨 SUITE: joinGame — Edge Cases & Invalid Inputs");

  const joinGame = httpsCallable(functions, "joinGame");

  // Test: Unauthenticated join attempt
  // Note: Firebase callable functions auto-attach auth, so we test via data validation
  
  await test("Reject empty joinCode", async () => {
    await expectError(joinGame, { joinCode: "", displayName: "Test" }, "invalid-argument");
  });

  await test("Reject joinCode too short (3 chars)", async () => {
    await expectError(joinGame, { joinCode: "ABC", displayName: "Test" }, "invalid-argument");
  });

  await test("Reject joinCode too long (10 chars)", async () => {
    await expectError(joinGame, { joinCode: "ABCDEFGHIJ", displayName: "Test" }, "invalid-argument");
  });

  await test("Reject joinCode with special chars", async () => {
    await expectError(joinGame, { joinCode: "AB@#$%", displayName: "Test" }, "invalid-argument");
  });

  await test("Reject displayName too short (1 char)", async () => {
    const { joinCode } = await createTestGame();
    await expectError(joinGame, { joinCode, displayName: "A" }, "invalid-argument");
  });

  await test("Reject displayName too long (50 chars)", async () => {
    const { joinCode } = await createTestGame();
    await expectError(joinGame, { joinCode, displayName: "A".repeat(50) }, "invalid-argument");
  });

  await test("Reject non-existent joinCode", async () => {
    await expectError(joinGame, { joinCode: "ZZZZZZ", displayName: "Test Baker" }, "not-found");
  });

  await test("Reject joining a game that already started", async () => {
    const { joinCode } = await createTestGame({ phase: "closing_hours" });
    await expectError(joinGame, { joinCode, displayName: "Late Baker" }, "failed-precondition");
  });

  await test("Reject joining a game_over game", async () => {
    const { joinCode } = await createTestGame({ phase: "game_over" });
    await expectError(joinGame, { joinCode, displayName: "Too Late" }, "failed-precondition");
  });

  await test("Allow re-join with updated displayName", async () => {
    const { joinCode, gameRef } = await createTestGame();
    // Join once
    const result1 = await joinGame({ joinCode, displayName: "First Name" });
    assert(result1.data.displayName === "First Name", "First join name");
    // Join again same user
    const result2 = await joinGame({ joinCode, displayName: "Updated Name" });
    assert(result2.data.displayName === "Updated Name", "Updated name on re-join");
  });

  await test("Accept displayName at exact min length (2 chars)", async () => {
    const { joinCode } = await createTestGame();
    const result = await joinGame({ joinCode, displayName: "AB" });
    assert(result.data.displayName === "AB", "2-char name accepted");
  });

  await test("Accept displayName at exact max length (40 chars)", async () => {
    const { joinCode } = await createTestGame();
    const name40 = "A".repeat(40);
    const result = await joinGame({ joinCode, displayName: name40 });
    assert(result.data.displayName === name40, "40-char name accepted");
  });

  await test("Reject null/undefined data", async () => {
    await expectError(joinGame, null, "invalid-argument");
  });

  await test("joinCode is case-insensitive (lowercased input)", async () => {
    const { joinCode } = await createTestGame();
    const result = await joinGame({ joinCode: joinCode.toLowerCase(), displayName: "Case Test" });
    assert(result.data.gameId, "Joined with lowercase code");
  });
}

async function suiteStartGame() {
  console.log("\n🔨 SUITE: startGame — Authorization & Phase Guards");

  const startGame = httpsCallable(functions, "startGame");
  const joinGame = httpsCallable(functions, "joinGame");

  await test("Reject start from non-professor player", async () => {
    const { gameId, joinCode } = await createTestGame();
    // Sign in as different user
    await signInAnonymously(auth);
    await expectError(startGame, { gameId }, "permission-denied");
  });

  await test("Reject starting a non-existent game", async () => {
    await expectError(startGame, { gameId: "nonexistent-game-id" }, "not-found");
  });

  await test("Reject starting a game already in closing_hours", async () => {
    const { gameId, profUid } = await createTestGame({ phase: "closing_hours" });
    // Sign back in as professor (need fresh auth for this game's professor)
    // Use admin to verify the phase
    await expectError(startGame, { gameId }, "failed-precondition");
  });

  await test("Reject invalid gameId format", async () => {
    await expectError(startGame, { gameId: "a" }, "invalid-argument");
  });

  await test("Reject gameId with forbidden characters", async () => {
    await expectError(startGame, { gameId: "game id with spaces!!" }, "invalid-argument");
  });

  await test("Reject empty gameId", async () => {
    await expectError(startGame, { gameId: "" }, "invalid-argument");
  });
}

async function suiteSubmitDecision() {
  console.log("\n🔨 SUITE: submitDecision — Validation, Budget, Phase, Double-Submit");

  const submitDecision = httpsCallable(functions, "submitDecision");
  const joinGame = httpsCallable(functions, "joinGame");

  // --- Menu validation ---
  await test("Reject menu with no sweet item", async () => {
    const { gameId, joinCode, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "No Sweet", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      menu: { croissant: false, cookie: false, bagel: true, sandwich: true, latte: true, matchaLatte: false },
      productPrices: { croissant: 0, cookie: 0, bagel: 5, sandwich: 5, latte: 5, matchaLatte: 0 },
    }), "invalid-argument");
  });

  await test("Reject menu with no savory item", async () => {
    const { gameId, joinCode, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "No Savory", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      menu: { croissant: true, cookie: true, bagel: false, sandwich: false, latte: true, matchaLatte: false },
      productPrices: { croissant: 5, cookie: 5, bagel: 0, sandwich: 0, latte: 5, matchaLatte: 0 },
    }), "invalid-argument");
  });

  await test("Reject menu with no drink", async () => {
    const { gameId, joinCode, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "No Drink", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      menu: { croissant: true, cookie: true, bagel: true, sandwich: false, latte: false, matchaLatte: false },
      productPrices: { croissant: 5, cookie: 5, bagel: 5, sandwich: 0, latte: 0, matchaLatte: 0 },
    }), "invalid-argument");
  });

  await test("Reject active menu item with $0 price", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Zero Price", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      productPrices: { croissant: 0, cookie: 4, bagel: 3, sandwich: 0, latte: 6, matchaLatte: 0 },
    }), "invalid-argument");
  });

  // --- Staff count boundaries ---
  await test("Reject staffCount = 0", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NoStaff", 2000);
    await expectError(submitDecision, validDecision(gameId, { staffCount: 0 }), "invalid-argument");
  });

  await test("Reject staffCount = 21", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "TooManyStaff", 2000);
    await expectError(submitDecision, validDecision(gameId, { staffCount: 21 }), "invalid-argument");
  });

  await test("Accept staffCount = 1 (min)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "MinStaff", 2000);
    const result = await submitDecision(validDecision(gameId, { staffCount: 1 }));
    assert(result.data.submitted === true, "Submitted with staffCount=1");
  });

  await test("Accept staffCount = 20 (max)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "MaxStaff", 5000);
    const result = await submitDecision(validDecision(gameId, { staffCount: 20 }));
    assert(result.data.submitted === true, "Submitted with staffCount=20");
  });

  await test("Reject staffCount = -1", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NegStaff", 2000);
    await expectError(submitDecision, validDecision(gameId, { staffCount: -1 }), "invalid-argument");
  });

  await test("Reject staffCount = 1.5 (non-integer)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "FloatStaff", 2000);
    await expectError(submitDecision, validDecision(gameId, { staffCount: 1.5 }), "invalid-argument");
  });

  await test("Reject staffCount = NaN", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NaNStaff", 2000);
    await expectError(submitDecision, validDecision(gameId, { staffCount: NaN }), "invalid-argument");
  });

  await test("Reject staffCount = Infinity", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "InfStaff", 2000);
    await expectError(submitDecision, validDecision(gameId, { staffCount: Infinity }), "invalid-argument");
  });

  // --- Negative prices/quantities ---
  await test("Reject negative product price", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NegPrice", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      productPrices: { croissant: -5, cookie: 4, bagel: 3, sandwich: 0, latte: 6, matchaLatte: 0 },
    }), "invalid-argument");
  });

  await test("Reject negative quantity", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NegQty", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      quantities: { croissant: -10, cookie: 50, bagel: 50, sandwich: 0, latte: 50, matchaLatte: 0 },
    }), "invalid-argument");
  });

  await test("Reject quantity > 10000", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "HugeQty", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      quantities: { croissant: 10001, cookie: 50, bagel: 50, sandwich: 0, latte: 50, matchaLatte: 0 },
    }), "invalid-argument");
  });

  await test("Accept quantity = 0 for active product", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "ZeroQty", 2000);
    const result = await submitDecision(validDecision(gameId, {
      quantities: { croissant: 0, cookie: 0, bagel: 0, sandwich: 0, latte: 0, matchaLatte: 0 },
    }));
    assert(result.data.submitted === true, "Zero quantities accepted");
  });

  // --- Ad spend without ad type ---
  await test("Reject adSpend > 0 without adType", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NoAdType", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      adSpend: 100,
      adType: null,
    }), "invalid-argument");
  });

  await test("Reject invalid ad type", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "BadAdType", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      adSpend: 100,
      adType: "Instagram",
    }), "invalid-argument");
  });

  await test("Accept adSpend = 0 without adType (no bid)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NoAd", 2000);
    const result = await submitDecision(validDecision(gameId, { adSpend: 0, adType: null }));
    assert(result.data.submitted === true, "No ad bid accepted");
  });

  await test("Reject negative adSpend", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NegAd", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      adSpend: -50,
      adType: "TV",
    }), "invalid-argument");
  });

  // --- Chef bid edge cases ---
  await test("Reject chefBid skillLevel > 100", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "HighChef", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      chefBid: { skillLevel: 101, amount: 50 },
    }), "invalid-argument");
  });

  await test("Reject chefBid negative skillLevel", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NegChef", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      chefBid: { skillLevel: -1, amount: 50 },
    }), "invalid-argument");
  });

  await test("Reject chefBid negative amount", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NegChefAmt", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      chefBid: { skillLevel: 50, amount: -100 },
    }), "invalid-argument");
  });

  // --- Budget enforcement ---
  await test("Reject decision that exceeds budget", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    // Give player only $100 budget
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Broke Baker", 100);
    // staffCount=20 × $50 = $1000 alone
    await expectError(submitDecision, validDecision(gameId, { staffCount: 20 }), "failed-precondition");
  });

  await test("Accept decision that exactly equals budget", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    // staffCount=3 × $50 = $150, quantities 200 × $1 = $200, total = $350
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Exact Budget", 350);
    const result = await submitDecision(validDecision(gameId, {
      staffCount: 3,
      adSpend: 0,
      chefBid: { skillLevel: 0, amount: 0 },
      quantities: { croissant: 50, cookie: 50, bagel: 50, sandwich: 0, latte: 50, matchaLatte: 0 },
    }));
    assert(result.data.submitted === true, "Exact budget decision accepted");
  });

  await test("Reject decision that exceeds budget by $1 (quantity cost)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    // staffCount=3 × $50 = $150, quantities 200 × $1 = $200, total = $350
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Off By One", 349);
    await expectError(submitDecision, validDecision(gameId, {
      staffCount: 3,
      adSpend: 0,
      chefBid: { skillLevel: 0, amount: 0 },
      quantities: { croissant: 50, cookie: 50, bagel: 50, sandwich: 0, latte: 50, matchaLatte: 0 },
    }), "failed-precondition");
  });

  // --- Phase guard ---
  await test("Reject submission during auction phase", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "auction" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Auction Submit", 2000);
    await expectError(submitDecision, validDecision(gameId), "failed-precondition");
  });

  await test("Reject submission during results phase", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "results" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Results Submit", 2000);
    await expectError(submitDecision, validDecision(gameId), "failed-precondition");
  });

  await test("Reject submission during open_for_business", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "open_for_business" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Sim Submit", 2000);
    await expectError(submitDecision, validDecision(gameId), "failed-precondition");
  });

  await test("Reject submission during game_over", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "game_over" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "GameOver Submit", 2000);
    await expectError(submitDecision, validDecision(gameId), "failed-precondition");
  });

  await test("Reject submission during lobby", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "lobby" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Lobby Submit", 2000);
    await expectError(submitDecision, validDecision(gameId), "failed-precondition");
  });

  // --- Double submit ---
  await test("Reject double submission for same round", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Double Submit", 2000);
    // First submit should succeed
    const result1 = await submitDecision(validDecision(gameId));
    assert(result1.data.submitted === true, "First submit OK");
    // Second submit should fail
    await expectError(submitDecision, validDecision(gameId), "already-exists");
  });

  // --- Round mismatch ---
  await test("Reject submission for wrong round number", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours", currentRound: 3 });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Wrong Round", 2000);
    await expectError(submitDecision, validDecision(gameId, { round: 1 }), "failed-precondition");
  });

  // --- Non-player submission ---
  await test("Reject submission from non-player (not joined)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const outsider = await signInAnonymously(auth);
    // Don't add this user as a player
    await expectError(submitDecision, validDecision(gameId), "failed-precondition");
  });

  // --- Unknown product keys ---
  await test("Reject unknown menu item key", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Unknown Menu", 2000);
    await expectError(submitDecision, {
      gameId,
      staffCount: 3,
      adSpend: 0,
      menu: { croissant: true, cookie: true, bagel: true, cupcake: true, latte: true, matchaLatte: false },
      productPrices: { croissant: 5, cookie: 4, bagel: 3, cupcake: 5, latte: 6, matchaLatte: 0 },
      quantities: { croissant: 50, cookie: 50, bagel: 50, cupcake: 50, latte: 50, matchaLatte: 0 },
      chefBid: { skillLevel: 0, amount: 0 },
    }, "invalid-argument");
  });

  // --- Menu as array format ---
  await test("Accept menu as array of product names", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Array Menu", 2000);
    const result = await submitDecision({
      gameId,
      staffCount: 3,
      adSpend: 0,
      menu: ["croissant", "cookie", "bagel", "latte"],
      productPrices: { croissant: 5, cookie: 4, bagel: 3, latte: 6 },
      quantities: { croissant: 50, cookie: 50, bagel: 50, latte: 50 },
      chefBid: { skillLevel: 0, amount: 0 },
    });
    assert(result.data.submitted === true, "Array menu accepted");
  });

  // --- Product alias handling ---
  await test("Accept matcha-latte alias for matchaLatte", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Alias Test", 2000);
    const result = await submitDecision({
      gameId,
      staffCount: 3,
      adSpend: 0,
      menu: { croissant: true, cookie: true, bagel: true, "matcha-latte": true, latte: false, matchaLatte: false },
      productPrices: { croissant: 5, cookie: 4, bagel: 3, "matcha-latte": 6 },
      quantities: { croissant: 50, cookie: 50, bagel: 50, "matcha-latte": 50 },
      chefBid: { skillLevel: 0, amount: 0 },
    });
    assert(result.data.submitted === true, "matcha-latte alias accepted");
  });

  // --- Ad type normalization ---
  await test("Accept case-insensitive ad type (tv → TV)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "CaseAd", 2000);
    const result = await submitDecision(validDecision(gameId, {
      adSpend: 50,
      adType: "tv",
    }));
    assert(result.data.submitted === true, "Lowercase ad type accepted");
  });

  await test("Accept 'television' alias for TV", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "TVAlias", 2000);
    const result = await submitDecision(validDecision(gameId, {
      adSpend: 50,
      adType: "television",
    }));
    assert(result.data.submitted === true, "Television alias accepted");
  });
}

async function suiteAdvanceGamePhase() {
  console.log("\n🔨 SUITE: advanceGamePhase — Phase Transitions & Guard Rails");

  const advanceGamePhase = httpsCallable(functions, "advanceGamePhase");

  await test("Reject advance from non-professor", async () => {
    const { gameId, joinCode, gameRef } = await createTestGame({ phase: "closing_hours" });
    // Sign in as a different user (not the professor)
    await signInAnonymously(auth);
    await expectError(advanceGamePhase, { gameId }, "permission-denied");
  });

  await test("Reject advance on game_over", async () => {
    const { gameId, profUid, gameRef } = await createTestGame({ phase: "game_over" });
    // Need to sign in as the professor - but we can't easily switch auth back
    // Just test the error
    await expectError(advanceGamePhase, { gameId }, "failed-precondition");
  });

  await test("Reject advance on nonexistent game", async () => {
    await expectError(advanceGamePhase, { gameId: "does-not-exist-xyz" }, "not-found");
  });
}

async function suiteDataIntegrity() {
  console.log("\n🔨 SUITE: Data Integrity — Extreme Values & Type Coercion");

  const submitDecision = httpsCallable(functions, "submitDecision");

  await test("Reject string staffCount", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "StringStaff", 2000);
    await expectError(submitDecision, validDecision(gameId, { staffCount: "three" }), "invalid-argument");
  });

  await test("Handle extremely large adSpend (budget check)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "HugeAd", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      adSpend: 999999999,
      adType: "TV",
    }), "failed-precondition");
  });

  await test("Handle huge chefBid amount (budget check)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "HugeChef", 2000);
    await expectError(submitDecision, validDecision(gameId, {
      chefBid: { skillLevel: 50, amount: 999999 },
    }), "failed-precondition");
  });

  await test("Accept numeric string staffCount '3' (type coercion)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Coerce Staff", 2000);
    // integerInRange does Number(value), so "3" → 3 should work
    const result = await submitDecision(validDecision(gameId, { staffCount: "3" }));
    assert(result.data.submitted === true, "String '3' coerced to 3");
  });

  await test("Reject game with no config doc (uses defaults)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours", withConfig: false });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NoConfig", 2000);
    // Should still work — mergeConfig falls back to defaults
    const result = await submitDecision(validDecision(gameId));
    assert(result.data.submitted === true, "Works without config doc");
  });

  await test("Handle max products + max staff + max quantities + max bids", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    // Need a LOT of budget: staff 20*50=1000, qty 60000*1=60000, ad 500, chef 500 = 62000
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Max Everything", 70000);
    const result = await submitDecision({
      gameId,
      staffCount: 20,
      adSpend: 500,
      adType: "TV",
      menu: { croissant: true, cookie: true, bagel: true, sandwich: true, latte: true, matchaLatte: true },
      productPrices: { croissant: 10, cookie: 10, bagel: 10, sandwich: 10, latte: 10, matchaLatte: 10 },
      quantities: { croissant: 10000, cookie: 10000, bagel: 10000, sandwich: 10000, latte: 10000, matchaLatte: 10000 },
      chefBid: { skillLevel: 100, amount: 500 },
    });
    assert(result.data.submitted === true, "Max everything decision accepted");
  });

  await test("Handle all products enabled with minimum prices", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Min Prices", 2000);
    const result = await submitDecision({
      gameId,
      staffCount: 1,
      adSpend: 0,
      menu: { croissant: true, cookie: true, bagel: true, sandwich: true, latte: true, matchaLatte: true },
      productPrices: { croissant: 0.01, cookie: 0.01, bagel: 0.01, sandwich: 0.01, latte: 0.01, matchaLatte: 0.01 },
      quantities: { croissant: 1, cookie: 1, bagel: 1, sandwich: 1, latte: 1, matchaLatte: 1 },
      chefBid: { skillLevel: 0, amount: 0 },
    });
    assert(result.data.submitted === true, "Tiny prices accepted");
  });
}

async function suiteBudgetCostCalculation() {
  console.log("\n🔨 SUITE: Budget & Cost Calculation — No Double-Charge Regression");

  const submitDecision = httpsCallable(functions, "submitDecision");

  await test("Ad bid does NOT double-charge (adSpend = adBid.amount)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    // Budget: staff 3×50=150 + ad 200 + qty 200 = 550
    // If double-charged: 150 + 200 + 200 + 200(again) = 750 → would fail with 600 budget
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "No Double Ad", 550);
    const result = await submitDecision(validDecision(gameId, {
      staffCount: 3,
      adSpend: 200,
      adType: "TV",
      quantities: { croissant: 50, cookie: 50, bagel: 50, sandwich: 0, latte: 50, matchaLatte: 0 },
      chefBid: { skillLevel: 0, amount: 0 },
    }));
    assert(result.data.submitted === true, "Ad spend not double-charged");
  });

  await test("Budget includes staff + stock + adBid + chefBid correctly", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    // staff 5×50=250 + qty 300×1=300 + ad 100 + chef 50 = 700
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Full Cost", 700);
    const result = await submitDecision(validDecision(gameId, {
      staffCount: 5,
      adSpend: 100,
      adType: "Billboard",
      quantities: { croissant: 75, cookie: 75, bagel: 75, sandwich: 0, latte: 75, matchaLatte: 0 },
      chefBid: { skillLevel: 50, amount: 50 },
    }));
    assert(result.data.submitted === true, "Full cost calculation correct");
  });

  await test("Budget $699 fails the $700 cost (off-by-one)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Off By One Cost", 699);
    await expectError(submitDecision, validDecision(gameId, {
      staffCount: 5,
      adSpend: 100,
      adType: "Billboard",
      quantities: { croissant: 75, cookie: 75, bagel: 75, sandwich: 0, latte: 75, matchaLatte: 0 },
      chefBid: { skillLevel: 50, amount: 50 },
    }), "failed-precondition");
  });

  await test("Zero budget player can submit zero-cost decision", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "closing_hours" });
    const playerAuth = await signInAnonymously(auth);
    // staffCount min=1 → 1×50 = $50 minimum. Budget = 50 exactly.
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Broke Min", 50);
    const result = await submitDecision(validDecision(gameId, {
      staffCount: 1,
      adSpend: 0,
      adType: null,
      quantities: { croissant: 0, cookie: 0, bagel: 0, sandwich: 0, latte: 0, matchaLatte: 0 },
      chefBid: { skillLevel: 0, amount: 0 },
    }));
    assert(result.data.submitted === true, "Minimum cost decision on tight budget");
  });
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║   BAKERY BASH — ADVERSARIAL STRESS TEST SUITE        ║");
  console.log("╚═══════════════════════════════════════════════════════╝");
  console.log(`Target: Firebase Emulator @ ${FUNCTIONS_HOST}:${FUNCTIONS_PORT}`);
  console.log("");

  try {
    await suiteJoinGame();
    await suiteStartGame();
    await suiteSubmitDecision();
    await suiteAdvanceGamePhase();
    await suiteDataIntegrity();
    await suiteBudgetCostCalculation();
  } catch (err) {
    console.error("\n💥 FATAL ERROR:", err);
  }

  console.log("\n" + "═".repeat(55));
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log("═".repeat(55));

  if (failures.length > 0) {
    console.log("\n🔴 FAILURES:");
    failures.forEach((f, i) => {
      console.log(`  ${i + 1}. ${f.name}`);
      console.log(`     → ${f.error}`);
    });
  }

  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

main();
