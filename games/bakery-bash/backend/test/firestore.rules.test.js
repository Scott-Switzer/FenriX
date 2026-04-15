const fs = require("node:fs");
const path = require("node:path");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const {
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} = require("firebase/firestore");

const PROJECT_ID = "bakery-bash-rules-test";
const GAME_ID = "game_abc123";
const PLAYER_A = "uid_player_a";
const PLAYER_B = "uid_player_b";

let testEnv;

const pendingDecision = {
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

const pendingBids = {
  adBid: {
    adType: null,
    amount: 0,
  },
  chefBid: {
    skillLevel: 0,
    amount: 0,
  },
};

function playerDocument(uid, displayName) {
  return {
    uid,
    displayName,
    joinedAt: null,
    budgetCurrent: 2000,
    creditBalance: 0,
    cumulativeRevenue: 0,
    pendingDecision,
    pendingBids,
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
  };
}

function authedDb(uid) {
  return testEnv.authenticatedContext(uid).firestore();
}

function anonDb() {
  return testEnv.unauthenticatedContext().firestore();
}

async function seedBaseGame() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await setDoc(doc(db, "games", GAME_ID), {
      joinCode: "ABC123",
      phase: "lobby",
      currentRound: 1,
      totalRounds: 5,
      phaseEndTime: null,
      submittedCount: 0,
      totalPlayers: 2,
      paused: false,
      professorId: "uid_professor",
      createdAt: null,
      startedAt: null,
      endedAt: null,
    });

    await setDoc(doc(db, "games", GAME_ID, "config", "params"), {
      startingBudget: 2000,
      costPerStaffPerRound: 50,
      unitCostPerProduct: 1,
    });

    await setDoc(
      doc(db, "games", GAME_ID, "players", PLAYER_A),
      playerDocument(PLAYER_A, "The Rolling Scone")
    );

    await setDoc(
      doc(db, "games", GAME_ID, "players", PLAYER_B),
      playerDocument(PLAYER_B, "Bagel Bros")
    );

    await setDoc(doc(db, "games", GAME_ID, "players", PLAYER_A, "rounds", "round_1"), {
      round: 1,
      revenue: 650,
    });

    await setDoc(doc(db, "games", GAME_ID, "players", PLAYER_B, "rounds", "round_1"), {
      round: 1,
      revenue: 610,
    });

    await setDoc(doc(db, "games", GAME_ID, "players", PLAYER_A, "emails", "round_2_data"), {
      type: "round_data_csv",
      round: 2,
      availableAfterRound: 1,
      recipientPlayerId: PLAYER_A,
      subject: "Round 1 data is ready",
      sender: "Bakery Bash Analytics",
      body: "Use this CSV before Round 2 to update your model.",
      read: false,
      createdAt: null,
      attachments: [
        {
          filename: "bakery-bash-through-round-1.csv",
          contentType: "text/csv",
          csvText: "day,revenue\n1,650",
          rowCount: 1,
          includedThroughRound: 1,
        },
      ],
    });

    await setDoc(doc(db, "games", GAME_ID, "players", PLAYER_B, "emails", "round_2_data"), {
      type: "round_data_csv",
      round: 2,
      availableAfterRound: 1,
      recipientPlayerId: PLAYER_B,
      subject: "Round 1 data is ready",
      sender: "Bakery Bash Analytics",
      body: "Use this CSV before Round 2 to update your model.",
      read: false,
      createdAt: null,
      attachments: [],
    });

    await setDoc(doc(db, "games", GAME_ID, "csvRows", PLAYER_A, "rounds", "round_1"), {
      playerId: PLAYER_A,
      round: 1,
      row: {
        day: 1,
        revenue: 650,
      },
    });

    await setDoc(doc(db, "games", GAME_ID, "leaderboard", "current"), {
      rankings: [
        {
          rank: 1,
          playerId: PLAYER_A,
          displayName: "The Rolling Scone",
          cumulativeRevenue: 650,
          lastRoundRevenue: 650,
          rankChange: 0,
        },
      ],
      updatedAt: null,
      round: 1,
    });

    await setDoc(doc(db, "games", GAME_ID, "rounds", "round_1"), {
      round: 1,
      classStats: {
        avgRevenue: 630,
      },
    });
  });
}

describe("Bakery Bash Firestore security rules", () => {
  before(async () => {
    const rules = fs.readFileSync(
      path.resolve(__dirname, "../firestore.rules"),
      "utf8"
    );

    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules,
      },
    });
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await seedBaseGame();
  });

  after(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  it("requires authentication to read game state", async () => {
    await assertFails(getDoc(doc(anonDb(), "games", GAME_ID)));
    await assertSucceeds(getDoc(doc(authedDb(PLAYER_A), "games", GAME_ID)));
  });

  it("lets authenticated players read shared game data", async () => {
    const db = authedDb(PLAYER_A);

    await assertSucceeds(getDoc(doc(db, "games", GAME_ID, "config", "params")));
    await assertSucceeds(getDoc(doc(db, "games", GAME_ID, "leaderboard", "current")));
    await assertSucceeds(getDoc(doc(db, "games", GAME_ID, "rounds", "round_1")));
  });

  it("lets players read their own private player data only", async () => {
    const db = authedDb(PLAYER_A);

    await assertSucceeds(getDoc(doc(db, "games", GAME_ID, "players", PLAYER_A)));
    await assertFails(getDoc(doc(db, "games", GAME_ID, "players", PLAYER_B)));
    await assertSucceeds(
      getDoc(doc(db, "games", GAME_ID, "players", PLAYER_A, "rounds", "round_1"))
    );
    await assertFails(
      getDoc(doc(db, "games", GAME_ID, "players", PLAYER_B, "rounds", "round_1"))
    );
    await assertSucceeds(
      getDoc(doc(db, "games", GAME_ID, "csvRows", PLAYER_A, "rounds", "round_1"))
    );
    await assertFails(
      getDoc(doc(db, "games", GAME_ID, "csvRows", PLAYER_B, "rounds", "round_1"))
    );
    await assertSucceeds(
      getDoc(doc(db, "games", GAME_ID, "players", PLAYER_A, "emails", "round_2_data"))
    );
    await assertFails(
      getDoc(doc(db, "games", GAME_ID, "players", PLAYER_B, "emails", "round_2_data"))
    );
  });

  it("does not let clients create initial player documents", async () => {
    const db = authedDb("uid_new_player");

    await assertFails(
      setDoc(
        doc(db, "games", GAME_ID, "players", "uid_new_player"),
        playerDocument("uid_new_player", "New Bakery")
      )
    );
  });

  it("lets players update only editable fields on their own player document", async () => {
    const db = authedDb(PLAYER_A);
    const playerRef = doc(db, "games", GAME_ID, "players", PLAYER_A);

    await assertSucceeds(updateDoc(playerRef, { displayName: "Crumb Club" }));
    await assertSucceeds(updateDoc(playerRef, { pendingDecision: {
      ...pendingDecision,
      staffCount: 4,
    } }));
    await assertFails(updateDoc(playerRef, { budgetCurrent: 999999 }));
    await assertFails(updateDoc(playerRef, { creditBalance: 999999 }));
    await assertFails(updateDoc(playerRef, { cumulativeRevenue: 999999 }));
  });

  it("does not let players write shared backend-owned data", async () => {
    const db = authedDb(PLAYER_A);

    await assertFails(setDoc(doc(db, "games", GAME_ID), { phase: "game_over" }));
    await assertFails(
      updateDoc(doc(db, "games", GAME_ID, "leaderboard", "current"), { round: 2 })
    );
    await assertFails(
      updateDoc(doc(db, "games", GAME_ID, "rounds", "round_1"), {
        "classStats.avgRevenue": 999999,
      })
    );
    await assertFails(
      updateDoc(
        doc(db, "games", GAME_ID, "players", PLAYER_A, "emails", "round_2_data"),
        { read: true }
      )
    );
  });

  it("lets players create but not edit or delete their own decision snapshots", async () => {
    const db = authedDb(PLAYER_A);
    const decisionRef = doc(
      db,
      "games",
      GAME_ID,
      "players",
      PLAYER_A,
      "decisions",
      "round_1"
    );

    await assertSucceeds(
      setDoc(decisionRef, {
        round: 1,
        submittedAt: null,
        staffCount: 3,
        adSpend: 0,
      })
    );
    await assertFails(updateDoc(decisionRef, { staffCount: 99 }));
    await assertFails(deleteDoc(decisionRef));
  });
});
