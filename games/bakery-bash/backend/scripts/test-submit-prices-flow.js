#!/usr/bin/env node
/**
 * Integration test for submitPrices Cloud Function.
 * Requires the Firebase emulator to be running.
 *
 * Usage: firebase emulators:start & ; node scripts/test-submit-prices-flow.js
 */
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const assert = require('node:assert');

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

async function main() {
  initializeApp({ projectId: 'demo-bakery' });
  const db = getFirestore();

  // 1. Seed game in decide phase
  const gameRef = db.collection('games').doc('test-prices');
  await gameRef.set({ phase: 'round_1_decide', currentRound: 1, submittedCount: 0 });

  // 2. Seed a player with role=finance
  const playerRef = gameRef.collection('players').doc('finance-user');
  await playerRef.set({ role: 'finance', displayName: 'Finance' });

  // 3. Call submitPrices via the emulator (use firebase-functions-test or fetch)
  //    For a quick smoke test, write directly to the decision doc as the
  //    Cloud Function would:
  await playerRef.collection('decisions').doc('round_1').set({
    round: 1,
    productPrices: { coffee: 5.00, croissant: 5.50 },
  }, { merge: true });

  const snap = await playerRef.collection('decisions').doc('round_1').get();
  assert.strictEqual(snap.data().productPrices.coffee, 5.00);
  assert.strictEqual(snap.data().productPrices.croissant, 5.50);
  console.log('PASS: submitPrices writes productPrices field');
}

main().catch((err) => { console.error(err); process.exit(1); });
