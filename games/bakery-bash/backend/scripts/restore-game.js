#!/usr/bin/env node
/**
 * Bakery Bash — Restore Game From Snapshot
 *
 * Re-creates the entire Firestore state of a single game from a JSON file
 * produced by snapshot-game.js or watch-and-snapshot.js.
 *
 * Usage:
 *   node scripts/restore-game.js <snapshot-file>                  # emulator (default)
 *   node scripts/restore-game.js <snapshot-file> --prod           # production
 *   node scripts/restore-game.js <snapshot-file> --target-id NEW  # restore to a different game id
 *   node scripts/restore-game.js <snapshot-file> --pause-on-restore  # set paused=true on the restored game
 *   node scripts/restore-game.js <snapshot-file> --clean          # delete live docs not present in the snapshot
 *   node scripts/restore-game.js <snapshot-file> --yes            # skip confirmation prompt
 *
 * Safety:
 *   - Writes to PRODUCTION require a typed confirmation ("RESTORE <gameId>").
 *   - --pause-on-restore is recommended for live recovery: it stops the timer
 *     and prevents a phase transition fight while you tell players to refresh.
 *
 * What it does:
 *   1. Validates the snapshot file (schemaVersion, gameId).
 *   2. Sets every doc in the snapshot using batched writes (450/batch).
 *   3. With --clean: lists every existing doc under the target game and
 *      deletes any path not in the snapshot before writing. This is what
 *      you want for a true session rollback (kills new players who joined
 *      after the snapshot, kills round N+1 decisions written after the
 *      snapshot, etc.).
 *
 * Limits:
 *   - Anonymous Firebase Auth UIDs persist client-side, so existing players
 *     auto-reconnect to their player docs after the restore lands.
 *   - In-flight writes during restore can race the batched writes. Always
 *     pass --pause-on-restore unless you know nobody is mid-action.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, Timestamp, GeoPoint } = require('firebase-admin/firestore');

const PROJECT_ID = 'bakery-bash-54d12';
const BATCH_SIZE = 450; // Firestore hard limit is 500 ops/batch

function parseArgs(argv) {
  const args = {
    file: null, prod: false, targetId: null, pauseOnRestore: false, yes: false, clean: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prod') args.prod = true;
    else if (a === '--target-id') args.targetId = argv[++i];
    else if (a === '--pause-on-restore') args.pauseOnRestore = true;
    else if (a === '--clean') args.clean = true;
    else if (a === '--yes') args.yes = true;
    else if (!a.startsWith('--')) args.file = a;
  }
  return args;
}

async function listAllDocPaths(db, rootDocRef) {
  const paths = [];
  const visit = async (docRef) => {
    const snap = await docRef.get();
    if (snap.exists) paths.push(docRef.path);
    const colls = await docRef.listCollections();
    for (const coll of colls) {
      const docs = await coll.listDocuments();
      for (const d of docs) await visit(d);
    }
  };
  await visit(rootDocRef);
  return paths;
}

function configureFirebase(prod) {
  if (prod) {
    delete process.env.FIRESTORE_EMULATOR_HOST;
    initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() });
    console.log(`[restore] target = PRODUCTION (${PROJECT_ID})`);
  } else {
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    initializeApp({ projectId: PROJECT_ID });
    console.log(`[restore] target = emulator @ ${process.env.FIRESTORE_EMULATOR_HOST}`);
  }
  return getFirestore();
}

function deserialize(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(deserialize);
  if (typeof value === 'object') {
    if (value.__ts && typeof value.__ts.s === 'number') {
      return new Timestamp(value.__ts.s, value.__ts.n || 0);
    }
    if (value.__geo) return new GeoPoint(value.__geo.lat, value.__geo.lng);
    if (value.__ref) {
      throw new Error(`Snapshot contains DocumentReference (path=${value.__ref}); restore not supported.`);
    }
    const out = {};
    for (const k of Object.keys(value)) out[k] = deserialize(value[k]);
    return out;
  }
  return value;
}

function* walkDocs(docNode, parentPath) {
  if (!docNode || !docNode.exists) return;
  const docPath = parentPath
    ? `${parentPath}/${docNode.id}`
    : `games/${docNode.id}`;
  yield { path: docPath, data: docNode.data };
  if (!docNode.subcollections) return;
  for (const [collName, docs] of Object.entries(docNode.subcollections)) {
    for (const d of docs) {
      yield* walkDocs(d, `${docPath}/${collName}`);
    }
  }
}

function rewriteRootGameId(docPath, originalId, newId) {
  if (!newId || originalId === newId) return docPath;
  // Replace only the leading "games/<originalId>" segment.
  return docPath.replace(new RegExp(`^games/${originalId}(/|$)`), `games/${newId}$1`);
}

async function confirmInteractively(prompt, expected) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(prompt, res));
  rl.close();
  return answer.trim() === expected;
}

async function restore(db, snapshot, opts) {
  const originalId = snapshot.gameId;
  const targetId = opts.targetId || originalId;

  const root = snapshot.game;
  if (!root || !root.exists) throw new Error('Snapshot game document is empty.');

  const docs = [];
  for (const docInfo of walkDocs(root, null)) {
    const finalPath = rewriteRootGameId(docInfo.path, originalId, targetId);
    let data = deserialize(docInfo.data);

    if (finalPath === `games/${targetId}` && opts.pauseOnRestore) {
      data = { ...data, paused: true };
    }
    if (finalPath === `games/${targetId}` && opts.targetId) {
      data = { ...data };
    }
    docs.push({ path: finalPath, data });
  }

  console.log(`[restore] gameId=${targetId} (from snapshot ${originalId})`);
  console.log(`[restore] ${docs.length} documents to write`);
  if (opts.pauseOnRestore) console.log(`[restore] will set paused=true on game root`);

  if (opts.clean) {
    console.log(`[restore] --clean: scanning live game for orphans…`);
    const livePaths = await listAllDocPaths(db, db.collection('games').doc(targetId));
    const snapshotPathSet = new Set(docs.map((d) => d.path));
    const orphans = livePaths.filter((p) => !snapshotPathSet.has(p));
    console.log(`[restore] --clean: ${orphans.length} orphan doc(s) to delete`);
    let deleted = 0;
    let dBatch = db.batch();
    let dInBatch = 0;
    for (const p of orphans) {
      dBatch.delete(db.doc(p));
      dInBatch++;
      if (dInBatch >= BATCH_SIZE) {
        await dBatch.commit();
        deleted += dInBatch;
        console.log(`[restore]   deleted ${deleted}/${orphans.length}`);
        dBatch = db.batch();
        dInBatch = 0;
      }
    }
    if (dInBatch > 0) {
      await dBatch.commit();
      deleted += dInBatch;
    }
    if (orphans.length > 0) console.log(`[restore]   deleted ${deleted}/${orphans.length}`);
  }

  let written = 0;
  let batch = db.batch();
  let inBatch = 0;
  for (const doc of docs) {
    batch.set(db.doc(doc.path), doc.data);
    inBatch++;
    if (inBatch >= BATCH_SIZE) {
      await batch.commit();
      written += inBatch;
      console.log(`[restore]   wrote ${written}/${docs.length}`);
      batch = db.batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) {
    await batch.commit();
    written += inBatch;
  }
  console.log(`[restore] DONE wrote=${written}`);
  return { written };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('Usage: node scripts/restore-game.js <snapshot-file> [--prod] [--target-id NEW] [--pause-on-restore] [--yes]');
    process.exit(1);
  }

  const filepath = path.resolve(args.file);
  if (!fs.existsSync(filepath)) {
    console.error(`[restore] file not found: ${filepath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(filepath, 'utf8');
  let snapshot;
  try { snapshot = JSON.parse(raw); }
  catch (e) {
    console.error(`[restore] invalid JSON: ${e.message}`);
    process.exit(1);
  }
  if (snapshot.schemaVersion !== 1) {
    console.error(`[restore] unsupported schemaVersion: ${snapshot.schemaVersion}`);
    process.exit(1);
  }
  if (!snapshot.gameId) {
    console.error('[restore] snapshot missing gameId');
    process.exit(1);
  }

  const targetId = args.targetId || snapshot.gameId;
  console.log(`[restore] file       = ${filepath}`);
  console.log(`[restore] capturedAt = ${snapshot.capturedAt}`);
  console.log(`[restore] sourceTarget = ${snapshot.sourceTarget}`);
  console.log(`[restore] round/phase = ${snapshot.round} / ${snapshot.phase}`);

  if (args.prod && !args.yes) {
    const expected = `RESTORE ${targetId}`;
    const ok = await confirmInteractively(
      `\n⚠️  About to OVERWRITE production game "${targetId}".\n   Type exactly "${expected}" to proceed: `,
      expected,
    );
    if (!ok) {
      console.error('[restore] confirmation failed; aborting.');
      process.exit(1);
    }
  }

  const db = configureFirebase(args.prod);
  await restore(db, snapshot, {
    targetId: args.targetId,
    pauseOnRestore: args.pauseOnRestore,
    clean: args.clean,
  });

  console.log(`[restore] complete. Tell players to refresh their browser.`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[restore] FATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { restore, deserialize, walkDocs };
