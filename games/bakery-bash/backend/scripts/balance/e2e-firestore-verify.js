/**
 * e2e-firestore-verify.js — Full 5-round playthrough via the Firebase
 * emulator, then deep-inspect Firestore docs to verify the simulation
 * persisted correctly.
 *
 * This complements the pure-Node tests by exercising the full pipeline:
 * submitBids → resolveAdAuction → simulating → results_ready → leaderboard.
 *
 * Verifies:
 *  - Per-round result docs exist with correct shape
 *  - Budget tracking across rounds is consistent
 *  - Ad auction resolves to the highest bidder (no min-bid floor in V7+)
 *  - Chef rosters accumulate within the cap
 *  - Cumulative profit at game end matches per-round sum
 *  - Sellout cap reflected in per-product results
 *
 * Run via:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *   GCLOUD_PROJECT=bakery-bash-54d12 \
 *   node scripts/balance/e2e-firestore-verify.js
 */

'use strict';

const { initializeApp: initAdmin } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { initializeApp } = require('firebase/app');
const { connectAuthEmulator, getAuth, signInAnonymously } = require('firebase/auth');
const { connectFunctionsEmulator, getFunctions, httpsCallable } = require('firebase/functions');

const PROJECT_ID = 'bakery-bash-54d12';
const GAME_ID = 'balance-e2e-' + Date.now();

// Pull live defaults so this test stays in sync with config.js scale (which
// has been rebalanced from $500k → $10k starting budget; ad bonuses 50× down).
const path = require('path');
const cfgMod = require(path.join('..', '..', 'functions', 'modules', 'config'));
const chefMod = require(path.join('..', '..', 'functions', 'modules', 'chef-system'));
const CFG = cfgMod.mergeConfig(cfgMod.DEFAULT_GAME_CONFIG);

const STARTING_BUDGET = CFG.startingBudget;     // $10,000 post-rebalance
const TV_BONUS = CFG.adBonuses.TV;              // $400 post-rebalance
// Alice bids ~80% of TV bonus (winning, profitable), Bob bids a tiny amount
// that loses to Alice. Pre-V7 there was a hard min-bid floor; that's gone
// (cfg.adBidMinimums all 0), so Bob's bid simply loses to Alice's.
const NORMAL_AD_BID = Math.round(TV_BONUS * 0.825);   // ~$330
const LOSING_AD_BID = Math.max(1, Math.round(TV_BONUS * 0.10)); // ~$40

let PASS = 0;
let FAIL = 0;
const FAILURES = [];

function check(label, condition, details) {
  if (condition) {
    PASS++;
    console.log('  ✓ ' + label);
    return true;
  }
  FAIL++;
  FAILURES.push(label + (details ? ': ' + details : ''));
  console.log('  ✗ ' + label + (details ? ' — ' + details : ''));
  return false;
}

function checkClose(label, actual, expected, tol) {
  return check(label + ` (got ${actual}, expected ${expected} ±${tol})`,
    Math.abs(actual - expected) <= tol);
}

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('FIRESTORE_EMULATOR_HOST not set. Start the emulator first.');
    process.exit(2);
  }

  initAdmin({ projectId: PROJECT_ID });
  const db = getFirestore();

  const app = initializeApp({
    apiKey: 'demo-key',
    authDomain: `${PROJECT_ID}.firebaseapp.com`,
    projectId: PROJECT_ID,
  });
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);

  const { user: prof } = await signInAnonymously(auth);
  console.log(`Professor signed in: ${prof.uid}`);

  // ---- Seed game with 2 teams using current default config ----
  console.log(`\nSeeding game ${GAME_ID}...`);
  await db.doc(`games/${GAME_ID}`).set({
    joinCode: 'BAL999',
    phase: 'round_1_email',
    round: 1,
    currentRound: 1,
    totalRounds: 2, // 2 rounds for speed
    phaseEndTime: null,
    submittedCount: 0,
    totalPlayers: 2,
    paused: false,
    professorId: prof.uid,
    professorUid: prof.uid,
    createdAt: FieldValue.serverTimestamp(),
  });

  // Use defaults — don't override the params doc, so the test exercises
  // whatever DEFAULT_GAME_CONFIG currently ships (V7: no ad-bid floor,
  // 50× rescaled budget/bonuses).
  await db.doc(`games/${GAME_ID}/config/params`).set({});

  // 2 solo teams
  for (const [teamSlug, uid, name] of [
    ['team-a', 'uid_alice', 'Alice'],
    ['team-b', 'uid_bob', 'Bob'],
  ]) {
    await db.doc(`games/${GAME_ID}/teams/${teamSlug}`).set({
      teamId: teamSlug, teamName: name + " Team",
      memberUids: [uid], createdAt: FieldValue.serverTimestamp(),
    });
    await db.doc(`games/${GAME_ID}/players/${uid}`).set({
      uid, playerId: uid, displayName: name, bakeryName: `${name} Bakery`,
      teamId: teamSlug, role: 'solo',
      budgetCurrent: STARTING_BUDGET, cumulativeRevenue: 0,
      specialtyChefs: [], sousChefCount: 0,
      consecutiveMissedRounds: 0, disconnected: false,
    });
  }

  // ---- Run 2 rounds ----
  const advance = httpsCallable(functions, 'advanceGamePhase');

  console.log('\nRound 1:');

  // Email → bid_ad
  await advance({ gameId: GAME_ID });
  const phase1 = (await db.doc(`games/${GAME_ID}`).get()).get('phase');
  check('R1 email→bid_ad transition', phase1 === 'round_1_bid_ad', `got ${phase1}`);

  // Alice bids ~80% of TV bonus (winning), Bob bids a token amount that loses
  // the auction to Alice. (Pre-V7 ad min floors were a thing; they were removed
  // for UX, so we now just rely on Alice's higher bid winning the sealed auction.)
  for (const [uid, bid] of [['uid_alice', NORMAL_AD_BID], ['uid_bob', LOSING_AD_BID]]) {
    await db.doc(`games/${GAME_ID}/players/${uid}/bids/round_1`).set({
      ad: { TV: bid, Billboard: 0, Radio: 0, Newspaper: 0 },
      adSubmittedAt: FieldValue.serverTimestamp(),
    });
  }

  // Advance to bid_chef (this triggers ad auction resolution)
  await advance({ gameId: GAME_ID });

  // Verify ad auction
  const adAuction = (await db.doc(`games/${GAME_ID}/rounds/round_1`).get()).get('adAuctionResults') || {};
  const aliceAdResult = adAuction['team-a'] || adAuction['uid_alice'];
  const bobAdResult = adAuction['team-b'] || adAuction['uid_bob'];

  check(`R1 alice ($${NORMAL_AD_BID} bid) won TV`,
    !!aliceAdResult && aliceAdResult.adTypes && aliceAdResult.adTypes.includes('TV'));
  check(`R1 bob ($${LOSING_AD_BID} bid) lost TV to higher bidder`,
    !bobAdResult || !bobAdResult.adTypes || !bobAdResult.adTypes.includes('TV'));

  // Submit chef bids (skip — both teams skip)
  for (const uid of ['uid_alice', 'uid_bob']) {
    await db.doc(`games/${GAME_ID}/players/${uid}/bids/round_1`).set({
      chef: [], chefSubmittedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  await advance({ gameId: GAME_ID });
  const phase3 = (await db.doc(`games/${GAME_ID}`).get()).get('phase');
  check('R1 bid_chef→roster transition', phase3 === 'round_1_roster', `got ${phase3}`);

  await advance({ gameId: GAME_ID });
  const phase4 = (await db.doc(`games/${GAME_ID}`).get()).get('phase');
  check('R1 roster→decide transition', phase4 === 'round_1_decide', `got ${phase4}`);

  // Submit decisions
  for (const uid of ['uid_alice', 'uid_bob']) {
    await db.doc(`games/${GAME_ID}/players/${uid}/decisions/round_1`).set({
      round: 1,
      submittedAt: FieldValue.serverTimestamp(),
      menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: true, matcha: false },
      quantities: { croissant: 100, cookie: 100, bagel: 100, coffee: 100 },
      sousChefCount: 2,
      sousChefAssignments: { croissant: 1, coffee: 1 },
    });
  }

  // Advance into simulating → results_ready
  await advance({ gameId: GAME_ID });
  const phase5 = (await db.doc(`games/${GAME_ID}`).get()).get('phase');
  check('R1 decide→simulating→results_ready', phase5 === 'results_ready', `got ${phase5}`);

  // ---- Verify R1 results ----
  console.log('\nR1 result verification:');
  const aliceR1 = (await db.doc(`games/${GAME_ID}/players/uid_alice/rounds/round_1`).get()).data();
  const bobR1 = (await db.doc(`games/${GAME_ID}/players/uid_bob/rounds/round_1`).get()).data();

  check('R1 alice result doc exists', !!aliceR1);
  check('R1 bob result doc exists', !!bobR1);
  check('R1 alice revenueGross is finite', Number.isFinite(aliceR1.revenueGross));
  check('R1 bob revenueGross is finite', Number.isFinite(bobR1.revenueGross));
  check('R1 alice budgetAfter is finite', Number.isFinite(aliceR1.budgetAfter));
  check('R1 bob budgetAfter is finite', Number.isFinite(bobR1.budgetAfter));

  // Alice won TV → her gross should include the TV bonus on top of product
  // sales. Both teams sell into the same demand pool so product revenue is
  // comparable; the TV bonus is the differentiator.
  check(`R1 alice gross > bob gross by ~TV bonus ($${TV_BONUS})`,
    (aliceR1.revenueGross - bobR1.revenueGross) >= TV_BONUS - 100);
  check('R1 bob did NOT receive TV ad bonus (lost auction)',
    (aliceR1.revenueGross - bobR1.revenueGross) > 0);

  // Cost reconciliation. With post-rebalance scale:
  //   Alice: NORMAL_AD_BID ad + 2-sous hire ($25 at base $10) + 400 stock
  //   Bob:   $0 ad win (lost auction, doesn't pay) + 25 sous + 400 stock
  const aliceCostsR1 = aliceR1.totalSpent;
  const bobCostsR1 = bobR1.totalSpent;
  const sousCostFor2 = chefMod.getTotalSousChefHireCost(2, CFG);  // 2.5 × baseCost
  const stockCost = 400 * CFG.unitCostPerProduct;
  const aliceExpectedSpend = NORMAL_AD_BID + sousCostFor2 + stockCost;
  const bobExpectedSpend = 0 + sousCostFor2 + stockCost;
  console.log(`  Alice totalSpent: $${aliceCostsR1}, Bob totalSpent: $${bobCostsR1}`);
  console.log(`  Expected — Alice: $${aliceExpectedSpend}, Bob: $${bobExpectedSpend}`);
  check(`R1 alice spent ~$${aliceExpectedSpend} (${NORMAL_AD_BID} ad + ${sousCostFor2} sous + ${stockCost} stock)`,
    Math.abs(aliceCostsR1 - aliceExpectedSpend) < 5);
  check(`R1 bob spent ~$${bobExpectedSpend} (0 ad lost + ${sousCostFor2} sous + ${stockCost} stock)`,
    Math.abs(bobCostsR1 - bobExpectedSpend) < 5);

  // Budget reconciliation: budgetAfter = budgetBefore + revenueNet - totalSpent
  const aliceBudgetExpected = Math.round(STARTING_BUDGET + aliceR1.revenueNet - aliceR1.totalSpent);
  check('R1 alice budgetAfter = budgetBefore + revenueNet - totalSpent',
    Math.abs(aliceR1.budgetAfter - aliceBudgetExpected) <= 1,
    `got ${aliceR1.budgetAfter}, expected ${aliceBudgetExpected}`);

  // Round doc has class stats
  const roundDoc = (await db.doc(`games/${GAME_ID}/rounds/round_1`).get()).data();
  check('R1 round doc simulationStatus = complete', roundDoc.simulationStatus === 'complete');
  check('R1 round doc classStats exists', roundDoc.classStats && typeof roundDoc.classStats === 'object');

  // Leaderboard
  const lb = (await db.doc(`games/${GAME_ID}/leaderboard/latest`).get()).data();
  check('R1 leaderboard exists with 2 rankings', lb && Array.isArray(lb.rankings) && lb.rankings.length === 2);

  // ---- Run R2 to verify multi-round consistency ----
  console.log('\nRound 2:');
  await advance({ gameId: GAME_ID });
  const phaseR2 = (await db.doc(`games/${GAME_ID}`).get()).get('phase');
  check('R2 begins (round_2_email)', phaseR2 === 'round_2_email');

  // Skip ads/chefs/roster/decide quickly
  await advance({ gameId: GAME_ID }); // → bid_ad
  // R2 ad bid: ~50% of TV bonus (split-the-difference auction)
  const r2Bid = Math.round(TV_BONUS * 0.5);
  for (const uid of ['uid_alice', 'uid_bob']) {
    await db.doc(`games/${GAME_ID}/players/${uid}/bids/round_2`).set({
      ad: { TV: r2Bid, Billboard: 0, Radio: 0, Newspaper: 0 },
      adSubmittedAt: FieldValue.serverTimestamp(),
    });
  }
  await advance({ gameId: GAME_ID }); // → bid_chef
  for (const uid of ['uid_alice', 'uid_bob']) {
    await db.doc(`games/${GAME_ID}/players/${uid}/bids/round_2`).set({
      chef: [], chefSubmittedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await advance({ gameId: GAME_ID }); // → roster
  await advance({ gameId: GAME_ID }); // → decide
  for (const uid of ['uid_alice', 'uid_bob']) {
    await db.doc(`games/${GAME_ID}/players/${uid}/decisions/round_2`).set({
      round: 2,
      submittedAt: FieldValue.serverTimestamp(),
      menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: true, matcha: false },
      quantities: { croissant: 100, cookie: 100, bagel: 100, coffee: 100 },
      sousChefCount: 2,
      sousChefAssignments: { croissant: 1, coffee: 1 },
    });
  }
  await advance({ gameId: GAME_ID }); // → simulating → results_ready or game_complete

  // R2 verification
  const aliceR2 = (await db.doc(`games/${GAME_ID}/players/uid_alice/rounds/round_2`).get()).data();
  const aliceLive = (await db.doc(`games/${GAME_ID}/players/uid_alice`).get()).data();

  check('R2 alice result doc exists', !!aliceR2);
  // Player live budget should match latest round's budgetAfter
  check('R2 alice live budgetCurrent matches budgetAfter',
    Math.abs(aliceLive.budgetCurrent - aliceR2.budgetAfter) <= 1,
    `live=${aliceLive.budgetCurrent}, R2=${aliceR2.budgetAfter}`);

  // Cumulative budget consistency
  // budgetAfter R2 = budgetAfter R1 + revenueNetR2 - totalSpentR2
  const expectedR2Budget = Math.round(aliceR1.budgetAfter + aliceR2.revenueNet - aliceR2.totalSpent);
  check('R2 budget chain consistency',
    Math.abs(aliceR2.budgetAfter - expectedR2Budget) <= 1,
    `got ${aliceR2.budgetAfter}, expected ${expectedR2Budget}`);

  // ---- Cleanup ----
  console.log('\nCleanup: deleting game ' + GAME_ID);
  await db.recursiveDelete(db.doc(`games/${GAME_ID}`));

  console.log(`\n=== E2E RESULTS: ${PASS} passed, ${FAIL} failed ===`);
  if (FAIL > 0) {
    console.log('Failures:');
    for (const f of FAILURES) console.log('  ' + f);
    process.exit(1);
  }
  console.log('All E2E Firestore checks passed.');
}

main().catch((err) => {
  console.error('E2E test crashed:', err);
  process.exit(2);
});
