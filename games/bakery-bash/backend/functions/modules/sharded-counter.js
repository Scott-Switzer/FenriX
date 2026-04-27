/**
 * Sharded Submission Counter (T3.3)
 *
 * Replaces the single-doc `game.submittedCount: FieldValue.increment(1)`
 * write hot-spot with per-shard intake docs at
 * `games/{gameId}/submittedCountShards/round_{N}/shards/{shardIdx}`,
 * aggregated back to the game doc by `onSubmittedCountShardWritten`.
 *
 * Why
 * ───
 * Every `submitDecision` ran a transactional `FieldValue.increment(1)`
 * on the same game doc. Atomic increments don't require a read but are
 * still bounded by Firestore's per-document write throttle (~1 sustained
 * write/sec). With 25–70 students hitting submit in the same window,
 * this is the next contention point after PR #98's auction sharding.
 *
 * Design
 * ──────
 * - Per-uid record: writes `{ uids: { [uid]: true } }` into the player's
 *   assigned shard. Same uid writing twice yields the same key — naturally
 *   idempotent, so a retry doesn't double-count.
 * - Per-round partitioning: shards live under `round_{N}` so the count
 *   resets implicitly at round transitions (no shard wipe needed; the
 *   aggregator just reads the new round's shards, which start empty).
 * - Aggregator: takes the round from the triggering shard's path (not
 *   `game.currentRound`), counts distinct uids, writes to
 *   `game.submittedCount`. Skips the write when unchanged. Using the
 *   path's round avoids a cross-round race where a late shard write from
 *   round N, fired after the game has advanced to N+1, would otherwise
 *   overwrite the new round's count with N+1's empty shards. Matches
 *   PR #98's `recomputeAndCacheTopBids(gameRef, round)` shape.
 *
 * Throughput
 * ──────────
 * With SHARD_COUNT = 10 and 25 submitters per round, each shard sees
 * ~2.5 contending writes — well under the per-doc cap.
 */

const { FieldValue } = require('firebase-admin/firestore');
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

function shardCollectionRef(gameRef, roundDocId) {
  return gameRef
    .collection('submittedCountShards')
    .doc(roundDocId)
    .collection('shards');
}

function shardDocRef(gameRef, roundDocId, shardIdx) {
  return shardCollectionRef(gameRef, roundDocId).doc(String(shardIdx));
}

/**
 * Write one player's uid into their assigned shard for the given round.
 * Uses `set({ merge: true })` so multiple uids in the same shard merge
 * cleanly. Same uid writing twice updates the same key — no double-count.
 */
async function writeUidToSubmittedCountShard(gameRef, roundDocId, uid) {
  if (!uid) throw new Error('writeUidToSubmittedCountShard: uid required');
  if (!roundDocId) throw new Error('writeUidToSubmittedCountShard: roundDocId required');
  const shardRef = shardDocRef(gameRef, roundDocId, pickShard(uid));
  await shardRef.set({
    uids: { [uid]: true },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * Read all shards for the given round and count distinct uids. The set of
 * uids is collected from the per-shard `uids` map keys.
 */
async function readAndCountSubmittedUids(gameRef, roundDocId) {
  const shardsSnap = await shardCollectionRef(gameRef, roundDocId).get();
  let count = 0;
  for (const shardDoc of shardsSnap.docs) {
    const data = shardDoc.data() || {};
    const uids = objectOrDefault(data.uids, {});
    count += Object.keys(uids).length;
  }
  return count;
}

/**
 * Aggregator: count distinct uids for `round` (the round number from the
 * triggering shard's path), write to `game.submittedCount` if it has
 * changed AND the game is still on that round. The currentRound guard
 * prevents a late-firing trigger from a previous round from clobbering
 * the freshly-zeroed count after `advancePhase`.
 *
 * Idempotent — safe to call concurrently with other instances. The trigger
 * uses `concurrency: 1` to serialise writes anyway.
 */
async function recomputeAndCacheSubmittedCount(gameRef, round) {
  if (!Number.isFinite(round) || round <= 0) return { changed: false };
  const gameSnap = await gameRef.get();
  if (!gameSnap.exists) return { changed: false };
  const game = gameSnap.data() || {};
  const currentRound = numberOrDefault(game.currentRound || game.round, 0);
  if (currentRound !== round) return { changed: false, skipped: 'stale-round' };
  const roundDocId = `round_${round}`;
  const count = await readAndCountSubmittedUids(gameRef, roundDocId);
  const existing = numberOrDefault(game.submittedCount, 0);
  if (count === existing) return { changed: false };
  await gameRef.update({
    submittedCount: count,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { changed: true, count };
}

module.exports = {
  SHARD_COUNT,
  pickShard,
  shardCollectionRef,
  shardDocRef,
  writeUidToSubmittedCountShard,
  readAndCountSubmittedUids,
  recomputeAndCacheSubmittedCount,
};
