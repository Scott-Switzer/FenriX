/**
 * Sharded Submission Mirror
 *
 * Replaces the single `submissions/{docId}` + `submissionCounts/{docId}`
 * write hot-spots with per-shard intake docs at
 * `submissions/{docId}/shards/{0..N-1}` aggregated back to the public
 * docs by an `onSubmissionShardWritten` trigger.
 *
 * Why
 * ───
 * Every `submitDecision` / `submitBids` / `submitPrices` /
 * `continueFromRoster` call ran a transaction on the same
 * `submissions/{docId}` doc to add the player's entry, and another
 * transaction on the same `submissionCounts/{docId}` doc to bump the
 * count. With 25 teams in a synchronous "everyone submit" moment, both
 * docs hit Firestore's per-document write throughput cap and stalled.
 *
 * Design
 * ──────
 * - Each uid is mapped to a deterministic shard via `pickShard(uid)`.
 * - `writeSubmissionToShard()` writes the per-uid record into that
 *   shard's `perUid` map. No two uids ever target the same field.
 * - `recomputeAndCacheSubmissions()` reads all shards, merges the
 *   per-uid maps, and writes the merged map to the public
 *   `submissions/{docId}` doc plus a count to `submissionCounts/{docId}`.
 *   Skips both writes when the result hasn't changed.
 *
 * Throughput
 * ──────────
 * With SHARD_COUNT = 10 and 25 submitters, each shard sees ~2.5
 * contending writes per phase versus 25 on the legacy single-doc
 * layout — well under Firestore's sustained per-document write cap.
 */

const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { numberOrDefault, objectOrDefault } = require('./config');

const SHARD_COUNT = 10;

function pickShard(uid, shardCount = SHARD_COUNT) {
  const key = String(uid || '');
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % shardCount;
}

function shardCollectionRef(gameRef, submissionDocId) {
  return gameRef
    .collection('submissions')
    .doc(submissionDocId)
    .collection('shards');
}

function shardDocRef(gameRef, submissionDocId, shardIdx) {
  return shardCollectionRef(gameRef, submissionDocId).doc(String(shardIdx));
}

/**
 * Write one player's submission record into their assigned shard. Uses
 * `set({ merge: true })` with a nested object so multiple uids in the
 * same shard merge cleanly without overwriting each other's entries.
 */
async function writeSubmissionToShard(gameRef, submissionDocId, uid, displayName, role) {
  if (!uid) throw new Error('writeSubmissionToShard: uid required');
  const shardRef = shardDocRef(gameRef, submissionDocId, pickShard(uid));
  await shardRef.set({
    perUid: {
      [uid]: {
        status: 'submitted',
        submittedAt: Timestamp.now(),
        displayName: displayName || '',
        role: role || null,
      },
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * Read all shards under one submissionDocId and aggregate into the legacy
 * `submissions/{docId}` shape: { [uid]: { status, submittedAt, displayName, role } }.
 */
async function readAndAggregateSubmissions(gameRef, submissionDocId) {
  const shardsSnap = await shardCollectionRef(gameRef, submissionDocId).get();
  const merged = {};
  let count = 0;
  for (const shardDoc of shardsSnap.docs) {
    const data = shardDoc.data() || {};
    const perUid = objectOrDefault(data.perUid, {});
    for (const uid of Object.keys(perUid)) {
      merged[uid] = perUid[uid];
      count += 1;
    }
  }
  return { perUid: merged, count };
}

/**
 * Read the shards, aggregate, and (if changed) write the legacy public
 * docs that the FE / professor dashboard listen to.
 *
 * Idempotent — safe to call concurrently. Skips writes when the result
 * matches the current state, so a burst of N shard writes resolves to
 * ≤N aggregate writes (and usually far fewer once steady state is reached).
 */
async function recomputeAndCacheSubmissions(gameRef, submissionDocId) {
  const submissionRef = gameRef.collection('submissions').doc(submissionDocId);
  const countRef = gameRef.collection('submissionCounts').doc(submissionDocId);

  const [aggregated, submissionSnap, countSnap] = await Promise.all([
    readAndAggregateSubmissions(gameRef, submissionDocId),
    submissionRef.get(),
    countRef.get(),
  ]);

  const existingPerUid = submissionSnap.exists ? (submissionSnap.data() || {}) : {};
  const existingCount = countSnap.exists ? numberOrDefault(countSnap.data().count, 0) : 0;

  const submissionsChanged = !uidMapsEqual(existingPerUid, aggregated.perUid);
  const countChanged = aggregated.count !== existingCount;

  const writes = [];
  if (submissionsChanged) {
    // Use a plain `set` (no merge) so the document is rewritten exactly to
    // the aggregated shape — this drops uids that disappeared from shards
    // (e.g., an admin reset). Reset paths still wipe both docs explicitly.
    writes.push(submissionRef.set(aggregated.perUid));
  }
  if (countChanged) {
    writes.push(countRef.set({
      count: aggregated.count,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }));
  }
  if (writes.length === 0) return { changed: false };
  await Promise.all(writes);
  return { changed: true, submissionsChanged, countChanged };
}

function uidMapsEqual(a, b) {
  const ak = Object.keys(a || {});
  const bk = Object.keys(b || {});
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k] || {};
    const bv = b[k] || {};
    // Compare on the small handful of fields recordSubmission writes.
    if (av.status !== bv.status) return false;
    if ((av.displayName || '') !== (bv.displayName || '')) return false;
    if ((av.role || null) !== (bv.role || null)) return false;
  }
  return true;
}

module.exports = {
  SHARD_COUNT,
  pickShard,
  shardCollectionRef,
  shardDocRef,
  writeSubmissionToShard,
  readAndAggregateSubmissions,
  recomputeAndCacheSubmissions,
};
