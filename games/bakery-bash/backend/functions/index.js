/**
 * index.js — Firebase Cloud Functions entry point for the bakery game backend.
 *
 * This file owns Firebase orchestration (admin init, function exports,
 * Firestore client, auth checks). Domain modules (config, phases, chef-system,
 * satisfaction, customer-allocation, revenue, loan-shark, simulation,
 * csv-export, decision-validation, round-preferences, market-insight) are
 * pure JS and never import Firebase.
 *
 * Documented exception: `modules/sharded-top-bids.js` and
 * `modules/sharded-submissions.js` import `FieldValue` and `Timestamp` from
 * `firebase-admin/firestore` to construct write-time sentinels
 * (`serverTimestamp()`, `Timestamp.now()`). They take Firestore document refs
 * as arguments rather than initialising the SDK themselves, so they remain
 * unit-testable with a fake refs object.
 *
 * Preserved Firebase patterns from index-current.js:
 *   - Firebase admin init via getApps()/initializeApp()
 *   - onCall / onDocumentCreated exports
 *   - Firestore transactions for critical state transitions
 *   - Batched writes chunked at BATCH_OP_LIMIT = 487 for 150+ player games
 *   - HttpsError for all client-facing failures
 *   - Logger for server-side diagnostics
 */

// ---------------------------------------------------------------------------
// Firebase imports (only file that does this)
// ---------------------------------------------------------------------------

const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');

// Halve per-function CPU to fit the project's Cloud Run CPU quota.
// 256MiB memory + 0.5 CPU is plenty for these short-lived Firestore-bound
// callables, and avoids "total allowable CPU per project per region" deploy
// failures when many revisions are rolling at once.
setGlobalOptions({ cpu: 0.5 });

// Allow Firebase ID tokens (anonymous + real users) to invoke callables.
// Without this, Cloud Run blocks requests at the IAM layer before they
// reach the onCall handler, causing 401s instead of auth checks.
const CALLABLE_OPTS = { invoker: 'public' };

// Callables that fan out widely across the game tree (simulation, snapshot
// capture/restore, CSV exports across 70 players × 5 rounds) get a 2x
// safety margin over the Cloud Functions Gen 2 default of 60s. Phase
// advancement at 70 players runs simulation + chef-pool generation +
// auto-snapshot upload back-to-back, and a slow Firestore round-trip on
// the snapshot chunks could push the cumulative time past 60s. The
// remaining hot callables (`submitBids`, `submitDecision`, `submitPrices`,
// `joinGame`, `createTeam`) finish well under the default and stay there.
const HEAVY_CALLABLE_OPTS = { ...CALLABLE_OPTS, timeoutSeconds: 120 };

const { getApps, initializeApp } = require('firebase-admin/app');
const {
  FieldValue,
  Timestamp,
  getFirestore,
} = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();

// ---------------------------------------------------------------------------
// Pure-module imports
// ---------------------------------------------------------------------------

const {
  DEFAULT_GAME_CONFIG,
  AD_TYPES,
  CHEF_NATIONALITIES,
  DEFAULT_UNLOCKED_PRODUCTS,
  OPTIONAL_MENU,
  BASE_MENU,
  mergeConfig,
  numberOrDefault,
  objectOrDefault,
  cleanString,
} = require('./modules/config');

const {
  parsePhase,
  getNextPhase,
  getPhaseDuration,
  canSubmitDecision,
  canSubmitBids,
} = require('./modules/phases');

const {
  generateChefPool,
  resolveChefAuction,
} = require('./modules/chef-system');

const { runMonthlySimulation } = require('./modules/multi-day-simulation');

const {
  buildCsvString,
} = require('./modules/csv-export');

const {
  DEFAULT_STUCK_THRESHOLD_MS,
  diagnoseSimulationState,
} = require('./modules/recovery');

const {
  writeAdBidsToShard,
  writeChefBidsToShard,
  recomputeAndCacheTopBids,
} = require('./modules/sharded-top-bids');

const {
  writeSubmissionToShard,
  recomputeAndCacheSubmissions,
} = require('./modules/sharded-submissions');

const {
  writeUidToSubmittedCountShard,
  recomputeAndCacheSubmittedCount,
} = require('./modules/sharded-counter');

const {
  generateBotDecisions,
  PRESETS,
} = require('./modules/bot-engine');

const {
  captureGameSnapshot,
  restoreGameSnapshot,
  pruneOldSnapshots,
} = require('./modules/snapshot');

// The following modules are part of the full backend surface. They are
// required only where needed so that missing optional helpers do not break
// the lobby / decision / bid flows.
let decisionValidation = null;
let ValidationError = null;
try {
  decisionValidation = require('./modules/decision-validation');
  ValidationError = decisionValidation.ValidationError ?? null;
} catch (loadErr) {
  logger.error('decision-validation module failed to load — using passthrough fallback.', {
    error: loadErr && loadErr.message,
  });
  decisionValidation = {
    validateDecision: (d) => d,
    validateAdBids: (d) => d,
    validateChefBids: (d) => d,
    // Fail-closed: the real validator snaps to the $0.25 grid and clamps to
    // [floor, ceiling]. A passthrough fallback would let unsnapped/unclamped
    // prices reach Firestore and break resolvePriceForSim's contract, so we
    // refuse price submissions when the validation module is unavailable.
    validateProductPrices: () => {
      throw new HttpsError(
        'internal',
        'Price validation module unavailable; cannot validate prices.',
      );
    },
  };
}

let roundPreferencesModule = null;
try {
  roundPreferencesModule = require('./modules/round-preferences');
} catch (loadErr) {
  logger.error('round-preferences module failed to load — all rounds will have neutral modifiers.', {
    error: loadErr && loadErr.message,
  });
  roundPreferencesModule = {
    generateRoundPreferences: (totalRounds) =>
      Array.from({ length: totalRounds }, () => ({ modifiers: {} })),
  };
}

// market-insight functionality lives in round-preferences.js.
// We wrap it in the interface index.js expects: buildMarketInsightEmail({ round, preferences, config })
const marketInsightModule = {
  buildMarketInsightEmail: ({ round, preferences }) => {
    if (roundPreferencesModule && roundPreferencesModule.generateMarketInsightEmail) {
      return roundPreferencesModule.generateMarketInsightEmail(preferences || {});
    }
    return {
      round,
      subject: `Round ${round} market insight`,
      body: 'Market insight is unavailable this round.',
      from: 'The Plaza Times',
    };
  },
};

let conclusionModule = null;
try {
  conclusionModule = require('./modules/conclusion');
} catch (loadErr) {
  logger.error('conclusion module failed to load — using minimal rankings fallback.', {
    error: loadErr && loadErr.message,
  });
  conclusionModule = {
    computeConclusion: (results) => ({ rankings: results }),
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Firestore batched writes are capped at 500 ops. We leave 13 ops of headroom
 * for the 2 aggregate writes (round doc, leaderboard) appended to the final
 * batch, plus margin for any future additions.
 */
const BATCH_OP_LIMIT = 487;

/**
 * Batch-delete every document in a collection. Used by `resetGame` to wipe
 * round/sim subcollections without leaving orphans. Chunks at BATCH_OP_LIMIT
 * so games with many rounds × many players don't bust the 500-op batch limit.
 */
async function deleteCollectionDocs(colRef) {
  const snap = await colRef.get();
  if (snap.empty) return;
  let batch = db.batch();
  let ops = 0;
  for (const docSnap of snap.docs) {
    batch.delete(docSnap.ref);
    ops += 1;
    if (ops >= BATCH_OP_LIMIT) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) {
    await batch.commit();
  }
}

/** Chars allowed in generated join codes — avoids 0/O/1/I confusion. */
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------------------
// Small utility helpers
// ---------------------------------------------------------------------------

function requireAuth(request, message = 'Sign in before continuing.') {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', message);
  }
  return request.auth;
}

// T2.1: warm-up short-circuit. The professor's "Warm up servers" button
// invokes each hot callable with { _warmup: true } ~30s before class so
// Cloud Run spins up an instance per service before students arrive. Gen 2
// callables each get their own Cloud Run service, so a single warmAll
// callable can't substitute — every hot callable needs its own short-circuit.
function isWarmupRequest(request) {
  return request?.data?._warmup === true;
}

function cleanGameId(value) {
  const gameId = cleanString(value);
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(gameId)) {
    throw new HttpsError('invalid-argument', 'gameId must be a valid game document id.');
  }
  return gameId;
}

/**
 * BE-R01: validate a client-supplied teamId. Must match the same shape
 * the `createTeam` slugifier produces (lowercase alphanumerics + dashes),
 * OR the `team-{N}` pattern used by the legacy number-based join path.
 * 2–60 chars keeps it bounded without rejecting legitimate names.
 */
function isValidTeamId(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return /^[a-z0-9-]{2,60}$/.test(trimmed);
}

/**
 * BE-R01: slugify a team name into a stable Firestore doc id.
 * Keeps alphanumerics + dashes; collapses whitespace; truncates to 50
 * chars so the id stays well under Firestore's 1500-byte key limit.
 * Appends a short random suffix on empty slugs (e.g. "🎂" alone).
 */
function slugifyTeamName(name) {
  const base = cleanString(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
  if (base.length >= 2) return base;
  // Fallback — caller should still uniqueness-check within the game.
  return `team-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * V4 (Apr 25): bakery-themed emoji palette used as the team logo on the
 * team-select grid + team page. Picked randomly on createTeam so each
 * team gets a distinct icon instead of every card defaulting to 🥐.
 * Keep these all bakery / café flavoured so the visual stays on-brand.
 */
const TEAM_EMOJI_POOL = [
  '🥐', '🥖', '🥨', '🍞', '🥯',
  '🍩', '🍪', '🧁', '🎂', '🍰',
  '🥧', '🍮', '🍯', '☕', '🥛',
  '🍓', '🥥', '🍫', '🌰', '🥜',
];
function pickTeamEmoji() {
  return TEAM_EMOJI_POOL[Math.floor(Math.random() * TEAM_EMOJI_POOL.length)];
}

/**
 * Generate a 6-character join code from the restricted alphabet.
 */
function generateJoinCode() {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += JOIN_CODE_ALPHABET[Math.floor(Math.random() * JOIN_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Generate a unique join code by retrying until we find one not already used.
 * 32^6 search space (~1 billion codes) is comfortable for a single classroom.
 */
async function generateUniqueJoinCode(maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateJoinCode();
    const existing = await db
      .collection('games')
      .where('joinCode', '==', code)
      .limit(1)
      .get();
    if (existing.empty) return code;
  }
  // Extremely unlikely — bubble up so the professor can retry.
  throw new HttpsError('aborted', 'Could not generate a unique join code. Please retry.');
}

/**
 * Turn a phase name + config into a Firestore Timestamp for phaseEndsAt.
 */
function phaseEndsAtFromNow(phaseName, config) {
  const seconds = getPhaseDuration(phaseName, config);
  return Timestamp.fromMillis(Date.now() + seconds * 1000);
}

/**
 * `games/{gameId}` ref helper.
 */
function gameDoc(gameId) {
  return db.collection('games').doc(gameId);
}

// ---------------------------------------------------------------------------
// assertRoleAllowed — BE-21 role-gated callable guard
// Throws HttpsError('permission-denied') unless playerRole is in allowedRoles.
// The 'solo' role bypasses all checks (single player doing everything).
//
// FE-I15 team-fallback (optional 3rd arg):
//   When `teamRoleAssignments` is provided and *nobody on the team holds
//   any of the allowedRoles*, this player is permitted to submit even if
//   their own role isn't in the list. This covers the 2-player team
//   shape (no one is `operations`) and mid-game edge cases where a
//   specialist role was cleared or a teammate disconnected. Pass the
//   team's `roleAssignments` map (uid → role | null) to enable the
//   fallback; omit it (or pass null) to preserve the strict BE-21 gate.
// ---------------------------------------------------------------------------
function assertRoleAllowed(playerRole, allowedRoles, teamRoleAssignments) {
  if (playerRole === 'solo') return;
  if (allowedRoles.includes(playerRole)) return;

  // Team-fallback: if the team doc is supplied and no teammate is
  // currently holding any of the required roles, allow the action.
  if (teamRoleAssignments && typeof teamRoleAssignments === 'object') {
    const heldRoles = Object.values(teamRoleAssignments).filter(Boolean);
    const someoneHoldsRequired = heldRoles.some((r) => allowedRoles.includes(r));
    if (!someoneHoldsRequired) return;
  }

  if (!playerRole) {
    // No role set and no fallback opened the gate — keep the original
    // BE-21 error so the client still nudges the player to pick a role.
    throw new HttpsError('failed-precondition',
      'You have not been assigned a role yet. Ask your team to set roles first.');
  }
  throw new HttpsError('permission-denied',
    `Your role "${playerRole}" cannot perform this action. Required: ${allowedRoles.join(' or ')}.`);
}

// ---------------------------------------------------------------------------
// assertRoleAllowedWithTeam — FE-I15 helper that reads the caller's team
// doc inside the transaction and forwards `roleAssignments` to
// `assertRoleAllowed` so role-gated callables accept the team-fallback.
// Call right after `pSnap` is available and *before* any writes in the
// transaction (Firestore forbids reads after writes).
// ---------------------------------------------------------------------------
async function assertRoleAllowedWithTeam(tx, gameRef, pSnap, allowedRoles) {
  const playerRole = pSnap.get('role');
  // Solo / matching specialist — skip the extra team-doc read.
  if (playerRole === 'solo' || allowedRoles.includes(playerRole)) return;

  const teamId = getPlayerTeamId(pSnap.data());
  let teamRoleAssignments = null;
  if (teamId) {
    const teamSnap = await tx.get(gameRef.collection('teams').doc(teamId));
    if (teamSnap.exists) {
      teamRoleAssignments = (teamSnap.data() || {}).roleAssignments || null;
    }
  }
  assertRoleAllowed(playerRole, allowedRoles, teamRoleAssignments);
}

function getPlayerTeamId(playerData) {
  const teamId = cleanString(playerData && playerData.teamId);
  return teamId || null;
}

function getPlayerTeamKey(playerDoc) {
  const data = (playerDoc && typeof playerDoc.data === 'function') ? playerDoc.data() : {};
  return getPlayerTeamId(data) || playerDoc.id;
}

/**
 * T2.2: Single per-team transient-state doc for round-scoped pending bids
 * and decision drafts. Replaces the previous cascade pattern where
 * `submitBids` / `submitDecision` wrote `pendingBids` / `pendingDecision`
 * to every teammate's `players/{uid}` doc — which contended at 3+ members.
 * Now each team has one doc that any teammate can subscribe to.
 *
 * Shape: { ad?, chef?, decisionDraft?, updatedByUid, updatedAt }
 *   - `ad` mirrors `pendingBids.ad` (the validated bid map)
 *   - `chef` mirrors `pendingBids.chef` (validated bid array)
 *   - `decisionDraft` mirrors the team-shared `pendingDecision.*` fields
 *     written by Operations' `submitDecision` (menu, quantities, staffCounts,
 *     sousChef*, submitted, submittedAt, round) and
 *     Finance's `submitPrices` (productPrices, pricesSubmitted, optional
 *     menu picks). `submitDecision`'s POST-01 gate also reads
 *     `decisionDraft.pricesSubmitted` from this doc to decide whether
 *     Finance has posted prices for the current round.
 */
function teamPendingDocRef(gameRef, teamId) {
  return gameRef.collection('teams').doc(teamId).collection('state').doc('pending');
}

/**
 * BE-I02: Scan every player doc and return the set of (teamKey, memberUid,
 * count) entries whose `specialtyChefs` array exceeds the cap. Used by
 * advanceGamePhase to block leaving the roster phase while anyone is over.
 *
 * Runs outside the phase-transition transaction because collection-wide reads
 * aren't allowed inside a transaction. The transactional phase check plus the
 * `expectedFromPhase` guard cover the narrow race window where a player could
 * add a chef between this scan and the phase write.
 */
async function findPlayersOverChefCap(gameRef, specialtyChefCap) {
  const snap = await gameRef.collection('players').get();
  const offenders = [];
  for (const doc of snap.docs) {
    const chefs = doc.get('specialtyChefs');
    const count = Array.isArray(chefs) ? chefs.length : 0;
    if (count > specialtyChefCap) {
      offenders.push({
        memberUid: doc.id,
        teamKey: doc.get('teamId') || doc.id,
        count,
      });
    }
  }
  return offenders;
}

function buildTeamGroupsFromPlayerDocs(playerDocs) {
  const groups = new Map();

  for (const playerDoc of playerDocs) {
    const data = playerDoc.data() || {};
    const teamId = getPlayerTeamId(data);
    const key = teamId || playerDoc.id;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        teamId,
        bakeryName: cleanString(data.bakeryName) || cleanString(data.displayName) || key,
        memberUids: [],
        memberDocs: [],
        operationsUid: null,
        financeUid: null,
        advertisingUid: null,
        soloUid: null,
        canonicalUid: playerDoc.id,
      });
    }

    const group = groups.get(key);
    group.memberUids.push(playerDoc.id);
    group.memberDocs.push(playerDoc);

    const role = cleanString(data.role);
    if (role === 'operations') group.operationsUid = playerDoc.id;
    if (role === 'finance') group.financeUid = playerDoc.id;
    if (role === 'advertising') group.advertisingUid = playerDoc.id;
    if (role === 'solo') group.soloUid = playerDoc.id;
  }

  for (const group of groups.values()) {
    group.memberUids.sort();
    group.memberDocs.sort((a, b) => a.id.localeCompare(b.id));
    group.canonicalUid =
      group.operationsUid ||
      group.financeUid ||
      group.advertisingUid ||
      group.soloUid ||
      group.memberUids[0] ||
      group.key;
  }

  return groups;
}

async function resolveAndApplyAdAuction(gameRef, round) {
  const roundId = `round_${round}`;
  const roundRef = gameRef.collection('rounds').doc(roundId);
  // RECOVERY-1: idempotency guard — if auction already resolved, skip.
  // This makes advanceGamePhase side effects safe to retry after a crash.
  const roundSnap = await roundRef.get();
  if (roundSnap.exists && roundSnap.data().adAuctionResolvedAt) {
    logger.info('resolveAndApplyAdAuction skipped — already resolved.', { gameId: gameRef.id, round });
    return;
  }
  const playersSnap = await gameRef.collection('players').get();
  const playerToTeamKey = new Map(
    playersSnap.docs.map((pd) => [pd.id, getPlayerTeamKey(pd)])
  );
  const bidSnaps = await Promise.all(
    playersSnap.docs.map((pd) => pd.ref.collection('bids').doc(roundId).get())
  );

  const aggregateAds = {};
  const adAuctionResults = {};

  // Balance pass 12: enforce minimum bid floor per ad type so a $1 bid
  // can't sweep up the cash bonus uncontested. Pulled from game config
  // so professors can tune live; falls back to the package default.
  const cfgSnap = await gameRef.collection('config').doc('params').get();
  const rawCfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
  const mergedCfg = require('./modules/config').mergeConfig(rawCfg);
  const adBidMins = (mergedCfg && mergedCfg.adBidMinimums) || {};

  for (const adType of AD_TYPES) {
    let winnerId = null;
    let winnerKey = null;
    let winningBid = 0;
    let winningSubmittedAt = null;
    const minBid = numberOrDefault(adBidMins[adType], 0);

    for (let i = 0; i < playersSnap.docs.length; i += 1) {
      const bidSnap = bidSnaps[i];
      if (!bidSnap.exists) continue;
      const bidData = bidSnap.data() || {};
      const amount = numberOrDefault(objectOrDefault(bidData.ad, {})[adType], 0);
      // Require strictly above zero AND meeting the minimum threshold.
      // Bids below threshold are silently dropped — the player still
      // pays nothing (their bid is just disqualified).
      if (amount <= 0 || amount < minBid) continue;
      const submittedAt = bidData.adSubmittedAt || null;
      const isEarlierSubmission =
        winningSubmittedAt &&
        submittedAt &&
        typeof winningSubmittedAt.toMillis === 'function' &&
        typeof submittedAt.toMillis === 'function' &&
        submittedAt.toMillis() < winningSubmittedAt.toMillis();
      if (
        amount > winningBid ||
        (amount === winningBid && winningBid > 0 && isEarlierSubmission)
      ) {
        winnerId = playersSnap.docs[i].id;
        winnerKey = playerToTeamKey.get(winnerId) || winnerId;
        winningBid = amount;
        winningSubmittedAt = submittedAt;
      }
    }

    if (!winnerId || !winnerKey || winningBid <= 0) continue;

    aggregateAds[adType] = {
      adType,
      winnerId,
      winnerKey,
      winningBid,
    };

    if (!adAuctionResults[winnerKey]) {
      adAuctionResults[winnerKey] = { adTypes: [], totalPaid: 0 };
    }
    adAuctionResults[winnerKey].adTypes.push(adType);
    adAuctionResults[winnerKey].totalPaid += winningBid;
  }

  await roundRef.set({
    round,
    auctionResults: { ads: aggregateAds },
    adAuctionResults,
    adAuctionResolvedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ---------------------------------------------------------------------------
// recordSubmission — BE-22 professor submission-state mirror (sharded path)
//
// Writes the player's submission record into a shard under
// `submissions/{submissionDocId}/shards/{idx}`. The `onSubmissionShardWritten`
// trigger then aggregates all shards into the public docs that the FE listens
// to:
//   - submissions/{submissionDocId}     = { [uid]: { status, submittedAt,
//                                                    displayName, role } }
//   - submissionCounts/{submissionDocId} = { count, updatedAt }
//
// The counts mirror is readable by all signed-in users (see firestore.rules)
// so the player-facing SubmissionLock can show "X / Y submitted" without
// exposing per-player identities.
//
// Re-submissions don't double-count: the same uid always maps to the same
// shard and overwrites the same `perUid[uid]` field, so the aggregator counts
// each uid exactly once regardless of how many times they re-submit.
//
// submissionDocId pattern: "round_{N}_{phase}"  e.g. "round_1_decide"
// Non-fatal: logged and swallowed on failure.
// ---------------------------------------------------------------------------
async function recordSubmission(gameRef, submissionDocId, uid, displayName, role) {
  // Sharded path: write the submission record into the uid's assigned shard
  // (no contention with other uids in other shards). The
  // `onSubmissionShardWritten` trigger then aggregates all shards into the
  // public `submissions/{docId}` + `submissionCounts/{docId}` docs that the
  // FE / professor dashboard already listen to. See modules/sharded-submissions.js.
  try {
    await writeSubmissionToShard(gameRef, submissionDocId, uid, displayName, role);
  } catch (err) {
    logger.warn('recordSubmission side-effect failed — non-fatal.', {
      gameId: gameRef.id, submissionDocId, uid, error: err && err.message,
    });
  }
}

/**
 * Load config for a game.
 */
async function loadGameConfig(gameRef) {
  const snap = await gameRef.collection('config').doc('params').get();
  return mergeConfig(snap.exists ? snap.data() : {});
}

/**
 * Load the preferences doc for one round.
 */
async function loadRoundPreferences(gameRef, round) {
  const snap = await gameRef.collection('preferences').doc(`round_${round}`).get();
  if (!snap.exists) return { modifiers: {} };
  return snap.data() || { modifiers: {} };
}

/**
 * Load all auction results for a round: read `rounds/{round}` doc and any
 * child auction docs. Returns a Map<playerId, { adWon, adWins, adBidPaid, chefsWon, chefBidPaid }>.
 */
async function loadAuctionResultsByPlayer(gameRef, round) {
  const byPlayer = new Map();
  const roundRef = gameRef.collection('rounds').doc(`round_${round}`);
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) return byPlayer;

  const data = roundSnap.data() || {};
  const adResults = objectOrDefault(data.adAuctionResults, {});
  const chefResults = objectOrDefault(data.chefAuctionResults, {});

  // Ad auction: keyed by playerId → { adTypes: [...], totalPaid }
  for (const [playerId, r] of Object.entries(adResults)) {
    if (!byPlayer.has(playerId)) {
      byPlayer.set(playerId, { adWon: null, adWins: [], adBidPaid: 0, chefsWon: [], chefBidPaid: 0 });
    }
    const entry = byPlayer.get(playerId);
    const adWins = Array.isArray(r && r.adTypes) ? r.adTypes : [];
    entry.adWon = adWins[0] || null;
    entry.adWins = adWins;
    entry.adBidPaid = numberOrDefault(r && r.totalPaid, 0);
  }

  // Chef auction: keyed by playerId → { chefs: [chef], totalPaid }
  for (const [playerId, r] of Object.entries(chefResults)) {
    if (!byPlayer.has(playerId)) {
      byPlayer.set(playerId, { adWon: null, adWins: [], adBidPaid: 0, chefsWon: [], chefBidPaid: 0 });
    }
    const entry = byPlayer.get(playerId);
    entry.chefsWon = Array.isArray(r && r.chefs) ? r.chefs : [];
    entry.chefBidPaid = numberOrDefault(r && r.totalPaid, 0);
  }

  return byPlayer;
}

/**
 * BE-R04: Clear every player's round-scoped pending state so round N doesn't
 * surface round N-1 data. Called from `advanceGamePhase` when entering any
 * `email` phase. Uses dot-paths to preserve `pendingDecision.productPrices`
 * (POST-01 carry-over) and any player fields that aren't round-scoped.
 *
 * Writes are chunked into batches of 400 to stay well under Firestore's
 * 500-op batch limit for games with large rosters.
 */
async function resetPendingPlayerStateForRound(gameRef) {
  const playersSnap = await gameRef.collection('players').get();
  if (playersSnap.empty) return;

  const BATCH_SIZE = 400;
  let batch = db.batch();
  let opsInBatch = 0;

  for (const playerDoc of playersSnap.docs) {
    batch.update(playerDoc.ref, {
      'pendingDecision.submitted': false,
      'pendingDecision.submittedAt': null,
      'pendingDecision.round': null,
      'pendingDecision.menu': {},
      'pendingDecision.quantities': {},
      'pendingDecision.sousChefCount': 0,
      'pendingDecision.sousChefAssignments': {},
      // POST-01 follow-up: clear the per-round Finance flag so the
      // "Operations waits for Finance prices" gate re-arms each round.
      // Without this, `pendingDecision.pricesSubmitted` carries over from
      // the previous round and Operations can submit before Finance posts
      // prices for the new round.
      'pendingDecision.pricesSubmitted': false,
      // Clear round-scoped Operations staffing state so round N+1 does not
      // inherit round N's staffing from a missed submission.
      'pendingDecision.staffCounts': {},
      'pendingBids.ad': null,
      'pendingBids.chef': null,
      pendingRosterAction: false,
      rosterCompleted: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
    opsInBatch++;
    if (opsInBatch >= BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      opsInBatch = 0;
    }
  }
  if (opsInBatch > 0) await batch.commit();
}

/**
 * T2.2: Clear every team's round-scoped pending doc so round N doesn't
 * surface round N-1 staged bids / decision drafts to teammates. Mirrors
 * `resetPendingPlayerStateForRound` for the new per-team transient-state
 * doc. Called from the same email-phase transition.
 *
 * NOTE: uses `set` *without* merge on purpose. Firestore set-merge
 * deep-merges nested maps, so an empty-map field like `menu: {}` would
 * be a no-op against an existing populated map and the previous round's
 * menu / quantities / staffCounts would survive into round N (surfacing
 * a stale draft to teammates after the per-player reset — which uses
 * dot-paths and clears correctly — already ran). A full overwrite is
 * safe here: this runs in `advanceGamePhase`'s post-transaction side-
 * effects, by which point the phase is already `email` and every submit
 * callable rejects with `failed-precondition`, so there are no
 * concurrent writers to lose work to.
 *
 * `decisionDraft.productPrices` is carried over across the reset so
 * Finance's last submitted prices default the next round's form
 * (POST-01 — same semantic as the per-player reset, which preserves
 * `pendingDecision.productPrices` by leaving it out of its dot-path
 * update list). We read each team's existing pending doc in parallel
 * via `db.getAll` to keep the carry-over cheap even at 25+ teams.
 */
async function resetPendingTeamStateForRound(gameRef) {
  const teamsSnap = await gameRef.collection('teams').get();
  if (teamsSnap.empty) return;

  const refs = teamsSnap.docs.map((td) => teamPendingDocRef(gameRef, td.id));
  const existingSnaps = refs.length > 0 ? await db.getAll(...refs) : [];

  const BATCH_SIZE = 400;
  let batch = db.batch();
  let opsInBatch = 0;

  for (let i = 0; i < teamsSnap.docs.length; i++) {
    const ref = refs[i];
    const ex = existingSnaps[i];
    const prevDraft = (ex && ex.exists && ex.data()) ? ex.data().decisionDraft : null;
    const carryoverPrices = (prevDraft
      && prevDraft.productPrices
      && typeof prevDraft.productPrices === 'object'
      && !Array.isArray(prevDraft.productPrices))
      ? prevDraft.productPrices
      : {};

    batch.set(ref, {
      ad: null,
      chef: null,
      decisionDraft: {
        submitted: false,
        submittedAt: null,
        round: null,
        menu: {},
        quantities: {},
        sousChefCount: 0,
        sousChefAssignments: {},
        staffCounts: {},
        productPrices: carryoverPrices,
        pricesSubmitted: false,
      },
      updatedByUid: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    opsInBatch++;
    if (opsInBatch >= BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      opsInBatch = 0;
    }
  }
  if (opsInBatch > 0) await batch.commit();
}

/**
 * MED-11 / HIGH-04: Resolve the chef auction for a round, write auction
 * results to the round doc, append won chefs to each winner's specialtyChefs
 * array, and set pendingRosterAction for anyone who exceeds the chef cap.
 */
async function resolveAndApplyChefAuction(gameRef, round, config) {
  const roundId = `round_${round}`;
  const roundRef = gameRef.collection('rounds').doc(roundId);

  // RECOVERY-1: idempotency guard — if auction already resolved, skip.
  const preRoundSnap = await roundRef.get();
  if (preRoundSnap.exists && preRoundSnap.data().chefAuctionResolvedAt) {
    logger.info('resolveAndApplyChefAuction skipped — already resolved.', { gameId: gameRef.id, round });
    return;
  }

  // Read the round's chefPool and all player bids for this round in parallel.
  const [roundSnap, playersSnap] = await Promise.all([
    roundRef.get(),
    gameRef.collection('players').get(),
  ]);

  const chefPool = (roundSnap.exists && roundSnap.data().chefPool) || [];
  const teamGroups = buildTeamGroupsFromPlayerDocs(playersSnap.docs);
  const playerToTeamKey = new Map(
    playersSnap.docs.map((pd) => [pd.id, getPlayerTeamKey(pd)])
  );
  if (chefPool.length === 0) {
    logger.info('No chef pool for this round; skipping auction.', {
      gameId: gameRef.id, round,
    });
    return;
  }

  // Read all player bid docs for this round.
  const bidSnaps = await Promise.all(
    playersSnap.docs.map((pd) =>
      pd.ref.collection('bids').doc(roundId).get()
    )
  );

  // Flatten into the format resolveChefAuction expects:
  // Array<{ playerId, chefId, amount, submittedAt }>
  const allBids = [];
  for (let i = 0; i < playersSnap.docs.length; i++) {
    const pd = playersSnap.docs[i];
    const bSnap = bidSnaps[i];
    if (!bSnap.exists) continue;
    const bData = bSnap.data() || {};
    const chefBids = Array.isArray(bData.chef) ? bData.chef : [];
    const submittedAt = bData.chefSubmittedAt || null;
    for (const cb of chefBids) {
      if (cb && cb.chefId && numberOrDefault(cb.amount, 0) > 0) {
        allBids.push({
          playerId: playerToTeamKey.get(pd.id) || pd.id,
          chefId: cb.chefId,
          amount: numberOrDefault(cb.amount, 0),
          submittedAt,
        });
      }
    }
  }

  if (allBids.length === 0) {
    logger.info('No chef bids submitted; skipping auction resolution.', {
      gameId: gameRef.id, round,
    });
    return;
  }

  // Resolve auction using pure function.
  const { winners, payments } = resolveChefAuction(chefPool, allBids);

  // Write auction results to round doc.
  // BE-I03: key by team slug only. Earlier code duplicated the entry under
  // every member uid, which caused the sim aggregator to sum the cost N× for
  // a team of N (BE-I01). Consumers read by `team.key`, which is the team
  // slug for multi-member teams and the player uid for solo players.
  const chefAuctionResults = {};
  for (const [winnerKey, chefs] of winners) {
    chefAuctionResults[winnerKey] = {
      chefs,
      totalPaid: payments.get(winnerKey) || 0,
    };
  }
  await roundRef.set({
    chefAuctionResults,
    chefAuctionResolvedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // Write winning chefs to each player's specialtyChefs and set
  // pendingRosterAction if they exceed the cap.
  // Uses FieldValue.arrayUnion so the write is atomic and idempotent —
  // safe on retry without duplicating chefs (addresses PR #19 review).
  const specialtyChefCap = numberOrDefault(config.specialtyChefCap, 3);
  const batch = db.batch();
  let opsCount = 0;

  for (const [winnerKey, wonChefs] of winners) {
    const winnerGroup = teamGroups.get(winnerKey);
    const memberDocs = winnerGroup ? winnerGroup.memberDocs : [];
    for (const playerDoc of memberDocs) {
      const existingCount = Array.isArray((playerDoc.data() || {}).specialtyChefs)
        ? playerDoc.data().specialtyChefs.length
        : 0;

      batch.update(playerDoc.ref, {
        specialtyChefs: FieldValue.arrayUnion(...wonChefs),
        pendingRosterAction: (existingCount + wonChefs.length) > specialtyChefCap,
        updatedAt: FieldValue.serverTimestamp(),
      });
      opsCount++;
    }
  }

  if (opsCount > 0) {
    await batch.commit();
  }

  logger.info('Chef auction resolved and applied.', {
    gameId: gameRef.id,
    round,
    winnersCount: winners.size,
    totalBids: allBids.length,
  });
}

// ===========================================================================
// createGame
// ===========================================================================

exports.createGame = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before creating a game.');
  const data = request.data || {};

  const totalRounds = numberOrDefault(data.totalRounds, DEFAULT_GAME_CONFIG.totalRounds);
  if (!Number.isInteger(totalRounds) || totalRounds < 1 || totalRounds > 10) {
    throw new HttpsError('invalid-argument', 'totalRounds must be an integer between 1 and 10.');
  }

  const config = mergeConfig(objectOrDefault(data.config, {}));
  const joinCode = await generateUniqueJoinCode();

  // Generate preference profiles for every round up front so the game is
  // fully configured before lobby opens.
  const roundPreferences = roundPreferencesModule.generateRoundPreferences(totalRounds, config);

  const gameRef = db.collection('games').doc();

  // Use a single batch for the initial doc set. Small enough not to need
  // chunking (one game doc + 1 config + totalRounds preference docs).
  const batch = db.batch();

  batch.set(gameRef, {
    joinCode,
    phase: 'lobby',
    round: 0,
    currentRound: 0,                      // legacy alias for readers
    totalRounds,
    professorUid: auth.uid,
    professorId: auth.uid,                // legacy alias
    paused: false,
    totalPlayers: 0,
    submittedCount: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    phaseStartedAt: FieldValue.serverTimestamp(),
    phaseEndsAt: null,
  });

  batch.set(gameRef.collection('config').doc('params'), {
    ...config,
    updatedAt: FieldValue.serverTimestamp(),
  });

  for (let i = 0; i < roundPreferences.length; i++) {
    const round = i + 1;
    const prefs = roundPreferences[i] || { modifiers: {} };
    batch.set(gameRef.collection('preferences').doc(`round_${round}`), {
      round,
      modifiers: prefs.modifiers || {},
      trending: prefs.trending || [],
      warm: prefs.warm || [],
      neutral: prefs.neutral || [],
      cold: prefs.cold || [],
    });
  }

  await batch.commit();

  logger.info('Game created.', { gameId: gameRef.id, joinCode, totalRounds });

  return { gameId: gameRef.id, joinCode };
});

// ===========================================================================
// joinGame
// ===========================================================================

exports.joinGame = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before joining a game.');
  const data = request.data || {};

  const joinCode = cleanString(data.joinCode).toUpperCase();
  const displayName = cleanString(data.displayName);
  const rawTeamNumber = data.teamNumber;
  const teamNumber = Number.isInteger(rawTeamNumber) && rawTeamNumber >= 1 && rawTeamNumber <= 8
    ? rawTeamNumber : null;
  // BE-R01/R02: explicit named-team join path. When supplied, the team
  // doc must already exist (created by `createTeam`) and is joined as-is.
  // Falls back to the PR #45 `team-{N}` derivation otherwise so existing
  // sessions keep working.
  const explicitTeamId = isValidTeamId(data.teamId) ? data.teamId : null;
  const bakeryName = cleanString(data.bakeryName) || (teamNumber ? `Team ${teamNumber}` : `${displayName}'s Bakery`);

  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(joinCode)) {
    throw new HttpsError('invalid-argument', 'joinCode must be a 6-character game code (letters A-Z excluding I/O, digits 2-9).');
  }
  if (displayName.length < 2 || displayName.length > 40) {
    throw new HttpsError('invalid-argument', 'displayName must be 2–40 characters.');
  }
  if (!teamNumber && !explicitTeamId) {
    throw new HttpsError('invalid-argument', 'Provide either teamNumber (1–8) or teamId.');
  }
  if (bakeryName.length > 60) {
    throw new HttpsError('invalid-argument', 'bakeryName must be 60 characters or fewer.');
  }

  const gameSnap = await db
    .collection('games')
    .where('joinCode', '==', joinCode)
    .limit(1)
    .get();
  if (gameSnap.empty) {
    throw new HttpsError('not-found', 'No game exists for that join code.');
  }
  const gameRef = gameSnap.docs[0].ref;
  const playerRef = gameRef.collection('players').doc(auth.uid);
  const rosterRef = gameRef.collection('roster').doc(auth.uid);

  // teamId: explicit wins, else derived from teamNumber. The team doc
  // for explicit ids must already exist (the createTeam callable writes
  // it); we fail fast if it's missing rather than silently creating an
  // orphan team.
  const teamId = explicitTeamId || `team-${teamNumber}`;
  const teamRef = gameRef.collection('teams').doc(teamId);

  let playerId = auth.uid;

  // P0-2 (2026-04-27): split joinGame into a per-uid transaction (validation
  // + player + roster + team-auto-create) and post-txn atomic increments
  // (totalPlayers, memberCount on existing teams). With 70 concurrent joiners,
  // having `transaction.update(gameRef, { totalPlayers: FieldValue.increment(1) })`
  // inside the transaction body caused 70-way pessimistic write-lock contention
  // on the game doc — 50/70 transactions exhausted retries with
  // `10 ABORTED: Transaction lock timeout`. Moving the increment outside the
  // transaction lets Firestore's server-side atomic counter handle the
  // contention; atomic field ops on a `.update()` outside a transaction don't
  // take a transaction lock, they serialize at the doc level naturally.
  //
  // Cap-check correctness: the read of `gSnap.get('totalPlayers')` lags by the
  // number of in-flight joins. For a 20-cap with 25 concurrent joiners, up to
  // 5 may slip past the cap. Acceptable for a class with cap >> realistic
  // attendance; tighten with a sharded counter (PR #103 pattern) if exact
  // enforcement is needed later.
  let outcomeNewJoin = false;
  let outcomeTeamExistedAtTxnTime = false;

  await db.runTransaction(async (transaction) => {
    // P0-2: reset on every retry so a previous-attempt flag doesn't leak
    // into a retry that may now take the rejoin path or hit a different
    // tSnap.exists value.
    outcomeNewJoin = false;
    outcomeTeamExistedAtTxnTime = false;

    const [gSnap, pSnap, cfgSnap, rSnap, tSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(playerRef),
      transaction.get(gameRef.collection('config').doc('params')),
      transaction.get(rosterRef),
      transaction.get(teamRef),
    ]);

    if (!gSnap.exists) {
      throw new HttpsError('not-found', 'No game exists for that join code.');
    }

    const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});

    // BE-24: new joins are only accepted during lobby and are subject to the
    // player cap. Rejoins (same uid, existing player doc) are allowed at any
    // phase so a student who refreshes their browser mid-game can recover
    // without being locked out.
    if (!pSnap.exists) {
      if (gSnap.get('phase') !== 'lobby') {
        throw new HttpsError('failed-precondition', 'This game is no longer accepting new players.');
      }
      const playerCap = numberOrDefault(config.playerCap, 20);
      const currentTotal = numberOrDefault(gSnap.get('totalPlayers'), 0);
      if (currentTotal >= playerCap) {
        throw new HttpsError('resource-exhausted', 'This game is full.');
      }
    }

    // BE-R01: if the caller specified an explicit teamId, require the team
    // to exist — don't silently create an orphan. The team-number path
    // (below) still auto-creates the team doc on first join.
    if (explicitTeamId && !tSnap.exists) {
      throw new HttpsError('not-found', 'No team exists with that id. Ask the team creator to share the game code again.');
    }

    // BE-R01: when joining an existing named team and the client didn't
    // send a bakeryName, mirror the team doc's name so the player's
    // roster card and the team doc stay in sync.
    let effectiveBakeryName = bakeryName;
    if (explicitTeamId && tSnap.exists && !cleanString(data.bakeryName)) {
      const teamName = tSnap.get('name');
      if (typeof teamName === 'string' && teamName.length > 0) {
        effectiveBakeryName = teamName;
      }
    }

    // BE-20 / BE-I04 (revised Apr 25): every joiner gets `solo` as the
    // backend role. `assertRoleAllowed`'s solo short-circuit (and the
    // team-fallback when no teammate holds a required role) keeps every
    // submit unlocked while the team is still picking. The 2→3 cascade
    // that previously force-flipped everyone onto specialist roles was
    // removed — it stole the choice away (the picker only re-enabled
    // *after* every role was already taken, leaving nothing to pick).
    // `setTeamRole` is now the only path onto a specialist role.
    const autoRole = 'solo';

    if (pSnap.exists) {
      // Rejoin: refresh display name / bakery name but do not reset progress.
      // No counter writes — player already counted from their original join.
      transaction.update(playerRef, {
        displayName,
        bakeryName: effectiveBakeryName,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(rosterRef, {
        uid: auth.uid,
        displayName,
        bakeryName: effectiveBakeryName,
        updatedAt: FieldValue.serverTimestamp(),
        ...(rSnap.exists ? {} : { joinedAt: FieldValue.serverTimestamp() }),
      }, { merge: true });
      return;
    }

    // First join: per-uid writes only inside the transaction. The hot-doc
    // increments (game.totalPlayers, team.memberCount) move below the txn.
    outcomeNewJoin = true;
    outcomeTeamExistedAtTxnTime = tSnap.exists;

    transaction.set(playerRef, {
      uid: auth.uid,
      playerId: auth.uid,
      displayName,
      bakeryName: effectiveBakeryName,
      teamId,                                    // BE-20
      role: autoRole,                            // BE-20
      joinedAt: FieldValue.serverTimestamp(),
      budgetCurrent: config.startingBudget,
      cumulativeRevenue: 0,
      specialtyChefs: [],
      sousChefCount: 0,
      equipmentGrade: 'C',
      cleanlinessScore: 75,
      cleanlinessGrade: 'B',
      returningCustomersPending: 0,
      consecutiveMissedRounds: 0,                // BE-19
      disconnected: false,                       // BE-19
      pendingDecision: { submitted: false },
      pendingBids: { ad: null, chef: null },
      pendingRosterAction: false,
      lastRoundResult: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.set(rosterRef, {
      uid: auth.uid,
      displayName,
      bakeryName: effectiveBakeryName,
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // BE-20: auto-create the team doc on the legacy team-{N} path when no
    // one has joined yet. This stays inside the transaction because team
    // auto-create is a fresh-doc write (no contention) and we want the
    // team doc and the player doc to land atomically — otherwise a peer
    // joiner could read an empty team while another player has half-joined.
    //
    // Concurrent first-join races on the same teamId are safe: the loser's
    // transaction observes `tSnap.exists = false` against a stale snapshot,
    // tries to `set(teamRef, ...)`, and Firestore aborts with a contention
    // error so the SDK retries; the retry sees `tSnap.exists = true` and
    // takes the post-txn `team.memberCount` increment path below.
    if (!tSnap.exists) {
      transaction.set(teamRef, {
        name: effectiveBakeryName,
        teamId,
        // V4 (Apr 25): match createTeam — pick a random emoji on the
        // legacy team-{N} auto-create path too, so every team has a
        // distinct icon regardless of which entry path created it.
        emoji: pickTeamEmoji(),
        roleAssignments: { [auth.uid]: autoRole },
        memberCount: 1,
        // Apr 28 2026: every new team starts with one product per station
        // unlocked. Locked products live in OPTIONAL_MENU and must be
        // unlocked via `purchaseProduct` for the team to add them to the
        // menu (see decision-validation.js).
        unlockedProducts: [...DEFAULT_UNLOCKED_PRODUCTS],
        unlocksPurchased: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });

  // P0-2: post-transaction hot-doc updates. Atomic FieldValue ops on a plain
  // .update() outside a transaction don't acquire a pessimistic write lock —
  // they serialize at the doc level via Firestore's atomic-counter machinery,
  // which scales to many more concurrent writers. See the comment above the
  // transaction body for why this matters at 70 concurrent joiners.
  if (outcomeNewJoin) {
    const writes = [
      gameRef.update({
        totalPlayers: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      }),
    ];
    // If the team doc already existed at txn-time, we still owe it a
    // memberCount bump and the per-uid roleAssignments key.
    if (outcomeTeamExistedAtTxnTime) {
      writes.push(teamRef.update({
        [`roleAssignments.${auth.uid}`]: 'solo',
        memberCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      }));
    }
    await Promise.all(writes);
  }

  return { gameId: gameRef.id, playerId };
});

// ===========================================================================
// createTeam (BE-R01)
// ===========================================================================
//
// Create a named team in the lobby and enroll the caller as its first
// member. Complements `joinGame`: the team-creator path never passes through
// the legacy `teamNumber → team-{N}` derivation and always produces a team
// doc keyed by a stable slug of the team name.
//
// Input: { joinCode, teamName, displayName }
// Output: { gameId, playerId, teamId, teamName }

exports.createTeam = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before creating a team.');
  const data = request.data || {};

  const joinCode = cleanString(data.joinCode).toUpperCase();
  const teamName = cleanString(data.teamName);
  const displayName = cleanString(data.displayName);

  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(joinCode)) {
    throw new HttpsError('invalid-argument', 'joinCode must be a 6-character game code.');
  }
  if (teamName.length < 2 || teamName.length > 30) {
    throw new HttpsError('invalid-argument', 'teamName must be 2–30 characters.');
  }
  if (displayName.length < 2 || displayName.length > 40) {
    throw new HttpsError('invalid-argument', 'displayName must be 2–40 characters.');
  }

  const gameSnap = await db
    .collection('games')
    .where('joinCode', '==', joinCode)
    .limit(1)
    .get();
  if (gameSnap.empty) {
    throw new HttpsError('not-found', 'No game exists for that join code.');
  }
  const gameRef = gameSnap.docs[0].ref;

  const baseSlug = slugifyTeamName(teamName);
  const playerRef = gameRef.collection('players').doc(auth.uid);
  const rosterRef = gameRef.collection('roster').doc(auth.uid);

  let resolvedTeamId = baseSlug;
  // P0-2: track whether this call enrolled a brand-new player so the
  // post-transaction totalPlayers increment only fires when it should.
  let createTeamCreatedNewPlayer = false;

  await db.runTransaction(async (transaction) => {
    // Reset on every attempt so a Firestore transaction retry doesn't carry
    // a stale suffix from a previous iteration into the slug-collision loop.
    resolvedTeamId = baseSlug;
    // P0-2: same reset rationale — if a previous attempt set this to true
    // and then aborted (contention retry), don't carry the stale flag
    // into a retry that may now be a no-op or a rejoin.
    createTeamCreatedNewPlayer = false;

    const [gSnap, cfgSnap, pSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(gameRef.collection('config').doc('params')),
      transaction.get(playerRef),
    ]);
    if (!gSnap.exists) {
      throw new HttpsError('not-found', 'No game exists for that join code.');
    }

    const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});

    // Mirror the joinGame ordering: phase + cap gates apply only to brand-new
    // players. A returning player (same uid, existing player doc) accidentally
    // hitting this path after the game started should get a precise error
    // rather than being silently blocked on the phase check.
    if (!pSnap.exists) {
      if (gSnap.get('phase') !== 'lobby') {
        throw new HttpsError('failed-precondition', 'Teams can only be created while the game is in the lobby.');
      }
      const playerCap = numberOrDefault(config.playerCap, 20);
      const currentTotal = numberOrDefault(gSnap.get('totalPlayers'), 0);
      if (currentTotal >= playerCap) {
        throw new HttpsError('resource-exhausted', 'This game is full.');
      }
    } else if (gSnap.get('phase') !== 'lobby') {
      throw new HttpsError('failed-precondition', 'You already joined this game. Refresh the page to rejoin your team.');
    }

    // Duplicate-name check: any existing team doc with the same name is a
    // conflict. `name` isn't indexed in this collection so we'd need either
    // a query-in-transaction (supported — single-doc result fine) or a
    // deterministic id collision check. We do both: slug collision + query.
    const dupSnap = await transaction.get(
      gameRef.collection('teams').where('name', '==', teamName).limit(1)
    );
    if (!dupSnap.empty) {
      throw new HttpsError('already-exists', 'A team with that name already exists in this game.');
    }

    // Slug-collision check: if `baseSlug` is taken by a different team,
    // append a short suffix until we find a free id.
    let teamRef = gameRef.collection('teams').doc(baseSlug);
    let tSnap = await transaction.get(teamRef);
    let attempts = 0;
    while (tSnap.exists && attempts < 6) {
      resolvedTeamId = `${baseSlug}-${Math.random().toString(36).slice(2, 5)}`;
      teamRef = gameRef.collection('teams').doc(resolvedTeamId);
      tSnap = await transaction.get(teamRef);
      attempts++;
    }
    if (tSnap.exists) {
      throw new HttpsError('aborted', 'Could not allocate a unique team id. Try a slightly different name.');
    }

    // BE-I04: first member is `solo` — the team only has one person
    // and `assertRoleAllowed`'s solo short-circuit keeps every action
    // unlocked. Players stay `solo` until they manually pick via
    // `setTeamRole` (the auto-cascade on the 3rd join was removed in
    // V6/V7 — see the matching comment in `joinGame`).
    //
    // V4 (Apr 25): pick a random bakery emoji for this team so the team
    // cards don't all default to the same croissant. The emoji is part
    // of the team doc so every member sees the same icon, and joiners
    // pick it up via `getTeamsInLobby` and the team-doc subscription.
    transaction.set(teamRef, {
      name: teamName,
      teamId: resolvedTeamId,
      createdBy: auth.uid,
      emoji: pickTeamEmoji(),
      roleAssignments: { [auth.uid]: 'solo' },
      memberCount: 1,
      // Apr 28 2026 — station-unlock seed (mirrors joinGame's auto-team
      // branch). Each station starts with one product unlocked; locked
      // products require a `purchaseProduct` call.
      unlockedProducts: [...DEFAULT_UNLOCKED_PRODUCTS],
      unlocksPurchased: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Player doc: mirror the `joinGame` shape so downstream writers
    // (submitDecision, submitBids, resetPendingPlayerStateForRound) can't
    // tell the two entry paths apart.
    if (pSnap.exists) {
      transaction.update(playerRef, {
        displayName,
        bakeryName: teamName,
        teamId: resolvedTeamId,
        role: 'solo',
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      transaction.set(playerRef, {
        uid: auth.uid,
        playerId: auth.uid,
        displayName,
        bakeryName: teamName,
        teamId: resolvedTeamId,
        role: 'solo',
        joinedAt: FieldValue.serverTimestamp(),
        budgetCurrent: config.startingBudget,
        cumulativeRevenue: 0,
        specialtyChefs: [],
        sousChefCount: 0,
        equipmentGrade: 'C',
        cleanlinessScore: 75,
        cleanlinessGrade: 'B',
        returningCustomersPending: 0,
        consecutiveMissedRounds: 0,
        disconnected: false,
        pendingDecision: { submitted: false },
        pendingBids: { ad: null, chef: null },
        pendingRosterAction: false,
        lastRoundResult: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(rosterRef, {
        uid: auth.uid,
        displayName,
        bakeryName: teamName,
        joinedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      // P0-2 (2026-04-27): totalPlayers increment moved below the txn — see
      // the matching note in joinGame. Tracking new-join via a closure flag
      // so the post-txn writer knows whether to fire the increment.
      createTeamCreatedNewPlayer = true;
    }
  });

  // P0-2: post-transaction atomic increment. Same rationale as joinGame —
  // pulling FieldValue.increment(1) out of the transaction body lets the
  // server-side counter handle parallel writers without lock contention.
  // createTeam contention is much lower than joinGame (one team-create per
  // team versus 9+ joins per team), but the same correctness argument
  // applies: the increment doesn't need transactional atomicity with the
  // per-uid player + roster + team writes.
  if (createTeamCreatedNewPlayer) {
    await gameRef.update({
      totalPlayers: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  return {
    gameId: gameRef.id,
    playerId: auth.uid,
    teamId: resolvedTeamId,
    teamName,
  };
});

// ===========================================================================
// getTeamsInLobby (BE-R02)
// ===========================================================================
//
// Return the list of teams currently in a game's lobby so the join-team
// form can render a selectable grid. No professor auth required — the
// lobby is public to anyone with the join code.
//
// Input:  { joinCode }
// Output: { gameId, teams: [{ teamId, name, memberCount }] }
//
// The response includes `gameId` so the client can set up a live
// Firestore subscription to `games/{gameId}/teams` and see member
// counts update in real time without having to re-invoke this
// callable on every keystroke.

exports.getTeamsInLobby = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before browsing teams.');
  const joinCode = cleanString((request.data || {}).joinCode).toUpperCase();
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(joinCode)) {
    throw new HttpsError('invalid-argument', 'joinCode must be a 6-character game code.');
  }

  const gameSnap = await db
    .collection('games')
    .where('joinCode', '==', joinCode)
    .limit(1)
    .get();
  if (gameSnap.empty) {
    throw new HttpsError('not-found', 'No game exists for that join code.');
  }

  const gameRef = gameSnap.docs[0].ref;

  // Surface "game already started" here instead of waiting for joinGame to
  // reject after the student has already selected a team. Returning players
  // (existing player doc) are exempt so they can still rejoin mid-game via
  // the team picker — joinGame's rejoin path stays open at any phase.
  if (gameSnap.docs[0].get('phase') !== 'lobby') {
    const existingPlayer = await gameRef.collection('players').doc(auth.uid).get();
    if (!existingPlayer.exists) {
      throw new HttpsError('failed-precondition', 'This game has already started and isn\'t accepting new players.');
    }
  }

  const teamsSnap = await gameRef.collection('teams').get();

  const teams = teamsSnap.docs.map((d) => {
    const data = d.data() || {};
    const roleAssignments = (data.roleAssignments && typeof data.roleAssignments === 'object')
      ? data.roleAssignments : {};
    return {
      teamId: d.id,
      name: typeof data.name === 'string' ? data.name : d.id,
      memberCount: numberOrDefault(data.memberCount, Object.keys(roleAssignments).length),
      // V4 (Apr 25): random per-team bakery emoji used as the team-card
      // logo on the join screen. Older teams created before this field
      // was introduced fall back to 🥐 in the FE.
      emoji: typeof data.emoji === 'string' && data.emoji.length > 0
        ? data.emoji
        : null,
    };
  });

  return { gameId: gameRef.id, teams };
});

// ===========================================================================
// startGame
// ===========================================================================

exports.startGame = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before starting a game.');
  const gameId = cleanGameId((request.data || {}).gameId);
  const gameRef = gameDoc(gameId);

  // HIGH-10 fix: wrap in a transaction to prevent double-start from
  // concurrent professor clicks (both would read phase='lobby' and commit).
  let config = null;
  await db.runTransaction(async (transaction) => {
    const [gSnap, cfgSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(gameRef.collection('config').doc('params')),
    ]);
    if (!gSnap.exists) {
      throw new HttpsError('not-found', 'Game not found.');
    }
    if (gSnap.get('professorUid') !== auth.uid && gSnap.get('professorId') !== auth.uid) {
      throw new HttpsError('permission-denied', 'Only the professor can start this game.');
    }
    if (gSnap.get('phase') !== 'lobby') {
      throw new HttpsError('failed-precondition', 'Only lobby games can be started.');
    }
    if (numberOrDefault(gSnap.get('totalPlayers'), 0) < 1) {
      throw new HttpsError('failed-precondition', 'At least one player must join first.');
    }

    config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});

    transaction.update(gameRef, {
      phase: 'round_1_email',
      round: 1,
      currentRound: 1,
      phaseStartedAt: FieldValue.serverTimestamp(),
      phaseEndsAt: phaseEndsAtFromNow('email', config),
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      submittedCount: 0,
    });
  });

  // Side-effect after transaction: write market insight email for round 1.
  const prefs = await loadRoundPreferences(gameRef, 1);
  const insight = marketInsightModule.buildMarketInsightEmail({
    round: 1,
    preferences: prefs,
    config,
  });
  await gameRef.collection('marketInsights').doc('round_1').set({
    round: 1,
    ...insight,
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  // BE-07: mirror to rounds/round_1.marketEmail for FE consumption
  await gameRef.collection('rounds').doc('round_1').set({
    round: 1,
    marketEmail: insight,
    marketEmailAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // T2.4: auto-snapshot at round 1 start (kicks off the per-round
  // checkpointing — see the matching hook in advanceGamePhase). Best-effort,
  // fire-and-forget — never block startGame on snapshot success.
  captureGameSnapshot(db, gameRef, { capturedBy: 'auto', capturedByUid: auth.uid })
    .then((res) => {
      logger.info('auto-snapshot ok (startGame)', {
        gameId, round: 1, snapshotId: res.snapshotId,
        totalDocs: res.totalDocs, totalBytes: res.totalBytes, elapsedMs: res.elapsedMs,
      });
      return pruneOldSnapshots(db, gameRef);
    })
    .catch((err) => {
      logger.warn('auto-snapshot failed (startGame) — non-fatal.', {
        gameId, error: err && err.message,
      });
    });

  return { gameId, phase: 'round_1_email', round: 1 };
});

// ===========================================================================
// advanceGamePhase
// ===========================================================================

exports.advanceGamePhase = onCall(HEAVY_CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before advancing phases.');
  const gameId = cleanGameId((request.data || {}).gameId);
  const gameRef = gameDoc(gameId);

  // ----------------------------------------------------------------
  // Step 1: transactional phase transition — decide next phase,
  // capture context. Side-effect work (simulation, chef-pool gen,
  // email gen) is queued for AFTER the transaction commits to keep
  // transaction duration bounded.
  // ----------------------------------------------------------------
  let transitionContext = null;

  // CRIT-02 fix: accept expectedFromPhase to prevent double-advance on
  // concurrent admin clicks (Firestore transaction retry would otherwise
  // read the already-advanced phase and advance it a second time).
  const expectedFromPhase = (request.data || {}).expectedFromPhase || null;

  // BE-I02: if we are leaving `roster`, no player may exceed the specialty-
  // chef cap. Run the collection scan outside the transaction since Firestore
  // transactions don't allow collection-wide reads. Concurrent writes are
  // bounded by the transactional phase guard below — worst case a player
  // gains a chef in the gap, advanceGamePhase fails, professor retries.
  {
    const preSnap = await gameRef.get();
    if (!preSnap.exists) {
      throw new HttpsError('not-found', 'Game not found.');
    }
    if (preSnap.get('professorUid') !== auth.uid && preSnap.get('professorId') !== auth.uid) {
      throw new HttpsError('permission-denied', 'Only the professor can advance phases.');
    }
    const currentPhase = preSnap.get('phase') || '';
    if (/_roster$/.test(currentPhase)) {
      const cfgSnap = await gameRef.collection('config').doc('params').get();
      const cfg = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
      const cap = numberOrDefault(cfg.specialtyChefCap, 3);
      const offenders = await findPlayersOverChefCap(gameRef, cap);
      if (offenders.length) {
        const detail = Array.from(
          new Map(offenders.map((o) => [o.teamKey, `${o.teamKey} (${o.count} chefs)`])).values(),
        ).join(', ');
        throw new HttpsError(
          'failed-precondition',
          `Cannot leave roster — team(s) over chef cap of ${cap}: ${detail}. Use Force Layoff or wait for teams to resolve.`,
        );
      }
    }
  }

  await db.runTransaction(async (transaction) => {
    const [gSnap, cfgSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(gameRef.collection('config').doc('params')),
    ]);
    if (!gSnap.exists) {
      throw new HttpsError('not-found', 'Game not found.');
    }
    if (gSnap.get('professorUid') !== auth.uid && gSnap.get('professorId') !== auth.uid) {
      throw new HttpsError('permission-denied', 'Only the professor can advance phases.');
    }

    const game = gSnap.data();
    const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
    const currentPhaseString = game.phase;
    const currentRound = numberOrDefault(game.currentRound || game.round, 0);

    // Guard against double-advance: if the caller specified which phase they
    // expect us to advance FROM, verify it still matches. On a Firestore
    // transaction retry the phase may have already moved.
    if (expectedFromPhase && currentPhaseString !== expectedFromPhase) {
      throw new HttpsError(
        'failed-precondition',
        `Phase has already advanced. Current: ${currentPhaseString}, expected: ${expectedFromPhase}`
      );
    }

    const next = getNextPhase(currentPhaseString, currentRound, game.totalRounds);

    // Parse next.phase for templates like 'round_N_x' to know the base name.
    const parsed = parsePhase(next.phase, next.round);
    const basePhaseName = parsed.phase;

    const update = {
      phase: next.phase,
      round: next.round,
      currentRound: next.round,
      phaseStartedAt: FieldValue.serverTimestamp(),
      phaseEndsAt:
        next.phase === 'game_over'
          ? null
          : phaseEndsAtFromNow(basePhaseName, config),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (basePhaseName === 'decide') {
      update.submittedCount = 0;
    }
    if (next.phase === 'game_over') {
      update.endedAt = FieldValue.serverTimestamp();
    }

    transaction.update(gameRef, update);

    transitionContext = {
      config,
      fromPhase: currentPhaseString,
      toPhase: next.phase,
      basePhaseName,
      round: next.round,
      totalRounds: game.totalRounds,
    };
  });

  if (!transitionContext) {
    return { gameId, status: 'no-op' };
  }

  const { config, toPhase, basePhaseName, round, totalRounds } = transitionContext;

  // ----------------------------------------------------------------
  // Step 2: phase-specific side-effects AFTER the transaction commit
  // ----------------------------------------------------------------

  try {
    if (basePhaseName === 'email' && round >= 1) {
      // BE-R04: on every round transition into `email`, wipe round-scoped
      // pending state on every player so Round N doesn't surface Round N-1
      // submitted bids / decision flags. `productPrices` carries over on
      // purpose (POST-01). `pendingRosterAction` is round-scoped — it's set
      // when the chef auction leaves a player over the cap and should not
      // survive into the next round's email screen. For round 1 this is a
      // no-op since all fields are already at their join-time defaults, but
      // it's idempotent and cheap so we run it unconditionally.
      await resetPendingPlayerStateForRound(gameRef);
      // T2.2: same reset for the per-team pending doc (the new home for
      // team-shared transient state). Independent batch — these docs live
      // under `teams/{id}/state/pending`, not under `players/{uid}`.
      await resetPendingTeamStateForRound(gameRef);

      // Write the market-insight email for the entering round.
      const prefs = await loadRoundPreferences(gameRef, round);
      const insight = marketInsightModule.buildMarketInsightEmail({ round, preferences: prefs, config });
      await gameRef.collection('marketInsights').doc(`round_${round}`).set({
        round,
        ...insight,
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      // BE-07: also mirror to rounds/round_N.marketEmail so FE can read it
      // from the rounds collection without a separate marketInsights listener.
      await gameRef.collection('rounds').doc(`round_${round}`).set({
        round,
        marketEmail: insight,
        marketEmailAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      // T2.4: auto-snapshot at the start of every round so the professor
      // can "restart this round" if anything goes sideways mid-round.
      // Best-effort and fire-and-forget — a snapshot failure must not block
      // the phase advance. Pruning is also fire-and-forget.
      captureGameSnapshot(db, gameRef, { capturedBy: 'auto', capturedByUid: null })
        .then((res) => {
          logger.info('auto-snapshot ok', {
            gameId, round, snapshotId: res.snapshotId,
            totalDocs: res.totalDocs, totalBytes: res.totalBytes,
            elapsedMs: res.elapsedMs,
          });
          return pruneOldSnapshots(db, gameRef);
        })
        .catch((err) => {
          logger.warn('auto-snapshot failed — non-fatal.', {
            gameId, round, error: err && err.message,
          });
        });
    }

    if (basePhaseName === 'bid_chef') {
      await resolveAndApplyAdAuction(gameRef, round);

      // Generate chef pool for this round.
      const pool = generateChefPool(round, config);
      await gameRef.collection('rounds').doc(`round_${round}`).set({
        round,
        chefPool: pool,
        chefPoolGeneratedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    if (basePhaseName === 'roster') {
      // MED-11 / HIGH-04 fix: resolve chef auction, write results to round doc,
      // write winning chefs to each player's specialtyChefs array, and set
      // pendingRosterAction for players who exceed the chef cap.
      await resolveAndApplyChefAuction(gameRef, round, config);
    }

    if (toPhase === 'simulating') {
      // Run simulation and persist results; then transition to results_ready.
      await runSimulationAndPersist(gameRef, round, config);

      // RACE-2 fix: wrap the simulating→results_ready transition in a
      // transaction that verifies phase is still 'simulating'. This prevents
      // a concurrent advanceGamePhase from corrupting the state, and makes
      // the transition retryable if the process crashes mid-way.
      await db.runTransaction(async (tx) => {
        const gSnap = await tx.get(gameRef);
        if (!gSnap.exists || gSnap.get('phase') !== 'simulating') {
          logger.warn('simulating→results_ready aborted: phase changed.', {
            gameId, currentPhase: gSnap.exists ? gSnap.get('phase') : 'deleted',
          });
          return;
        }
        tx.update(gameRef, {
          phase: 'results_ready',
          phaseStartedAt: FieldValue.serverTimestamp(),
          phaseEndsAt: phaseEndsAtFromNow('results_ready', config),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
    }

    if (toPhase === 'game_over') {
      // Compute and cache final conclusion.
      await persistConclusion(gameRef, totalRounds, config);
    }
  } catch (err) {
    logger.error('advanceGamePhase side-effect failed.', {
      gameId,
      toPhase,
      error: err && err.message,
    });
    // Surface the error so the professor UI knows to retry.
    throw new HttpsError('internal', `Phase side-effects failed: ${err.message || err}`);
  }

  const finalSnap = await gameRef.get();
  return {
    gameId,
    phase: finalSnap.get('phase'),
    round: numberOrDefault(finalSnap.get('round'), 0),
  };
});

// ===========================================================================
// retryStuckSimulation
// ===========================================================================

/**
 * Recover a game that is stuck at `phase === 'simulating'`.
 *
 * advanceGamePhase commits phase='simulating' inside a transaction, then runs
 * the simulation and the simulating→results_ready transition *outside* the
 * transaction. If the Cloud Function crashes or times out between those steps
 * the professor sees a frozen "simulating" screen with no results.
 *
 * This callable diagnoses the state and takes one of three actions:
 *
 *   - 'advance'  — simulation completed but the phase transition didn't land.
 *                  Re-run the transactional phase transition only.
 *   - 'rerun'    — simulation stopped mid-way (crash or never started). Re-run
 *                  it end-to-end. noiseSeed is deterministic
 *                  (`${gameId}:${round}:${playerId}`) so partially-written
 *                  player docs get overwritten with identical values.
 *   - failed-precondition — game is not actually stuck (phase ≠ 'simulating',
 *                  or simulation is still running within the 60s threshold).
 */
exports.retryStuckSimulation = onCall(HEAVY_CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before recovering stuck simulations.');
  const gameId = cleanGameId((request.data || {}).gameId);
  const gameRef = gameDoc(gameId);

  const [gSnap, cfgSnap] = await Promise.all([
    gameRef.get(),
    gameRef.collection('config').doc('params').get(),
  ]);
  if (!gSnap.exists) {
    throw new HttpsError('not-found', 'Game not found.');
  }
  if (gSnap.get('professorUid') !== auth.uid && gSnap.get('professorId') !== auth.uid) {
    throw new HttpsError('permission-denied', 'Only the professor can recover simulations.');
  }

  const game = gSnap.data();
  const phase = game.phase;
  const round = numberOrDefault(game.currentRound || game.round, 0);
  const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});

  const roundRef = gameRef.collection('rounds').doc(`round_${round}`);
  const roundSnap = await roundRef.get();

  // RECOVERY-2: recover side effects for bid_ad and bid_chef phases.
  // If advanceGamePhase crashed after the transaction committed but before
  // auction resolution / chef pool generation, the game is stuck with
  // missing side effects. The idempotency guards in resolveAndApplyAdAuction
  // and resolveAndApplyChefAuction make these safe to re-run.
  if (phase === 'bid_ad') {
    if (!roundSnap.exists || !roundSnap.data().adAuctionResolvedAt) {
      await resolveAndApplyAdAuction(gameRef, round);
      logger.info('retryStuckSimulation: recovered ad auction.', { gameId, round });
    }
    if (!roundSnap.exists || !roundSnap.data().chefPoolGeneratedAt) {
      const pool = generateChefPool(round, config);
      await roundRef.set({
        round,
        chefPool: pool,
        chefPoolGeneratedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      logger.info('retryStuckSimulation: recovered chef pool.', { gameId, round });
    }
    return { gameId, round, action: 'recover', reason: 'Recovered ad auction and chef pool.', phase };
  }

  if (phase === 'bid_chef') {
    if (!roundSnap.exists || !roundSnap.data().chefAuctionResolvedAt) {
      await resolveAndApplyChefAuction(gameRef, round, config);
      logger.info('retryStuckSimulation: recovered chef auction.', { gameId, round });
    }
    return { gameId, round, action: 'recover', reason: 'Recovered chef auction.', phase };
  }

  const simulationStatus = roundSnap.exists ? (roundSnap.get('simulationStatus') || null) : null;
  const startedTs = roundSnap.exists ? roundSnap.get('simulationStartedAt') : null;
  const simulationStartedAt =
    startedTs && typeof startedTs.toMillis === 'function' ? startedTs.toMillis() : null;

  const diagnosis = diagnoseSimulationState({
    phase,
    simulationStatus,
    simulationStartedAt,
    now: Date.now(),
    stuckThresholdMs: DEFAULT_STUCK_THRESHOLD_MS,
  });

  logger.info('retryStuckSimulation diagnosis', {
    gameId, round, phase, simulationStatus, diagnosis,
  });

  if (diagnosis.action === 'not-stuck' || diagnosis.action === 'wait') {
    throw new HttpsError('failed-precondition', diagnosis.reason);
  }

  if (diagnosis.action === 'rerun') {
    // Deterministic noiseSeed makes this idempotent — any partially-written
    // player rows from the original (crashed) run get overwritten with the
    // same values.
    await runSimulationAndPersist(gameRef, round, config);
  }

  // Transition simulating → results_ready using the same transactional guard
  // advanceGamePhase uses.
  await db.runTransaction(async (tx) => {
    const gs = await tx.get(gameRef);
    if (!gs.exists || gs.get('phase') !== 'simulating') {
      logger.warn('retryStuckSimulation: phase already moved before recovery advance.', {
        gameId, currentPhase: gs.exists ? gs.get('phase') : 'deleted',
      });
      return;
    }
    tx.update(gameRef, {
      phase: 'results_ready',
      phaseStartedAt: FieldValue.serverTimestamp(),
      phaseEndsAt: phaseEndsAtFromNow('results_ready', config),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  const finalSnap = await gameRef.get();
  return {
    gameId,
    round,
    action: diagnosis.action,
    reason: diagnosis.reason,
    phase: finalSnap.get('phase'),
  };
});

// ---------------------------------------------------------------------------
// Simulation orchestration (reads → pure sim → chunked batched writes)
// ---------------------------------------------------------------------------

/**
 * BE-I06: Stocked-weighted aggregate fill rate across a player's offered
 * products. Returns 0 when the player stocked nothing. Input is the
 * per-product map that `simulation.js` already builds.
 */
function aggregateFillRate(perProductSatisfaction) {
  const entries = Object.values(perProductSatisfaction || {});
  const totalStocked = entries.reduce(
    (s, e) => s + numberOrDefault(e && e.qtyStocked, 0),
    0,
  );
  if (totalStocked <= 0) return 0;
  const weighted = entries.reduce(
    (s, e) => s + numberOrDefault(e && e.fillRate, 0) * numberOrDefault(e && e.qtyStocked, 0),
    0,
  );
  return weighted / totalStocked;
}

/**
 * Read all data needed for simulation, invoke the pure simulation engine,
 * and persist results with batch chunking for 150+ player games.
 */
async function runSimulationAndPersist(gameRef, round, config) {
  const roundId = `round_${round}`;
  const roundRef = gameRef.collection('rounds').doc(roundId);

  // RECOVERY-1: idempotency guard — if simulation already complete, skip.
  const roundSnap = await roundRef.get();
  if (roundSnap.exists && roundSnap.data().simulationStatus === 'complete') {
    logger.info('runSimulationAndPersist skipped — already complete.', { gameId: gameRef.id, round });
    return;
  }

  // -----------------------------------------------------------------------
  // Read phase
  // -----------------------------------------------------------------------
  const [playersSnap, prefs, auctionByPlayer] = await Promise.all([
    gameRef.collection('players').get(),
    loadRoundPreferences(gameRef, round),
    loadAuctionResultsByPlayer(gameRef, round),
  ]);

  const playerDocs = playersSnap.docs;
  const teamGroups = buildTeamGroupsFromPlayerDocs(playerDocs);
  if (playerDocs.length === 0) {
    logger.warn('Simulation skipped — no players.', { gameId: gameRef.id, round });
    await roundRef.set({
      round,
      simulationStatus: 'complete',
      completedAt: FieldValue.serverTimestamp(),
      note: 'no players',
    }, { merge: true });
    return;
  }

  const decisionSnaps = await Promise.all(
    playerDocs.map((pd) =>
      pd.ref.collection('decisions').doc(roundId).get()
    )
  );

  // RC-9/10/11: read any existing player round docs for THIS round so
  // retryStuckSimulation can rerun idempotently. If a doc exists, it means
  // the first run's batch for that player committed — we must (a) skip the
  // cumulativeRevenue FieldValue.increment to avoid double-counting, and
  // (b) use the doc's budgetBefore as sim input since budgetCurrent was
  // already overwritten with budgetAfter.
  const priorRoundSnaps = await Promise.all(
    playerDocs.map((pd) =>
      pd.ref.collection('rounds').doc(roundId).get()
    )
  );
  const priorRoundByUid = new Map(
    playerDocs.map((pd, i) => [pd.id, priorRoundSnaps[i]])
  );

  // POST-01: load prior-round decisions for each player so pricing carry-over
  // can walk back through rounds 1..round-1.
  const priorRoundIds = [];
  for (let r = 1; r < round; r += 1) priorRoundIds.push(`round_${r}`);

  const priorDecisionSnapsByPlayer = await Promise.all(
    playerDocs.map((pd) =>
      Promise.all(priorRoundIds.map((rid) =>
        pd.ref.collection('decisions').doc(rid).get()
      ))
    )
  );

  const decisionSnapByUid = new Map(
    playerDocs.map((pd, i) => [pd.id, decisionSnaps[i]])
  );
  const priorDecisionSnapsByUid = new Map(
    playerDocs.map((pd, i) => [pd.id, priorDecisionSnapsByPlayer[i] || []])
  );

  // BE-19: compute disconnection state per team using the Operations owner
  // (or the best available fallback) as the round-submission owner.
  const disconnectionMap = new Map();
  const teams = Array.from(teamGroups.values());

  for (const team of teams) {
    const ownerUid =
      team.operationsUid ||
      team.soloUid ||
      team.financeUid ||
      team.advertisingUid ||
      team.canonicalUid;
    const ownerDoc = team.memberDocs.find((pd) => pd.id === ownerUid) || team.memberDocs[0];
    const ownerData = (ownerDoc && ownerDoc.data()) || {};
    const ownerDecisionSnap = decisionSnapByUid.get(ownerUid);
    // BUG-2 fix: require `submittedAt` (Operations marker) not just doc existence.
    // Finance-only `submitPrices` creates the doc with `pricesSubmittedAt` but
    // no `submittedAt`; those teams should be treated as missed submissions.
    const missed = !(ownerDecisionSnap && ownerDecisionSnap.exists && ownerDecisionSnap.get('submittedAt'));
    const prevMissed = numberOrDefault(ownerData.consecutiveMissedRounds, 0);
    disconnectionMap.set(team.key, {
      consecutiveMissedRounds: missed ? prevMissed + 1 : 0,
      disconnected: missed ? prevMissed + 1 >= 2 : false,
    });
  }

  // Assemble one simulation input per team, not per player row.
  const players = teams.map((team) => {
    const operationsUid =
      team.operationsUid ||
      team.soloUid ||
      team.financeUid ||
      team.advertisingUid ||
      team.canonicalUid;
    const financeUid =
      team.financeUid ||
      team.soloUid ||
      team.operationsUid ||
      team.canonicalUid;
    const canonicalDoc =
      team.memberDocs.find((pd) => pd.id === team.canonicalUid) || team.memberDocs[0];
    const canonicalData = (canonicalDoc && canonicalDoc.data()) || {};
    const decisionSnap = decisionSnapByUid.get(operationsUid);
    const financeDecisionSnap =
      decisionSnapByUid.get(financeUid) || decisionSnapByUid.get(operationsUid);
    // BUG-2 fix: require `submittedAt` (Operations marker) not just doc existence.
    const missed = !(decisionSnap && decisionSnap.exists && decisionSnap.get('submittedAt'));
    const decision = missed ? {} : (decisionSnap.data() || {});
    const financeDecision =
      financeDecisionSnap && financeDecisionSnap.exists
        ? (financeDecisionSnap.data() || {})
        : {};
    const financePrices = objectOrDefault(financeDecision.productPrices, {});
    const opsPrices = objectOrDefault(decision.productPrices, {});

    const aggregatedAuction = {
      adWon: null,
      adWins: [],
      adBidPaid: 0,
      chefsWon: [],
      chefBidPaid: 0,
    };
    // BE-I01: auction results are keyed by team slug (see BE-I03 in
    // resolveAndApplyAdAuction / resolveAndApplyChefAuction). Read once per
    // team — never iterate memberUids, which double-counted the cost.
    const ar = auctionByPlayer.get(team.key) || {};
    if (Array.isArray(ar.adWins)) {
      for (const adType of ar.adWins) {
        if (!aggregatedAuction.adWins.includes(adType)) {
          aggregatedAuction.adWins.push(adType);
        }
      }
    } else if (ar.adWon) {
      aggregatedAuction.adWins.push(ar.adWon);
    }
    aggregatedAuction.adBidPaid = numberOrDefault(ar.adBidPaid, 0);
    if (Array.isArray(ar.chefsWon)) {
      for (const chef of ar.chefsWon) {
        aggregatedAuction.chefsWon.push(chef);
      }
    }
    aggregatedAuction.chefBidPaid = numberOrDefault(ar.chefBidPaid, 0);
    aggregatedAuction.adWon = aggregatedAuction.adWins[0] || null;

    const priorSubmittedPrices = (priorDecisionSnapsByUid.get(financeUid) || [])
      .map((s) => (s && s.exists && s.data()) ? (s.data().productPrices || null) : null);

    // RC-11: on a retryStuckSimulation rerun, the canonical player's
    // budgetCurrent may have been overwritten with budgetAfter by the first
    // (crashed) run. Prefer the pre-sim snapshot from the round doc when it
    // exists, so the rerun sees the same input as the original run.
    const canonicalRoundSnap = priorRoundByUid.get(team.canonicalUid);
    const snapshotBudget =
      canonicalRoundSnap && canonicalRoundSnap.exists
        ? canonicalRoundSnap.get('budgetBefore')
        : undefined;
    const simInputBudget = typeof snapshotBudget === 'number'
      ? snapshotBudget
      : numberOrDefault(canonicalData.budgetCurrent, 0);

    return {
      playerId: team.key,
      displayName: cleanString(canonicalData.displayName) || team.bakeryName || 'Team',
      bakeryName: team.bakeryName || cleanString(canonicalData.displayName) || 'Team',
      decision: {
        menu: objectOrDefault(decision.menu, {}),
        quantities: objectOrDefault(decision.quantities, {}),
        sousChefCount: missed
          ? 0
          : numberOrDefault(decision.sousChefCount, canonicalData.sousChefCount || 0),
        sousChefAssignments: objectOrDefault(decision.sousChefAssignments, {}),
        productPrices: Object.keys(financePrices).length > 0 ? financePrices : opsPrices,
        // POST-01 follow-up: forward station-based counts so the CSV export
        // can fill in the bakery/deli/barista sous-chef columns + the
        // maintenance-guy column. Falls back to the canonical player's
        // `pendingDecision.staffCounts` when the decision doc pre-dates
        // this change.
        staffCounts: objectOrDefault(
          decision.staffCounts,
          objectOrDefault(
            (canonicalData.pendingDecision && canonicalData.pendingDecision.staffCounts) || {},
            {},
          ),
        ),
        equipmentUpgradePurchased: !!decision.equipmentUpgradePurchased,
      },
      specialtyChefs: Array.isArray(canonicalData.specialtyChefs) ? canonicalData.specialtyChefs : [],
      budgetCurrent: simInputBudget,
      returningCustomersPending: numberOrDefault(canonicalData.returningCustomersPending, 0),
      // Forward equipment + cleanliness state from the canonical player doc
      // so the simulation sees the round-end values from the prior round.
      // Without this, every round resets to defaults regardless of upgrades
      // or cleanliness drift persisted at the end of the previous round.
      equipmentGrade: canonicalData.equipmentGrade || 'C',
      cleanlinessScore: numberOrDefault(canonicalData.cleanlinessScore, 75),
      cleanlinessGrade: canonicalData.cleanlinessGrade || 'B',
      auctionResults: aggregatedAuction,
      priorSubmittedPrices,
    };
  });

  // -----------------------------------------------------------------------
  // Mark sim as running
  // -----------------------------------------------------------------------
  await roundRef.set({
    round,
    simulationStatus: 'running',
    simulationStartedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // -----------------------------------------------------------------------
  // Pure sim
  // -----------------------------------------------------------------------
  // P2 (2026-04-27): runMonthlySimulation wraps runSimulation in a 30-day
  // loop. Returns the same monthly aggregate shape as runSimulation plus a
  // `dailyResults` array. Existing consumers (results[i].revenueNet, etc.)
  // continue to work — those are still the monthly aggregates.
  const results = runMonthlySimulation(players, prefs, config, { gameId: gameRef.id, round });

  // Per-team sim-input budget, keyed by playerId (== team.key). Used below to
  // write budgetBefore alongside budgetAfter on each player round doc, which
  // powers RC-10/11 rerun idempotency.
  const simInputBudgetByTeam = new Map(players.map((p) => [p.playerId, p.budgetCurrent]));

  // -----------------------------------------------------------------------
  // Write phase — chunked batches
  // -----------------------------------------------------------------------
  // Each team member writes 3 ops:
  //   1. update players/{uid}
  //   2. set  players/{uid}/rounds/{round}
  //   3. set  csvRows/{uid}/rounds/{round}
  const OPS_PER_PLAYER = 3;

  let batch = db.batch();
  let opsInBatch = 0;
  const batches = [];

  for (const r of results) {
    const team = teamGroups.get(r.playerId);
    const memberDocs = team ? team.memberDocs : playerDocs.filter((pd) => pd.id === r.playerId);
    const dc = disconnectionMap.get(r.playerId) || { consecutiveMissedRounds: 0, disconnected: false };

    for (const memberDoc of memberDocs) {
      const playerRef = memberDoc.ref;
      const memberData = memberDoc.data() || {};
      const playerRoundRef = playerRef.collection('rounds').doc(roundId);
      const csvRowRef = gameRef
        .collection('csvRows')
        .doc(memberDoc.id)
        .collection('rounds')
        .doc(roundId);

      if (opsInBatch + OPS_PER_PLAYER > BATCH_OP_LIMIT) {
        batches.push(batch);
        batch = db.batch();
        opsInBatch = 0;
      }

      // RC-9: on a rerun, if this member's round doc already exists, the
      // first run's batch committed and cumulativeRevenue was already
      // incremented. Skip the increment to avoid double-counting.
      const priorRoundSnap = priorRoundByUid.get(memberDoc.id);
      const alreadyPersisted = !!(priorRoundSnap && priorRoundSnap.exists);
      const playerUpdate = {
        budgetCurrent: r.budgetAfter,
        returningCustomersPending: r.returningCustomersEarned,
        equipmentGrade: r.equipmentGrade,
        cleanlinessScore: r.cleanlinessScore,
        cleanlinessGrade: r.cleanlinessGrade,
        sousChefCount: numberOrDefault(
          (r.csvRow && r.csvRow.sous_chef_count),
          0
        ),
        consecutiveMissedRounds: dc.consecutiveMissedRounds,
        disconnected: dc.disconnected,
        lastRoundResult: {
          round,
          revenueGross: r.revenueGross,
          revenueNet: r.revenueNet,
          customerCount: r.customerCount,
          aggregateSatisfactionPct: r.aggregateSatisfactionPct,
          fillRate: aggregateFillRate(r.perProductSatisfaction),
          amountBorrowed: r.amountBorrowed,
          interestCharged: r.interestCharged,
          selloutAnywhere: r.selloutAnywhere || false,
          adWon: r.adWon || null,
          adWins: Array.isArray(r.adWins) ? r.adWins : [],
          adPaid: r.adBidPaid || 0,
          chefsWon: Array.isArray(r.chefsWon) ? r.chefsWon : [],
          chefWon: Array.isArray(r.chefsWon) && r.chefsWon.length > 0 ? r.chefsWon[0].name || r.chefsWon[0].id || null : null,
          chefBidPaid: r.chefBidPaid || 0,
          // POST-01 follow-up: surface submitted staff counts so the
          // frontend CSV download (RoundHeader.tsx / serializeRow) fills
          // in the per-station sous-chef + maintenance-guy columns
          // instead of leaving them blank.
          staffCounts:
            (r.csvRow && typeof r.csvRow === 'object'
              ? {
                  bakerySousChefs: r.csvRow.bakery_sous_chef_count || 0,
                  deliSousChefs: r.csvRow.deli_sous_chef_count || 0,
                  baristaSousChefs: r.csvRow.barista_sous_chef_count || 0,
                  maintenanceGuys: r.csvRow.maintenance_staff_count || 0,
                }
              : null)
            || objectOrDefault(
              (memberData.pendingDecision && memberData.pendingDecision.staffCounts) || {},
              {},
            ),
          // P1 (2026-04-27): surface decision inputs so the student CSV can
          // emit them. Without these the frontend CSV is outcome-only and
          // students can't fit y ~ X for in-game re-training.
          productPrices:
            r.csvRow && typeof r.csvRow === 'object'
              ? {
                  croissant: numberOrDefault(r.csvRow.price_croissant, null),
                  cookie: numberOrDefault(r.csvRow.price_cookie, null),
                  bagel: numberOrDefault(r.csvRow.price_bagel, null),
                  sandwich: numberOrDefault(r.csvRow.price_sandwich, null),
                  coffee: numberOrDefault(r.csvRow.price_coffee, null),
                  matcha: numberOrDefault(r.csvRow.price_matcha, null),
                }
              : null,
          quantitiesStocked:
            r.csvRow && typeof r.csvRow === 'object'
              ? {
                  croissant: numberOrDefault(r.csvRow.croissant_qty_stocked, 0),
                  cookie: numberOrDefault(r.csvRow.cookie_qty_stocked, 0),
                  bagel: numberOrDefault(r.csvRow.bagel_qty_stocked, 0),
                  sandwich: numberOrDefault(r.csvRow.sandwich_qty_stocked, 0),
                  coffee: numberOrDefault(r.csvRow.coffee_qty_stocked, 0),
                  matcha: numberOrDefault(r.csvRow.matcha_qty_stocked, 0),
                }
              : null,
          numProducts: numberOrDefault(r.csvRow && r.csvRow.num_products, 0),
          // P2 (2026-04-27): lightweight per-day summary so the frontend
          // CSV download can emit one row per day per round. Decision
          // inputs (constant across the round) are read from the
          // round-level fields above; daily values just fill in the
          // outcome columns that vary day to day.
          dailyBreakdown: Array.isArray(r.dailyResults)
            ? r.dailyResults.map((d) => ({
                day: d.day,
                revenueGross: d.revenueGross,
                revenueNet: d.revenueNet,
                amountBorrowed: d.amountBorrowed || 0,
                interestCharged: d.interestCharged || 0,
                customerCount: d.customerCount,
                aggregateSatisfactionPct: d.aggregateSatisfactionPct,
              }))
            : [],
        },
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!alreadyPersisted) {
        playerUpdate.cumulativeRevenue = FieldValue.increment(r.revenueNet);
      }
      batch.update(playerRef, playerUpdate);

      const perProductSold = {};
      const selloutFlags = {};
      for (const [product, pps] of Object.entries(r.perProductSatisfaction || {})) {
        perProductSold[product] = (pps && pps.qtySold) || 0;
        selloutFlags[product] = !!(pps && pps.sellout);
      }

      batch.set(playerRoundRef, {
        round,
        playerId: memberDoc.id,
        displayName: memberData.displayName || r.displayName,
        bakeryName: r.bakeryName,
        revenueGross: r.revenueGross,
        revenueNet: r.revenueNet,
        amountBorrowed: r.amountBorrowed,
        interestCharged: r.interestCharged,
        totalSpent: r.totalSpent,
        // RC-10: pre-sim budget snapshot, consulted by a retryStuckSimulation
        // rerun to restore the sim input that was already overwritten with
        // budgetAfter by the first (crashed) run's batch. If the round doc
        // already had a budgetBefore from a prior run, preserve it; otherwise
        // snapshot the sim-input budget we just passed in.
        budgetBefore: alreadyPersisted && typeof priorRoundSnap.get('budgetBefore') === 'number'
          ? priorRoundSnap.get('budgetBefore')
          : numberOrDefault(simInputBudgetByTeam.get(r.playerId), 0),
        budgetAfter: r.budgetAfter,
        customerCount: r.customerCount,
        perProductCustomers: r.perProductCustomers,
        aggregateSatisfactionPct: r.aggregateSatisfactionPct,
        perProductSatisfaction: r.perProductSatisfaction,
        perProductSold,
        selloutFlags,
        returningCustomersEarned: r.returningCustomersEarned,
        adWon: r.adWon || null,
        adWins: Array.isArray(r.adWins) ? r.adWins : [],
        adPaid: r.adBidPaid || 0,
        chefsWon: Array.isArray(r.chefsWon) ? r.chefsWon : [],
        chefBidPaid: r.chefBidPaid || 0,
        computedAt: FieldValue.serverTimestamp(),
      });

      batch.set(csvRowRef, {
        round,
        playerId: memberDoc.id,
        row: {
          ...(r.csvRow || {}),
          player_id: memberDoc.id,
          display_name: memberData.displayName || r.displayName,
          bakery_name: r.bakeryName,
        },
        writtenAt: FieldValue.serverTimestamp(),
      });

      opsInBatch += OPS_PER_PLAYER;

      // P2 (2026-04-27): per-day breakdown lives on lastRoundResult
      // (`dailyBreakdown` field) — the frontend reads it from there and
      // emits one CSV row per day from in-memory state. We do NOT persist
      // separate per-day csvRow Firestore docs because no consumer reads
      // them (CsvInboxModal pulls from GameContext.roundResults; the
      // professor CSV reads only the monthly csvRow doc above). Persisting
      // 30 extra docs per player per round (16x write amplification)
      // would burn quota for unread data. If a future feature (e.g.,
      // cross-team CSV pool, P3) needs the daily docs, add the writes
      // back then.
    }
  }

  // Aggregate writes (leaderboard + round doc completion) appended to the
  // FINAL batch so that simulationStatus='complete' only after all per-player
  // writes land.
  const rankings = results
    .slice()
    .map((r) => {
      const memberDoc = playerDocs.find((m) => m.id === r.playerId);
      const memberData = (memberDoc && memberDoc.data()) || {};
      return {
        ...r,
        cumulativeRevenue:
          numberOrDefault(memberData.cumulativeRevenue, 0) + r.revenueNet,
      };
    })
    .sort(
      (a, b) =>
        b.cumulativeRevenue - a.cumulativeRevenue || b.budgetAfter - a.budgetAfter,
    )
    .map((r, i) => ({
      rank: i + 1,
      playerId: r.playerId,
      displayName: r.bakeryName || r.displayName,
      bakeryName: r.bakeryName,
      revenueNet: r.revenueNet,
      revenueGross: r.revenueGross,
      customerCount: r.customerCount,
      budgetAfter: r.budgetAfter,
      amountBorrowed: r.amountBorrowed || 0,
      cumulativeRevenue: r.cumulativeRevenue,
    }));

  const revenues = results.map((r) => r.revenueNet);
  const customers = results.map((r) => r.customerCount);
  const avg = (arr) => (arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : 0);

  batch.set(roundRef, {
    round,
    simulationStatus: 'complete',
    completedAt: FieldValue.serverTimestamp(),
    classStats: {
      avgRevenueNet: avg(revenues),
      maxRevenueNet: revenues.length ? Math.max(...revenues) : 0,
      minRevenueNet: revenues.length ? Math.min(...revenues) : 0,
      avgCustomerCount: avg(customers),
      totalCustomerPool: customers.reduce((s, n) => s + n, 0),
      playerCount: results.length,
    },
  }, { merge: true });

  batch.set(gameRef.collection('leaderboard').doc('latest'), {
    round,
    rankings,
    updatedAt: FieldValue.serverTimestamp(),
  });

  batches.push(batch);

  for (const b of batches) {
    // eslint-disable-next-line no-await-in-loop
    await b.commit();
  }

  logger.info('Simulation persisted.', {
    gameId: gameRef.id,
    round,
    playerCount: results.length,
    batchCount: batches.length,
  });
}

// ---------------------------------------------------------------------------
// Conclusion persistence (game_over)
// ---------------------------------------------------------------------------

async function persistConclusion(gameRef, totalRounds, config) {
  const playersSnap = await gameRef.collection('players').get();

  // CRIT-05 fix: parallelize all per-player round reads instead of serial.
  // Chunk into groups of 20 to avoid overwhelming Firestore.
  const CHUNK_SIZE = 20;
  const playerDocs = playersSnap.docs;
  const perPlayer = [];

  for (let start = 0; start < playerDocs.length; start += CHUNK_SIZE) {
    const chunk = playerDocs.slice(start, start + CHUNK_SIZE);
    const chunkResults = await Promise.all(
      chunk.map(async (pd) => {
        const p = pd.data() || {};
        const roundsSnap = await pd.ref.collection('rounds').get();
        // LOGIC-2 fix: sum revenueNet (already post-loan-shark) to be
        // consistent with per-round leaderboard. Keep gross/borrowed/interest
        // for the conclusion breakdown display.
        let totalRevenueNet = 0;
        let totalRevenueGross = 0;
        let totalBorrowed = 0;
        let totalInterest = 0;
        for (const rd of roundsSnap.docs) {
          const rr = rd.data() || {};
          totalRevenueNet += numberOrDefault(rr.revenueNet, 0);
          totalRevenueGross += numberOrDefault(rr.revenueGross, 0);
          totalBorrowed += numberOrDefault(rr.amountBorrowed, 0);
          totalInterest += numberOrDefault(rr.interestCharged, 0);
        }
        const netRevenue = totalRevenueNet;
        return {
          playerId: pd.id,
          displayName: p.displayName || 'Player',
          bakeryName: p.bakeryName || '',
          totalRevenue: totalRevenueGross,
          totalBorrowed,
          totalInterest,
          netRevenue,
          budgetRemaining: numberOrDefault(p.budgetCurrent, 0),
          specialtyChefs: Array.isArray(p.specialtyChefs) ? p.specialtyChefs : [],
        };
      })
    );
    perPlayer.push(...chunkResults);
  }

  // Rank: netRevenue desc, tiebreak budgetRemaining desc.
  perPlayer.sort((a, b) =>
    b.netRevenue - a.netRevenue || b.budgetRemaining - a.budgetRemaining
  );
  const rankings = perPlayer.map((entry, i) => ({ rank: i + 1, ...entry }));

  const conclusion = conclusionModule.computeConclusion
    ? conclusionModule.computeConclusion(rankings, { totalRounds, config })
    : { rankings };

  await gameRef.collection('conclusion').doc('final').set({
    rankings,
    totalRounds,
    ...conclusion,
    computedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ===========================================================================
// submitDecision
// ===========================================================================

exports.submitDecision = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before submitting decisions.');
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const uid = auth.uid;
  const gameRef = gameDoc(gameId);
  const playerRef = gameRef.collection('players').doc(uid);

  let roundId = null;
  let _submitDecision_role = null;
  let _submitDecision_displayName = '';
  // P0-2 follow-up: capture the team pending fields inside the txn body so
  // the post-txn writer can mirror the draft outside the transaction's lock
  // domain. Inside the txn, the per-team `teams/{teamId}/state/pending` doc
  // was the next contention bottleneck: ~9 teammates submitting decisions
  // concurrently all wrote to the same pending doc, which caused another
  // wave of `ABORTED: Transaction lock timeout` failures even after the
  // joinGame fix. The pending doc is purely a UI mirror; eventual
  // consistency on it is fine — `set({ merge: true })` outside the txn
  // handles per-key merges (pricesSubmitted from submitPrices vs.
  // decisionDraft.* from submitDecision) correctly without lock contention.
  let _submitDecision_teamId = null;
  let _submitDecision_draftFields = null;

  try {
    await db.runTransaction(async (transaction) => {
      // P0-2: reset on retry so a stale prior-iteration capture doesn't leak
      // into the post-txn writer if the transaction body re-runs.
      _submitDecision_teamId = null;
      _submitDecision_draftFields = null;

      const [gSnap, pSnap, cfgSnap] = await Promise.all([
        transaction.get(gameRef),
        transaction.get(playerRef),
        transaction.get(gameRef.collection('config').doc('params')),
      ]);

      if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found.');
      if (!pSnap.exists) throw new HttpsError('failed-precondition', 'Join the game before submitting.');

      // BE-21 / FE-I15: operations role (or solo) required to submit
      // decisions — or any teammate when nobody on the team holds
      // operations (2-player team, cleared role, etc.).
      await assertRoleAllowedWithTeam(transaction, gameRef, pSnap, ['operations']);
      _submitDecision_role = pSnap.get('role') || null;
      _submitDecision_displayName = pSnap.get('displayName') || '';

      const game = gSnap.data();
      if (game.paused === true) {
        throw new HttpsError('failed-precondition', 'Game is paused. Submissions are temporarily disabled.');
      }
      if (!canSubmitDecision(game.phase)) {
        throw new HttpsError('failed-precondition', 'Decisions can only be submitted during the decide phase.');
      }

      const currentRound = numberOrDefault(game.currentRound || game.round, 1);
      const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
      const teamId = getPlayerTeamId(pSnap.data());

      // POST-01 gate: when the team has a Finance teammate, Operations may
      // not submit until Finance has posted prices for this round. Mirrors
      // the frontend gate in GamePage.tsx so a stale frontend cache (or a
      // direct callable invocation) can't bypass it. Skipped for solo
      // players and teams with no Finance seat — those paths submit prices
      // implicitly via `submitPrices`'s solo / fallback handling.
      //
      // T2.2 follow-up: read `pricesSubmitted` from the per-team pending
      // doc rather than the caller's own player doc — `submitPrices` no
      // longer cascades that flag onto teammates' player docs, so
      // Operations' own doc never sees it.
      //
      // P0-2 follow-up (2026-04-27): the gate ONLY applies to non-solo,
      // non-finance roles. Solo players take the early-out below without
      // any team-doc reads — eliminating ~9-way contention on the team +
      // team-pending docs in the all-solo stress test, and eliminating
      // unnecessary reads in mixed teams where most members are solo.
      // The gate is preserved for ops/advertising via the same reads.
      const needsPriceGate = teamId
        && _submitDecision_role !== 'solo'
        && _submitDecision_role !== 'finance';
      // Hoisted so the unlockedProducts read below reuses the snap when the
      // price-gate block already fetched it (PR #119 contention work).
      let teamSnap = null;
      if (needsPriceGate) {
        let teamPendingSnap;
        [teamSnap, teamPendingSnap] = await Promise.all([
          transaction.get(gameRef.collection('teams').doc(teamId)),
          transaction.get(teamPendingDocRef(gameRef, teamId)),
        ]);
        const teamRoleAssignmentsForGate = teamSnap.exists
          ? ((teamSnap.data() || {}).roleAssignments || null)
          : null;
        const teamPendingDraftForGate = teamPendingSnap.exists
          ? ((teamPendingSnap.data() || {}).decisionDraft || null)
          : null;
        const teamHasFinance = teamRoleAssignmentsForGate
          && Object.values(teamRoleAssignmentsForGate).some((r) => r === 'finance');
        if (teamHasFinance) {
          const teamPricesSubmitted = teamPendingDraftForGate
            && teamPendingDraftForGate.pricesSubmitted === true;
          if (!teamPricesSubmitted) {
            throw new HttpsError(
              'failed-precondition',
              'Waiting for your Finance teammate to submit prices for this round.',
            );
          }
        }
      }

      // T2.2: dropped the `players where teamId == X` read that previously
      // backed a cascade write across teammates' player docs. The submitter's
      // own player doc still gets the full `pendingDecision.*` write below
      // (no behaviour change for the submitter); the team-shared draft is
      // mirrored once to `teams/{teamId}/state/pending` so other teammates
      // can subscribe without contending on each other's player docs.

      // Apr 28 2026 — read the team's `unlockedProducts` so the validator can
      // reject menu items the team hasn't paid to unlock. We only do this read
      // when the player is on a team (every game post BE-20 should be); solo
      // players outside a team fall back to BASE_MENU only via the validator's
      // default. Missing team doc → starter set, matching joinGame's seed.
      let unlockedProducts = [...DEFAULT_UNLOCKED_PRODUCTS];
      if (teamId) {
        if (!teamSnap) {
          teamSnap = await transaction.get(gameRef.collection('teams').doc(teamId));
        }
        if (teamSnap.exists) {
          const raw = teamSnap.get('unlockedProducts');
          if (Array.isArray(raw) && raw.length > 0) {
            unlockedProducts = raw.filter((p) => typeof p === 'string');
          }
        }
      }

      // Validate using the decision-validation module (pure).
      // ValidationError is a plain JS error — convert to HttpsError so the
      // Firebase Functions runtime surfaces the right code to the client.
      let validated;
      try {
        validated = decisionValidation.validateDecision(data, currentRound, config, {
          unlockedProducts,
        });
      } catch (vErr) {
        if (ValidationError && vErr instanceof ValidationError) {
          throw new HttpsError(vErr.code || 'invalid-argument', vErr.message);
        }
        throw vErr;
      }

      roundId = `round_${currentRound}`;
      const decisionRef = playerRef.collection('decisions').doc(roundId);
      const dSnap = await transaction.get(decisionRef);
      // POST-01: `submitPrices` may have created this doc already with just
      // `productPrices + pricesSubmittedAt`. We only block duplicate Operations
      // submissions — presence of `submittedAt` is the Operations marker.
      if (dSnap.exists && dSnap.get('submittedAt')) {
        throw new HttpsError('already-exists', 'Decision already submitted for this round.');
      }

      // Merge so an existing Finance-written `productPrices` survives.
      // POST-01 follow-up: `staffCounts` (including the maintenanceGuys
      // default of 2) is included in `validated` and flows through the
      // spread — do not re-assign it from raw `data.staffCounts`, which
      // would discard the validator's defaulting.
      const decisionPatch = {
        round: currentRound,
        submittedAt: FieldValue.serverTimestamp(),
        ...validated,
      };
      transaction.set(decisionRef, decisionPatch, { merge: true });

      // BUG-1 fix: FieldValue.serverTimestamp() is invalid inside a nested
      // map — Firestore only allows sentinels at top-level fields. Use
      // Timestamp.now() for the nested submittedAt.
      //
      // POST-01: use dot-paths rather than replacing the whole `pendingDecision`
      // so Finance's `pendingDecision.productPrices` (written by submitPrices)
      // isn't clobbered when Operations submits after Finance.
      const submittedAtTs = Timestamp.now();
      const draftFields = {
        submitted: true,
        submittedAt: submittedAtTs,
        round: currentRound,
        menu: validated.menu || {},
        quantities: validated.quantities || {},
        sousChefCount: validated.sousChefCount || 0,
        sousChefAssignments: validated.sousChefAssignments || {},
        staffCounts: objectOrDefault(data.staffCounts, {}),
      };
      transaction.update(playerRef, {
        'pendingDecision.submitted': draftFields.submitted,
        'pendingDecision.submittedAt': draftFields.submittedAt,
        'pendingDecision.round': draftFields.round,
        'pendingDecision.menu': draftFields.menu,
        'pendingDecision.quantities': draftFields.quantities,
        'pendingDecision.sousChefCount': draftFields.sousChefCount,
        'pendingDecision.sousChefAssignments': draftFields.sousChefAssignments,
        'pendingDecision.staffCounts': draftFields.staffCounts,
        consecutiveMissedRounds: 0,
        disconnected: false,
        updatedAt: FieldValue.serverTimestamp(),
      });

      // P0-2 follow-up: capture the team pending fields the post-txn writer
      // will use. The actual write moves below the transaction — see the
      // detailed rationale at the end of this function.
      _submitDecision_teamId = teamId || null;
      _submitDecision_draftFields = draftFields;

      // T3.3: submittedCount is no longer incremented here. The single-doc
      // FieldValue.increment(1) was the next contention point at 25–70 students;
      // it's been replaced by per-uid shard writes after the transaction
      // (writeUidToSubmittedCountShard below) plus an aggregator trigger
      // (onSubmittedCountShardWritten) that recomputes game.submittedCount.
      //
      // P0-2 follow-up (2026-04-27): the leftover `transaction.update(gameRef,
      // { updatedAt: ... })` here re-introduced 70-way write-lock contention
      // that the T3.3 sharding was designed to eliminate. The 70-player
      // stress test was hitting `60/70 deadline-exceeded` on this single
      // line. game.updatedAt isn't read by anything that matters (FE
      // listeners watch phase/round/submittedCount, not updatedAt), so the
      // write is removed entirely. If a future feature needs a "game last
      // touched" timestamp, derive it from the `players/{uid}.updatedAt`
      // we already write or add a sharded equivalent.
    });
  } catch (err) {
    // Re-raise HttpsError untouched so Firebase Functions surfaces the
    // intended code/message to the client. Anything else gets wrapped into
    // a generic 'internal' AFTER being logged with enough context to make
    // the failure debuggable from Cloud Logging — previously these escaped
    // as opaque "internal" errors with no breadcrumbs.
    if (err instanceof HttpsError) throw err;
    logger.error('submitDecision unexpected error', {
      gameId, uid,
      role: _submitDecision_role,
      message: err && err.message,
      stack: err && err.stack,
    });
    throw new HttpsError('internal', `submitDecision failed: ${err && err.message ? err.message : err}`);
  }

  // P0-2 follow-up: mirror the team draft to the per-team pending doc
  // OUTSIDE the transaction. Same rationale as the joinGame post-txn
  // increments — `set({ merge: true })` outside a transaction does not
  // take a pessimistic write lock, so 9 teammates submitting concurrently
  // (worst case, one team) merge cleanly via field-level updates instead
  // of contending on the same doc. Best-effort: a failure here doesn't
  // roll back the player's decision (the transaction above committed
  // their personal player + decision docs); the team UI mirror just lags.
  if (_submitDecision_teamId && _submitDecision_draftFields) {
    try {
      await teamPendingDocRef(gameRef, _submitDecision_teamId).set({
        decisionDraft: _submitDecision_draftFields,
        updatedByUid: uid,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (mirrorErr) {
      logger.warn('submitDecision team-pending mirror failed — non-fatal.', {
        gameId, uid, teamId: _submitDecision_teamId, error: mirrorErr && mirrorErr.message,
      });
    }
  }

  // T3.3: bump the sharded submission counter. The aggregator trigger
  // recomputes game.submittedCount from these shards. Best-effort: if this
  // fails the player's decision is still saved (the transaction above
  // already committed); the count just lags briefly until the next submit.
  if (roundId) {
    try {
      await writeUidToSubmittedCountShard(gameRef, roundId, uid);
    } catch (shardErr) {
      logger.warn('writeUidToSubmittedCountShard failed — non-fatal.', {
        gameId, uid, roundId, error: shardErr && shardErr.message,
      });
    }
  }

  // BE-22: mirror submission state for professor dashboard
  if (roundId) {
    await recordSubmission(
      gameRef, `${roundId}_decide`, uid,
      _submitDecision_displayName, _submitDecision_role
    );
  }

  return { gameId, playerId: uid, roundId, submitted: true };
});

// ===========================================================================
// submitPrices (POST-01)
// ===========================================================================
//
// Finance-role-gated per-product price submission. Lives in its own callable
// (rather than piggybacking on submitDecision) because Finance and Operations
// are separate people and must not race on the same document write.
//
// Multiple submits during a single Decide phase are allowed — latest wins.

exports.submitPrices = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before submitting prices.');
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const uid = auth.uid;
  const gameRef = gameDoc(gameId);
  const playerRef = gameRef.collection('players').doc(uid);

  let roundId = null;
  let _submitPrices_role = null;
  let _submitPrices_displayName = '';

  await db.runTransaction(async (transaction) => {
    const [gSnap, pSnap, cfgSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(playerRef),
      transaction.get(gameRef.collection('config').doc('params')),
    ]);

    if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found.');
    if (!pSnap.exists) throw new HttpsError('failed-precondition', 'Join the game before submitting.');

    // Finance-only (solo players pass through assertRoleAllowed's solo
    // case; FE-I15 also unlocks this for any teammate when no one on
    // the team holds finance).
    await assertRoleAllowedWithTeam(transaction, gameRef, pSnap, ['finance']);
    _submitPrices_role = pSnap.get('role') || null;
    _submitPrices_displayName = pSnap.get('displayName') || '';

    const game = gSnap.data();
    if (game.paused === true) {
      throw new HttpsError('failed-precondition', 'Game is paused. Submissions are temporarily disabled.');
    }
    if (!canSubmitDecision(game.phase)) {
      throw new HttpsError('failed-precondition', 'Prices can only be submitted during the decide phase.');
    }

    const currentRound = numberOrDefault(game.currentRound || game.round, 1);
    const teamId = getPlayerTeamId(pSnap.data());
    // T2.2 follow-up: dropped the `players where teamId == X` cascade read.
    // The submitter's own player doc still gets the same `pendingDecision.*`
    // writes (so the submitter's UI is unchanged); the team-shared signals
    // are mirrored once to the per-team pending doc instead of fanning out
    // to every teammate's player doc.
    // Note: cfgSnap is read for parity with submitDecision even though the
    // price validator doesn't need it today. Future work may apply per-game
    // zone overrides from config.
    void mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});

    // Validate + snap + clamp
    // ValidationError is a plain JS error — convert to HttpsError so the
    // Firebase Functions runtime surfaces the right code to the client.
    let validated;
    try {
      validated = decisionValidation.validateProductPrices(data.productPrices);
    } catch (vErr) {
      if (ValidationError && vErr instanceof ValidationError) {
        throw new HttpsError(vErr.code || 'invalid-argument', vErr.message);
      }
      throw vErr;
    }

    roundId = `round_${currentRound}`;
    const decisionRef = playerRef.collection('decisions').doc(roundId);

    // Multiple submits are allowed during the same phase — use set-merge,
    // NOT the already-exists check that submitDecision uses.
    transaction.set(decisionRef, {
      round: currentRound,
      productPrices: validated,
      pricesSubmittedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    // Propagate optional menu choices from Finance so Operations sees newly
    // unlocked products without needing to reload. Base-menu items are always
    // true and need no propagation; we only sync optional products.
    const OPTIONAL = ['sandwich', 'coffee', 'matcha'];
    const rawMenu = objectOrDefault(data.menu, {});
    const optionalMenuPatch = {};
    for (const p of OPTIONAL) {
      optionalMenuPatch[p] = rawMenu[p] === true;
    }
    const playerMenuUpdate = {};
    for (const p of OPTIONAL) {
      playerMenuUpdate[`pendingDecision.menu.${p}`] = optionalMenuPatch[p];
    }

    transaction.update(playerRef, {
      'pendingDecision.productPrices': validated,
      'pendingDecision.pricesSubmitted': true,
      ...playerMenuUpdate,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // T2.2 follow-up: mirror the team-shared price/menu signals to the
    // per-team pending doc. The deep-merge semantics of `set` with
    // `merge: true` work cleanly for these top-level keys under
    // `decisionDraft` — we're either creating new fields or replacing
    // leaf values (productPrices is a flat map of price scalars,
    // pricesSubmitted is a boolean, menu.* are booleans). An Operations
    // submit that lands later writes the full `menu` map and the deep
    // merge correctly overlays the optional keys we wrote here.
    if (teamId) {
      const teamDraftPatch = {
        productPrices: validated,
        pricesSubmitted: true,
        menu: optionalMenuPatch,
      };
      transaction.set(teamPendingDocRef(gameRef, teamId), {
        decisionDraft: teamDraftPatch,
        updatedByUid: uid,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  });

  // Mirror submission state for the professor dashboard
  if (roundId) {
    await recordSubmission(
      gameRef, `${roundId}_prices`, uid,
      _submitPrices_displayName, _submitPrices_role
    );
  }

  return { gameId, playerId: uid, roundId, submitted: true };
});

// ===========================================================================
// submitBids
// ===========================================================================

exports.submitBids = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before bidding.');
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const bidType = cleanString(data.bidType); // 'ad' or 'chef'
  if (bidType !== 'ad' && bidType !== 'chef') {
    throw new HttpsError('invalid-argument', 'bidType must be "ad" or "chef".');
  }

  const uid = auth.uid;
  const gameRef = gameDoc(gameId);
  const playerRef = gameRef.collection('players').doc(uid);

  let _submitBids_round = null;
  let _submitBids_validated = null;
  let _submitBids_role = null;
  let _submitBids_displayName = '';
  let _submitBids_teamKey = null;

  await db.runTransaction(async (transaction) => {
    const [gSnap, pSnap, cfgSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(playerRef),
      transaction.get(gameRef.collection('config').doc('params')),
    ]);
    if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found.');
    if (!pSnap.exists) throw new HttpsError('failed-precondition', 'Join the game before bidding.');

    // BE-21 / FE-I15: advertising (ad bids) / finance (chef bids) —
    // or solo, or any teammate when that role is unfilled.
    if (bidType === 'ad') {
      await assertRoleAllowedWithTeam(transaction, gameRef, pSnap, ['advertising']);
    } else {
      await assertRoleAllowedWithTeam(transaction, gameRef, pSnap, ['finance']);
    }
    _submitBids_role = pSnap.get('role') || null;
    _submitBids_displayName = pSnap.get('displayName') || '';
    _submitBids_teamKey = getPlayerTeamKey(pSnap);

    const game = gSnap.data();
    if (!canSubmitBids(game.phase, bidType)) {
      throw new HttpsError('failed-precondition', `Current phase ${game.phase} does not accept ${bidType} bids.`);
    }

    // BE-N04: server-side timer enforcement — reject bids after the phase timer expires.
    const phaseEnd = game.phaseEndsAt;
    if (phaseEnd && Timestamp.now().toMillis() > phaseEnd.toMillis()) {
      throw new HttpsError(
        'failed-precondition',
        'The auction timer has expired. No more bids are accepted.'
      );
    }

    const round = numberOrDefault(game.currentRound || game.round, 1);
    _submitBids_round = round;
    const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
    const teamId = getPlayerTeamId(pSnap.data());
    // T2.2: dropped the `players where teamId == X` cascade read — the
    // submitter still gets their own `pendingBids.${bidType}` write below
    // (no behaviour change for the submitter); other teammates subscribe
    // to the team pending doc instead of having it cascaded onto theirs.

    let validated;
    try {
      if (bidType === 'ad') {
        validated = decisionValidation.validateAdBids(data);
      } else {
        // CRIT-07 fix: chefPool lives on rounds/{round} doc, NOT on game root.
        const roundSnap = await transaction.get(
          gameRef.collection('rounds').doc(`round_${round}`)
        );
        const chefPool = (roundSnap.exists && roundSnap.data().chefPool) || [];
        validated = decisionValidation.validateChefBids(data, chefPool);
      }
    } catch (vErr) {
      if (ValidationError && vErr instanceof ValidationError) {
        throw new HttpsError(vErr.code || 'invalid-argument', vErr.message);
      }
      throw vErr;
    }
    _submitBids_validated = validated;

    const roundRef = gameRef.collection('rounds').doc(`round_${round}`);
    const bidsRef = playerRef.collection('bids').doc(`round_${round}`);
    const existing = await transaction.get(bidsRef);
    const roundSnap = await transaction.get(roundRef);
    const merged = existing.exists ? existing.data() : { round };
    const roundData = (roundSnap.exists && roundSnap.data()) || {};
    const topBids = objectOrDefault(roundData.topBids || {}, {});
    const topBidsLeader = objectOrDefault(roundData.topBidsLeader || {}, {});
    const myTeamKey = getPlayerTeamKey(pSnap);

    if (bidType === 'ad') {
      const existingAd = objectOrDefault(merged.ad, {});
      const currentTopAd = objectOrDefault(topBids.ad, {});
      const currentTopLeaderAd = objectOrDefault(topBidsLeader.ad, {});
      for (const adType of AD_TYPES) {
        const existingAmount = numberOrDefault(existingAd[adType], 0);
        const currentTop = numberOrDefault(currentTopAd[adType], 0);
        const nextAmount = numberOrDefault(validated[adType], 0);
        const isActualLeader = currentTopLeaderAd[adType] === myTeamKey;
        if (existingAmount > 0 && existingAmount === currentTop && isActualLeader && nextAmount !== existingAmount) {
          throw new HttpsError(
            'failed-precondition',
            `You already hold the top bid for ${adType} and cannot change it until another team outbids you.`
          );
        }
      }
      merged.ad = validated;
    } else {
      const existingChefBids = Array.isArray(merged.chef) ? merged.chef : [];
      const existingChefMap = {};
      for (const bid of existingChefBids) {
        if (bid && bid.chefId) existingChefMap[bid.chefId] = numberOrDefault(bid.amount, 0);
      }
      const currentTopChef = objectOrDefault(topBids.chef, {});
      const currentTopLeaderChef = objectOrDefault(topBidsLeader.chef, {});
      for (const bid of validated) {
        if (!bid || !bid.chefId) continue;
        const existingAmount = numberOrDefault(existingChefMap[bid.chefId], 0);
        const currentTop = numberOrDefault(currentTopChef[bid.chefId], 0);
        const isActualLeader = currentTopLeaderChef[bid.chefId] === myTeamKey;
        if (existingAmount > 0 && existingAmount === currentTop && isActualLeader && numberOrDefault(bid.amount, 0) !== existingAmount) {
          throw new HttpsError(
            'failed-precondition',
            'You already hold the top bid for that chef and cannot change it until another team outbids you.'
          );
        }
      }

      const mergedChefMap = { ...existingChefMap };
      for (const bid of validated) {
        if (bid && bid.chefId) mergedChefMap[bid.chefId] = numberOrDefault(bid.amount, 0);
      }
      merged.chef = Object.entries(mergedChefMap)
        .filter(([, amount]) => numberOrDefault(amount, 0) > 0)
        .map(([chefId, amount]) => ({ chefId, amount }));
    }

    merged.round = round;
    merged[`${bidType}SubmittedAt`] = FieldValue.serverTimestamp();

    transaction.set(bidsRef, merged, { merge: true });
    // T2.2: write submitter's own player doc (preserves the existing
    // contract — submitter's UI continues to read pendingBids from their
    // own player doc) and mirror to the per-team pending doc once. Solo
    // players (no teamId) skip the team mirror.
    transaction.update(playerRef, {
      [`pendingBids.${bidType}`]: validated,
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (teamId) {
      transaction.set(teamPendingDocRef(gameRef, teamId), {
        [bidType]: validated,
        updatedByUid: uid,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  });

  // BE-25 + perf: write the team's bid into their assigned shard so the FE
  // can compute live top bids by aggregating across shards. Replaces the
  // legacy `updateTopBids` single-doc transaction that hot-spotted the round
  // doc and corrupted state at >10 concurrent bidders. Non-fatal: a failed
  // shard write only delays the live UI for this team's bid until they
  // re-submit; the source-of-truth `players/{uid}/bids/{round}` doc is
  // already committed by the transaction above.
  if (
    _submitBids_round !== null
    && _submitBids_validated !== null
    && _submitBids_teamKey
  ) {
    try {
      if (bidType === 'ad') {
        await writeAdBidsToShard(
          gameRef, _submitBids_round, _submitBids_teamKey, _submitBids_validated,
        );
      } else {
        await writeChefBidsToShard(
          gameRef, _submitBids_round, _submitBids_teamKey, _submitBids_validated,
        );
      }
    } catch (err) {
      logger.warn('writeBidsToShard side-effect failed — non-fatal.', {
        gameId: gameRef.id,
        round: _submitBids_round,
        bidType,
        teamKey: _submitBids_teamKey,
        error: err && err.message,
      });
    }
  }

  // BE-22: mirror submission state for professor dashboard
  if (_submitBids_round !== null) {
    const phase = bidType === 'ad' ? 'bid_ad' : 'bid_chef';
    await recordSubmission(
      gameRef, `round_${_submitBids_round}_${phase}`, uid,
      _submitBids_displayName, _submitBids_role
    );
  }

  return { gameId, playerId: uid, bidType, submitted: true };
});

// ===========================================================================
// layoffChef
// ===========================================================================

exports.layoffChef = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request);
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const chefId = cleanString(data.chefId);
  if (!chefId) throw new HttpsError('invalid-argument', 'chefId is required.');

  const uid = auth.uid;
  const gameRef = gameDoc(gameId);
  const playerRef = gameRef.collection('players').doc(uid);

  await db.runTransaction(async (transaction) => {
    // LOGIC-1 fix: read config to get specialtyChefCap instead of hardcoding 3.
    const [gSnap, pSnap, cfgSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(playerRef),
      transaction.get(gameRef.collection('config').doc('params')),
    ]);
    if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found.');
    if (!pSnap.exists) throw new HttpsError('failed-precondition', 'Player not in this game.');

    // BE-21 / FE-I15: operations role (or solo) required to manage
    // roster — or any teammate when no one on the team holds operations.
    await assertRoleAllowedWithTeam(transaction, gameRef, pSnap, ['operations']);

    const game = gSnap.data();
    const { phase } = parsePhase(game.phase, game.currentRound || game.round);
    if (phase !== 'roster') {
      throw new HttpsError('failed-precondition', 'Chefs can only be laid off during the roster phase.');
    }

    const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
    const specialtyChefCap = numberOrDefault(config.specialtyChefCap, 3);
    const player = pSnap.data();
    const teamId = getPlayerTeamId(player);
    const teamPlayerDocs = teamId
      ? (await transaction.get(gameRef.collection('players').where('teamId', '==', teamId))).docs
      : [pSnap];
    const specialtyChefs = Array.isArray(player.specialtyChefs) ? player.specialtyChefs : [];
    const idx = specialtyChefs.findIndex((c) => c && c.id === chefId);
    if (idx === -1) {
      throw new HttpsError('not-found', 'Chef not on your roster.');
    }

    const removed = specialtyChefs[idx];
    const remaining = specialtyChefs.slice(0, idx).concat(specialtyChefs.slice(idx + 1));

    const round = numberOrDefault(game.currentRound || game.round, 1);
    const returnPoolRef = gameRef
      .collection('rounds')
      .doc(`round_${round}`)
      .collection('chefReturnPool')
      .doc(chefId);

    transaction.set(returnPoolRef, {
      ...removed,
      returnedByPlayerId: uid,
      returnedAt: FieldValue.serverTimestamp(),
    });

    for (const teamPlayerDoc of teamPlayerDocs) {
      transaction.update(teamPlayerDoc.ref, {
        specialtyChefs: remaining,
        pendingRosterAction: remaining.length > specialtyChefCap,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });

  return { gameId, chefId, laidOff: true };
});

// ===========================================================================
// layoffChefs (M-13)
// ===========================================================================
//
// Batch lay-off variant of layoffChef. Accepts an array of chefIds and writes
// every chef to the chefReturnPool + the team's specialtyChefs update inside
// a single transaction so concurrent layoffs by teammates can't drift the
// roster between reads and writes. Mirrors the auth + phase + cap rules of
// the single-chef callable. Scott consumes this from the FE for the new
// "Lay offs" panel UX (S-05).

exports.layoffChefs = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request);
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const rawChefIds = Array.isArray(data.chefIds) ? data.chefIds : null;
  if (!rawChefIds || rawChefIds.length === 0) {
    throw new HttpsError('invalid-argument', 'chefIds must be a non-empty array.');
  }
  const chefIds = [];
  const seen = new Set();
  for (const c of rawChefIds) {
    const id = cleanString(c);
    if (!id) {
      throw new HttpsError('invalid-argument', 'chefIds entries must be non-empty strings.');
    }
    if (!seen.has(id)) {
      seen.add(id);
      chefIds.push(id);
    }
  }

  const uid = auth.uid;
  const gameRef = gameDoc(gameId);
  const playerRef = gameRef.collection('players').doc(uid);

  let _laidOffCount = 0;

  await db.runTransaction(async (transaction) => {
    const [gSnap, pSnap, cfgSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(playerRef),
      transaction.get(gameRef.collection('config').doc('params')),
    ]);
    if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found.');
    if (!pSnap.exists) throw new HttpsError('failed-precondition', 'Player not in this game.');

    await assertRoleAllowedWithTeam(transaction, gameRef, pSnap, ['operations']);

    const game = gSnap.data();
    const { phase } = parsePhase(game.phase, game.currentRound || game.round);
    if (phase !== 'roster') {
      throw new HttpsError('failed-precondition', 'Chefs can only be laid off during the roster phase.');
    }

    const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
    const specialtyChefCap = numberOrDefault(config.specialtyChefCap, 3);
    const player = pSnap.data();
    const teamId = getPlayerTeamId(player);
    const teamPlayerDocs = teamId
      ? (await transaction.get(gameRef.collection('players').where('teamId', '==', teamId))).docs
      : [pSnap];
    const specialtyChefs = Array.isArray(player.specialtyChefs) ? player.specialtyChefs : [];
    const round = numberOrDefault(game.currentRound || game.round, 1);

    // All-or-nothing: validate every requested chef before any writes so
    // partial failures can't leave the roster in an unexpected state.
    const removed = [];
    for (const chefId of chefIds) {
      const chef = specialtyChefs.find((c) => c && c.id === chefId);
      if (!chef) {
        throw new HttpsError('not-found', `Chef ${chefId} not on your roster.`);
      }
      removed.push(chef);
    }
    const removedIds = new Set(chefIds);
    const remaining = specialtyChefs.filter(
      (c) => !c || !removedIds.has(c.id),
    );

    for (const chef of removed) {
      const returnPoolRef = gameRef
        .collection('rounds')
        .doc(`round_${round}`)
        .collection('chefReturnPool')
        .doc(chef.id);
      transaction.set(returnPoolRef, {
        ...chef,
        returnedByPlayerId: uid,
        returnedAt: FieldValue.serverTimestamp(),
      });
    }

    for (const teamPlayerDoc of teamPlayerDocs) {
      transaction.update(teamPlayerDoc.ref, {
        specialtyChefs: remaining,
        pendingRosterAction: remaining.length > specialtyChefCap,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    _laidOffCount = removed.length;
  });

  return { gameId, chefIds, laidOffCount: _laidOffCount };
});

// ===========================================================================
// reclaimTeammateRole (M-10)
// ===========================================================================
//
// Allows any teammate to clear `roleAssignments[targetUid]` on the team doc
// when the target's presence has gone stale or their player doc is flagged
// disconnected. Without this, a closed-tab teammate's specialist role
// stays locked on the team forever and the remaining teammates can't take
// over the corresponding submit button.

const PRESENCE_STALE_MS = 60_000;

exports.reclaimTeammateRole = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in to reclaim a teammate role.');
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const teamId = cleanString(data.teamId);
  const targetUid = cleanString(data.targetUid);
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required.');
  if (!targetUid) throw new HttpsError('invalid-argument', 'targetUid is required.');
  if (targetUid === auth.uid) {
    throw new HttpsError('invalid-argument', 'Cannot reclaim your own role — clear it via setTeamRole.');
  }

  const uid = auth.uid;
  const gameRef = gameDoc(gameId);
  const teamRef = gameRef.collection('teams').doc(teamId);
  const callerRef = gameRef.collection('players').doc(uid);
  const targetPlayerRef = gameRef.collection('players').doc(targetUid);
  const targetPresenceRef = gameRef.collection('presence').doc(targetUid);

  await db.runTransaction(async (transaction) => {
    const [gSnap, callerSnap, teamSnap, targetSnap, presenceSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(callerRef),
      transaction.get(teamRef),
      transaction.get(targetPlayerRef),
      transaction.get(targetPresenceRef),
    ]);

    if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found.');
    if (!callerSnap.exists) {
      throw new HttpsError('failed-precondition', 'Join the game before reclaiming a role.');
    }
    if (!teamSnap.exists) {
      throw new HttpsError('not-found', 'Team not found.');
    }
    const callerTeamId = getPlayerTeamId(callerSnap.data());
    if (callerTeamId !== teamId) {
      throw new HttpsError('permission-denied', 'You can only reclaim a role on your own team.');
    }

    // Eligibility: presence stale OR disconnected flag set on the target's
    // player doc. The disconnected flag is set by the simulation when a
    // player misses two consecutive rounds (BE-19); presence is set when
    // their tab closes / backgrounds for > 60s.
    const lastSeenAt = presenceSnap.exists ? presenceSnap.get('lastSeenAt') : null;
    const lastSeenMs = lastSeenAt && typeof lastSeenAt.toMillis === 'function'
      ? lastSeenAt.toMillis()
      : 0;
    const presenceStale = lastSeenMs > 0
      ? (Timestamp.now().toMillis() - lastSeenMs) > PRESENCE_STALE_MS
      : true; // no presence doc → treat as stale (never connected this session)
    const targetDisconnected = targetSnap.exists
      && targetSnap.get('disconnected') === true;

    if (!presenceStale && !targetDisconnected) {
      throw new HttpsError(
        'failed-precondition',
        'That teammate is still connected. Wait 60s after they leave before reclaiming.',
      );
    }

    const teamData = teamSnap.data() || {};
    const roleAssignments = teamData.roleAssignments || {};
    if (roleAssignments[targetUid] === undefined || roleAssignments[targetUid] === null) {
      // Idempotent — no role to clear, return success rather than error.
      return;
    }

    transaction.update(teamRef, {
      [`roleAssignments.${targetUid}`]: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { gameId, teamId, targetUid, reclaimed: true };
});

// ===========================================================================
// continueFromRoster
// ===========================================================================

exports.continueFromRoster = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request);
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const uid = auth.uid;

  const gameRef = gameDoc(gameId);
  const playerRef = gameRef.collection('players').doc(uid);

  let _roster_round = null;
  let _roster_role = null;
  let _roster_displayName = '';

  await db.runTransaction(async (transaction) => {
    // MED-05 fix: read game doc to validate phase is 'roster'.
    // LOGIC-1 fix: read config for specialtyChefCap instead of hardcoding 3.
    const [gSnap, pSnap, cfgSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(playerRef),
      transaction.get(gameRef.collection('config').doc('params')),
    ]);
    if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found.');
    if (!pSnap.exists) throw new HttpsError('failed-precondition', 'Player not in this game.');

    // BE-21 / FE-I15: operations role (or solo) required to complete
    // roster — or any teammate when no one on the team holds operations.
    await assertRoleAllowedWithTeam(transaction, gameRef, pSnap, ['operations']);

    const game = gSnap.data();
    const { phase } = parsePhase(game.phase, game.currentRound || game.round);
    if (phase !== 'roster') {
      throw new HttpsError('failed-precondition', 'Roster actions are only allowed during the roster phase.');
    }

    const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
    const specialtyChefCap = numberOrDefault(config.specialtyChefCap, 3);

    const player = pSnap.data();
    const count = Array.isArray(player.specialtyChefs) ? player.specialtyChefs.length : 0;
    if (count > specialtyChefCap) {
      throw new HttpsError('failed-precondition',
        `Lay off chefs until you have at most ${specialtyChefCap}.`);
    }

    _roster_round = numberOrDefault(game.currentRound || game.round, 1);
    _roster_role = pSnap.get('role') || null;
    _roster_displayName = pSnap.get('displayName') || '';

    transaction.update(playerRef, {
      pendingRosterAction: false,
      rosterCompleted: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  // BE-22: mirror roster-complete submission for professor dashboard
  if (_roster_round !== null) {
    await recordSubmission(
      gameRef, `round_${_roster_round}_roster`, uid,
      _roster_displayName, _roster_role
    );
  }

  return { gameId, playerId: uid, rosterCompleted: true };
});

// ===========================================================================
// pauseGame / resumeGame
// ===========================================================================

async function setPausedFlag(request, paused) {
  const auth = requireAuth(request);
  const gameId = cleanGameId((request.data || {}).gameId);
  const gameRef = gameDoc(gameId);

  // CRIT-06 fix: wrap read + permission check + write in a Firestore
  // transaction to eliminate the stale-read race between get() and update().
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(gameRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Game not found.');
    if (snap.get('professorUid') !== auth.uid && snap.get('professorId') !== auth.uid) {
      throw new HttpsError('permission-denied', 'Only the professor can pause/resume.');
    }

    const update = {
      paused,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (paused) {
      // Snapshot current deadline so we can restore remaining time on resume.
      const currentEndsAt = snap.get('phaseEndsAt');
      update.pausedAt = FieldValue.serverTimestamp();
      update.pausedPhaseEndsAt = currentEndsAt || null;
      // Null out the deadline so the frontend timer stops.
      update.phaseEndsAt = null;
    } else {
      // Restore remaining time: new deadline = now + (pausedPhaseEndsAt - pausedAt).
      const pausedAt = snap.get('pausedAt');
      const pausedEndsAt = snap.get('pausedPhaseEndsAt');
      if (pausedAt && pausedEndsAt) {
        const pausedAtMs = pausedAt.toMillis();
        const endsAtMs = pausedEndsAt.toMillis();
        const remainingMs = Math.max(0, endsAtMs - pausedAtMs);
        update.phaseEndsAt = Timestamp.fromMillis(Date.now() + remainingMs);
      }
      update.pausedAt = null;
      update.pausedPhaseEndsAt = null;
    }

    transaction.update(gameRef, update);
  });

  return { gameId, paused };
}

exports.pauseGame  = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  return setPausedFlag(request, true);
});
exports.resumeGame = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  return setPausedFlag(request, false);
});

// ===========================================================================
// endGame — force transition to game_over
// ===========================================================================

exports.endGame = onCall(HEAVY_CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request);
  const gameId = cleanGameId((request.data || {}).gameId);
  const gameRef = gameDoc(gameId);

  // RACE-1 fix: wrap permission check + phase guard + phase write in a
  // transaction to prevent double-end from concurrent professor clicks.
  let config = null;
  let totalRounds = 5;
  let alreadyEnded = false;

  await db.runTransaction(async (transaction) => {
    const [gSnap, cfgSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(gameRef.collection('config').doc('params')),
    ]);
    if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found.');
    if (gSnap.get('professorUid') !== auth.uid && gSnap.get('professorId') !== auth.uid) {
      throw new HttpsError('permission-denied', 'Only the professor can end this game.');
    }

    config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
    totalRounds = numberOrDefault(gSnap.get('totalRounds'), config.totalRounds);

    if (gSnap.get('phase') === 'game_over') {
      alreadyEnded = true;
      return; // skip write; handle conclusion check outside transaction
    }

    transaction.update(gameRef, {
      phase: 'game_over',
      phaseEndsAt: null,
      endedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  // If game was already game_over, check if conclusion exists.
  if (alreadyEnded) {
    const conclusionSnap = await gameRef.collection('conclusion').doc('final').get();
    if (conclusionSnap.exists) {
      return { gameId, phase: 'game_over', alreadyEnded: true };
    }
    logger.warn('endGame: game_over but no conclusion — recomputing.', { gameId });
    await persistConclusion(gameRef, totalRounds, config);
    return { gameId, phase: 'game_over', conclusionRecomputed: true };
  }

  // Compute conclusion after transaction (expensive, side-effect).
  await persistConclusion(gameRef, totalRounds, config);

  return { gameId, phase: 'game_over' };
});

// ===========================================================================
// getConclusion — return cached conclusion
// ===========================================================================

exports.getConclusion = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in to view game results.');
  const gameId = cleanGameId((request.data || {}).gameId);
  const gameRef = gameDoc(gameId);

  // HIGH-02 fix: verify caller is either the professor or a player in this game.
  const [gameSnap, playerSnap] = await Promise.all([
    gameRef.get(),
    gameRef.collection('players').doc(auth.uid).get(),
  ]);
  if (!gameSnap.exists) throw new HttpsError('not-found', 'Game not found.');
  const isProfessor =
    gameSnap.get('professorUid') === auth.uid ||
    gameSnap.get('professorId') === auth.uid;
  if (!isProfessor && !playerSnap.exists) {
    throw new HttpsError('permission-denied', 'You are not a participant in this game.');
  }

  const snap = await gameRef.collection('conclusion').doc('final').get();
  if (!snap.exists) {
    throw new HttpsError('failed-precondition', 'Conclusion not yet available.');
  }
  return { gameId, conclusion: snap.data() };
});

// ===========================================================================
// exportPlayerCsv — player downloads their own round-by-round CSV
// ===========================================================================

exports.exportPlayerCsv = onCall(HEAVY_CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in to export your data.');
  const gameId = cleanGameId((request.data || {}).gameId);
  const gameRef = gameDoc(gameId);

  // Verify player belongs to this game.
  const playerSnap = await gameRef.collection('players').doc(auth.uid).get();
  if (!playerSnap.exists) {
    throw new HttpsError('not-found', 'Player not found in this game.');
  }

  // Read all CSV row documents for this player, sorted by round.
  const csvSnap = await gameRef
    .collection('csvRows')
    .doc(auth.uid)
    .collection('rounds')
    .orderBy('round', 'asc')
    .get();

  if (csvSnap.empty) {
    throw new HttpsError('failed-precondition', 'No round data available yet.');
  }

  const rows = csvSnap.docs.map((doc) => doc.data().row).filter(Boolean);
  const csvString = buildCsvString(rows, false);

  return {
    gameId,
    playerId: auth.uid,
    csv: csvString,
    roundCount: rows.length,
  };
});

// ===========================================================================
// exportProfessorCsv — professor downloads class-wide CSV with player names
// ===========================================================================

exports.exportProfessorCsv = onCall(HEAVY_CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in to export class data.');
  const gameId = cleanGameId((request.data || {}).gameId);
  const gameRef = gameDoc(gameId);

  // Verify caller is the professor.
  const gameSnap = await gameRef.get();
  if (!gameSnap.exists) throw new HttpsError('not-found', 'Game not found.');
  if (gameSnap.get('professorUid') !== auth.uid && gameSnap.get('professorId') !== auth.uid) {
    throw new HttpsError('permission-denied', 'Only the professor can export class data.');
  }

  // Read all players.
  const playersSnap = await gameRef.collection('players').get();
  const allRows = [];

  // HIGH-03 fix: parallelize CSV row reads instead of serial O(N) loop.
  const csvSnapResults = await Promise.all(
    playersSnap.docs.map((pd) =>
      gameRef
        .collection('csvRows')
        .doc(pd.id)
        .collection('rounds')
        .orderBy('round', 'asc')
        .get()
    )
  );

  playersSnap.docs.forEach((playerDoc, i) => {
    const p = playerDoc.data() || {};
    const csvSnap = csvSnapResults[i];
    for (const rowDoc of csvSnap.docs) {
      const row = rowDoc.data().row;
      if (row) {
        row.player_id = playerDoc.id;
        row.bakery_name = p.bakeryName || '';
        row.display_name = p.displayName || '';
        allRows.push(row);
      }
    }
  });

  if (allRows.length === 0) {
    throw new HttpsError('failed-precondition', 'No round data available yet.');
  }

  // Sort by player then round for clean output.
  allRows.sort((a, b) => {
    if (a.player_id < b.player_id) return -1;
    if (a.player_id > b.player_id) return 1;
    return (a.round || 0) - (b.round || 0);
  });

  const csvString = buildCsvString(allRows, true);

  return {
    gameId,
    csv: csvString,
    playerCount: playersSnap.size,
    rowCount: allRows.length,
  };
});

// ===========================================================================
// onDecisionSubmitted — Firestore trigger
// ===========================================================================

/**
 * Observational trigger: when a player's decision is written, log that the
 * submission landed. The actual simulation is triggered by the professor
 * advancing through the phase state machine.
 *
 * CRIT-01 / MED-12 / HIGH-08 fix: this trigger does not write
 * `submittedCount` to the game doc — only `onSubmittedCountShardWritten`
 * does, by aggregating sharded uid intake docs. Concurrent submissions
 * stay race-safe because each shard write is keyed by uid (idempotent)
 * and the aggregator is gated on the round from the shard's path.
 */
exports.onDecisionSubmitted = onDocumentCreated(
  'games/{gameId}/players/{playerId}/decisions/{roundId}',
  async (event) => {
    const { gameId, playerId, roundId } = event.params;
    const match = /^round_(\d+)$/.exec(roundId);
    if (!match) {
      logger.warn('Decision with invalid roundId ignored.', { gameId, roundId });
      return;
    }
    const round = Number(match[1]);
    const gameRef = gameDoc(gameId);

    try {
      const [gSnap, playersSnap] = await Promise.all([
        gameRef.get(),
        gameRef.collection('players').get(),
      ]);
      if (!gSnap.exists) return;

      const game = gSnap.data();
      const currentRound = numberOrDefault(game.currentRound || game.round, 0);
      if (currentRound !== round) {
        logger.info('Decision for non-current round; ignoring.', {
          gameId, playerId, round, currentRound,
        });
        return;
      }

      // `game.submittedCount` is now eventually-consistent via
      // `onSubmittedCountShardWritten`, so we don't compute `allSubmitted`
      // here — it would be off-by-N depending on trigger ordering. The
      // aggregator is the source of truth for the count.
      logger.info('Decision submitted.', {
        gameId,
        playerId,
        round,
        totalPlayers: playersSnap.size,
      });
    } catch (err) {
      logger.error('onDecisionSubmitted failure.', {
        gameId, playerId, round, error: err && err.message,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// onTopBidsShardWritten — aggregate sharded bids into rounds/{round}.topBids
//
// Each `submitBids` call writes to one shard under
// `rounds/{round}/topBidsShards/{idx}`. This trigger watches those shard
// writes and recomputes the public top-bids aggregate that the FE listens
// to. Running with `concurrency: 1` (single instance, single in-flight
// invocation) serialises the round-doc writes so they don't pile up under
// the per-document write throttle when 25 teams bid in the same window.
// `recomputeAndCacheTopBids` skips the write when the aggregate is
// unchanged, so a burst of N shard writes resolves to ≤N round-doc writes
// (and usually far fewer once the leader stabilises).
// ---------------------------------------------------------------------------
exports.onTopBidsShardWritten = onDocumentWritten(
  {
    document: 'games/{gameId}/rounds/{roundId}/topBidsShards/{shardIdx}',
    concurrency: 1,
  },
  async (event) => {
    const { gameId, roundId } = event.params;
    const match = /^round_(\d+)$/.exec(roundId);
    if (!match) return;
    const round = Number(match[1]);
    const gameRef = gameDoc(gameId);
    try {
      await recomputeAndCacheTopBids(gameRef, round);
    } catch (err) {
      logger.warn('onTopBidsShardWritten aggregation failed — non-fatal.', {
        gameId, round, error: err && err.message,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// onSubmissionShardWritten — aggregate sharded submission records into the
// public `submissions/{docId}` + `submissionCounts/{docId}` docs that the FE
// (SubmissionLock) and professor dashboard already listen to. Same `concurrency: 1`
// + skip-no-op pattern as `onTopBidsShardWritten`. See `modules/sharded-submissions.js`.
// ---------------------------------------------------------------------------
exports.onSubmissionShardWritten = onDocumentWritten(
  {
    document: 'games/{gameId}/submissions/{submissionDocId}/shards/{shardIdx}',
    concurrency: 1,
  },
  async (event) => {
    const { gameId, submissionDocId } = event.params;
    const gameRef = gameDoc(gameId);
    try {
      await recomputeAndCacheSubmissions(gameRef, submissionDocId);
    } catch (err) {
      logger.warn('onSubmissionShardWritten aggregation failed — non-fatal.', {
        gameId, submissionDocId, error: err && err.message,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// onSubmittedCountShardWritten — aggregate sharded uid sets into the game
// doc's `submittedCount` field. Each `submitDecision` writes to one shard
// under `submittedCountShards/round_{N}/shards/{idx}`; this trigger recounts
// THAT round's shards (parsed from the path, not the live game doc) and
// writes to `game.submittedCount` only if the game is still on that round.
// Same `concurrency: 1` + skip-no-op pattern as `onTopBidsShardWritten`.
// See `modules/sharded-counter.js`.
// ---------------------------------------------------------------------------
exports.onSubmittedCountShardWritten = onDocumentWritten(
  {
    document: 'games/{gameId}/submittedCountShards/{roundDocId}/shards/{shardIdx}',
    concurrency: 1,
  },
  async (event) => {
    const { gameId, roundDocId } = event.params;
    const match = /^round_(\d+)$/.exec(roundDocId);
    if (!match) return;
    const round = Number(match[1]);
    const gameRef = gameDoc(gameId);
    try {
      await recomputeAndCacheSubmittedCount(gameRef, round);
    } catch (err) {
      logger.warn('onSubmittedCountShardWritten aggregation failed — non-fatal.', {
        gameId, round, error: err && err.message,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// updateTeamName — any team member may rename their team.
// ---------------------------------------------------------------------------
exports.updateTeamName = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Must be signed in.');

  const gameId   = cleanGameId(request.data && request.data.gameId);
  const teamId   = cleanString(request.data && request.data.teamId);
  const name     = cleanString(request.data && request.data.name);

  if (!gameId) throw new HttpsError('invalid-argument', 'gameId is required.');
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required.');
  if (!name)   throw new HttpsError('invalid-argument', 'name is required.');
  if (name.length > 64) throw new HttpsError('invalid-argument', 'name must be 64 characters or fewer.');

  const teamRef   = db.collection('games').doc(gameId).collection('teams').doc(teamId);
  const playerRef = db.collection('games').doc(gameId).collection('players').doc(auth.uid);

  await db.runTransaction(async (tx) => {
    const [teamSnap, playerSnap] = await Promise.all([
      tx.get(teamRef),
      tx.get(playerRef),
    ]);

    if (!teamSnap.exists)   throw new HttpsError('not-found', 'Team not found.');
    if (!playerSnap.exists) throw new HttpsError('not-found', 'You are not in this game.');

    const roleAssignments = (teamSnap.data() || {}).roleAssignments || {};
    if (!(auth.uid in roleAssignments)) {
      throw new HttpsError('permission-denied', 'You are not a member of this team.');
    }

    tx.update(teamRef, { name, updatedAt: FieldValue.serverTimestamp() });
  });

  return { success: true };
});

// ---------------------------------------------------------------------------
// setTeamRole — assign a role to the calling player within their team.
//
// Rules:
//   • Rejects if another teammate already holds the requested role.
//   • Overwrites the caller's previous role (clearing it for others).
//   • Writes roleAssignments[uid] = role on the team doc.
//   • Mirrors the same value onto players/{uid}.role so role-gated submits
//     keep working without reading the teams collection.
// ---------------------------------------------------------------------------
exports.setTeamRole = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Must be signed in.');

  const gameId = cleanGameId(request.data && request.data.gameId);
  const teamId = cleanString(request.data && request.data.teamId);
  // BE-I13: accept null / "" / "unassigned" as an explicit clear signal.
  // The FE's "× Clear" button sends `role: null`; `cleanString(null)`
  // returns "", so we branch on the empty case before the `!role` guard
  // below rejects it.
  const rawRole = request.data && request.data.role;
  const role = cleanString(rawRole);
  const isClear =
    rawRole === null || role === '' || role === 'unassigned';

  if (!gameId) throw new HttpsError('invalid-argument', 'gameId is required.');
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required.');
  if (!isClear && !role)   throw new HttpsError('invalid-argument', 'role is required.');

  const teamRef   = db.collection('games').doc(gameId).collection('teams').doc(teamId);
  const playerRef = db.collection('games').doc(gameId).collection('players').doc(auth.uid);

  await db.runTransaction(async (tx) => {
    const [teamSnap, playerSnap] = await Promise.all([
      tx.get(teamRef),
      tx.get(playerRef),
    ]);

    if (!teamSnap.exists)   throw new HttpsError('not-found', 'Team not found.');
    if (!playerSnap.exists) throw new HttpsError('not-found', 'You are not in this game.');

    const roleAssignments = (teamSnap.data() || {}).roleAssignments || {};

    if (!(auth.uid in roleAssignments)) {
      throw new HttpsError('permission-denied', 'You are not a member of this team.');
    }

    if (isClear) {
      // Clearing: null out the team assignment and drop the player's
      // mirrored role. `solo` is the safe post-clear default on the
      // player doc — `assertRoleAllowed` treats it as "no gate", which
      // matches the UX expectation that a cleared player is back to
      // "can do anything" until they pick again.
      tx.update(teamRef, {
        [`roleAssignments.${auth.uid}`]: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(playerRef, { role: 'solo' });
      return;
    }

    // Reject if another teammate already holds this role.
    for (const [uid, existingRole] of Object.entries(roleAssignments)) {
      if (uid !== auth.uid && existingRole === role) {
        throw new HttpsError('already-exists', `Role "${role}" is already held by another teammate.`);
      }
    }

    tx.update(teamRef, {
      [`roleAssignments.${auth.uid}`]: role,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(playerRef, { role });
  });

  return { success: true };
});

// ===========================================================================
// extendPhase — BE-N02: professor extends the active phase timer
// ===========================================================================

exports.extendPhase = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const extraSeconds = data.extraSeconds;
  if (!gameId || typeof extraSeconds !== "number") {
    throw new HttpsError("invalid-argument", "gameId and extraSeconds are required.");
  }
  if (!Number.isFinite(extraSeconds) || extraSeconds <= 0) {
    throw new HttpsError("invalid-argument", "extraSeconds must be a positive number.");
  }
  const cappedExtra = Math.min(extraSeconds, 300);
  const gameRef = gameDoc(gameId);
  const gameSnap = await gameRef.get();
  if (!gameSnap.exists) throw new HttpsError("not-found", "Game not found.");
  const game = gameSnap.data();
  const isProfessor = request.auth.uid === game.professorUid ||
    (request.auth.token && request.auth.token.professor === true);
  if (!isProfessor) throw new HttpsError("permission-denied", "Professors only.");
  const terminalPhases = ["lobby", "game_over", "simulating"];
  if (terminalPhases.includes(game.phase)) {
    throw new HttpsError("failed-precondition", "Cannot extend this phase.");
  }
  if (!game.phaseEndsAt) throw new HttpsError("failed-precondition", "No active timer.");
  const currentEnd = game.phaseEndsAt.toMillis();
  const newEnd = Timestamp.fromMillis(currentEnd + cappedExtra * 1000);
  await gameRef.update({ phaseEndsAt: newEnd });
  return { success: true, newPhaseEndsAt: newEnd.toMillis() };
});

// ===========================================================================
// purchaseCompetitorInsight — BE-N03: player purchases competitor decisions CSV
// ===========================================================================

exports.purchaseCompetitorInsight = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const round = data.round;
  if (!gameId || typeof round !== "number") {
    throw new HttpsError("invalid-argument", "gameId and round are required.");
  }
  const uid = request.auth.uid;
  const gameRef = gameDoc(gameId);
  const gameSnap = await gameRef.get();
  if (!gameSnap.exists) throw new HttpsError("not-found", "Game not found.");
  const game = gameSnap.data();
  const currentPhase = typeof game.phase === "string" ? game.phase : "";
  if (!currentPhase.includes("decide")) {
    throw new HttpsError("failed-precondition", "Competitor insight only available during Decisions phase.");
  }
  if (round < 1 || round >= (game.currentRound || 1)) {
    throw new HttpsError("invalid-argument", "Can only purchase insight for a completed round.");
  }

  const configSnap = await gameRef.collection("config").doc("params").get();
  const config = configSnap.exists ? configSnap.data() : {};
  const insightCost = numberOrDefault(config.competitorInsightCost, 100);

  await db.runTransaction(async (tx) => {
    const playerRef = gameRef.collection("players").doc(uid);
    const playerSnap = await tx.get(playerRef);
    if (!playerSnap.exists) throw new HttpsError("not-found", "Player not found.");
    const player = playerSnap.data();
    const budget = player.budgetCurrent || 0;
    if (budget < insightCost) {
      throw new HttpsError("failed-precondition", "Insufficient budget to purchase competitor insight.");
    }
    tx.update(playerRef, { budgetCurrent: FieldValue.increment(-insightCost) });
    tx.set(
      playerRef.collection("purchases").doc(`insight_round_${round}`),
      { round, costDeducted: insightCost, purchasedAt: FieldValue.serverTimestamp() }
    );
  });

  // Collect all player decisions for the requested round.
  const playersSnap = await gameRef.collection("players").get();
  const rows = [];
  rows.push("team_name,product,quantity,price");
  for (const pDoc of playersSnap.docs) {
    const pData = pDoc.data();
    const teamName = pData.displayName || pDoc.id;
    const decisionSnap = await pDoc.ref.collection("decisions").doc(`round_${round}`).get();
    if (!decisionSnap.exists) continue;
    const dec = decisionSnap.data();
    const quantities = dec.quantities || {};
    const prices = dec.productPrices || {};
    for (const [product, qty] of Object.entries(quantities)) {
      if (typeof qty === "number" && qty > 0) {
        const price = prices[product] || 0;
        rows.push(`"${teamName}",${product},${qty},${price}`);
      }
    }
  }

  return { csv: rows.join("\n"), costDeducted: insightCost };
});

// ===========================================================================
// purchaseChefData — Tier 1 / Tier 2 chef data CSVs
//
// Tier 1 (chefDataTier1Cost, default $50): static nationality → specialty-
// product map. Reveals which cuisines lift which products — always the same
// payload, independent of the current round's generated pool.
//
// Tier 2 (chefDataTier2Cost, default $150): full per-chef dump for the
// current round's chef pool (name, nationality, gender, skill tier,
// specialties, min bid floor) so a team can evaluate every candidate
// before the chef auction resolves.
//
// Purchases are recorded at `players/{uid}/purchases/chef_tier{1|2}` and
// the transaction rejects re-buying the same tier, so the total cost is
// bounded even if the UI re-enables the button.
// ===========================================================================
exports.purchaseChefData = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const tier = data.tier;
  if (!gameId || (tier !== 1 && tier !== 2)) {
    throw new HttpsError("invalid-argument", "gameId and tier (1 or 2) are required.");
  }
  const uid = request.auth.uid;
  const gameRef = gameDoc(gameId);
  const gameSnap = await gameRef.get();
  if (!gameSnap.exists) throw new HttpsError("not-found", "Game not found.");
  const game = gameSnap.data();
  const currentPhase = typeof game.phase === "string" ? game.phase : "";
  if (!currentPhase.includes("decide")) {
    throw new HttpsError("failed-precondition", "Chef data only available during Decisions phase.");
  }

  const configSnap = await gameRef.collection("config").doc("params").get();
  const config = configSnap.exists ? configSnap.data() : {};
  const tier1Cost = numberOrDefault(config.chefDataTier1Cost, 50);
  const tier2Cost = numberOrDefault(config.chefDataTier2Cost, 150);
  const cost = tier === 1 ? tier1Cost : tier2Cost;

  await db.runTransaction(async (tx) => {
    const playerRef = gameRef.collection("players").doc(uid);
    const purchaseRef = playerRef.collection("purchases").doc(`chef_tier${tier}`);
    const [playerSnap, purchaseSnap] = await Promise.all([
      tx.get(playerRef),
      tx.get(purchaseRef),
    ]);
    if (!playerSnap.exists) throw new HttpsError("not-found", "Player not found.");
    if (purchaseSnap.exists) {
      throw new HttpsError("already-exists", `Tier ${tier} chef data already purchased.`);
    }
    const player = playerSnap.data();
    const budget = player.budgetCurrent || 0;
    if (budget < cost) {
      throw new HttpsError("failed-precondition", `Insufficient budget to purchase Tier ${tier} chef data.`);
    }
    tx.update(playerRef, { budgetCurrent: FieldValue.increment(-cost) });
    tx.set(purchaseRef, {
      tier,
      costDeducted: cost,
      purchasedAt: FieldValue.serverTimestamp(),
    });
  });

  const rows = [];
  if (tier === 1) {
    rows.push("nationality,specialties");
    for (const [nationality, data] of Object.entries(CHEF_NATIONALITIES)) {
      const specs = Array.isArray(data.specialties) ? data.specialties.join(";") : "";
      rows.push(`${nationality},"${specs}"`);
    }
  } else {
    rows.push("chef_id,name,nationality,gender,skill_tier,specialties,min_bid_floor");
    const round = game.currentRound || 1;
    const roundSnap = await gameRef.collection("rounds").doc(`round_${round}`).get();
    const pool = (roundSnap.exists && Array.isArray(roundSnap.data().chefPool))
      ? roundSnap.data().chefPool
      : [];
    for (const chef of pool) {
      const specs = Array.isArray(chef.specialties) ? chef.specialties.join(";") : "";
      rows.push([
        chef.id || "",
        `"${String(chef.name || "").replace(/"/g, '""')}"`,
        chef.nationality || "",
        chef.gender || "",
        chef.skillTier || "",
        `"${specs}"`,
        numberOrDefault(chef.minBidFloor, 0),
      ].join(","));
    }
  }

  return { csv: rows.join("\n"), costDeducted: cost, tier };
});

// ===========================================================================
// purchaseProduct — Apr 28 2026
//
// Each station starts with one product unlocked (BASE_MENU). The other
// product per station lives in OPTIONAL_MENU and must be purchased before
// the team can put it on their menu. Every unlock costs the same flat
// amount — see `productUnlockCost` in config.js (default $500).
//
// Storage:
//   - team doc gains `unlockedProducts: string[]` and `unlocksPurchased: number`.
//     The team doc is readable by any signed-in user (firestore.rules), so
//     teammates and opponents can see who has the full menu unlocked.
//   - cost is deducted from the *caller's* `budgetCurrent` (mirrors the
//     existing `purchaseCompetitorInsight` / `purchaseChefData` model).
//
// Authorization: any teammate may unlock — the menu is shared across the
// team, so locking this to a specific role would just create a coordination
// problem (Operations needs Finance to unlock a product before they can
// stock it). The Finance/Operations gate applies to submitting decisions /
// prices, not to spending on shared inventory.
// ===========================================================================
exports.purchaseProduct = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const { gameId: rawGameId, product } = request.data || {};
  const gameId = cleanGameId(rawGameId);
  if (typeof product !== 'string' || !OPTIONAL_MENU.includes(product)) {
    throw new HttpsError(
      'invalid-argument',
      `product must be one of: ${OPTIONAL_MENU.join(', ')}`,
    );
  }
  const uid = request.auth.uid;
  const gameRef = gameDoc(gameId);

  let costDeducted = 0;
  let nextUnlocked = null;
  let nextUnlocksPurchased = 0;

  await db.runTransaction(async (tx) => {
    const playerRef = gameRef.collection('players').doc(uid);
    const cfgRef = gameRef.collection('config').doc('params');
    const [playerSnap, cfgSnap, gameSnap] = await Promise.all([
      tx.get(playerRef),
      tx.get(cfgRef),
      tx.get(gameRef),
    ]);
    if (!gameSnap.exists) throw new HttpsError('not-found', 'Game not found.');
    if (!playerSnap.exists) throw new HttpsError('failed-precondition', 'Join the game before purchasing unlocks.');
    if (gameSnap.get('paused') === true) {
      throw new HttpsError('failed-precondition', 'Game is paused. Purchases are temporarily disabled.');
    }
    const currentPhase = typeof gameSnap.get('phase') === 'string' ? gameSnap.get('phase') : '';
    if (!currentPhase.includes('decide')) {
      throw new HttpsError('failed-precondition', 'Product unlocks only available during Decisions phase.');
    }

    const player = playerSnap.data();
    const teamId = getPlayerTeamId(player);
    if (!teamId) {
      throw new HttpsError('failed-precondition', 'You must be on a team to unlock products.');
    }
    const teamRef = gameRef.collection('teams').doc(teamId);
    const teamSnap = await tx.get(teamRef);
    if (!teamSnap.exists) {
      throw new HttpsError('not-found', 'Team not found.');
    }

    const team = teamSnap.data() || {};
    const currentUnlocked = Array.isArray(team.unlockedProducts) && team.unlockedProducts.length > 0
      ? team.unlockedProducts.filter((p) => typeof p === 'string')
      : [...DEFAULT_UNLOCKED_PRODUCTS];

    if (currentUnlocked.includes(product)) {
      throw new HttpsError('already-exists', `Your team already has "${product}" unlocked.`);
    }

    const unlocksPurchased = numberOrDefault(team.unlocksPurchased, 0);
    const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
    const cost = numberOrDefault(config.productUnlockCost, 500);

    const budget = numberOrDefault(player.budgetCurrent, 0);
    if (budget < cost) {
      throw new HttpsError(
        'failed-precondition',
        `Insufficient budget — unlocking "${product}" costs $${cost.toLocaleString()} but you only have $${budget.toLocaleString()}.`,
      );
    }

    nextUnlocked = [...currentUnlocked, product];
    nextUnlocksPurchased = unlocksPurchased + 1;
    costDeducted = cost;

    tx.update(playerRef, {
      budgetCurrent: FieldValue.increment(-cost),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(teamRef, {
      unlockedProducts: nextUnlocked,
      unlocksPurchased: nextUnlocksPurchased,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      playerRef.collection('purchases').doc(`unlock_${product}`),
      {
        kind: 'product-unlock',
        product,
        costDeducted: cost,
        unlocksPurchasedBefore: unlocksPurchased,
        purchasedAt: FieldValue.serverTimestamp(),
      },
    );
  });

  return {
    product,
    costDeducted,
    unlockedProducts: nextUnlocked,
    unlocksPurchased: nextUnlocksPurchased,
  };
});

// ---------------------------------------------------------------------------
// resetGame — professor-only. Wipes round/sim/leaderboard/conclusion data
// and resets each player to lobby defaults so a class can replay without
// rebuilding the roster. Authorization checks both `professorUid` (canonical)
// and `professorId` (legacy alias) to match createGame's write pattern.
// ---------------------------------------------------------------------------
exports.resetGame = onCall(HEAVY_CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request);
  const gameId = cleanGameId((request.data || {}).gameId);
  const gameRef = gameDoc(gameId);

  const [gameSnap, cfgSnap, playersSnap, teamsSnap] = await Promise.all([
    gameRef.get(),
    gameRef.collection('config').doc('params').get(),
    gameRef.collection('players').get(),
    gameRef.collection('teams').get(),
  ]);

  if (!gameSnap.exists) throw new HttpsError('not-found', 'Game not found.');
  if (
    gameSnap.get('professorUid') !== auth.uid &&
    gameSnap.get('professorId') !== auth.uid
  ) {
    throw new HttpsError('permission-denied', 'Only the professor can reset this game.');
  }

  const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
  const startingBudget = numberOrDefault(
    config.startingBudget,
    DEFAULT_GAME_CONFIG.startingBudget,
  );

  const playerDocs = playersSnap.docs;
  const teamDocs = teamsSnap.docs;

  // Wipe game-level + per-player subcollections in parallel. deleteCollectionDocs
  // chunks at BATCH_OP_LIMIT internally. `rounds`, `submissions`, and
  // `submittedCountShards` use recursiveDelete because they own shard
  // subcollections (`topBidsShards`, `shards`) that would otherwise survive
  // the reset and pollute the next game's aggregate writes. Each team's
  // `state` subcollection holds the T2.2 per-team pending draft and must
  // also be cleared, otherwise stale `decisionDraft.submitted: true` would
  // surface to teammates' UIs in the next game.
  await Promise.all([
    db.recursiveDelete(gameRef.collection('rounds')),
    db.recursiveDelete(gameRef.collection('submissions')),
    db.recursiveDelete(gameRef.collection('submittedCountShards')),
    deleteCollectionDocs(gameRef.collection('submissionCounts')),
    deleteCollectionDocs(gameRef.collection('marketInsights')),
    deleteCollectionDocs(gameRef.collection('leaderboard')),
    deleteCollectionDocs(gameRef.collection('conclusion')),
    ...playerDocs.map((pd) => deleteCollectionDocs(pd.ref.collection('decisions'))),
    ...playerDocs.map((pd) => deleteCollectionDocs(pd.ref.collection('rounds'))),
    ...playerDocs.map((pd) => deleteCollectionDocs(pd.ref.collection('emails'))),
    ...playerDocs.map((pd) =>
      deleteCollectionDocs(
        gameRef.collection('csvRows').doc(pd.id).collection('rounds'),
      ),
    ),
    ...teamDocs.map((td) => db.recursiveDelete(td.ref.collection('state'))),
  ]);

  // Reset the game doc + each player to lobby defaults in chunked batches.
  let batch = db.batch();
  let ops = 0;
  const commitBatch = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };

  batch.update(gameRef, {
    phase: 'lobby',
    round: 0,
    currentRound: 0,
    paused: false,
    submittedCount: 0,
    phaseEndsAt: null,
    phaseStartedAt: FieldValue.serverTimestamp(),
    pausedAt: null,
    startedAt: null,
    endedAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  ops += 1;

  for (const pd of playerDocs) {
    batch.update(pd.ref, {
      budgetCurrent: startingBudget,
      cumulativeRevenue: 0,
      specialtyChefs: [],
      sousChefCount: 0,
      pendingDecision: {},
      pendingBids: {},
      pendingRosterAction: false,
      rosterCompleted: false,
      returningCustomersPending: 0,
      lastRoundResult: FieldValue.delete(),
      consecutiveMissedRounds: 0,
      disconnected: false,
      equipmentGrade: 'C',
      cleanlinessScore: 75,
      cleanlinessGrade: 'B',
      updatedAt: FieldValue.serverTimestamp(),
    });
    ops += 1;
    if (ops >= BATCH_OP_LIMIT) await commitBatch();
  }

  // Apr 28 2026 — restore each team back to the starter unlock set so a
  // replay starts the unlock economy from scratch instead of carrying over
  // products purchased in the prior playthrough.
  for (const td of teamDocs) {
    batch.update(td.ref, {
      unlockedProducts: [...DEFAULT_UNLOCKED_PRODUCTS],
      unlocksPurchased: 0,
      updatedAt: FieldValue.serverTimestamp(),
    });
    ops += 1;
    if (ops >= BATCH_OP_LIMIT) await commitBatch();
  }
  await commitBatch();

  return { gameId, phase: 'lobby' };
});

// ===========================================================================
// createBotPlayer — inject an AI opponent into a game lobby
// ===========================================================================

exports.createBotPlayer = onCall(CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before adding a bot.');
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  if (!gameId) {
    throw new HttpsError('invalid-argument', 'gameId is required.');
  }

  const gameRef = gameDoc(gameId);
  const gameSnap = await gameRef.get();
  if (!gameSnap.exists) {
    throw new HttpsError('not-found', 'Game not found.');
  }
  if (
    gameSnap.get('professorUid') !== auth.uid &&
    gameSnap.get('professorId') !== auth.uid
  ) {
    throw new HttpsError('permission-denied', 'Only the professor can add bots.');
  }
  if (gameSnap.get('phase') !== 'lobby') {
    throw new HttpsError('failed-precondition', 'Bots can only be added during the lobby phase.');
  }

  // Resolve preset or manual difficulty + personality
  const presetKey = data.preset;
  const preset = PRESETS[presetKey];

  let difficulty;
  let personality;
  let botName;

  if (preset) {
    ({ difficulty, personality, name: botName } = preset);
  } else {
    const validDifficulties = ['novice', 'easy', 'medium', 'hard', 'perfect'];
    difficulty = validDifficulties.includes(data.difficulty) ? data.difficulty : 'medium';
    const validPersonalities = ['balanced', 'aggressive', 'conservative', 'random', 'chef_focused', 'ad_focused', 'volume', 'margin'];
    personality = validPersonalities.includes(data.personality) ? data.personality : 'balanced';
    botName = data.name || `Bot ${difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}`;
  }

  const cfgSnap = await gameRef.collection('config').doc('params').get();
  const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
  const startingBudget = numberOrDefault(
    config.startingBudget,
    DEFAULT_GAME_CONFIG.startingBudget,
  );

  // Generate a synthetic UID for the bot
  const botUid = `bot_${difficulty}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  await gameRef.collection('players').doc(botUid).set({
    uid: botUid,
    displayName: botName,
    bakeryName: `${botName}'s Bakery`,
    role: 'solo',
    budgetCurrent: startingBudget,
    cumulativeRevenue: 0,
    specialtyChefs: [],
    sousChefCount: 0,
    equipmentGrade: 'C',
    cleanlinessScore: 75,
    cleanlinessGrade: 'B',
    consecutiveMissedRounds: 0,
    disconnected: false,
    isBot: true,
    botDifficulty: difficulty,
    botPersonality: personality,
    botPreset: presetKey || null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Increment totalPlayers
  await gameRef.update({
    totalPlayers: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Add to roster
  await gameRef.collection('roster').doc(botUid).set({
    uid: botUid,
    displayName: botName,
    bakeryName: `${botName}'s Bakery`,
    joinedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  logger.info('createBotPlayer ok', { gameId, botUid, difficulty, personality, preset: presetKey });
  return { gameId, botUid, difficulty, personality, preset: presetKey || null, displayName: botName };
});

// ===========================================================================
// loadHistoricalBids — reads all previous rounds' bid docs for opponent
// modeling by perfect-tier bots. Returns { [playerId]: [{ round, ad, chef }] }
// ===========================================================================

async function loadHistoricalBids(gameRef, bots, opponents, currentRound) {
  const historicalBids = {};
  const allPlayers = [...bots, ...opponents.map((o) => ({ id: o.uid || o.playerId }))];

  for (const player of allPlayers) {
    const pid = player.id || (player.data && player.id);
    if (!pid) continue;
    const bids = [];
    for (let r = 1; r < currentRound; r++) {
      try {
        const bidSnap = await gameRef.collection('players').doc(pid).collection('bids').doc(`round_${r}`).get();
        if (bidSnap.exists) {
          const d = bidSnap.data();
          bids.push({
            round: r,
            ad: d.ad || {},
            chef: Array.isArray(d.chef) ? d.chef.map((c) => ({
              chefId: c.chefId,
              amount: c.amount,
              chefTier: c.chefTier,
            })) : [],
          });
        }
      } catch (e) {
        // Non-fatal: missing bid doc is fine
      }
    }
    if (bids.length > 0) {
      historicalBids[pid] = bids;
    }
  }

  return historicalBids;
}

// ===========================================================================
// onBotPhaseChange — Firestore trigger that invokes bot decisions when
// the game phase changes. Listens to the game doc; when phase transitions
// to a decision phase (bid_ad, bid_chef, roster, decide), the trigger
// reads all bots and submits their decisions via the same callable flow.
// ===========================================================================

exports.onBotPhaseChange = onDocumentWritten(
  {
    document: 'games/{gameId}',
    concurrency: 1,
    timeoutSeconds: 120,
  },
  async (event) => {
    const { gameId } = event.params;
    const after = event.data && event.data.after ? event.data.after.data() : null;
    const before = event.data && event.data.before ? event.data.before.data() : null;
    if (!after) return;

    const newPhase = after.phase;
    const oldPhase = before ? before.phase : null;
    if (newPhase === oldPhase) return; // no phase change

    const botPhases = ['bid_ad', 'bid_chef', 'roster', 'decide'];
    const parsed = parsePhase(newPhase, after.currentRound || after.round || 0);
    if (!botPhases.includes(parsed.phase)) return;

    const gameRef = gameDoc(gameId);

    // Find all bots
    const playersSnap = await gameRef.collection('players').get();
    const bots = playersSnap.docs.filter((d) => d.get('isBot') === true);
    if (bots.length === 0) return;

    const cfgSnap = await gameRef.collection('config').doc('params').get();
    const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});

    const round = numberOrDefault(after.currentRound || after.round, 0);
    const roundRef = gameRef.collection('rounds').doc(`round_${round}`);
    const roundSnap = await roundRef.get();
    const roundData = roundSnap.exists ? roundSnap.data() : {};

    // Load opponents (human players) for opponent modeling
    const opponents = playersSnap.docs
      .filter((d) => !d.get('isBot'))
      .map((d) => d.data());

    // Eagerly load historical bids if any perfect bots exist
    const hasPerfectBot = bots.some((b) => (b.data().botDifficulty || 'medium') === 'perfect');
    let historicalBids = null;
    if (hasPerfectBot && round > 1) {
      historicalBids = await loadHistoricalBids(gameRef, bots, opponents, round);
    }

    // Load auction results if available (for perfect bot shadow sim)
    const auctionResults = roundData.auctionResults || {};
    const adAuctionResults = roundData.adAuctionResults || {};
    const chefAuctionResults = roundData.chefAuctionResults || {};
    const roundPreferences = roundData.preferences || { modifiers: {} };

    for (const botDoc of bots) {
      const botData = botDoc.data();
      const difficulty = botData.botDifficulty || 'medium';
      const personality = botData.botPersonality || 'balanced';

      // Resolve this bot's auction wins for shadow sim
      const botAuctionKey = botDoc.id; // solo bots use their own id
      const botAdAuction = adAuctionResults[botAuctionKey] || {};
      const botChefAuction = chefAuctionResults[botAuctionKey] || {};
      const adWins = Array.isArray(botAdAuction.adTypes) ? botAdAuction.adTypes : [];
      const chefsWon = Array.isArray(botChefAuction.chefs) ? botChefAuction.chefs : [];

      // Apr 28 2026 — read the bot's team unlocks so the bot doesn't menu
      // locked optional products (validateDecision rejects locked items
      // with `failed-precondition`). Bots created via createBotPlayer have
      // no teamId and can't call purchaseProduct, so they fall back to the
      // starter set. If a future change wires bots to teams, this branch
      // already mirrors the submitDecision path.
      const botTeamId = getPlayerTeamId(botData);
      let unlockedProducts = [...DEFAULT_UNLOCKED_PRODUCTS];
      if (botTeamId) {
        try {
          const teamSnap = await gameRef.collection('teams').doc(botTeamId).get();
          if (teamSnap.exists) {
            const raw = teamSnap.get('unlockedProducts');
            if (Array.isArray(raw) && raw.length > 0) {
              unlockedProducts = raw.filter((p) => typeof p === 'string');
            }
          }
        } catch (err) {
          logger.warn('onBotPhaseChange: failed to read team unlocks; using default', {
            gameId,
            botId: botDoc.id,
            teamId: botTeamId,
            error: err && err.message,
          });
        }
      }

      const botState = {
        budgetCurrent: botData.budgetCurrent,
        specialtyChefs: botData.specialtyChefs || [],
        chefPool: roundData.chefPool || [],
        unlockedProducts,
        playerId: botDoc.id,
        round,
        gameId,
        adWins,
        chefsWon,
        auctionResults,
        roundPreferences,
        priorSubmittedPrices: botData.priorSubmittedPrices || [],
      };

      try {
        // Deterministic seed for idempotent retries (BUG-3 class fix)
        const seed = `${gameId}:${round}:${parsed.phase}:${botDoc.id}`;
        const decisions = generateBotDecisions(
          botState,
          parsed.phase,
          config,
          opponents,
          difficulty,
          personality,
          historicalBids,
          seed,
        );

        if (parsed.phase === 'bid_ad') {
          const bidsRef = botDoc.ref.collection('bids').doc(`round_${round}`);
          await bidsRef.set({
            round,
            ad: decisions.adBids || {},
            adSubmittedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }

        if (parsed.phase === 'bid_chef') {
          const bidsRef = botDoc.ref.collection('bids').doc(`round_${round}`);
          await bidsRef.set({
            round,
            chef: decisions.chefBids || [],
            chefSubmittedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }

        if (parsed.phase === 'roster' && decisions.layoffs && decisions.layoffs.length > 0) {
          for (const chefId of decisions.layoffs) {
            const remaining = (botData.specialtyChefs || []).filter((c) => c.id !== chefId);
            await botDoc.ref.update({
              specialtyChefs: remaining,
              pendingRosterAction: remaining.length > numberOrDefault(config.specialtyChefCap, 3),
            });
          }
          // Auto-continue from roster if now at or under cap
          const updatedSnap = await botDoc.ref.get();
          const updatedChefs = updatedSnap.data().specialtyChefs || [];
          if (updatedChefs.length <= numberOrDefault(config.specialtyChefCap, 3)) {
            await botDoc.ref.update({ rosterCompleted: true });
          }
        }

        if (parsed.phase === 'decide') {
          const decisionRef = botDoc.ref.collection('decisions').doc(`round_${round}`);
          await decisionRef.set({
            round,
            menu: decisions.menu || {},
            quantities: decisions.quantities || {},
            productPrices: decisions.productPrices || {},
            sousChefCount: decisions.sousChefCount || 0,
            sousChefAssignments: decisions.sousChefAssignments || {},
            staffCounts: decisions.staffCounts || {},
            submittedAt: FieldValue.serverTimestamp(),
          }, { merge: true });

          // Also update pendingDecision for FE visibility
          await botDoc.ref.update({
            pendingDecision: {
              submitted: true,
              submittedAt: Timestamp.now(),
              round,
              menu: decisions.menu || {},
              quantities: decisions.quantities || {},
              sousChefCount: decisions.sousChefCount || 0,
              sousChefAssignments: decisions.sousChefAssignments || {},
              productPrices: decisions.productPrices || {},
            },
            updatedAt: FieldValue.serverTimestamp(),
          });

          // Write to submittedCount shard
          await writeUidToSubmittedCountShard(gameRef, `round_${round}`, botDoc.id);
        }

        logger.info('onBotPhaseChange: bot decision submitted.', {
          gameId,
          botId: botDoc.id,
          phase: parsed.phase,
          difficulty,
          personality,
        });
      } catch (err) {
        logger.error('onBotPhaseChange: bot decision failed.', {
          gameId,
          botId: botDoc.id,
          phase: parsed.phase,
          error: err && err.message,
        });
      }
    }
  }
);

// ---------------------------------------------------------------------------
// T2.4 — Save / restore from the professor UI
// ---------------------------------------------------------------------------

/**
 * Verify the caller is the professor for this game. Mirrors the
 * `professorUid` / `professorId` check used by `resetGame`. Throws
 * permission-denied on mismatch.
 */
async function assertCallerIsProfessor(gameRef, authUid) {
  const gameSnap = await gameRef.get();
  if (!gameSnap.exists) {
    throw new HttpsError('not-found', 'Game not found.');
  }
  if (
    gameSnap.get('professorUid') !== authUid &&
    gameSnap.get('professorId') !== authUid
  ) {
    throw new HttpsError('permission-denied', 'Only the professor can do that.');
  }
}

/**
 * createSnapshot — manual checkpoint button on the professor page. Captures
 * the entire game state into `games/{gameId}/snapshots/{snapshotId}` (chunked
 * across the `chunks` subcollection) and prunes old snapshots on the way out.
 *
 * Returns: { snapshotId, totalChunks, totalBytes, totalDocs, round, phase, elapsedMs }
 */
exports.createSnapshot = onCall(HEAVY_CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before saving a snapshot.');
  const gameId = cleanGameId((request.data || {}).gameId);
  const gameRef = gameDoc(gameId);

  await assertCallerIsProfessor(gameRef, auth.uid);

  const result = await captureGameSnapshot(db, gameRef, {
    capturedByUid: auth.uid,
    capturedBy: 'manual',
  });

  // Best-effort retention sweep — never block the caller on this.
  pruneOldSnapshots(db, gameRef).catch((err) => {
    logger.warn('createSnapshot prune failed — non-fatal.', {
      gameId, error: err && err.message,
    });
  });

  logger.info('createSnapshot ok', {
    gameId,
    capturedByUid: auth.uid,
    snapshotId: result.snapshotId,
    round: result.round,
    phase: result.phase,
    totalDocs: result.totalDocs,
    totalBytes: result.totalBytes,
    elapsedMs: result.elapsedMs,
  });

  return result;
});

/**
 * restoreSnapshot — destructive. Pauses the game, deletes drift docs not in
 * the snapshot, then writes every doc from the snapshot back. Players need
 * to refresh after this lands; their anonymous Firebase Auth UIDs persist
 * so the player docs they restore into still match.
 *
 * Always logs to Cloud Logging with the calling uid for audit.
 *
 * Args: { gameId, snapshotId }
 * Returns: { written, deleted, snapshotId, round, phase }
 */
exports.restoreSnapshot = onCall(HEAVY_CALLABLE_OPTS, async (request) => {
  if (isWarmupRequest(request)) return { ok: true, warm: true };
  const auth = requireAuth(request, 'Sign in before restoring a snapshot.');
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const snapshotId = cleanString(data.snapshotId);
  if (!/^snap_[A-Za-z0-9_]+$/.test(snapshotId)) {
    throw new HttpsError('invalid-argument', 'snapshotId is required.');
  }

  const gameRef = gameDoc(gameId);
  await assertCallerIsProfessor(gameRef, auth.uid);

  const startedAt = Date.now();
  const result = await restoreGameSnapshot(db, gameRef, snapshotId);
  const elapsedMs = Date.now() - startedAt;

  // Audit trail — every restore is logged with the calling uid, the
  // snapshot id, and the round/phase that was restored.
  logger.info('restoreSnapshot ok', {
    gameId,
    restoredByUid: auth.uid,
    snapshotId,
    round: result.round,
    phase: result.phase,
    written: result.written,
    deleted: result.deleted,
    elapsedMs,
  });

  return { ...result, elapsedMs };
});
