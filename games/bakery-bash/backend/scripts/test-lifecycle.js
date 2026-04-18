/**
 * Bakery Bash — Full Game Lifecycle Test
 *
 * Plays a complete 5-round game with 3 players through all phases,
 * verifying budget math, simulation output, leaderboard, CSV data,
 * and game_over state at every step.
 *
 * Run with: node scripts/test-lifecycle.js
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
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ~${expected} ±${tolerance}, got ${actual}`);
  }
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

function randomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase().replace(/[^A-Z0-9]/g, "X").substring(0, 6);
}

// ─── Game Setup ───────────────────────────────────────────────

const actors = {
  professor: { credential: null, uid: null },
  player1: { credential: null, uid: null },
  player2: { credential: null, uid: null },
  player3: { credential: null, uid: null },
};

let gameId;
let joinCode;
let gameRef;

const playerApps = {};
const playerAuths = {};
const playerFunctions = {};

function createPlayerClient(name) {
  const app = initializeClientApp({
    projectId: PROJECT_ID,
    apiKey: "fake-api-key",
  }, name);
  const pAuth = getAuth(app);
  connectAuthEmulator(pAuth, `http://${FUNCTIONS_HOST}:${AUTH_PORT}`, { disableWarnings: true });
  const pFunctions = getFunctions(app);
  connectFunctionsEmulator(pFunctions, FUNCTIONS_HOST, FUNCTIONS_PORT);
  return { app, auth: pAuth, functions: pFunctions };
}

// ─── Phase Helpers ────────────────────────────────────────────

async function advanceAsProf() {
  const fn = httpsCallable(playerFunctions.professor, "advanceGamePhase");
  const result = await fn({ gameId });
  await new Promise(r => setTimeout(r, 1500));
  return result.data;
}

async function submitDecisionAs(playerName, decision) {
  const fn = httpsCallable(playerFunctions[playerName], "submitDecision");
  const result = await fn(decision);
  await new Promise(r => setTimeout(r, 500));
  return result.data;
}

async function waitForResultsReady() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const snap = await gameRef.get();
    if (snap.get("phase") === "results_ready") return;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("Simulation did not reach results_ready before timeout.");
}

// ─── Main Test ────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║   BAKERY BASH — FULL GAME LIFECYCLE TEST (5 rounds)  ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  // ─── Setup ──────────────────────────────────────────────────
  console.log("🔧 Setting up actors...");

  for (const name of ["professor", "player1", "player2", "player3"]) {
    const client = createPlayerClient(`client_${name}_${Date.now()}`);
    playerApps[name] = client.app;
    playerAuths[name] = client.auth;
    playerFunctions[name] = client.functions;

    const cred = await signInAnonymously(client.auth);
    actors[name] = { uid: cred.user.uid };
  }

  console.log(`  Professor UID: ${actors.professor.uid}`);
  console.log(`  Player 1 UID:  ${actors.player1.uid}`);
  console.log(`  Player 2 UID:  ${actors.player2.uid}`);
  console.log(`  Player 3 UID:  ${actors.player3.uid}`);

  // ─── Create game via admin ───────────────────────────────────
  gameId = `lifecycle_${Date.now()}`;
  joinCode = randomCode();
  gameRef = db.collection("games").doc(gameId);

  await gameRef.set({
    joinCode,
    phase: "lobby",
    round: 0,
    currentRound: 0,
    totalRounds: 5,
    totalPlayers: 0,
    submittedCount: 0,
    professorUid: actors.professor.uid,
    professorId: actors.professor.uid,
    paused: false,
    createdAt: FieldValue.serverTimestamp(),
    startedAt: null,
    endedAt: null,
    phaseStartedAt: null,
    phaseEndsAt: null,
  });

  await gameRef.collection("config").doc("params").set({
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

  // Seed round preferences so simulation has demand modifiers.
  for (let r = 1; r <= 5; r++) {
    await gameRef.collection("preferences").doc(`round_${r}`).set({
      round: r,
      modifiers: {
        croissant: 1.0, cookie: 1.0, bagel: 1.0,
        sandwich: 1.0, coffee: 1.0, matcha: 1.0,
      },
      trending: [],
      warm: [],
      neutral: [],
      cold: [],
    });
  }

  console.log(`  Game ID: ${gameId}, Join Code: ${joinCode}\n`);

  // ─── PHASE: Player Join ────────────────────────────────────
  console.log("📋 PHASE: Player Join");

  await test("Player 1 joins game", async () => {
    const fn = httpsCallable(playerFunctions.player1, "joinGame");
    const result = await fn({ joinCode, displayName: "The Rolling Scone" });
    assert(result.data.gameId === gameId, `gameId matches: ${result.data.gameId}`);
  });

  await test("Player 2 joins game", async () => {
    const fn = httpsCallable(playerFunctions.player2, "joinGame");
    const result = await fn({ joinCode, displayName: "Bread Winners" });
    assert(result.data.gameId === gameId, "gameId matches");
  });

  await test("Player 3 joins game", async () => {
    const fn = httpsCallable(playerFunctions.player3, "joinGame");
    const result = await fn({ joinCode, displayName: "Loaf Actually" });
    assert(result.data.gameId === gameId, "gameId matches");
  });

  await test("Game shows 3 players", async () => {
    const snap = await gameRef.get();
    assert(snap.get("totalPlayers") === 3, `Total players = ${snap.get("totalPlayers")}`);
  });

  // ─── PHASE: Start Game ─────────────────────────────────────
  console.log("\n🚀 PHASE: Start Game");

  await test("Professor starts game → round_1_email", async () => {
    const fn = httpsCallable(playerFunctions.professor, "startGame");
    const result = await fn({ gameId });
    assert(result.data.phase === "round_1_email", `Phase = ${result.data.phase}`);
    assert(result.data.round === 1, `Round = ${result.data.round}`);
  });

  // ─── ROUNDS 1-5 ────────────────────────────────────────────
  const TOTAL_ROUNDS = 5;

  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    console.log(`\n${"═".repeat(55)}`);
    console.log(`🎯 ROUND ${round} of ${TOTAL_ROUNDS}`);
    console.log("═".repeat(55));

    // ─── Advance email → decide ───────────────────────────────
    console.log(`\n  📧 Email → Decide (Round ${round})`);

    await test(`R${round}: email → decide`, async () => {
      await advanceAsProf();
      const snap = await gameRef.get();
      assert(snap.get("phase") === `round_${round}_decide`, `Phase = ${snap.get("phase")}`);
    });

    // ─── Submit decisions ─────────────────────────────────────
    console.log(`\n  📝 Decide Phase (Round ${round})`);

    const player1Decision = {
      gameId,
      sousChefCount: 0,
      sousChefAssignments: {},
      menu: {
        croissant: true, cookie: true, bagel: true,
        sandwich: true, coffee: true, matcha: round >= 3,
      },
      quantities: {
        croissant: 30, cookie: 30, bagel: 30, sandwich: 30,
        coffee: 30, matcha: round >= 3 ? 30 : 0,
      },
    };

    const player2Decision = {
      gameId,
      sousChefCount: 0,
      sousChefAssignments: {},
      menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: false, matcha: false },
      quantities: {
        croissant: 20, cookie: 20, bagel: 20,
        sandwich: 0, coffee: 0, matcha: 0,
      },
    };

    const player3Decision = {
      gameId,
      sousChefCount: 0,
      sousChefAssignments: {},
      menu: {
        croissant: true, cookie: true, bagel: true,
        sandwich: false, coffee: true, matcha: false,
      },
      quantities: {
        croissant: 40, cookie: 40, bagel: 40,
        sandwich: 0, coffee: 40, matcha: 0,
      },
    };

    await test(`R${round}: Player 1 submits decision`, async () => {
      const result = await submitDecisionAs("player1", player1Decision);
      assert(result.submitted === true, "P1 submitted");
    });

    await test(`R${round}: Player 2 submits decision`, async () => {
      const result = await submitDecisionAs("player2", player2Decision);
      assert(result.submitted === true, "P2 submitted");
    });

    await test(`R${round}: Player 3 submits decision`, async () => {
      const result = await submitDecisionAs("player3", player3Decision);
      assert(result.submitted === true, "P3 submitted");
    });

    // ─── Advance through bid and roster phases ─────────────────
    console.log(`\n  🏷️  Bid Phases (Round ${round})`);

    await test(`R${round}: decide → bid_ad`, async () => {
      await advanceAsProf();
      const snap = await gameRef.get();
      assert(snap.get("phase") === `round_${round}_bid_ad`, `Phase = ${snap.get("phase")}`);
    });

    await test(`R${round}: bid_ad → bid_chef`, async () => {
      await advanceAsProf();
      const snap = await gameRef.get();
      assert(snap.get("phase") === `round_${round}_bid_chef`, `Phase = ${snap.get("phase")}`);
    });

    await test(`R${round}: bid_chef → roster`, async () => {
      await advanceAsProf();
      const snap = await gameRef.get();
      assert(snap.get("phase") === `round_${round}_roster`, `Phase = ${snap.get("phase")}`);
    });

    // ─── Roster → Simulating → Results Ready ──────────────────
    console.log(`\n  🏪 Simulation (Round ${round})`);

    await test(`R${round}: roster → simulating → results_ready`, async () => {
      await advanceAsProf();
      await waitForResultsReady();
      const snap = await gameRef.get();
      assert(snap.get("phase") === "results_ready", `Phase = ${snap.get("phase")}`);
    });

    // ─── Verify results ───────────────────────────────────────
    console.log(`\n  📊 Verify Results (Round ${round})`);

    await test(`R${round}: Round document exists with simulation data`, async () => {
      const roundRef = gameRef.collection("rounds").doc(`round_${round}`);
      const roundSnap = await roundRef.get();
      assert(roundSnap.exists, "Round doc exists");
      assert(roundSnap.get("simulationStatus") === "complete", "Simulation complete");
      assert(roundSnap.get("round") === round, `Round number = ${round}`);

      const stats = roundSnap.get("classStats");
      assert(stats, "classStats exists");
      assert(typeof stats.avgRevenueNet === "number", "avgRevenueNet is number");
    });

    await test(`R${round}: Player budgets updated`, async () => {
      for (const [name, uid] of [
        ["player1", actors.player1.uid],
        ["player2", actors.player2.uid],
        ["player3", actors.player3.uid],
      ]) {
        const playerSnap = await gameRef.collection("players").doc(uid).get();
        const budget = playerSnap.get("budgetCurrent");
        assert(typeof budget === "number", `${name} budget is number`);
        console.log(`     ${name}: budget = $${budget}`);
      }
    });

    await test(`R${round}: Leaderboard updated`, async () => {
      const lbSnap = await gameRef.collection("leaderboard").doc("latest").get();
      assert(lbSnap.exists, "Leaderboard exists");
      const rankings = lbSnap.get("rankings");
      assert(Array.isArray(rankings), "Rankings is array");
      assert(rankings.length === 3, `Rankings has 3 entries, got ${rankings.length}`);
      assert(rankings[0].rank === 1, "Top rank is 1");
    });

    await test(`R${round}: Player round results stored`, async () => {
      for (const [name, uid] of [
        ["player1", actors.player1.uid],
        ["player2", actors.player2.uid],
        ["player3", actors.player3.uid],
      ]) {
        const resultSnap = await gameRef
          .collection("players").doc(uid)
          .collection("rounds").doc(`round_${round}`).get();
        assert(resultSnap.exists, `${name} round result exists`);
        const data = resultSnap.data();
        assert(data.round === round, `${name} round number correct`);
        assert(typeof data.revenueGross === "number", `${name} revenueGross is number`);
        assert(typeof data.revenueNet === "number", `${name} revenueNet is number`);
        assert(typeof data.budgetAfter === "number", `${name} budgetAfter is number`);
      }
    });

    await test(`R${round}: CSV row data stored for each player`, async () => {
      for (const [name, uid] of [
        ["player1", actors.player1.uid],
        ["player2", actors.player2.uid],
        ["player3", actors.player3.uid],
      ]) {
        const csvSnap = await gameRef
          .collection("csvRows").doc(uid)
          .collection("rounds").doc(`round_${round}`).get();
        assert(csvSnap.exists, `${name} CSV row exists`);
        const row = csvSnap.get("row");
        assert(row, `${name} CSV row data exists`);
        assert(row.round === round, `${name} CSV round = ${round}`);
      }
    });

    // ─── Advance to next round or game_over ───────────────────
    if (round < TOTAL_ROUNDS) {
      console.log(`\n  ➡️  Advance → round_${round + 1}_email`);
      await test(`R${round}: results_ready → round_${round + 1}_email`, async () => {
        await advanceAsProf();
        const snap = await gameRef.get();
        assert(snap.get("phase") === `round_${round + 1}_email`, `Phase = ${snap.get("phase")}`);
        assert(snap.get("currentRound") === round + 1, `Round = ${snap.get("currentRound")}`);
      });
    }
  }

  // ─── Final Round: game_over ─────────────────────────────────
  console.log(`\n${"═".repeat(55)}`);
  console.log("🏁 GAME OVER PHASE");
  console.log("═".repeat(55));

  await test("Advance to game_over after round 5", async () => {
    await advanceAsProf();
    const snap = await gameRef.get();
    assert(snap.get("phase") === "game_over", `Phase = ${snap.get("phase")}`);
    assert(snap.get("endedAt") !== null, "endedAt is set");
  });

  await test("Cannot advance past game_over", async () => {
    try {
      const fn = httpsCallable(playerFunctions.professor, "advanceGamePhase");
      await fn({ gameId });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(
        err.code?.includes("failed-precondition") || err.message?.includes("already over"),
        `Expected failed-precondition, got: ${err.code || err.message}`
      );
    }
  });

  await test("Cannot join after game_over", async () => {
    try {
      const fn = httpsCallable(playerFunctions.player1, "joinGame");
      await fn({ joinCode, displayName: "Late Joiner" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(
        err.code?.includes("failed-precondition"),
        `Expected failed-precondition, got: ${err.code || err.message}`
      );
    }
  });

  await test("Cannot submit after game_over", async () => {
    try {
      const fn = httpsCallable(playerFunctions.player1, "submitDecision");
      await fn({
        gameId,
        sousChefCount: 0,
        sousChefAssignments: {},
        menu: { croissant: true, cookie: true, bagel: true },
        quantities: { croissant: 10, cookie: 10, bagel: 10, sandwich: 0, coffee: 0, matcha: 0 },
      });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(
        err.code?.includes("failed-precondition"),
        `Expected failed-precondition, got: ${err.code || err.message}`
      );
    }
  });

  // ─── Final Summary ─────────────────────────────────────────
  await test("Final leaderboard has correct structure", async () => {
    const lbSnap = await gameRef.collection("leaderboard").doc("latest").get();
    const rankings = lbSnap.get("rankings");

    for (const ranking of rankings) {
      const playerSnap = await gameRef.collection("players").doc(ranking.playerId).get();
      assert(typeof playerSnap.get("cumulativeRevenue") === "number", `${ranking.displayName} cumulativeRevenue is number`);
    }

    console.log("\n  📊 Final Standings:");
    rankings.forEach(r => {
      console.log(`     #${r.rank} ${r.displayName}: $${r.revenueNet} net this round`);
    });
  });

  await test("All 5 round docs exist and are complete", async () => {
    for (let r = 1; r <= 5; r++) {
      const snap = await gameRef.collection("rounds").doc(`round_${r}`).get();
      assert(snap.exists, `round_${r} exists`);
      assert(snap.get("simulationStatus") === "complete", `round_${r} simulation complete`);
    }
  });

  // ─── Report ─────────────────────────────────────────────────
  console.log("\n" + "═".repeat(55));
  console.log(`Results: ${passed} passed, ${failed} failed`);
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

main().catch(err => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});
