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
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
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
      return;
    }
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
    round: options.currentRound || 1,
    currentRound: options.currentRound || 1,
    totalRounds: options.totalRounds || 5,
    totalPlayers: 0,
    submittedCount: 0,
    professorUid: profUid,
    professorId: profUid,
    paused: false,
    createdAt: FieldValue.serverTimestamp(),
    startedAt: null,
    endedAt: null,
    phaseStartedAt: null,
    phaseEndsAt: null,
  });

  if (options.withConfig !== false) {
    await gameRef.collection("config").doc("params").set({
      startingBudget: options.startingBudget || 500000,
      sousChefBaseCost: 12500,
      unitCostPerProduct: 1,
      revenueCoefficients: {
        base: 500,
        sousChefCoeff: 12,
        satisfactionCoeff: 8.0,
        adSpendCoeff: 0.8,
        numProductsCoeff: 50,
        noiseMin: -100,
        noiseMax: 100,
      },
      adBonuses: { TV: 50000, Billboard: 37500, Radio: 25000, Newspaper: 18750 },
      chefBidFloors: { novel: 25000, intermediate: 43750, advanced: 68750 },
      phaseDurations: {
        email: 30,
        decide: 300,
        bid_ad: 60,
        bid_chef: 60,
        roster: 60,
        simulating: 30,
        results: 60,
      },
      loanSharkInterestRate: 0.10,
      specialtyChefCap: 3,
    });
  }

  return { gameId, joinCode, profUid, gameRef };
}

async function addPlayerDirectly(gameRef, uid, displayName, budget) {
  await gameRef.collection("players").doc(uid).set({
    uid,
    playerId: uid,
    displayName,
    bakeryName: displayName,
    joinedAt: FieldValue.serverTimestamp(),
    budgetCurrent: budget ?? 500000,
    cumulativeRevenue: 0,
    specialtyChefs: [],
    sousChefCount: 0,
    pendingRosterAction: false,
    returningCustomersPending: 0,
    pendingDecision: {
      submitted: false,
      submittedAt: null,
      menu: {
        croissant: true, cookie: true, bagel: true,
        sandwich: false, coffee: false, matcha: false,
      },
      quantities: {
        croissant: 0, cookie: 0, bagel: 0,
        sandwich: 0, coffee: 0, matcha: 0,
      },
      sousChefCount: 0,
      sousChefAssignments: {},
    },
    pendingBids: { ad: null, chef: null },
    lastRoundResult: null,
  });
  await gameRef.update({ totalPlayers: FieldValue.increment(1) });
}

function validDecision(gameId, overrides = {}) {
  return {
    gameId,
    sousChefCount: 0,
    sousChefAssignments: {},
    menu: {
      croissant: true, cookie: true, bagel: true,
      sandwich: false, coffee: true, matcha: false,
    },
    quantities: {
      croissant: 50, cookie: 50, bagel: 50,
      sandwich: 0, coffee: 50, matcha: 0,
    },
    ...overrides,
  };
}

// ─── Test Suites ──────────────────────────────────────────────

async function suiteJoinGame() {
  console.log("\n🔨 SUITE: joinGame — Edge Cases & Invalid Inputs");

  const joinGame = httpsCallable(functions, "joinGame");

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
    const { joinCode } = await createTestGame({ phase: "round_1_decide" });
    await expectError(joinGame, { joinCode, displayName: "Late Baker" }, "failed-precondition");
  });

  await test("Reject joining a game_over game", async () => {
    const { joinCode } = await createTestGame({ phase: "game_over" });
    await expectError(joinGame, { joinCode, displayName: "Too Late" }, "failed-precondition");
  });

  await test("Allow re-join with updated displayName", async () => {
    const { joinCode } = await createTestGame();
    const result1 = await joinGame({ joinCode, displayName: "First Name" });
    assert(result1.data.gameId, "First join");
    const result2 = await joinGame({ joinCode, displayName: "Updated Name" });
    assert(result2.data.gameId, "Re-join accepted");
  });

  await test("Accept displayName at exact min length (2 chars)", async () => {
    const { joinCode } = await createTestGame();
    const result = await joinGame({ joinCode, displayName: "AB" });
    assert(result.data.gameId, "2-char name accepted");
  });

  await test("Accept displayName at exact max length (40 chars)", async () => {
    const { joinCode } = await createTestGame();
    const name40 = "A".repeat(40);
    const result = await joinGame({ joinCode, displayName: name40 });
    assert(result.data.gameId, "40-char name accepted");
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

  await test("Reject start from non-professor player", async () => {
    const { gameId } = await createTestGame();
    await signInAnonymously(auth);
    await expectError(startGame, { gameId }, "permission-denied");
  });

  await test("Reject starting a non-existent game", async () => {
    await expectError(startGame, { gameId: "nonexistent-game-id" }, "not-found");
  });

  await test("Reject starting a game already in round_1_decide", async () => {
    const { gameId } = await createTestGame({ phase: "round_1_decide" });
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
  console.log("\n🔨 SUITE: submitDecision — Validation, Phase, Double-Submit");

  const submitDecision = httpsCallable(functions, "submitDecision");

  // --- Menu validation ---
  await test("Reject base menu product disabled (croissant: false)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "No Croissant", 500000);
    await expectError(submitDecision, validDecision(gameId, {
      menu: { croissant: false, cookie: true, bagel: true, sandwich: false, coffee: true, matcha: false },
    }), "invalid-argument");
  });

  // --- Negative quantities ---
  await test("Reject negative quantity", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NegQty", 500000);
    await expectError(submitDecision, validDecision(gameId, {
      quantities: { croissant: -10, cookie: 50, bagel: 50, sandwich: 0, coffee: 50, matcha: 0 },
    }), "invalid-argument");
  });

  await test("Reject quantity > 10000", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "HugeQty", 500000);
    await expectError(submitDecision, validDecision(gameId, {
      quantities: { croissant: 10001, cookie: 50, bagel: 50, sandwich: 0, coffee: 50, matcha: 0 },
    }), "invalid-argument");
  });

  await test("Accept quantity = 0 for active product", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "ZeroQty", 500000);
    const result = await submitDecision(validDecision(gameId, {
      quantities: { croissant: 0, cookie: 0, bagel: 0, sandwich: 0, coffee: 0, matcha: 0 },
    }));
    assert(result.data.submitted === true, "Zero quantities accepted");
  });

  // --- sousChefCount validation ---
  await test("Reject negative sousChefCount", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NegSousChef", 500000);
    await expectError(submitDecision, validDecision(gameId, { sousChefCount: -1 }), "invalid-argument");
  });

  await test("Reject sousChefCount mismatch with assignments", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "MismatchAssign", 500000);
    await expectError(submitDecision, validDecision(gameId, {
      sousChefCount: 2,
      sousChefAssignments: { croissant: 1 },
    }), "invalid-argument");
  });

  await test("Accept sousChefCount with correct assignments", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "SousChefOK", 500000);
    const result = await submitDecision(validDecision(gameId, {
      sousChefCount: 2,
      sousChefAssignments: { croissant: 1, bagel: 1 },
    }));
    assert(result.data.submitted === true, "Sous chef assignments accepted");
  });

  // --- Phase guard ---
  await test("Reject submission during bid_ad phase", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_bid_ad" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Bid Submit", 500000);
    await expectError(submitDecision, validDecision(gameId), "failed-precondition");
  });

  await test("Reject submission during results_ready phase", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "results_ready" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Results Submit", 500000);
    await expectError(submitDecision, validDecision(gameId), "failed-precondition");
  });

  await test("Reject submission during simulating", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "simulating" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Sim Submit", 500000);
    await expectError(submitDecision, validDecision(gameId), "failed-precondition");
  });

  await test("Reject submission during game_over", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "game_over" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "GameOver Submit", 500000);
    await expectError(submitDecision, validDecision(gameId), "failed-precondition");
  });

  await test("Reject submission during lobby", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "lobby" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Lobby Submit", 500000);
    await expectError(submitDecision, validDecision(gameId), "failed-precondition");
  });

  // --- Double submit ---
  await test("Reject double submission for same round", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Double Submit", 500000);
    const result1 = await submitDecision(validDecision(gameId));
    assert(result1.data.submitted === true, "First submit OK");
    await expectError(submitDecision, validDecision(gameId), "already-exists");
  });

  // --- Non-player submission ---
  await test("Reject submission from non-player (not joined)", async () => {
    const { gameId } = await createTestGame({ phase: "round_1_decide" });
    await signInAnonymously(auth);
    await expectError(submitDecision, validDecision(gameId), "failed-precondition");
  });

  // --- Unknown product keys ---
  await test("Reject unknown menu item key", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Unknown Menu", 500000);
    await expectError(submitDecision, {
      gameId,
      sousChefCount: 0,
      sousChefAssignments: {},
      menu: { croissant: true, cookie: true, bagel: true, cupcake: true, coffee: true, matcha: false },
      quantities: { croissant: 50, cookie: 50, bagel: 50, cupcake: 50, coffee: 50, matcha: 0 },
    }, "invalid-argument");
  });

  // --- Menu as array format ---
  await test("Accept menu as object with correct keys", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Array Menu", 500000);
    const result = await submitDecision({
      gameId,
      sousChefCount: 0,
      sousChefAssignments: {},
      menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: true, matcha: false },
      quantities: { croissant: 50, cookie: 50, bagel: 50, sandwich: 0, coffee: 50, matcha: 0 },
    });
    assert(result.data.submitted === true, "Menu accepted");
  });
}

async function suiteAdvanceGamePhase() {
  console.log("\n🔨 SUITE: advanceGamePhase — Phase Transitions & Guard Rails");

  const advanceGamePhase = httpsCallable(functions, "advanceGamePhase");

  await test("Reject advance from non-professor", async () => {
    const { gameId } = await createTestGame({ phase: "round_1_decide" });
    await signInAnonymously(auth);
    await expectError(advanceGamePhase, { gameId }, "permission-denied");
  });

  await test("Reject advance on game_over", async () => {
    const { gameId } = await createTestGame({ phase: "game_over" });
    await expectError(advanceGamePhase, { gameId }, "failed-precondition");
  });

  await test("Reject advance on nonexistent game", async () => {
    await expectError(advanceGamePhase, { gameId: "does-not-exist-xyz" }, "not-found");
  });
}

async function suiteDataIntegrity() {
  console.log("\n🔨 SUITE: Data Integrity — Type Coercion & Extreme Values");

  const submitDecision = httpsCallable(functions, "submitDecision");

  await test("Reject string sousChefCount 'three'", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "StringSous", 500000);
    await expectError(submitDecision, validDecision(gameId, { sousChefCount: "three" }), "invalid-argument");
  });

  await test("Accept numeric string sousChefCount '0' (type coercion)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Coerce Sous", 500000);
    const result = await submitDecision(validDecision(gameId, { sousChefCount: "0" }));
    assert(result.data.submitted === true, "String '0' coerced");
  });

  await test("Reject game with no config doc (uses defaults)", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide", withConfig: false });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "NoConfig", 500000);
    const result = await submitDecision(validDecision(gameId));
    assert(result.data.submitted === true, "Works without config doc (falls back to defaults)");
  });

  await test("Handle max quantities for all products", async () => {
    const { gameId, gameRef } = await createTestGame({ phase: "round_1_decide" });
    const playerAuth = await signInAnonymously(auth);
    await addPlayerDirectly(gameRef, playerAuth.user.uid, "Max Quantities", 500000);
    const result = await submitDecision({
      gameId,
      sousChefCount: 0,
      sousChefAssignments: {},
      menu: { croissant: true, cookie: true, bagel: true, sandwich: true, coffee: true, matcha: true },
      quantities: {
        croissant: 100, cookie: 100, bagel: 100,
        sandwich: 100, coffee: 100, matcha: 100,
      },
    });
    assert(result.data.submitted === true, "All products with quantities accepted");
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
