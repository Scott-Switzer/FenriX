/**
 * Bakery Bash — 70 Player Stress Test
 *
 * Simulates 70 concurrent students through a full multi-round game.
 * Tests race conditions, data consistency, auction resolution, and
 * performance under load.
 *
 * Run with: node scripts/test-70-players.js
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
const HOST = "127.0.0.1";
const FUNCTIONS_PORT = 5001;
const AUTH_PORT = 9099;
const FIRESTORE_PORT = 8080;
const PLAYER_COUNT = 70;
const TOTAL_ROUNDS = 2;
const STARTING_BUDGET = 2000;

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

function randomCode() {
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += charset[Math.floor(Math.random() * charset.length)];
  }
  return code;
}

function createPlayerClient(index) {
  const name = `stress_player_${index}_${Date.now()}`;
  const app = initializeClientApp(
    {
      projectId: PROJECT_ID,
      apiKey: "fake-api-key",
    },
    name
  );
  const pAuth = getAuth(app);
  connectAuthEmulator(pAuth, `http://${HOST}:${AUTH_PORT}`, {
    disableWarnings: true,
  });
  const pFunctions = getFunctions(app);
  connectFunctionsEmulator(pFunctions, HOST, FUNCTIONS_PORT);
  return { app, auth: pAuth, functions: pFunctions };
}

/**
 * Generate a decision that varies per player to exercise auction logic.
 * Guarantees totalCostsMax <= budget.
 */
function generateDecision(playerIndex, gameId, budget) {
  const staffCount = 3 + (playerIndex % 8); // 3–10

  const adTypeChoices = ["TV", "Billboard", "Radio", "Newspaper"];
  const adType = playerIndex % 3 === 0 ? adTypeChoices[playerIndex % 4] : null;
  const adSpend = adType ? 30 + (playerIndex % 50) : 0;

  const chefBidAmount = playerIndex % 5 === 0 ? 20 + (playerIndex % 40) : 0;

  // Menu: base products (croissant, cookie, bagel) cannot be disabled —
  // the validator rejects `menu.cookie === false`. Optional products are
  // sandwich, coffee, matcha (NOT latte/matchaLatte — those names don't
  // match PRODUCT_KEYS in modules/config.js).
  const menu = {
    croissant: true,
    cookie: true,
    bagel: true,
    sandwich: playerIndex % 3 === 0,
    coffee: true,
    matcha: playerIndex % 4 === 0,
  };

  const productPrices = {
    croissant: 4 + (playerIndex % 5),
    cookie: 3 + (playerIndex % 4),
    bagel: 3 + (playerIndex % 6),
    sandwich: menu.sandwich ? 5 + (playerIndex % 5) : 0,
    coffee: 5 + (playerIndex % 4),
    matcha: menu.matcha ? 6 + (playerIndex % 5) : 0,
  };

  let quantities = {
    croissant: 15 + (playerIndex % 20),
    cookie: 10 + (playerIndex % 15),
    bagel: 15 + (playerIndex % 20),
    sandwich: menu.sandwich ? 10 + (playerIndex % 15) : 0,
    coffee: 15 + (playerIndex % 20),
    matcha: menu.matcha ? 10 + (playerIndex % 15) : 0,
  };

  const staffCost = staffCount * 50;
  const stockCost = Object.values(quantities).reduce((s, q) => s + q, 0);
  const totalMaxCost = staffCost + stockCost + adSpend + chefBidAmount;

  if (totalMaxCost > budget) {
    const availableForStock = Math.max(0, budget - staffCost - adSpend - chefBidAmount);
    const scale = stockCost > 0 ? availableForStock / stockCost : 0;
    for (const key of Object.keys(quantities)) {
      quantities[key] = Math.floor(quantities[key] * scale);
    }
  }

  return {
    gameId,
    staffCount,
    adSpend,
    adType,
    menu,
    productPrices,
    quantities,
    chefBid: {
      skillLevel: Math.min(100, (playerIndex * 7) % 101),
      amount: chefBidAmount,
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║   BAKERY BASH — 70 PLAYER STRESS TEST                ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  // ─── Professor client ───────────────────────────────────────
  const profApp = initializeClientApp(
    { projectId: PROJECT_ID, apiKey: "fake-api-key" },
    `prof_${Date.now()}`
  );
  const profAuth = getAuth(profApp);
  connectAuthEmulator(profAuth, `http://${HOST}:${AUTH_PORT}`, {
    disableWarnings: true,
  });
  const profFunctions = getFunctions(profApp);
  connectFunctionsEmulator(profFunctions, HOST, FUNCTIONS_PORT);

  const profCred = await signInAnonymously(profAuth);
  const professorUid = profCred.user.uid;
  console.log(`👨‍🏫 Professor UID: ${professorUid}`);

  // ─── Create 70 player clients ──────────────────────────────
  console.log(`\n🔧 Creating ${PLAYER_COUNT} player clients...`);
  const players = [];
  for (let i = 0; i < PLAYER_COUNT; i++) {
    const client = createPlayerClient(i);
    players.push({
      index: i,
      displayName: `Bakery_${i + 1}`,
      ...client,
    });
  }

  // ─── Sign in all players concurrently ──────────────────────
  console.log(`🔑 Signing in ${PLAYER_COUNT} players concurrently...`);
  const signInStart = Date.now();
  await Promise.all(
    players.map(async (p) => {
      const cred = await signInAnonymously(p.auth);
      p.uid = cred.user.uid;
    })
  );
  console.log(`  ⏱️  All signed in: ${Date.now() - signInStart}ms`);

  // ─── Create game + config via admin SDK ────────────────────
  const gameId = `stress70_${Date.now()}`;
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
    startingBudget: STARTING_BUDGET,
    // Default playerCap is 20; raise it so the 70-player stress test
    // exercises the contended-write path rather than just hitting the cap.
    playerCap: PLAYER_COUNT + 10,
    costPerStaffPerRound: 50,
    unitCostPerProduct: 1,
    revenueModel: {
      base: 500,
      staffCoefficient: 30,
      priceCoefficient: -15,
      adSpendCoefficient: 0.8,
      numProductsCoefficient: 50,
      noiseMin: -50,
      noiseMax: 50,
    },
    adBonuses: { TV: 200, Billboard: 150, Radio: 100, Newspaper: 75 },
    chefBonusPerPoint: 5,
    customerPoolMultiplier: 100,
    phaseDurations: {
      closing_hours: 300,
      auction: 120,
      open_for_business: 60,
      results: 60,
    },
    attractivenessWeights: {
      priceWeight: 100,
      staffWeight: 5,
      adSpendWeight: 0.3,
      numProductsWeight: 10,
    },
  });

  // ─── PHASE: Join ───────────────────────────────────────────
  console.log(`\n📋 PHASE: ${PLAYER_COUNT} Players Joining`);
  const joinStart = Date.now();

  const joinResults = await Promise.allSettled(
    players.map(async (p) => {
      const fn = httpsCallable(p.functions, "joinGame");
      // joinGame requires a teamNumber (1–8) or teamId — distribute the 70
      // players across all 8 teams so every team gets ~9 members.
      const teamNumber = (p.index % 8) + 1;
      const result = await fn({ joinCode, displayName: p.displayName, teamNumber });
      assert(result.data.gameId === gameId, `${p.displayName} joined wrong game`);
      return result.data;
    })
  );

  const joinFailures = joinResults.filter((r) => r.status === "rejected");
  if (joinFailures.length > 0) {
    console.log("  First 3 join errors:");
    joinFailures.slice(0, 3).forEach((r) => console.log("    ", r.reason?.message || r.reason));
  }
  assert(joinFailures.length === 0, `${joinFailures.length} joins failed`);
  console.log(`  ⏱️  All joins: ${Date.now() - joinStart}ms`);

  await timed("Game totalPlayers === 70", async () => {
    const snap = await gameRef.get();
    assert(
      snap.get("totalPlayers") === PLAYER_COUNT,
      `totalPlayers = ${snap.get("totalPlayers")}`
    );
  });

  // Verify no duplicate player docs and all displayNames match
  await timed("All player docs valid", async () => {
    const snap = await gameRef.collection("players").get();
    assert(snap.size === PLAYER_COUNT, `Player doc count = ${snap.size}`);
    const names = new Set();
    for (const doc of snap.docs) {
      const name = doc.get("displayName");
      assert(name && name.startsWith("Bakery_"), `Invalid name: ${name}`);
      assert(!names.has(name), `Duplicate name: ${name}`);
      names.add(name);
      const budget = doc.get("budgetCurrent");
      assert(budget === STARTING_BUDGET, `Wrong starting budget for ${name}`);
    }
  });

  // ─── PHASE: Start Game ─────────────────────────────────────
  console.log(`\n🚀 PHASE: Start Game`);
  await timed("Professor starts game", async () => {
    const fn = httpsCallable(profFunctions, "startGame");
    const result = await fn({ gameId });
    // Canonical phase flow: lobby → round_1_email (per modules/phases.js).
    assert(result.data.phase === "round_1_email", `Got ${result.data.phase}`);
    assert(result.data.round === 1, "Round should be 1");
  });

  // ─── ROUNDS ────────────────────────────────────────────────
  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`🎯 ROUND ${round} of ${TOTAL_ROUNDS}`);
    console.log("═".repeat(60));

    const roundId = `round_${round}`;

    // Walk forward through the bid_ad / bid_chef / roster phases to land on
    // round_N_decide, where submitDecision is accepted. Players don't bid in
    // this stress test — the goal is to exercise concurrent decision writes.
    await timed("Advance email → decide (4 phases)", async () => {
      const fn = httpsCallable(profFunctions, "advanceGamePhase");
      let last;
      for (let i = 0; i < 4; i++) {
        last = await fn({ gameId });
      }
      assert(
        last.data.phase === `round_${round}_decide`,
        `Got ${last.data.phase}`
      );
    });

    // Generate decisions
    const decisions = players.map((p) =>
      generateDecision(p.index, gameId, STARTING_BUDGET)
    );

    // ─── Decide phase: Concurrent submissions ────────────────
    console.log(`\n  📝 Submitting ${PLAYER_COUNT} decisions concurrently...`);
    const submitStart = Date.now();

    const submitResults = await Promise.allSettled(
      players.map(async (p, i) => {
        const fn = httpsCallable(p.functions, "submitDecision");
        return await fn(decisions[i]);
      })
    );

    const submitElapsed = Date.now() - submitStart;
    const submitFailures = submitResults.filter((r) => r.status === "rejected");
    console.log(
      `  ⏱️  Submissions: ${submitElapsed}ms (${submitFailures.length} failures)`
    );
    if (submitFailures.length > 0) {
      // P0-2 debug: surface the first few error codes/messages so we can tell
      // contention aborts (deadline-exceeded / aborted / internal) apart
      // from validation rejects (already-exists / failed-precondition).
      const summary = {};
      for (const f of submitFailures) {
        const code = f.reason?.code || f.reason?.message?.slice(0, 40) || "unknown";
        summary[code] = (summary[code] || 0) + 1;
      }
      console.log("  Failure breakdown:", summary);
      console.log("  First 3 errors:", submitFailures.slice(0, 3).map(f => f.reason?.message));
    }
    assert(submitFailures.length === 0, `${submitFailures.length} submissions failed`);

    // Verify all decision docs exist (race-condition check)
    await timed("All decision docs written", async () => {
      const decisionSnaps = await Promise.all(
        players.map((p) =>
          gameRef.collection("players").doc(p.uid).collection("decisions").doc(roundId).get()
        )
      );
      const missing = decisionSnaps.filter((s) => !s.exists).length;
      assert(missing === 0, `${missing} decision docs missing`);
    });

    // ─── Advance: decide → simulating → results_ready ────────
    // advanceGamePhase runs the simulation synchronously when transitioning
    // out of the `decide` phase, then commits the simulating→results_ready
    // transition before returning. A single call covers what used to be
    // "advance to auction" + "advance to open_for_business" + polling.
    console.log(`\n  🧮 Advance → simulating → results_ready (runs simulation)`);
    const simStart = Date.now();
    await timed("Advance to results_ready", async () => {
      const fn = httpsCallable(profFunctions, "advanceGamePhase");
      const result = await fn({ gameId });
      assert(
        result.data.phase === "results_ready",
        `Got ${result.data.phase}`
      );
    });
    const totalSimTime = Date.now() - simStart;
    console.log(`  ⏱️  Total sim phase: ${totalSimTime}ms`);

    // ─── VERIFICATION ────────────────────────────────────────
    console.log(`\n  📊 Verification (Round ${round})`);

    await timed("Round aggregate doc complete", async () => {
      const roundSnap = await gameRef.collection("rounds").doc(roundId).get();
      assert(roundSnap.exists, "Round doc missing");
      assert(
        roundSnap.get("simulationStatus") === "complete",
        `simulationStatus = ${roundSnap.get("simulationStatus")}`
      );
      assert(roundSnap.get("round") === round, "Round number mismatch");
      assert(roundSnap.get("completedAt"), "completedAt missing");

      const stats = roundSnap.get("classStats");
      assert(stats, "classStats missing");
      assert(typeof stats.avgRevenue === "number", "avgRevenue not a number");
      assert(typeof stats.maxRevenue === "number", "maxRevenue not a number");
      assert(typeof stats.minRevenue === "number", "minRevenue not a number");
      assert(typeof stats.avgCustomerCount === "number", "avgCustomerCount not a number");
      assert(
        stats.totalCustomerPool === PLAYER_COUNT * 100,
        `Customer pool = ${stats.totalCustomerPool}`
      );

      // No bids are submitted in this stress test (the goal is concurrent
      // decision writes), so we only check that the auction-results document
      // was written. Auction-shape verification belongs in tests that
      // actually exercise the bidding flow.
      const auctions = roundSnap.get("auctionResults");
      assert(auctions, "auctionResults missing");
    });

    await timed("Leaderboard has 70 entries", async () => {
      const lbSnap = await gameRef.collection("leaderboard").doc("current").get();
      assert(lbSnap.exists, "Leaderboard missing");
      const rankings = lbSnap.get("rankings");
      assert(Array.isArray(rankings), "Rankings not an array");
      assert(
        rankings.length === PLAYER_COUNT,
        `Rankings length = ${rankings.length}`
      );
      for (let i = 0; i < rankings.length - 1; i++) {
        assert(
          rankings[i].cumulativeRevenue >= rankings[i + 1].cumulativeRevenue,
          `Leaderboard not sorted at ${i}`
        );
      }
      assert(rankings[0].rank === 1, "Top rank not 1");
    });

    await timed("No NaN / corrupted budgets", async () => {
      const snap = await gameRef.collection("players").get();
      assert(snap.size === PLAYER_COUNT, `Player count = ${snap.size}`);
      for (const doc of snap.docs) {
        const budget = doc.get("budgetCurrent");
        assert(
          typeof budget === "number" && !Number.isNaN(budget),
          `${doc.id} budget is NaN or not a number`
        );
        const cumRev = doc.get("cumulativeRevenue");
        assert(
          typeof cumRev === "number" && !Number.isNaN(cumRev),
          `${doc.id} cumulativeRevenue is NaN`
        );
      }
    });

    await timed("CSV rows exist for all players", async () => {
      const csvSnaps = await Promise.all(
        players.map((p) =>
          gameRef.collection("csvRows").doc(p.uid).collection("rounds").doc(roundId).get()
        )
      );
      const missing = csvSnaps.filter((s) => !s.exists).length;
      assert(missing === 0, `${missing} CSV rows missing`);

      for (let i = 0; i < csvSnaps.length; i++) {
        const row = csvSnaps[i].get("row");
        assert(row, `${players[i].displayName} CSV row empty`);
        assert(row.day === round, `${players[i].displayName} CSV day mismatch`);
        assert(typeof row.revenue === "number", `${players[i].displayName} CSV revenue invalid`);
      }
    });

    await timed("Player round results valid", async () => {
      const resultSnaps = await Promise.all(
        players.map((p) =>
          gameRef.collection("players").doc(p.uid).collection("rounds").doc(roundId).get()
        )
      );
      const missing = resultSnaps.filter((s) => !s.exists).length;
      assert(missing === 0, `${missing} round results missing`);

      for (let i = 0; i < resultSnaps.length; i++) {
        const data = resultSnaps[i].data();
        assert(data.round === round, `${players[i].displayName} round mismatch`);
        assert(typeof data.revenue === "number", `${players[i].displayName} revenue invalid`);
        assert(typeof data.totalCosts === "number", `${players[i].displayName} totalCosts invalid`);
        assert(typeof data.budgetBefore === "number", `${players[i].displayName} budgetBefore invalid`);
        assert(typeof data.budgetAfter === "number", `${players[i].displayName} budgetAfter invalid`);

        const expectedAfter = Math.round(data.budgetBefore + data.revenue - data.totalCosts);
        assertClose(
          data.budgetAfter,
          expectedAfter,
          1,
          `${players[i].displayName} budget math`
        );
      }
    });

    await timed("submittedCount tracked correctly", async () => {
      const snap = await gameRef.get();
      const submittedCount = snap.get("submittedCount");
      assert(
        submittedCount === PLAYER_COUNT,
        `submittedCount = ${submittedCount}, expected ${PLAYER_COUNT}`
      );
    });

    // Verify no data corruption from previous rounds
    if (round > 1) {
      await timed("No data corruption across rounds", async () => {
        // Round 1 doc should still be complete
        const r1Snap = await gameRef.collection("rounds").doc("round_1").get();
        assert(r1Snap.exists, "Round 1 doc missing");
        assert(
          r1Snap.get("simulationStatus") === "complete",
          "Round 1 simulationStatus corrupted"
        );

        // All round 1 results should still exist
        const r1Results = await Promise.all(
          players.map((p) =>
            gameRef.collection("players").doc(p.uid).collection("rounds").doc("round_1").get()
          )
        );
        assert(
          r1Results.every((s) => s.exists),
          "Some round 1 results missing"
        );

        // Round 1 CSV rows should still exist
        const r1Csvs = await Promise.all(
          players.map((p) =>
            gameRef.collection("csvRows").doc(p.uid).collection("rounds").doc("round_1").get()
          )
        );
        assert(r1Csvs.every((s) => s.exists), "Some round 1 CSV rows missing");

        // Leaderboard cumulativeRevenue should match player docs
        const lbSnap = await gameRef.collection("leaderboard").doc("current").get();
        const rankings = lbSnap.get("rankings") || [];
        for (const rank of rankings) {
          const pSnap = await gameRef.collection("players").doc(rank.playerId).get();
          assertClose(
            pSnap.get("cumulativeRevenue"),
            rank.cumulativeRevenue,
            1,
            `Leaderboard/player cumulativeRevenue mismatch for ${rank.displayName}`
          );
        }
      });
    }

    // Emails should be created for rounds that have a next round
    if (round < TOTAL_ROUNDS) {
      await timed("CSV emails queued", async () => {
        const emailSnaps = await Promise.all(
          players.map((p) =>
            gameRef
              .collection("players")
              .doc(p.uid)
              .collection("emails")
              .doc(`round_${round + 1}_data`)
              .get()
          )
        );
        const missing = emailSnaps.filter((s) => !s.exists).length;
        assert(missing === 0, `${missing} emails missing`);

        for (let i = 0; i < emailSnaps.length; i++) {
          const data = emailSnaps[i].data();
          assert(data.type === "round_data_csv", `${players[i].displayName} email type wrong`);
          assert(data.round === round + 1, `${players[i].displayName} email round wrong`);
          assert(data.attachments?.length === 1, `${players[i].displayName} missing attachment`);
          assert(
            data.attachments[0].contentType === "text/csv",
            `${players[i].displayName} wrong contentType`
          );
          assert(
            data.attachments[0].rowCount === round,
            `${players[i].displayName} wrong rowCount`
          );
        }
      });
    }

    // ─── Advance from results_ready → next round / game_over ─
    const expectedNext =
      round < TOTAL_ROUNDS ? `round_${round + 1}_email` : "game_over";
    console.log(`\n  ➡️  Advance → ${expectedNext}`);
    await timed(`Advance to ${expectedNext}`, async () => {
      const fn = httpsCallable(profFunctions, "advanceGamePhase");
      const result = await fn({ gameId });
      assert(result.data.phase === expectedNext, `Got ${result.data.phase}`);
      if (round < TOTAL_ROUNDS) {
        const snap = await gameRef.get();
        assert(snap.get("currentRound") === round + 1, `Round mismatch`);
      }
    });
  }

  // ─── Final Phase: game_over ────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log("🏁 FINAL VERIFICATION");
  console.log("═".repeat(60));

  await timed("Game in game_over phase", async () => {
    const snap = await gameRef.get();
    assert(snap.get("phase") === "game_over", `Got ${snap.get("phase")}`);
    assert(snap.get("endedAt") !== null, "endedAt missing");
  });

  await timed("No round_N+1 emails created", async () => {
    const emailSnaps = await Promise.all(
      players.map((p) =>
        gameRef
          .collection("players")
          .doc(p.uid)
          .collection("emails")
          .doc(`round_${TOTAL_ROUNDS + 1}_data`)
          .get()
      )
    );
    const existing = emailSnaps.filter((s) => s.exists).length;
    assert(existing === 0, `${existing} unexpected emails found`);
  });

  await timed("Final budgets consistent with round-by-round math", async () => {
    for (const p of players) {
      let runningBudget = STARTING_BUDGET;
      for (let r = 1; r <= TOTAL_ROUNDS; r++) {
        const snap = await gameRef
          .collection("players")
          .doc(p.uid)
          .collection("rounds")
          .doc(`round_${r}`)
          .get();
        const data = snap.data();
        runningBudget = Math.round(runningBudget + data.revenue - data.totalCosts);
      }
      const playerSnap = await gameRef.collection("players").doc(p.uid).get();
      const finalBudget = playerSnap.get("budgetCurrent");
      assertClose(finalBudget, runningBudget, 2, `${p.displayName} final budget mismatch`);
    }
  });

  await timed("All round docs complete", async () => {
    for (let r = 1; r <= TOTAL_ROUNDS; r++) {
      const snap = await gameRef.collection("rounds").doc(`round_${r}`).get();
      assert(snap.exists, `round_${r} missing`);
      assert(
        snap.get("simulationStatus") === "complete",
        `round_${r} not complete`
      );
    }
  });

  // ─── Summary ──────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("✅ STRESS TEST PASSED — all assertions succeeded");
  console.log("═".repeat(60));
}

main().catch((err) => {
  console.error("\n💥 FATAL ERROR:", err.message || err);
  process.exit(1);
});
