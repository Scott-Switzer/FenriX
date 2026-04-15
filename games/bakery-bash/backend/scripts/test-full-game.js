/**
 * test-full-game.js
 *
 * End-to-end smoke test for ALL Bakery Bash Cloud Functions.
 * Runs against the Firebase Emulator suite.
 *
 * Usage:
 *   firebase emulators:exec --only auth,firestore,functions \
 *     "node scripts/test-full-game.js" --project bakery-bash-54d12
 *
 * What it tests (in order):
 *   1. createGame      — professor creates a game
 *   2. joinGame         — 3 players join the lobby
 *   3. startGame        — professor starts → phase becomes "decide"
 *   4. submitDecisions  — each player submits unique decisions
 *   5. advancePhase     — decide → bid
 *   6. advancePhase     — bid → simulating → results_ready (runs simulation)
 *   7. advancePhase     — results_ready → decide (round 2)
 *   8. exportCsv        — player downloads their CSV
 *   9. professorExport  — professor downloads all-player CSV
 *  10. Permission checks — players can't call professor-only functions
 */

const { initializeApp: initializeAdminApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase/app");
const {
  connectAuthEmulator,
  getAuth,
  signInAnonymously,
  signOut,
} = require("firebase/auth");
const {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
} = require("firebase/functions");

const PROJECT_ID = "bakery-bash-54d12";

// ── Tracking ──
let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? " — " + detail : ""}`);
    failed++;
    failures.push(label);
  }
}

async function expectError(label, asyncFn, expectedCode) {
  try {
    await asyncFn();
    console.log(`  ❌ ${label} — expected error but call succeeded`);
    failed++;
    failures.push(label);
  } catch (err) {
    const code = err.code || err.message;
    if (expectedCode && !code.includes(expectedCode)) {
      console.log(`  ❌ ${label} — expected "${expectedCode}" but got "${code}"`);
      failed++;
      failures.push(label);
    } else {
      console.log(`  ✅ ${label} (correctly rejected: ${code})`);
      passed++;
    }
  }
}

async function main() {
  // ── Setup ──
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("Run this via: firebase emulators:exec");
  }

  initializeAdminApp({ projectId: PROJECT_ID });
  const db = getFirestore();

  const app = initializeApp({
    apiKey: "demo-key",
    authDomain: `${PROJECT_ID}.firebaseapp.com`,
    projectId: PROJECT_ID,
  });

  const auth = getAuth(app);
  connectAuthEmulator(
    auth,
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`,
    { disableWarnings: true }
  );

  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);

  // Helper to call functions
  const call = (name) => httpsCallable(functions, name);

  // ─────────────────────────────────────────────
  // TEST 1: createGame (as professor)
  // ─────────────────────────────────────────────
  console.log("\n🧪 TEST 1: createGame");

  const profUser = await signInAnonymously(auth);
  const profUid = profUser.user.uid;

  const createResult = await call("createGame")({ totalRounds: 3 });
  const gameId = createResult.data.gameId;
  const joinCode = createResult.data.joinCode;

  check("Returns gameId", typeof gameId === "string" && gameId.length > 0);
  check("Returns joinCode", typeof joinCode === "string" && joinCode.length === 6);
  check("Returns totalRounds=3", createResult.data.totalRounds === 3);

  // Verify Firestore state
  const gameSnap = await db.doc(`games/${gameId}`).get();
  check("Game doc exists in Firestore", gameSnap.exists);
  check("Phase is lobby", gameSnap.get("phase") === "lobby");
  check("professorId matches", gameSnap.get("professorId") === profUid);
  check("totalPlayers is 0", gameSnap.get("totalPlayers") === 0);

  const configSnap = await db.doc(`games/${gameId}/config/params`).get();
  check("Config doc exists", configSnap.exists);
  check("startingBudget is 2000", configSnap.get("startingBudget") === 2000);

  const lbSnap = await db.doc(`games/${gameId}/leaderboard/current`).get();
  check("Leaderboard doc exists", lbSnap.exists);

  // ─────────────────────────────────────────────
  // TEST 2: joinGame (3 players)
  // ─────────────────────────────────────────────
  console.log("\n🧪 TEST 2: joinGame (3 players)");

  await signOut(auth);

  const playerNames = ["The Rolling Scone", "Crumb Club", "Baguette Brigade"];
  const playerUids = [];

  for (const name of playerNames) {
    const user = await signInAnonymously(auth);
    playerUids.push(user.user.uid);

    const result = await call("joinGame")({ joinCode, displayName: name });
    check(`${name} joined`, result.data.gameId === gameId);

    await signOut(auth);
  }

  // Verify Firestore
  const gameAfterJoin = await db.doc(`games/${gameId}`).get();
  check("totalPlayers is 3", gameAfterJoin.get("totalPlayers") === 3);

  for (let i = 0; i < playerUids.length; i++) {
    const pSnap = await db.doc(`games/${gameId}/players/${playerUids[i]}`).get();
    check(`Player "${playerNames[i]}" doc exists`, pSnap.exists);
    check(`Player "${playerNames[i]}" budget is 2000`, pSnap.get("budgetCurrent") === 2000);
  }

  // ─────────────────────────────────────────────
  // TEST 3: startGame (professor only)
  // ─────────────────────────────────────────────
  console.log("\n🧪 TEST 3: startGame");

  // First, test that a player CANNOT start the game
  const playerUser = await signInAnonymously(auth);
  await expectError(
    "Player cannot startGame",
    () => call("startGame")({ gameId }),
    "permission-denied"
  );
  await signOut(auth);

  // Now professor starts the game
  // Re-sign-in won't give us the same UID, so use admin to verify
  // We need to sign in as the professor — use admin to update professorId to new auth
  const profUser2 = await signInAnonymously(auth);
  const profUid2 = profUser2.user.uid;
  // Update game doc so this user is the professor (emulator workaround for anonymous auth)
  await db.doc(`games/${gameId}`).update({ professorId: profUid2 });

  const startResult = await call("startGame")({ gameId });
  check("startGame returns phase=decide", startResult.data.phase === "decide");
  check("startGame returns currentRound=1", startResult.data.currentRound === 1);

  const gameAfterStart = await db.doc(`games/${gameId}`).get();
  check("Firestore phase is decide", gameAfterStart.get("phase") === "decide");
  check("submittedCount reset to 0", gameAfterStart.get("submittedCount") === 0);
  check("phaseEndTime is set", gameAfterStart.get("phaseEndTime") !== null);

  // ─────────────────────────────────────────────
  // TEST 4: submitDecisions (3 players)
  // ─────────────────────────────────────────────
  console.log("\n🧪 TEST 4: submitDecisions");

  await signOut(auth);

  const decisionSets = [
    {
      staffCount: 5,
      adSpend: 200,
      menu: { croissant: true, cookie: true, bagel: true, sandwich: false, latte: false, matchaLatte: false },
      productPrices: { croissant: 5, cookie: 4, bagel: 6, sandwich: 0, latte: 0, matchaLatte: 0 },
      quantities: { croissant: 20, cookie: 15, bagel: 10, sandwich: 0, latte: 0, matchaLatte: 0 },
    },
    {
      staffCount: 3,
      adSpend: 100,
      menu: { croissant: true, cookie: false, bagel: true, sandwich: true, latte: false, matchaLatte: false },
      productPrices: { croissant: 4, cookie: 0, bagel: 5, sandwich: 8, latte: 0, matchaLatte: 0 },
      quantities: { croissant: 25, cookie: 0, bagel: 20, sandwich: 10, latte: 0, matchaLatte: 0 },
    },
    {
      staffCount: 7,
      adSpend: 50,
      menu: { croissant: true, cookie: true, bagel: true, sandwich: true, latte: true, matchaLatte: false },
      productPrices: { croissant: 3, cookie: 3, bagel: 3, sandwich: 7, latte: 6, matchaLatte: 0 },
      quantities: { croissant: 10, cookie: 10, bagel: 10, sandwich: 5, latte: 5, matchaLatte: 0 },
    },
  ];

  const bidSets = [
    { adBid: { adType: "TV", amount: 150 }, chefBid: { amount: 100 } },
    { adBid: { adType: "Billboard", amount: 80 }, chefBid: { amount: 200 } },
    { adBid: { adType: "TV", amount: 120 }, chefBid: { amount: 50 } },
  ];

  for (let i = 0; i < playerUids.length; i++) {
    // Write pendingDecision and pendingBids as if client did it
    const playerRef = db.doc(`games/${gameId}/players/${playerUids[i]}`);
    await playerRef.update({
      pendingDecision: { ...decisionSets[i], submitted: false, submittedAt: null },
      pendingBids: bidSets[i],
    });

    // Sign in as this player
    // Note: anonymous auth gives new UIDs each time, so we update the player doc's uid
    const pUser = await signInAnonymously(auth);
    const pUid = pUser.user.uid;

    // Remap: update player doc to this new uid and move it
    // Simpler approach: just set the player doc at the new uid path
    const oldData = (await playerRef.get()).data();
    const newPlayerRef = db.doc(`games/${gameId}/players/${pUid}`);
    await newPlayerRef.set({ ...oldData, uid: pUid });

    const submitResult = await call("submitDecisions")({ gameId });
    check(`Player ${i + 1} submitted`, submitResult.data.success === true);

    // Verify decision snapshot was created
    const decSnap = await newPlayerRef.collection("decisions").doc("round_1").get();
    check(`Player ${i + 1} decision doc exists`, decSnap.exists);

    // Verify double-submit is blocked
    await expectError(
      `Player ${i + 1} double-submit blocked`,
      () => call("submitDecisions")({ gameId }),
      "already-exists"
    );

    await signOut(auth);

    // Store new uid for later
    playerUids[i] = pUid;
  }

  const gameAfterSubmit = await db.doc(`games/${gameId}`).get();
  check(
    "submittedCount is 3",
    gameAfterSubmit.get("submittedCount") === 3,
    `got ${gameAfterSubmit.get("submittedCount")}`
  );

  // ─────────────────────────────────────────────
  // TEST 5: advancePhase (decide → bid)
  // ─────────────────────────────────────────────
  console.log("\n🧪 TEST 5: advancePhase (decide → bid)");

  // Sign in as professor
  await signOut(auth);
  const profUser3 = await signInAnonymously(auth);
  await db.doc(`games/${gameId}`).update({ professorId: profUser3.user.uid });

  const advResult1 = await call("advancePhase")({ gameId });
  check("Phase advanced to bid", advResult1.data.phase === "bid");

  // ─────────────────────────────────────────────
  // TEST 6: advancePhase (bid → simulating → results_ready)
  // ─────────────────────────────────────────────
  console.log("\n🧪 TEST 6: advancePhase (bid → results_ready via simulation)");

  const advResult2 = await call("advancePhase")({ gameId });
  check("Phase advanced to results_ready", advResult2.data.phase === "results_ready");

  // Verify simulation wrote data
  const aggRoundSnap = await db.doc(`games/${gameId}/rounds/round_1`).get();
  check("Aggregate round doc exists", aggRoundSnap.exists);
  check(
    "Aggregate round has auction results",
    aggRoundSnap.get("auctionResults") !== undefined
  );
  check(
    "Aggregate round has classStats",
    aggRoundSnap.get("classStats") !== undefined
  );

  const lbAfterSim = await db.doc(`games/${gameId}/leaderboard/current`).get();
  const rankings = lbAfterSim.get("rankings") || [];
  check("Leaderboard has rankings", rankings.length > 0, `got ${rankings.length}`);

  if (rankings.length > 0) {
    check("Rankings have rank field", rankings[0].rank === 1);
    check("Rankings have displayName", typeof rankings[0].displayName === "string");
    check("Rankings have cumulativeRevenue", typeof rankings[0].cumulativeRevenue === "number");
    console.log("\n  📊 Leaderboard after Round 1:");
    for (const r of rankings) {
      console.log(`     #${r.rank} ${r.displayName} — Revenue: $${r.cumulativeRevenue}`);
    }
  }

  // Check per-player round results
  for (const uid of playerUids) {
    const roundSnap = await db.doc(`games/${gameId}/players/${uid}/rounds/round_1`).get();
    if (roundSnap.exists) {
      const d = roundSnap.data();
      check(
        `Player ${uid.substring(0, 8)} round result exists`,
        true
      );
      check(
        `  revenue >= 0`,
        typeof d.revenue === "number" && d.revenue >= 0,
        `got ${d.revenue}`
      );
      check(
        `  customerCount >= 0`,
        typeof d.customerCount === "number" && d.customerCount >= 0,
        `got ${d.customerCount}`
      );
      check(
        `  budgetAfter is a number`,
        typeof d.budgetAfter === "number",
        `got ${d.budgetAfter}`
      );
    } else {
      check(`Player ${uid.substring(0, 8)} round result exists`, false, "MISSING");
    }
  }

  // ─────────────────────────────────────────────
  // TEST 7: advancePhase (results_ready → decide round 2)
  // ─────────────────────────────────────────────
  console.log("\n🧪 TEST 7: advancePhase (results_ready → decide round 2)");

  const advResult3 = await call("advancePhase")({ gameId });
  check("Phase advanced to decide", advResult3.data.phase === "decide");
  check("currentRound is 2", advResult3.data.currentRound === 2);

  const gameRound2 = await db.doc(`games/${gameId}`).get();
  check("Firestore currentRound is 2", gameRound2.get("currentRound") === 2);
  check("submittedCount reset to 0", gameRound2.get("submittedCount") === 0);

  // ─────────────────────────────────────────────
  // TEST 8: exportCsv (player)
  // ─────────────────────────────────────────────
  console.log("\n🧪 TEST 8: exportCsv");

  await signOut(auth);
  const exportUser = await signInAnonymously(auth);
  const exportUid = exportUser.user.uid;

  // Create a player doc for this user so they can export
  // Copy one of the existing player's csvRows
  const csvTestPlayerId = playerUids[0];
  const csvRowsSnap = await db
    .collection(`games/${gameId}/csvRows/${csvTestPlayerId}/rounds`)
    .get();

  // Create matching player + csvRows for our export user
  await db.doc(`games/${gameId}/players/${exportUid}`).set({
    uid: exportUid,
    displayName: "Export Tester",
    budgetCurrent: 1500,
    cumulativeRevenue: 500,
  });

  for (const doc of csvRowsSnap.docs) {
    await db
      .doc(`games/${gameId}/csvRows/${exportUid}/rounds/${doc.id}`)
      .set(doc.data());
  }

  const csvResult = await call("exportCsv")({ gameId });
  check("exportCsv returns csv string", typeof csvResult.data.csv === "string");
  check("exportCsv has rows", csvResult.data.rowCount > 0, `got ${csvResult.data.rowCount}`);

  if (csvResult.data.csv) {
    const lines = csvResult.data.csv.trim().split("\n");
    const header = lines[0];
    check(
      "CSV header includes key columns",
      header.includes("day") && header.includes("revenue") && header.includes("customer_count")
    );
    console.log(`\n  📄 CSV Preview:\n     ${lines.slice(0, 3).join("\n     ")}`);
  }

  // ─────────────────────────────────────────────
  // TEST 9: professorExport
  // ─────────────────────────────────────────────
  console.log("\n🧪 TEST 9: professorExport");

  await signOut(auth);
  const profUser4 = await signInAnonymously(auth);
  await db.doc(`games/${gameId}`).update({ professorId: profUser4.user.uid });

  const profExport = await call("professorExport")({ gameId });
  check("professorExport returns csv", typeof profExport.data.csv === "string");
  check("professorExport has rows", profExport.data.rowCount > 0);
  check("professorExport includes bakery_name column",
    profExport.data.csv.startsWith("bakery_name,")
  );

  // ─────────────────────────────────────────────
  // TEST 10: Permission checks
  // ─────────────────────────────────────────────
  console.log("\n🧪 TEST 10: Permission checks");

  await signOut(auth);
  const randUser = await signInAnonymously(auth);

  await expectError(
    "Random user cannot startGame",
    () => call("startGame")({ gameId }),
    "permission-denied"
  );

  await expectError(
    "Random user cannot advancePhase",
    () => call("advancePhase")({ gameId }),
    "permission-denied"
  );

  await expectError(
    "Random user cannot professorExport",
    () => call("professorExport")({ gameId }),
    "permission-denied"
  );

  // ─────────────────────────────────────────────
  // RESULTS
  // ─────────────────────────────────────────────
  console.log("\n" + "═".repeat(50));
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log("═".repeat(50));

  if (failures.length > 0) {
    console.log("\n  Failed tests:");
    for (const f of failures) {
      console.log(`    ❌ ${f}`);
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("\n💥 FATAL ERROR:", error.message || error);
  if (error.stack) console.error(error.stack);
  process.exitCode = 1;
});
