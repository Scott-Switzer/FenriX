/**
 * test-multi-team-costs.js
 *
 * BE-I01 / BE-I03 regression test. Seeds a 1-member team and a 3-member team,
 * has both win equal-priced auctions, runs the simulation, and asserts:
 *
 *   1. The round's `adAuctionResults` / `chefAuctionResults` docs are keyed by
 *      team slug only — no per-member-uid copies (BE-I03).
 *   2. Both teams' `totalSpent` on their player round doc matches, proving the
 *      auction cost is not being charged N× for a team of N (BE-I01).
 *
 * Run via: npm run test:multi-team-costs
 */

const { initializeApp: initializeAdminApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase/app");
const {
  connectAuthEmulator,
  getAuth,
  signInAnonymously,
} = require("firebase/auth");
const {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
} = require("firebase/functions");

const PROJECT_ID = "bakery-bash-54d12";
const GAME_ID = "multi-team-costs-game";
const ROUND_ID = "round_1";

// Team "solo": one player. team.key === player uid (no teamId on the doc).
const PLAYER_SOLO = "uid_solo";

// Team "team-multi": three players with finance/advertising/operations roles.
const TEAM_MULTI = "team-multi";
const PLAYER_M_FIN = "uid_multi_fin";
const PLAYER_M_ADV = "uid_multi_adv";
const PLAYER_M_OPS = "uid_multi_ops";

const AD_COST = 30000;   // identical ad bids — each team wins a different slot
const CHEF_COST = 100000; // comfortably above every skillTier minBidFloor

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} must be set by Firebase emulators:exec.`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`FAIL: ${message} — expected ${expected}, got ${actual}.`);
  }
}

async function cleanSlate(db) {
  // The Firestore emulator persists across runs, and resolveAndApply*Auction
  // writes to the round doc with `{ merge: true }`, so stale per-uid keys from
  // a prior run would linger. Wipe the whole game tree before seeding.
  await db.recursiveDelete(db.doc(`games/${GAME_ID}`));
}

async function seedBaseGame(db, professorUid) {
  await db.doc(`games/${GAME_ID}`).set({
    joinCode: "MTCOST",
    phase: "round_1_bid_ad",
    round: 1,
    currentRound: 1,
    totalRounds: 3,
    phaseStartedAt: Timestamp.fromMillis(Date.now()),
    phaseEndsAt: null, // null so `submitBids` gate isn't triggered by the emu
    submittedCount: 0,
    totalPlayers: 4,
    paused: false,
    professorId: professorUid,
    professorUid,
    createdAt: Timestamp.fromMillis(Date.now()),
    startedAt: Timestamp.fromMillis(Date.now()),
    endedAt: null,
  });

  await db.doc(`games/${GAME_ID}/config/params`).set({
    startingBudget: 500000,
    sousChefBaseCost: 12500,
    unitCostPerProduct: 1,
    specialtyChefCap: 3,
    chefPoolSize: 12,
    revenueCoefficients: {
      base: 0,
      sousChefCoeff: 0,
      satisfactionCoeff: 0,
      adSpendCoeff: 0,
      numProductsCoeff: 0,
      noiseMin: 0,
      noiseMax: 0,
    },
  });

  // ---- Solo team (key = uid_solo) --------------------------------------
  await db.doc(`games/${GAME_ID}/players/${PLAYER_SOLO}`).set({
    uid: PLAYER_SOLO,
    playerId: PLAYER_SOLO,
    displayName: "Solo Player",
    bakeryName: "Solo Bakery",
    role: "solo",
    teamId: null,
    budgetCurrent: 500000,
    cumulativeRevenue: 0,
    specialtyChefs: [],
    sousChefCount: 0,
    consecutiveMissedRounds: 0,
    disconnected: false,
  });

  // ---- Multi team (key = "team-multi") --------------------------------
  const multiMembers = [
    { uid: PLAYER_M_FIN, role: "finance", name: "Multi Finance" },
    { uid: PLAYER_M_ADV, role: "advertising", name: "Multi Advertising" },
    { uid: PLAYER_M_OPS, role: "operations", name: "Multi Operations" },
  ];
  for (const m of multiMembers) {
    await db.doc(`games/${GAME_ID}/players/${m.uid}`).set({
      uid: m.uid,
      playerId: m.uid,
      displayName: m.name,
      bakeryName: "Multi Bakery",
      role: m.role,
      teamId: TEAM_MULTI,
      budgetCurrent: 500000,
      cumulativeRevenue: 0,
      specialtyChefs: [],
      sousChefCount: 0,
      consecutiveMissedRounds: 0,
      disconnected: false,
    });
  }

  // A teams/{slug} doc isn't required by the advanceGamePhase pipeline
  // (team grouping is derived from player docs), but we seed a minimal one
  // for realism and to mirror production state.
  await db.doc(`games/${GAME_ID}/teams/${TEAM_MULTI}`).set({
    name: "Multi Bakery",
    memberCount: 3,
    roleAssignments: {
      [PLAYER_M_FIN]: "finance",
      [PLAYER_M_ADV]: "advertising",
      [PLAYER_M_OPS]: "operations",
    },
  });
}

async function seedAdBids(db) {
  // Each team wins a different ad surface at the same price so there's no
  // tiebreak and both teams pay exactly AD_COST. The bid doc lives under
  // whichever member has the `advertising` role (or solo, for the solo team).
  const submittedAt = Timestamp.fromMillis(Date.now());

  await db.doc(`games/${GAME_ID}/players/${PLAYER_SOLO}/bids/${ROUND_ID}`).set({
    round: 1,
    ad: { TV: AD_COST, Billboard: 0, Radio: 0, Newspaper: 0 },
    adSubmittedAt: submittedAt,
  });

  await db.doc(`games/${GAME_ID}/players/${PLAYER_M_ADV}/bids/${ROUND_ID}`).set({
    round: 1,
    ad: { TV: 0, Billboard: AD_COST, Radio: 0, Newspaper: 0 },
    adSubmittedAt: submittedAt,
  });
}

async function seedChefBids(db, soloChefId, multiChefId) {
  // Read back the chef pool after bid_ad→bid_chef advance, pick two distinct
  // chefs, have each team bid on a different one at the same price. Bids
  // land on the `finance` role (or solo).
  const submittedAt = Timestamp.fromMillis(Date.now());

  await db.doc(`games/${GAME_ID}/players/${PLAYER_SOLO}/bids/${ROUND_ID}`).set({
    chef: [{ chefId: soloChefId, amount: CHEF_COST }],
    chefSubmittedAt: submittedAt,
  }, { merge: true });

  await db.doc(`games/${GAME_ID}/players/${PLAYER_M_FIN}/bids/${ROUND_ID}`).set({
    round: 1,
    chef: [{ chefId: multiChefId, amount: CHEF_COST }],
    chefSubmittedAt: submittedAt,
  });
}

async function seedDecisions(db) {
  const menu = {
    croissant: true, cookie: false, bagel: false,
    sandwich: false, coffee: false, matcha: false,
  };
  const quantities = { croissant: 0 };
  const submittedAt = Timestamp.fromMillis(Date.now());

  // Write the same decision under every uid whose doc the sim might read
  // (operations for ops-side, finance for prices, solo covers both).
  const decisionSeeds = [
    PLAYER_SOLO,
    PLAYER_M_OPS,
    PLAYER_M_FIN,
    PLAYER_M_ADV,
  ];
  for (const uid of decisionSeeds) {
    await db.doc(`games/${GAME_ID}/players/${uid}/decisions/${ROUND_ID}`).set({
      round: 1,
      submittedAt,
      menu,
      quantities,
      sousChefCount: 0,
      sousChefAssignments: {},
      productPrices: {},
    });
  }
}

async function main() {
  requireEnv("FIRESTORE_EMULATOR_HOST");
  requireEnv("FIREBASE_AUTH_EMULATOR_HOST");

  initializeAdminApp({ projectId: PROJECT_ID });
  const db = getFirestore();

  const app = initializeApp({
    apiKey: "demo-key",
    authDomain: `${PROJECT_ID}.firebaseapp.com`,
    projectId: PROJECT_ID,
  });

  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, {
    disableWarnings: true,
  });

  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);

  const { user: professor } = await signInAnonymously(auth);
  await cleanSlate(db);
  await seedBaseGame(db, professor.uid);
  await seedAdBids(db);

  const advanceGamePhase = httpsCallable(functions, "advanceGamePhase");

  // -----------------------------------------------------------------------
  // bid_ad → bid_chef: triggers resolveAndApplyAdAuction + generateChefPool.
  // -----------------------------------------------------------------------
  const afterAd = await advanceGamePhase({ gameId: GAME_ID });
  assertEqual(afterAd.data.phase, "round_1_bid_chef", "Phase after ad auction.");
  console.log("  ✓ advanceGamePhase: bid_ad → bid_chef");

  const roundAfterAd = await db.doc(`games/${GAME_ID}/rounds/${ROUND_ID}`).get();
  assert(roundAfterAd.exists, "Round doc exists after ad auction.");
  const adResults = roundAfterAd.get("adAuctionResults") || {};
  const adKeys = Object.keys(adResults).sort();

  // BE-I03 assertion: keys are team slugs only — no per-member uid leaks.
  const expectedAdKeys = [PLAYER_SOLO, TEAM_MULTI].sort();
  assertEqual(
    adKeys.join(","),
    expectedAdKeys.join(","),
    `adAuctionResults keys should be exactly the winning team slugs. Got: [${adKeys.join(", ")}]`
  );
  console.log(`  ✓ BE-I03: adAuctionResults keyed by team slug only (${adKeys.join(", ")})`);

  assertEqual(adResults[PLAYER_SOLO].totalPaid, AD_COST, "Solo team adAuctionResults.totalPaid.");
  assertEqual(adResults[TEAM_MULTI].totalPaid, AD_COST, "Multi team adAuctionResults.totalPaid.");
  console.log("  ✓ both teams paid the same AD_COST");

  // -----------------------------------------------------------------------
  // Pick 2 distinct chefs from the generated pool and seed chef bids.
  // -----------------------------------------------------------------------
  const chefPool = roundAfterAd.get("chefPool") || [];
  assert(chefPool.length >= 2, `Chef pool must have ≥2 chefs to seed bids, got ${chefPool.length}.`);
  await seedChefBids(db, chefPool[0].id, chefPool[1].id);

  // -----------------------------------------------------------------------
  // bid_chef → roster: triggers resolveAndApplyChefAuction.
  // -----------------------------------------------------------------------
  const afterChef = await advanceGamePhase({ gameId: GAME_ID });
  assertEqual(afterChef.data.phase, "round_1_roster", "Phase after chef auction.");
  console.log("  ✓ advanceGamePhase: bid_chef → roster");

  const roundAfterChef = await db.doc(`games/${GAME_ID}/rounds/${ROUND_ID}`).get();
  const chefResults = roundAfterChef.get("chefAuctionResults") || {};
  const chefKeys = Object.keys(chefResults).sort();
  const expectedChefKeys = [PLAYER_SOLO, TEAM_MULTI].sort();
  assertEqual(
    chefKeys.join(","),
    expectedChefKeys.join(","),
    `chefAuctionResults keys should be exactly the winning team slugs. Got: [${chefKeys.join(", ")}]`
  );
  console.log(`  ✓ BE-I03: chefAuctionResults keyed by team slug only (${chefKeys.join(", ")})`);

  assertEqual(chefResults[PLAYER_SOLO].totalPaid, CHEF_COST, "Solo team chef totalPaid.");
  assertEqual(chefResults[TEAM_MULTI].totalPaid, CHEF_COST, "Multi team chef totalPaid.");
  console.log("  ✓ both teams paid the same CHEF_COST");

  // -----------------------------------------------------------------------
  // roster → decide: trivial transition.
  // -----------------------------------------------------------------------
  await seedDecisions(db);
  const afterRoster = await advanceGamePhase({ gameId: GAME_ID });
  assertEqual(afterRoster.data.phase, "round_1_decide", "Phase after roster.");
  console.log("  ✓ advanceGamePhase: roster → decide");

  // -----------------------------------------------------------------------
  // decide → simulating → results_ready: runSimulationAndPersist runs.
  // -----------------------------------------------------------------------
  const afterSim = await advanceGamePhase({ gameId: GAME_ID });
  assertEqual(afterSim.data.phase, "results_ready", "Phase after sim.");
  console.log("  ✓ advanceGamePhase: decide → simulating → results_ready");

  // -----------------------------------------------------------------------
  // The critical BE-I01 assertion: totalSpent is the same for both teams.
  // -----------------------------------------------------------------------
  const [soloRound, multiOpsRound, multiFinRound, multiAdvRound] = await Promise.all([
    db.doc(`games/${GAME_ID}/players/${PLAYER_SOLO}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_M_OPS}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_M_FIN}/rounds/${ROUND_ID}`).get(),
    db.doc(`games/${GAME_ID}/players/${PLAYER_M_ADV}/rounds/${ROUND_ID}`).get(),
  ]);
  assert(soloRound.exists, "Solo round doc written.");
  assert(multiOpsRound.exists, "Multi ops round doc written.");
  assert(multiFinRound.exists, "Multi fin round doc written.");
  assert(multiAdvRound.exists, "Multi adv round doc written.");

  const soloSpent = soloRound.get("totalSpent");
  const multiSpent = multiOpsRound.get("totalSpent");
  const multiFinSpent = multiFinRound.get("totalSpent");
  const multiAdvSpent = multiAdvRound.get("totalSpent");

  // All three team-multi member docs carry the SAME aggregated totalSpent.
  assertEqual(
    multiFinSpent,
    multiSpent,
    `team-multi member totalSpent should be consistent across uids (fin vs ops).`
  );
  assertEqual(
    multiAdvSpent,
    multiSpent,
    `team-multi member totalSpent should be consistent across uids (adv vs ops).`
  );

  // The actual bug: solo totalSpent should equal multi totalSpent because
  // their decisions + auction wins are identical. Under the old broken
  // code, multi = solo × 3 because auction costs were summed over member uids.
  assertEqual(
    multiSpent,
    soloSpent,
    `BE-I01: totalSpent must match between teams with identical decisions. ` +
    `solo=${soloSpent}, multi=${multiSpent} ` +
    `(expected ratio 1.0; buggy ratio ~${(multiSpent / (soloSpent || 1)).toFixed(2)}×)`
  );
  console.log(`  ✓ BE-I01: totalSpent identical — solo=$${soloSpent}, multi=$${multiSpent}`);

  // Sanity: totalSpent = ad (30k) + chef (100k) + 0 stock + 0 sous = 130k.
  assertEqual(soloSpent, AD_COST + CHEF_COST, "totalSpent matches ad + chef cost.");
  console.log(`  ✓ totalSpent equals adPaid + chefPaid ($${AD_COST + CHEF_COST})`);

  // -----------------------------------------------------------------------
  // BE-I05: classStats.totalCustomerPool must be written.
  // BE-I06: lastRoundResult.fillRate must be a number.
  // -----------------------------------------------------------------------
  const roundDoc = await db.doc(`games/${GAME_ID}/rounds/${ROUND_ID}`).get();
  assert(roundDoc.exists, "Round doc written.");
  const classStats = roundDoc.get("classStats") || {};
  assert(
    typeof classStats.totalCustomerPool === "number",
    `BE-I05: classStats.totalCustomerPool should be a number, got ${typeof classStats.totalCustomerPool}.`
  );
  const expectedPool = classStats.avgCustomerCount * classStats.playerCount;
  assert(
    Math.abs(classStats.totalCustomerPool - expectedPool) < 1,
    `BE-I05: totalCustomerPool (${classStats.totalCustomerPool}) should equal avg × playerCount (${expectedPool}).`
  );
  console.log(`  ✓ BE-I05: classStats.totalCustomerPool = ${classStats.totalCustomerPool}`);

  const soloPlayer = await db.doc(`games/${GAME_ID}/players/${PLAYER_SOLO}`).get();
  const lrr = soloPlayer.get("lastRoundResult") || {};
  assert(
    typeof lrr.fillRate === "number",
    `BE-I06: lastRoundResult.fillRate should be a number, got ${typeof lrr.fillRate}.`
  );
  assert(
    lrr.fillRate >= 0 && lrr.fillRate <= 5,
    `BE-I06: fillRate should be in a plausible range, got ${lrr.fillRate}.`
  );
  console.log(`  ✓ BE-I06: lastRoundResult.fillRate = ${lrr.fillRate.toFixed(3)}`);

  console.log("\nMulti-team cost flow passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
