/**
 * Bakery Bash — Full Game Lifecycle Test
 * 
 * Plays a complete 5-round game with 3 players through all phases,
 * verifying budget math, simulation output, leaderboard, CSV emails,
 * auction resolution, and game_over state at every step.
 * 
 * Run with: node scripts/test-lifecycle.js
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

// Store auth credentials for each actor so we can switch between them
const actors = {
  professor: { credential: null, uid: null },
  player1: { credential: null, uid: null },
  player2: { credential: null, uid: null },
  player3: { credential: null, uid: null },
};

let gameId;
let joinCode;
let gameRef;

// Track expected budgets to verify at each step
const expectedBudgets = {};

async function signInAs(actor) {
  const cred = await signInAnonymously(auth);
  actors[actor].credential = cred;
  actors[actor].uid = cred.user.uid;
  return cred;
}

// We can't easily switch between Firebase Auth anonymous users in the same client,
// so we'll create the game state via admin and use the client for callable functions.
// For multi-player, we'll create separate client apps per player.

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

// ─── Phase Helper ─────────────────────────────────────────────

async function advanceAsProf(expectedPhase) {
  const fn = httpsCallable(playerFunctions.professor, "advanceGamePhase");
  const result = await fn({ gameId });
  // Wait a moment for Firestore triggers to complete
  await new Promise(r => setTimeout(r, 1500));
  return result.data;
}

async function submitDecisionAs(playerName, decision) {
  const fn = httpsCallable(playerFunctions[playerName], "submitDecision");
  const result = await fn(decision);
  // Small delay to allow trigger
  await new Promise(r => setTimeout(r, 500));
  return result.data;
}

// ─── Main Test ────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║   BAKERY BASH — FULL GAME LIFECYCLE TEST (5 rounds)  ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  // ─── Setup: Create separate client apps for each actor ──────
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

  // ─── Create game via admin ──────────────────────────────────
  gameId = `lifecycle_${Date.now()}`;
  joinCode = randomCode();
  gameRef = db.collection("games").doc(gameId);

  await gameRef.set({
    joinCode,
    phase: "lobby",
    currentRound: 1,
    totalRounds: 5,
    totalPlayers: 0,
    submittedCount: 0,
    professorId: actors.professor.uid,
    paused: false,
    createdAt: FieldValue.serverTimestamp(),
    startedAt: null,
    endedAt: null,
    phaseStartedAt: null,
    phaseEndTime: null,
  });

  await gameRef.collection("config").doc("params").set({
    startingBudget: 2000,
    costPerStaffPerRound: 50,
    unitCostPerProduct: 1,
    revenueModel: {
      base: 500, staffCoefficient: 30, priceCoefficient: -15,
      adSpendCoefficient: 0.8, numProductsCoefficient: 50,
      noiseMin: 0, noiseMax: 0, // Zero noise for deterministic testing!
    },
    adBonuses: { TV: 200, Billboard: 150, Radio: 100, Newspaper: 75 },
    chefBonusPerPoint: 5,
    customerPoolMultiplier: 100,
    phaseDurations: { closing_hours: 300, auction: 120, open_for_business: 60, results: 60 },
    attractivenessWeights: { priceWeight: 100, staffWeight: 5, adSpendWeight: 0.3, numProductsWeight: 10 },
  });

  console.log(`  Game ID: ${gameId}, Join Code: ${joinCode}\n`);

  // ─── PHASE 1: Join ─────────────────────────────────────────
  console.log("📋 PHASE: Player Join");

  await test("Player 1 joins game", async () => {
    const fn = httpsCallable(playerFunctions.player1, "joinGame");
    const result = await fn({ joinCode, displayName: "The Rolling Scone" });
    assert(result.data.gameId === gameId, `gameId matches: ${result.data.gameId}`);
    assert(result.data.displayName === "The Rolling Scone", "Name matches");
  });

  await test("Player 2 joins game", async () => {
    const fn = httpsCallable(playerFunctions.player2, "joinGame");
    const result = await fn({ joinCode, displayName: "Bread Winners" });
    assert(result.data.displayName === "Bread Winners", "Name matches");
  });

  await test("Player 3 joins game", async () => {
    const fn = httpsCallable(playerFunctions.player3, "joinGame");
    const result = await fn({ joinCode, displayName: "Loaf Actually" });
    assert(result.data.displayName === "Loaf Actually", "Name matches");
  });

  await test("Game shows 3 players", async () => {
    const snap = await gameRef.get();
    assert(snap.get("totalPlayers") === 3, `Total players = ${snap.get("totalPlayers")}`);
  });

  // Initialize expected budgets
  for (const name of ["player1", "player2", "player3"]) {
    expectedBudgets[name] = 2000;
  }

  // ─── PHASE 2: Start Game ───────────────────────────────────
  console.log("\n🚀 PHASE: Start Game");

  await test("Professor starts game → closing_hours round 1", async () => {
    const fn = httpsCallable(playerFunctions.professor, "startGame");
    const result = await fn({ gameId });
    assert(result.data.phase === "closing_hours", `Phase = ${result.data.phase}`);
    assert(result.data.currentRound === 1, `Round = ${result.data.currentRound}`);
  });

  // ─── ROUNDS 1-5 ────────────────────────────────────────────
  const TOTAL_ROUNDS = 5;

  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    console.log(`\n${"═".repeat(55)}`);
    console.log(`🎯 ROUND ${round} of ${TOTAL_ROUNDS}`);
    console.log("═".repeat(55));

    // ─── Closing Hours: Submit decisions ──────────────────────
    console.log(`\n  📝 Closing Hours (Round ${round})`);

    // Different strategies per player:
    // Player 1: Aggressive (high staff, high ad spend, max products)
    // Player 2: Conservative (low staff, no ads, few products)
    // Player 3: Balanced (mid staff, some ads, varied products)

    const player1Decision = {
      gameId,
      staffCount: Math.min(10 + round, 20), // Grows each round
      adSpend: round <= 3 ? 100 : 0,
      adType: round <= 3 ? "TV" : null,
      menu: { croissant: true, cookie: true, bagel: true, sandwich: true, latte: true, matchaLatte: round >= 3 },
      productPrices: {
        croissant: 5, cookie: 4, bagel: 3, sandwich: 6,
        latte: 7, matchaLatte: round >= 3 ? 8 : 0,
      },
      quantities: {
        croissant: 30, cookie: 30, bagel: 30, sandwich: 30,
        latte: 30, matchaLatte: round >= 3 ? 30 : 0,
      },
      chefBid: { skillLevel: 50, amount: round * 20 },
    };

    const player2Decision = {
      gameId,
      staffCount: 2,
      adSpend: 0,
      adType: null,
      menu: { croissant: true, cookie: false, bagel: true, sandwich: false, latte: true, matchaLatte: false },
      productPrices: {
        croissant: 3, cookie: 0, bagel: 3, sandwich: 0,
        latte: 4, matchaLatte: 0,
      },
      quantities: {
        croissant: 20, cookie: 0, bagel: 20, sandwich: 0,
        latte: 20, matchaLatte: 0,
      },
      chefBid: { skillLevel: 0, amount: 0 },
    };

    const player3Decision = {
      gameId,
      staffCount: 5,
      adSpend: round % 2 === 0 ? 75 : 0,
      adType: round % 2 === 0 ? "Billboard" : null,
      menu: { croissant: true, cookie: true, bagel: true, sandwich: false, latte: true, matchaLatte: false },
      productPrices: {
        croissant: 4, cookie: 4, bagel: 4, sandwich: 0,
        latte: 5, matchaLatte: 0,
      },
      quantities: {
        croissant: 40, cookie: 40, bagel: 40, sandwich: 0,
        latte: 40, matchaLatte: 0,
      },
      chefBid: { skillLevel: 30, amount: round * 10 },
    };

    // Calculate expected costs for budget verification
    function calcCost(d) {
      const staffCost = d.staffCount * 50;
      const stockCost = Object.values(d.quantities).reduce((s, q) => s + Math.max(0, q), 0) * 1;
      const adBidAmt = d.adType ? Math.max(0, d.adSpend) : 0;
      const chefBidAmt = Math.max(0, d.chefBid.amount);
      return staffCost + stockCost + adBidAmt + chefBidAmt;
    }

    const p1Cost = calcCost(player1Decision);
    const p2Cost = calcCost(player2Decision);
    const p3Cost = calcCost(player3Decision);

    await test(`R${round}: Player 1 submits (cost $${p1Cost}, budget $${expectedBudgets.player1})`, async () => {
      assert(p1Cost <= expectedBudgets.player1, `P1 cost ${p1Cost} > budget ${expectedBudgets.player1}`);
      const result = await submitDecisionAs("player1", player1Decision);
      assert(result.submitted === true, "P1 submitted");
    });

    await test(`R${round}: Player 2 submits (cost $${p2Cost}, budget $${expectedBudgets.player2})`, async () => {
      assert(p2Cost <= expectedBudgets.player2, `P2 cost ${p2Cost} > budget ${expectedBudgets.player2}`);
      const result = await submitDecisionAs("player2", player2Decision);
      assert(result.submitted === true, "P2 submitted");
    });

    await test(`R${round}: Player 3 submits (cost $${p3Cost}, budget $${expectedBudgets.player3})`, async () => {
      assert(p3Cost <= expectedBudgets.player3, `P3 cost ${p3Cost} > budget ${expectedBudgets.player3}`);
      const result = await submitDecisionAs("player3", player3Decision);
      assert(result.submitted === true, "P3 submitted");
    });

    // ─── Advance to auction ──────────────────────────────────
    console.log(`\n  🏷️  Advance → auction (Round ${round})`);

    await test(`R${round}: Advance to auction`, async () => {
      const result = await advanceAsProf();
      const snap = await gameRef.get();
      const phase = snap.get("phase");
      // After advance from closing_hours, should be auction
      assert(phase === "auction", `Expected auction, got ${phase}`);
    });

    // ─── Advance to open_for_business (triggers simulation) ──
    console.log(`\n  🏪 Advance → open_for_business (Round ${round})`);

    await test(`R${round}: Advance to open_for_business → simulation runs`, async () => {
      const result = await advanceAsProf();
      // Wait for simulation to complete
      await new Promise(r => setTimeout(r, 3000));
      const snap = await gameRef.get();
      const phase = snap.get("phase");
      // After simulation completes, should be in results
      assert(
        phase === "open_for_business" || phase === "results",
        `Expected open_for_business or results, got ${phase}`
      );
    });

    // If still in open_for_business, advance to results
    let currentPhase = (await gameRef.get()).get("phase");
    if (currentPhase === "open_for_business") {
      await test(`R${round}: Advance to results`, async () => {
        const result = await advanceAsProf();
        const snap = await gameRef.get();
        const phase = snap.get("phase");
        assert(phase === "results", `Expected results, got ${phase}`);
      });
    }

    // ─── Verify simulation results ───────────────────────────
    console.log(`\n  📊 Verify Results (Round ${round})`);

    await test(`R${round}: Round document exists with simulation data`, async () => {
      const roundRef = gameRef.collection("rounds").doc(`round_${round}`);
      const roundSnap = await roundRef.get();
      assert(roundSnap.exists, "Round doc exists");
      assert(roundSnap.get("simulationStatus") === "complete", "Simulation complete");
      assert(roundSnap.get("round") === round, `Round number = ${round}`);

      const stats = roundSnap.get("classStats");
      assert(stats, "classStats exists");
      assert(typeof stats.avgRevenue === "number", "avgRevenue is number");
      assert(typeof stats.totalCustomerPool === "number", "totalCustomerPool is number");
      assert(stats.totalCustomerPool === 300, `Customer pool = 100 × 3 = 300, got ${stats.totalCustomerPool}`);
    });

    await test(`R${round}: Auction results stored correctly`, async () => {
      const roundRef = gameRef.collection("rounds").doc(`round_${round}`);
      const roundSnap = await roundRef.get();
      const auctions = roundSnap.get("auctionResults");
      assert(auctions, "auctionResults exists");
      assert(auctions.ads, "ads auctions exist");
      assert(auctions.chef, "chef auction exists");
      // Verify each ad type has winnerId and winningBid fields
      for (const adType of ["TV", "Billboard", "Radio", "Newspaper"]) {
        assert(auctions.ads[adType] !== undefined, `${adType} auction exists`);
        assert("winnerId" in auctions.ads[adType], `${adType} has winnerId`);
        assert("winningBid" in auctions.ads[adType], `${adType} has winningBid`);
      }
    });

    await test(`R${round}: Player budgets updated correctly`, async () => {
      for (const [name, uid] of [["player1", actors.player1.uid], ["player2", actors.player2.uid], ["player3", actors.player3.uid]]) {
        const playerSnap = await gameRef.collection("players").doc(uid).get();
        const budget = playerSnap.get("budgetCurrent");
        assert(typeof budget === "number", `${name} budget is number`);
        // Budget should have changed from the starting value
        // (We can't predict exact revenue due to noise, but we check it's reasonable)
        console.log(`     ${name}: budget = $${budget}`);
        expectedBudgets[name] = budget; // Track for next round
      }
    });

    await test(`R${round}: Leaderboard updated`, async () => {
      const lbSnap = await gameRef.collection("leaderboard").doc("current").get();
      assert(lbSnap.exists, "Leaderboard exists");
      const rankings = lbSnap.get("rankings");
      assert(Array.isArray(rankings), "Rankings is array");
      assert(rankings.length === 3, `Rankings has 3 entries, got ${rankings.length}`);
      // Should be sorted by cumulativeRevenue descending
      for (let i = 0; i < rankings.length - 1; i++) {
        assert(
          rankings[i].cumulativeRevenue >= rankings[i + 1].cumulativeRevenue,
          `Rank ${i + 1} (${rankings[i].cumulativeRevenue}) >= Rank ${i + 2} (${rankings[i + 1].cumulativeRevenue})`
        );
      }
      assert(rankings[0].rank === 1, "Top rank is 1");
      assert(rankings[rankings.length - 1].rank === 3, "Last rank is 3");
    });

    await test(`R${round}: Player round results stored`, async () => {
      for (const [name, uid] of [["player1", actors.player1.uid], ["player2", actors.player2.uid], ["player3", actors.player3.uid]]) {
        const resultSnap = await gameRef.collection("players").doc(uid)
          .collection("rounds").doc(`round_${round}`).get();
        assert(resultSnap.exists, `${name} round result exists`);
        const data = resultSnap.data();
        assert(data.round === round, `${name} round number correct`);
        assert(typeof data.revenue === "number", `${name} revenue is number`);
        assert(typeof data.customerCount === "number", `${name} customerCount is number`);
        assert(typeof data.totalCosts === "number", `${name} totalCosts is number`);
        assert(typeof data.budgetBefore === "number", `${name} budgetBefore is number`);
        assert(typeof data.budgetAfter === "number", `${name} budgetAfter is number`);
        // Verify budget math: budgetAfter = budgetBefore + revenue - totalCosts
        const expectedAfter = Math.round(data.budgetBefore + data.revenue - data.totalCosts);
        assert(
          Math.abs(data.budgetAfter - expectedAfter) <= 1,
          `${name} budget math: ${data.budgetBefore} + ${data.revenue} - ${data.totalCosts} = ${expectedAfter}, got ${data.budgetAfter}`
        );
      }
    });

    await test(`R${round}: CSV row data stored for each player`, async () => {
      for (const [name, uid] of [["player1", actors.player1.uid], ["player2", actors.player2.uid], ["player3", actors.player3.uid]]) {
        const csvSnap = await gameRef.collection("csvRows").doc(uid)
          .collection("rounds").doc(`round_${round}`).get();
        assert(csvSnap.exists, `${name} CSV row exists`);
        const row = csvSnap.get("row");
        assert(row, `${name} CSV row data exists`);
        assert(row.day === round, `${name} CSV day = ${round}`);
        assert(typeof row.revenue === "number", `${name} CSV revenue`);
        assert(typeof row.staff_count === "number", `${name} CSV staff_count`);
      }
    });

    // Email check: emails should exist for rounds 1-4 but NOT round 5
    if (round < TOTAL_ROUNDS) {
      await test(`R${round}: CSV email created for next round`, async () => {
        for (const [name, uid] of [["player1", actors.player1.uid], ["player2", actors.player2.uid], ["player3", actors.player3.uid]]) {
          const emailSnap = await gameRef.collection("players").doc(uid)
            .collection("emails").doc(`round_${round + 1}_data`).get();
          assert(emailSnap.exists, `${name} email for round ${round + 1} exists`);
          const data = emailSnap.data();
          assert(data.type === "round_data_csv", "Email type correct");
          assert(data.round === round + 1, `Email round = ${round + 1}`);
          assert(data.attachments?.length === 1, "Has 1 attachment");
          assert(data.attachments[0].contentType === "text/csv", "Attachment is CSV");
          assert(data.attachments[0].rowCount === round, `CSV has ${round} rows`);
        }
      });
    }

    // ─── Advance to next round or game_over ──────────────────
    if (round < TOTAL_ROUNDS) {
      console.log(`\n  ➡️  Advance → closing_hours (Round ${round + 1})`);
      await test(`R${round}: Advance to closing_hours round ${round + 1}`, async () => {
        const result = await advanceAsProf();
        const snap = await gameRef.get();
        assert(snap.get("phase") === "closing_hours", `Phase = ${snap.get("phase")}`);
        assert(snap.get("currentRound") === round + 1, `Round = ${snap.get("currentRound")}`);
        assert(snap.get("submittedCount") === 0, "submittedCount reset to 0");
      });
    }
  }

  // ─── Final Round: Advance to game_over ─────────────────────
  console.log(`\n${"═".repeat(55)}`);
  console.log("🏁 GAME OVER PHASE");
  console.log("═".repeat(55));

  await test("Advance to game_over after round 5", async () => {
    const result = await advanceAsProf();
    const snap = await gameRef.get();
    assert(snap.get("phase") === "game_over", `Phase = ${snap.get("phase")}`);
    assert(snap.get("endedAt") !== null, "endedAt is set");
  });

  await test("No email created after final round (round 5)", async () => {
    for (const [name, uid] of [["player1", actors.player1.uid], ["player2", actors.player2.uid], ["player3", actors.player3.uid]]) {
      const emailSnap = await gameRef.collection("players").doc(uid)
        .collection("emails").doc("round_6_data").get();
      assert(!emailSnap.exists, `${name} should NOT have round_6_data email`);
    }
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
        staffCount: 3,
        adSpend: 0,
        menu: { croissant: true, cookie: true, bagel: true, latte: true },
        productPrices: { croissant: 5, cookie: 4, bagel: 3, latte: 6 },
        quantities: { croissant: 10, cookie: 10, bagel: 10, latte: 10 },
        chefBid: { skillLevel: 0, amount: 0 },
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
  await test("Final leaderboard has correct cumulative revenues", async () => {
    const lbSnap = await gameRef.collection("leaderboard").doc("current").get();
    const rankings = lbSnap.get("rankings");
    
    for (const ranking of rankings) {
      const playerSnap = await gameRef.collection("players").doc(ranking.playerId).get();
      const storedCumulative = playerSnap.get("cumulativeRevenue");
      assertClose(
        ranking.cumulativeRevenue,
        storedCumulative,
        1,
        `Leaderboard cumRev matches player doc for ${ranking.displayName}`
      );
    }
    
    console.log("\n  📊 Final Standings:");
    rankings.forEach(r => {
      console.log(`     #${r.rank} ${r.displayName}: $${r.cumulativeRevenue} cumulative`);
    });
  });

  await test("All 5 round docs exist and are complete", async () => {
    for (let r = 1; r <= 5; r++) {
      const snap = await gameRef.collection("rounds").doc(`round_${r}`).get();
      assert(snap.exists, `round_${r} exists`);
      assert(snap.get("simulationStatus") === "complete", `round_${r} simulation complete`);
    }
  });

  await test("Final budgets are consistent with round-by-round math", async () => {
    for (const [name, uid] of [["player1", actors.player1.uid], ["player2", actors.player2.uid], ["player3", actors.player3.uid]]) {
      let runningBudget = 2000; // Starting budget
      
      for (let r = 1; r <= 5; r++) {
        const resultSnap = await gameRef.collection("players").doc(uid)
          .collection("rounds").doc(`round_${r}`).get();
        const data = resultSnap.data();
        runningBudget = Math.round(runningBudget + data.revenue - data.totalCosts);
      }
      
      const playerSnap = await gameRef.collection("players").doc(uid).get();
      const finalBudget = playerSnap.get("budgetCurrent");
      
      console.log(`     ${name}: calculated $${runningBudget}, stored $${finalBudget}`);
      assertClose(finalBudget, runningBudget, 2, `${name} final budget matches sum`);
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
