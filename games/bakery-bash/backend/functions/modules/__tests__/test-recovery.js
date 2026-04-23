/**
 * test-recovery.js — Unit tests for simulation-limbo recovery diagnosis.
 *
 * Covers the pure decision function `diagnoseSimulationState` that powers
 * the `retryStuckSimulation` callable. Firebase I/O is not exercised here;
 * the callable is thin glue around this module.
 *
 * Run with: node modules/__tests__/test-recovery.js
 */

'use strict';

const path = require('path');
const { diagnoseSimulationState } = require(path.join(__dirname, '..', 'recovery'));

let passed = 0;
let failed = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
  }
}

function assertDiagnosis(input, expectedAction, label) {
  const out = diagnoseSimulationState(input);
  assertEq(out && out.action, expectedAction, label);
}

console.log('=== recovery.diagnoseSimulationState ===');

// ---------------------------------------------------------------------------
// 1. Phase is not 'simulating' → nothing to recover
// ---------------------------------------------------------------------------
assertDiagnosis(
  { phase: 'round_1_decide', simulationStatus: null, simulationStartedAt: null, now: 1_000_000 },
  'not-stuck',
  "phase 'round_1_decide' → not-stuck"
);
assertDiagnosis(
  { phase: 'results_ready', simulationStatus: 'complete', simulationStartedAt: 1, now: 1_000_000 },
  'not-stuck',
  "phase 'results_ready' (already advanced) → not-stuck"
);
assertDiagnosis(
  { phase: 'game_over', simulationStatus: 'complete', simulationStartedAt: 1, now: 1_000_000 },
  'not-stuck',
  "phase 'game_over' → not-stuck"
);

// ---------------------------------------------------------------------------
// 2. simulationStatus === 'complete' but phase stuck at 'simulating'
//    → sim finished but phase transition failed; just advance.
// ---------------------------------------------------------------------------
assertDiagnosis(
  { phase: 'simulating', simulationStatus: 'complete', simulationStartedAt: 1, now: 1_000_000 },
  'advance',
  "simulating + complete → advance (phase transition failed)"
);

// ---------------------------------------------------------------------------
// 3. simulationStatus === 'running' and started recently → wait
// ---------------------------------------------------------------------------
assertDiagnosis(
  { phase: 'simulating', simulationStatus: 'running', simulationStartedAt: 999_000, now: 1_000_000, stuckThresholdMs: 60_000 },
  'wait',
  "running for 1s < 60s threshold → wait"
);
assertDiagnosis(
  { phase: 'simulating', simulationStatus: 'running', simulationStartedAt: 940_001, now: 1_000_000, stuckThresholdMs: 60_000 },
  'wait',
  "running for 59.999s < 60s threshold → wait (just under)"
);

// ---------------------------------------------------------------------------
// 4. simulationStatus === 'running' and started long ago → rerun
// ---------------------------------------------------------------------------
assertDiagnosis(
  { phase: 'simulating', simulationStatus: 'running', simulationStartedAt: 940_000, now: 1_000_000, stuckThresholdMs: 60_000 },
  'rerun',
  "running for exactly 60s at threshold → rerun"
);
assertDiagnosis(
  { phase: 'simulating', simulationStatus: 'running', simulationStartedAt: 100_000, now: 1_000_000, stuckThresholdMs: 60_000 },
  'rerun',
  "running for 900s (>> 60s) → rerun"
);

// ---------------------------------------------------------------------------
// 5. simulationStatus === 'running' but no timestamp → rerun (can't trust it)
// ---------------------------------------------------------------------------
assertDiagnosis(
  { phase: 'simulating', simulationStatus: 'running', simulationStartedAt: null, now: 1_000_000 },
  'rerun',
  "running + null timestamp → rerun"
);
assertDiagnosis(
  { phase: 'simulating', simulationStatus: 'running', simulationStartedAt: undefined, now: 1_000_000 },
  'rerun',
  "running + undefined timestamp → rerun"
);
assertDiagnosis(
  { phase: 'simulating', simulationStatus: 'running', simulationStartedAt: 'not-a-number', now: 1_000_000 },
  'rerun',
  "running + non-numeric timestamp → rerun"
);

// ---------------------------------------------------------------------------
// 6. simulationStatus is null/undefined but phase is 'simulating'
//    → runSimulationAndPersist never reached; rerun.
// ---------------------------------------------------------------------------
assertDiagnosis(
  { phase: 'simulating', simulationStatus: null, simulationStartedAt: null, now: 1_000_000 },
  'rerun',
  "simulating + no status → rerun"
);
assertDiagnosis(
  { phase: 'simulating', simulationStatus: undefined, simulationStartedAt: null, now: 1_000_000 },
  'rerun',
  "simulating + undefined status → rerun"
);

// ---------------------------------------------------------------------------
// 7. Default threshold applies when stuckThresholdMs is omitted
//    Default is 60_000 ms (60 seconds).
// ---------------------------------------------------------------------------
assertDiagnosis(
  { phase: 'simulating', simulationStatus: 'running', simulationStartedAt: 999_999, now: 1_000_000 },
  'wait',
  "default threshold: 1ms old → wait"
);
assertDiagnosis(
  { phase: 'simulating', simulationStatus: 'running', simulationStartedAt: 1, now: 1_000_000 },
  'rerun',
  "default threshold: 999s old → rerun"
);

// ---------------------------------------------------------------------------
// 8. Result includes a human-readable reason string in every case
// ---------------------------------------------------------------------------
const waitResult = diagnoseSimulationState({
  phase: 'simulating', simulationStatus: 'running',
  simulationStartedAt: 999_000, now: 1_000_000,
});
assertEq(typeof waitResult.reason, 'string', 'wait result includes reason string');
assertEq(waitResult.reason.length > 0, true, 'wait reason is non-empty');

const rerunResult = diagnoseSimulationState({
  phase: 'simulating', simulationStatus: 'running',
  simulationStartedAt: 1, now: 1_000_000,
});
assertEq(typeof rerunResult.reason, 'string', 'rerun result includes reason string');
assertEq(rerunResult.reason.length > 0, true, 'rerun reason is non-empty');

// ---------------------------------------------------------------------------
// 9. Result for 'wait'/'rerun' includes ageMs so the callable can log it
// ---------------------------------------------------------------------------
assertEq(
  diagnoseSimulationState({
    phase: 'simulating', simulationStatus: 'running',
    simulationStartedAt: 940_000, now: 1_000_000, stuckThresholdMs: 60_000,
  }).ageMs,
  60_000,
  "rerun result includes ageMs"
);
assertEq(
  diagnoseSimulationState({
    phase: 'simulating', simulationStatus: 'running',
    simulationStartedAt: 999_000, now: 1_000_000, stuckThresholdMs: 60_000,
  }).ageMs,
  1_000,
  "wait result includes ageMs"
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n==========================================================');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('==========================================================');

if (failed > 0) process.exit(1);
