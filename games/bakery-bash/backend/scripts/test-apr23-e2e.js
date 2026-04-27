#!/usr/bin/env node
/**
 * test-apr23-e2e.js
 *
 * End-to-end emulator test for the Apr 23 P0 team-role fixes shipped
 * in PR #77. Drives the full user flow (createTeam → joinGame → role
 * picker → setTeamRole(null) → submit callables) and verifies every
 * acceptance criterion in playtesting-apr23-issues.md for:
 *
 *   • BE-I04 — 2-player teams default to `solo`; 2→3 join flips the
 *     whole team to finance/advertising/operations.
 *   • BE-I13 — `setTeamRole({ role: null })` clears the caller's role
 *     and drops the player doc back to `solo`. Round-trip: another
 *     teammate can now claim the cleared role.
 *   • FE-I15 — `submitDecision`/etc. accept any teammate when nobody
 *     on the team holds the required specialist role.
 *
 * Uses a fresh gameId on every run so the test is idempotent.
 *
 * Run via: FIRESTORE_EMULATOR_HOST=… FIREBASE_AUTH_EMULATOR_HOST=…
 *          node scripts/test-apr23-e2e.js
 */

const { initializeApp: initAdmin } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth: getAdminAuth } = require("firebase-admin/auth");
const { initializeApp: initClient } = require("firebase/app");
const {
  connectAuthEmulator,
  getAuth,
  signInWithCustomToken,
} = require("firebase/auth");
const {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
} = require("firebase/functions");

const PROJECT_ID = "bakery-bash-54d12";
const GAME_ID = `apr23-e2e-${Date.now()}`;
// Join codes are uppercase alphanumerics (excluding I/O/1/0). Derive
// a unique one from the timestamp so repeated runs don't collide on
// a long-running emulator instance.
const JOIN_CODE = (() => {
  const ALLOWED = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let n = Date.now();
  let out = "";
  while (out.length < 6) {
    out += ALLOWED[n % ALLOWED.length];
    n = Math.floor(n / ALLOWED.length);
  }
  return out;
})();
const PROFESSOR_UID = `${GAME_ID}-prof`;

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} must be set (point at a running Firebase emulator).`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function expectError(fn, expectedCode, label) {
  try {
    await fn();
    throw new Error(`FAIL: ${label} — expected "${expectedCode}" but call succeeded.`);
  } catch (err) {
    const code = err.code || (err.details && err.details.code) || "";
    if (!code.includes(expectedCode)) {
      throw new Error(`FAIL: ${label} — expected "${expectedCode}", got "${code}": ${err.message}`);
    }
    console.log(`  ✓ ${label} rejected (${code})`);
  }
}

async function seedGame(db) {
  await db.doc(`games/${GAME_ID}`).set({
    joinCode: JOIN_CODE,
    professorUid: PROFESSOR_UID,
    professorId: PROFESSOR_UID,
    phase: "lobby",
    round: 0,
    currentRound: 0,
    totalRounds: 5,
    totalPlayers: 0,
    submittedCount: 0,
    paused: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  await db.doc(`games/${GAME_ID}/config/params`).set({
    playerCap: 20,
    unitCostPerProduct: 1,
    specialtyChefCap: 3,
    // Force-zero noise so the simulation is deterministic across reruns;
    // other coefficients fall back to DEFAULT_GAME_CONFIG.
    revenueCoefficients: { noiseMin: 0, noiseMax: 0 },
  });
}

function makeClient(name) {
  const app = initClient(
    { apiKey: "demo-key", authDomain: `${PROJECT_ID}.firebaseapp.com`, projectId: PROJECT_ID, appId: "demo" },
    name,
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, {
    disableWarnings: true,
  });
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return { app, auth, functions };
}

async function signAs(auth, adminAuth, uid) {
  const token = await adminAuth.createCustomToken(uid);
  await signInWithCustomToken(auth, token);
}

function validDecision(roundOverride) {
  return {
    gameId: GAME_ID,
    round: roundOverride || 1,
    menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: true, matcha: false },
    quantities: { croissant: 50, cookie: 50, bagel: 50, coffee: 50 },
    sousChefCount: 2,
    sousChefAssignments: { croissant: 1, coffee: 1 },
  };
}

async function main() {
  requireEnv("FIRESTORE_EMULATOR_HOST");
  requireEnv("FIREBASE_AUTH_EMULATOR_HOST");

  initAdmin({ projectId: PROJECT_ID });
  const db = getFirestore();
  const adminAuth = getAdminAuth();

  await seedGame(db);
  console.log(`Seeded game ${GAME_ID} with join code ${JOIN_CODE}`);

  // ----- Four client sessions (one per player) -----
  const ALICE_UID = `${GAME_ID}-alice`;
  const BOB_UID = `${GAME_ID}-bob`;
  const CARLA_UID = `${GAME_ID}-carla`;
  const DAVE_UID = `${GAME_ID}-dave`;

  const alice = makeClient("alice");
  const bob = makeClient("bob");
  const carla = makeClient("carla");
  const dave = makeClient("dave");

  // =========================================================================
  // BE-I04 scenario 1 — 1-player team, creator is solo
  // =========================================================================
  console.log("\n── BE-I04: 1-person team gets solo on create ──");

  await signAs(alice.auth, adminAuth, ALICE_UID);
  const aliceCreateTeam = httpsCallable(alice.functions, "createTeam");
  const createResult = await aliceCreateTeam({
    joinCode: JOIN_CODE,
    teamName: "Knead To Know",
    displayName: "Alice",
  });
  const TEAM_ID = createResult.data.teamId;
  assert(TEAM_ID === "knead-to-know", `teamId should be slugified: ${TEAM_ID}`);

  const teamAfterCreate = await db.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  assert(
    teamAfterCreate.get(`roleAssignments.${ALICE_UID}`) === "solo",
    "creator should be solo, not finance",
  );
  const aliceAfterCreate = await db.doc(`games/${GAME_ID}/players/${ALICE_UID}`).get();
  assert(aliceAfterCreate.get("role") === "solo", "player doc role mirrors team: solo");
  console.log(`  ✓ creator role is "solo" (was "finance" pre-BE-I04)`);

  // =========================================================================
  // BE-I04 scenario 2 — 2-player team, both solo
  // =========================================================================
  console.log("\n── BE-I04: 2-person team keeps everyone solo ──");

  await signAs(bob.auth, adminAuth, BOB_UID);
  const bobJoinGame = httpsCallable(bob.functions, "joinGame");
  await bobJoinGame({
    joinCode: JOIN_CODE,
    displayName: "Bob",
    teamId: TEAM_ID,
  });

  const teamAfter2 = await db.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  assert(teamAfter2.get("memberCount") === 2, "memberCount bumped to 2");
  assert(
    teamAfter2.get(`roleAssignments.${ALICE_UID}`) === "solo",
    "alice still solo at 2 members",
  );
  assert(
    teamAfter2.get(`roleAssignments.${BOB_UID}`) === "solo",
    "bob also solo at 2 members",
  );
  const bobAfterJoin = await db.doc(`games/${GAME_ID}/players/${BOB_UID}`).get();
  assert(bobAfterJoin.get("role") === "solo", "bob player doc role: solo");
  console.log("  ✓ both alice + bob are solo while team has 2 members");

  // =========================================================================
  // FE-I15 scenario 1 — 2-player team, either member can submit anything
  // =========================================================================
  console.log("\n── FE-I15: 2-player team — either teammate can submit ──");

  // Advance to decide so submitDecision works
  await db.doc(`games/${GAME_ID}`).update({
    phase: "round_1_decide",
    round: 1,
    currentRound: 1,
  });

  // Alice (role = solo) submits — should pass trivially
  const aliceSubmit = httpsCallable(alice.functions, "submitDecision");
  const aliceResult = await aliceSubmit(validDecision());
  assert(aliceResult.data.submitted === true, "alice (solo) submitDecision succeeds");
  console.log("  ✓ alice (role=solo) submits decision");

  // Bob (role = solo) — same, also passes
  const bobSubmit = httpsCallable(bob.functions, "submitDecision");
  const bobResult = await bobSubmit(validDecision());
  assert(bobResult.data.submitted === true, "bob (solo) submitDecision succeeds");
  console.log("  ✓ bob (role=solo) also submits");

  // Also test submitBids for ad + chef — both bid types should accept
  // either teammate. Flip phase to bid_ad.
  await db.doc(`games/${GAME_ID}`).update({
    phase: "round_1_bid_ad",
    phaseEndsAt: FieldValue.serverTimestamp(),
  });
  // Give the emulator a fresh phaseEndsAt far in the future so the
  // submitBids timer-expiry guard doesn't reject us.
  const future = new Date(Date.now() + 10 * 60 * 1000);
  await db.doc(`games/${GAME_ID}`).update({
    phaseEndsAt: future,
  });

  const bobSubmitBids = httpsCallable(bob.functions, "submitBids");
  await bobSubmitBids({
    gameId: GAME_ID,
    bidType: "ad",
    adBids: { TV: 10000 },
  });
  console.log("  ✓ bob (role=solo) submits ad bids");

  // Chef auction round setup — seed a chef pool so validateChefBids works
  await db.doc(`games/${GAME_ID}/rounds/round_1`).set({
    chefPool: [
      { id: "chef-1", name: "Test Chef", minBidFloor: 10000, skillTier: "Novel" },
    ],
  }, { merge: true });

  await db.doc(`games/${GAME_ID}`).update({ phase: "round_1_bid_chef" });
  const aliceSubmitBids = httpsCallable(alice.functions, "submitBids");
  await aliceSubmitBids({
    gameId: GAME_ID,
    bidType: "chef",
    chefBids: [{ chefId: "chef-1", amount: 15000 }],
  });
  console.log("  ✓ alice (role=solo) submits chef bids");

  // =========================================================================
  // BE-I04 (revised Apr 25) — 2→3 join keeps everyone on `solo`; players
  // claim specialist roles explicitly via the picker / setTeamRole.
  // =========================================================================
  console.log("\n── 2→3 join keeps everyone on solo until they pick ──");

  // Reset phase so createTeam / joinGame are allowed again. joinGame
  // allows rejoin at any phase — but for a new 3rd member we need
  // lobby phase. Flip back.
  await db.doc(`games/${GAME_ID}`).update({ phase: "lobby" });

  await signAs(carla.auth, adminAuth, CARLA_UID);
  const carlaJoinGame = httpsCallable(carla.functions, "joinGame");
  await carlaJoinGame({
    joinCode: JOIN_CODE,
    displayName: "Carla",
    teamId: TEAM_ID,
  });

  const teamAfter3 = await db.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  assert(teamAfter3.get("memberCount") === 3, "memberCount bumped to 3");

  const roleMapAuto = teamAfter3.get("roleAssignments");
  for (const uid of [ALICE_UID, BOB_UID, CARLA_UID]) {
    assert(
      roleMapAuto[uid] === "solo",
      `roleAssignments[${uid}] should remain 'solo' until the player picks via setTeamRole`,
    );
    const pSnap = await db.doc(`games/${GAME_ID}/players/${uid}`).get();
    assert(
      pSnap.get("role") === "solo",
      `players/${uid}.role mirrors the 'solo' default — no auto-cascade`,
    );
  }
  console.log("  ✓ every seat stays on 'solo' (no auto-cascade)");

  // Now drive the picker the way the FE does — each teammate calls
  // setTeamRole to claim a specialist. The downstream FE-I15 / role-gate
  // assertions below depend on this 3-way split.
  const aliceSetRole = httpsCallable(alice.functions, "setTeamRole");
  await aliceSetRole({ gameId: GAME_ID, teamId: TEAM_ID, role: "finance" });
  const bobSetRole = httpsCallable(bob.functions, "setTeamRole");
  await bobSetRole({ gameId: GAME_ID, teamId: TEAM_ID, role: "advertising" });
  const carlaSetRole = httpsCallable(carla.functions, "setTeamRole");
  await carlaSetRole({ gameId: GAME_ID, teamId: TEAM_ID, role: "operations" });

  const teamAfterPicks = await db.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  const roleMap = teamAfterPicks.get("roleAssignments");
  assert(roleMap[ALICE_UID] === "finance", "alice picked finance");
  assert(roleMap[BOB_UID] === "advertising", "bob picked advertising");
  assert(roleMap[CARLA_UID] === "operations", "carla picked operations");

  // Player docs should mirror the picks.
  for (const uid of [ALICE_UID, BOB_UID, CARLA_UID]) {
    const pSnap = await db.doc(`games/${GAME_ID}/players/${uid}`).get();
    assert(
      pSnap.get("role") === roleMap[uid],
      `players/${uid}.role mirrors roleMap: expected ${roleMap[uid]}, got ${pSnap.get("role")}`,
    );
  }
  console.log(`  ✓ alice=${roleMap[ALICE_UID]}, bob=${roleMap[BOB_UID]}, carla=${roleMap[CARLA_UID]} (manual picks)`);
  console.log("  ✓ every player doc's role mirrors the team picks");

  // =========================================================================
  // FE-I15 scenario 2 — 3-role team enforces strict role gate
  // =========================================================================
  console.log("\n── FE-I15: full 3-role team still enforces role gate ──");

  // Identify who got finance/advertising/operations so we can test the gate.
  const uidByRole = {};
  for (const [uid, r] of Object.entries(roleMap)) uidByRole[r] = uid;

  // Non-operations teammate cannot submitDecision; check by the role
  // we identified. Pick the finance member.
  const financeUid = uidByRole.finance;
  const financeClient = [alice, bob, carla].find((c, i) => {
    const uid = [ALICE_UID, BOB_UID, CARLA_UID][i];
    return uid === financeUid;
  });
  assert(financeClient, "identified finance teammate's client");

  // Flip back to decide phase for round 2 (round 1 already has a submit).
  await db.doc(`games/${GAME_ID}`).update({
    phase: "round_2_decide",
    round: 2,
    currentRound: 2,
  });

  const financeSubmit = httpsCallable(financeClient.functions, "submitDecision");
  await expectError(
    () => financeSubmit(validDecision(2)),
    "permission-denied",
    "finance role can't submitDecision on a 3-role team",
  );

  const operationsUid = uidByRole.operations;
  const operationsClient = [alice, bob, carla].find((c, i) => {
    const uid = [ALICE_UID, BOB_UID, CARLA_UID][i];
    return uid === operationsUid;
  });
  const opsSubmit = httpsCallable(operationsClient.functions, "submitDecision");

  // POST-01 gate: when a Finance teammate exists, Operations cannot submit
  // until Finance has posted prices for this round. Reproduces and locks in
  // the regression where Operations submits silently went through (or worse,
  // surfaced as a generic "internal" error in earlier builds).
  await expectError(
    () => opsSubmit(validDecision(2)),
    "failed-precondition",
    "operations blocked before finance submits prices",
  );

  // Now Finance posts prices for round 2 — afterwards Operations may submit.
  const financeSubmitPrices = httpsCallable(financeClient.functions, "submitPrices");
  await financeSubmitPrices({
    gameId: GAME_ID,
    productPrices: { croissant: 5, cookie: 3, bagel: 4, coffee: 4 },
    menu: { croissant: true, cookie: true, bagel: true, sandwich: false, coffee: true, matcha: false },
  });

  const opsResult = await opsSubmit(validDecision(2));
  assert(opsResult.data.submitted === true, "operations teammate submits decision");
  console.log("  ✓ operations submits after finance posts prices; finance still blocked from submitDecision");

  // =========================================================================
  // BE-I13 scenario — clear role round-trip via setTeamRole
  // =========================================================================
  console.log("\n── BE-I13: clear role via setTeamRole(null) ──");

  // Operations teammate clears their role. The fallback should then
  // kick in — and any teammate (finance or advertising) should be
  // able to submitDecision in a subsequent round.
  const opsSetRole = httpsCallable(operationsClient.functions, "setTeamRole");
  await opsSetRole({ gameId: GAME_ID, teamId: TEAM_ID, role: null });

  const teamAfterClear = await db.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  assert(
    teamAfterClear.get(`roleAssignments.${operationsUid}`) === null,
    "operations slot nulled after clear",
  );
  const opsPlayerAfterClear = await db.doc(`games/${GAME_ID}/players/${operationsUid}`).get();
  assert(
    opsPlayerAfterClear.get("role") === "solo",
    "cleared player doc.role falls back to solo",
  );
  console.log(`  ✓ setTeamRole({ role: null }) clears assignment, player.role -> solo`);

  // Alternate clear spellings.
  await opsSetRole({ gameId: GAME_ID, teamId: TEAM_ID, role: "operations" });
  await opsSetRole({ gameId: GAME_ID, teamId: TEAM_ID, role: "" });
  const afterEmptyStr = await db.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  assert(
    afterEmptyStr.get(`roleAssignments.${operationsUid}`) === null,
    'role: "" also clears',
  );
  console.log('  ✓ role: "" clears');

  await opsSetRole({ gameId: GAME_ID, teamId: TEAM_ID, role: "operations" });
  await opsSetRole({ gameId: GAME_ID, teamId: TEAM_ID, role: "unassigned" });
  const afterUnassigned = await db.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  assert(
    afterUnassigned.get(`roleAssignments.${operationsUid}`) === null,
    'role: "unassigned" also clears',
  );
  console.log('  ✓ role: "unassigned" clears');

  // Another teammate can reclaim the cleared role.
  const opsClearedSetRole = httpsCallable(financeClient.functions, "setTeamRole");
  // First they have to clear their own finance role, since a player
  // can only hold one seat at a time.
  await opsClearedSetRole({ gameId: GAME_ID, teamId: TEAM_ID, role: null });
  await opsClearedSetRole({ gameId: GAME_ID, teamId: TEAM_ID, role: "operations" });
  const afterReclaim = await db.doc(`games/${GAME_ID}/teams/${TEAM_ID}`).get();
  assert(
    afterReclaim.get(`roleAssignments.${financeUid}`) === "operations",
    "finance teammate reclaims cleared operations slot",
  );
  console.log("  ✓ another teammate reclaims the cleared role");

  // =========================================================================
  // FE-I15 scenario 3 — cleared operations + manual reclaim → fallback off
  // =========================================================================
  console.log("\n── FE-I15: fallback stays off when someone re-holds the role ──");

  // Current state: financeUid → operations, operationsUid → solo,
  // advertisingUid → advertising. Team has an operations holder, so
  // the strict gate should reject the solo'd teammate.
  //
  // But wait — operationsUid's player doc is solo. A solo role always
  // passes the gate. Let's instead check the advertising teammate
  // can't submit (they're still "advertising" and not solo).
  const advertisingUid = uidByRole.advertising;
  const advertisingClient = [alice, bob, carla].find((c, i) => {
    const uid = [ALICE_UID, BOB_UID, CARLA_UID][i];
    return uid === advertisingUid;
  });

  // Advance to round 3 decide so no "already submitted" collision.
  await db.doc(`games/${GAME_ID}`).update({
    phase: "round_3_decide",
    round: 3,
    currentRound: 3,
  });

  const advSubmit = httpsCallable(advertisingClient.functions, "submitDecision");
  await expectError(
    () => advSubmit(validDecision(3)),
    "permission-denied",
    "advertising can't submitDecision once finance-turned-operations holds the seat",
  );

  // The new-operations teammate (was finance) submits fine.
  const newOpsSubmit = httpsCallable(financeClient.functions, "submitDecision");
  const newOpsResult = await newOpsSubmit(validDecision(3));
  assert(
    newOpsResult.data.submitted === true,
    "re-held operations teammate submits",
  );
  console.log("  ✓ strict gate restored after reclaim");

  console.log(`\n✅ Apr 23 P0 e2e test passed. Game id: ${GAME_ID}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
