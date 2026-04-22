# Reset Game Cherry-Pick (from PR #49) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cherry-pick the genuinely net-new pieces from PR #49 — `resetGame` Cloud Function, Reset Game UI button on ProfessorPage, and the `isGameProfessor(gameId)` Firestore rule helper that removes the BE-18 custom-claim dependency for live-game professor reads.

**Architecture:** Three-layer change. Backend adds a `resetGame` callable that wipes round/sim subcollections and resets each player to lobby state. Firestore rules add a per-game professor identity check so the actual game's professor (no global claim required) can read `submissions` and per-player `rounds` docs. Frontend adds a Reset Game button to ProfessorPage that calls the new callable via the existing `callCallable` helper.

**Tech Stack:** Cloud Functions for Firebase v6 (Node 22), `firebase-admin` Firestore (batched writes, BATCH_OP_LIMIT=487), Firestore Security Rules v2, React 19 + TypeScript on Vite.

**Source:** PR #49 commit `e4d4b71` on branch `bakery-bash-live-fixes`. We are NOT cherry-picking the commit directly — it's tangled with POST-01 duplicates and one regression. Each task transcribes only the relevant lines from that commit, applied on top of current main.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `games/bakery-bash/backend/functions/index.js` | Modify | Add `deleteCollectionDocs` helper + `exports.resetGame` callable |
| `games/bakery-bash/backend/firestore.rules` | Modify | Add `isGameProfessor(gameId)` helper + extend reads on `submissions/{doc}` and `players/{playerId}/rounds/{roundId}` |
| `games/bakery-bash/backend/scripts/test-reset-game-flow.js` | Create | Emulator integration test — seed a mid-game state, call `resetGame`, assert subcollections wiped + player budgets reset + game.phase=='lobby' |
| `games/bakery-bash/backend/test/firestore.rules.test.js` | Modify | Extend with cases for `isGameProfessor` access to submissions and player rounds |
| `games/bakery-bash/backend/package.json` | Modify | Add `test:reset-game` npm script |
| `games/bakery-bash/app/src/pages/ProfessorPage.tsx` | Modify | Add `onReset` handler + Reset Game button next to End Game |

No new files in the frontend. No code-mod beyond what's listed above. The `LOW_RESOURCE_CALLABLE_OPTS` and vitest pieces from PR #49 are deliberately deferred to separate PRs.

---

## Task 0: Branch and Worktree Setup

**Files:** none (git only)

- [ ] **Step 1: Verify main is clean and up-to-date**

```bash
cd /Users/dylanmassaro/FenriX
git status
git pull --ff-only origin main
```

Expected: `nothing to commit, working tree clean` and `Already up to date.`

- [ ] **Step 2: Create feature branch**

```bash
git checkout -b feat/reset-game-callable
```

Expected: `Switched to a new branch 'feat/reset-game-callable'`

---

## Task 1: Add `deleteCollectionDocs` helper to backend

**Files:**
- Modify: `games/bakery-bash/backend/functions/index.js` (insert helper after `BATCH_OP_LIMIT` declaration around line 156)

**Why first:** `resetGame` needs this. PR #49 places it adjacent to other helpers; we mirror that placement.

- [ ] **Step 1: Locate the insertion point**

Run: `grep -n "^const BATCH_OP_LIMIT" games/bakery-bash/backend/functions/index.js`
Expected: one match, around line 156: `const BATCH_OP_LIMIT = 487;`

- [ ] **Step 2: Insert the helper immediately after the BATCH_OP_LIMIT line**

Add this block after `const BATCH_OP_LIMIT = 487;`:

```js

/**
 * Batch-delete every document in a collection. Used by `resetGame` to wipe
 * round/sim subcollections without leaving orphans. Chunks at BATCH_OP_LIMIT
 * so games with many rounds × many players don't bust the 500-op batch limit.
 */
async function deleteCollectionDocs(colRef) {
  const snap = await colRef.get();
  if (snap.empty) return;
  let batch = db.batch();
  let ops = 0;
  for (const docSnap of snap.docs) {
    batch.delete(docSnap.ref);
    ops += 1;
    if (ops >= BATCH_OP_LIMIT) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) {
    await batch.commit();
  }
}
```

- [ ] **Step 3: Verify syntax**

Run: `cd games/bakery-bash/backend/functions && node --check index.js`
Expected: no output (syntax OK).

- [ ] **Step 4: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend/functions/index.js
git commit -m "feat(bakery-bash): add deleteCollectionDocs helper for batched wipes

Required by the upcoming resetGame callable. Chunks at BATCH_OP_LIMIT (487)
to handle games with many rounds × many players safely."
```

---

## Task 2: Write the failing integration test for `resetGame`

**Files:**
- Create: `games/bakery-bash/backend/scripts/test-reset-game-flow.js`
- Modify: `games/bakery-bash/backend/package.json` (add `test:reset-game` script)

**Why test first:** Existing flow scripts (`test-revenue-flow.js`, `test-submit-prices-flow.js`) follow the same pattern — drives Firestore admin SDK against the emulator with `firebase emulators:exec` to assert end-to-end behaviour.

- [ ] **Step 1: Write the test script**

Create `games/bakery-bash/backend/scripts/test-reset-game-flow.js`:

```js
#!/usr/bin/env node
/**
 * Integration test for resetGame Cloud Function.
 * Run via: npm run test:reset-game (uses firebase emulators:exec).
 */
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const {
  initializeApp: initClient,
} = require('firebase/app');
const {
  getAuth,
  signInWithCustomToken,
  connectAuthEmulator,
} = require('firebase/auth');
const {
  getFunctions,
  httpsCallable,
  connectFunctionsEmulator,
} = require('firebase/functions');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');
const assert = require('node:assert');

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

const PROJECT_ID = 'bakery-bash-54d12';
const GAME_ID = 'reset-test';
const PROFESSOR_UID = 'reset-test-professor';
const PLAYER_UID = 'reset-test-player';

async function main() {
  initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore();
  const adminAuth = getAdminAuth();

  // 1. Seed a game in mid-flight: round 3, with rounds/submissions/leaderboard
  //    docs and a player with non-default budget/cumulativeRevenue.
  const gameRef = db.collection('games').doc(GAME_ID);
  await gameRef.set({
    professorUid: PROFESSOR_UID,
    professorId: PROFESSOR_UID,
    phase: 'round_3_decide',
    currentRound: 3,
    round: 3,
    totalRounds: 5,
    paused: false,
    submittedCount: 2,
    startedAt: FieldValue.serverTimestamp(),
    endedAt: null,
  });
  await gameRef.collection('config').doc('params').set({
    startingBudget: 2000,
  });
  await gameRef.collection('rounds').doc('round_2').set({ stub: true });
  await gameRef.collection('submissions').doc('round_2_decide').set({ stub: true });
  await gameRef.collection('leaderboard').doc('round_2').set({ stub: true });
  await gameRef.collection('conclusion').doc('final').set({ stub: true });

  const playerRef = gameRef.collection('players').doc(PLAYER_UID);
  await playerRef.set({
    uid: PLAYER_UID,
    budgetCurrent: 1234,
    cumulativeRevenue: 4567,
    specialtyChefs: [{ chefId: 'french-f', skillLevel: 5 }],
    sousChefCount: 3,
    pendingDecision: { staffCount: 5 },
    pendingBids: { adBid: { amount: 100 } },
    pendingRosterAction: true,
    rosterCompleted: true,
    returningCustomersPending: 50,
    chefSatisfactionScores: { sc1: 80 },
    maintenanceBars: { cleanliness: 30, ovenHealth: 40, slicerHealth: 50, espressoHealth: 60 },
    lastRoundResult: { round: 2, revenue: 999 },
    consecutiveMissedRounds: 1,
    disconnected: false,
  });
  await playerRef.collection('decisions').doc('round_2').set({ stub: true });
  await playerRef.collection('rounds').doc('round_2').set({ stub: true });

  // 2. Call resetGame as the professor via the callable client SDK.
  initClient({
    apiKey: 'demo',
    projectId: PROJECT_ID,
    authDomain: 'demo',
    appId: 'demo',
  });
  const auth = getAuth();
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const functions = getFunctions();
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);

  const customToken = await adminAuth.createCustomToken(PROFESSOR_UID);
  await signInWithCustomToken(auth, customToken);

  const resetGame = httpsCallable(functions, 'resetGame');
  const result = await resetGame({ gameId: GAME_ID });

  // 3. Assert game state.
  const gAfter = await gameRef.get();
  assert.strictEqual(gAfter.get('phase'), 'lobby', 'phase reset');
  assert.strictEqual(gAfter.get('currentRound'), 0, 'currentRound reset');
  assert.strictEqual(gAfter.get('round'), 0, 'round reset');
  assert.strictEqual(gAfter.get('paused'), false, 'paused cleared');
  assert.strictEqual(gAfter.get('submittedCount'), 0, 'submittedCount reset');
  assert.strictEqual(gAfter.get('endedAt'), null, 'endedAt cleared');

  // 4. Assert subcollections wiped.
  const roundsSnap = await gameRef.collection('rounds').get();
  assert.strictEqual(roundsSnap.size, 0, 'rounds wiped');
  const subsSnap = await gameRef.collection('submissions').get();
  assert.strictEqual(subsSnap.size, 0, 'submissions wiped');
  const lbSnap = await gameRef.collection('leaderboard').get();
  assert.strictEqual(lbSnap.size, 0, 'leaderboard wiped');
  const conclusionSnap = await gameRef.collection('conclusion').get();
  assert.strictEqual(conclusionSnap.size, 0, 'conclusion wiped');

  // 5. Assert player reset.
  const pAfter = await playerRef.get();
  assert.strictEqual(pAfter.get('budgetCurrent'), 2000, 'budget reset to startingBudget');
  assert.strictEqual(pAfter.get('cumulativeRevenue'), 0, 'cumulativeRevenue cleared');
  assert.deepStrictEqual(pAfter.get('specialtyChefs'), [], 'specialtyChefs cleared');
  assert.strictEqual(pAfter.get('sousChefCount'), 0, 'sousChefCount cleared');
  assert.strictEqual(pAfter.get('pendingRosterAction'), false, 'pendingRosterAction cleared');
  assert.strictEqual(pAfter.get('rosterCompleted'), false, 'rosterCompleted cleared');
  assert.strictEqual(pAfter.get('disconnected'), false, 'disconnected cleared');
  assert.strictEqual(pAfter.get('consecutiveMissedRounds'), 0, 'consecutiveMissedRounds cleared');
  assert.strictEqual(pAfter.get('lastRoundResult'), undefined, 'lastRoundResult deleted');

  const pDecisions = await playerRef.collection('decisions').get();
  assert.strictEqual(pDecisions.size, 0, 'player decisions wiped');
  const pRounds = await playerRef.collection('rounds').get();
  assert.strictEqual(pRounds.size, 0, 'player rounds wiped');

  // 6. Assert response shape.
  assert.strictEqual(result.data.gameId, GAME_ID);
  assert.strictEqual(result.data.phase, 'lobby');

  console.log('PASS: resetGame wipes subcollections and resets players');
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

Open `games/bakery-bash/backend/package.json`. In the `"scripts"` block, after `"test:submit-decision"`, add:

```json
    "test:reset-game": "firebase emulators:exec --only auth,firestore,functions \"node scripts/test-reset-game-flow.js\" --project bakery-bash-54d12",
```

- [ ] **Step 3: Run the test to verify it fails**

Run from repo root:
```bash
cd games/bakery-bash/backend && npm run test:reset-game
```

Expected: FAIL with `INTERNAL` or `not-found` error from the callable — `resetGame` is not yet exported. (You may also see "functions[us-central1-resetGame]: function not found" in the emulator log.)

- [ ] **Step 4: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend/scripts/test-reset-game-flow.js games/bakery-bash/backend/package.json
git commit -m "test(bakery-bash): integration test for resetGame callable

Drives a seeded mid-game state through resetGame and asserts subcollections
are wiped + each player is restored to lobby defaults. Fails until the
callable is implemented."
```

---

## Task 3: Implement `resetGame` callable

**Files:**
- Modify: `games/bakery-bash/backend/functions/index.js` (append new export at end of file)

- [ ] **Step 1: Locate insertion point**

Run: `grep -n "^exports\." games/bakery-bash/backend/functions/index.js | tail -3`
Expected: last few exports include `setTeamRole`. Append `resetGame` after them (file end).

- [ ] **Step 2: Append the resetGame callable**

Append this block at the very end of `games/bakery-bash/backend/functions/index.js`:

```js

// ---------------------------------------------------------------------------
// resetGame — professor-only. Wipes round/sim/leaderboard/conclusion data
// and resets each player to lobby defaults so a class can replay without
// rebuilding the roster. Authorization checks both `professorUid` (canonical)
// and `professorId` (legacy alias) to match createGame's write pattern.
// ---------------------------------------------------------------------------
exports.resetGame = onCall(CALLABLE_OPTS, async (request) => {
  const auth = requireAuth(request);
  const gameId = cleanGameId((request.data || {}).gameId);
  const gameRef = gameDoc(gameId);

  const [gameSnap, cfgSnap, playersSnap] = await Promise.all([
    gameRef.get(),
    gameRef.collection('config').doc('params').get(),
    gameRef.collection('players').get(),
  ]);

  if (!gameSnap.exists) throw new HttpsError('not-found', 'Game not found.');
  if (
    gameSnap.get('professorUid') !== auth.uid &&
    gameSnap.get('professorId') !== auth.uid
  ) {
    throw new HttpsError('permission-denied', 'Only the professor can reset this game.');
  }

  const config = mergeConfig(cfgSnap.exists ? cfgSnap.data() : {});
  const startingBudget = numberOrDefault(
    config.startingBudget,
    DEFAULT_GAME_CONFIG.startingBudget,
  );

  const playerDocs = playersSnap.docs;

  // Wipe game-level + per-player subcollections in parallel. deleteCollectionDocs
  // chunks at BATCH_OP_LIMIT internally.
  await Promise.all([
    deleteCollectionDocs(gameRef.collection('rounds')),
    deleteCollectionDocs(gameRef.collection('submissions')),
    deleteCollectionDocs(gameRef.collection('marketInsights')),
    deleteCollectionDocs(gameRef.collection('leaderboard')),
    deleteCollectionDocs(gameRef.collection('conclusion')),
    ...playerDocs.map((pd) => deleteCollectionDocs(pd.ref.collection('decisions'))),
    ...playerDocs.map((pd) => deleteCollectionDocs(pd.ref.collection('rounds'))),
    ...playerDocs.map((pd) => deleteCollectionDocs(pd.ref.collection('emails'))),
    ...playerDocs.map((pd) =>
      deleteCollectionDocs(
        gameRef.collection('csvRows').doc(pd.id).collection('rounds'),
      ),
    ),
  ]);

  // Reset the game doc + each player to lobby defaults in chunked batches.
  let batch = db.batch();
  let ops = 0;
  const commitBatch = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };

  batch.update(gameRef, {
    phase: 'lobby',
    round: 0,
    currentRound: 0,
    paused: false,
    submittedCount: 0,
    phaseEndsAt: null,
    phaseStartedAt: FieldValue.serverTimestamp(),
    pausedAt: null,
    startedAt: null,
    endedAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  ops += 1;

  for (const pd of playerDocs) {
    batch.update(pd.ref, {
      budgetCurrent: startingBudget,
      cumulativeRevenue: 0,
      specialtyChefs: [],
      sousChefCount: 0,
      pendingDecision: {},
      pendingBids: {},
      pendingRosterAction: false,
      rosterCompleted: false,
      returningCustomersPending: 0,
      chefSatisfactionScores: {},
      maintenanceBars: {
        cleanliness: 100,
        ovenHealth: 100,
        slicerHealth: 100,
        espressoHealth: 100,
      },
      lastRoundResult: FieldValue.delete(),
      consecutiveMissedRounds: 0,
      disconnected: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
    ops += 1;
    if (ops >= BATCH_OP_LIMIT) await commitBatch();
  }
  await commitBatch();

  return { gameId, phase: 'lobby' };
});
```

- [ ] **Step 3: Verify syntax**

Run: `cd games/bakery-bash/backend/functions && node --check index.js`
Expected: no output.

- [ ] **Step 4: Run the integration test to verify it passes**

Run from repo root:
```bash
cd games/bakery-bash/backend && npm run test:reset-game
```

Expected: `PASS: resetGame wipes subcollections and resets players` and the script exits 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend/functions/index.js
git commit -m "feat(bakery-bash): add resetGame callable

Professor-only. Wipes round/submissions/leaderboard/conclusion + per-player
decisions/rounds/emails subcollections and resets each player doc to lobby
defaults using the configured startingBudget. Authorization checks both
professorUid and the legacy professorId alias to match createGame.

Cherry-picked from PR #49 (commit e4d4b71)."
```

---

## Task 4: Add `isGameProfessor(gameId)` Firestore rule

**Files:**
- Modify: `games/bakery-bash/backend/firestore.rules`

**Why:** Today `submissions/{doc}` and per-player `rounds/{roundId}` reads are gated on `request.auth.token.professor == true`, which requires the BE-18 set-professor-claim script to have been run. PR #49 adds an alternative path: the actual game's professor (the UID written to `game.professorUid` / `professorId` at creation) can read these without the claim.

- [ ] **Step 1: Locate the insertion point for the helper**

Run: `grep -n "function isProfessor()" games/bakery-bash/backend/firestore.rules`
Expected: one match around line 16. Insert the new helper directly after the closing `}` of `isProfessor()`.

- [ ] **Step 2: Add the `isGameProfessor` helper**

After the `isProfessor()` function (around line 19), add:

```
    function isGameProfessor(gameId) {
      return signedIn()
        && exists(/databases/$(database)/documents/games/$(gameId))
        && (
          get(/databases/$(database)/documents/games/$(gameId)).data.professorUid
            == request.auth.uid
          || get(/databases/$(database)/documents/games/$(gameId)).data.professorId
            == request.auth.uid
        );
    }
```

- [ ] **Step 3: Relax the per-player rounds read**

Find the `match /rounds/{roundId}` block inside `match /players/{playerId}` (around line 73-85 — the comment above it says "Round results are written exclusively by Cloud Functions"). Change:

```
          allow read: if isOwner(playerId);
```

to:

```
          allow read: if isOwner(playerId) || isGameProfessor(gameId);
```

- [ ] **Step 4: Relax the submissions read**

Find the `match /submissions/{doc}` block (around line 158-162 — the comment above mentions "Doc IDs follow the pattern round_{N}_{phase}"). Change:

```
        allow read: if isProfessor();
```

to:

```
        allow read: if isProfessor() || isGameProfessor(gameId);
```

- [ ] **Step 5: Verify the rules file parses**

Run from repo root:
```bash
cd games/bakery-bash/backend && firebase emulators:exec --only firestore "echo rules ok" --project bakery-bash-54d12 2>&1 | tail -10
```

Expected: emulator boots without `[firestore] Error parsing rules`. Final lines show "Script exited successfully" or similar.

- [ ] **Step 6: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend/firestore.rules
git commit -m "feat(bakery-bash): isGameProfessor rule helper

Allows the actual game's professor (game.professorUid / professorId) to
read /games/{gameId}/submissions and /players/{playerId}/rounds without
the global \`professor == true\` custom claim. Removes a BE-18 deploy
dependency for live gameplay.

Cherry-picked from PR #49 (commit e4d4b71)."
```

---

## Task 5: Add rules unit tests for `isGameProfessor`

**Files:**
- Modify: `games/bakery-bash/backend/test/firestore.rules.test.js`

- [ ] **Step 1: Locate the file structure**

Run: `grep -nE "describe\\(|it\\(" games/bakery-bash/backend/test/firestore.rules.test.js | head -20`
Expected: existing `describe`/`it` blocks. Note the patterns for setting up authenticated and unauthenticated contexts.

- [ ] **Step 2: Add the test cases**

Append a new `describe` block at the end of the file (but inside the top-level wrapper, before the final closing brace if any). Use this code, adjusting the `describe`/`it` import names to match existing patterns observed in Step 1:

```js
describe("isGameProfessor — submissions + player rounds", () => {
  const PROF_UID = "uid_game_professor";
  const OTHER_UID = "uid_other_player";

  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, `games/${GAME_ID}`), {
        professorUid: PROF_UID,
        professorId: PROF_UID,
        phase: "lobby",
      });
      await setDoc(doc(db, `games/${GAME_ID}/submissions/round_1_decide`), {
        round: 1,
        count: 2,
      });
      await setDoc(doc(db, `games/${GAME_ID}/players/${PLAYER_A}`), {
        uid: PLAYER_A,
      });
      await setDoc(
        doc(db, `games/${GAME_ID}/players/${PLAYER_A}/rounds/round_1`),
        { round: 1, revenue: 100 },
      );
    });
  });

  it("game professor can read submissions without claim", async () => {
    const profDb = testEnv.authenticatedContext(PROF_UID).firestore();
    await assertSucceeds(
      getDoc(doc(profDb, `games/${GAME_ID}/submissions/round_1_decide`)),
    );
  });

  it("non-professor player cannot read submissions", async () => {
    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      getDoc(doc(otherDb, `games/${GAME_ID}/submissions/round_1_decide`)),
    );
  });

  it("game professor can read another player's rounds", async () => {
    const profDb = testEnv.authenticatedContext(PROF_UID).firestore();
    await assertSucceeds(
      getDoc(
        doc(profDb, `games/${GAME_ID}/players/${PLAYER_A}/rounds/round_1`),
      ),
    );
  });

  it("player can still read their own rounds", async () => {
    const ownDb = testEnv.authenticatedContext(PLAYER_A).firestore();
    await assertSucceeds(
      getDoc(
        doc(ownDb, `games/${GAME_ID}/players/${PLAYER_A}/rounds/round_1`),
      ),
    );
  });

  it("unrelated player cannot read another player's rounds", async () => {
    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      getDoc(
        doc(otherDb, `games/${GAME_ID}/players/${PLAYER_A}/rounds/round_1`),
      ),
    );
  });
});
```

If the existing file does not yet import `describe`, `it`, or `beforeEach` from a test runner, add them at the top following the existing pattern (mocha provides them as globals — no import needed).

- [ ] **Step 3: Run the rules tests**

```bash
cd games/bakery-bash/backend && npm run test:rules
```

Expected: all 5 new cases pass alongside the existing suite.

- [ ] **Step 4: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/backend/test/firestore.rules.test.js
git commit -m "test(bakery-bash): rules unit tests for isGameProfessor

Covers: game professor reads submissions + other player's rounds;
non-professor reads of submissions denied; player still reads own rounds;
unrelated player's rounds denied."
```

---

## Task 6: Add Reset Game button to ProfessorPage

**Files:**
- Modify: `games/bakery-bash/app/src/pages/ProfessorPage.tsx`

**Why:** This is the only frontend change. It uses the existing `callCallable("name", "actionKey", "successMsg")` helper and `pendingAction` state — no new infrastructure needed. The `controlsDisabled` flag is already wired for the End Game button; we reuse it.

- [ ] **Step 1: Locate the `onEnd` handler and the End Game button**

Run: `grep -n "onEnd\\|End Game" games/bakery-bash/app/src/pages/ProfessorPage.tsx`
Expected: `onEnd` definition around line 334-342, and the `<button … onClick={onEnd}>End Game</button>` markup further down (around line 543 in main).

- [ ] **Step 2: Add the `onReset` handler**

Immediately after the `onEnd` function definition (around line 342), insert:

```tsx
  const onReset = () => {
    if (
      !window.confirm(
        "Reset this game back to the lobby? This clears round data and lets the same class replay.",
      )
    ) {
      return;
    }
    void callCallable(
      "resetGame",
      "reset",
      "Game reset — round data cleared and returned to lobby.",
    );
  };
```

- [ ] **Step 3: Add the Reset Game button**

Immediately after the End Game `<button>` block (the one that renders `{pendingAction === "end" ? "Ending…" : "End Game"}`), insert:

```tsx
        <button
          className="btn btn--danger"
          onClick={onReset}
          disabled={!gameId || controlsDisabled}
          title="Clear round data and send the current game back to the lobby."
        >
          {pendingAction === "reset" ? "Resetting…" : "Reset Game"}
        </button>
```

- [ ] **Step 4: Type-check + build**

```bash
cd games/bakery-bash/app && npm run build
```

Expected: exits 0 with no TypeScript errors. ProfessorPage rebuilds cleanly.

- [ ] **Step 5: Commit**

```bash
cd /Users/dylanmassaro/FenriX
git add games/bakery-bash/app/src/pages/ProfessorPage.tsx
git commit -m "feat(bakery-bash): Reset Game button on ProfessorPage

Calls the new resetGame callable with a window.confirm prompt. Reuses the
existing callCallable + pendingAction wiring (same shape as End Game).

Cherry-picked from PR #49 (commit e4d4b71)."
```

---

## Task 7: Manual verification + open PR

**Files:** none (verification + PR)

- [ ] **Step 1: Verify the full backend flow once more**

```bash
cd games/bakery-bash/backend && npm run test:reset-game && npm run test:rules
```

Expected: both pass.

- [ ] **Step 2: Push the branch**

```bash
cd /Users/dylanmassaro/FenriX
git push -u origin feat/reset-game-callable
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat(bakery-bash): resetGame callable + Reset button + isGameProfessor rule" --body "$(cat <<'EOF'
## Summary
- Cherry-picks the genuinely net-new pieces from PR #49 (codex pricing/professor flows)
- Adds \`resetGame\` Cloud Function: professor-only, wipes round/submissions/leaderboard/conclusion + per-player decisions/rounds/emails, resets each player to lobby defaults using the configured startingBudget
- Adds \`isGameProfessor(gameId)\` Firestore rule helper so the actual game's professor can read \`submissions/{doc}\` and \`players/{playerId}/rounds/{roundId}\` without needing the BE-18 \`professor == true\` custom claim
- Adds Reset Game button to ProfessorPage with confirm dialog (uses existing \`callCallable\` + \`pendingAction\` wiring)

## Why
PR #49 is mostly a duplicate of POST-01 (#43) plus one regression in \`validateProductPrices\`. Closing it wholesale would lose three real wins. This PR extracts the wins on a clean base.

The \`isGameProfessor\` rule in particular removes a deploy-time dependency on BE-18 (set-professor-claim script never shipped), which has been blocking professor reads of submission state in live games.

## Test plan
- [x] \`cd games/bakery-bash/backend && npm run test:reset-game\` — new emulator integration test seeds a mid-game state, calls resetGame as the professor, and asserts subcollections are wiped + each player is restored to lobby defaults
- [x] \`cd games/bakery-bash/backend && npm run test:rules\` — extended rules suite with 5 new cases for \`isGameProfessor\`
- [x] \`cd games/bakery-bash/app && npm run build\` — no TS errors

## Out of scope (deferred to follow-up PRs)
- LOW_RESOURCE_CALLABLE_OPTS for submitBids/pauseGame (PR-B from triage)
- vitest config + initial frontend tests (PR-C from triage)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: After PR opens, leave a follow-up comment on PR #49 pointing here**

```bash
gh pr comment 49 --body "Cherry-picked the three genuinely net-new pieces (resetGame, Reset Game button, isGameProfessor rule) into a clean PR on top of current main: <NEW_PR_URL>. Closing this PR is appropriate once the new one merges, since the remaining changes here are duplicates of POST-01 (#43) and one regression in validateProductPrices already noted in review."
```

(Replace `<NEW_PR_URL>` with the URL `gh pr create` printed in Step 3.)

---

## Done When

- `npm run test:reset-game` passes (new integration test)
- `npm run test:rules` passes (extended rules tests)
- `npm run build` succeeds in the app
- Feature branch pushed and PR open with the test plan above
- Follow-up comment posted on PR #49
