#!/usr/bin/env node
/**
 * Bakery Bash — Game State Snapshot
 *
 * Dumps the entire Firestore state for a single game to a JSON file.
 * Use this between rounds (or on a watcher) so a session can be restored
 * if the game crashes mid-class.
 *
 * Usage:
 *   node scripts/snapshot-game.js <gameId>                  # emulator (default)
 *   node scripts/snapshot-game.js <gameId> --prod           # production Firestore
 *   node scripts/snapshot-game.js <gameId> --out ./mydir    # custom output dir
 *
 * Output: ./snapshots/<gameId>/snap_round{N}_{phase}_{ISO-ts}.json
 *
 * Safety:
 *   - Read-only. Cannot mutate the game.
 *   - Production access requires GOOGLE_APPLICATION_CREDENTIALS env or
 *     a default service-account login (gcloud auth application-default login).
 */

const fs = require('fs');
const path = require('path');
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// T2.4: serialize / dumpDoc / dumpCollection / countDocs all live in the
// shared module now so the CLI and the server-side `createSnapshot`
// callable share one implementation. NON_SNAPSHOTTED_SUBCOLLECTIONS keeps
// CLI and server in sync on which live-state subcollections to skip
// (snapshots: avoid quadratic embedding; presence: avoid stale liveness).
const {
  serialize,
  dumpDoc,
  dumpCollection,
  countDocs,
  NON_SNAPSHOTTED_SUBCOLLECTIONS,
} = require('../functions/modules/snapshot');

const PROJECT_ID = 'bakery-bash-54d12';

function parseArgs(argv) {
  const args = { gameId: null, prod: false, outDir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prod') args.prod = true;
    else if (a === '--out') args.outDir = argv[++i];
    else if (!a.startsWith('--')) args.gameId = a;
  }
  return args;
}

function configureFirebase(prod) {
  if (prod) {
    delete process.env.FIRESTORE_EMULATOR_HOST;
    initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() });
    console.log(`[snapshot] target = PRODUCTION (${PROJECT_ID})`);
  } else {
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    initializeApp({ projectId: PROJECT_ID });
    console.log(`[snapshot] target = emulator @ ${process.env.FIRESTORE_EMULATOR_HOST}`);
  }
  return getFirestore();
}

async function snapshotGame(db, gameId) {
  const start = Date.now();
  const gameRef = db.collection('games').doc(gameId);
  // Match the server callable: skip live-state subcollections so the JSON
  // file doesn't embed prior chunked snapshots and doesn't carry stale
  // presence pings that `restore-game.js --clean` would write back.
  const dump = await dumpDoc(gameRef, {
    excludeSubcollections: NON_SNAPSHOTTED_SUBCOLLECTIONS,
  });
  if (!dump.exists) {
    throw new Error(`Game ${gameId} does not exist.`);
  }
  const elapsed = Date.now() - start;
  return { dump, elapsed };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.gameId) {
    console.error('Usage: node scripts/snapshot-game.js <gameId> [--prod] [--out <dir>]');
    process.exit(1);
  }

  const db = configureFirebase(args.prod);

  const { dump, elapsed } = await snapshotGame(db, args.gameId);
  const round = (dump.data && (dump.data.round || dump.data.currentRound)) || 0;
  const phase = (dump.data && dump.data.phase) || 'unknown';
  const totalDocs = countDocs(dump);

  const outDir = args.outDir || path.resolve(process.cwd(), 'snapshots', args.gameId);
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `snap_round${round}_${phase}_${ts}.json`;
  const filepath = path.join(outDir, filename);

  const envelope = {
    schemaVersion: 1,
    gameId: args.gameId,
    capturedAt: new Date().toISOString(),
    sourceTarget: args.prod ? 'production' : 'emulator',
    round,
    phase,
    totalDocs,
    elapsedMs: elapsed,
    game: dump,
  };

  fs.writeFileSync(filepath, JSON.stringify(envelope, null, 2));
  const sizeKb = (fs.statSync(filepath).size / 1024).toFixed(1);

  // Update "latest" pointer for easy restore
  const latestPath = path.join(outDir, 'latest.json');
  try { fs.unlinkSync(latestPath); } catch (_) {}
  fs.writeFileSync(latestPath, JSON.stringify({ file: filename, ...envelope }, null, 2));

  console.log(`[snapshot] OK round=${round} phase=${phase} docs=${totalDocs} ${sizeKb}KB ${elapsed}ms`);
  console.log(`[snapshot] wrote ${filepath}`);
  console.log(`[snapshot] latest pointer ${latestPath}`);

  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[snapshot] FAILED: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { snapshotGame, serialize, dumpDoc, dumpCollection };
