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

const AD_TYPE_LOOKUP = {
  tv: "TV",
  television: "TV",
  billboard: "Billboard",
  radio: "Radio",
  newspaper: "Newspaper",
};

const PRODUCT_ALIASES = {
  croissant: "croissant",
  cookie: "cookie",
  bagel: "bagel",
  sandwich: "sandwich",
  latte: "latte",
  matchaLatte: "matchaLatte",
  "matcha-latte": "matchaLatte",
  matcha_latte: "matchaLatte",
};

const MENU_CATEGORIES = {
  sweet: ["croissant", "cookie"],
  savory: ["bagel", "sandwich"],
  drink: ["latte", "matchaLatte"],
};

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

function normalizeProductKey(product) {
  return PRODUCT_ALIASES[product] || null;
}

function normalizeAdType(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return AD_TYPE_LOOKUP[String(value).trim().toLowerCase()] || null;
}

function integerInRange(value, fieldName, { min = 0, max = Number.MAX_SAFE_INTEGER }) {
  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} must be an integer from ${min} to ${max}.`
    );
  }

  return numberValue;
}

function nonNegativeNumber(value, fieldName) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} must be a non-negative number.`
    );
  }

  return numberValue;
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

function decisionRoundCost(config, decision) {
  const staffCount = Math.max(0, numberOrDefault(decision.staffCount, 0));
  const adSpend = Math.max(0, numberOrDefault(decision.adSpend, 0));
  const stockCost = totalQuantityCost(
    objectOrDefault(decision.quantities, {}),
    config.unitCostPerProduct
  );
  const adBid = objectOrDefault(decision.adBid, {});
  const chefBid = objectOrDefault(decision.chefBid, {});
  const adBidAmount = adTypeForDecision(decision)
    ? Math.max(0, numberOrDefault(adBid.amount, 0))
    : 0;
  const chefBidAmount = Math.max(0, numberOrDefault(chefBid.amount, 0));

  // adSpend is NOT added separately — adBidAmount already represents the
  // player's ad expenditure (validateDecisionInput sets adBid.amount = adSpend).
  // Adding both would double-charge the player.
  return (
    staffCount * config.costPerStaffPerRound +
    stockCost +
    adBidAmount +
    chefBidAmount
  );
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

function submittedAtMillis(decision) {
  const submittedAt = decision?.submittedAt;

  if (submittedAt instanceof Timestamp) {
    return submittedAt.toMillis();
  }

  if (submittedAt && typeof submittedAt.toMillis === "function") {
    return submittedAt.toMillis();
  }

  if (submittedAt instanceof Date) {
    return submittedAt.getTime();
  }

  return Number.POSITIVE_INFINITY;
}

function isWinningBid(amount, submittedAt, winner) {
  if (amount <= 0) {
    return false;
  }

  if (amount > winner.winningBid) {
    return true;
  }

  return amount === winner.winningBid && submittedAt < winner.submittedAtMillis;
}

function resolveAuctions(playerInputs) {
  const adWinners = Object.fromEntries(
    AD_TYPES.map((adType) => [
      adType,
      {
        winnerId: null,
        winningBid: 0,
        submittedAtMillis: Number.POSITIVE_INFINITY,
      },
    ])
  );
  const chefWinner = {
    winnerId: null,
    winningBid: 0,
    skillLevel: 0,
    submittedAtMillis: Number.POSITIVE_INFINITY,
  };

  for (const input of playerInputs) {
    const adBid = objectOrDefault(input.decision.adBid, {});
    const adType = adTypeForDecision(input.decision);
    const adAmount = Math.max(0, numberOrDefault(adBid.amount, 0));
    const submittedAt = submittedAtMillis(input.decision);

    if (adType && isWinningBid(adAmount, submittedAt, adWinners[adType])) {
      adWinners[adType] = {
        winnerId: input.playerId,
        winningBid: adAmount,
        submittedAtMillis: submittedAt,
      };
    }

    const chefBid = objectOrDefault(input.decision.chefBid, {});
    const chefAmount = Math.max(0, numberOrDefault(chefBid.amount, 0));

    if (isWinningBid(chefAmount, submittedAt, chefWinner)) {
      chefWinner.winnerId = input.playerId;
      chefWinner.winningBid = chefAmount;
      chefWinner.skillLevel = Math.max(
        0,
        Math.min(100, numberOrDefault(chefBid.skillLevel, 0))
      );
      chefWinner.submittedAtMillis = submittedAt;
    }
  }

  return {
    ads: Object.fromEntries(
      Object.entries(adWinners).map(([adType, winner]) => [
        adType,
        {
          winnerId: winner.winnerId,
          winningBid: winner.winningBid,
          tieBreaker: "earliest_submission",
        },
      ])
    ),
    chef: {
      winnerId: chefWinner.winnerId,
      winningBid: chefWinner.winningBid,
      skillLevel: chefWinner.skillLevel,
      tieBreaker: "earliest_submission",
    },
  };
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

function normalizeMenuPayload(data) {
  const rawMenu = data.menu ?? data.menuSelections ?? data.selectedMenu ?? {};
  const rawPrices = objectOrDefault(data.productPrices ?? data.prices, {});
  const rawQuantities = objectOrDefault(data.quantities ?? data.stockQuantities, {});
  const menu = Object.fromEntries(PRODUCT_KEYS.map((product) => [product, false]));
  const productPrices = Object.fromEntries(PRODUCT_KEYS.map((product) => [product, 0]));
  const quantities = Object.fromEntries(PRODUCT_KEYS.map((product) => [product, 0]));

  if (Array.isArray(rawMenu)) {
    for (const product of rawMenu) {
      const normalized = normalizeProductKey(product);

      if (!normalized) {
        throw new HttpsError(
          "invalid-argument",
          `Unknown menu item: ${product}.`
        );
      }

      menu[normalized] = true;
    }
  } else if (rawMenu && typeof rawMenu === "object") {
    for (const [product, selected] of Object.entries(rawMenu)) {
      const normalized = normalizeProductKey(product);

      if (!normalized) {
        throw new HttpsError(
          "invalid-argument",
          `Unknown menu item: ${product}.`
        );
      }

      menu[normalized] = selected === true;
    }
  } else {
    throw new HttpsError(
      "invalid-argument",
      "menu must be an array of selected items or an object keyed by menu item."
    );
  }

  for (const [product, price] of Object.entries(rawPrices)) {
    const normalized = normalizeProductKey(product);

    if (!normalized) {
      throw new HttpsError(
        "invalid-argument",
        `Unknown product price item: ${product}.`
      );
    }

    productPrices[normalized] = nonNegativeNumber(
      price,
      `productPrices.${product}`
    );
  }

  for (const [product, quantity] of Object.entries(rawQuantities)) {
    const normalized = normalizeProductKey(product);

    if (!normalized) {
      throw new HttpsError(
        "invalid-argument",
        `Unknown quantity item: ${product}.`
      );
    }

    quantities[normalized] = integerInRange(quantity, `quantities.${product}`, {
      min: 0,
      max: 10000,
    });
  }

  for (const product of PRODUCT_KEYS) {
    if (menu[product] && productPrices[product] <= 0) {
      throw new HttpsError(
        "invalid-argument",
        `${product} is on the menu and must have a price greater than $0.`
      );
    }
  }

  const activeMenuItems = activeProducts(menu);
  const hasCategory = (category) =>
    MENU_CATEGORIES[category].some((product) => menu[product] === true);

  if (!hasCategory("sweet")) {
    throw new HttpsError(
      "invalid-argument",
      "Menu must include at least one sweet item."
    );
  }

  if (!hasCategory("savory")) {
    throw new HttpsError(
      "invalid-argument",
      "Menu must include at least one savory item."
    );
  }

  if (!hasCategory("drink")) {
    throw new HttpsError(
      "invalid-argument",
      "Menu must include at least one drink."
    );
  }

  return {
    menu,
    productPrices,
    quantities,
    numProducts: activeMenuItems.length,
  };
}

function validateDecisionInput(data) {
  const staffCount = integerInRange(data.staffCount, "staffCount", {
    min: 1,
    max: 20,
  });
  const adSpend = nonNegativeNumber(data.adSpend ?? data.adBid?.amount ?? 0, "adSpend");
  const adType = normalizeAdType(data.adType ?? data.adBid?.adType);

  if (adSpend > 0 && !adType) {
    throw new HttpsError(
      "invalid-argument",
      "adType must be TV, Radio, Newspaper, or Billboard when adSpend is greater than $0."
    );
  }

  const chefBidData = objectOrDefault(data.chefBid, {});
  const chefBid = {
    skillLevel: integerInRange(chefBidData.skillLevel ?? 0, "chefBid.skillLevel", {
      min: 0,
      max: 100,
    }),
    amount: nonNegativeNumber(chefBidData.amount ?? 0, "chefBid.amount"),
  };
  const normalizedMenu = normalizeMenuPayload(data);

  return {
    staffCount,
    adSpend,
    ...normalizedMenu,
    adBid: {
      adType,
      amount: adSpend,
    },
    chefBid,
  };
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

/**
 * Mark a simulation as failed and roll the game phase back to closing_hours.
 *
 * Recovery path: professor calls advanceGamePhase again, which walks through
 * auction → open_for_business and re-triggers the simulation. Rolling back to
 * closing_hours (not auction) gives players the option to revise decisions if
 * the failure was caused by invalid data, while keeping existing decisions
 * intact if they choose not to resubmit.
 */
async function markSimulationFailed(gameId, roundId, error) {
  const gameRef = db.collection("games").doc(gameId);
  const configSnap = await gameRef.collection("config").doc("params").get();
  const config = mergeConfig(configSnap.exists ? configSnap.data() : {});
  const failureUpdate = {
    simulationStatus: "failed",
    simulationError:
      error instanceof Error ? error.message : "Unknown simulation error",
    failedAt: FieldValue.serverTimestamp(),
  };

  await gameRef.collection("rounds").doc(roundId).set(failureUpdate, { merge: true });
  await gameRef.update({
    phase: "closing_hours",
    phaseEndTime: phaseEndTimeFromNow(config, "closing_hours"),
    phaseStartedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
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
    // adSpend is NOT added separately — adWinningBid is the actual cost
    // the player pays if they win the ad auction. Adding adSpend on top
    // would double-charge them (adSpend = the bid amount).
    const totalCosts =
      staffingCost + stockCost + adWinningBid + chefWinningBid + creditCost;
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
        budgetDelta: revenue - totalCosts,
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
  const totalRounds = numberOrDefault(gameSnap.get("totalRounds"), 5);
  const isLastRound = roundNumber >= totalRounds;

  // Only build email docs if this is NOT the last round — there is no
  // round N+1 to deliver the email to, so writing round_6_data when
  // totalRounds=5 would create orphaned documents.
  const emailDocs = isLastRound
    ? []
    : await Promise.all(
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
      budgetCurrent: FieldValue.increment(result.result.budgetDelta),
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
    // Only write the email doc if we built one (skipped on last round)
    if (!isLastRound && emailDocs[index]) {
      batch.set(emailRef, emailDocs[index]);
    }
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
      await markSimulationFailed(gameId, roundId, error);
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
  let shouldClaimSimulation = false;

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

    nextPhase = next.phase;
    currentRound = next.round;

    transaction.update(gameRef, update);

    if (next.phase === "open_for_business") {
      shouldClaimSimulation = true;
    }
  });

  if (shouldClaimSimulation) {
    const roundId = `round_${currentRound}`;
    const shouldRunSimulation = await claimSimulationRun(gameId, roundId);

    if (shouldRunSimulation) {
      try {
        await runRoundSimulation(gameId, roundId);
        logger.info("Revenue simulation complete.", { gameId, roundId });
      } catch (error) {
        logger.error("Revenue simulation failed.", { gameId, roundId, error });
        await markSimulationFailed(gameId, roundId, error);
        throw error;
      }
    }
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

exports.submitDecision = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Sign in before submitting decisions."
    );
  }

  const data = request.data || {};
  const gameId = cleanGameId(data.gameId);
  const uid = request.auth.uid;
  const gameRef = db.collection("games").doc(gameId);
  const playerRef = gameRef.collection("players").doc(uid);
  const decision = validateDecisionInput(data);
  let roundId;

  await db.runTransaction(async (transaction) => {
    const [gameSnap, playerSnap, configSnap] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(playerRef),
      transaction.get(gameRef.collection("config").doc("params")),
    ]);

    if (!gameSnap.exists) {
      throw new HttpsError("not-found", "Game not found.");
    }

    if (!playerSnap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Join this game before submitting decisions."
      );
    }

    const game = gameSnap.data();

    if (game.phase !== "closing_hours" && game.phase !== "decide") {
      throw new HttpsError(
        "failed-precondition",
        "Decisions can only be submitted during Closing Hours."
      );
    }

    const currentRound = numberOrDefault(game.currentRound, 1);
    const requestedRound =
      data.round === undefined || data.round === null
        ? currentRound
        : integerInRange(data.round, "round", { min: 1, max: 100 });

    if (requestedRound !== currentRound) {
      throw new HttpsError(
        "failed-precondition",
        `This game is currently on round ${currentRound}.`
      );
    }

    roundId = `round_${currentRound}`;
    const decisionRef = playerRef.collection("decisions").doc(roundId);
    const decisionSnap = await transaction.get(decisionRef);

    if (decisionSnap.exists) {
      throw new HttpsError(
        "already-exists",
        "Decisions have already been submitted for this round."
      );
    }

    const config = mergeConfig(configSnap.exists ? configSnap.data() : {});
    const budgetCurrent = numberOrDefault(playerSnap.get("budgetCurrent"), 0);

    // Compute individual cost components to match DecisionDocument schema
    const staffingCost = decision.staffCount * config.costPerStaffPerRound;
    const creditCost = 0; // Pending Game Design sign-off (Open Q #6)
    const stockCost = totalQuantityCost(
      objectOrDefault(decision.quantities, {}),
      config.unitCostPerProduct
    );
    const adBidAmount = decision.adBid.adType
      ? Math.max(0, numberOrDefault(decision.adBid.amount, 0))
      : 0;
    const chefBidAmount = Math.max(0, numberOrDefault(decision.chefBid.amount, 0));
    const totalCosts = staffingCost + stockCost + adBidAmount + chefBidAmount + creditCost;

    if (totalCosts > budgetCurrent) {
      throw new HttpsError(
        "failed-precondition",
        `This decision costs $${totalCosts.toFixed(2)}, but your current budget is $${budgetCurrent.toFixed(2)}.`
      );
    }

    const decisionDoc = {
      round: currentRound,
      submittedAt: FieldValue.serverTimestamp(),
      staffCount: decision.staffCount,
      adSpend: decision.adSpend,
      menu: decision.menu,
      productPrices: decision.productPrices,
      quantities: decision.quantities,
      adBid: decision.adBid,
      chefBid: decision.chefBid,
      numProducts: decision.numProducts,
      budgetBefore: budgetCurrent,
      // Match DecisionDocument schema fields (staffingCost, creditCost, totalCosts)
      staffingCost,
      creditCost,
      totalCosts,
    };

    transaction.set(decisionRef, decisionDoc);
    transaction.update(playerRef, {
      pendingDecision: {
        submitted: true,
        submittedAt: FieldValue.serverTimestamp(),
        staffCount: decision.staffCount,
        adSpend: decision.adSpend,
        menu: decision.menu,
        productPrices: decision.productPrices,
        quantities: decision.quantities,
      },
      pendingBids: {
        adBid: decision.adBid,
        chefBid: decision.chefBid,
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return {
    gameId,
    playerId: uid,
    roundId,
    submitted: true,
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
