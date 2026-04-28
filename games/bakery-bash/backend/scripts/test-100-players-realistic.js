/**
 * Bakery Bash — 100 Player Realistic Stress Test
 *
 * 76 human players in 25 teams of 3 + 1 solo
 * 24 bot players (solo) with named presets
 * All phases exercised with concurrent human submissions + bot triggers
 *
 * Run: npx firebase emulators:exec --only auth,firestore,functions \
 *        --project bakery-bash-54d12 \
 *        "node scripts/test-100-players-realistic.js"
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
const HUMAN_COUNT = parseInt(process.env.HUMAN_COUNT || process.env.PLAYER_COUNT || '76', 10);
const BOT_COUNT = parseInt(process.env.BOT_COUNT || '24', 10);
const TOTAL_ROUNDS = parseInt(process.env.TOTAL_ROUNDS || process.env.ROUNDS || '5', 10);
const TEAMS_OF_THREE = Math.floor((HUMAN_COUNT - 1) / 3);

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
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += c[Math.floor(Math.random() * c.length)];
  return code;
}

function createClient(nameSuffix) {
  const app = initializeClientApp({ projectId: PROJECT_ID, apiKey: "fake-api-key" }, `client_${nameSuffix}_${Date.now()}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${HOST}:${AUTH_PORT}`, { disableWarnings: true });
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, HOST, FUNCTIONS_PORT);
  return { app, auth, functions };
}

async function batchAll(items, batchSize, fn, delayMs = 500) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length && delayMs > 0) await sleep(delayMs);
  }
  return results;
}

function report(label, results) {
  const fails = results.filter((r) => r.status === "rejected");
  if (fails.length === 0) {
    console.log(`  ✅ ${label}: ${results.length}/${results.length} passed`);
    return true;
  }
  const summary = {};
  for (const f of fails) {
    const code = f.reason?.code || f.reason?.message?.slice(0, 50) || "unknown";
    summary[code] = (summary[code] || 0) + 1;
  }
  console.log(`  ⚠️  ${label}: ${fails.length}/${results.length} failed —`, summary);
  return false;
}

// ─── Generators ───────────────────────────────────────────────

function generateAdBids(idx, budget) {
  const surfaces = ["TV", "Billboard", "Radio", "Newspaper"];
  const bids = {};
  // Each player bids on 1-2 surfaces with varying amounts
  surfaces.forEach((s, i) => {
    if ((idx + i) % 3 === 0) bids[s] = Math.min(200, 15 + (idx % 100));
    else bids[s] = 0;
  });
  return bids;
}

function generateChefBids(idx, chefPool) {
  if (!chefPool || chefPool.length === 0) return [];
  const bids = [];
  chefPool.forEach((chef, i) => {
    if ((idx + i) % 4 === 0) {
      const floor = chef.minBidFloor || 20;
      bids.push({ chefId: chef.id, amount: floor + (idx % 35) });
    }
  });
  return bids;
}

function generateDecision(idx, budget, unlockedProducts) {
  const base = ["croissant", "bagel", "coffee"];
  const optional = ["cookie", "sandwich", "matcha"];
  const unlockedSet = new Set([...base, ...unlockedProducts]);

  const menu = {};
  for (const p of base) menu[p] = true;
  for (const p of optional) menu[p] = unlockedSet.has(p) && (idx % 3 === 0 || idx % 7 === 0);
  const offered = [...base, ...optional].filter((p) => menu[p]);

  const quantities = {};
  for (const p of base) quantities[p] = 8 + (idx % 18);
  for (const p of optional) quantities[p] = menu[p] ? 6 + (idx % 12) : 0;

  const sousChefCount = 1 + (idx % 5);
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

  return { menu, quantities, sousChefCount, sousChefAssignments, staffCounts: {}, maintenanceTasks: [] };
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════════════╗");
  console.log("║   BAKERY BASH — 100 PLAYER REALISTIC STRESS TEST                     ║");
  console.log("║   76 humans (25×3 + 1 solo) + 24 bots with presets                   ║");
  console.log("╚═══════════════════════════════════════════════════════════════════════╝\n");

  // Professor
  const profClient = createClient("prof");
  const profAuth = getAuth(profClient.app);
  const profCred = await signInAnonymously(profAuth);
  const professorUid = profCred.user.uid;
  const profFunctions = getFunctions(profClient.app);
  console.log(`👨‍🏫 Professor UID: ${professorUid}`);

  // Create 76 human clients
  console.log(`\n🔧 Creating ${HUMAN_COUNT} human player clients...`);
  const humans = [];
  for (let i = 0; i < HUMAN_COUNT; i++) {
    const client = createClient(`human_${i}`);
    humans.push({ index: i, displayName: `Player_${i + 1}`, ...client });
  }

  // Sign in all humans
  console.log(`🔑 Signing in ${HUMAN_COUNT} humans...`);
  const signInResults = await batchAll(
    humans, 15, async (p) => {
      const cred = await signInAnonymously(p.auth);
      p.uid = cred.user.uid;
    }, 400
  );
  assert(report("Sign-in", signInResults), "Sign-in failures");

  // Create game
  const gameId = `real100_${Date.now()}`;
  const joinCode = randomCode();
  const gameRef = db.collection("games").doc(gameId);

  console.log(`\n🎮 Creating game ${gameId} (joinCode: ${joinCode})...`);
  await gameRef.set({
    joinCode, phase: "lobby", currentRound: 1, totalRounds: TOTAL_ROUNDS,
    totalPlayers: 0, submittedCount: 0, professorId: professorUid,
    paused: false, createdAt: FieldValue.serverTimestamp(),
    startedAt: null, endedAt: null, phaseStartedAt: null, phaseEndTime: null,
  });

  await gameRef.collection("config").doc("params").set({
    startingBudget: 10000, playerCap: 120, costPerStaffPerRound: 10, unitCostPerProduct: 1,
    revenueCoefficients: { base: 10, sousChefCoeff: 0.5, satisfactionCoeff: 1.2, adSpendCoeff: 0, numProductsCoeff: 2, noiseMin: -2, noiseMax: 2 },
    adBonuses: { TV: 400, Billboard: 250, Radio: 150, Newspaper: 80 },
    phaseDurations: { email: 15, decide: 300, bid_ad: 90, bid_chef: 90, roster: 60, simulating: 8, results: 60 },
    totalRounds: TOTAL_ROUNDS, specialtyChefCap: 3, chefPoolSize: 12,
  });

  // Create 25 teams (first 25 humans)
  console.log(`\n📋 Creating ${TEAMS_OF_THREE} teams...`);
  const teamCreators = humans.slice(0, TEAMS_OF_THREE);
  const teamJoiners = humans.slice(TEAMS_OF_THREE, TEAMS_OF_THREE * 3); // 50 joiners
  const soloHuman = humans[TEAMS_OF_THREE * 3]; // 1 solo

  const teamResults = await batchAll(
    teamCreators, 8,
    async (p) => {
      const fn = httpsCallable(p.functions, "createTeam");
      const result = await fn({ joinCode, displayName: p.displayName, teamName: `Team_${p.index + 1}` });
      p.teamId = result.data.teamId;
      return result.data;
    }, 600
  );
  assert(report("Team creation", teamResults), "Team creation failed");

  // Map team creators to their teamIds for joiners
  const teamIds = teamCreators.map((p) => p.teamId);

  // 50 players join existing teams (2 per team)
  console.log(`📋 ${teamJoiners.length} players joining teams...`);
  const joinResults = await batchAll(
    teamJoiners, 15,
    async (p) => {
      const teamIndex = (p.index - TEAMS_OF_THREE) % TEAMS_OF_THREE;
      const teamId = teamIds[teamIndex];
      const fn = httpsCallable(p.functions, "joinGame");
      const result = await fn({ joinCode, displayName: p.displayName, teamId });
      p.teamId = teamId;
      return result.data;
    }, 400
  );
  assert(report("Team joins", joinResults), "Team join failed");

  // 1 solo player creates their own team
  console.log(`📋 1 solo player...`);
  const soloFn = httpsCallable(soloHuman.functions, "createTeam");
  const soloResult = await soloFn({ joinCode, displayName: soloHuman.displayName, teamName: `Solo_${soloHuman.index + 1}` });
  soloHuman.teamId = soloResult.data.teamId;

  // Add 24 bots via professor
  console.log(`\n🤖 Adding ${BOT_COUNT} bots with presets...`);
  const presets = [
    "chaotic_charlie", "unlucky_larry", "balanced_bob", "cautious_carla",
    "risky_ricky", "chef_pierre", "marketing_molly", "perfect_patricia",
  ];
  const createBotFn = httpsCallable(profFunctions, "createBotPlayer");

  const botResults = await batchAll(
    Array.from({ length: BOT_COUNT }), 8,
    async (_, i) => {
      const preset = presets[i % presets.length];
      return await createBotFn({ gameId, preset });
    }, 300
  );
  assert(report("Bot creation", botResults), "Bot creation failed");

  // Verify total players
  await timed("Total players = 100", async () => {
    const snap = await gameRef.get();
    assert(snap.get("totalPlayers") === HUMAN_COUNT + BOT_COUNT, `totalPlayers=${snap.get("totalPlayers")}`);
  });

  // Start game
  console.log(`\n🚀 Starting game...`);
  await timed("startGame", async () => {
    const fn = httpsCallable(profFunctions, "startGame");
    const result = await fn({ gameId });
    assert(result.data.phase === "round_1_email", `Got ${result.data.phase}`);
  });

  // ─── ROUNDS ─────────────────────────────────────────────────
  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`🎯 ROUND ${round} of ${TOTAL_ROUNDS}`);
    console.log("═".repeat(60));
    const roundId = `round_${round}`;

    // Helper to advance phase
    async function advancePhase(expected) {
      const fn = httpsCallable(profFunctions, "advanceGamePhase");
      const result = await fn({ gameId });
      assert(result.data.phase === expected, `Expected ${expected}, got ${result.data.phase}`);
    }

    // email → bid_ad
    await timed("Advance email → bid_ad", () => advancePhase(`round_${round}_bid_ad`));

    // Bid Ad: all 76 humans submit concurrently + bots auto-fire via trigger
    console.log(`  📢 Ad bids: 76 humans concurrent + 24 bots via trigger...`);
    const adBidStart = Date.now();
    // Small delay to let bot trigger start, then fire humans in parallel
    await sleep(200);
    const adBidResults = await Promise.allSettled(
      humans.map(async (p) => {
        const fn = httpsCallable(p.functions, "submitBids");
        const bids = generateAdBids(p.index, 10000);
        return await fn({ gameId, bidType: "ad", ...bids });
      })
    );
    console.log(`  ⏱️  Ad bids: ${Date.now() - adBidStart}ms`);
    assert(report("Ad bids", adBidResults), "Ad bid failures");

    // bid_ad → bid_chef
    await timed("Advance bid_ad → bid_chef", () => advancePhase(`round_${round}_bid_chef`));

    // Fetch chef pool
    const roundDoc = await gameRef.collection("rounds").doc(roundId).get();
    const chefPool = (roundDoc.exists && roundDoc.data().chefPool) || [];
    console.log(`  👨‍🍳 Chef pool: ${chefPool.length} chefs`);

    // Bid Chef: all 76 humans concurrent + bots
    console.log(`  👨‍🍳 Chef bids: 76 humans concurrent + 24 bots via trigger...`);
    const chefBidStart = Date.now();
    await sleep(200);
    const chefBidResults = await Promise.allSettled(
      humans.map(async (p) => {
        const fn = httpsCallable(p.functions, "submitBids");
        const bids = generateChefBids(p.index, chefPool);
        return await fn({ gameId, bidType: "chef", chefBids: bids });
      })
    );
    console.log(`  ⏱️  Chef bids: ${Date.now() - chefBidStart}ms`);
    assert(report("Chef bids", chefBidResults), "Chef bid failures");

    // bid_chef → roster
    await timed("Advance bid_chef → roster", () => advancePhase(`round_${round}_roster`));

    // Roster: humans continue + bots auto-fire
    console.log(`  📋 Roster: 76 humans + 24 bots...`);
    const rosterStart = Date.now();
    await sleep(200);

    // Fetch current chef counts for humans
    const playerSnaps = await gameRef.collection("players").get();
    const playerData = {};
    for (const doc of playerSnaps.docs) playerData[doc.id] = doc.data();

    const rosterResults = await Promise.allSettled(
      humans.map(async (p) => {
        const data = playerData[p.uid];
        const chefs = Array.isArray(data?.specialtyChefs) ? data.specialtyChefs : [];
        const cap = 3;
        if (chefs.length > cap) {
          for (const chef of chefs.slice(cap)) {
            const layoffFn = httpsCallable(p.functions, "layoffChef");
            await layoffFn({ gameId, chefId: chef.id });
          }
        }
        const continueFn = httpsCallable(p.functions, "continueFromRoster");
        await continueFn({ gameId });
      })
    );
    console.log(`  ⏱️  Roster: ${Date.now() - rosterStart}ms`);
    assert(report("Roster", rosterResults), "Roster failures");

    // roster → decide
    await timed("Advance roster → decide", () => advancePhase(`round_${round}_decide`));

    // Station unlocks: ~30% of humans unlock an optional product
    console.log(`  🔓 Station unlocks...`);
    const optionalProducts = ["cookie", "sandwich", "matcha"];
    const unlockPlayers = humans.filter((p) => p.index % 3 === 0);
    const unlockResults = await Promise.allSettled(
      unlockPlayers.map(async (p) => {
        const product = optionalProducts[p.index % optionalProducts.length];
        const fn = httpsCallable(p.functions, "purchaseProduct");
        return await fn({ gameId, product });
      })
    );
    report("Unlocks", unlockResults); // non-fatal

    // Fetch team unlocks for decision generation
    const teamSnaps = await gameRef.collection("teams").get();
    const teamUnlocked = {};
    for (const doc of teamSnaps.docs) {
      const ups = doc.get("unlockedProducts");
      teamUnlocked[doc.id] = Array.isArray(ups) ? ups : ["croissant", "bagel", "coffee"];
    }
    const playerSnaps2 = await gameRef.collection("players").get();
    const playerTeamMap = {};
    for (const doc of playerSnaps2.docs) playerTeamMap[doc.id] = doc.get("teamId");

    // Decide: all 76 humans submit concurrently + bots via trigger
    console.log(`  📝 Decisions: 76 humans concurrent + 24 bots via trigger...`);
    const decideStart = Date.now();
    await sleep(200);

    const decideResults = await Promise.allSettled(
      humans.map(async (p) => {
        const teamId = playerTeamMap[p.uid];
        const unlocked = teamUnlocked[teamId] || ["croissant", "bagel", "coffee"];
        const budget = playerData[p.uid]?.budgetCurrent || 10000;
        const fn = httpsCallable(p.functions, "submitDecision");
        return await fn({ gameId, ...generateDecision(p.index, budget, unlocked) });
      })
    );
    console.log(`  ⏱️  Decisions: ${Date.now() - decideStart}ms`);
    assert(report("Decisions", decideResults), "Decision failures");

    // decide → results_ready (runs simulation)
    console.log(`  🧮 Running simulation...`);
    const simStart = Date.now();
    await timed("Advance to results_ready", () => advancePhase("results_ready"));
    console.log(`  ⏱️  Sim wall time: ${Date.now() - simStart}ms`);

    // Verification
    console.log(`  📊 Verification (Round ${round})`);

    await timed("Round doc complete", async () => {
      const snap = await gameRef.collection("rounds").doc(roundId).get();
      assert(snap.exists && snap.get("simulationStatus") === "complete", "Incomplete");
    });

    await timed("No NaN budgets", async () => {
      const snap = await gameRef.collection("players").get();
      let nanCount = 0;
      for (const doc of snap.docs) {
        const b = doc.get("budgetCurrent");
        if (typeof b !== "number" || Number.isNaN(b)) nanCount++;
      }
      assert(nanCount === 0, `${nanCount} NaN budgets`);
    });

    await timed("All round results exist", async () => {
      const allPlayers = await gameRef.collection("players").get();
      const snaps = await Promise.all(
        allPlayers.docs.map((d) => d.ref.collection("rounds").doc(roundId).get())
      );
      const missing = snaps.filter((s) => !s.exists).length;
      assert(missing === 0, `${missing} missing round results`);
    });

    await timed("submittedCount = 100", async () => {
      const snap = await gameRef.get();
      const sc = snap.get("submittedCount");
      assert(sc === HUMAN_COUNT + BOT_COUNT, `submittedCount=${sc}`);
    });

    if (round > 1) {
      await timed("No cross-round corruption", async () => {
        const r1 = await gameRef.collection("rounds").doc("round_1").get();
        assert(r1.exists && r1.get("simulationStatus") === "complete", "Round 1 corrupted");
      });
    }

    // Advance to next or game_over
    const expectedNext = round < TOTAL_ROUNDS ? `round_${round + 1}_email` : "game_over";
    console.log(`  ➡️  Advance → ${expectedNext}`);
    await timed(`Advance to ${expectedNext}`, () => advancePhase(expectedNext));
  }

  // ─── Final Verification ────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log("🏁 FINAL VERIFICATION");
  console.log("═".repeat(60));

  await timed("Game in game_over", async () => {
    const snap = await gameRef.get();
    assert(snap.get("phase") === "game_over", `Got ${snap.get("phase")}`);
  });

  await timed("All 5 rounds complete", async () => {
    for (let r = 1; r <= TOTAL_ROUNDS; r++) {
      const snap = await gameRef.collection("rounds").doc(`round_${r}`).get();
      assert(snap.exists && snap.get("simulationStatus") === "complete", `round_${r} incomplete`);
    }
  });

  // Cleanup
  console.log(`\n🧹 Cleaning up...`);
  await db.recursiveDelete(gameRef);

  console.log("\n" + "═".repeat(60));
  console.log("✅ REALISTIC STRESS TEST PASSED");
  console.log("   76 humans (25×3 + 1 solo) + 24 preset bots");
  console.log("   All 5 rounds, all phases, concurrent submissions");
  console.log("═".repeat(60));
}

main().catch((err) => {
  console.error("\n💥 FATAL:", err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
