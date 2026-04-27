#!/usr/bin/env node
/**
 * verify-roster-to-decide.js
 *
 * Reproduces V6 complaint: "Still not moving to the decide phase for everyone.
 * It says from the professor window that everyone is on the decide screen,
 * but the players are not from just looking at it, they're still on the chef
 * roster deciding phase."
 *
 * Plan:
 * - Set up a 2-team game (Team A: Alice, Team B: Bob; both solo for simplicity).
 * - Drive through start → email → bid_ad → bid_chef → roster.
 * - Have Alice click Continue (continueFromRoster).
 * - Try to advance roster → decide.
 * - Inspect the result + the game doc + each player doc.
 *
 * Confirms whether the BACKEND succeeds in writing phase=round_1_decide.
 * If yes, the bug must be FE — the player tabs aren't picking up the snapshot
 * and/or are not navigating.
 */

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

const { initializeApp: initAdmin } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');
const { initializeApp: initClient } = require('firebase/app');
const {
  getAuth, signInWithCustomToken, connectAuthEmulator,
} = require('firebase/auth');
const {
  getFunctions, httpsCallable, connectFunctionsEmulator,
} = require('firebase/functions');

const PROJECT_ID = 'bakery-bash-54d12';
const GAME_ID = 'verify-roster-decide';
const JOIN_CODE = 'RDC234';
const PROF_UID = 'prof-rdc';
const ALICE_UID = 'rdc-alice';
const BOB_UID = 'rdc-bob';

async function clientForUid(uid, adminAuth, label) {
  const app = initClient(
    { apiKey: 'demo', projectId: PROJECT_ID, authDomain: 'demo', appId: 'demo' },
    label,
  );
  connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001);
  await signInWithCustomToken(getAuth(app), await adminAuth.createCustomToken(uid));
  return getFunctions(app);
}

async function clearGame(db) {
  const gameRef = db.collection('games').doc(GAME_ID);
  for (const sub of ['players', 'roster', 'teams', 'config', 'rounds', 'submissions', 'marketInsights']) {
    const snap = await gameRef.collection(sub).get();
    for (const d of snap.docs) {
      for (const inner of ['bids', 'decisions']) {
        const subSnap = await d.ref.collection(inner).get().catch(() => ({ docs: [] }));
        for (const s of subSnap.docs) await s.ref.delete();
      }
      await d.ref.delete();
    }
  }
  await gameRef.delete().catch(() => {});
}

async function dumpGame(db, label) {
  const g = await db.collection('games').doc(GAME_ID).get();
  console.log(`\n=== ${label} ===`);
  console.log(`  game.phase           = ${g.get('phase')}`);
  console.log(`  game.currentRound    = ${g.get('currentRound')}`);
  console.log(`  game.phaseEndsAt     = ${g.get('phaseEndsAt')?.toDate?.() || g.get('phaseEndsAt')}`);
  console.log(`  game.paused          = ${g.get('paused')}`);
  return g;
}

async function dumpPlayers(db) {
  for (const uid of [ALICE_UID, BOB_UID]) {
    const p = await db.collection('games').doc(GAME_ID).collection('players').doc(uid).get();
    if (!p.exists) {
      console.log(`  ${uid}: <missing>`);
      continue;
    }
    console.log(`  ${uid}: rosterCompleted=${p.get('rosterCompleted')} specialtyChefs=${(p.get('specialtyChefs') || []).length} role=${p.get('role')}`);
  }
}

async function main() {
  initAdmin({ projectId: PROJECT_ID });
  const db = getFirestore();
  const adminAuth = getAdminAuth();

  console.log('Cleaning prior state…');
  await clearGame(db);

  const gameRef = db.collection('games').doc(GAME_ID);
  await gameRef.set({
    joinCode: JOIN_CODE,
    professorUid: PROF_UID, professorId: PROF_UID,
    phase: 'lobby', round: 0, currentRound: 0, totalRounds: 5,
    totalPlayers: 0, submittedCount: 0, paused: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  await gameRef.collection('config').doc('params').set({
    playerCap: 20,
  });

  const fnsA = await clientForUid(ALICE_UID, adminAuth, 'app-a');
  const fnsB = await clientForUid(BOB_UID, adminAuth, 'app-b');
  const fnsP = await clientForUid(PROF_UID, adminAuth, 'app-p');

  console.log('\nStep 1: Alice + Bob create teams (solo each).');
  await httpsCallable(fnsA, 'createTeam')({
    joinCode: JOIN_CODE, teamName: 'Flour Power', displayName: 'Alice',
  });
  await httpsCallable(fnsB, 'createTeam')({
    joinCode: JOIN_CODE, teamName: 'Bake Off', displayName: 'Bob',
  });

  console.log('\nStep 2: startGame (lobby → round_1_email)');
  await httpsCallable(fnsP, 'startGame')({ gameId: GAME_ID });
  await dumpGame(db, 'after startGame');

  const advance = httpsCallable(fnsP, 'advanceGamePhase');

  console.log('\nStep 3: advance email → bid_ad');
  await advance({ gameId: GAME_ID });
  await dumpGame(db, 'after email→bid_ad');

  console.log('\nStep 4: each places bids on TV/Billboard/Radio/Newspaper at $400 each');
  await httpsCallable(fnsA, 'submitBids')({
    gameId: GAME_ID, bidType: 'ad',
    adBids: { TV: 400, Billboard: 400, Radio: 400, Newspaper: 400 },
  });
  await httpsCallable(fnsB, 'submitBids')({
    gameId: GAME_ID, bidType: 'ad',
    adBids: { TV: 500, Billboard: 100, Radio: 100, Newspaper: 100 }, // Bob outbids on TV only
  });

  console.log('\nStep 5: advance bid_ad → bid_chef (ad auction resolves)');
  await advance({ gameId: GAME_ID });
  await dumpGame(db, 'after bid_ad→bid_chef');

  const round1 = await gameRef.collection('rounds').doc('round_1').get();
  const ads = round1.data()?.auctionResults?.ads || {};
  console.log('\nAd winners after resolution:');
  for (const adType of ['TV', 'Billboard', 'Radio', 'Newspaper']) {
    const w = ads[adType];
    console.log(`  ${adType}: winnerId=${w?.winnerId || '(none)'} winningBid=${w?.winningBid || 0}`);
  }
  console.log('\n>>> EXPECTED: Bob wins TV ($500 > $400); Alice wins Billboard/Radio/Newspaper ($400 > $100)');
  console.log('>>> Note: ad bid floors were removed in V7, so any positive bid is a valid auction entry.');

  console.log('\nStep 6: each places chef bids and advance bid_chef → roster (chef auction resolves)');
  // Get the chef pool for round 1
  const chefPool = round1.data()?.chefPool || [];
  console.log(`  Chef pool size for round 1: ${chefPool.length}`);
  // Now we need to refetch the round doc since it's been updated
  const round1AfterAdRes = await gameRef.collection('rounds').doc('round_1').get();
  const pool = round1AfterAdRes.data()?.chefPool || [];
  // Have each player bid on the first chef so they each get one
  if (pool.length >= 2) {
    await httpsCallable(fnsA, 'submitBids')({
      gameId: GAME_ID, bidType: 'chef',
      chefBids: [{ chefId: pool[0].id, amount: pool[0].minBidFloor + 100 }],
    });
    await httpsCallable(fnsB, 'submitBids')({
      gameId: GAME_ID, bidType: 'chef',
      chefBids: [{ chefId: pool[1].id, amount: pool[1].minBidFloor + 100 }],
    });
  }
  await advance({ gameId: GAME_ID });
  await dumpGame(db, 'after bid_chef→roster');
  console.log('Player state after chef auction:');
  await dumpPlayers(db);

  console.log('\nStep 7: Alice clicks Continue (continueFromRoster)');
  try {
    await httpsCallable(fnsA, 'continueFromRoster')({ gameId: GAME_ID });
    console.log('  Alice continueFromRoster: OK');
  } catch (e) {
    console.log(`  Alice continueFromRoster FAILED: ${e.code}: ${e.message}`);
  }
  // Bob deliberately does NOT click continue — to mimic the case where one team hasn't locked in yet.
  console.log('  Bob deliberately not clicking continue (mimicking real game)');
  await dumpPlayers(db);

  console.log('\nStep 8: Professor advances roster → decide');
  try {
    const result = await advance({ gameId: GAME_ID });
    console.log(`  advance result: phase=${result.data.phase} round=${result.data.round}`);
  } catch (e) {
    console.log(`  advance FAILED: ${e.code}: ${e.message}`);
    console.log('  >>> If this is "failed-precondition: Cannot leave roster — team(s) over chef cap"');
    console.log('  >>> then the bug is that the professor SEES it advance but it actually failed silently in the UI.');
  }
  await dumpGame(db, 'after roster→decide attempt');
  await dumpPlayers(db);

  const finalGame = await gameRef.get();
  console.log(`\n>>> FINAL game.phase = ${finalGame.get('phase')}`);
  console.log(finalGame.get('phase') === 'round_1_decide'
    ? '>>> ✓ Backend transitions correctly. Bug must be in FE navigation.'
    : '>>> ✗ Backend FAILED to transition. Bug is in backend or chef-cap check.');

  console.log('\n✓ Done.');
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
