/**
 * Bakery Bash — Firestore NoSQL Schema
 *
 * This file documents the complete Firestore data model for Bakery Bash.
 * It serves as the canonical reference for collection/document structure,
 * field types, and relationships. Use this alongside the security rules and
 * Cloud Functions to implement the backend.
 *
 * Top-level collections:
 *   /games
 */

/**
 * @typedef {"lobby" | "round_N_email" | "round_N_decide" | "round_N_bid_ad" | "round_N_bid_chef" | "round_N_roster" | "simulating" | "results_ready" | "game_over"} GamePhase
 */

// ─────────────────────────────────────────────────────────────
// /games/{gameId}
// Created by professor via /api/game/create
// ─────────────────────────────────────────────────────────────
const GameDocument = {
  // Unique 6-character join code shown to players
  joinCode: "ABC123",             // string

  // Current phase of the state machine
  // Transitions: lobby → round_N_email → round_N_decide → round_N_bid_ad → round_N_bid_chef
  //              → round_N_roster → simulating → results_ready → round_N+1_email → game_over
  phase: "lobby",                 // GamePhase

  // Current round number (1-indexed)
  currentRound: 1,                // number (1–5)
  totalRounds: 5,                 // number

  // Server-owned timestamps for the current phase. Clients calculate time remaining
  // from phaseEndTime and must not run local authoritative countdowns.
  phaseStartedAt: null,           // Timestamp | null
  phaseEndTime: null,             // Timestamp | null

  // Track submission progress so professor dashboard can show "X/Y submitted"
  submittedCount: 0,              // number
  totalPlayers: 0,                // number

  // Whether the game is paused (professor control)
  paused: false,                  // boolean

  professorId: "uid_prof",        // string — Firebase Auth UID of the professor

  createdAt: null,                // Timestamp
  startedAt: null,                // Timestamp | null
  endedAt: null,                  // Timestamp | null
};

// ─────────────────────────────────────────────────────────────
// /games/{gameId}/config/{configId}  (single doc: "params")
// Stores all tunable parameters so nothing is hardcoded in Cloud Functions.
// ─────────────────────────────────────────────────────────────
const GameConfigDocument = {
  // Economy
  startingBudget: 2000,           // number ($)
  costPerStaffPerRound: 50,       // number ($)
  unitCostPerProduct: 1,          // number ($) — flat cost per unit ordered

  // Credit / overdraft mechanics are pending Game Design sign-off.
  // Until creditCostRate is finalized, backend validation should keep budgets non-negative.
  credit: {
    overdraftEnabled: false,       // boolean
    creditCostRate: null,          // number | null — Open Q #6
    chargeTiming: null,            // "immediate" | "per_round" | "game_end" | null
  },

  // Dynamic staffing cost is pending Game Design sign-off.
  // Until escalationCurve is finalized, use costPerStaffPerRound as a flat fallback.
  staffingCost: {
    baseCostPerStaff: 50,          // number ($)
    escalationCurve: null,         // object | null — Open Q #7
  },

  // Revenue regression coefficients
  revenueModel: {
    base: 500,
    staffCoefficient: 30,
    priceCoefficient: -15,
    adSpendCoefficient: 0.8,
    numProductsCoefficient: 50,
    noiseMin: -100,
    noiseMax: 100,
  },

  // Ad auction bonus values ($/round added to revenue if player wins that ad slot)
  adBonuses: {
    TV: 200,
    Billboard: 150,
    Radio: 100,
    Newspaper: 75,
  },

  // Chef auction: skill level (0–100) won maps to a revenue bonus
  // bonus = chefSkill * chefBonusPerPoint
  chefBonusPerPoint: 5,           // number

  // Customer pool = customerPoolMultiplier × numPlayers
  customerPoolMultiplier: 100,

  // Attractiveness weights (used for proportional customer allocation)
  attractivenessWeights: {
    priceWeight: 100,             // (1 / avg_price) * priceWeight
    staffWeight: 5,               // staff_count * staffWeight
    adSpendWeight: 0.3,           // ad_spend * adSpendWeight
    numProductsWeight: 10,        // num_products * numProductsWeight
  },

  // Phase durations (seconds)
  phaseDurations: {
    email:      30,
    decide:     300,
    bid_ad:     60,
    bid_chef:   60,
    roster:     60,
    simulating: 30,
    results:    60,
  },
};

// ─────────────────────────────────────────────────────────────
// /games/{gameId}/players/{playerId}
// One document per player. Created on join.
// ─────────────────────────────────────────────────────────────
const PlayerDocument = {
  uid: "firebase_auth_uid",       // string — Firebase Auth UID (anonymous)
  displayName: "The Rolling Scone", // string — bakery name chosen on join

  joinedAt: null,                 // Timestamp

  // Live financial state (never shown to players mid-game — DEC design principle)
  budgetCurrent: 500000,          // number ($) — updated after each round (DEC-01)
  cumulativeRevenue: 0,           // number ($) — sum of all round revenues (for leaderboard)

  // Current round's working draft (live editable state before submit)
  // On submit, backend snapshots this into /decisions/{roundId} as the immutable historical record
  pendingDecision: {
    submitted: false,             // boolean
    submittedAt: null,            // Timestamp | null

    // Active menu items (true = on menu this round; base products always true)
    menu: {
      croissant: true,
      cookie: true,
      bagel: true,
      sandwich: false,
      coffee: false,
      matcha: false,
    },

    // Per-product quantity ordered (units); prices are fixed server-side (MIG-04)
    quantities: {
      croissant: 0,
      cookie: 0,
      bagel: 0,
      sandwich: 0,
      coffee: 0,
      matcha: 0,
    },

    // Sous chef hiring (decide phase only — DEC-02)
    sousChefCount: 0,             // number
    sousChefAssignments: {},      // { [product]: number } — sums to sousChefCount
  },

  // Specialty chef roster (max 3; written server-side after auction)
  specialtyChefs: [],             // ChefObject[] — max 3; specialty field hidden from client

  // Sous chef count hired this round (decide phase only — DEC-02)
  sousChefCount: 0,               // number

  // True when specialtyChefs.length > 3 after auction; blocks rosterContinue
  pendingRosterAction: false,     // boolean

  // Returning customer bonus earned from prior round satisfaction
  returningCustomersPending: 0,   // number

  // Ad + chef bids (separate callable submitBids — MIG-05)
  pendingBids: {
    ad: null,    // { TV, Billboard, Radio, Newspaper } | null
    chef: null,  // [{ chefId, amount }] | null
  },

  // Denormalised last-round result for fast UI reads
  lastRoundResult: null,          // RoundResultDocument snapshot | null
};

// ─────────────────────────────────────────────────────────────
// /games/{gameId}/players/{playerId}/decisions/{roundId}
// Immutable historical snapshot written by the submitDecision Cloud Function
// after server-side validation of the player's Closing Hours choices.
// roundId = "round_1", "round_2", … "round_5"
// ─────────────────────────────────────────────────────────────
const DecisionDocument = {
  round: 1,                       // number
  submittedAt: null,              // Timestamp

  // Active menu (base products always true; prices are fixed server-side — MIG-04)
  menu: {
    croissant: true,
    cookie: true,
    bagel: true,
    sandwich: false,
    coffee: false,
    matcha: false,
  },

  quantities: {
    croissant: 0,
    cookie: 0,
    bagel: 0,
    sandwich: 0,
    coffee: 0,
    matcha: 0,
  },

  // Sous chef hiring (decide phase only — DEC-02)
  sousChefCount: 0,               // number
  sousChefAssignments: {},        // { [product]: number }

  // Derived server-side
  numProducts: 3,                 // number — count of active menu items
};

// ─────────────────────────────────────────────────────────────
// /games/{gameId}/players/{playerId}/rounds/{roundId}
// Simulation output written by Cloud Function after each round.
// roundId = "round_1", "round_2", … "round_5"
// ─────────────────────────────────────────────────────────────
const RoundResultDocument = {
  round: 1,                       // number

  // Revenue (post loan-shark deduction)
  revenueGross: 0,                // number ($) — before loan-shark deduction
  revenueNet: 0,                  // number ($) — gross − (borrowed × 1.10)
  amountBorrowed: 0,              // number ($) — $0 if within budget
  interestCharged: 0,             // number ($) — amountBorrowed × 0.10
  totalSpent: 0,                  // number ($)
  budgetAfter: 0,                 // number ($)

  // Customer metrics
  customerCount: 0,               // number
  returningCustomersEarned: 0,    // number

  // Satisfaction
  aggregateSatisfactionPct: 0,    // number (0–100)
  chefSatisfactionScore: 0,       // number (0–100)

  // Per-product breakdown (keyed by product)
  // Each entry: { fillRate, satisfactionPct, qtySold, sellout: boolean }
  perProductSatisfaction: {},

  // Flat aliases for easy frontend consumption
  perProductSold: {},             // { [product]: number }
  selloutFlags: {},               // { [product]: boolean }
  perProductCustomers: {},        // { [product]: number }

  computedAt: null,               // Timestamp
};

// ─────────────────────────────────────────────────────────────
// /games/{gameId}/rounds/{roundId}
// Aggregate round document written by Cloud Function.
// roundId = "round_1" … "round_5"
// Used by professor dashboard for class-wide analytics.
// ─────────────────────────────────────────────────────────────
const AggregateRoundDocument = {
  round: 1,                       // number

  // Auction winners (sealed-bid, first-price: highest bid wins, pays their bid)
  auctionResults: {
    ads: {
      TV: { winnerId: null, winningBid: 0 },
      Billboard: { winnerId: null, winningBid: 0 },
      Radio: { winnerId: null, winningBid: 0 },
      Newspaper: { winnerId: null, winningBid: 0 },
    },
    chef: {
      winnerId: null,
      winningBid: 0,
      skillLevel: 0,
    },
  },

  // Class-wide stats for professor view
  classStats: {
    avgRevenue: 0,
    maxRevenue: 0,
    minRevenue: 0,
    avgCustomerCount: 0,
    totalCustomerPool: 0,
  },

  completedAt: null,              // Timestamp
};

// ─────────────────────────────────────────────────────────────
// /games/{gameId}/leaderboard/current
// Rewritten by Cloud Function at the end of each round.
// ─────────────────────────────────────────────────────────────
const LeaderboardDocument = {
  // Array sorted by cumulativeRevenue descending
  rankings: [
    {
      rank: 1,                    // number
      playerId: "uid_abc",        // string
      displayName: "The Rolling Scone", // string
      cumulativeRevenue: 0,       // number ($)
      lastRoundRevenue: 0,        // number ($)
      rankChange: 0,              // number — positive = moved up, negative = moved down
    },
  ],

  updatedAt: null,                // Timestamp
  round: 1,                       // number — which round this snapshot reflects
};

// ─────────────────────────────────────────────────────────────
// /games/{gameId}/csvRows/{playerId}/rounds/{roundId}
// Append-only array of row objects for CSV export.
// Matches the 17-column schema from the game design spec exactly.
// Written by Cloud Function after each simulation.
// ─────────────────────────────────────────────────────────────
const CsvRowsDocument = {
  playerId: "uid_abc",
  round: 1,                     // number — round number
  row: {
    day: 1,                     // number — round number
    revenue: 0,                 // number ($)
    num_products: 3,            // number
    avg_price: 5.0,             // number ($)
    staff_count: 3,             // number
    ad_spend: 0,                // number ($)
    customer_count: 0,          // number
    customer_satisfaction: 0,   // number (0–100)
    headchef_skill: 0,          // number (0–100)
    croissant: 0,               // number — units sold
    cookie: 0,
    bagel: 0,
    sandwich: 0,
    coffee: 0,
    matcha: 0,
    ad_type: "none",           // string — ad type won this round, or "none"
  },
};

// ─────────────────────────────────────────────────────────────
// /games/{gameId}/players/{playerId}/emails/{emailId}
// Backend-owned email phase messages. Used to drop the current CSV dataset
// before the next decision round so players can update their models.
// emailId = "round_2_data", "round_3_data", …
// ─────────────────────────────────────────────────────────────
const PlayerEmailDocument = {
  type: "round_data_csv",        // string
  round: 2,                      // number — next decision round this data supports
  availableAfterRound: 1,        // number — last completed round included in CSV
  recipientPlayerId: "uid_abc",  // string
  subject: "Round 1 data is ready",
  sender: "Bakery Bash Analytics",
  body: "Use this CSV before Round 2 to update your model and plan decisions.",
  read: false,                   // boolean — frontend may track read state locally
  createdAt: null,               // Timestamp
  attachments: [
    {
      filename: "bakery-bash-through-round-1.csv",
      contentType: "text/csv",
      csvText: "day,revenue,num_products,...", // string — full CSV payload
      rowCount: 1,               // number
      includedThroughRound: 1,   // number
    },
  ],
};

// ─────────────────────────────────────────────────────────────
// COLLECTION HIERARCHY SUMMARY
// ─────────────────────────────────────────────────────────────
//
// /games/{gameId}                          ← GameDocument
// /games/{gameId}/config/params            ← GameConfigDocument
// /games/{gameId}/players/{playerId}       ← PlayerDocument
// /games/{gameId}/players/{playerId}/decisions/{roundId}  ← DecisionDocument
// /games/{gameId}/players/{playerId}/rounds/{roundId}     ← RoundResultDocument
// /games/{gameId}/players/{playerId}/emails/{emailId}     ← PlayerEmailDocument
// /games/{gameId}/rounds/{roundId}         ← AggregateRoundDocument
// /games/{gameId}/leaderboard/current      ← LeaderboardDocument
// /games/{gameId}/csvRows/{playerId}/rounds/{roundId}  ← CsvRowsDocument
//
// ─────────────────────────────────────────────────────────────
// FIRESTORE SECURITY RULES (reference)
// ─────────────────────────────────────────────────────────────
//
// rules_version = '2';
// service cloud.firestore {
//   match /databases/{database}/documents {
//
//     // Players can read game state but not write it directly
//     match /games/{gameId} {
//       allow read: if request.auth != null;
//       allow write: if false; // Cloud Functions only
//     }
//
//     // Config is read-only for all authenticated users
//     match /games/{gameId}/config/{doc} {
//       allow read: if request.auth != null;
//       allow write: if false;
//     }
//
//     // Players can read their own player document, but backend owns financial/result fields
//     match /games/{gameId}/players/{playerId} {
//       allow read: if request.auth.uid == playerId;
//       allow write: if request.auth.uid == playerId
//         && request.resource.data.diff(resource.data).changedKeys().hasOnly(["displayName", "pendingDecision", "pendingBids"]);
//
//       match /decisions/{roundId} {
//         allow read: if request.auth.uid == playerId;
//         allow write: if false; // Cloud Functions only
//       }
//
//       match /rounds/{roundId} {
//         allow read: if request.auth.uid == playerId;
//         allow write: if false; // Cloud Functions only
//       }
//
//       match /emails/{emailId} {
//         allow read: if request.auth.uid == playerId;
//         allow write: if false; // Cloud Functions only
//       }
//     }
//
//     // Leaderboard and aggregate rounds are readable by all players
//     match /games/{gameId}/leaderboard/{leaderboardId} {
//       allow read: if request.auth != null;
//       allow write: if false;
//     }
//
//     match /games/{gameId}/rounds/{roundId} {
//       allow read: if request.auth != null;
//       allow write: if false;
//     }
//
//     // CSV rows readable only by the owning player (one doc per round)
//     match /games/{gameId}/csvRows/{playerId}/rounds/{roundId} {
//       allow read: if request.auth.uid == playerId;
//       allow write: if false;
//     }
//   }
// }
//
// ─────────────────────────────────────────────────────────────

module.exports = {
  GameDocument,
  GameConfigDocument,
  PlayerDocument,
  DecisionDocument,
  RoundResultDocument,
  AggregateRoundDocument,
  LeaderboardDocument,
  CsvRowsDocument,
  PlayerEmailDocument,
};
