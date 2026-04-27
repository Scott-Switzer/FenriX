#!/usr/bin/env node
/**
 * verify-ad-winner.js
 *
 * Reproduces the V5 complaint: "Ad winners now doesn't work. It says I won the
 * one thing I didn't bid for."
 *
 * Plan: drive 2 teams to ad-bidding, place CONTRASTING bids (Alice on TV
 * only, Bob on Billboard only), advance to bid_chef so the ad auction
 * resolves, then dump the round doc + the round_doc.auctionResults shape so
 * we can see what the FE will read.
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
const GAME_ID = 'verify-ad-winner';
const JOIN_CODE = 'ADWN23';
const PROF_UID = 'prof-adwin';
const ALICE_UID = 'adwin-alice';
const BOB_UID = 'adwin-bob';

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
  });

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

  console.log('\nStep 2: Advance lobby → email → bid_ad');
  const advance = httpsCallable(fnsP, 'advanceGamePhase');
  await advance({ gameId: GAME_ID });   // lobby → round_1_email
  await advance({ gameId: GAME_ID });   // email → bid_ad

  let g = await gameRef.get();
  console.log('Now in phase:', g.get('phase'));

  console.log('\nStep 3: Alice bids ONLY on TV ($400). Bob bids ONLY on Billboard ($300).');
  // Alice bids TV only.
  await httpsCallable(fnsA, 'submitBids')({
    gameId: GAME_ID, bidType: 'ad',
    adBids: { TV: 400, Billboard: 0, Radio: 0, Newspaper: 0 },
  });
  // Bob bids Billboard only.
  await httpsCallable(fnsB, 'submitBids')({
    gameId: GAME_ID, bidType: 'ad',
    adBids: { TV: 0, Billboard: 300, Radio: 0, Newspaper: 0 },
  });

  // Confirm bids stored.
  const aliceBidSnap = await gameRef.collection('players').doc(ALICE_UID).collection('bids').doc('round_1').get();
  const bobBidSnap = await gameRef.collection('players').doc(BOB_UID).collection('bids').doc('round_1').get();
  console.log('  alice/bids/round_1.ad:', JSON.stringify(aliceBidSnap.data()?.ad));
  console.log('  bob/bids/round_1.ad:  ', JSON.stringify(bobBidSnap.data()?.ad));

  console.log('\nStep 4: Advance bid_ad → bid_chef (this is when ad auction resolves)');
  await advance({ gameId: GAME_ID });

  g = await gameRef.get();
  console.log('Now in phase:', g.get('phase'));

  const roundSnap = await gameRef.collection('rounds').doc('round_1').get();
  const data = roundSnap.data() || {};
  console.log('\nrounds/round_1.auctionResults.ads (FE reads this):');
  console.log(JSON.stringify(data.auctionResults?.ads, null, 2));
  console.log('\nrounds/round_1.adAuctionResults (legacy alt path):');
  console.log(JSON.stringify(data.adAuctionResults, null, 2));

  // Sanity check: Alice should win TV (and only TV); Bob should win Billboard
  // (and only Billboard); Radio + Newspaper should have no winner.
  const ads = data.auctionResults?.ads || {};
  const aliceTeamId = (await gameRef.collection('players').doc(ALICE_UID).get()).get('teamId');
  const bobTeamId = (await gameRef.collection('players').doc(BOB_UID).get()).get('teamId');
  console.log(`\nAlice teamId/uid: ${aliceTeamId} / ${ALICE_UID}`);
  console.log(`Bob   teamId/uid: ${bobTeamId} / ${BOB_UID}`);

  const expect = (label, condition) =>
    console.log(`  ${condition ? '✓' : '✗ FAIL'} ${label}`);
  expect('TV winner is Alice', ads.TV?.winnerId === ALICE_UID || ads.TV?.winnerKey === aliceTeamId);
  expect('Billboard winner is Bob', ads.Billboard?.winnerId === BOB_UID || ads.Billboard?.winnerKey === bobTeamId);
  expect('Radio has NO winner', !ads.Radio?.winnerId && !ads.Radio?.winnerKey);
  expect('Newspaper has NO winner', !ads.Newspaper?.winnerId && !ads.Newspaper?.winnerKey);

  console.log('\n✓ Done.');
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
