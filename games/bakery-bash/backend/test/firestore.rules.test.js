const fs = require("node:fs");
const path = require("node:path");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} = require("firebase/firestore");

const PROJECT_ID = "bakery-bash-rules-test";
const GAME_ID = "game_abc123";
const PLAYER_A = "uid_player_a";
const PLAYER_B = "uid_player_b";

let testEnv;

// Mirror production canonical shapes from `resetPendingPlayerStateForRound` /
// `joinGame` (backend/functions/index.js) and `PendingDecisionDraft` /
// `StaffCounts` (app/src/types/game.ts). These fixtures are seeded through
// `withSecurityRulesDisabled` so the rules don't actually enforce inner
// shape — but keeping them in sync with production avoids confusing the
// next person who reads this file looking for the canonical schema.
const pendingDecision = {
  submitted: false,
  submittedAt: null,
  round: null,
  menu: {
    coffee: false,
    croissant: true,
    bagel: true,
    cookie: true,
    sandwich: false,
    matcha: false,
  },
  quantities: {
    coffee: 0,
    croissant: 0,
    bagel: 0,
    cookie: 0,
    sandwich: 0,
    matcha: 0,
  },
  sousChefCount: 0,
  sousChefAssignments: {},
  staffCounts: {
    bakerySousChefs: 0,
    deliSousChefs: 0,
    baristaSousChefs: 0,
    maintenanceGuys: 0,
  },
  maintenanceTasks: [],
  productPrices: {
    coffee: 0,
    croissant: 0,
    bagel: 0,
    cookie: 0,
    sandwich: 0,
    matcha: 0,
  },
  pricesSubmitted: false,
};

const pendingBids = {
  ad: null,
  chef: null,
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
    lastRoundResult: null,
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

    await setDoc(doc(db, "games", GAME_ID, "leaderboard", "latest"), {
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

    await setDoc(doc(db, "games", GAME_ID, "roster", PLAYER_A), {
      uid: PLAYER_A,
      displayName: "The Rolling Scone",
      bakeryName: "Rolling Scone Bakery",
      joinedAt: null,
    });
    await setDoc(doc(db, "games", GAME_ID, "roster", PLAYER_B), {
      uid: PLAYER_B,
      displayName: "Bagel Bros",
      bakeryName: "Bagel Bros Bakery",
      joinedAt: null,
    });
  });
}

describe("Bakery Bash Firestore security rules", function () {
  before(async function () {
    // `firebase emulators:exec` (used by `npm run test:rules`) sets
    // FIRESTORE_EMULATOR_HOST so @firebase/rules-unit-testing can
    // auto-discover the emulator. Plain `npm test` runs without an
    // emulator — skip the suite there rather than fail.
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      this.skip();
      return;
    }
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
    await assertSucceeds(getDoc(doc(db, "games", GAME_ID, "leaderboard", "latest")));
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
      staffCounts: {
        ...pendingDecision.staffCounts,
        bakerySousChefs: 1,
      },
    } }));
    await assertFails(updateDoc(playerRef, { budgetCurrent: 999999 }));
    await assertFails(updateDoc(playerRef, { creditBalance: 999999 }));
    await assertFails(updateDoc(playerRef, { cumulativeRevenue: 999999 }));
  });

  it("does not let players write shared backend-owned data", async () => {
    const db = authedDb(PLAYER_A);

    await assertFails(setDoc(doc(db, "games", GAME_ID), { phase: "game_over" }));
    await assertFails(
      updateDoc(doc(db, "games", GAME_ID, "leaderboard", "latest"), { round: 2 })
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

  it("lets any signed-in player get and list the public roster", async () => {
    const db = authedDb(PLAYER_A);

    await assertSucceeds(getDoc(doc(db, "games", GAME_ID, "roster", PLAYER_A)));
    await assertSucceeds(getDoc(doc(db, "games", GAME_ID, "roster", PLAYER_B)));
    await assertSucceeds(getDocs(collection(db, "games", GAME_ID, "roster")));

    await assertFails(getDoc(doc(anonDb(), "games", GAME_ID, "roster", PLAYER_A)));
    await assertFails(getDocs(collection(anonDb(), "games", GAME_ID, "roster")));
  });

  it("does not let clients write roster documents", async () => {
    const db = authedDb(PLAYER_A);
    const rosterRef = doc(db, "games", GAME_ID, "roster", PLAYER_A);

    await assertFails(
      setDoc(rosterRef, {
        uid: PLAYER_A,
        displayName: "Bypass",
        bakeryName: "Bypass",
        joinedAt: null,
      })
    );
    await assertFails(updateDoc(rosterRef, { displayName: "Bypass" }));
    await assertFails(deleteDoc(rosterRef));
  });

  it("does not let players write decision snapshots directly", async () => {
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

    await assertFails(
      setDoc(decisionRef, {
        round: 1,
        submittedAt: null,
        staffCounts: {
          bakerySousChefs: 1,
          deliSousChefs: 0,
          baristaSousChefs: 0,
          maintenanceGuys: 0,
        },
      })
    );
    await assertFails(
      updateDoc(decisionRef, {
        "staffCounts.bakerySousChefs": 99,
      })
    );
    await assertFails(deleteDoc(decisionRef));

    // POST-01: productPrices written by submitPrices (Admin SDK) — client
    // writes to the decisions doc must still be rejected even with this field.
    await assertFails(
      setDoc(decisionRef, { round: 1, productPrices: { coffee: 4.00 } }, { merge: true })
    );
  });

  // ─────────────────────────────────────────────────────────
  // isGameProfessor — game-scoped professor reads (no global custom claim).
  // The base seed already sets games/{GAME_ID}.professorId = "uid_professor".
  // ─────────────────────────────────────────────────────────
  describe("isGameProfessor — submissions + player rounds", () => {
    const PROF_UID = "uid_professor";
    const OTHER_UID = "uid_unrelated";

    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, "games", GAME_ID, "submissions", "round_1_decide"), {
          round: 1,
          phase: "decide",
          submittedCount: 2,
        });
        await setDoc(
          doc(db, "games", GAME_ID, "submissionCounts", "round_1_decide"),
          { count: 2 }
        );
      });
    });

    it("game professor can read submissions without the global claim", async () => {
      await assertSucceeds(
        getDoc(doc(authedDb(PROF_UID), "games", GAME_ID, "submissions", "round_1_decide"))
      );
    });

    it("non-professor signed-in user cannot read submissions", async () => {
      await assertFails(
        getDoc(doc(authedDb(OTHER_UID), "games", GAME_ID, "submissions", "round_1_decide"))
      );
    });

    it("any signed-in user can read submissionCounts", async () => {
      await assertSucceeds(
        getDoc(
          doc(authedDb(OTHER_UID), "games", GAME_ID, "submissionCounts", "round_1_decide")
        )
      );
    });

    it("clients cannot write submissionCounts", async () => {
      await assertFails(
        setDoc(
          doc(authedDb(PLAYER_A), "games", GAME_ID, "submissionCounts", "round_1_decide"),
          { count: 99 }
        )
      );
    });

    it("game professor can read another player's per-player rounds", async () => {
      await assertSucceeds(
        getDoc(doc(authedDb(PROF_UID), "games", GAME_ID, "players", PLAYER_A, "rounds", "round_1"))
      );
    });

    it("player can still read their own rounds", async () => {
      await assertSucceeds(
        getDoc(doc(authedDb(PLAYER_A), "games", GAME_ID, "players", PLAYER_A, "rounds", "round_1"))
      );
    });

    it("unrelated player cannot read another player's rounds", async () => {
      await assertFails(
        getDoc(doc(authedDb(OTHER_UID), "games", GAME_ID, "players", PLAYER_A, "rounds", "round_1"))
      );
    });
  });
});
