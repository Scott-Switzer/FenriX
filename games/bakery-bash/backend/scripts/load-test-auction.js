#!/usr/bin/env node
/**
 * Bakery Bash — Auction Load Test
 *
 * Spins up N teams (each with one auth'd player in the `advertising` role)
 * and fires all submitBids({ bidType: 'ad' }) calls in parallel against the
 * Cloud Functions emulator. Measures latency distribution, error codes, and
 * the resulting topBids state to spot transaction conflicts on the shared
 * rounds/{round} document.
 *
 * Usage:
 *   firebase emulators:start --only auth,firestore,functions   # in another terminal
 *   node scripts/load-test-auction.js                          # default: 25 teams on TV
 *   node scripts/load-test-auction.js --teams 70               # 70 teams
 *   node scripts/load-test-auction.js --teams 25 --burst 30    # bursts of 30 over the same surface
 *   node scripts/load-test-auction.js --teams 25 --spread      # spread across all 4 ad surfaces
 *
 * Output:
 *   Per-team timing + final aggregate report (success%, latency percentiles,
 *   error code histogram, final topBids state).
 *
 * Requires emulator with auth + firestore + functions running.
 */

const { initializeApp: initAdmin } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { initializeApp: initClient } = require('firebase/app');
const { connectAuthEmulator, getAuth, signInAnonymously } = require('firebase/auth');
const { connectFunctionsEmulator, getFunctions, httpsCallable } = require('firebase/functions');

const PROJECT_ID = 'bakery-bash-54d12';
const FUNCTIONS_HOST = '127.0.0.1';
const FUNCTIONS_PORT = 5001;
const AUTH_HOST = '127.0.0.1';
const AUTH_PORT = 9099;
const FIRESTORE_HOST = '127.0.0.1';
const FIRESTORE_PORT = 8080;

const AD_SURFACES = ['TV', 'Billboard', 'Radio', 'Newspaper'];

function parseArgs(argv) {
  const args = { teams: 25, burst: null, spread: false, gameId: null, surface: 'TV', staggerMs: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--teams') args.teams = parseInt(argv[++i], 10);
    else if (a === '--burst') args.burst = parseInt(argv[++i], 10);
    else if (a === '--spread') args.spread = true;
    else if (a === '--game-id') args.gameId = argv[++i];
    else if (a === '--surface') args.surface = argv[++i];
    else if (a === '--stagger') args.staggerMs = parseInt(argv[++i], 10);
  }
  if (!args.gameId) args.gameId = `loadtest_${Date.now()}`;
  return args;
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function seedGame(db, gameId, teams, professorUid) {
  // Wipe any prior run with this gameId.
  await db.recursiveDelete(db.doc(`games/${gameId}`));

  await db.doc(`games/${gameId}`).set({
    joinCode: 'LOADTS',
    phase: 'round_1_bid_ad',
    round: 1,
    currentRound: 1,
    totalRounds: 5,
    phaseStartedAt: Timestamp.now(),
    phaseEndsAt: null,
    submittedCount: 0,
    totalPlayers: teams.length,
    paused: false,
    professorId: professorUid,
    professorUid,
    createdAt: Timestamp.now(),
    startedAt: Timestamp.now(),
    endedAt: null,
  });

  await db.doc(`games/${gameId}/config/params`).set({
    startingBudget: 5_000_000,
    sousChefBaseCost: 10,
    unitCostPerProduct: 1,
    specialtyChefCap: 3,
    chefPoolSize: 12,
    revenueCoefficients: {
      base: 0, sousChefCoeff: 0, satisfactionCoeff: 0,
      adSpendCoeff: 0, numProductsCoeff: 0, noiseMin: 0, noiseMax: 0,
    },
    adBonuses: { TV: 400, Billboard: 250, Radio: 150, Newspaper: 80 },
    phaseDurations: { email: 30, decide: 300, bid_ad: 60, bid_chef: 60, roster: 60, simulating: 30, results: 60 },
    totalRounds: 5,
  });

  for (const t of teams) {
    await db.doc(`games/${gameId}/players/${t.uid}`).set({
      uid: t.uid,
      playerId: t.uid,
      displayName: t.name,
      bakeryName: `${t.name} Bakery`,
      role: 'solo',
      teamId: null,
      budgetCurrent: 5_000_000,
      cumulativeRevenue: 0,
      specialtyChefs: [],
      sousChefCount: 0,
      consecutiveMissedRounds: 0,
      disconnected: false,
    });
  }
}

async function signInClients(teams) {
  return Promise.all(
    teams.map(async (t) => {
      const app = initClient({ apiKey: 'demo-key', projectId: PROJECT_ID, authDomain: `${PROJECT_ID}.firebaseapp.com` }, `client-${t.idx}`);
      const auth = getAuth(app);
      connectAuthEmulator(auth, `http://${AUTH_HOST}:${AUTH_PORT}`, { disableWarnings: true });
      const cred = await signInAnonymously(auth);
      const functions = getFunctions(app);
      connectFunctionsEmulator(functions, FUNCTIONS_HOST, FUNCTIONS_PORT);
      return { ...t, uid: cred.user.uid, app, auth, functions };
    })
  );
}

async function fireBids(teamsWithClients, args) {
  const surfaces = args.spread ? AD_SURFACES : [args.surface];
  const tasks = teamsWithClients.map((t, i) => {
    const surface = surfaces[i % surfaces.length];
    // Vary bid amounts so there's no tiebreak path that short-circuits.
    const amount = 100 + (i * 13);
    const bids = { TV: 0, Billboard: 0, Radio: 0, Newspaper: 0 };
    bids[surface] = amount;

    const fn = httpsCallable(t.functions, 'submitBids');
    const delay = args.staggerMs > 0 ? Math.random() * args.staggerMs : 0;
    return async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const startedAt = Date.now();
      try {
        const res = await fn({ gameId: args.gameId, bidType: 'ad', ...bids });
        return {
          team: t.name, surface, amount, latencyMs: Date.now() - startedAt,
          ok: true, response: res.data,
        };
      } catch (err) {
        return {
          team: t.name, surface, amount, latencyMs: Date.now() - startedAt,
          ok: false,
          code: err.code || 'unknown',
          message: err.message || String(err),
        };
      }
    };
  });

  // Fire all tasks; each may self-delay for the configured stagger window.
  const t0 = Date.now();
  const results = await Promise.all(tasks.map((fn) => fn()));
  const totalMs = Date.now() - t0;
  return { results, totalMs };
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`[loadtest] teams=${args.teams} surface=${args.spread ? 'spread' : args.surface} gameId=${args.gameId}`);

  process.env.FIRESTORE_EMULATOR_HOST = `${FIRESTORE_HOST}:${FIRESTORE_PORT}`;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = `${AUTH_HOST}:${AUTH_PORT}`;

  initAdmin({ projectId: PROJECT_ID });
  const db = getFirestore();

  // Sign in teams first so we have their UIDs to seed player docs.
  console.log(`[loadtest] signing in ${args.teams} anonymous users…`);
  const teams = Array.from({ length: args.teams }, (_, idx) => ({
    idx, name: `Team${String(idx + 1).padStart(2, '0')}`, uid: null,
  }));
  const teamsWithClients = await signInClients(teams);

  // Need a professor uid; reuse first team's auth (it's just a string in seed).
  const professorUid = teamsWithClients[0].uid;

  console.log(`[loadtest] seeding game ${args.gameId}…`);
  await seedGame(db, args.gameId, teamsWithClients, professorUid);

  console.log(`[loadtest] firing ${args.teams} concurrent submitBids…`);
  const { results, totalMs } = await fireBids(teamsWithClients, args);

  // ── Report ────────────────────────────────────────────────────────────
  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const latencies = results.map((r) => r.latencyMs);

  console.log('\n══════════════════════════════════════════════════');
  console.log(`  AUCTION LOAD TEST — ${args.teams} concurrent bidders`);
  console.log('══════════════════════════════════════════════════');
  console.log(`  Wallclock total      ${totalMs} ms`);
  console.log(`  Success              ${ok.length} / ${results.length}  (${(100 * ok.length / results.length).toFixed(1)}%)`);
  console.log(`  Failure              ${fail.length} / ${results.length}  (${(100 * fail.length / results.length).toFixed(1)}%)`);
  console.log(`  Latency p50/p95/p99  ${pct(latencies, 50)} / ${pct(latencies, 95)} / ${pct(latencies, 99)} ms`);
  console.log(`  Latency min / max    ${Math.min(...latencies)} / ${Math.max(...latencies)} ms`);

  if (fail.length > 0) {
    const codeHist = {};
    for (const f of fail) codeHist[f.code] = (codeHist[f.code] || 0) + 1;
    console.log('\n  Failure codes:');
    for (const [code, n] of Object.entries(codeHist).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${code.padEnd(40)} ${n}`);
    }
    console.log('\n  Sample failures:');
    for (const f of fail.slice(0, 3)) {
      console.log(`    [${f.team}] ${f.code}: ${f.message}`);
    }
  }

  // The sharded path aggregates via an async trigger. Poll the round doc
  // for up to 8s to let the trigger drain its queue before validating.
  let topBids = {};
  let lastTopBidsJson = '';
  const drainDeadline = Date.now() + 8000;
  while (Date.now() < drainDeadline) {
    const roundDoc = await db.doc(`games/${args.gameId}/rounds/round_1`).get();
    topBids = roundDoc.exists ? (roundDoc.data().topBids || {}) : {};
    const json = JSON.stringify(topBids);
    if (json === lastTopBidsJson && json !== '{}') break;
    lastTopBidsJson = json;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('\n  Final rounds/round_1.topBids.ad:');
  console.log(`    ${JSON.stringify(topBids.ad || {}, null, 2).split('\n').join('\n    ')}`);

  // What we expect: highest bid per surface should match the highest amount
  // in our task list for that surface.
  const expectedTop = { TV: 0, Billboard: 0, Radio: 0, Newspaper: 0 };
  for (const r of ok) {
    if (r.amount > (expectedTop[r.surface] || 0)) expectedTop[r.surface] = r.amount;
  }
  console.log('\n  Expected top bid per surface (from successful submissions):');
  console.log(`    ${JSON.stringify(expectedTop, null, 2).split('\n').join('\n    ')}`);

  let topBidsCorrect = true;
  for (const surface of AD_SURFACES) {
    const actual = (topBids.ad && topBids.ad[surface]) || 0;
    if (actual !== expectedTop[surface]) {
      topBidsCorrect = false;
      console.log(`  ⚠️  topBids.ad.${surface} = ${actual} but expected ${expectedTop[surface]}`);
    }
  }
  console.log(`\n  topBids consistent with successful submissions: ${topBidsCorrect ? 'YES ✅' : 'NO ❌ (race condition)'}`);

  console.log('══════════════════════════════════════════════════\n');

  process.exit(fail.length > 0 || !topBidsCorrect ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[loadtest] FATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(2);
  });
}
