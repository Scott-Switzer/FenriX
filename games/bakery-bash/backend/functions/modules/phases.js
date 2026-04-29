/**
 * phases.js — Game phase state machine.
 *
 * Pure module (no Firebase dependencies). CommonJS exports only.
 *
 * Phase sequence per round:
 *   lobby
 *     → round_N_email
 *     → round_N_decide
 *     → round_N_bid_ad
 *     → round_N_bid_chef
 *     → round_N_roster
 *     → simulating
 *     → results_ready
 *     → (round_(N+1)_email | game_over)
 *
 * "simulating" and "results_ready" are not prefixed with a round number in
 * their string form — they're always contextual to the current round.
 */

// ---------------------------------------------------------------------------
// Phase order constant
// ---------------------------------------------------------------------------

/**
 * PHASE_ORDER
 * Base phase template names in canonical order (one round's worth).
 */
const PHASE_ORDER = [
  'email',
  'decide',
  'bid_ad',
  'bid_chef',
  'roster',
  'simulating',
  'results_ready',
];

// Phases that get the "round_N_" prefix in their string form.
const ROUND_PREFIXED_PHASES = new Set(['email', 'decide', 'bid_ad', 'bid_chef', 'roster']);

// Terminal / non-round phases.
const SPECIAL_PHASES = new Set(['lobby', 'game_over', 'simulating', 'results_ready']);

// Legacy alias map → canonical phase name.
const LEGACY_PHASE_ALIASES = {
  closing_hours:     'decide',
  auction:           'bid_ad',
  open_for_business: 'simulating',
  results:           'results_ready',
};

// ---------------------------------------------------------------------------
// parsePhase / formatPhase
// ---------------------------------------------------------------------------

/**
 * Normalize a legacy phase name to the canonical name if applicable.
 * @param {string} phase
 * @returns {string}
 */
function canonicalizePhase(phase) {
  if (!phase) return phase;
  return LEGACY_PHASE_ALIASES[phase] || phase;
}

/**
 * parsePhase
 * Parse a phase string like "round_2_decide" into { round, phase }.
 *
 *   "lobby"             → { round: 0,     phase: 'lobby' }
 *   "game_over"         → { round: null,  phase: 'game_over' }
 *   "simulating"        → { round: currentRound, phase: 'simulating' }
 *   "results_ready"     → { round: currentRound, phase: 'results_ready' }
 *   "round_2_decide"    → { round: 2,     phase: 'decide' }
 *
 * @param {string} phaseString
 * @param {number} [currentRound] used for simulating/results_ready. Defaults to null.
 * @returns {{ round: number|null, phase: string }}
 */
function parsePhase(phaseString, currentRound = null) {
  if (typeof phaseString !== 'string' || phaseString.length === 0) {
    throw new Error(`parsePhase: invalid phase string: ${phaseString}`);
  }

  if (phaseString === 'lobby') {
    return { round: 0, phase: 'lobby' };
  }
  if (phaseString === 'game_over') {
    return { round: null, phase: 'game_over' };
  }
  if (phaseString === 'simulating' || phaseString === 'results_ready') {
    return { round: currentRound, phase: phaseString };
  }

  // Legacy bare aliases
  if (LEGACY_PHASE_ALIASES[phaseString]) {
    const canon = LEGACY_PHASE_ALIASES[phaseString];
    if (canon === 'simulating' || canon === 'results_ready') {
      return { round: currentRound, phase: canon };
    }
    // Bare alias with no round context — treat as current-round.
    return { round: currentRound, phase: canon };
  }

  // round_N_<phase>
  const match = /^round_(\d+)_(.+)$/.exec(phaseString);
  if (!match) {
    throw new Error(`parsePhase: unrecognized phase string: ${phaseString}`);
  }
  const round = Number(match[1]);
  const rawPhase = match[2];
  const phase = canonicalizePhase(rawPhase);

  if (!PHASE_ORDER.includes(phase)) {
    throw new Error(`parsePhase: unknown phase template: ${rawPhase}`);
  }

  return { round, phase };
}

/**
 * formatPhase
 * Inverse of parsePhase.
 *
 *   formatPhase(0, 'lobby')         → "lobby"
 *   formatPhase(null, 'game_over')  → "game_over"
 *   formatPhase(3, 'simulating')    → "simulating"
 *   formatPhase(3, 'results_ready') → "results_ready"
 *   formatPhase(2, 'decide')        → "round_2_decide"
 *
 * @param {number|null} round
 * @param {string} phase
 * @returns {string}
 */
function formatPhase(round, phase) {
  if (phase === 'lobby') return 'lobby';
  if (phase === 'game_over') return 'game_over';
  if (phase === 'simulating' || phase === 'results_ready') return phase;

  const canon = canonicalizePhase(phase);
  if (!ROUND_PREFIXED_PHASES.has(canon)) {
    throw new Error(`formatPhase: unknown phase: ${phase}`);
  }
  if (!Number.isFinite(round) || round < 1) {
    throw new Error(`formatPhase: invalid round ${round} for phase ${phase}`);
  }
  return `round_${round}_${canon}`;
}

// ---------------------------------------------------------------------------
// getNextPhase
// ---------------------------------------------------------------------------

/**
 * getNextPhase
 * Advance the phase state machine by one step.
 *
 *   lobby                 → round_1_email
 *   round_N_email         → round_N_decide
 *   round_N_decide        → round_N_bid_ad
 *   round_N_bid_ad        → round_N_bid_chef
 *   round_N_bid_chef      → round_N_roster
 *   round_N_roster        → simulating
 *   simulating            → results_ready
 *   results_ready         → round_(N+1)_email | game_over
 *
 * @param {string} currentPhaseString current phase as a string
 * @param {number} currentRound       current round (used for simulating/results_ready)
 * @param {number} totalRounds        total rounds in the game
 * @returns {{ phase: string, round: number }}
 */
function getNextPhase(currentPhaseString, currentRound, totalRounds) {
  const { round: parsedRound, phase } = parsePhase(currentPhaseString, currentRound);
  const round = parsedRound == null ? currentRound : parsedRound;

  if (phase === 'lobby') {
    return { phase: 'round_1_email', round: 1 };
  }
  if (phase === 'game_over') {
    throw new Error('getNextPhase: cannot advance past game_over');
  }

  switch (phase) {
    case 'email':
      return { phase: formatPhase(round, 'decide'), round };
    case 'decide':
      return { phase: formatPhase(round, 'bid_ad'), round };
    case 'bid_ad':
      return { phase: formatPhase(round, 'bid_chef'), round };
    case 'bid_chef':
      return { phase: formatPhase(round, 'roster'), round };
    case 'roster':
      return { phase: 'simulating', round };
    case 'simulating':
      return { phase: 'results_ready', round };
    case 'results_ready':
      if (round < totalRounds) {
        const nextRound = round + 1;
        return { phase: formatPhase(nextRound, 'email'), round: nextRound };
      }
      return { phase: 'game_over', round };
    default:
      throw new Error(`getNextPhase: invalid phase ${phase}`);
  }
}

// ---------------------------------------------------------------------------
// isValidTransition
// ---------------------------------------------------------------------------

/**
 * isValidTransition
 * Returns true if `toPhase` is a valid successor to `fromPhase`.
 *
 * @param {string} fromPhase
 * @param {string} toPhase
 * @returns {boolean}
 */
function isValidTransition(fromPhase, toPhase) {
  try {
    // We need round context for simulating/results_ready. Try to infer from
    // fromPhase if possible; otherwise use a placeholder.
    let ctxRound = 1;
    try {
      const parsed = parsePhase(fromPhase, 1);
      if (parsed.round != null && parsed.round > 0) ctxRound = parsed.round;
    } catch (_) { /* ignore */ }

    // Try enough total-rounds values to cover "last round → game_over" as well
    // as "mid-game → next round".
    const candidates = [];
    for (const totalRounds of [ctxRound, ctxRound + 1]) {
      try {
        candidates.push(getNextPhase(fromPhase, ctxRound, totalRounds).phase);
      } catch (_) { /* ignore */ }
    }

    const canonTo = canonicalizePhase(toPhase);
    return candidates.some((candidate) => candidate === toPhase || candidate === canonTo);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// getPhaseDuration
// ---------------------------------------------------------------------------

/**
 * getPhaseDuration
 * Look up the duration (seconds) for a base phase name in config.phaseDurations.
 *
 * Handles canonical names plus 'results_ready' (aliased to 'results' in config)
 * and legacy aliases.
 *
 * @param {string} phase base phase name (e.g. 'decide', not 'round_2_decide')
 * @param {object} config merged game config (must have phaseDurations)
 * @returns {number} duration in seconds (0 if not defined)
 */
function getPhaseDuration(phase, config) {
  const durations = (config && config.phaseDurations) || {};
  const canon = canonicalizePhase(phase);

  // Direct hit.
  if (durations[canon] != null) return durations[canon];

  // Legacy: config stores 'results' but phase name is 'results_ready'.
  if (canon === 'results_ready' && durations.results != null) return durations.results;

  // Fallback: try the raw phase.
  if (durations[phase] != null) return durations[phase];

  return 0;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * canSubmitDecision
 * True when the current phase is a decide phase (any round).
 *
 * @param {string} currentPhase phase string (e.g. 'round_2_decide')
 * @returns {boolean}
 */
function canSubmitDecision(currentPhase) {
  try {
    const { phase } = parsePhase(currentPhase, null);
    return phase === 'decide';
  } catch (_) {
    return false;
  }
}

/**
 * canSubmitBids
 * True when the current phase matches the bid type ('ad' or 'chef').
 *
 * @param {string} currentPhase phase string
 * @param {'ad'|'chef'|'bid_ad'|'bid_chef'} bidType
 * @returns {boolean}
 */
function canSubmitBids(currentPhase, bidType) {
  try {
    const { phase } = parsePhase(currentPhase, null);
    const expected =
      bidType === 'ad' || bidType === 'bid_ad'
        ? 'bid_ad'
        : bidType === 'chef' || bidType === 'bid_chef'
        ? 'bid_chef'
        : null;
    if (!expected) return false;
    return phase === expected;
  } catch (_) {
    return false;
  }
}

/**
 * isGameActive
 * True if the game is running (not in lobby and not game_over).
 *
 * @param {string} currentPhase
 * @returns {boolean}
 */
function isGameActive(currentPhase) {
  try {
    const { phase } = parsePhase(currentPhase, null);
    return phase !== 'lobby' && phase !== 'game_over';
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  PHASE_ORDER,
  LEGACY_PHASE_ALIASES,
  SPECIAL_PHASES,
  parsePhase,
  formatPhase,
  getNextPhase,
  isValidTransition,
  getPhaseDuration,
  canSubmitDecision,
  canSubmitBids,
  isGameActive,
  canonicalizePhase,
};
