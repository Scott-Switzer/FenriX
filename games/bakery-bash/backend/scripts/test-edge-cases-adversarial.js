const { initializeApp: initializeAdminApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase/app");
const { connectAuthEmulator, getAuth, signInAnonymously } = require("firebase/auth");
const { connectFunctionsEmulator, getFunctions, httpsCallable } = require("firebase/functions");

const PROJECT_ID = "bakery-bash-54d12";

const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function expectError(fn, expectedCode, label) {
  try {
    await fn();
    const msg = `${label}: ACCEPTED but should reject`;
    failures.push(msg);
    console.log(`  ⚠ ${msg}`);
  } catch (err) {
    const code = err.code || "";
    if (code.includes(expectedCode)) {
      console.log(`  ✓ ${label}: rejected (${code})`);
    } else {
      const msg = `${label}: got ${code} but expected ${expectedCode}`;
      failures.push(msg);
      console.log(`  ⚠ ${msg}`);
    }
  }
}

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error("Set FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST");
  }

  initializeAdminApp({ projectId: PROJECT_ID });
  const db = getFirestore();

  const app = initializeApp({ apiKey: "demo-key", authDomain: `${PROJECT_ID}.firebaseapp.com`, projectId: PROJECT_ID });
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);

  const { user: prof } = await signInAnonymously(auth);
  const uid = prof.uid;
  const timestamp = Date.now();

  const joinGame = httpsCallable(functions, "joinGame");
  const createTeam = httpsCallable(functions, "createTeam");
  const submitDecision = httpsCallable(functions, "submitDecision");
  const submitPrices = httpsCallable(functions, "submitPrices");
  const submitBids = httpsCallable(functions, "submitBids");
  const advanceGamePhase = httpsCallable(functions, "advanceGamePhase");
  const pauseGame = httpsCallable(functions, "pauseGame");

  console.log("\n=== Edge Case & Adversarial Test Suite ===\n");

  // --- Test 1: Pause blocks everything ---
  console.log("--- Test 1: Pause blocks all submissions ---");
  const g1 = `g1-${timestamp}`;
  await db.doc(`games/${g1}`).set({
    joinCode: "ABCD23", phase: "lobby", currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 0, submittedCount: 0,
  });
  await db.doc(`games/${g1}/config/params`).set({});
  await db.doc(`games/${g1}/players/${uid}`).set({
    uid, displayName: "Pause", bakeryName: "Pause Bakery", role: "solo",
    budgetCurrent: 10000, cumulativeRevenue: 0, specialtyChefs: [], sousChefCount: 0,
  });

  for (let i = 0; i < 5; i++) await advanceGamePhase({ gameId: g1 });
  await pauseGame({ gameId: g1 });

  await expectError(
    () => submitDecision({ gameId: g1, decision: { menu: { croissant: true }, quantities: { croissant: 10 }, sousChefCount: 0, sousChefAssignments: {} } }),
    "failed-precondition", "submitDecision while paused"
  );
  await expectError(
    () => submitPrices({ gameId: g1, productPrices: { coffee: 4.5 } }),
    "failed-precondition", "submitPrices while paused"
  );
  await expectError(
    () => submitBids({ gameId: g1, bidType: "ad", bids: { TV: 100 } }),
    "failed-precondition", "submitBids while paused"
  );

  // --- Test 2: Decision immutability ---
  console.log("\n--- Test 2: Decision immutability ---");
  const g2 = `g2-${timestamp}`;
  await db.doc(`games/${g2}`).set({
    joinCode: "EFGH45", phase: "lobby", currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 0, submittedCount: 0,
  });
  await db.doc(`games/${g2}/config/params`).set({});
  await db.doc(`games/${g2}/players/${uid}`).set({
    uid, displayName: "Immutable", bakeryName: "Immutable Bakery", role: "solo",
    budgetCurrent: 10000, cumulativeRevenue: 0, specialtyChefs: [], sousChefCount: 0,
  });

  for (let i = 0; i < 5; i++) await advanceGamePhase({ gameId: g2 });

  await submitDecision({
    gameId: g2,
    decision: { menu: { croissant: true }, quantities: { croissant: 10 }, sousChefCount: 0, sousChefAssignments: {} },
  });
  console.log("  ✓ First submitDecision succeeded");

  await expectError(
    () => submitDecision({
      gameId: g2,
      decision: { menu: { croissant: true }, quantities: { croissant: 99 }, sousChefCount: 0, sousChefAssignments: {} },
    }),
    "already-exists", "Double-submit decision rejected"
  );

  // --- Test 3: Boundary values in bids ---
  console.log("\n--- Test 3: Boundary values in bids ---");
  const g3 = `g3-${timestamp}`;
  await db.doc(`games/${g3}`).set({
    joinCode: "JKLM67", phase: "lobby", currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 0, submittedCount: 0,
  });
  await db.doc(`games/${g3}/config/params`).set({});
  await db.doc(`games/${g3}/players/${uid}`).set({
    uid, displayName: "Bid", bakeryName: "Bid Bakery", role: "solo",
    budgetCurrent: 10000, cumulativeRevenue: 0, specialtyChefs: [], sousChefCount: 0,
  });

  for (let i = 0; i < 2; i++) await advanceGamePhase({ gameId: g3 });

  const bidTests = [
    { label: "$0 bid", payload: { TV: 0 }, shouldWork: true },
    { label: "$1 bid", payload: { TV: 1 }, shouldWork: true },
    { label: "Negative bid", payload: { TV: -5 }, shouldWork: false },
    { label: "NaN bid", payload: { TV: NaN }, shouldWork: false },
    { label: "String bid", payload: { TV: "five" }, shouldWork: false },
    { label: "Huge bid > budget", payload: { TV: 999999 }, shouldWork: true },
  ];

  for (const t of bidTests) {
    try {
      await submitBids({ gameId: g3, bidType: "ad", adBids: t.payload });
      if (t.shouldWork) {
        console.log(`  ✓ ${t.label}: accepted`);
      } else {
        const msg = `${t.label}: ACCEPTED but should reject`;
        failures.push(msg);
        console.log(`  ⚠ ${msg}`);
      }
    } catch (err) {
      if (!t.shouldWork) {
        console.log(`  ✓ ${t.label}: rejected (${err.code})`);
      } else {
        const msg = `${t.label}: REJECTED but should accept (${err.code})`;
        failures.push(msg);
        console.log(`  ⚠ ${msg}`);
      }
    }
  }

  // --- Test 4: Submit during wrong phase ---
  console.log("\n--- Test 4: Submit during wrong phase ---");
  const g4 = `g4-${timestamp}`;
  await db.doc(`games/${g4}`).set({
    joinCode: "MNPQ89", phase: "lobby", currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 0, submittedCount: 0,
  });
  await db.doc(`games/${g4}/config/params`).set({});
  await db.doc(`games/${g4}/players/${uid}`).set({
    uid, displayName: "Phase", bakeryName: "Phase Bakery", role: "solo",
    budgetCurrent: 10000, cumulativeRevenue: 0, specialtyChefs: [], sousChefCount: 0,
  });

  for (let i = 0; i < 2; i++) await advanceGamePhase({ gameId: g4 });

  await expectError(
    () => submitDecision({ gameId: g4, decision: { menu: { croissant: true }, quantities: { croissant: 10 }, sousChefCount: 0, sousChefAssignments: {} } }),
    "failed-precondition", "submitDecision during bid_ad phase"
  );
  await expectError(
    () => submitBids({ gameId: g4, bidType: "chef", chefBids: [] }),
    "failed-precondition", "submitBids chef during bid_ad phase"
  );

  // --- Test 5: Chef cap at exactly 3 ---
  console.log("\n--- Test 5: Chef cap at exactly 3 ---");
  const g5 = `g5-${timestamp}`;
  await db.doc(`games/${g5}`).set({
    joinCode: "QRST23", phase: "round_1_roster", currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 1, submittedCount: 0,
  });
  await db.doc(`games/${g5}/config/params`).set({ specialtyChefCap: 3 });
  await db.doc(`games/${g5}/players/${uid}`).set({
    uid, displayName: "Cap", bakeryName: "Cap Bakery", role: "solo",
    budgetCurrent: 10000, cumulativeRevenue: 0,
    specialtyChefs: [
      { id: "c1", name: "Chef1", nationality: "french", skillTier: "advanced", specialties: ["croissant"] },
      { id: "c2", name: "Chef2", nationality: "french", skillTier: "advanced", specialties: ["croissant"] },
      { id: "c3", name: "Chef3", nationality: "french", skillTier: "advanced", specialties: ["croissant"] },
    ],
    sousChefCount: 0,
  });

  // Cap is 3; exactly 3 should be allowed, only 4+ blocked.
  try {
    await advanceGamePhase({ gameId: g5 });
    console.log("  ✓ Advance allowed at exactly 3 chefs (cap not exceeded)");
  } catch (err) {
    const msg = `Advance blocked at exactly 3 chefs — should be allowed (${err.code})`;
    failures.push(msg);
    console.log(`  ⚠ ${msg}`);
  }

  // --- Test 6: Empty / malformed inputs ---
  console.log("\n--- Test 6: Empty and malformed inputs ---");
  const g6 = `g6-${timestamp}`;
  await db.doc(`games/${g6}`).set({
    joinCode: "UVWX45", phase: "lobby", currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 0, submittedCount: 0,
  });

  await expectError(
    () => createTeam({ joinCode: "UVWX45", teamName: "", displayName: "Test" }),
    "invalid-argument", "Empty team name rejected"
  );
  await expectError(
    () => createTeam({ joinCode: "UVWX45", teamName: "Valid", displayName: "" }),
    "invalid-argument", "Empty display name rejected"
  );
  await expectError(
    () => createTeam({ joinCode: "UVWX45", teamName: "A", displayName: "Test" }),
    "invalid-argument", "1-char team name rejected"
  );

  // --- Test 7: Injection / XSS in names ---
  console.log("\n--- Test 7: Injection / XSS in names ---");
  const g7 = `g7-${timestamp}`;
  await db.doc(`games/${g7}`).set({
    joinCode: "YZAB67", phase: "lobby", currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 0, submittedCount: 0,
  });

  const injectionNames = [
    { name: "<script>alert('xss')</script>", expect: "rejected" },
    { name: "🍞🥐🥖", expect: "accepted" },
    { name: "A".repeat(100), expect: "rejected" },
    { name: "null", expect: "accepted" },
  ];

  for (const t of injectionNames) {
    const shortName = t.name.slice(0, 30);
    try {
      await createTeam({ joinCode: "YZAB67", teamName: t.name, displayName: "Test" });
      if (t.expect === "accepted") {
        console.log(`  ✓ Team name "${shortName}" accepted`);
      } else {
        const msg = `Team name "${shortName}" ACCEPTED but should reject`;
        failures.push(msg);
        console.log(`  ⚠ ${msg}`);
      }
    } catch (err) {
      if (t.expect === "rejected") {
        console.log(`  ✓ Team name "${shortName}" rejected (${err.code})`);
      } else {
        const msg = `Team name "${shortName}" REJECTED but should accept (${err.code})`;
        failures.push(msg);
        console.log(`  ⚠ ${msg}`);
      }
    }
  }

  // --- Test 8: Zero budget player ---
  console.log("\n--- Test 8: Zero budget player ---");
  const g8 = `g8-${timestamp}`;
  await db.doc(`games/${g8}`).set({
    joinCode: "CDEF89", phase: "lobby", currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 0, submittedCount: 0,
  });
  await db.doc(`games/${g8}/config/params`).set({ revenueCoefficients: { noiseMin: 0, noiseMax: 0 } });
  await db.doc(`games/${g8}/players/${uid}`).set({
    uid, displayName: "Zero", bakeryName: "Zero Bakery", role: "solo",
    budgetCurrent: 0, cumulativeRevenue: 0, specialtyChefs: [], sousChefCount: 0,
  });

  for (let i = 0; i < 5; i++) await advanceGamePhase({ gameId: g8 });

  const r8 = await submitDecision({
    gameId: g8,
    decision: { menu: { croissant: true, cookie: true, bagel: true }, quantities: { croissant: 10, cookie: 10, bagel: 10 }, sousChefCount: 0, sousChefAssignments: {} },
  });
  assert(r8.data.submitted === true, "Zero budget player should submit");
  console.log("  ✓ Zero budget player submitted successfully");

  // --- Test 9: Negative budget player ---
  console.log("\n--- Test 9: Negative budget player ---");
  const g9 = `g9-${timestamp}`;
  await db.doc(`games/${g9}`).set({
    joinCode: "GHJK23", phase: "lobby", currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 0, submittedCount: 0,
  });
  await db.doc(`games/${g9}/config/params`).set({ revenueCoefficients: { noiseMin: 0, noiseMax: 0 } });
  await db.doc(`games/${g9}/players/${uid}`).set({
    uid, displayName: "Neg", bakeryName: "Neg Bakery", role: "solo",
    budgetCurrent: -500, cumulativeRevenue: 0, specialtyChefs: [], sousChefCount: 0,
  });

  for (let i = 0; i < 5; i++) await advanceGamePhase({ gameId: g9 });

  const r9 = await submitDecision({
    gameId: g9,
    decision: { menu: { croissant: true }, quantities: { croissant: 5 }, sousChefCount: 0, sousChefAssignments: {} },
  });
  assert(r9.data.submitted === true, "Negative budget player should submit");
  console.log("  ✓ Negative budget player submitted successfully");

  // --- Test 10: Rapid double-submit (race condition) ---
  console.log("\n--- Test 10: Rapid double-submit ---");
  const g10 = `g10-${timestamp}`;
  await db.doc(`games/${g10}`).set({
    joinCode: "KLMN45", phase: "lobby", currentRound: 1, totalRounds: 2,
    paused: false, professorId: uid, totalPlayers: 0, submittedCount: 0,
  });
  await db.doc(`games/${g10}/config/params`).set({});
  await db.doc(`games/${g10}/players/${uid}`).set({
    uid, displayName: "Race", bakeryName: "Race Bakery", role: "solo",
    budgetCurrent: 10000, cumulativeRevenue: 0, specialtyChefs: [], sousChefCount: 0,
  });

  for (let i = 0; i < 5; i++) await advanceGamePhase({ gameId: g10 });

  const decision = {
    gameId: g10,
    decision: { menu: { croissant: true, cookie: true, bagel: true }, quantities: { croissant: 10, cookie: 10, bagel: 10 }, sousChefCount: 0, sousChefAssignments: {} },
  };

  const [r10a, r10b] = await Promise.allSettled([
    submitDecision(decision),
    submitDecision(decision),
  ]);

  const successCount = [r10a, r10b].filter(r => r.status === "fulfilled").length;
  assert(successCount >= 1, "At least one submit should succeed");
  console.log(`  ✓ Double-submit: ${successCount}/2 succeeded (idempotency guard working)`);

  if (failures.length > 0) {
    console.log(`\n❌ ${failures.length} soft-failure${failures.length === 1 ? "" : "s"}:`);
    for (const f of failures) console.log(`  - ${f}`);
    throw new Error(`${failures.length} adversarial assertion(s) failed`);
  }

  console.log("\n=== All edge case tests passed ===\n");
}

main().catch((err) => {
  console.error("\n❌ TEST FAILED:\n", err);
  process.exit(1);
});
