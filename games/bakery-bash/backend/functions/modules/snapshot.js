/**
 * snapshot.js — Game-state capture/restore module (T2.4)
 *
 * Shared backbone for both:
 *  • CLI scripts (`scripts/snapshot-game.js`, `scripts/restore-game.js`)
 *    — operator tools that read/write local-disk JSON files
 *  • Server-side callables (`createSnapshot`, `restoreSnapshot` in
 *    `index.js`) and the auto-snapshot hook in `advanceGamePhase`
 *
 * Snapshots are stored entirely in Firestore (no Cloud Storage dependency)
 * by chunking the serialized JSON across `games/{gameId}/snapshots/{id}`
 * (index doc) and `games/{gameId}/snapshots/{id}/chunks/{N}` (payload
 * chunks). Each chunk stays comfortably under Firestore's 1 MiB doc cap.
 *
 * Storage layout
 * ──────────────
 *   games/{gameId}/snapshots/{snapshotId}
 *     {
 *       schemaVersion: 1,
 *       phase: 'round_3_email',
 *       round: 3,
 *       capturedAt: Timestamp,
 *       capturedByUid: 'uid_prof',
 *       capturedBy: 'auto' | 'manual',
 *       totalChunks: 2,
 *       totalBytes: 1234567,
 *       totalDocs: 312,
 *     }
 *   games/{gameId}/snapshots/{snapshotId}/chunks/{idx}
 *     { idx: 0, payload: '<base64-chunk>' }
 *
 * Restore is destructive — it (a) deletes any docs under the game that
 * are NOT in the snapshot ("clean"), and (b) writes every doc from the
 * snapshot. Always sets `paused: true` on the restored game so players
 * can't write into a half-restored state. Cap on safety: callers must
 * verify the requesting uid is the professor before invoking
 * restoreGameSnapshot.
 */

'use strict';

const { Timestamp, GeoPoint, FieldValue } = require('firebase-admin/firestore');

const SCHEMA_VERSION = 1;
const CHUNK_SIZE_BYTES = 800_000; // <1 MiB Firestore doc cap, with safety margin
const FIRESTORE_BATCH_OPS = 450; // hard limit is 500
const DEFAULT_MAX_SNAPSHOTS_PER_GAME = 20;
const DEFAULT_MAX_AGE_DAYS = 30;

// Subcollections that hold operational/live state and must NOT round-trip
// through snapshot capture or restore. `snapshots` would grow quadratically;
// `presence` is liveness pings whose stale `lastSeenAt` would lie to the
// professor's disconnect banner if restored.
const NON_SNAPSHOTTED_SUBCOLLECTIONS = ['snapshots', 'presence'];

// ---------------------------------------------------------------------------
// Serialization (lossless round-trip for Firestore-supported types)
// ---------------------------------------------------------------------------

// Duck-typed type checks. `instanceof Timestamp` would be cleaner, but the
// backend has two firebase-admin installs (backend/node_modules and
// backend/functions/node_modules) and a Timestamp from the "wrong" copy
// fails `instanceof` against the other copy's class. The Admin SDK stores
// Timestamps as `{ _seconds, _nanoseconds }` regardless of which copy
// produced them, and GeoPoints as `{ _latitude, _longitude }`, so we
// detect by shape instead.
function isTimestampLike(v) {
  return (
    typeof v === 'object' && v !== null &&
    (v instanceof Timestamp ||
      (typeof v._seconds === 'number' && typeof v._nanoseconds === 'number' &&
        v.constructor && v.constructor.name === 'Timestamp'))
  );
}

function isGeoPointLike(v) {
  return (
    typeof v === 'object' && v !== null &&
    typeof v._latitude === 'number' && typeof v._longitude === 'number'
  );
}

function serialize(value) {
  if (value === null || value === undefined) return value;
  if (isTimestampLike(value)) {
    const s = value._seconds ?? value.seconds;
    const n = value._nanoseconds ?? value.nanoseconds;
    return { __ts: { s, n } };
  }
  if (value instanceof Date) {
    return { __ts: { s: Math.floor(value.getTime() / 1000), n: (value.getTime() % 1000) * 1e6 } };
  }
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    if (isGeoPointLike(value)) {
      return { __geo: { lat: value._latitude, lng: value._longitude } };
    }
    if (value.path && typeof value.path === 'string' && value.firestore) {
      return { __ref: value.path };
    }
    const out = {};
    for (const k of Object.keys(value)) out[k] = serialize(value[k]);
    return out;
  }
  return value;
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

// ---------------------------------------------------------------------------
// Recursive Firestore dump
// ---------------------------------------------------------------------------

async function dumpDoc(docRef, opts) {
  const exclude = (opts && opts.excludeSubcollections) || null;
  const snap = await docRef.get();
  const collections = await docRef.listCollections();
  const sub = {};
  for (const coll of collections) {
    if (exclude && exclude.includes(coll.id)) continue;
    sub[coll.id] = await dumpCollection(coll, opts);
  }
  return {
    id: snap.id,
    exists: snap.exists,
    data: snap.exists ? serialize(snap.data()) : null,
    subcollections: Object.keys(sub).length ? sub : undefined,
  };
}

async function dumpCollection(collRef, opts) {
  const snap = await collRef.get();
  const docs = [];
  for (const d of snap.docs) {
    docs.push(await dumpDoc(d.ref, opts));
  }
  return docs;
}

function countDocs(node) {
  let n = node && node.exists ? 1 : 0;
  if (!node || !node.subcollections) return n;
  for (const coll of Object.values(node.subcollections)) {
    for (const d of coll) n += countDocs(d);
  }
  return n;
}

/**
 * Walk the dumped game tree and yield { path, data } for each existing
 * doc, suitable for batched writes. The `parentPath` arg is the top-level
 * "games/<id>" prefix — passing null derives it from the dumped root id.
 */
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

// ---------------------------------------------------------------------------
// Chunked store / load (server-side, Firestore-only)
// ---------------------------------------------------------------------------

function chunkString(s, chunkSize = CHUNK_SIZE_BYTES) {
  const chunks = [];
  for (let i = 0; i < s.length; i += chunkSize) {
    chunks.push(s.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Capture the entire game state and write it as a chunked snapshot under
 * `games/{gameId}/snapshots/{snapshotId}`.
 *
 * Returns:
 *   { snapshotId, totalChunks, totalBytes, totalDocs, round, phase, elapsedMs }
 */
async function captureGameSnapshot(db, gameRef, opts) {
  const { capturedByUid, capturedBy } = opts || {};
  if (!capturedBy || !['auto', 'manual'].includes(capturedBy)) {
    throw new Error("captureGameSnapshot: opts.capturedBy must be 'auto' or 'manual'");
  }

  const start = Date.now();
  const dump = await dumpDoc(gameRef, {
    excludeSubcollections: NON_SNAPSHOTTED_SUBCOLLECTIONS,
  });
  if (!dump.exists) {
    throw new Error(`captureGameSnapshot: game ${gameRef.id} does not exist`);
  }

  const round = (dump.data && (dump.data.round || dump.data.currentRound)) || 0;
  const phase = (dump.data && dump.data.phase) || 'unknown';
  const totalDocs = countDocs(dump);

  // Serialize the dump as JSON, then split into Firestore-safe chunks. We
  // chunk the JSON STRING (not the object) so reassembly is just string
  // concatenation. Each chunk stays well under Firestore's 1 MiB doc cap.
  const json = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    gameId: gameRef.id,
    game: dump,
  });
  const totalBytes = Buffer.byteLength(json, 'utf8');
  const chunks = chunkString(json);

  const snapshotId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const indexRef = gameRef.collection('snapshots').doc(snapshotId);
  const chunksColl = indexRef.collection('chunks');

  // Write chunks first so a partial failure leaves no readable index.
  let batch = db.batch();
  let inBatch = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    batch.set(chunksColl.doc(String(i)), { idx: i, payload: chunks[i] });
    inBatch += 1;
    if (inBatch >= FIRESTORE_BATCH_OPS) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) await batch.commit();

  // Now the index doc (the existence of which is the readable signal).
  await indexRef.set({
    schemaVersion: SCHEMA_VERSION,
    phase,
    round,
    capturedAt: FieldValue.serverTimestamp(),
    capturedByUid: capturedByUid || null,
    capturedBy,
    totalChunks: chunks.length,
    totalBytes,
    totalDocs,
  });

  return {
    snapshotId,
    totalChunks: chunks.length,
    totalBytes,
    totalDocs,
    round,
    phase,
    elapsedMs: Date.now() - start,
  };
}

/**
 * Read a chunked snapshot back into the in-memory snapshot envelope shape.
 *
 * Returns the parsed object: { schemaVersion, gameId, game: <dumpDoc tree> }
 */
async function loadSnapshot(gameRef, snapshotId) {
  const indexRef = gameRef.collection('snapshots').doc(snapshotId);
  const indexSnap = await indexRef.get();
  if (!indexSnap.exists) {
    throw new Error(`loadSnapshot: snapshot ${snapshotId} not found`);
  }
  const index = indexSnap.data() || {};
  if (index.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`loadSnapshot: unsupported schemaVersion ${index.schemaVersion}`);
  }

  const chunksSnap = await indexRef.collection('chunks').get();
  // Sort by idx to handle the case where Firestore returns docs out of order.
  const sorted = chunksSnap.docs
    .map((d) => d.data() || {})
    .sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
  if (sorted.length !== index.totalChunks) {
    throw new Error(
      `loadSnapshot: expected ${index.totalChunks} chunks, found ${sorted.length}`,
    );
  }
  const json = sorted.map((c) => c.payload || '').join('');
  return JSON.parse(json);
}

/**
 * List every existing doc path under a game root, used by the restore
 * "clean" pass to find drift docs that need to be deleted.
 *
 * Skips `NON_SNAPSHOTTED_SUBCOLLECTIONS` so the cleanup pass mirrors the
 * capture: the in-progress restore doesn't delete the very snapshot it's
 * restoring from, and live presence pings (which were never captured)
 * aren't wiped out from under the players who are still pinging.
 */
async function listLiveDocPathsForCleanup(rootDocRef) {
  const paths = [];
  const skip = new Set(NON_SNAPSHOTTED_SUBCOLLECTIONS);
  const visit = async (docRef, isUnderSkipped) => {
    if (isUnderSkipped) return;
    const snap = await docRef.get();
    if (snap.exists) paths.push(docRef.path);
    const colls = await docRef.listCollections();
    for (const coll of colls) {
      const childIsSkipped = isUnderSkipped || skip.has(coll.id);
      const docs = await coll.listDocuments();
      for (const d of docs) await visit(d, childIsSkipped);
    }
  };
  await visit(rootDocRef, false);
  return paths;
}

/**
 * Restore a chunked snapshot into the live game. ALWAYS pauses the game
 * (`paused: true`) and ALWAYS does the "clean" pass that drops drift
 * docs (new players who joined after the snapshot, decisions written
 * after it, etc.). These two safety defaults match the "true session
 * rollback" use case described in the scaling plan.
 *
 * Returns:
 *   { written, deleted, snapshotId, round, phase }
 */
async function restoreGameSnapshot(db, gameRef, snapshotId) {
  const envelope = await loadSnapshot(gameRef, snapshotId);
  const root = envelope.game;
  if (!root || !root.exists) {
    throw new Error('restoreGameSnapshot: snapshot game document is empty');
  }

  // Walk the snapshot to build the write list.
  const docs = [];
  for (const docInfo of walkDocs(root, null)) {
    // Rewrite the leading "games/<originalId>" prefix to match the live
    // gameRef in case the snapshot was captured for a different gameId
    // (we never do this on the server, but it's free safety).
    const finalPath = docInfo.path.replace(
      /^games\/[^/]+(\/|$)/,
      `games/${gameRef.id}$1`,
    );
    let data = deserialize(docInfo.data);
    if (finalPath === `games/${gameRef.id}`) {
      // Always pause-on-restore. Players still see the previous state until
      // they refresh, and the paused flag prevents a phase auto-advance from
      // racing the restore mid-write.
      data = { ...data, paused: true };
    }
    docs.push({ path: finalPath, data });
  }

  // "Clean" pass — find live docs not in the snapshot and delete them.
  // Subcollections in NON_SNAPSHOTTED_SUBCOLLECTIONS (snapshots, presence)
  // are excluded both here and from the capture, so the restore doesn't
  // wipe its own snapshots or live liveness pings.
  const livePaths = await listLiveDocPathsForCleanup(gameRef);
  const snapshotPathSet = new Set(docs.map((d) => d.path));
  const orphans = livePaths.filter((p) => !snapshotPathSet.has(p));

  let deleted = 0;
  let dBatch = db.batch();
  let dInBatch = 0;
  for (const p of orphans) {
    dBatch.delete(db.doc(p));
    dInBatch += 1;
    if (dInBatch >= FIRESTORE_BATCH_OPS) {
      await dBatch.commit();
      deleted += dInBatch;
      dBatch = db.batch();
      dInBatch = 0;
    }
  }
  if (dInBatch > 0) {
    await dBatch.commit();
    deleted += dInBatch;
  }

  // Write pass.
  let written = 0;
  let batch = db.batch();
  let inBatch = 0;
  for (const doc of docs) {
    batch.set(db.doc(doc.path), doc.data);
    inBatch += 1;
    if (inBatch >= FIRESTORE_BATCH_OPS) {
      await batch.commit();
      written += inBatch;
      batch = db.batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) {
    await batch.commit();
    written += inBatch;
  }

  // Pull metadata for the return value (round/phase from the index doc).
  const indexSnap = await gameRef.collection('snapshots').doc(snapshotId).get();
  const idx = indexSnap.exists ? indexSnap.data() : {};

  return {
    written,
    deleted,
    snapshotId,
    round: idx.round || 0,
    phase: idx.phase || 'unknown',
  };
}

/**
 * Retention sweep: keep at most `maxKeep` snapshots per game and drop
 * any older than `maxAgeDays`. Index docs and their chunk subcollections
 * are deleted together. Best-effort — never throws.
 */
async function pruneOldSnapshots(db, gameRef, opts) {
  const { maxKeep = DEFAULT_MAX_SNAPSHOTS_PER_GAME, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = opts || {};
  try {
    const snap = await gameRef.collection('snapshots').get();
    const items = snap.docs.map((d) => ({
      ref: d.ref,
      capturedAt: d.get('capturedAt'),
      capturedAtMs:
        d.get('capturedAt') instanceof Timestamp
          ? d.get('capturedAt').toMillis()
          : 0,
    }));
    items.sort((a, b) => b.capturedAtMs - a.capturedAtMs); // newest first

    const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const toDelete = items.filter((it, i) => i >= maxKeep || it.capturedAtMs < cutoffMs);

    let pruned = 0;
    for (const it of toDelete) {
      await db.recursiveDelete(it.ref);
      pruned += 1;
    }
    return { pruned };
  } catch (err) {
    return { pruned: 0, error: err && err.message };
  }
}

module.exports = {
  SCHEMA_VERSION,
  CHUNK_SIZE_BYTES,
  FIRESTORE_BATCH_OPS,
  DEFAULT_MAX_SNAPSHOTS_PER_GAME,
  DEFAULT_MAX_AGE_DAYS,
  NON_SNAPSHOTTED_SUBCOLLECTIONS,
  serialize,
  deserialize,
  dumpDoc,
  dumpCollection,
  countDocs,
  walkDocs,
  captureGameSnapshot,
  loadSnapshot,
  listLiveDocPathsForCleanup,
  restoreGameSnapshot,
  pruneOldSnapshots,
};
