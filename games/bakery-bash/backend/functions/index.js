const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const {
  FieldValue,
  Timestamp,
  getFirestore,
} = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();

const PRODUCT_KEYS = [
  "croissant",
  "cookie",
  "bagel",
  "sandwich",
  "latte",
  "matchaLatte",
];

const AD_TYPES = ["TV", "Billboard", "Radio", "Newspaper"];

const DEFAULT_CONFIG = {
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
  chefBonusPerPoint: 5,
  customerPoolMultiplier: 100,
  attractivenessWeights: {
    priceWeight: 100,
    staffWeight: 5,
    adSpendWeight: 0.3,
    numProductsWeight: 10,
  },
};

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

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrDefault(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function objectOrDefault(value, fallback) {
  return value && typeof value === "object" ? value : fallback;
}

function mergeConfig(rawConfig = {}) {
  const revenueModel = objectOrDefault(
    rawConfig.revenueModel,
    DEFAULT_CONFIG.revenueModel
  );
  const adBonuses = objectOrDefault(rawConfig.adBonuses, DEFAULT_CONFIG.adBonuses);
  const attractivenessWeights = objectOrDefault(
    rawConfig.attractivenessWeights,
    DEFAULT_CONFIG.attractivenessWeights
  );

  return {
    costPerStaffPerRound: numberOrDefault(
      rawConfig.costPerStaffPerRound,
      DEFAULT_CONFIG.costPerStaffPerRound
    ),
    unitCostPerProduct: numberOrDefault(
      rawConfig.unitCostPerProduct,
      DEFAULT_CONFIG.unitCostPerProduct
    ),
    revenueModel: {
      base: numberOrDefault(revenueModel.base, DEFAULT_CONFIG.revenueModel.base),
      staffCoefficient: numberOrDefault(
        revenueModel.staffCoefficient,
        DEFAULT_CONFIG.revenueModel.staffCoefficient
      ),
      priceCoefficient: numberOrDefault(
        revenueModel.priceCoefficient,
        DEFAULT_CONFIG.revenueModel.priceCoefficient
      ),
      adSpendCoefficient: numberOrDefault(
        revenueModel.adSpendCoefficient,
        DEFAULT_CONFIG.revenueModel.adSpendCoefficient
      ),
      numProductsCoefficient: numberOrDefault(
        revenueModel.numProductsCoefficient,
        DEFAULT_CONFIG.revenueModel.numProductsCoefficient
      ),
      noiseMin: numberOrDefault(
        revenueModel.noiseMin,
        DEFAULT_CONFIG.revenueModel.noiseMin
      ),
      noiseMax: numberOrDefault(
        revenueModel.noiseMax,
        DEFAULT_CONFIG.revenueModel.noiseMax
      ),
    },
    adBonuses: Object.fromEntries(
      AD_TYPES.map((adType) => [
        adType,
        numberOrDefault(adBonuses[adType], DEFAULT_CONFIG.adBonuses[adType]),
      ])
    ),
    chefBonusPerPoint: numberOrDefault(
      rawConfig.chefBonusPerPoint,
      DEFAULT_CONFIG.chefBonusPerPoint
    ),
    customerPoolMultiplier: numberOrDefault(
      rawConfig.customerPoolMultiplier,
      DEFAULT_CONFIG.customerPoolMultiplier
    ),
    attractivenessWeights: {
      priceWeight: numberOrDefault(
        attractivenessWeights.priceWeight,
        DEFAULT_CONFIG.attractivenessWeights.priceWeight
      ),
      staffWeight: numberOrDefault(
        attractivenessWeights.staffWeight,
        DEFAULT_CONFIG.attractivenessWeights.staffWeight
      ),
      adSpendWeight: numberOrDefault(
        attractivenessWeights.adSpendWeight,
        DEFAULT_CONFIG.attractivenessWeights.adSpendWeight
      ),
      numProductsWeight: numberOrDefault(
        attractivenessWeights.numProductsWeight,
        DEFAULT_CONFIG.attractivenessWeights.numProductsWeight
      ),
    },
  };
}

function gaussianNoise(min, max) {
  let u = 0;
  let v = 0;

  while (u === 0) {
    u = Math.random();
  }
  while (v === 0) {
    v = Math.random();
  }

  const standardNormal =
    Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const mean = (min + max) / 2;
  const stdDev = (max - min) / 6;
  const value = mean + standardNormal * stdDev;

  return Math.max(min, Math.min(max, value));
}

function activeProducts(menu = {}) {
  return PRODUCT_KEYS.filter((product) => menu[product] === true);
}

function averagePrice(menu, productPrices = {}) {
  const products = activeProducts(menu);
  const prices = products
    .map((product) => numberOrDefault(productPrices[product], 0))
    .filter((price) => price > 0);

  if (!prices.length) {
    return 0;
  }

  return prices.reduce((total, price) => total + price, 0) / prices.length;
}

function totalQuantityCost(quantities = {}, unitCostPerProduct) {
  return PRODUCT_KEYS.reduce((total, product) => {
    return total + Math.max(0, numberOrDefault(quantities[product], 0));
  }, 0) * unitCostPerProduct;
}

function computeRevenue(config, inputs) {
  const model = config.revenueModel;
  const noise = gaussianNoise(model.noiseMin, model.noiseMax);

  return (
    model.base +
    model.staffCoefficient * inputs.staffCount +
    model.priceCoefficient * inputs.avgPrice +
    model.adSpendCoefficient * inputs.adSpend +
    model.numProductsCoefficient * inputs.numProducts +
    config.chefBonusPerPoint * inputs.headchefSkill +
    inputs.adBonus +
    noise
  );
}

function attractivenessScore(config, decision, avgPrice, numProducts) {
  const weights = config.attractivenessWeights;
  const staffCount = Math.max(0, numberOrDefault(decision.staffCount, 0));
  const adSpend = Math.max(0, numberOrDefault(decision.adSpend, 0));

  return (
    (avgPrice > 0 ? (1 / avgPrice) * weights.priceWeight : 0) +
    staffCount * weights.staffWeight +
    adSpend * weights.adSpendWeight +
    numProducts * weights.numProductsWeight
  );
}

function allocateCustomers(totalCustomers, playerInputs) {
  const totalScore = playerInputs.reduce(
    (total, playerInput) => total + playerInput.attractivenessScore,
    0
  );

  if (!playerInputs.length) {
    return new Map();
  }

  if (totalScore <= 0) {
    const evenShare = Math.floor(totalCustomers / playerInputs.length);
    return new Map(
      playerInputs.map((playerInput) => [playerInput.playerId, evenShare])
    );
  }

  return new Map(
    playerInputs.map((playerInput) => [
      playerInput.playerId,
      Math.floor(
        (playerInput.attractivenessScore / totalScore) * totalCustomers
      ),
    ])
  );
}

function customerSatisfaction(decision, customerCount, avgPrice, numProducts) {
  const staffCount = Math.max(0, numberOrDefault(decision.staffCount, 0));
  let satisfaction = 70;

  satisfaction += numProducts * 3;
  satisfaction -= Math.max(0, avgPrice - 8) * 2;

  if (staffCount > 0) {
    satisfaction -= Math.max(0, customerCount / staffCount - 20) * 0.5;
  } else if (customerCount > 0) {
    satisfaction -= 25;
  }

  return Math.max(0, Math.min(100, satisfaction));
}

function productsSold(decision, customerCount) {
  const products = activeProducts(decision.menu);
  const demandPerProduct = products.length
    ? Math.floor(customerCount / products.length)
    : 0;

  return Object.fromEntries(
    PRODUCT_KEYS.map((product) => {
      if (!products.includes(product)) {
        return [product, 0];
      }

      const stocked = Math.max(
        0,
        numberOrDefault(objectOrDefault(decision.quantities, {})[product], 0)
      );
      return [product, Math.min(demandPerProduct, stocked)];
    })
  );
}

function adTypeForDecision(decision) {
  const adBid = objectOrDefault(decision.adBid, {});
  return AD_TYPES.includes(adBid.adType) ? adBid.adType : null;
}

function resolveAuctions(playerInputs) {
  const adWinners = Object.fromEntries(
    AD_TYPES.map((adType) => [adType, { winnerId: null, winningBid: 0 }])
  );
  const chefWinner = { winnerId: null, winningBid: 0, skillLevel: 0 };

  for (const input of playerInputs) {
    const adBid = objectOrDefault(input.decision.adBid, {});
    const adType = adTypeForDecision(input.decision);
    const adAmount = Math.max(0, numberOrDefault(adBid.amount, 0));

    if (adType && adAmount > adWinners[adType].winningBid) {
      adWinners[adType] = {
        winnerId: input.playerId,
        winningBid: adAmount,
      };
    }

    const chefBid = objectOrDefault(input.decision.chefBid, {});
    const chefAmount = Math.max(0, numberOrDefault(chefBid.amount, 0));

    if (chefAmount > chefWinner.winningBid) {
      chefWinner.winnerId = input.playerId;
      chefWinner.winningBid = chefAmount;
      chefWinner.skillLevel = Math.max(
        0,
        Math.min(100, numberOrDefault(chefBid.skillLevel, 0))
      );
    }
  }

  return { ads: adWinners, chef: chefWinner };
}

function roundNumberFromId(roundId) {
  const match = /^round_(\d+)$/.exec(roundId);
  return match ? Number.parseInt(match[1], 10) : Number.NaN;
}

async function claimSimulationRun(gameId, roundId) {
  const gameRef = db.collection("games").doc(gameId);
  const roundRef = gameRef.collection("rounds").doc(roundId);
  const roundNumber = roundNumberFromId(roundId);
  let shouldRun = false;

  await db.runTransaction(async (transaction) => {
    const gameSnap = await transaction.get(gameRef);

    if (!gameSnap.exists) {
      logger.warn("Decision submitted for missing game.", { gameId, roundId });
      return;
    }

    const game = gameSnap.data();
    const phase = game.phase;

    if (phase !== "decide" && phase !== "bid") {
      logger.info("Decision submitted outside simulation-ready phase.", {
        gameId,
        roundId,
        phase,
      });
      return;
    }

    if (game.currentRound !== roundNumber) {
      logger.info("Decision submitted for non-current round.", {
        gameId,
        roundId,
        currentRound: game.currentRound,
      });
      return;
    }

    const playersSnap = await transaction.get(gameRef.collection("players"));

    if (playersSnap.empty) {
      logger.warn("Simulation skipped because game has no players.", {
        gameId,
        roundId,
      });
      return;
    }

    const decisionSnaps = await Promise.all(
      playersSnap.docs.map((playerDoc) =>
        transaction.get(playerDoc.ref.collection("decisions").doc(roundId))
      )
    );

    const submittedCount = decisionSnaps.filter((snap) => snap.exists).length;

    if (submittedCount < playersSnap.size) {
      transaction.update(gameRef, {
        submittedCount,
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.info("Waiting for remaining player decisions.", {
        gameId,
        roundId,
        submittedCount,
        totalPlayers: playersSnap.size,
      });
      return;
    }

    const roundSnap = await transaction.get(roundRef);
    const simulationStatus = roundSnap.exists
      ? roundSnap.get("simulationStatus")
      : null;

    if (simulationStatus === "running" || simulationStatus === "complete") {
      logger.info("Simulation already claimed.", {
        gameId,
        roundId,
        simulationStatus,
      });
      return;
    }

    transaction.set(
      roundRef,
      {
        round: roundNumber,
        simulationStatus: "running",
        simulationStartedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    transaction.update(gameRef, {
      phase: "simulating",
      submittedCount,
      updatedAt: FieldValue.serverTimestamp(),
    });
    shouldRun = true;
  });

  return shouldRun;
}

async function runRoundSimulation(gameId, roundId) {
  const gameRef = db.collection("games").doc(gameId);
  const configRef = gameRef.collection("config").doc("params");
  const roundRef = gameRef.collection("rounds").doc(roundId);
  const roundNumber = roundNumberFromId(roundId);

  const [gameSnap, configSnap, playersSnap] = await Promise.all([
    gameRef.get(),
    configRef.get(),
    gameRef.collection("players").get(),
  ]);

  if (!gameSnap.exists) {
    throw new Error(`Game ${gameId} not found.`);
  }

  const config = mergeConfig(configSnap.exists ? configSnap.data() : {});
  const playerDocs = playersSnap.docs;
  const decisionSnaps = await Promise.all(
    playerDocs.map((playerDoc) =>
      playerDoc.ref.collection("decisions").doc(roundId).get()
    )
  );

  const playerInputs = playerDocs.map((playerDoc, index) => {
    const player = playerDoc.data();
    const decision = decisionSnaps[index].data();
    const avgPrice = averagePrice(decision.menu, decision.productPrices);
    const numProducts = activeProducts(decision.menu).length;

    return {
      playerId: playerDoc.id,
      player,
      decision,
      avgPrice,
      numProducts,
      attractivenessScore: attractivenessScore(
        config,
        decision,
        avgPrice,
        numProducts
      ),
    };
  });

  const auctions = resolveAuctions(playerInputs);
  const totalCustomers = Math.max(
    0,
    Math.floor(config.customerPoolMultiplier * playerInputs.length)
  );
  const customerCounts = allocateCustomers(totalCustomers, playerInputs);
  const results = [];

  for (const input of playerInputs) {
    const decision = input.decision;
    const player = input.player;
    const staffCount = Math.max(0, numberOrDefault(decision.staffCount, 0));
    const adSpend = Math.max(0, numberOrDefault(decision.adSpend, 0));
    const adTypeWon =
      AD_TYPES.find((adType) => auctions.ads[adType].winnerId === input.playerId) ||
      null;
    const adWinningBid = adTypeWon ? auctions.ads[adTypeWon].winningBid : 0;
    const wonChef = auctions.chef.winnerId === input.playerId;
    const chefWinningBid = wonChef ? auctions.chef.winningBid : 0;
    const headchefSkill = wonChef ? auctions.chef.skillLevel : 0;
    const adBonus = adTypeWon ? config.adBonuses[adTypeWon] : 0;
    const chefBonus = headchefSkill * config.chefBonusPerPoint;
    const customerCount = customerCounts.get(input.playerId) || 0;
    const productsSoldForRound = productsSold(decision, customerCount);
    const staffingCost = staffCount * config.costPerStaffPerRound;
    const stockCost = totalQuantityCost(
      objectOrDefault(decision.quantities, {}),
      config.unitCostPerProduct
    );
    const creditCost = 0;
    const totalCosts =
      staffingCost + adSpend + stockCost + adWinningBid + chefWinningBid + creditCost;
    const budgetBefore = numberOrDefault(player.budgetCurrent, 0);
    const creditBalanceBefore = numberOrDefault(player.creditBalance, 0);
    const revenue = Math.round(
      computeRevenue(config, {
        staffCount,
        avgPrice: input.avgPrice,
        adSpend,
        numProducts: input.numProducts,
        headchefSkill,
        adBonus,
      })
    );
    const budgetAfter = Math.round(budgetBefore + revenue - totalCosts);
    const satisfaction = Number(
      customerSatisfaction(
        decision,
        customerCount,
        input.avgPrice,
        input.numProducts
      ).toFixed(1)
    );

    results.push({
      playerId: input.playerId,
      displayName: player.displayName,
      cumulativeRevenue:
        numberOrDefault(player.cumulativeRevenue, 0) + revenue,
      result: {
        round: roundNumber,
        revenue,
        customerCount,
        customerSatisfaction: satisfaction,
        headchefSkill,
        adTypeWon,
        adBonus,
        chefBonus,
        productsSold: productsSoldForRound,
        avgPrice: input.avgPrice,
        productPrices: objectOrDefault(decision.productPrices, {}),
        menu: objectOrDefault(decision.menu, {}),
        quantitySubmitted: objectOrDefault(decision.quantities, {}),
        staffCount,
        adSpend,
        numProducts: input.numProducts,
        revenueGross: revenue,
        staffingCost,
        stockCost,
        creditCost,
        creditBalanceBefore,
        creditBalanceAfter: creditBalanceBefore,
        totalCosts,
        budgetBefore,
        budgetAfter,
        computedAt: FieldValue.serverTimestamp(),
      },
    });
  }

  const rankings = results
    .slice()
    .sort((a, b) => b.cumulativeRevenue - a.cumulativeRevenue)
    .map((result, index) => ({
      rank: index + 1,
      playerId: result.playerId,
      displayName: result.displayName,
      cumulativeRevenue: result.cumulativeRevenue,
      lastRoundRevenue: result.result.revenue,
      rankChange: 0,
    }));

  const revenues = results.map((result) => result.result.revenue);
  const customerCountsList = results.map((result) => result.result.customerCount);
  const batch = db.batch();

  for (const result of results) {
    const playerRef = gameRef.collection("players").doc(result.playerId);
    const playerRoundRef = playerRef.collection("rounds").doc(roundId);
    const csvRowRef = gameRef
      .collection("csvRows")
      .doc(result.playerId)
      .collection("rounds")
      .doc(roundId);

    batch.set(playerRoundRef, result.result);
    batch.update(playerRef, {
      budgetCurrent: result.result.budgetAfter,
      cumulativeRevenue: FieldValue.increment(result.result.revenue),
      lastRoundResult: {
        round: roundNumber,
        revenue: result.result.revenue,
        customerCount: result.result.customerCount,
        customerSatisfaction: result.result.customerSatisfaction,
        headchefSkill: result.result.headchefSkill,
        adTypeWon: result.result.adTypeWon,
        productsSold: result.result.productsSold,
      },
    });
    batch.set(csvRowRef, {
      playerId: result.playerId,
      round: roundNumber,
      row: {
        day: roundNumber,
        revenue: result.result.revenue,
        num_products: result.result.numProducts,
        avg_price: result.result.avgPrice,
        staff_count: result.result.staffCount,
        ad_spend: result.result.adSpend,
        customer_count: result.result.customerCount,
        customer_satisfaction: result.result.customerSatisfaction,
        headchef_skill: result.result.headchefSkill,
        croissant: result.result.productsSold.croissant,
        cookie: result.result.productsSold.cookie,
        bagel: result.result.productsSold.bagel,
        sandwich: result.result.productsSold.sandwich,
        latte: result.result.productsSold.latte,
        matcha_latte: result.result.productsSold.matchaLatte,
        ad_type: result.result.adTypeWon || "none",
      },
    });
  }

  batch.set(
    roundRef,
    {
      round: roundNumber,
      auctionResults: auctions,
      classStats: {
        avgRevenue: revenues.length
          ? revenues.reduce((total, revenue) => total + revenue, 0) /
            revenues.length
          : 0,
        maxRevenue: revenues.length ? Math.max(...revenues) : 0,
        minRevenue: revenues.length ? Math.min(...revenues) : 0,
        avgCustomerCount: customerCountsList.length
          ? customerCountsList.reduce((total, count) => total + count, 0) /
            customerCountsList.length
          : 0,
        totalCustomerPool: totalCustomers,
      },
      simulationStatus: "complete",
      completedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  batch.set(gameRef.collection("leaderboard").doc("current"), {
    rankings,
    updatedAt: FieldValue.serverTimestamp(),
    round: roundNumber,
  });
  batch.update(gameRef, {
    phase: "results_ready",
    phaseEndTime: null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();
}

exports.onDecisionSubmitted = onDocumentCreated(
  "games/{gameId}/players/{playerId}/decisions/{roundId}",
  async (event) => {
    const { gameId, roundId } = event.params;
    const roundNumber = roundNumberFromId(roundId);

    if (!Number.isInteger(roundNumber)) {
      logger.warn("Ignoring decision with invalid round id.", {
        gameId,
        roundId,
      });
      return;
    }

    try {
      const shouldRun = await claimSimulationRun(gameId, roundId);

      if (!shouldRun) {
        return;
      }

      await runRoundSimulation(gameId, roundId);
      logger.info("Revenue simulation complete.", { gameId, roundId });
    } catch (error) {
      logger.error("Revenue simulation failed.", { gameId, roundId, error });
      await db.collection("games").doc(gameId).collection("rounds").doc(roundId).set(
        {
          simulationStatus: "failed",
          simulationError:
            error instanceof Error ? error.message : "Unknown simulation error",
          failedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      throw error;
    }
  }
);

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
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Sign in anonymously before joining a game."
    );
  }

  const uid = request.auth.uid;
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
      creditBalance: 0,
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
