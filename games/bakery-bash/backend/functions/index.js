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

const ROUND_PHASES = [
  "closing_hours",
  "auction",
  "open_for_business",
  "results",
];

const CSV_COLUMNS = [
  "day",
  "revenue",
  "num_products",
  "avg_price",
  "staff_count",
  "ad_spend",
  "customer_count",
  "customer_satisfaction",
  "headchef_skill",
  "croissant",
  "cookie",
  "bagel",
  "sandwich",
  "latte",
  "matcha_latte",
  "ad_type",
];

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
  phaseDurations: {
    closing_hours: 180,
    auction: 90,
    open_for_business: 30,
    results: 60,
  },
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
  const phaseDurations = objectOrDefault(
    rawConfig.phaseDurations,
    DEFAULT_CONFIG.phaseDurations
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
    phaseDurations: {
      closing_hours: numberOrDefault(
        phaseDurations.closing_hours ?? phaseDurations.decide,
        DEFAULT_CONFIG.phaseDurations.closing_hours
      ),
      auction: numberOrDefault(
        phaseDurations.auction ?? phaseDurations.bid,
        DEFAULT_CONFIG.phaseDurations.auction
      ),
      open_for_business: numberOrDefault(
        phaseDurations.open_for_business ?? phaseDurations.simulate,
        DEFAULT_CONFIG.phaseDurations.open_for_business
      ),
      results: numberOrDefault(
        phaseDurations.results,
        DEFAULT_CONFIG.phaseDurations.results
      ),
    },
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

function cleanGameId(value) {
  const gameId = cleanString(value);

  if (!/^[A-Za-z0-9_-]{3,80}$/.test(gameId)) {
    throw new HttpsError(
      "invalid-argument",
      "gameId must be a valid game document id."
    );
  }

  return gameId;
}

function phaseEndTimeFromNow(config, phase) {
  const durationSeconds = numberOrDefault(
    config.phaseDurations[phase],
    DEFAULT_CONFIG.phaseDurations[phase] || 60
  );

  return Timestamp.fromMillis(Date.now() + durationSeconds * 1000);
}

function nextPhaseFor(game) {
  const currentRound = numberOrDefault(game.currentRound, 1);
  const totalRounds = numberOrDefault(game.totalRounds, 5);

  if (game.phase === "lobby") {
    return { phase: "closing_hours", round: 1 };
  }

  if (game.phase === "closing_hours" || game.phase === "decide") {
    return { phase: "auction", round: currentRound };
  }

  if (game.phase === "auction" || game.phase === "bid") {
    return { phase: "open_for_business", round: currentRound };
  }

  if (game.phase === "open_for_business" || game.phase === "simulating") {
    return { phase: "results", round: currentRound };
  }

  if (game.phase === "results" || game.phase === "results_ready") {
    if (currentRound >= totalRounds) {
      return { phase: "game_over", round: currentRound };
    }

    return { phase: "closing_hours", round: currentRound + 1 };
  }

  if (game.phase === "game_over") {
    throw new HttpsError("failed-precondition", "This game is already over.");
  }

  throw new HttpsError(
    "failed-precondition",
    `Cannot advance unknown phase: ${game.phase}`
  );
}

async function assertProfessor(request, gameRef) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in before controlling a game.");
  }

  const gameSnap = await gameRef.get();

  if (!gameSnap.exists) {
    throw new HttpsError("not-found", "Game not found.");
  }

  if (gameSnap.get("professorId") !== request.auth.uid) {
    throw new HttpsError(
      "permission-denied",
      "Only the professor can control game phases."
    );
  }

  return gameSnap;
}

function csvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const stringValue = String(value);

  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }

  return stringValue;
}

function rowsToCsv(rows) {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((column) => csvCell(row[column])).join(",")
  );

  return [header, ...lines].join("\n");
}

async function buildPlayerCsvEmail({
  gameRef,
  playerId,
  displayName,
  completedRound,
  currentRow,
}) {
  const previousRowsSnap = await gameRef
    .collection("csvRows")
    .doc(playerId)
    .collection("rounds")
    .get();
  const previousRows = previousRowsSnap.docs
    .map((doc) => ({
      round: numberOrDefault(doc.get("round"), 0),
      row: doc.get("row"),
    }))
    .filter((entry) => entry.round > 0 && entry.round < completedRound)
    .sort((a, b) => a.round - b.round)
    .map((entry) => entry.row);
  const rows = [...previousRows, currentRow];
  const nextRound = completedRound + 1;

  return {
    type: "round_data_csv",
    round: nextRound,
    availableAfterRound: completedRound,
    recipientPlayerId: playerId,
    subject: `Round ${completedRound} data is ready`,
    sender: "Bakery Bash Analytics",
    body:
      `Hi ${displayName || "there"}, your latest performance data is attached. ` +
      `Use this CSV before Round ${nextRound} to update your model and plan decisions.`,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
    attachments: [
      {
        filename: `bakery-bash-through-round-${completedRound}.csv`,
        contentType: "text/csv",
        csvText: rowsToCsv(rows),
        rowCount: rows.length,
        includedThroughRound: completedRound,
      },
    ],
  };
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

    if (
      phase !== "closing_hours" &&
      phase !== "auction" &&
      phase !== "open_for_business" &&
      phase !== "decide" &&
      phase !== "bid"
    ) {
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

    const configSnap = await transaction.get(gameRef.collection("config").doc("params"));
    const config = mergeConfig(configSnap.exists ? configSnap.data() : {});
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
      phase: "open_for_business",
      phaseEndTime: phaseEndTimeFromNow(config, "open_for_business"),
      submittedCount,
      phaseStartedAt: FieldValue.serverTimestamp(),
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
    const decision = decisionSnaps[index].exists
      ? decisionSnaps[index].data()
      : objectOrDefault(player.pendingDecision, DEFAULT_PENDING_DECISION);
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
    const csvRow = {
      day: roundNumber,
      revenue,
      num_products: input.numProducts,
      avg_price: input.avgPrice,
      staff_count: staffCount,
      ad_spend: adSpend,
      customer_count: customerCount,
      customer_satisfaction: satisfaction,
      headchef_skill: headchefSkill,
      croissant: productsSoldForRound.croissant,
      cookie: productsSoldForRound.cookie,
      bagel: productsSoldForRound.bagel,
      sandwich: productsSoldForRound.sandwich,
      latte: productsSoldForRound.latte,
      matcha_latte: productsSoldForRound.matchaLatte,
      ad_type: adTypeWon || "none",
    };

    results.push({
      playerId: input.playerId,
      displayName: player.displayName,
      cumulativeRevenue:
        numberOrDefault(player.cumulativeRevenue, 0) + revenue,
      csvRow,
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
  const emailDocs = await Promise.all(
    results.map((result) =>
      buildPlayerCsvEmail({
        gameRef,
        playerId: result.playerId,
        displayName: result.displayName,
        completedRound: roundNumber,
        currentRow: result.csvRow,
      })
    )
  );
  const batch = db.batch();

  for (const [index, result] of results.entries()) {
    const playerRef = gameRef.collection("players").doc(result.playerId);
    const playerRoundRef = playerRef.collection("rounds").doc(roundId);
    const csvRowRef = gameRef
      .collection("csvRows")
      .doc(result.playerId)
      .collection("rounds")
      .doc(roundId);
    const emailRef = playerRef
      .collection("emails")
      .doc(`round_${roundNumber + 1}_data`);

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
      row: result.csvRow,
    });
    batch.set(emailRef, emailDocs[index]);
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
    phase: "results",
    phaseEndTime: phaseEndTimeFromNow(config, "results"),
    phaseStartedAt: FieldValue.serverTimestamp(),
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

exports.startGame = onCall(async (request) => {
  const gameId = cleanGameId(request.data?.gameId);
  const gameRef = db.collection("games").doc(gameId);
  const gameSnap = await assertProfessor(request, gameRef);

  if (gameSnap.get("phase") !== "lobby") {
    throw new HttpsError(
      "failed-precondition",
      "Only lobby games can be started."
    );
  }

  const configSnap = await gameRef.collection("config").doc("params").get();
  const config = mergeConfig(configSnap.exists ? configSnap.data() : {});
  const phaseEndTime = phaseEndTimeFromNow(config, "closing_hours");

  await gameRef.update({
    phase: "closing_hours",
    currentRound: 1,
    submittedCount: 0,
    phaseStartedAt: FieldValue.serverTimestamp(),
    phaseEndTime,
    startedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    gameId,
    phase: "closing_hours",
    currentRound: 1,
    phaseEndTime: phaseEndTime.toMillis(),
  };
});

exports.advanceGamePhase = onCall(async (request) => {
  const gameId = cleanGameId(request.data?.gameId);
  const gameRef = db.collection("games").doc(gameId);
  await assertProfessor(request, gameRef);

  let nextPhase;
  let currentRound;
  let shouldRunSimulation = false;

  await db.runTransaction(async (transaction) => {
    const gameSnap = await transaction.get(gameRef);
    const configSnap = await transaction.get(gameRef.collection("config").doc("params"));
    const game = gameSnap.data();
    const config = mergeConfig(configSnap.exists ? configSnap.data() : {});
    const next = nextPhaseFor(game);
    const update = {
      phase: next.phase,
      currentRound: next.round,
      phaseStartedAt: FieldValue.serverTimestamp(),
      phaseEndTime:
        next.phase === "game_over"
          ? null
          : phaseEndTimeFromNow(config, next.phase),
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (next.phase === "closing_hours") {
      update.submittedCount = 0;
    }

    if (next.phase === "game_over") {
      update.endedAt = FieldValue.serverTimestamp();
    }

    transaction.update(gameRef, update);
    nextPhase = next.phase;
    currentRound = next.round;
    shouldRunSimulation = next.phase === "open_for_business";
  });

  if (shouldRunSimulation) {
    await runRoundSimulation(gameId, `round_${currentRound}`);
  }

  const updatedGameSnap = await gameRef.get();
  const phaseEndTime = updatedGameSnap.get("phaseEndTime");

  return {
    gameId,
    phase: updatedGameSnap.get("phase"),
    requestedPhase: nextPhase,
    currentRound: updatedGameSnap.get("currentRound"),
    phaseEndTime:
      phaseEndTime instanceof Timestamp ? phaseEndTime.toMillis() : null,
  };
});

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
