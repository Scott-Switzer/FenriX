/**
 * Bakery Bash — Cloud Functions (Firebase v2)
 *
 * Canonical references used to build this file:
 *   - firestore-schema.js   (collection hierarchy + document shapes)
 *   - BACKEND.md            (API map, state machine, revenue model, budget system)
 *   - GAME_DESIGN_PROPOSAL  (round structure, decisions, scoring, CSV columns)
 *   - AUTH_PLAYER_FLOW.md   (identity model, joinGame contract)
 *   - revenue.ts            (teammate's revenue engine — adapted to match Firestore schema)
 *
 * Exported callable functions:
 *   joinGame          — Player joins a lobby (already existed on dbarlava)
 *   createGame        — Professor creates a new game session
 *   startGame         — Professor starts the game (lobby → decide)
 *   advancePhase      — Professor advances the phase / triggers simulation
 *   submitDecisions   — Player locks in their round decisions
 *   simulate          — Internal: runs revenue engine (called by advancePhase)
 *   exportCsv         — Player downloads their own CSV
 *   professorExport   — Professor downloads all-player CSV
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const {
  FieldValue,
  Timestamp,
  getFirestore,
} = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();

// ═════════════════════════════════════════════════════════════
// CONSTANTS & DEFAULTS
// ═════════════════════════════════════════════════════════════

const ALL_PRODUCTS = [
  "croissant", "cookie", "bagel", "sandwich", "latte", "matchaLatte",
];

const DEFAULT_PENDING_DECISION = {
  submitted: false,
  submittedAt: null,
  staffCount: 3,
  adSpend: 0,
  menu: {
    croissant: true,
    cookie: true,
    bagel: true,
    sandwich: false,
    latte: false,
    matchaLatte: false,
  },
  productPrices: {
    croissant: 0,
    cookie: 0,
    bagel: 0,
    sandwich: 0,
    latte: 0,
    matchaLatte: 0,
  },
  quantities: {
    croissant: 0,
    cookie: 0,
    bagel: 0,
    sandwich: 0,
    latte: 0,
    matchaLatte: 0,
  },
};

const DEFAULT_PENDING_BIDS = {
  adBid: {
    adType: null,
    amount: 0,
  },
  chefBid: {
    skillLevel: 0,
    amount: 0,
  },
};

/** Full default config matching GameConfigDocument in firestore-schema.js */
const DEFAULT_GAME_CONFIG = {
  startingBudget: 2000,
  costPerStaffPerRound: 50,
  unitCostPerProduct: 1,

  revenueModel: {
    base: 500,
    staffCoefficient: 30,
    priceCoefficient: -15,
    adSpendCoefficient: 0.8,
    numProductsCoefficient: 50,
    noiseMin: -100,
    noiseMax: 100,
  },

  adBonuses: {
    TV: 200,
    Billboard: 150,
    Radio: 100,
    Newspaper: 75,
  },

  chefBonusPerPoint: 2,
  customerPoolMultiplier: 100,

  attractivenessWeights: {
    priceWeight: 100,
    staffWeight: 5,
    adSpendWeight: 0.3,
    numProductsWeight: 10,
  },

  phaseDurations: {
    decide: 300,
    bid: 120,
    simulate: 30,
    results: 60,
  },
};

// ═════════════════════════════════════════════════════════════
// HELPER UTILITIES
// ═════════════════════════════════════════════════════════════

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "You must be signed in to perform this action."
    );
  }
  return request.auth.uid;
}

/** Verify the caller is the professor who owns this game. */
async function requireProfessor(request, gameRef) {
  const uid = requireAuth(request);
  const gameSnap = await gameRef.get();

  if (!gameSnap.exists) {
    throw new HttpsError("not-found", "Game not found.");
  }

  if (gameSnap.get("professorId") !== uid) {
    throw new HttpsError(
      "permission-denied",
      "Only the professor who created this game can perform this action."
    );
  }

  return { uid, gameSnap };
}

function generateJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 to avoid confusion
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function randomUniform(min, max) {
  return min + Math.random() * (max - min);
}

/** Read config/params for a game, falling back to defaults. */
async function readGameConfig(gameRef) {
  const configSnap = await gameRef.collection("config").doc("params").get();
  if (!configSnap.exists) {
    return { ...DEFAULT_GAME_CONFIG };
  }
  const raw = configSnap.data();
  return {
    startingBudget: raw.startingBudget ?? DEFAULT_GAME_CONFIG.startingBudget,
    costPerStaffPerRound: raw.costPerStaffPerRound ?? DEFAULT_GAME_CONFIG.costPerStaffPerRound,
    unitCostPerProduct: raw.unitCostPerProduct ?? DEFAULT_GAME_CONFIG.unitCostPerProduct,
    revenueModel: { ...DEFAULT_GAME_CONFIG.revenueModel, ...(raw.revenueModel || {}) },
    adBonuses: { ...DEFAULT_GAME_CONFIG.adBonuses, ...(raw.adBonuses || {}) },
    chefBonusPerPoint: raw.chefBonusPerPoint ?? DEFAULT_GAME_CONFIG.chefBonusPerPoint,
    customerPoolMultiplier: raw.customerPoolMultiplier ?? DEFAULT_GAME_CONFIG.customerPoolMultiplier,
    attractivenessWeights: { ...DEFAULT_GAME_CONFIG.attractivenessWeights, ...(raw.attractivenessWeights || {}) },
    phaseDurations: { ...DEFAULT_GAME_CONFIG.phaseDurations, ...(raw.phaseDurations || {}) },
  };
}

/** Count active menu items from a menu map { croissant: true, … } */
function countActiveProducts(menu) {
  return Object.values(menu || {}).filter(Boolean).length;
}

/** Compute average price from productPrices for active menu items only. */
function computeAvgPrice(menu, productPrices) {
  const activePrices = [];
  for (const [product, active] of Object.entries(menu || {})) {
    if (active && typeof productPrices[product] === "number" && productPrices[product] > 0) {
      activePrices.push(productPrices[product]);
    }
  }
  if (activePrices.length === 0) return 0;
  return activePrices.reduce((sum, p) => sum + p, 0) / activePrices.length;
}

// ═════════════════════════════════════════════════════════════
// 1. joinGame  — Player joins a lobby
//    (Preserved from dbarlava branch, unchanged)
// ═════════════════════════════════════════════════════════════

function validateJoinInput(data) {
  const joinCode = cleanString(data.joinCode).toUpperCase();
  const displayName = cleanString(data.displayName);

  if (!/^[A-Z0-9]{6}$/.test(joinCode)) {
    throw new HttpsError(
      "invalid-argument",
      "joinCode must be a 6-character game code."
    );
  }

  if (displayName.length < 2 || displayName.length > 40) {
    throw new HttpsError(
      "invalid-argument",
      "displayName must be between 2 and 40 characters."
    );
  }

  return { joinCode, displayName };
}

async function findLobbyByJoinCode(joinCode) {
  const snapshot = await db
    .collection("games")
    .where("joinCode", "==", joinCode)
    .limit(1)
    .get();

  if (snapshot.empty) {
    throw new HttpsError("not-found", "No game exists for that join code.");
  }

  return snapshot.docs[0].ref;
}

async function readStartingBudget(transaction, gameRef) {
  const configRef = gameRef.collection("config").doc("params");
  const configSnap = await transaction.get(configRef);

  if (!configSnap.exists) {
    return 2000;
  }

  const startingBudget = configSnap.get("startingBudget");
  return typeof startingBudget === "number" ? startingBudget : 2000;
}

exports.joinGame = onCall(async (request) => {
  const uid = requireAuth(request);
  const { joinCode, displayName } = validateJoinInput(request.data || {});
  const gameRef = await findLobbyByJoinCode(joinCode);
  const playerRef = gameRef.collection("players").doc(uid);

  await db.runTransaction(async (transaction) => {
    const gameSnap = await transaction.get(gameRef);
    const playerSnap = await transaction.get(playerRef);
    const startingBudget = await readStartingBudget(transaction, gameRef);

    if (!gameSnap.exists) {
      throw new HttpsError("not-found", "No game exists for that join code.");
    }

    if (gameSnap.get("phase") !== "lobby") {
      throw new HttpsError(
        "failed-precondition",
        "This game is no longer accepting players."
      );
    }

    if (playerSnap.exists) {
      transaction.update(playerRef, {
        displayName,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    transaction.set(playerRef, {
      uid,
      displayName,
      joinedAt: FieldValue.serverTimestamp(),
      budgetCurrent: startingBudget,
      cumulativeRevenue: 0,
      pendingDecision: DEFAULT_PENDING_DECISION,
      pendingBids: DEFAULT_PENDING_BIDS,
      lastRoundResult: {
        round: 0,
        revenue: 0,
        customerCount: 0,
        customerSatisfaction: 0,
        headchefSkill: 0,
        adTypeWon: null,
        productsSold: {
          croissant: 0,
          cookie: 0,
          bagel: 0,
          sandwich: 0,
          latte: 0,
          matchaLatte: 0,
        },
      },
    });

    transaction.update(gameRef, {
      totalPlayers: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  const playerSnap = await playerRef.get();
  const player = playerSnap.data();

  return {
    uid,
    gameId: gameRef.id,
    playerId: uid,
    displayName: player.displayName,
    joinedAt:
      player.joinedAt instanceof Timestamp
        ? player.joinedAt.toMillis()
        : null,
  };
});

// ═════════════════════════════════════════════════════════════
// 2. createGame  — Professor creates a new game session
// ═════════════════════════════════════════════════════════════

exports.createGame = onCall(async (request) => {
  const uid = requireAuth(request);
  const data = request.data || {};

  // Optional overrides from the professor
  const totalRounds = typeof data.totalRounds === "number" && data.totalRounds >= 1 && data.totalRounds <= 10
    ? data.totalRounds
    : 5;

  const joinCode = generateJoinCode();
  const gameRef = db.collection("games").doc();

  // Write game document — matches GameDocument in firestore-schema.js
  await gameRef.set({
    joinCode,
    phase: "lobby",
    currentRound: 1,
    totalRounds,
    phaseEndTime: null,
    submittedCount: 0,
    totalPlayers: 0,
    paused: false,
    professorId: uid,
    createdAt: FieldValue.serverTimestamp(),
    startedAt: null,
    endedAt: null,
  });

  // Write config/params — matches GameConfigDocument in firestore-schema.js
  // Professor can pass custom config overrides; otherwise use defaults
  const configOverrides = data.config || {};
  const config = {
    ...DEFAULT_GAME_CONFIG,
    ...configOverrides,
    revenueModel: { ...DEFAULT_GAME_CONFIG.revenueModel, ...(configOverrides.revenueModel || {}) },
    adBonuses: { ...DEFAULT_GAME_CONFIG.adBonuses, ...(configOverrides.adBonuses || {}) },
    attractivenessWeights: { ...DEFAULT_GAME_CONFIG.attractivenessWeights, ...(configOverrides.attractivenessWeights || {}) },
    phaseDurations: { ...DEFAULT_GAME_CONFIG.phaseDurations, ...(configOverrides.phaseDurations || {}) },
  };

  await gameRef.collection("config").doc("params").set(config);

  // Initialize empty leaderboard — matches LeaderboardDocument
  await gameRef.collection("leaderboard").doc("current").set({
    rankings: [],
    updatedAt: FieldValue.serverTimestamp(),
    round: 0,
  });

  logger.info(`Game created: ${gameRef.id} (code: ${joinCode}) by professor ${uid}`);

  return {
    gameId: gameRef.id,
    joinCode,
    totalRounds,
  };
});

// ═════════════════════════════════════════════════════════════
// 3. startGame  — Professor starts the game (lobby → decide)
// ═════════════════════════════════════════════════════════════

exports.startGame = onCall(async (request) => {
  const data = request.data || {};
  const gameId = cleanString(data.gameId);

  if (!gameId) {
    throw new HttpsError("invalid-argument", "gameId is required.");
  }

  const gameRef = db.collection("games").doc(gameId);
  const { gameSnap } = await requireProfessor(request, gameRef);

  if (gameSnap.get("phase") !== "lobby") {
    throw new HttpsError(
      "failed-precondition",
      "Game can only be started from the lobby phase."
    );
  }

  if (gameSnap.get("totalPlayers") < 1) {
    throw new HttpsError(
      "failed-precondition",
      "At least one player must join before starting."
    );
  }

  const config = await readGameConfig(gameRef);

  await gameRef.update({
    phase: "decide",
    currentRound: 1,
    submittedCount: 0,
    startedAt: FieldValue.serverTimestamp(),
    phaseEndTime: Timestamp.fromMillis(
      Date.now() + config.phaseDurations.decide * 1000
    ),
  });

  logger.info(`Game ${gameId} started by professor.`);

  return { gameId, phase: "decide", currentRound: 1 };
});

// ═════════════════════════════════════════════════════════════
// 4. advancePhase  — Professor advances the game phase
//    State machine: decide → bid → simulating → results_ready → (next decide | game_over)
// ═════════════════════════════════════════════════════════════

exports.advancePhase = onCall(async (request) => {
  const data = request.data || {};
  const gameId = cleanString(data.gameId);

  if (!gameId) {
    throw new HttpsError("invalid-argument", "gameId is required.");
  }

  const gameRef = db.collection("games").doc(gameId);
  const { gameSnap } = await requireProfessor(request, gameRef);
  const game = gameSnap.data();
  const config = await readGameConfig(gameRef);
  const currentPhase = game.phase;
  const currentRound = game.currentRound;

  let nextPhase;
  let updates = {};

  switch (currentPhase) {
    case "decide":
      nextPhase = "bid";
      updates.phaseEndTime = Timestamp.fromMillis(
        Date.now() + config.phaseDurations.bid * 1000
      );
      break;

    case "bid":
      // Transition to simulating, then run the simulation
      nextPhase = "simulating";
      updates.phaseEndTime = null;
      break;

    case "simulating":
      // Should not happen — simulation auto-advances to results_ready
      throw new HttpsError(
        "failed-precondition",
        "Simulation is in progress. Please wait."
      );

    case "results_ready":
      if (currentRound >= game.totalRounds) {
        nextPhase = "game_over";
        updates.endedAt = FieldValue.serverTimestamp();
        updates.phaseEndTime = null;
      } else {
        nextPhase = "decide";
        updates.currentRound = currentRound + 1;
        updates.submittedCount = 0;
        updates.phaseEndTime = Timestamp.fromMillis(
          Date.now() + config.phaseDurations.decide * 1000
        );

        // Reset all players' pendingDecision and pendingBids for next round
        const playersSnap = await gameRef.collection("players").get();
        const resetBatch = db.batch();
        for (const playerDoc of playersSnap.docs) {
          resetBatch.update(playerDoc.ref, {
            pendingDecision: DEFAULT_PENDING_DECISION,
            pendingBids: DEFAULT_PENDING_BIDS,
          });
        }
        await resetBatch.commit();
      }
      break;

    default:
      throw new HttpsError(
        "failed-precondition",
        `Cannot advance from phase "${currentPhase}".`
      );
  }

  updates.phase = nextPhase;
  await gameRef.update(updates);

  // If we just entered "simulating", run the simulation now
  if (nextPhase === "simulating") {
    await runSimulation(gameId, currentRound);
    await gameRef.update({
      phase: "results_ready",
      phaseEndTime: Timestamp.fromMillis(
        Date.now() + config.phaseDurations.results * 1000
      ),
    });

    logger.info(`Game ${gameId} round ${currentRound}: simulation complete → results_ready`);

    return { gameId, phase: "results_ready", currentRound };
  }

  logger.info(`Game ${gameId}: ${currentPhase} → ${nextPhase}`);

  return { gameId, phase: nextPhase, currentRound: updates.currentRound || currentRound };
});

// ═════════════════════════════════════════════════════════════
// 5. submitDecisions  — Player submits their round decisions
// ═════════════════════════════════════════════════════════════

exports.submitDecisions = onCall(async (request) => {
  const uid = requireAuth(request);
  const data = request.data || {};
  const gameId = cleanString(data.gameId);

  if (!gameId) {
    throw new HttpsError("invalid-argument", "gameId is required.");
  }

  const gameRef = db.collection("games").doc(gameId);
  const playerRef = gameRef.collection("players").doc(uid);

  return await db.runTransaction(async (transaction) => {
    const gameSnap = await transaction.get(gameRef);
    const playerSnap = await transaction.get(playerRef);

    if (!gameSnap.exists) {
      throw new HttpsError("not-found", "Game not found.");
    }
    if (!playerSnap.exists) {
      throw new HttpsError("not-found", "Player not found in this game.");
    }

    const game = gameSnap.data();
    const player = playerSnap.data();

    // Can only submit during decide or bid phase
    if (game.phase !== "decide" && game.phase !== "bid") {
      throw new HttpsError(
        "failed-precondition",
        `Cannot submit decisions during the "${game.phase}" phase.`
      );
    }

    // Check if already submitted this round
    if (player.pendingDecision && player.pendingDecision.submitted) {
      throw new HttpsError(
        "already-exists",
        "You have already submitted your decisions for this round."
      );
    }

    // Read the player's current pendingDecision (written client-side)
    const pending = player.pendingDecision || DEFAULT_PENDING_DECISION;
    const bids = player.pendingBids || DEFAULT_PENDING_BIDS;
    const roundId = `round_${game.currentRound}`;

    const numProducts = countActiveProducts(pending.menu);
    const avgPrice = computeAvgPrice(pending.menu, pending.productPrices);

    // Compute total costs for this round (budget snapshot)
    const configSnap = await transaction.get(gameRef.collection("config").doc("params"));
    const config = configSnap.exists ? configSnap.data() : DEFAULT_GAME_CONFIG;
    const staffCost = (pending.staffCount || 0) * (config.costPerStaffPerRound || 50);
    const stockCost = Object.entries(pending.quantities || {}).reduce((sum, [product, qty]) => {
      if (pending.menu[product] && typeof qty === "number") {
        return sum + qty * (config.unitCostPerProduct || 1);
      }
      return sum;
    }, 0);
    const totalCosts = staffCost + stockCost;

    // Snapshot into immutable decisions subcollection — matches DecisionDocument
    const decisionRef = playerRef.collection("decisions").doc(roundId);
    transaction.set(decisionRef, {
      round: game.currentRound,
      submittedAt: FieldValue.serverTimestamp(),
      staffCount: pending.staffCount || 3,
      adSpend: pending.adSpend || 0,
      menu: pending.menu,
      productPrices: pending.productPrices,
      quantities: pending.quantities,
      adBid: bids.adBid,
      chefBid: bids.chefBid,
      numProducts,
      avgPrice,
      totalCosts,
      budgetBefore: player.budgetCurrent,
    });

    // Mark pending decision as submitted
    transaction.update(playerRef, {
      "pendingDecision.submitted": true,
      "pendingDecision.submittedAt": FieldValue.serverTimestamp(),
    });

    // Increment game's submittedCount
    transaction.update(gameRef, {
      submittedCount: FieldValue.increment(1),
    });

    return {
      success: true,
      roundId,
      numProducts,
      avgPrice,
    };
  });
});

// ═════════════════════════════════════════════════════════════
// 6. SIMULATION ENGINE
//    Adapted from revenue.ts to match firestore-schema.js conventions
// ═════════════════════════════════════════════════════════════

/**
 * Run the full simulation for a round:
 *  1. Load config + all player decisions
 *  2. Resolve ad auctions (4 ad types, sealed-bid first-price)
 *  3. Resolve chef auction (randomized skill level)
 *  4. Allocate customers proportionally by attractiveness
 *  5. Compute revenue, satisfaction, sold quantities per player
 *  6. Update budgets, write round results, leaderboard, CSV rows
 */
async function runSimulation(gameId, roundNumber) {
  const gameRef = db.collection("games").doc(gameId);
  const roundId = `round_${roundNumber}`;

  const [gameSnap, playersSnap, config] = await Promise.all([
    gameRef.get(),
    gameRef.collection("players").get(),
    readGameConfig(gameRef),
  ]);

  if (!gameSnap.exists) throw new Error(`Game ${gameId} not found.`);
  const game = gameSnap.data();
  const players = playersSnap.docs;

  if (players.length === 0) {
    logger.warn(`Game ${gameId}: no players found. Skipping simulation.`);
    return;
  }

  // ── 1. Build decision map — read from decisions subcollection ──
  const decisions = {};
  for (const playerDoc of players) {
    const playerId = playerDoc.id;
    const decisionSnap = await playerDoc.ref.collection("decisions").doc(roundId).get();

    if (decisionSnap.exists) {
      decisions[playerId] = decisionSnap.data();
    } else {
      // Player didn't submit — build default from their current state
      const p = playerDoc.data();
      decisions[playerId] = {
        round: roundNumber,
        staffCount: p.pendingDecision?.staffCount ?? 3,
        adSpend: p.pendingDecision?.adSpend ?? 0,
        menu: p.pendingDecision?.menu ?? DEFAULT_PENDING_DECISION.menu,
        productPrices: p.pendingDecision?.productPrices ?? DEFAULT_PENDING_DECISION.productPrices,
        quantities: p.pendingDecision?.quantities ?? DEFAULT_PENDING_DECISION.quantities,
        adBid: p.pendingBids?.adBid ?? DEFAULT_PENDING_BIDS.adBid,
        chefBid: p.pendingBids?.chefBid ?? DEFAULT_PENDING_BIDS.chefBid,
        numProducts: countActiveProducts(p.pendingDecision?.menu),
        avgPrice: computeAvgPrice(
          p.pendingDecision?.menu ?? DEFAULT_PENDING_DECISION.menu,
          p.pendingDecision?.productPrices ?? DEFAULT_PENDING_DECISION.productPrices
        ),
        budgetBefore: p.budgetCurrent ?? config.startingBudget,
        totalCosts: 0,
      };
    }
  }

  // ── 2. Resolve ad auctions — 4 types, sealed-bid, first-price ──
  // Per BACKEND.md: "Player can bid on multiple but wins at most one."
  const adTypes = ["TV", "Billboard", "Radio", "Newspaper"];
  const adAuctionResults = {};
  const adWinners = {}; // playerId → adType they won

  for (const adType of adTypes) {
    adAuctionResults[adType] = { winnerId: null, winningBid: 0 };
  }

  // Collect all ad bids: { playerId, adType, amount }
  const adBids = [];
  for (const [playerId, decision] of Object.entries(decisions)) {
    const bid = decision.adBid;
    if (bid && bid.adType && bid.amount > 0) {
      adBids.push({ playerId, adType: bid.adType, amount: bid.amount });
    }
  }

  // Sort by amount descending — highest bidders get priority
  adBids.sort((a, b) => b.amount - a.amount);

  for (const bid of adBids) {
    // Skip if player already won a different ad
    if (adWinners[bid.playerId]) continue;
    // Skip if this ad slot is already taken
    if (adAuctionResults[bid.adType]?.winnerId) continue;

    adAuctionResults[bid.adType] = {
      winnerId: bid.playerId,
      winningBid: bid.amount,
    };
    adWinners[bid.playerId] = bid.adType;
  }

  // ── 3. Resolve chef auction ──
  // Per BACKEND.md: "3 chefs per round, skill levels randomized"
  // Simplified for MVP: one chef auction, random skill level
  const chefSkillLevel = Math.floor(Math.random() * 101); // 0–100

  let chefWinnerId = null;
  let chefWinningBid = 0;

  for (const [playerId, decision] of Object.entries(decisions)) {
    const bid = decision.chefBid;
    if (bid && bid.amount > 0 && bid.amount > chefWinningBid) {
      chefWinnerId = playerId;
      chefWinningBid = bid.amount;
    }
  }

  // ── 4. Allocate customers ──
  // Per BACKEND.md: total pool = customerPoolMultiplier × numPlayers
  // Attractiveness formula from BACKEND.md spec
  const totalCustomerPool = config.customerPoolMultiplier * players.length;
  const weights = config.attractivenessWeights;

  const scores = {};
  for (const [playerId, decision] of Object.entries(decisions)) {
    const avgPrice = decision.avgPrice || computeAvgPrice(decision.menu, decision.productPrices);
    const numProducts = decision.numProducts || countActiveProducts(decision.menu);
    const staffCount = decision.staffCount || 0;
    const adSpend = decision.adSpend || 0;

    scores[playerId] =
      (avgPrice > 0 ? (1 / avgPrice) * weights.priceWeight : 0)
      + staffCount * weights.staffWeight
      + adSpend * weights.adSpendWeight
      + numProducts * weights.numProductsWeight;
  }

  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const customerCounts = {};

  if (totalScore === 0) {
    const even = Math.floor(totalCustomerPool / players.length);
    for (const playerDoc of players) {
      customerCounts[playerDoc.id] = even;
    }
  } else {
    for (const [playerId, score] of Object.entries(scores)) {
      customerCounts[playerId] = Math.floor((score / totalScore) * totalCustomerPool);
    }
  }

  // ── 5. Compute results for every player ──
  const rm = config.revenueModel;
  const batch = db.batch();
  const allRevenues = [];
  const allCustomerCounts = [];
  const leaderboardEntries = [];

  for (const playerDoc of players) {
    const playerId = playerDoc.id;
    const player = playerDoc.data();
    const decision = decisions[playerId];

    const numProducts = decision.numProducts || countActiveProducts(decision.menu);
    const avgPrice = decision.avgPrice || computeAvgPrice(decision.menu, decision.productPrices);
    const staffCount = decision.staffCount || 0;

    // Auction outcomes for this player
    const wonAdType = adWinners[playerId] || null;
    const adBonus = wonAdType ? (config.adBonuses[wonAdType] || 0) : 0;
    const wonChef = chefWinnerId === playerId;
    const headchefSkill = wonChef ? chefSkillLevel : 0;
    const chefBonus = headchefSkill * config.chefBonusPerPoint;

    // Actual ad spend = winning bid amount if won, else 0
    const actualAdSpend = wonAdType
      ? (adAuctionResults[wonAdType]?.winningBid || 0)
      : 0;

    // ── Revenue formula (matches BACKEND.md + revenue.ts) ──
    const noise = randomUniform(rm.noiseMin, rm.noiseMax);
    const revenueRaw =
      rm.base
      + rm.staffCoefficient * staffCount
      + rm.priceCoefficient * avgPrice
      + rm.adSpendCoefficient * actualAdSpend
      + rm.numProductsCoefficient * numProducts
      + adBonus
      + chefBonus
      + noise;
    const revenue = Math.round(Math.max(0, revenueRaw)); // Floor at 0

    // Customer satisfaction (adapted from revenue.ts)
    let satisfaction = 70;
    satisfaction += numProducts * 3;
    satisfaction -= Math.max(0, avgPrice - 8) * 2;
    if (staffCount > 0) {
      satisfaction -= Math.max(0, (customerCounts[playerId] || 0) / staffCount - 20) * 0.5;
    }
    satisfaction = Math.min(100, Math.max(0, satisfaction));
    satisfaction = parseFloat(satisfaction.toFixed(1));

    // Sold quantities — demand split evenly across active products, capped by stock
    const productsSold = {};
    const activeProducts = ALL_PRODUCTS.filter((p) => decision.menu && decision.menu[p]);
    const demandPerProduct = activeProducts.length > 0
      ? Math.floor((customerCounts[playerId] || 0) / activeProducts.length)
      : 0;

    for (const product of ALL_PRODUCTS) {
      if (!decision.menu || !decision.menu[product]) {
        productsSold[product] = 0;
        continue;
      }
      const stocked = (decision.quantities && decision.quantities[product]) || 0;
      productsSold[product] = stocked > 0 ? Math.min(demandPerProduct, stocked) : 0;
    }

    // Costs
    const staffCost = staffCount * config.costPerStaffPerRound;
    const stockCost = Object.entries(decision.quantities || {}).reduce((sum, [product, qty]) => {
      if (decision.menu && decision.menu[product] && typeof qty === "number") {
        return sum + qty * config.unitCostPerProduct;
      }
      return sum;
    }, 0);
    const auctionCost =
      (wonAdType ? (adAuctionResults[wonAdType]?.winningBid || 0) : 0)
      + (wonChef ? chefWinningBid : 0);
    const totalCosts = staffCost + stockCost + auctionCost;
    const budgetBefore = player.budgetCurrent ?? config.startingBudget;
    const budgetAfter = Math.round(budgetBefore + revenue - totalCosts);

    allRevenues.push(revenue);
    allCustomerCounts.push(customerCounts[playerId] || 0);

    // ── Write per-player round result — matches RoundResultDocument ──
    const roundResultRef = playerDoc.ref.collection("rounds").doc(roundId);
    batch.set(roundResultRef, {
      round: roundNumber,
      revenue,
      customerCount: customerCounts[playerId] || 0,
      customerSatisfaction: satisfaction,
      headchefSkill,
      adTypeWon: wonAdType,
      adBonus,
      chefBonus,
      productsSold,
      avgPrice,
      productPrices: decision.productPrices || {},
      menu: decision.menu || {},
      quantitySubmitted: decision.quantities || {},
      staffCount,
      adSpend: actualAdSpend,
      numProducts,
      revenueGross: revenue,
      totalCosts,
      budgetBefore,
      budgetAfter,
      computedAt: FieldValue.serverTimestamp(),
    });

    // ── Update player's live state ──
    batch.update(playerDoc.ref, {
      budgetCurrent: budgetAfter,
      cumulativeRevenue: FieldValue.increment(revenue),
      lastRoundResult: {
        round: roundNumber,
        revenue,
        customerCount: customerCounts[playerId] || 0,
        customerSatisfaction: satisfaction,
        headchefSkill,
        adTypeWon: wonAdType,
        productsSold,
      },
    });

    // ── Write CSV row — matches CsvRowsDocument (17-column spec) ──
    const csvRef = gameRef
      .collection("csvRows")
      .doc(playerId)
      .collection("rounds")
      .doc(roundId);
    batch.set(csvRef, {
      playerId,
      round: roundNumber,
      row: {
        day: roundNumber,
        revenue,
        num_products: numProducts,
        avg_price: parseFloat(avgPrice.toFixed(2)),
        staff_count: staffCount,
        ad_spend: actualAdSpend,
        customer_count: customerCounts[playerId] || 0,
        customer_satisfaction: satisfaction,
        headchef_skill: headchefSkill,
        croissant: productsSold.croissant || 0,
        cookie: productsSold.cookie || 0,
        bagel: productsSold.bagel || 0,
        sandwich: productsSold.sandwich || 0,
        latte: productsSold.latte || 0,
        matcha_latte: productsSold.matchaLatte || 0,
        ad_type: wonAdType || "none",
      },
    });

    // Collect for leaderboard
    leaderboardEntries.push({
      playerId,
      displayName: player.displayName,
      cumulativeRevenue: (player.cumulativeRevenue || 0) + revenue,
      lastRoundRevenue: revenue,
    });
  }

  // ── Write aggregate round doc — matches AggregateRoundDocument ──
  const aggRef = gameRef.collection("rounds").doc(roundId);
  const avgRevenue = allRevenues.length > 0
    ? Math.round(allRevenues.reduce((a, b) => a + b, 0) / allRevenues.length)
    : 0;
  const avgCustCount = allCustomerCounts.length > 0
    ? Math.round(allCustomerCounts.reduce((a, b) => a + b, 0) / allCustomerCounts.length)
    : 0;

  batch.set(aggRef, {
    round: roundNumber,
    auctionResults: {
      ads: adAuctionResults,
      chef: {
        winnerId: chefWinnerId,
        winningBid: chefWinningBid,
        skillLevel: chefSkillLevel,
      },
    },
    classStats: {
      avgRevenue,
      maxRevenue: allRevenues.length > 0 ? Math.max(...allRevenues) : 0,
      minRevenue: allRevenues.length > 0 ? Math.min(...allRevenues) : 0,
      avgCustomerCount: avgCustCount,
      totalCustomerPool,
    },
    completedAt: FieldValue.serverTimestamp(),
  });

  // ── Write leaderboard — matches LeaderboardDocument ──
  leaderboardEntries.sort((a, b) => b.cumulativeRevenue - a.cumulativeRevenue);

  // Compute rank changes (compare to previous leaderboard)
  const prevLeaderboardSnap = await gameRef.collection("leaderboard").doc("current").get();
  const prevRankings = {};
  if (prevLeaderboardSnap.exists) {
    const prevData = prevLeaderboardSnap.data();
    for (const entry of (prevData.rankings || [])) {
      prevRankings[entry.playerId] = entry.rank;
    }
  }

  const rankings = leaderboardEntries.map((entry, index) => {
    const newRank = index + 1;
    const prevRank = prevRankings[entry.playerId] || newRank;
    return {
      rank: newRank,
      playerId: entry.playerId,
      displayName: entry.displayName,
      cumulativeRevenue: entry.cumulativeRevenue,
      lastRoundRevenue: entry.lastRoundRevenue,
      rankChange: prevRank - newRank, // positive = moved up
    };
  });

  batch.set(gameRef.collection("leaderboard").doc("current"), {
    rankings,
    updatedAt: FieldValue.serverTimestamp(),
    round: roundNumber,
  });

  await batch.commit();

  logger.info(`Game ${gameId} round ${roundNumber}: simulation complete. ${players.length} players processed.`);
}

// ═════════════════════════════════════════════════════════════
// 7. exportCsv  — Player downloads their own CSV
// ═════════════════════════════════════════════════════════════

const CSV_COLUMNS = [
  "day", "revenue", "num_products", "avg_price", "staff_count", "ad_spend",
  "customer_count", "customer_satisfaction", "headchef_skill",
  "croissant", "cookie", "bagel", "sandwich", "latte", "matcha_latte", "ad_type",
];

exports.exportCsv = onCall(async (request) => {
  const uid = requireAuth(request);
  const data = request.data || {};
  const gameId = cleanString(data.gameId);

  if (!gameId) {
    throw new HttpsError("invalid-argument", "gameId is required.");
  }

  const gameRef = db.collection("games").doc(gameId);

  // Verify player belongs to this game
  const playerSnap = await gameRef.collection("players").doc(uid).get();
  if (!playerSnap.exists) {
    throw new HttpsError("not-found", "You are not a player in this game.");
  }

  // Read all CSV rows for this player
  const csvSnap = await gameRef
    .collection("csvRows")
    .doc(uid)
    .collection("rounds")
    .orderBy("round")
    .get();

  if (csvSnap.empty) {
    return { csv: CSV_COLUMNS.join(",") + "\n", rowCount: 0 };
  }

  let csv = CSV_COLUMNS.join(",") + "\n";
  let rowCount = 0;

  for (const doc of csvSnap.docs) {
    const row = doc.data().row;
    const values = CSV_COLUMNS.map((col) => {
      const val = row[col];
      return val !== undefined && val !== null ? val : "";
    });
    csv += values.join(",") + "\n";
    rowCount++;
  }

  return { csv, rowCount };
});

// ═════════════════════════════════════════════════════════════
// 8. professorExport  — Professor downloads all-player CSV
// ═════════════════════════════════════════════════════════════

exports.professorExport = onCall(async (request) => {
  const data = request.data || {};
  const gameId = cleanString(data.gameId);

  if (!gameId) {
    throw new HttpsError("invalid-argument", "gameId is required.");
  }

  const gameRef = db.collection("games").doc(gameId);
  await requireProfessor(request, gameRef);

  // Read all players
  const playersSnap = await gameRef.collection("players").get();
  const playerNames = {};
  for (const doc of playersSnap.docs) {
    playerNames[doc.id] = doc.data().displayName || doc.id;
  }

  // Columns: bakery_name + all CSV columns
  const exportColumns = ["bakery_name", ...CSV_COLUMNS];
  let csv = exportColumns.join(",") + "\n";
  let rowCount = 0;

  for (const playerDoc of playersSnap.docs) {
    const playerId = playerDoc.id;
    const bakeryName = playerNames[playerId];

    const csvSnap = await gameRef
      .collection("csvRows")
      .doc(playerId)
      .collection("rounds")
      .orderBy("round")
      .get();

    for (const doc of csvSnap.docs) {
      const row = doc.data().row;
      // Escape bakery name if it contains commas
      const safeName = bakeryName.includes(",") ? `"${bakeryName}"` : bakeryName;
      const values = CSV_COLUMNS.map((col) => {
        const val = row[col];
        return val !== undefined && val !== null ? val : "";
      });
      csv += safeName + "," + values.join(",") + "\n";
      rowCount++;
    }
  }

  return { csv, rowCount, playerCount: playersSnap.size };
});
