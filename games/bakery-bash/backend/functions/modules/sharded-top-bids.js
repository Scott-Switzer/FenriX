/**
 * Sharded Top Bids
 *
 * Replaces the single `rounds/{round}.topBids` document hot-spot with a fan-out
 * across SHARD_COUNT documents under `rounds/{round}/topBidsShards/{0..N-1}`.
 *
 * Why
 * ───
 * The auction phase has every team submit bids on the same ad surfaces and chef
 * pool. The previous implementation kept the live "current top bid per slot" on
 * a single `rounds/{round}` document and rewrote it via a transaction after
 * every `submitBids` call. With 25 teams contending on the same document,
 * Firestore's per-document write throughput cap caused 50%+ of writes to
 * stall past the 25 s transaction timeout, and a small fraction of failed
 * writes still mutated `topBids` (the `updateTopBids()` side-effect was non-
 * fatal but not idempotent), corrupting the displayed leader.
 *
 * Design
 * ──────
 * - Each team is mapped to a deterministic shard via `pickShard(teamKey)`.
 * - Every team writes only to their own (teamKey, slot) entry inside their
 *   shard. No two teams write to the same field path.
 * - Reads aggregate across all SHARD_COUNT shards to compute the global top
 *   bid per ad surface / chef.
 * - Auction RESOLUTION at end of phase still reads `players/{uid}/bids/{round}`
 *   directly (the source of truth) — the shards are an optimisation for the
 *   live UI feedback only.
 *
 * Throughput
 * ──────────
 * With SHARD_COUNT = 10 and 25 teams, each shard sees ~2.5 contending writes
 * per phase versus 25 on the legacy single-doc layout — well under Firestore's
 * sustained per-document write cap.
 */

const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { AD_TYPES, numberOrDefault, objectOrDefault } = require('./config');

const SHARD_COUNT = 10;

function pickShard(teamKey, shardCount = SHARD_COUNT) {
  const key = String(teamKey || '');
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % shardCount;
}

function shardCollectionRef(gameRef, round) {
  return gameRef
    .collection('rounds')
    .doc(`round_${round}`)
    .collection('topBidsShards');
}

function shardDocRef(gameRef, round, shardIdx) {
  return shardCollectionRef(gameRef, round).doc(String(shardIdx));
}

/**
 * Write a team's ad bids to their assigned shard. `bids` is the validated ad
 * bid object: { TV: number, Billboard: number, Radio: number, Newspaper: number }.
 *
 * Best-effort and non-transactional. Multiple writes to the same shard for
 * different teams target disjoint field paths and serialize cleanly under
 * Firestore's normal write semantics. A team's own re-submission overwrites
 * their previous entry in place.
 */
async function writeAdBidsToShard(gameRef, round, teamKey, bids) {
  if (!teamKey) throw new Error('writeAdBidsToShard: teamKey required');
  const shardRef = shardDocRef(gameRef, round, pickShard(teamKey));
  // Build a nested object so `set({ merge: true })` deep-merges into the
  // shard's existing { ad: { [adType]: { [teamKey]: amount } } } shape.
  // (Dotted keys at top level would be stored as literal field names —
  // Firestore only interprets dots as paths in `update()`, not `set()`.)
  const ad = {};
  for (const adType of AD_TYPES) {
    ad[adType] = { [teamKey]: numberOrDefault(bids[adType], 0) };
  }
  await shardRef.set({
    round,
    updatedAt: FieldValue.serverTimestamp(),
    ad,
    adSubmittedAt: { [teamKey]: Timestamp.now() },
  }, { merge: true });
}

/**
 * Write a team's chef bids to their assigned shard. `chefBids` is the
 * validated chef bid array: [{ chefId, amount }, ...].
 *
 * Any chef NOT in the array is treated as "no bid for this round" and the
 * shard entry for (chefId, teamKey) is left as-is. If a team replaces an
 * earlier chef bid with a smaller one, that's their explicit intent and the
 * shard records the latest amount.
 */
async function writeChefBidsToShard(gameRef, round, teamKey, chefBids) {
  if (!teamKey) throw new Error('writeChefBidsToShard: teamKey required');
  const shardRef = shardDocRef(gameRef, round, pickShard(teamKey));
  // Same nesting pattern as writeAdBidsToShard — see comment there.
  const chef = {};
  if (Array.isArray(chefBids)) {
    for (const bid of chefBids) {
      if (!bid || !bid.chefId) continue;
      chef[bid.chefId] = { [teamKey]: numberOrDefault(bid.amount, 0) };
    }
  }
  await shardRef.set({
    round,
    updatedAt: FieldValue.serverTimestamp(),
    chef,
    chefSubmittedAt: { [teamKey]: Timestamp.now() },
  }, { merge: true });
}

/**
 * Read every shard for a round and aggregate to the same shape the legacy
 * `rounds/{round}.topBids` field provided:
 *   {
 *     ad:           { [adType]:    topAmount  },
 *     adLeader:     { [adType]:    teamKey    },
 *     chef:         { [chefId]:    topAmount  },
 *     chefLeader:   { [chefId]:    teamKey    },
 *   }
 *
 * Tie-break on equal amounts: earlier `*SubmittedAt` wins (matches the legacy
 * behaviour from `updateTopBids` and `resolveAndApplyAdAuction`).
 */
async function readAndAggregateTopBids(gameRef, round) {
  const snap = await shardCollectionRef(gameRef, round).get();
  return aggregateShardData(snap.docs.map((d) => d.data() || {}));
}

function aggregateShardData(shards) {
  const ad = {};
  const adLeader = {};
  const adMillis = {};
  const chef = {};
  const chefLeader = {};
  const chefMillis = {};

  const submittedAtMillis = (ts) => {
    if (!ts) return Number.POSITIVE_INFINITY;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts._seconds === 'number') return ts._seconds * 1000;
    return Number.POSITIVE_INFINITY;
  };

  for (const shard of shards) {
    const adMap = objectOrDefault(shard.ad, {});
    const adAtMap = objectOrDefault(shard.adSubmittedAt, {});
    for (const adType of Object.keys(adMap)) {
      const teamMap = objectOrDefault(adMap[adType], {});
      for (const teamKey of Object.keys(teamMap)) {
        const amount = numberOrDefault(teamMap[teamKey], 0);
        if (amount <= 0) continue;
        const millis = submittedAtMillis(adAtMap[teamKey]);
        const cur = numberOrDefault(ad[adType], 0);
        const curMillis = adMillis[adType] != null ? adMillis[adType] : Number.POSITIVE_INFINITY;
        if (amount > cur || (amount === cur && millis < curMillis)) {
          ad[adType] = amount;
          adLeader[adType] = teamKey;
          adMillis[adType] = millis;
        }
      }
    }

    const chefMap = objectOrDefault(shard.chef, {});
    const chefAtMap = objectOrDefault(shard.chefSubmittedAt, {});
    for (const chefId of Object.keys(chefMap)) {
      const teamMap = objectOrDefault(chefMap[chefId], {});
      for (const teamKey of Object.keys(teamMap)) {
        const amount = numberOrDefault(teamMap[teamKey], 0);
        if (amount <= 0) continue;
        const millis = submittedAtMillis(chefAtMap[teamKey]);
        const cur = numberOrDefault(chef[chefId], 0);
        const curMillis = chefMillis[chefId] != null ? chefMillis[chefId] : Number.POSITIVE_INFINITY;
        if (amount > cur || (amount === cur && millis < curMillis)) {
          chef[chefId] = amount;
          chefLeader[chefId] = teamKey;
          chefMillis[chefId] = millis;
        }
      }
    }
  }

  return { ad, adLeader, chef, chefLeader };
}

/**
 * Read all shards, aggregate, and write the result to `rounds/{round}.topBids`
 * + `rounds/{round}.topBidsLeader` so the legacy frontend listener keeps
 * working without changes.
 *
 * This function is the bridge between the sharded write layer (per-shard doc,
 * low contention) and the public aggregate (single round doc).
 *
 * Concurrency: correctness-safe under concurrent calls — multiple invocations
 * read the same shard state, produce the same aggregate, and last-write-wins
 * under `set({ merge: true })` converges to the correct value. It is NOT
 * throughput-safe, however: concurrent invocations all write to the same
 * `rounds/{round}` doc and burn its per-document write budget, which is the
 * very contention this module exists to avoid. The `onTopBidsShardWritten`
 * trigger therefore runs with `concurrency: 1` to serialise these writes —
 * any new caller must do the same.
 *
 * Skips the write if the computed aggregate matches what's already on the
 * round doc, to avoid burning the round-doc write throughput on no-op updates.
 */
async function recomputeAndCacheTopBids(gameRef, round) {
  const aggregated = await readAndAggregateTopBids(gameRef, round);
  const roundRef = gameRef.collection('rounds').doc(`round_${round}`);
  const roundSnap = await roundRef.get();
  const existing = roundSnap.exists ? (roundSnap.data() || {}) : {};
  const existingTopBids = objectOrDefault(existing.topBids, {});
  const existingLeader = objectOrDefault(existing.topBidsLeader, {});

  const nextTopBids = { ad: aggregated.ad, chef: aggregated.chef };
  const nextLeader = { ad: aggregated.adLeader, chef: aggregated.chefLeader };

  if (deepEqualMap(existingTopBids, nextTopBids) && deepEqualMap(existingLeader, nextLeader)) {
    return { changed: false };
  }

  await roundRef.set({
    round,
    topBids: nextTopBids,
    topBidsLeader: nextLeader,
    topBidsUpdatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { changed: true };
}

function deepEqualMap(a, b) {
  const ak = Object.keys(a || {});
  const bk = Object.keys(b || {});
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    if (av && typeof av === 'object' && bv && typeof bv === 'object') {
      if (!deepEqualMap(av, bv)) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

module.exports = {
  SHARD_COUNT,
  pickShard,
  shardCollectionRef,
  shardDocRef,
  writeAdBidsToShard,
  writeChefBidsToShard,
  readAndAggregateTopBids,
  aggregateShardData,
  recomputeAndCacheTopBids,
};
