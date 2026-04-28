/**
 * Bakery Bash — 100 Player Full-Phase Stress Test (Emulator-Safe)
 *
 * Processes 100 players in small batches to avoid crashing the local emulator.
 * Exercises all phases across 5 rounds: bid_ad, bid_chef, roster, decide.
 *
 * Run with: node scripts/test-100-players-full-phase.js
 */

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getFunctions, connectFunctionsEmulator } = require("firebase/functions");
const { initializeApp: initializeClientApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, signInAnonymously } = require("firebase/auth");
const { httpsCallable } = require("firebase/functions");

// ─── Config ───────────────────────────────────────────────────
const PROJECT_ID = "bakery-bash-54d12";
const HOST = "127.0.0.1";
const FUNCTIONS_PORT = 5001;
const AUTH_PORT = 9099;
const FIRESTORE_PORT = 8080;
const PLAYER_COUNT = 100;
const TOTAL_ROUNDS = 5;
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${FIRESTORE_PORT}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `${HOST}:${AUTH_PORT}`;

const adminApp = initializeApp({ projectId: PROJECT_ID });
const db = getFirestore(adminApp);

// ─── Helpers ──────────────────────────────────────────────────

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ~${expected} ±${tolerance}, got ${actual}`);
  }
}

async function timed(label, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    console.log(`    ✅ ${label} (${Date.now() - start}ms)`);
    return result;
  } catch (err) {
    console.log(`    ❌ ${label} (${Date.now() - start}ms): ${err.message || err}`);
    throw err;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomCode() {
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += charset[Math.floor(Math.random() * charset.length)];
  return code;
}

function createPlayerClient(index) {
  const name = `stress_${index}_${Date.now()}`;
  const app = initializeClientApp({ projectId: PROJECT_ID, apiKey: "fake-api-key" }, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${HOST}:${AUTH_PORT}`, { disableWarnings: true });
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, HOST, FUNCTIONS_PORT);
  return { app, auth, functions };
}

async function batchAll(items, batchSize, fn, delayMs) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return results;
}

function reportFailures(results, label) {
  const fails = results.filter((r) => r.status === "rejected");
  if (fails.length === 0) return true;
  const summary = {};
  for (const f of fails) {
    const code = f.reason?.code || f.reason?.message?.slice(0, 40) || "unknown";
    summary[code] = (summary[code] || 0) + 1;
  }
  console.log(`  ⚠️  ${label}: ${fails.length} failures —`, summary);
  return false;
}

// ─── Decision / Bid Generators ────────────────────────────────

function generateDecision(playerIndex, gameId, budget, unlockedProducts = []) {
  const base = ["croissant", "bagel", "coffee"];
  const optional = ["cookie", "sandwich", "matcha"];
  const unlockedSet = new Set([...base, ...unlockedProducts]);

  const menu = {};
  for (const p of base) menu[p] = true;
  for (const p of optional) menu[p] = unlockedSet.has(p) && (playerIndex % 3 === 0 || playerIndex % 5 === 0);
  const offered = [...base, ...optional].filter((p) => menu[p]);

  const quantities = {};
  for (const p of base) quantities[p] = 10 + (playerIndex % 20);
  for (const p of optional) quantities[p] = menu[p] ? 8 + (playerIndex % 15) : 0;

  const sousChefCount = 2 + (playerIndex % 4);
  const sousChefAssignments = {};
  for (let i = 0; i < sousChefCount; i++) {
    const product = offered[i % offered.length];
    sousChefAssignments[product] = (sousChefAssignments[product] || 0) + 1;
  }

  const stockCost = Object.values(quantities).reduce((s, q) => s + q, 0);
  const scCost = sousChefCount * 10;
  if (stockCost + scCost > budget) {
    const scale = Math.max(0.1, (budget - scCost) / stockCost);
    for (const key of Object.keys(quantities)) quantities[key] = Math.floor(quantities[key] * scale);
  }

  return { gameId, menu, quantities, sousChefCount, sousChefAssignments, staffCounts: {}, maintenanceTasks: [] };
}

function generateAdBids(playerIndex) {
  const surfaces = ["TV", "Billboard", "Radio", "Newspaper"];
  const bids = {};
  for (const s of surfaces) bids[s] = playerIndex % 4 === surfaces.indexOf(s) ? 20 + (playerIndex % 80) : 0;
  return bids;
}

function generateChefBids(playerIndex, chefPool) {
  if (!chefPool || chefPool.length === 0) return [];
  const bids = [];
  for (let i = 0; i < chefPool.length; i++) {
    const chef = chefPool[i];
    if (playerIndex % 5 === i % 5) {
      const floor = chef.minBidFloor || 20;
      bids.push({ chefId: chef.id, amount: floor + (playerIndex % 30) });
    }
  }
  return bids;
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║   BAKERY BASH — 100 PLAYER FULL-PHASE STRESS TEST            ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  // Professor client
  const profApp = initializeClientApp({ projectId: PROJECT_ID, apiKey: "fake-api-key" }, `prof_${Date.now()}`);
  const profAuth = getAuth(profApp);
  connectAuthEmulator(profAuth, `http://${HOST}:${AUTH_PORT}`, { disableWarnings: true });
  const profFunctions = getFunctions(profApp);
  connectFunctionsEmulator(profFunctions, HOST, FUNCTIONS_PORT);

  const profCred = await signInAnonymously(profAuth);
  const professorUid = profCred.user.uid;
  console.log(`👨‍🏫 Professor UID: ${professorUid}`);

  // Create player clients (lightweight — just objects, no heavy state yet)
  console.log(`\n🔧 Preparing ${PLAYER_COUNT} player slots...`);
  const players = [];
  for (let i = 0; i < PLAYER_COUNT; i++) {
    const client = createPlayerClient(i);
    players.push({ index: i, displayName: `Bakery_${i + 1}`, ...client });
  }

  // Sign in — batched to avoid emulator overload
  console.log(`🔑 Signing in ${PLAYER_COUNT} players (batch=${BATCH_SIZE}, delay=${BATCH_DELAY_MS}ms)...`);
  const signInStart = Date.now();
  const signInResults = await batchAll(
    players,
    BATCH_SIZE,
    async (p) => {
      const cred = await signInAnonymously(p.auth);
      p.uid = cred.user.uid;
      return p.uid;
    },
    BATCH_DELAY_MS
  );
  const signInFails = signInResults.filter((r) => r.status === "rejected").length;
  console.log(`  ⏱️  Sign-in: ${Date.now() - signInStart}ms (${signInFails} failures)`);
  assert(signInFails === 0, `${signInFails} sign-ins failed`);

  // Create game via admin SDK
  const gameId = `stress100_${Date.now()}`;
  const joinCode = randomCode();
  const gameRef = db.collection("games").doc(gameId);

  console.log(`\n🎮 Creating game ${gameId} (joinCode: ${joinCode})...`);
  await gameRef.set({
    joinCode,
    phase: "lobby",
    currentRound: 1,
    totalRounds: TOTAL_ROUNDS,
    totalPlayers: 0,
    submittedCount: 0,
    professorId: professorUid,
    paused: false,
    createdAt: FieldValue.serverTimestamp(),
    startedAt: null,
    endedAt: null,
    phaseStartedAt: null,
    phaseEndTime: null,
  });

  await gameRef.collection("config").doc("params").set({
    startingBudget: 10000,
    playerCap: PLAYER_COUNT + 20,
    costPerStaffPerRound: 10,
    unitCostPerProduct: 1,
    revenueCoefficients: {
      base: 10, sousChefCoeff: 0.5, satisfactionCoeff: 1.2,
      adSpendCoeff: 0, numProductsCoeff: 2, noiseMin: -2, noiseMax: 2,
    },
    adBonuses: { TV: 400, Billboard: 250, Radio: 150, Newspaper: 80 },
    phaseDurations: { email: 15, decide: 300, bid_ad: 90, bid_chef: 90, roster: 60, simulating: 8, results: 60 },
    totalRounds: TOTAL_ROUNDS,
    specialtyChefCap: 3,
    chefPoolSize: 12,
  });

  // PHASE: Join — batched
  console.log(`\n📋 PHASE: ${PLAYER_COUNT} Players Joining (batch=${BATCH_SIZE})...`);
  const joinStart = Date.now();
  const joinResults = await batchAll(
    players,
    20,
    async (p) => {
      const fn = httpsCallable(p.functions, "createTeam");
      // Each player creates their own team so we get 100 simulation/leaderboard entries
      const result = await fn({ joinCode, displayName: p.displayName, teamName: p.displayName });
      assert(result.data.gameId === gameId, `${p.displayName} joined wrong game`);
      return result.data;
    },
    300
  );
  const joinFails = joinResults.filter((r) => r.status === "rejected");
  if (joinFails.length > 0) {
    console.log("  First 3 join errors:", joinFails.slice(0, 3).map((f) => f.reason?.message || f.reason));
  }
  assert(joinFails.length === 0, `${joinFails.length} joins failed`);
  console.log(`  ⏱️  All joins: ${Date.now() - joinStart}ms`);

  await timed("Game totalPlayers === 100", async () => {
    const snap = await gameRef.get();
    assert(snap.get("totalPlayers") === PLAYER_COUNT, `totalPlayers = ${snap.get("totalPlayers")}`);
  });

  await timed("All player docs valid", async () => {
    const snap = await gameRef.collection("players").get();
    assert(snap.size === PLAYER_COUNT, `Player doc count = ${snap.size}`);
  });

  // PHASE: Start Game
  console.log(`\n🚀 PHASE: Start Game`);
  await timed("Professor starts game", async () => {
    const fn = httpsCallable(profFunctions, "startGame");
    const result = await fn({ gameId });
    assert(result.data.phase === "round_1_email", `Got ${result.data.phase}`);
    assert(result.data.round === 1, "Round should be 1");
  });

  // ─── ROUNDS ─────────────────────────────────────────────────
  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`🎯 ROUND ${round} of ${TOTAL_ROUNDS}`);
    console.log("═".repeat(60));
    const roundId = `round_${round}`;

    // email → bid_ad
    await timed("Advance email → bid_ad", async () => {
      const fn = httpsCallable(profFunctions, "advanceGamePhase");
      const result = await fn({ gameId });
      assert(result.data.phase === `round_${round}_bid_ad`, `Got ${result.data.phase}`);
    });

    // Bid Ad
    console.log(`  📢 Ad bids (batch=${BATCH_SIZE})...`);
    const adBidResults = await batchAll(
      players,
      BATCH_SIZE,
      async (p) => {
        const fn = httpsCallable(p.functions, "submitBids");
        const bids = generateAdBids(p.index);
        return await fn({ gameId, bidType: "ad", ...bids });
      },
      500
    );
    assert(reportFailures(adBidResults, "Ad bids"), "Ad bid failures");

    // bid_ad → bid_chef
    await timed("Advance bid_ad → bid_chef", async () => {
      const fn = httpsCallable(profFunctions, "advanceGamePhase");
      const result = await fn({ gameId });
      assert(result.data.phase === `round_${round}_bid_chef`, `Got ${result.data.phase}`);
    });

    // Fetch chef pool
    const roundDoc = await gameRef.collection("rounds").doc(roundId).get();
    const chefPool = (roundDoc.exists && roundDoc.data().chefPool) || [];
    console.log(`  👨‍🍳 Chef pool size: ${chefPool.length}`);

    // Bid Chef
    console.log(`  👨‍🍳 Chef bids (batch=${BATCH_SIZE})...`);
    const chefBidResults = await batchAll(
      players,
      BATCH_SIZE,
      async (p) => {
        const fn = httpsCallable(p.functions, "submitBids");
        const bids = generateChefBids(p.index, chefPool);
        return await fn({ gameId, bidType: "chef", chefBids: bids });
      },
      500
    );
    assert(reportFailures(chefBidResults, "Chef bids"), "Chef bid failures");

    // bid_chef → roster
    await timed("Advance bid_chef → roster", async () => {
      const fn = httpsCallable(profFunctions, "advanceGamePhase");
      const result = await fn({ gameId });
      assert(result.data.phase === `round_${round}_roster`, `Got ${result.data.phase}`);
    });

    // Roster — layoffs + continue
    console.log(`  📋 Roster actions (batch=${BATCH_SIZE})...`);
    const playerSnaps = await gameRef.collection("players").get();
    const playerData = {};
    for (const doc of playerSnaps.docs) playerData[doc.id] = doc.data();

    const rosterResults = await batchAll(
      players,
      BATCH_SIZE,
      async (p) => {
        const data = playerData[p.uid];
        const chefs = Array.isArray(data.specialtyChefs) ? data.specialtyChefs : [];
        const cap = 3;
        if (chefs.length > cap) {
          for (const chef of chefs.slice(cap)) {
            const layoffFn = httpsCallable(p.functions, "layoffChef");
            await layoffFn({ gameId, chefId: chef.id });
          }
        }
        const continueFn = httpsCallable(p.functions, "continueFromRoster");
        await continueFn({ gameId });
      },
      500
    );
    assert(reportFailures(rosterResults, "Roster actions"), "Roster failures");

    // roster → decide
    await timed("Advance roster → decide", async () => {
      const fn = httpsCallable(profFunctions, "advanceGamePhase");
      const result = await fn({ gameId });
      assert(result.data.phase === `round_${round}_decide`, `Got ${result.data.phase}`);
    });

    // Station unlocks (~30% of players)
    console.log(`  🔓 Station unlocks (batch=${BATCH_SIZE})...`);
    const optionalProducts = ["cookie", "sandwich", "matcha"];
    const unlockPlayers = players.filter((p) => p.index % 3 === 0);
    const unlockResults = await batchAll(
      unlockPlayers,
      BATCH_SIZE,
      async (p) => {
        const product = optionalProducts[p.index % optionalProducts.length];
        const fn = httpsCallable(p.functions, "purchaseProduct");
        return await fn({ gameId, product });
      },
      500
    );
    reportFailures(unlockResults, "Unlocks"); // non-fatal

    // Fetch unlocked products per team
    const teamSnaps = await gameRef.collection("teams").get();
    const teamUnlocked = {};
    for (const doc of teamSnaps.docs) {
      const ups = doc.get("unlockedProducts");
      teamUnlocked[doc.id] = Array.isArray(ups) ? ups : ["croissant", "bagel", "coffee"];
    }
    const playerSnaps2 = await gameRef.collection("players").get();
    const playerTeamMap = {};
    for (const doc of playerSnaps2.docs) playerTeamMap[doc.id] = doc.get("teamId");

    // Decisions
    console.log(`  📝 Decisions (batch=${BATCH_SIZE})...`);
    const submitResults = await batchAll(
      players.map((p) => ({
        p,
        decision: generateDecision(
          p.index,
          gameId,
          playerData[p.uid]?.budgetCurrent || 10000,
          teamUnlocked[playerTeamMap[p.uid]] || ["croissant", "bagel", "coffee"]
        ),
      })),
      BATCH_SIZE,
      async ({ p, decision }) => {
        const fn = httpsCallable(p.functions, "submitDecision");
        return await fn(decision);
      },
      500
    );
    assert(reportFailures(submitResults, "Decisions"), "Decision submission failures");

    // decide → simulating → results_ready
    console.log(`  🧮 Advance → simulating → results_ready`);
    const simStart = Date.now();
    await timed("Advance to results_ready", async () => {
      const fn = httpsCallable(profFunctions, "advanceGamePhase");
      const result = await fn({ gameId });
      assert(result.data.phase === "results_ready", `Got ${result.data.phase}`);
    });
    console.log(`  ⏱️  Sim phase wall time: ${Date.now() - simStart}ms`);

    // Verification
    console.log(`  📊 Verification (Round ${round})`);

    await timed("Round doc complete", async () => {
      const snap = await gameRef.collection("rounds").doc(roundId).get();
      assert(snap.exists, "Round doc missing");
      assert(snap.get("simulationStatus") === "complete", `status=${snap.get("simulationStatus")}`);
      assert(snap.get("auctionResults"), "auctionResults missing");
    });

    await timed("Leaderboard has 100 entries", async () => {
      const lbSnap = await gameRef.collection("leaderboard").doc("latest").get();
      assert(lbSnap.exists, "Leaderboard missing");
      const rankings = lbSnap.get("rankings") || [];
      assert(rankings.length === PLAYER_COUNT, `Length=${rankings.length}`);
      for (let i = 0; i < rankings.length - 1; i++) {
        const a = rankings[i].revenueNet;
        const b = rankings[i + 1].revenueNet;
        assert(a >= b, `Sort error at ${i}: ${a} < ${b}`);
      }
    });

    await timed("No NaN budgets", async () => {
      const snap = await gameRef.collection("players").get();
      assert(snap.size === PLAYER_COUNT, `Count=${snap.size}`);
      for (const doc of snap.docs) {
        const budget = doc.get("budgetCurrent");
        assert(typeof budget === "number" && !Number.isNaN(budget), `${doc.id} budget NaN`);
      }
    });

    await timed("CSV rows exist", async () => {
      const csvSnaps = await Promise.all(
        players.map((p) => gameRef.collection("csvRows").doc(p.uid).collection("rounds").doc(roundId).get())
      );
      assert(csvSnaps.every((s) => s.exists), `${csvSnaps.filter((s) => !s.exists).length} CSV rows missing`);
    });

    await timed("Player round results valid", async () => {
      const resultSnaps = await Promise.all(
        players.map((p) => gameRef.collection("players").doc(p.uid).collection("rounds").doc(roundId).get())
      );
      assert(resultSnaps.every((s) => s.exists), `${resultSnaps.filter((s) => !s.exists).length} round results missing`);
      for (let i = 0; i < resultSnaps.length; i++) {
        const data = resultSnaps[i].data();
        assertClose(Math.round(data.budgetBefore + data.revenue - data.totalCosts), data.budgetAfter, 2, `${players[i].displayName} budget math`);
      }
    });

    await timed("submittedCount correct", async () => {
      const snap = await gameRef.get();
      assert(snap.get("submittedCount") === PLAYER_COUNT, `Count=${snap.get("submittedCount")}`);
    });

    if (round > 1) {
      await timed("No cross-round corruption", async () => {
        const r1Snap = await gameRef.collection("rounds").doc("round_1").get();
        assert(r1Snap.exists && r1Snap.get("simulationStatus") === "complete", "Round 1 corrupted");
      });
    }

    // Advance to next round or game_over
    const expectedNext = round < TOTAL_ROUNDS ? `round_${round + 1}_email` : "game_over";
    console.log(`  ➡️  Advance → ${expectedNext}`);
    await timed(`Advance to ${expectedNext}`, async () => {
      const fn = httpsCallable(profFunctions, "advanceGamePhase");
      const result = await fn({ gameId });
      assert(result.data.phase === expectedNext, `Got ${result.data.phase}`);
    });
  }

  // ─── Final Verification ────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log("🏁 FINAL VERIFICATION");
  console.log("═".repeat(60));

  await timed("Game in game_over", async () => {
    const snap = await gameRef.get();
    assert(snap.get("phase") === "game_over", `Got ${snap.get("phase")}`);
    assert(snap.get("endedAt") !== null, "endedAt missing");
  });

  await timed("All round docs complete", async () => {
    for (let r = 1; r <= TOTAL_ROUNDS; r++) {
      const snap = await gameRef.collection("rounds").doc(`round_${r}`).get();
      assert(snap.exists && snap.get("simulationStatus") === "complete", `round_${r} incomplete`);
    }
  });

  await timed("Final budgets consistent", async () => {
    for (const p of players) {
      let runningBudget = 10000;
      for (let r = 1; r <= TOTAL_ROUNDS; r++) {
        const snap = await gameRef.collection("players").doc(p.uid).collection("rounds").doc(`round_${r}`).get();
        const data = snap.data();
        runningBudget = Math.round(runningBudget + data.revenue - data.totalCosts);
      }
      const finalBudget = (await gameRef.collection("players").doc(p.uid).get()).get("budgetCurrent");
      assertClose(finalBudget, runningBudget, 3, `${p.displayName} final budget mismatch`);
    }
  });

  // Cleanup
  console.log(`\n🧹 Cleaning up game data...`);
  await db.recursiveDelete(gameRef);
  console.log("  Game data deleted.");

  console.log("\n" + "═".repeat(60));
  console.log("✅ STRESS TEST PASSED — all 100 players, 5 rounds, all phases");
  console.log("═".repeat(60));
}

main().catch((err) => {
  console.error("\n💥 FATAL ERROR:", err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
