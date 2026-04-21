#!/usr/bin/env node
/**
 * set-professor-claim.js — One-off admin script to grant the professor role.
 *
 * Usage:
 *   node set-professor-claim.js <uid>
 *   GCLOUD_PROJECT=<prod-project-id> node set-professor-claim.js <uid>
 *
 * The script uses Application Default Credentials (ADC). In production, run
 * from a service account with the Firebase Auth Admin role; locally, use:
 *   firebase login; export GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json
 *
 * Emulator override: if FIREBASE_AUTH_EMULATOR_HOST is set, the call targets
 * the local Auth emulator instead of production.
 */

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const uid = process.argv[2];
if (!uid || uid.trim() === '') {
  console.error('Usage: node set-professor-claim.js <uid>');
  process.exit(1);
}

if (!getApps().length) {
  // initializeApp picks up GOOGLE_APPLICATION_CREDENTIALS or the emulator env
  // automatically; no config object needed in most CI / Cloud environments.
  initializeApp();
}

const auth = getAuth();

(async () => {
  try {
    // Verify the UID exists before writing the claim.
    const user = await auth.getUser(uid);
    console.log(`Found user: ${user.displayName || '(no display name)'} <${user.email || 'no email'}>`);

    await auth.setCustomUserClaims(uid, { professor: true });
    console.log(`✅ professor: true set on UID ${uid}`);
    console.log('The user must refresh their ID token (sign out + in, or wait 1 h) to pick up the new claim.');
  } catch (err) {
    console.error('❌ Failed to set claim:', err.message || err);
    process.exit(1);
  }
})();
