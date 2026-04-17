/**
 * conclusion.js — End-of-game aggregation and ranking.
 *
 * Pure module (no Firebase dependencies). CommonJS exports only.
 *
 * Per-round result objects are expected to expose:
 *   round           number
 *   revenueGross    number
 *   revenueNet      number (revenueGross - borrowed - interest)
 *   amountBorrowed  number
 *   interestCharged number
 *   totalSpent      number  (all costs: chefs, sous chefs, inventory, ads, etc.)
 */

const { DEFAULT_GAME_CONFIG } = require('./config');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// ---------------------------------------------------------------------------
// aggregatePlayerResults
// ---------------------------------------------------------------------------

/**
 * aggregatePlayerResults
 * Sum round-level metrics for a single player into totals used for the
 * conclusion screen and ranking.
 *
 *   totalRevenue    = Σ revenueGross
 *   totalInterest   = Σ interestCharged
 *   totalBorrowed   = Σ amountBorrowed
 *   netRevenue      = totalRevenue - totalInterest - totalBorrowed
 *   budgetRemaining = startingBudget + Σ revenueNet - Σ totalSpent   (may be < 0)
 *
 * @param {object[]} playerRounds per-round result objects
 * @param {object}   [config]    merged game config (defaults applied if omitted)
 * @returns {object}
 */
function aggregatePlayerResults(playerRounds, config = DEFAULT_GAME_CONFIG) {
  const rounds = Array.isArray(playerRounds) ? playerRounds : [];
  const startingBudget = num(config && config.startingBudget, DEFAULT_GAME_CONFIG.startingBudget);

  let totalRevenue = 0;
  let totalInterest = 0;
  let totalBorrowed = 0;
  let sumRevenueNet = 0;
  let sumSpent = 0;

  const roundBreakdown = [];

  for (const r of rounds) {
    const revGross = num(r && (r.revenueGross != null ? r.revenueGross : r.revenue));
    const revNet   = num(r && (r.revenueNet   != null ? r.revenueNet   : revGross - num(r.amountBorrowed) - num(r.interestCharged)));
    const borrowed = num(r && r.amountBorrowed);
    const interest = num(r && r.interestCharged);
    const spent    = num(r && r.totalSpent);

    totalRevenue  += revGross;
    totalInterest += interest;
    totalBorrowed += borrowed;
    sumRevenueNet += revNet;
    sumSpent      += spent;

    roundBreakdown.push({
      round: num(r && r.round),
      revenue: revGross,
      borrowed,
      interest,
      netThisRound: revGross - borrowed - interest,
    });
  }

  const netRevenue = totalRevenue - totalInterest - totalBorrowed;
  const budgetRemaining = startingBudget + sumRevenueNet - sumSpent;

  return {
    totalRevenue,
    totalInterest,
    totalBorrowed,
    netRevenue,
    budgetRemaining,
    roundBreakdown,
  };
}

// ---------------------------------------------------------------------------
// rankPlayers
// ---------------------------------------------------------------------------

/**
 * rankPlayers
 * Rank players by netRevenue desc, tiebreaking by budgetRemaining desc.
 * Ties on both values produce identical ranks (competition / "1224" ranking).
 *
 * @param {object[]} playerAggregates each has { playerId, displayName, bakeryName, netRevenue, budgetRemaining, ... }
 * @returns {object[]} sorted copy with a `rank` field added
 */
function rankPlayers(playerAggregates) {
  const list = Array.isArray(playerAggregates) ? playerAggregates.slice() : [];

  list.sort((a, b) => {
    const aNet = num(a.netRevenue);
    const bNet = num(b.netRevenue);
    if (bNet !== aNet) return bNet - aNet;

    const aBud = num(a.budgetRemaining);
    const bBud = num(b.budgetRemaining);
    return bBud - aBud;
  });

  let lastRank = 0;
  let lastNet = null;
  let lastBud = null;
  return list.map((p, i) => {
    const net = num(p.netRevenue);
    const bud = num(p.budgetRemaining);
    let rank;
    if (i === 0 || net !== lastNet || bud !== lastBud) {
      rank = i + 1;
      lastRank = rank;
      lastNet = net;
      lastBud = bud;
    } else {
      rank = lastRank;
    }
    return { ...p, rank };
  });
}

// ---------------------------------------------------------------------------
// buildConclusionData
// ---------------------------------------------------------------------------

/**
 * Normalize a chef object into the conclusion winner-roster shape.
 */
function normalizeChef(chef) {
  if (!chef || typeof chef !== 'object') return null;
  return {
    name:       chef.name || chef.displayName || '',
    nationality: chef.nationality || '',
    skillTier:  chef.skillTier || chef.skill || '',
    variant:    chef.variant || chef.portraitVariant || null,
  };
}

/**
 * buildConclusionData
 * Assemble the final conclusion payload.
 *
 * @param {object[]} rankedPlayers    output of rankPlayers()
 * @param {object[]} winnerChefRoster chef objects for the rank-1 player
 * @returns {object} conclusion payload
 */
function buildConclusionData(rankedPlayers, winnerChefRoster) {
  const rankings = Array.isArray(rankedPlayers) ? rankedPlayers : [];
  const top = rankings.find((p) => p.rank === 1) || rankings[0] || null;

  const chefRoster = Array.isArray(winnerChefRoster)
    ? winnerChefRoster.map(normalizeChef).filter(Boolean)
    : [];

  const winner = top
    ? {
        playerId:    top.playerId || null,
        displayName: top.displayName || '',
        bakeryName:  top.bakeryName || '',
        netRevenue:  num(top.netRevenue),
        chefRoster,
      }
    : null;

  return {
    winner,
    rankings,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  aggregatePlayerResults,
  rankPlayers,
  buildConclusionData,
  normalizeChef,
};
