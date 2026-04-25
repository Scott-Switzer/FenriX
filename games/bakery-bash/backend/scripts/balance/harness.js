/**
 * harness.js — Standalone simulation harness for balance testing.
 *
 * Wraps the pure backend modules (no Firebase) so we can run thousands of
 * full 5-round games quickly with arbitrary team strategies competing.
 *
 * Each "strategy" is a function (state) => decisions+bids that plays one team.
 * The harness threads game state across 5 rounds: budget, returning customers,
 * specialty chef roster (subject to the 3-chef cap), auction outcomes.
 */

'use strict';

const path = require('path');

const config = require(path.join('..', '..', 'functions', 'modules', 'config'));
const chefSystem = require(path.join('..', '..', 'functions', 'modules', 'chef-system'));
const sim = require(path.join('..', '..', 'functions', 'modules', 'simulation'));

const {
  PRODUCT_KEYS,
  CHEF_NATIONALITIES,
  DEFAULT_GAME_CONFIG,
  mergeConfig,
} = config;

const {
  generateChefPool,
  resolveChefAuction,
  getTotalSousChefHireCost,
} = chefSystem;

const { runSimulation } = sim;

// ---------------------------------------------------------------------------
// Round preference profiles (mirrors what the live game shows in email phase)
// ---------------------------------------------------------------------------

/**
 * Round preference profiles — each round has a "theme" that boosts some
 * products and cools others. We shuffle these per game so a strategy that
 * happens to align with R2/R3 doesn't get a structural advantage in our
 * statistics.
 */
const PREFERENCE_TEMPLATES = [
  { name: 'neutral',  modifiers: { coffee: 1.0,  croissant: 1.0,  bagel: 1.0,  cookie: 1.0,  sandwich: 1.0,  matcha: 1.0  } },
  { name: 'coffee',   modifiers: { coffee: 1.4,  croissant: 1.15, bagel: 0.85, cookie: 1.0,  sandwich: 0.85, matcha: 1.15 } },
  { name: 'premium',  modifiers: { coffee: 1.0,  croissant: 1.4,  bagel: 0.9,  cookie: 1.0,  sandwich: 1.0,  matcha: 1.4  } },
  { name: 'american', modifiers: { coffee: 1.15, croissant: 0.9,  bagel: 1.4,  cookie: 1.4,  sandwich: 1.0,  matcha: 0.85 } },
  { name: 'sandwich', modifiers: { coffee: 0.9,  croissant: 1.15, bagel: 0.9,  cookie: 1.0,  sandwich: 1.4,  matcha: 1.15 } },
];

/** Shuffle a copy of an array (Fisher-Yates). */
function shuffle(arr, seed) {
  const a = arr.slice();
  // Cheap deterministic-ish RNG so a given seed produces same shuffle.
  let s = (typeof seed === 'number' && Number.isFinite(seed)) ? seed : Math.floor(Math.random() * 1e9);
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Backward-compat: some tests/probes use ROUND_PREFERENCES directly. */
const ROUND_PREFERENCES = PREFERENCE_TEMPLATES.map((t, i) => ({ round: i + 1, ...t }));

/**
 * Generate a per-game shuffled list of round preferences. Cycles through
 * the templates if the game has more rounds than templates available.
 * Same seed → same order, so reps within a tournament cell are reproducible.
 */
function makeRoundPreferences(seed, totalRounds = 5) {
  const order = shuffle(PREFERENCE_TEMPLATES, seed);
  const out = [];
  for (let r = 0; r < totalRounds; r++) {
    out.push({ round: r + 1, ...order[r % order.length] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auction support — sealed-bid first-price for ads
// ---------------------------------------------------------------------------

/**
 * Resolve sealed-bid ad auction across teams.
 *   adBids[teamId] = { TV?, Billboard?, Radio?, Newspaper? } in dollars.
 *
 * Highest bid per ad type wins. Ties broken RANDOMLY (was team-index, but
 * that gave team 0 a systematic advantage in mirror matches — see
 * exploit-hunt Probe 12). Bids below the per-ad-type minimum (from
 * `cfg.adBidMinimums`) are dropped: the bidder pays nothing but cannot win.
 */
function resolveAdAuction(adBids, cfg = null) {
  const winners = {};
  const paid = {};
  const mins = (cfg && cfg.adBidMinimums) || { TV: 0, Billboard: 0, Radio: 0, Newspaper: 0 };
  for (const adType of ['TV', 'Billboard', 'Radio', 'Newspaper']) {
    const minBid = Number(mins[adType]) || 0;
    // Collect all qualifying bids
    const qualifying = [];
    for (const [teamId, bids] of Object.entries(adBids)) {
      const amt = Number(bids && bids[adType]) || 0;
      if (amt > 0 && amt >= minBid) qualifying.push({ teamId, amt });
    }
    if (qualifying.length === 0) continue;
    // Find max bid
    const maxAmt = Math.max(...qualifying.map(q => q.amt));
    const tied = qualifying.filter(q => q.amt === maxAmt);
    // Random tie-break
    const winner = tied[Math.floor(Math.random() * tied.length)];
    if (!winners[winner.teamId]) winners[winner.teamId] = [];
    winners[winner.teamId].push(adType);
    paid[winner.teamId] = (paid[winner.teamId] || 0) + winner.amt;
  }
  return { winners, paid };
}

// ---------------------------------------------------------------------------
// Game runner
// ---------------------------------------------------------------------------

/**
 * Run one 5-round game with the given team strategies.
 *
 * @param {Array<{ id: string, name: string, strategy: function }>} teams
 * @param {object} cfgOverride  partial config to merge over defaults
 * @param {number} seed         deterministic RNG seed for chef pool / auction noise (Math.random remains used)
 * @returns {object} { teams: [{id, name, totalProfit, profitByRound, finalBudget, ...}] }
 */
function runOneGame(teams, cfgOverride = {}, seed = null) {
  const cfg = mergeConfig({ ...DEFAULT_GAME_CONFIG, ...cfgOverride });

  // Per-team state across rounds
  const state = {};
  for (const t of teams) {
    state[t.id] = {
      teamId: t.id,
      teamName: t.name,
      budget: cfg.startingBudget,
      specialtyChefs: [], // accumulates each round, capped at 3
      returningCustomers: 0,
      priorPrices: [],    // chronological list of {product: price} maps
      profitByRound: [],
      revenueByRound: [],
      customersByRound: [],
      satisfactionByRound: [],
      cumulativeProfit: 0,
      decisions: [],
      adWinsByRound: [],
      chefRosterByRound: [],
      sousChefByRound: [],
    };
  }

  // Shuffle round preferences per game (seeded for reproducibility).
  const roundPrefsList = makeRoundPreferences(seed, cfg.totalRounds);

  for (let round = 1; round <= cfg.totalRounds; round++) {
    const roundPrefs = roundPrefsList[round - 1];
    // ---- Generate chef pool for the round ----
    const chefPool = generateChefPool(round, cfg);

    // ---- Each team picks ad bids and chef bids ----
    const adBidsByTeam = {};
    const chefBidsByTeam = {};
    for (const t of teams) {
      const s = state[t.id];
      const ctx = {
        round,
        budget: s.budget,
        specialtyChefs: s.specialtyChefs,
        returningCustomers: s.returningCustomers,
        roundPrefs,
        chefPool,
        cfg,
        priorPrices: s.priorPrices,
      };
      const playFn = t.strategy.play || t.strategy;
      const move = playFn(ctx) || {};
      adBidsByTeam[t.id] = move.adBids || {};
      chefBidsByTeam[t.id] = move.chefBids || []; // [{chefId, amount}]
      state[t.id].pendingMove = move;
    }

    // ---- Resolve ad auction ----
    const adResult = resolveAdAuction(adBidsByTeam, cfg);

    // ---- Resolve chef auction (sealed first-price) ----
    const chefBidsFlat = [];
    for (const [teamId, bids] of Object.entries(chefBidsByTeam)) {
      bids.forEach((b, idx) => {
        if (!b || !Number.isFinite(b.amount) || b.amount <= 0) return;
        chefBidsFlat.push({
          playerId: teamId, // we treat team as the "player" for purposes of bidding
          chefId: b.chefId,
          amount: b.amount,
          submittedAt: idx, // earlier index = earlier
        });
      });
    }
    const chefResult = resolveChefAuction(chefPool, chefBidsFlat);

    // ---- Apply chef wins (with 3-chef cap) ----
    const chefRosterDeltaByTeam = {};
    for (const [teamId, won] of chefResult.winners.entries()) {
      const s = state[teamId];
      const room = Math.max(0, cfg.specialtyChefCap - s.specialtyChefs.length);
      const accept = won.slice(0, room);
      // Note: in the live game, exceeding the cap is blocked at submit; if it
      // gets through (race condition), the teams keep their existing roster. We
      // simulate a deterministic rule: accept up to the cap in win order.
      s.specialtyChefs.push(...accept);
      chefRosterDeltaByTeam[teamId] = accept;
    }

    // ---- Build the per-player simulation input ----
    const players = teams.map((t) => {
      const s = state[t.id];
      const move = s.pendingMove || {};
      const adWins = adResult.winners[t.id] || [];
      const adBidPaid = adResult.paid[t.id] || 0;
      const chefBidPaid = chefResult.payments.get(t.id) || 0;
      const chefsWon = chefRosterDeltaByTeam[t.id] || [];
      return {
        playerId: t.id,
        displayName: t.name,
        bakeryName: t.name,
        budgetCurrent: s.budget,
        decision: {
          quantities: move.quantities || {},
          menu: move.menu || {},
          sousChefCount: move.sousChefCount || 0,
          sousChefAssignments: move.sousChefAssignments || {},
          productPrices: move.productPrices || {},
        },
        priorSubmittedPrices: s.priorPrices,
        specialtyChefs: s.specialtyChefs,
        sousChefCount: move.sousChefCount || 0,
        returningCustomersPending: s.returningCustomers,
        cleanliness_pct: 100, // ignore burglary curveball for balance probes
        auctionResults: {
          adWins,
          adBidPaid,
          chefBidPaid,
          chefsWon,
        },
      };
    });

    // ---- Run simulation ----
    const results = runSimulation(players, roundPrefs, cfg, {
      gameId: `bal-seed${seed || 0}`,
      round,
    });

    // ---- Apply results back to state ----
    for (const r of results) {
      const s = state[r.playerId];
      s.budget = r.budgetAfter;
      s.returningCustomers = r.returningCustomersEarned;
      s.priorPrices.push(r.productPrices || {});
      s.profitByRound.push(r.revenueNet - r.totalSpent + (r.amountBorrowed || 0));
      // Note: profit per round is reflected in the budgetAfter delta:
      //   budgetAfter = budgetBefore + revenueNet - totalSpent
      // So profit_this_round = revenueNet - totalSpent.
      // But we want the change in budget which already accounts for borrow.
      // Track both for transparency.
      s.revenueByRound.push(r.revenueNet);
      s.customersByRound.push(r.customerCount);
      s.satisfactionByRound.push(r.aggregateSatisfactionPct);
      s.adWinsByRound.push(r.adWins || []);
      s.sousChefByRound.push(players.find((p) => p.playerId === r.playerId).decision.sousChefCount || 0);
      s.chefRosterByRound.push(s.specialtyChefs.map((c) => ({
        nat: c.nationality,
        skill: c.skillTier,
        specs: c.specialties,
      })));
    }
  }

  // ---- Summarize ----
  const summary = teams.map((t) => {
    const s = state[t.id];
    const totalProfit = s.budget - cfg.startingBudget;
    const totalCustomers = s.customersByRound.reduce((a, b) => a + b, 0);
    const avgSatisfaction =
      s.satisfactionByRound.reduce((a, b) => a + b, 0) / s.satisfactionByRound.length;
    return {
      teamId: t.id,
      teamName: t.name,
      strategyName: t.strategy.name || t.strategy.label || t.id,
      finalBudget: s.budget,
      totalProfit,
      totalCustomers,
      avgSatisfaction,
      profitByRound: s.profitByRound,
      revenueByRound: s.revenueByRound,
      customersByRound: s.customersByRound,
      satisfactionByRound: s.satisfactionByRound,
      adWinsByRound: s.adWinsByRound,
      sousChefByRound: s.sousChefByRound,
      chefRosterFinal: s.specialtyChefs.map((c) => ({
        nat: c.nationality,
        skill: c.skillTier,
        specs: c.specialties,
      })),
    };
  });

  // Rank by total profit
  summary.sort((a, b) => b.totalProfit - a.totalProfit);
  summary.forEach((row, i) => { row.rank = i + 1; });

  return { teams: summary };
}

/**
 * Run N games with the same strategies and aggregate results.
 *
 * @returns {Array<{strategyName, avgProfit, winRate, avgRank, ...}>} per strategy
 */
function runManyGames(teams, cfgOverride = {}, n = 200) {
  const aggregator = {};
  for (const t of teams) {
    const sn = t.strategy.name || t.strategy.label || t.id;
    if (!aggregator[sn]) {
      aggregator[sn] = {
        strategyName: sn,
        n: 0,
        wins: 0,
        ranks: [],
        profits: [],
        budgets: [],
        customers: [],
        satisfactions: [],
      };
    }
  }

  for (let i = 0; i < n; i++) {
    const result = runOneGame(teams, cfgOverride, i);
    for (const row of result.teams) {
      const sn = row.strategyName;
      const a = aggregator[sn];
      a.n += 1;
      a.profits.push(row.totalProfit);
      a.budgets.push(row.finalBudget);
      a.customers.push(row.totalCustomers);
      a.satisfactions.push(row.avgSatisfaction);
      a.ranks.push(row.rank);
      if (row.rank === 1) a.wins += 1;
    }
  }

  const out = Object.values(aggregator).map((a) => {
    const avg = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
    const stdev = (xs) => {
      if (xs.length < 2) return 0;
      const m = avg(xs);
      const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
      return Math.sqrt(v);
    };
    return {
      strategyName: a.strategyName,
      n: a.n,
      winRate: a.wins / a.n,
      avgRank: avg(a.ranks),
      avgProfit: Math.round(avg(a.profits)),
      profitStdev: Math.round(stdev(a.profits)),
      avgFinalBudget: Math.round(avg(a.budgets)),
      avgCustomers: Math.round(avg(a.customers)),
      avgSatisfaction: Number(avg(a.satisfactions).toFixed(1)),
      sample: a.profits.slice(0, 3),
    };
  });
  out.sort((a, b) => b.avgProfit - a.avgProfit);
  return out;
}

module.exports = {
  runOneGame,
  runManyGames,
  ROUND_PREFERENCES,
  resolveAdAuction,
  makeRoundPreferences,
  PREFERENCE_TEMPLATES,
};
