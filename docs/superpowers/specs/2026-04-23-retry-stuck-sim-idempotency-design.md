# Design: retryStuckSimulation rerun idempotency

**Date:** 2026-04-23
**Status:** Approved
**Scope:** `games/bakery-bash/backend/functions/` — `index.js`, tests

## Problem

PR #61 added `retryStuckSimulation` to recover games stuck in `phase === 'simulating'` after a Cloud Function crash/timeout. When the diagnosis returns `action: 'rerun'`, the callable re-invokes `runSimulationAndPersist`. The PR claims idempotency via deterministic `noiseSeed`, but two non-idempotent interactions break that claim:

1. **Double-counted `cumulativeRevenue`.** `runSimulationAndPersist` writes `cumulativeRevenue: FieldValue.increment(r.revenueNet)` per player (index.js:1878). `FieldValue.increment` is additive. If the first (crashed) run committed any per-player batches before failing, those players' revenue was already incremented once — the rerun increments it again.

2. **Mutated `budgetCurrent` input.** The same batch writes `budgetCurrent: r.budgetAfter` (index.js:1877). On rerun, `budgetCurrent` is read as sim input (index.js:1821) — but for players whose batch already committed, it now holds `budgetAfter` from the first run. The rerun's second-pass loan/budget math diverges from the first pass.

Deterministic `noiseSeed` only controls revenue noise; it does not save either scenario.

## Decision

Approach **(C) — gate the non-idempotent writes on prior round-doc existence, and snapshot pre-sim budget onto the round doc.**

Rejected alternatives:
- **(A)** Restrict `'rerun'` to a no-op. Safer but abandons recovery for the scenario it was built for.
- **(B)** Switch `cumulativeRevenue` to an absolute `set` by summing all round docs. Correct but penalizes every normal-path write with an extra read-per-player.

## Design

### New field on the player round doc

`players/{uid}/rounds/{round}`:
```
budgetBefore: number   // snapshot of sim-input budgetCurrent, new in this change
```

### runSimulationAndPersist — read phase

Add a parallel read of existing player round docs for the current round (the doc at `players/{uid}/rounds/round_{N}`). Call the resulting map `priorRoundByUid`.

For each team, when assembling the sim-input `player` object:
- If `priorRoundByUid.get(canonicalUid)` exists and has a numeric `budgetBefore`, use that value as the sim input `budgetCurrent`.
- Otherwise, use `canonicalData.budgetCurrent` as today.

This restores pre-sim state for any player whose first-run batch committed.

### runSimulationAndPersist — write phase

For each team member's `batch.update(playerRef, { ... })`:
- Continue to set `budgetCurrent: r.budgetAfter` absolutely (already idempotent).
- Gate `cumulativeRevenue: FieldValue.increment(r.revenueNet)` on whether this member's round doc was already present in `priorRoundByUid`. If present → omit the field; the increment already landed. If absent → apply as today.

For each `batch.set(playerRoundRef, { ... })`:
- Add `budgetBefore: player.budgetCurrent` (the value used as sim input — this is the pre-sim value by the restoration logic above).

`budgetBefore` is per-team-member and equals the canonicalData budget for that member's team. It is written deterministically regardless of whether the doc was present before, so a partial-then-complete run lands the same value.

### Aggregate (leaderboard + round completion) writes

Unchanged. They already use `set` and were part of the final batch, which is the last one to commit. Reruns overwrite with identical content.

## Tests

### `modules/__tests__/test-stress.js`

Add one new static assertion in SUITE 1 (Simulation Stress) or SUITE 5 (Race Condition Analysis):

- **RC-9**: assert that `cumulativeRevenue: FieldValue.increment` in `runSimulationAndPersist` is gated on prior-round-doc existence. Static substring check for both `FieldValue.increment(r.revenueNet)` and a nearby gate token (e.g., `alreadyPersisted` or similar) near the gated write.

- **RC-10**: assert that `budgetBefore:` appears in the per-player round doc write.

- **RC-11**: assert that the sim-input assembly reads `budgetBefore` from a prior round doc when present.

### `modules/__tests__/test-recovery.js`

No new cases required — `diagnoseSimulationState` remains a pure function with identical semantics.

## Acceptance

- `node modules/__tests__/test-stress.js` returns 99+ PASS / 0 FAIL (new assertions pass).
- `node modules/__tests__/test-recovery.js` returns 21/21.
- The patch does not change normal-path (non-rerun) outputs for any player.

## Out of scope

- Seeding the burglary RNG (pre-existing; unrelated to idempotency).
- Transactionalizing the diagnose→action path (separate concern; the transactional phase-transition guard already protects the terminal write).
- UI double-click debouncing of the "Retry Stuck Simulation" button (separate concern; backend now truly idempotent makes this lower-risk).
