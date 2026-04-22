/**
 * index.js — Firebase Cloud Functions entry point for the bakery game backend.
 *
 * This is the ONLY file that imports Firebase. It orchestrates the pure
 * modules (config, phases, chef-system, satisfaction, customer-allocation,
 * revenue, loan-shark, simulation, csv-export, decision-validation,
 * round-preferences, market-insight).
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

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

// Allow Firebase ID tokens (anonymous + real users) to invoke callables.
// Without this, Cloud Run blocks requests at the IAM layer before they
// reach the onCall handler, causing 401s instead of auth checks.
const CALLABLE_OPTS = { invoker: 'public' };

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

const {
  runSimulation,
} = require('./modules/simulation');

const {
  buildCsvString,
} = require('./modules/csv-export');

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

function cleanGameId(value) {
  const gameId = cleanString(value);
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(gameId)) {
    throw new HttpsError('invalid-argument', 'gameId must be a valid game document id.');
  }
  return gameId;
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
// ---------------------------------------------------------------------------
function assertRoleAllowed(playerRole, allowedRoles) {
  if (playerRole === 'solo') return;
  if (!playerRole) {
    // No role set — team game but player hasn't been assigned yet; block the action.
    throw new HttpsError('failed-precondition',
      'You have not been assigned a role yet. Ask your team to set roles first.');
  }
  if (!allowedRoles.includes(playerRole)) {
    throw new HttpsError('permission-denied',
      `Your role "${playerRole}" cannot perform this action. Required: ${allowedRoles.join(' or ')}.`);
  }
}

// ---------------------------------------------------------------------------
// updateTopBids — BE-25 competing-bid surface
// After a successful submitBids, update the round's topBids map so the FE
// can surface the current top VALUE for each ad slot / chef without revealing
// who the high bidder is.  Non-fatal: logged and swallowed on failure.
// ---------------------------------------------------------------------------
async function updateTopBids(gameRef, round, bidType, validated) {
  const roundRef = gameRef.collection('rounds').doc(`round_${round}`);
  try {
    await db.runTransaction(async (tx) => {
      const roundSnap = await tx.get(roundRef);
      const data = (roundSnap.exists && roundSnap.data()) || {};
      const topBids = data.topBids || {};
      const updates = {};

      if (bidType === 'ad') {
        const adTop = topBids.ad || {};
        for (const [adType, amount] of Object.entries(validated || {})) {
          if (amount > 0 && amount > numberOrDefault(adTop[adType], 0)) {
            updates[`topBids.ad.${adType}`] = amount;
          }
        }
      } else {
        const chefTop = topBids.chef || {};
        for (const bid of (Array.isArray(validated) ? validated : [])) {
          const { chefId, amount } = bid || {};
          if (chefId && amount > 0 && amount > numberOrDefault(chefTop[chefId], 0)) {
            updates[`topBids.chef.${chefId}`] = amount;
          }
        }
      }

      if (Object.keys(updates).length === 0) return;
      updates.updatedAt = FieldValue.serverTimestamp();

      if (roundSnap.exists) {
        tx.update(roundRef, updates);
      } else {
        // Round doc may not exist yet during early bid phase — set with merge.
        const topBidsPayload = { ad: {}, chef: {} };
        for (const [key, val] of Object.entries(updates)) {
          if (key === 'updatedAt') continue;
          const parts = key.split('.');  // ['topBids', 'ad'|'chef', slot]
          if (parts[1] === 'ad' && parts[2]) topBidsPayload.ad[parts[2]] = val;
          else if (parts[1] === 'chef' && parts[2]) topBidsPayload.chef[parts[2]] = val;
        }
        tx.set(roundRef, {
          round,
          topBids: topBidsPayload,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });
  } catch (err) {
    logger.warn('updateTopBids side-effect failed — non-fatal.', {
      gameId: gameRef.id, round, bidType, error: err && err.message,
    });
  }
}

// ---------------------------------------------------------------------------
// recordSubmission — BE-22 professor submission-state mirror
// Writes { uid: { status, submittedAt, displayName, role } } to
// games/{gameId}/submissions/{submissionDocId} with merge so the professor
// dashboard can track per-player submission state in real time.
// submissionDocId pattern: "round_{N}_{phase}"  e.g. "round_1_decide"
// Non-fatal: logged and swallowed on failure.
// ---------------------------------------------------------------------------
async function recordSubmission(gameRef, submissionDocId, uid, displayName, role) {
  try {
    await gameRef.collection('submissions').doc(submissionDocId).set({
      [uid]: {
        status: 'submitted',
        submittedAt: Timestamp.now(),
        displayName: displayName || '',
        role: role || null,
      },
    }, { merge: true });
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
 * child auction docs. Returns a Map<playerId, { adWon, adBidPaid, chefsWon, chefBidPaid }>.
 */
async function loadAuctionResultsByPlayer(gameRef, round) {
  const byPlayer = new Map();
  const roundRef = gameRef.collection('rounds').doc(`round_${round}`);
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) return byPlayer;

  const data = roundSnap.data() || {};
  const adResults = objectOrDefault(data.adAuctionResults, {});
  const chefResults = objectOrDefault(data.chefAuctionResults, {});

  // Ad auction: keyed by playerId → { adType, amount }
  for (const [playerId, r] of Object.entries(adResults)) {
    if (!byPlayer.has(playerId)) {
      byPlayer.set(playerId, { adWon: null, adBidPaid: 0, chefsWon: [], chefBidPaid: 0 });
    }
    const entry = byPlayer.get(playerId);
    entry.adWon = (r && r.adType) || null;
    entry.adBidPaid = numberOrDefault(r && r.amount, 0);
  }

  // Chef auction: keyed by playerId → { chefs: [chef], totalPaid }
  for (const [playerId, r] of Object.entries(chefResults)) {
    if (!byPlayer.has(playerId)) {
      byPlayer.set(playerId, { adWon: null, adBidPaid: 0, chefsWon: [], chefBidPaid: 0 });
    }
    const entry = byPlayer.get(playerId);
    entry.chefsWon = Array.isArray(r && r.chefs) ? r.chefs : [];
    entry.chefBidPaid = numberOrDefault(r && r.totalPaid, 0);
  }

  return byPlayer;
}

/**
 * MED-11 / HIGH-04: Resolve the chef auction for a round, write auction
 * results to the round doc, append won chefs to each winner's specialtyChefs
 * array, and set pendingRosterAction for anyone who exceeds the chef cap.
 */
async function resolveAndApplyChefAuction(gameRef, round, config) {
  const roundId = `round_${round}`;
  const roundRef = gameRef.collection('rounds').doc(roundId);

  // Read the round's chefPool and all player bids for this round in parallel.
  const [roundSnap, playersSnap] = await Promise.all([
    roundRef.get(),
    gameRef.collection('players').get(),
  ]);

  const chefPool = (roundSnap.exists && roundSnap.data().chefPool) || [];
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
          playerId: pd.id,
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
  const chefAuctionResults = {};
  for (const [playerId, chefs] of winners) {
    chefAuctionResults[playerId] = {
      chefs,
      totalPaid: payments.get(playerId) || 0,
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

  for (const [playerId, wonChefs] of winners) {
    const playerRef = gameRef.collection('players').doc(playerId);
    const pSnap = playersSnap.docs.find((d) => d.id === playerId);
    const existingCount = pSnap
      ? (Array.isArray((pSnap.data() || {}).specialtyChefs)
          ? pSnap.data().specialtyChefs.length
          : 0)
      : 0;

    batch.update(playerRef, {
      specialtyChefs: FieldValue.arrayUnion(...wonChefs),
      pendingRosterAction: (existingCount + wonChefs.length) > specialtyChefCap,
      updatedAt: FieldValue.serverTimestamp(),
    });
    opsCount++;
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
  const auth = requireAuth(request, 'Sign in before joining a game.');
  const data = request.data || {};

  const joinCode = cleanString(data.joinCode).toUpperCase();
  const displayName = cleanString(data.displayName);
  const rawTeamNumber = data.teamNumber;
  const teamNumber = Number.isInteger(rawTeamNumber) && rawTeamNumber >= 1 && rawTeamNumber <= 8
    ? rawTeamNumber : null;
  const bakeryName = cleanString(data.bakeryName) || (teamNumber ? `Team ${teamNumber}` : `${displayName}'s Bakery`);

  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(joinCode)) {
    throw new HttpsError('invalid-argument', 'joinCode must be a 6-character game code (letters A-Z excluding I/O, digits 2-9).');
  }
  if (displayName.length < 2 || displayName.length > 40) {
    throw new HttpsError('invalid-argument', 'displayName must be 2–40 characters.');
  }
  if (!teamNumber) {
    throw new HttpsError('invalid-argument', 'teamNumber must be an integer between 1 and 8.');
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

  // teamId is derived from teamNumber for predictable grouping.
  const teamId = `team-${teamNumber}`;
  const teamRef = gameRef.collection('teams').doc(teamId);

  let playerId = auth.uid;

  await db.runTransaction(async (transaction) => {
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

    // BE-20: auto-assign role from team's available slots
    const ROLES_ORDER = ['finance', 'advertising', 'operations'];
    const existingRoleAssignments = tSnap.exists
      ? ((tSnap.data() || {}).roleAssignments || {})
      : {};
    const takenRoles = new Set(Object.values(existingRoleAssignments));
    const autoRole = ROLES_ORDER.find((r) => !takenRoles.has(r)) || 'solo';

    if (pSnap.exists) {
      // Rejoin: refresh display name / bakery name but do not reset progress.
      transaction.update(playerRef, {
        displayName,
        bakeryName,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(rosterRef, {
        uid: auth.uid,
        displayName,
        bakeryName,
        updatedAt: FieldValue.serverTimestamp(),
        ...(rSnap.exists ? {} : { joinedAt: FieldValue.serverTimestamp() }),
      }, { merge: true });
      return;
    }

    transaction.set(playerRef, {
      uid: auth.uid,
      playerId: auth.uid,
      displayName,
      bakeryName,
      teamId,                                    // BE-20
      role: autoRole,                            // BE-20
      joinedAt: FieldValue.serverTimestamp(),
      budgetCurrent: config.startingBudget,
      cumulativeRevenue: 0,
      specialtyChefs: [],
      sousChefCount: 0,
      returningCustomersPending: 0,
      consecutiveMissedRounds: 0,                // BE-19
      disconnected: false,                       // BE-19
      pendingDecision: { submitted: false },
      pendingBids: { ad: null, chef: null },
      pendingRosterAction: false,
      lastRoundResult: null,
      teamLogoUrl: typeof (request.data.logoUrl) === 'string' &&        // BE-N07
        request.data.logoUrl.startsWith('https://firebasestorage.googleapis.com')
        ? request.data.logoUrl
        : null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // BE-20: create or update the team doc with this player's role assignment
    if (!tSnap.exists) {
      transaction.set(teamRef, {
        name: bakeryName,
        teamId,
        roleAssignments: { [auth.uid]: autoRole },
        memberCount: 1,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      transaction.update(teamRef, {
        [`roleAssignments.${auth.uid}`]: autoRole,
        memberCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    transaction.set(rosterRef, {
      uid: auth.uid,
      displayName,
      bakeryName,
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.update(gameRef, {
      totalPlayers: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { gameId: gameRef.id, playerId };
});

// ===========================================================================
// startGame
// ===========================================================================

exports.startGame = onCall(CALLABLE_OPTS, async (request) => {
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

  return { gameId, phase: 'round_1_email', round: 1 };
});

// ===========================================================================
// advanceGamePhase
// ===========================================================================

exports.advanceGamePhase = onCall(CALLABLE_OPTS, async (request) => {
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
    }

    if (basePhaseName === 'bid_chef') {
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

// ---------------------------------------------------------------------------
// Simulation orchestration (reads → pure sim → chunked batched writes)
// ---------------------------------------------------------------------------

/**
 * Read all data needed for simulation, invoke the pure simulation engine,
 * and persist results with batch chunking for 150+ player games.
 */
async function runSimulationAndPersist(gameRef, round, config) {
  const roundId = `round_${round}`;
  const roundRef = gameRef.collection('rounds').doc(roundId);

  // -----------------------------------------------------------------------
  // Read phase
  // -----------------------------------------------------------------------
  const [playersSnap, prefs, auctionByPlayer] = await Promise.all([
    gameRef.collection('players').get(),
    loadRoundPreferences(gameRef, round),
    loadAuctionResultsByPlayer(gameRef, round),
  ]);

  const playerDocs = playersSnap.docs;
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

  // BE-19: compute disconnection state for each player before simulation.
  // A player is considered "disconnected" if they have missed 2+ consecutive rounds.
  const disconnectionMap = new Map();
  for (let _i = 0; _i < playerDocs.length; _i++) {
    const _pd = playerDocs[_i];
    const _p = _pd.data() || {};
    const _dSnap = decisionSnaps[_i];
    const _prevMissed = numberOrDefault(_p.consecutiveMissedRounds, 0);
    const _missed = !_dSnap.exists;
    disconnectionMap.set(_pd.id, {
      consecutiveMissedRounds: _missed ? _prevMissed + 1 : 0,
      disconnected: _missed ? _prevMissed + 1 >= 2 : false,
    });
  }

  // Assemble per-player input for the pure simulation engine.
  const players = playerDocs.map((pd, i) => {
    const p = pd.data() || {};
    const dSnap = decisionSnaps[i];
    // BE-19 / regression fix (c7c859f): missed players contribute zero
    // quantities/menu to the sim — never replay stale pendingDecision.
    const missed = !dSnap.exists;
    const decision = missed ? {} : dSnap.data();
    const ar = auctionByPlayer.get(pd.id) || {
      adWon: null, adBidPaid: 0, chefsWon: [], chefBidPaid: 0,
    };

    // POST-01: chronological list of prior-round productPrices maps.
    const priorSubmittedPrices = (priorDecisionSnapsByPlayer[i] || [])
      .map((s) => (s && s.exists && s.data()) ? (s.data().productPrices || null) : null);

    return {
      playerId: pd.id,
      displayName: p.displayName || 'Player',
      bakeryName: p.bakeryName || '',
      decision: {
        menu: (decision && decision.menu) || {},
        quantities: (decision && decision.quantities) || {},
        sousChefCount: missed ? 0 : numberOrDefault(decision && decision.sousChefCount, p.sousChefCount || 0),
        sousChefAssignments: (decision && decision.sousChefAssignments) || {},
        productPrices: (decision && decision.productPrices) || {},   // POST-01
      },
      specialtyChefs: Array.isArray(p.specialtyChefs) ? p.specialtyChefs : [],
      budgetCurrent: numberOrDefault(p.budgetCurrent, 0),
      returningCustomersPending: numberOrDefault(p.returningCustomersPending, 0),
      auctionResults: ar,
      priorSubmittedPrices,   // POST-01
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
  const results = runSimulation(players, prefs, config, { gameId: gameRef.id, round });

  // -----------------------------------------------------------------------
  // Write phase — chunked batches
  // -----------------------------------------------------------------------
  // Each player writes 3 ops:
  //   1. update players/{uid}
  //   2. set  players/{uid}/rounds/{round}
  //   3. set  csvRows/{uid}/rounds/{round}
  const OPS_PER_PLAYER = 3;

  let batch = db.batch();
  let opsInBatch = 0;
  const batches = [];

  for (const r of results) {
    const playerRef = gameRef.collection('players').doc(r.playerId);
    const playerRoundRef = playerRef.collection('rounds').doc(roundId);
    const csvRowRef = gameRef
      .collection('csvRows')
      .doc(r.playerId)
      .collection('rounds')
      .doc(roundId);

    if (opsInBatch + OPS_PER_PLAYER > BATCH_OP_LIMIT) {
      batches.push(batch);
      batch = db.batch();
      opsInBatch = 0;
    }

    const dc = disconnectionMap.get(r.playerId) || { consecutiveMissedRounds: 0, disconnected: false };
    batch.update(playerRef, {
      budgetCurrent: r.budgetAfter,
      cumulativeRevenue: FieldValue.increment(r.revenueNet),
      returningCustomersPending: r.returningCustomersEarned,
      sousChefCount: numberOrDefault(
        (r.csvRow && r.csvRow.sous_chef_count),
        0
      ),
      consecutiveMissedRounds: dc.consecutiveMissedRounds,  // BE-19
      disconnected: dc.disconnected,                         // BE-19
      lastRoundResult: {
        round,
        revenueGross: r.revenueGross,
        revenueNet: r.revenueNet,
        customerCount: r.customerCount,
        aggregateSatisfactionPct: r.aggregateSatisfactionPct,
        chefSatisfactionScore: r.chefSatisfactionScore,
        amountBorrowed: r.amountBorrowed,
        interestCharged: r.interestCharged,
        selloutAnywhere: r.selloutAnywhere || false,
        burglary: r.burglary || false,           // BE-N06
        burglaryAmount: r.burglaryAmount || 0,   // BE-N06
      },
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Extract perProductSold and selloutFlags as flat objects for easy
    // frontend consumption (avoids nested digging into perProductSatisfaction).
    const perProductSold = {};
    const selloutFlags = {};
    for (const [product, pps] of Object.entries(r.perProductSatisfaction || {})) {
      perProductSold[product] = (pps && pps.qtySold) || 0;
      selloutFlags[product] = !!(pps && pps.sellout);
    }

    batch.set(playerRoundRef, {
      round,
      playerId: r.playerId,
      displayName: r.displayName,
      bakeryName: r.bakeryName,
      revenueGross: r.revenueGross,
      revenueNet: r.revenueNet,
      amountBorrowed: r.amountBorrowed,
      interestCharged: r.interestCharged,
      totalSpent: r.totalSpent,
      budgetAfter: r.budgetAfter,
      customerCount: r.customerCount,
      perProductCustomers: r.perProductCustomers,
      aggregateSatisfactionPct: r.aggregateSatisfactionPct,
      chefSatisfactionScore: r.chefSatisfactionScore,
      perProductSatisfaction: r.perProductSatisfaction,
      perProductSold,
      selloutFlags,
      returningCustomersEarned: r.returningCustomersEarned,
      burglary: r.burglary || false,             // BE-N06
      burglaryAmount: r.burglaryAmount || 0,     // BE-N06
      computedAt: FieldValue.serverTimestamp(),
    });

    batch.set(csvRowRef, {
      round,
      playerId: r.playerId,
      row: r.csvRow,
      writtenAt: FieldValue.serverTimestamp(),
    });

    opsInBatch += OPS_PER_PLAYER;
  }

  // Aggregate writes (leaderboard + round doc completion) appended to the
  // FINAL batch so that simulationStatus='complete' only after all per-player
  // writes land.
  const rankings = results
    .slice()
    .sort((a, b) => b.revenueNet - a.revenueNet || b.budgetAfter - a.budgetAfter)
    .map((r, i) => ({
      rank: i + 1,
      playerId: r.playerId,
      displayName: r.displayName,
      bakeryName: r.bakeryName,
      revenueNet: r.revenueNet,
      revenueGross: r.revenueGross,
      customerCount: r.customerCount,
      budgetAfter: r.budgetAfter,
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
  const auth = requireAuth(request, 'Sign in before submitting decisions.');
  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const uid = auth.uid;
  const gameRef = gameDoc(gameId);
  const playerRef = gameRef.collection('players').doc(uid);

  let roundId = null;
  let _submitDecision_role = null;
  let _submitDecision_displayName = '';

  await db.runTransaction(async (transaction) => {
    const [gSnap, pSnap, cfgSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(playerRef),
      transaction.get(gameRef.collection('config').doc('params')),
    ]);

    if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found.');
    if (!pSnap.exists) throw new HttpsError('failed-precondition', 'Join the game before submitting.');

    // BE-21: operations role (or solo) required to submit decisions
    assertRoleAllowed(pSnap.get('role'), ['operations']);
    _submitDecision_role = pSnap.get('role') || null;
    _submitDecision_displayName = pSnap.get('displayName') || '';

    const game = gSnap.data();
    if (!canSubmitDecision(game.phase)) {
      throw new HttpsError('failed-precondition', 'Decisions can only be submitted during the decide phase.');
    }

    const currentRound = numberOrDefault(game.currentRound || game.round, 1);
    const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});

    // Validate using the decision-validation module (pure).
    // ValidationError is a plain JS error — convert to HttpsError so the
    // Firebase Functions runtime surfaces the right code to the client.
    let validated;
    try {
      validated = decisionValidation.validateDecision(data, currentRound, config);
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
    transaction.set(decisionRef, {
      round: currentRound,
      submittedAt: FieldValue.serverTimestamp(),
      ...validated,
    }, { merge: true });

    // BUG-1 fix: FieldValue.serverTimestamp() is invalid inside a nested
    // map — Firestore only allows sentinels at top-level fields. Use
    // Timestamp.now() for the nested submittedAt.
    //
    // POST-01: use dot-paths rather than replacing the whole `pendingDecision`
    // so Finance's `pendingDecision.productPrices` (written by submitPrices)
    // isn't clobbered when Operations submits after Finance.
    transaction.update(playerRef, {
      'pendingDecision.submitted': true,
      'pendingDecision.submittedAt': Timestamp.now(),
      'pendingDecision.round': currentRound,
      'pendingDecision.menu': validated.menu || {},
      'pendingDecision.quantities': validated.quantities || {},
      'pendingDecision.sousChefCount': validated.sousChefCount || 0,
      'pendingDecision.sousChefAssignments': validated.sousChefAssignments || {},
      // BE-19: un-flag a reconnected player immediately on successful submit.
      // Without this, a previously-disconnected player stays flagged on the
      // professor dashboard until the next simulation batch runs.
      consecutiveMissedRounds: 0,
      disconnected: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.update(gameRef, {
      submittedCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

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

    // Finance-only (solo players pass through assertRoleAllowed's solo case).
    assertRoleAllowed(pSnap.get('role'), ['finance']);
    _submitPrices_role = pSnap.get('role') || null;
    _submitPrices_displayName = pSnap.get('displayName') || '';

    const game = gSnap.data();
    if (!canSubmitDecision(game.phase)) {
      throw new HttpsError('failed-precondition', 'Prices can only be submitted during the decide phase.');
    }

    const currentRound = numberOrDefault(game.currentRound || game.round, 1);
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

    transaction.update(playerRef, {
      'pendingDecision.productPrices': validated,
      updatedAt: FieldValue.serverTimestamp(),
    });
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

  await db.runTransaction(async (transaction) => {
    const [gSnap, pSnap, cfgSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(playerRef),
      transaction.get(gameRef.collection('config').doc('params')),
    ]);
    if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found.');
    if (!pSnap.exists) throw new HttpsError('failed-precondition', 'Join the game before bidding.');

    // BE-21: advertising role (or solo) for ad bids; finance role (or solo) for chef bids
    if (bidType === 'ad') {
      assertRoleAllowed(pSnap.get('role'), ['advertising']);
    } else {
      assertRoleAllowed(pSnap.get('role'), ['finance']);
    }
    _submitBids_role = pSnap.get('role') || null;
    _submitBids_displayName = pSnap.get('displayName') || '';

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

    const bidsRef = playerRef.collection('bids').doc(`round_${round}`);
    const existing = await transaction.get(bidsRef);
    const merged = existing.exists ? existing.data() : { round };

    if (bidType === 'ad') merged.ad = validated;
    else merged.chef = validated;

    merged.round = round;
    merged[`${bidType}SubmittedAt`] = FieldValue.serverTimestamp();

    transaction.set(bidsRef, merged, { merge: true });
    transaction.update(playerRef, {
      [`pendingBids.${bidType}`]: validated,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  // BE-25: update topBids on the round doc after transaction (non-fatal)
  if (_submitBids_round !== null && _submitBids_validated !== null) {
    await updateTopBids(gameRef, _submitBids_round, bidType, _submitBids_validated);
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

    // BE-21: operations role (or solo) required to manage roster
    assertRoleAllowed(pSnap.get('role'), ['operations']);

    const game = gSnap.data();
    const { phase } = parsePhase(game.phase, game.currentRound || game.round);
    if (phase !== 'roster') {
      throw new HttpsError('failed-precondition', 'Chefs can only be laid off during the roster phase.');
    }

    const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
    const specialtyChefCap = numberOrDefault(config.specialtyChefCap, 3);

    const player = pSnap.data();
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

    transaction.update(playerRef, {
      specialtyChefs: remaining,
      pendingRosterAction: remaining.length > specialtyChefCap,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { gameId, chefId, laidOff: true };
});

// ===========================================================================
// continueFromRoster
// ===========================================================================

exports.continueFromRoster = onCall(CALLABLE_OPTS, async (request) => {
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

    // BE-21: operations role (or solo) required to complete roster
    assertRoleAllowed(pSnap.get('role'), ['operations']);

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

    transaction.update(gameRef, {
      paused,
      pausedAt: paused ? FieldValue.serverTimestamp() : null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { gameId, paused };
}

exports.pauseGame  = onCall(CALLABLE_OPTS, async (request) => setPausedFlag(request, true));
exports.resumeGame = onCall(CALLABLE_OPTS, async (request) => setPausedFlag(request, false));

// ===========================================================================
// endGame — force transition to game_over
// ===========================================================================

exports.endGame = onCall(CALLABLE_OPTS, async (request) => {
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

exports.exportPlayerCsv = onCall(CALLABLE_OPTS, async (request) => {
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

exports.exportProfessorCsv = onCall(CALLABLE_OPTS, async (request) => {
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
 * Observational trigger: when a player's decision is written, log whether
 * every player has now submitted. The actual simulation is triggered by the
 * professor advancing through the phase state machine.
 *
 * CRIT-01 / MED-12 / HIGH-08 fix: this trigger no longer writes
 * submittedCount to the game doc. `submitDecision`'s transactional
 * `FieldValue.increment(1)` is the sole authoritative writer, which is
 * race-safe for concurrent submissions. The trigger is purely observational.
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

      // Read the game doc's submittedCount (set by submitDecision's increment).
      const submittedCount = numberOrDefault(game.submittedCount, 0);

      logger.info('Decision submitted.', {
        gameId,
        playerId,
        round,
        submittedCount,
        totalPlayers: playersSnap.size,
        allSubmitted: submittedCount >= playersSnap.size,
      });
    } catch (err) {
      logger.error('onDecisionSubmitted failure.', {
        gameId, playerId, round, error: err && err.message,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// updateTeamName — any team member may rename their team.
// ---------------------------------------------------------------------------
exports.updateTeamName = onCall(CALLABLE_OPTS, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Must be signed in.');

  const gameId   = cleanString(request.data && request.data.gameId);
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
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Must be signed in.');

  const gameId = cleanString(request.data && request.data.gameId);
  const teamId = cleanString(request.data && request.data.teamId);
  const role   = cleanString(request.data && request.data.role);

  if (!gameId) throw new HttpsError('invalid-argument', 'gameId is required.');
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required.');
  if (!role)   throw new HttpsError('invalid-argument', 'role is required.');

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

exports.extendPhase = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const { gameId, extraSeconds } = request.data || {};
  if (!gameId || typeof extraSeconds !== "number") {
    throw new HttpsError("invalid-argument", "gameId and extraSeconds are required.");
  }
  const cappedExtra = Math.min(extraSeconds, 300);
  const gameRef = db.collection("games").doc(gameId);
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

exports.purchaseCompetitorInsight = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const { gameId, round } = request.data || {};
  if (!gameId || typeof round !== "number") {
    throw new HttpsError("invalid-argument", "gameId and round are required.");
  }
  const uid = request.auth.uid;
  const gameRef = db.collection("games").doc(gameId);
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
  const insightCost = (config.competitorInsightCost) || 5000;

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
