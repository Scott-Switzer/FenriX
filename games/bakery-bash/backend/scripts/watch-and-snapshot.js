#!/usr/bin/env node
/**
 * Bakery Bash — Watch & Snapshot
 *
 * Subscribes to a game's root document and writes a full snapshot every
 * time the game advances rounds or phases. Run this in a terminal next to
 * a live session so you always have a recent restore point if the game
 * crashes mid-class.
 *
 * Usage:
 *   node scripts/watch-and-snapshot.js <gameId>                # emulator
 *   node scripts/watch-and-snapshot.js <gameId> --prod         # production
 *   node scripts/watch-and-snapshot.js <gameId> --out ./mydir  # custom output
 *   node scripts/watch-and-snapshot.js <gameId> --on phase     # snapshot per phase change (default: per round change)
 *
 * Behaviour:
 *   - Snapshots once on startup so you have an immediate baseline.
 *   - Then snapshots whenever (round) — or (round, phase) with --on phase
 *     — changes from the previous value.
 *   - Debounces 1.5s after a change in case multiple fields update together.
 *   - Logs each snapshot path to stdout. Ctrl+C to stop.
 */

const path = require('path');
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { snapshotGame } = require('./snapshot-game.js');

const PROJECT_ID = 'bakery-bash-54d12';

function parseArgs(argv) {
  const args = { gameId: null, prod: false, outDir: null, on: 'round' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prod') args.prod = true;
    else if (a === '--out') args.outDir = argv[++i];
    else if (a === '--on') args.on = argv[++i];
    else if (!a.startsWith('--')) args.gameId = a;
  }
  return args;
}

function configureFirebase(prod) {
  if (prod) {
    delete process.env.FIRESTORE_EMULATOR_HOST;
    initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() });
    console.log(`[watch] target = PRODUCTION (${PROJECT_ID})`);
  } else {
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    initializeApp({ projectId: PROJECT_ID });
    console.log(`[watch] target = emulator @ ${process.env.FIRESTORE_EMULATOR_HOST}`);
  }
  return getFirestore();
}

const fs = require('fs');

async function takeSnapshot(db, gameId, outDir, label) {
  try {
    const start = Date.now();
    const { dump, elapsed } = await snapshotGame(db, gameId);
    const round = (dump.data && (dump.data.round || dump.data.currentRound)) || 0;
    const phase = (dump.data && dump.data.phase) || 'unknown';

    const dir = outDir || path.resolve(process.cwd(), 'snapshots', gameId);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `snap_round${round}_${phase}_${ts}.json`;
    const filepath = path.join(dir, filename);

    const envelope = {
      schemaVersion: 1,
      gameId,
      capturedAt: new Date().toISOString(),
      sourceTarget: process.env.FIRESTORE_EMULATOR_HOST ? 'emulator' : 'production',
      round,
      phase,
      reason: label,
      elapsedMs: elapsed,
      game: dump,
    };

    fs.writeFileSync(filepath, JSON.stringify(envelope, null, 2));
    const latestPath = path.join(dir, 'latest.json');
    try { fs.unlinkSync(latestPath); } catch (_) {}
    fs.writeFileSync(latestPath, JSON.stringify({ file: filename, ...envelope }, null, 2));

    const sizeKb = (fs.statSync(filepath).size / 1024).toFixed(1);
    const totalMs = Date.now() - start;
    console.log(`[watch] ${label.padEnd(8)} round=${round} phase=${phase.padEnd(20)} ${sizeKb.padStart(6)}KB ${totalMs}ms → ${filename}`);
    return { round, phase };
  } catch (err) {
    console.error(`[watch] snapshot FAILED (${label}): ${err.message}`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.gameId) {
    console.error('Usage: node scripts/watch-and-snapshot.js <gameId> [--prod] [--out <dir>] [--on round|phase]');
    process.exit(1);
  }
  if (!['round', 'phase'].includes(args.on)) {
    console.error(`--on must be 'round' or 'phase' (got '${args.on}')`);
    process.exit(1);
  }

  const db = configureFirebase(args.prod);
  const gameRef = db.collection('games').doc(args.gameId);

  const exists = await gameRef.get();
  if (!exists.exists) {
    console.error(`[watch] Game ${args.gameId} does not exist.`);
    process.exit(1);
  }

  console.log(`[watch] watching game=${args.gameId} on=${args.on}`);
  await takeSnapshot(db, args.gameId, args.outDir, 'startup');

  let last = { round: null, phase: null };
  let pending = null;

  const unsubscribe = gameRef.onSnapshot(
    (snap) => {
      if (!snap.exists) return;
      const data = snap.data();
      const round = data.round || data.currentRound || 0;
      const phase = data.phase || 'unknown';

      const triggerKey = args.on === 'round' ? round : `${round}/${phase}`;
      const lastKey = args.on === 'round' ? last.round : `${last.round}/${last.phase}`;

      if (triggerKey === lastKey) return;
      if (last.round === null) {
        last = { round, phase };
        return;
      }

      const label = args.on === 'round' ? `r${round}` : `r${round}/${phase}`;
      if (pending) clearTimeout(pending);
      pending = setTimeout(async () => {
        await takeSnapshot(db, args.gameId, args.outDir, label);
        last = { round, phase };
        pending = null;
      }, 1500);
    },
    (err) => {
      console.error(`[watch] listener error: ${err.message}`);
    }
  );

  process.on('SIGINT', async () => {
    console.log('\n[watch] stopping…');
    unsubscribe();
    if (pending) {
      clearTimeout(pending);
      await takeSnapshot(db, args.gameId, args.outDir, 'shutdown');
    }
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[watch] FATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });
}
