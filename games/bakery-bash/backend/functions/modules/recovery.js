/**
 * recovery.js — Diagnosis helpers for simulation-phase recovery.
 *
 * Pure module (no Firebase dependencies). CommonJS exports only.
 *
 * Context: `advanceGamePhase` commits `phase='simulating'` inside a Firestore
 * transaction, then runs the simulation and the simulating→results_ready
 * transition *outside* the transaction. If the Cloud Function crashes or
 * times out between those steps the game is left stuck at `simulating` with
 * no results visible to the professor. This module tells the recovery
 * callable what to do about it.
 *
 * Inputs are plain primitives so the function is trivially unit-testable
 * without the Firebase emulator.
 */

'use strict';

// Default window after which a 'running' simulation is considered stuck and
// safe to re-run. Normal 150-player simulations finish well under 10 seconds,
// so 60 seconds is comfortably past any legitimate run.
const DEFAULT_STUCK_THRESHOLD_MS = 60_000;

/**
 * Decide how to recover a game that may be stuck in the simulating phase.
 *
 * @param {object} params
 * @param {string} params.phase — games/{id}.phase
 * @param {string|null|undefined} params.simulationStatus — rounds/{id}.simulationStatus
 * @param {number|null|undefined} params.simulationStartedAt — rounds/{id}.simulationStartedAt (ms since epoch)
 * @param {number} params.now — current time (ms since epoch)
 * @param {number} [params.stuckThresholdMs] — override the 60_000ms default
 *
 * @returns {{
 *   action: 'not-stuck' | 'advance' | 'wait' | 'rerun',
 *   reason: string,
 *   ageMs?: number,
 * }}
 *
 *   not-stuck — phase is not 'simulating'; caller should reject the retry.
 *   advance   — simulation ran but the phase transition never happened; caller
 *               should advance simulating→results_ready without re-running sim.
 *   wait      — simulation is still running within the threshold; caller
 *               should reject the retry to avoid duplicate work.
 *   rerun     — simulation did not complete within the threshold (crash or
 *               missing status); caller should re-run sim, then advance.
 */
function diagnoseSimulationState(params) {
  const {
    phase,
    simulationStatus,
    simulationStartedAt,
    now,
    stuckThresholdMs = DEFAULT_STUCK_THRESHOLD_MS,
  } = params || {};

  if (phase !== 'simulating') {
    return {
      action: 'not-stuck',
      reason: `Game phase is '${phase}', not 'simulating'; nothing to recover.`,
    };
  }

  if (simulationStatus === 'complete') {
    return {
      action: 'advance',
      reason: 'Simulation already completed; advancing to results_ready.',
    };
  }

  if (simulationStatus === 'running') {
    if (typeof simulationStartedAt !== 'number' || !Number.isFinite(simulationStartedAt)) {
      return {
        action: 'rerun',
        reason: 'Simulation marked running but no valid start timestamp; re-running.',
      };
    }
    const ageMs = now - simulationStartedAt;
    if (ageMs < stuckThresholdMs) {
      return {
        action: 'wait',
        reason: `Simulation started ${Math.max(0, Math.round(ageMs / 1000))}s ago; still within the ${Math.round(stuckThresholdMs / 1000)}s threshold.`,
        ageMs,
      };
    }
    return {
      action: 'rerun',
      reason: `Simulation has been running for ${Math.round(ageMs / 1000)}s (past the ${Math.round(stuckThresholdMs / 1000)}s threshold); re-running.`,
      ageMs,
    };
  }

  // simulationStatus is null/undefined/unexpected → runSimulationAndPersist
  // never wrote its 'running' marker, so the sim never started.
  return {
    action: 'rerun',
    reason: `Simulation status is '${simulationStatus == null ? 'missing' : String(simulationStatus)}'; re-running from scratch.`,
  };
}

module.exports = {
  DEFAULT_STUCK_THRESHOLD_MS,
  diagnoseSimulationState,
};
