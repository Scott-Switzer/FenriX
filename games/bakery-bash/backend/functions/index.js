const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const {
  FieldValue,
  Timestamp,
  getFirestore,
} = require("firebase-admin/firestore");

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();

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
