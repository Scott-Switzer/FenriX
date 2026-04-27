#!/usr/bin/env node
/**
 * verify-chef-win-display.js
 *
 * Reproduces the V4-testing complaint: "We won chefs in the bidding but it
 * says we didn't win."
 *
 * Plan: drive a 2-team game to the chef-auction step, place bids, advance
 * to roster, and dump the round doc so we can confirm what
 * `chefAuctionResults` contains and what the FE would actually render.
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
const GAME_ID = 'verify-chef-win';
const JOIN_CODE = 'CHEFV2';
const PROF_UID = 'prof-chefwin';

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
      // Clean up nested subcollections (e.g. players/{uid}/bids).
      const inner = await d.ref.collection('bids').get().catch(() => ({ docs: [] }));
      for (const i of inner.docs) await i.ref.delete();
      const inner2 = await d.ref.collection('decisions').get().catch(() => ({ docs: [] }));
      for (const i of inner2.docs) await i.ref.delete();
      await d.ref.delete();
    }
  }
  await gameRef.delete().catch(() => {});
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
    chefPoolSize: 6,
  });

  // 2 teams, 1 player each, plus a professor.
  const ALICE_UID = 'chefwin-alice';
  const BOB_UID = 'chefwin-bob';
  const fnsA = await clientForUid(ALICE_UID, adminAuth, 'app-a');
  const fnsB = await clientForUid(BOB_UID, adminAuth, 'app-b');
  const fnsP = await clientForUid(PROF_UID, adminAuth, 'app-p');

  console.log('\nStep 1: Alice creates "Flour Power", Bob creates "Bake Off"');
  await httpsCallable(fnsA, 'createTeam')({
    joinCode: JOIN_CODE, teamName: 'Flour Power', displayName: 'Alice',
  });
  await httpsCallable(fnsB, 'createTeam')({
    joinCode: JOIN_CODE, teamName: 'Bake Off', displayName: 'Bob',
  });

  // The advanceGamePhase backend gate uses `professorUid === auth.uid`,
  // not a custom claim. We seeded the game with `professorUid = PROF_UID`
  // above so PROF_UID's anonymous sign-in is enough.
  const advance = httpsCallable(fnsP, 'advanceGamePhase');
  console.log('\nStep 2: Advance lobby → round_1_email → bid_ad → bid_chef');
  await advance({ gameId: GAME_ID });   // lobby → round_1_email
  await advance({ gameId: GAME_ID });   // email → bid_ad
  await advance({ gameId: GAME_ID });   // bid_ad → bid_chef

  let g = await gameRef.get();
  console.log(`Now in phase: ${g.get('phase')}`);

  // Chef pool is generated when entering bid_chef.
  let roundSnap = await gameRef.collection('rounds').doc('round_1').get();
  const chefPool = (roundSnap.data() || {}).chefPool || [];
  console.log(`Chef pool size: ${chefPool.length}`);
  if (chefPool.length === 0) {
    console.error('No chef pool generated — aborting.');
    process.exit(1);
  }
  const chef = chefPool[0];
  console.log(`Picking chef: id=${chef.id} name=${chef.name} minBid=${chef.minBidFloor}`);

  console.log('\nStep 3: Both teams bid on the same chef. Alice bids higher.');
  // Alice bids high — should win.
  await httpsCallable(fnsA, 'submitBids')({
    gameId: GAME_ID, bidType: 'chef',
    chefBids: [{ chefId: chef.id, amount: chef.minBidFloor + 1000 }],
  });
  console.log(`  Alice bid $${chef.minBidFloor + 1000} on ${chef.name}`);
  await httpsCallable(fnsB, 'submitBids')({
    gameId: GAME_ID, bidType: 'chef',
    chefBids: [{ chefId: chef.id, amount: chef.minBidFloor + 20 }],
  });
  console.log(`  Bob bid   $${chef.minBidFloor + 20} on ${chef.name}`);

  // Sanity: read both bid docs.
  const aliceBidSnap = await gameRef.collection('players').doc(ALICE_UID).collection('bids').doc('round_1').get();
  const bobBidSnap = await gameRef.collection('players').doc(BOB_UID).collection('bids').doc('round_1').get();
  console.log('  alice/bids/round_1 chef:', JSON.stringify(aliceBidSnap.data()?.chef));
  console.log('  bob/bids/round_1 chef:  ', JSON.stringify(bobBidSnap.data()?.chef));

  console.log('\nStep 4: Advance bid_chef → roster (this is when chef auction resolves)');
  await advance({ gameId: GAME_ID });

  g = await gameRef.get();
  console.log(`Now in phase: ${g.get('phase')}`);

  roundSnap = await gameRef.collection('rounds').doc('round_1').get();
  const data = roundSnap.data() || {};
  console.log('\nrounds/round_1.chefAuctionResults:');
  console.log(JSON.stringify(data.chefAuctionResults, null, 2));

  // What would Alice see on the FE? FE reads chefAuctionResults[teamId || playerId].
  const aliceTeamId = (await gameRef.collection('players').doc(ALICE_UID).get()).get('teamId');
  const bobTeamId = (await gameRef.collection('players').doc(BOB_UID).get()).get('teamId');
  console.log(`\nAlice teamId: ${aliceTeamId}`);
  console.log(`Bob teamId:   ${bobTeamId}`);

  const aliceLookup = data.chefAuctionResults?.[aliceTeamId];
  const bobLookup = data.chefAuctionResults?.[bobTeamId];
  console.log(`\nFE lookup chefAuctionResults[${aliceTeamId}]:`, aliceLookup ? JSON.stringify(aliceLookup) : 'NOT FOUND');
  console.log(`FE lookup chefAuctionResults[${bobTeamId}]:  `, bobLookup ? JSON.stringify(bobLookup) : 'NOT FOUND');

  // Player doc specialtyChefs — should mirror.
  const aliceSpec = (await gameRef.collection('players').doc(ALICE_UID).get()).get('specialtyChefs');
  console.log(`\nAlice specialtyChefs:`, JSON.stringify(aliceSpec));

  console.log('\n✓ Verification complete.');
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
