/**
 * useFirebase.ts — All Cloud Function calls + Firestore listeners
 *
 * This is the integration layer between the React frontend and the
 * Firebase backend. Every function maps 1:1 to an exported callable
 * in functions/index.js.
 */

import { httpsCallable } from "firebase/functions";
import {
  doc,
  collection,
  onSnapshot,
  updateDoc,
  type Unsubscribe,
} from "firebase/firestore";
import { db, functions } from "../lib/firebase";

// ── Cloud Function wrappers ──

export async function callCreateGame(totalRounds = 5) {
  const fn = httpsCallable<
    { totalRounds: number },
    { gameId: string; joinCode: string; totalRounds: number }
  >(functions, "createGame");
  const result = await fn({ totalRounds });
  return result.data;
}

export async function callJoinGame(joinCode: string, displayName: string) {
  const fn = httpsCallable<
    { joinCode: string; displayName: string },
    { uid: string; gameId: string; playerId: string; displayName: string }
  >(functions, "joinGame");
  const result = await fn({ joinCode, displayName });
  return result.data;
}

export async function callStartGame(gameId: string) {
  const fn = httpsCallable<
    { gameId: string },
    { gameId: string; phase: string; currentRound: number }
  >(functions, "startGame");
  const result = await fn({ gameId });
  return result.data;
}

export async function callAdvancePhase(gameId: string) {
  const fn = httpsCallable<
    { gameId: string },
    { gameId: string; phase: string; currentRound: number }
  >(functions, "advancePhase");
  const result = await fn({ gameId });
  return result.data;
}

export async function callSubmitDecisions(gameId: string) {
  const fn = httpsCallable<
    { gameId: string },
    { success: boolean; roundId: string; numProducts: number; avgPrice: number }
  >(functions, "submitDecisions");
  const result = await fn({ gameId });
  return result.data;
}

export async function callExportCsv(gameId: string) {
  const fn = httpsCallable<
    { gameId: string },
    { csv: string; rowCount: number }
  >(functions, "exportCsv");
  const result = await fn({ gameId });
  return result.data;
}

export async function callProfessorExport(gameId: string) {
  const fn = httpsCallable<
    { gameId: string },
    { csv: string; rowCount: number; playerCount: number }
  >(functions, "professorExport");
  const result = await fn({ gameId });
  return result.data;
}

// ── Firestore real-time listeners ──

/** Listen to the game document for phase/round changes. */
export function onGameSnapshot(
  gameId: string,
  callback: (data: Record<string, unknown>) => void
): Unsubscribe {
  return onSnapshot(doc(db, "games", gameId), (snap) => {
    if (snap.exists()) {
      callback({ id: snap.id, ...snap.data() });
    }
  });
}

/** Listen to the players subcollection for live player list. */
export function onPlayersSnapshot(
  gameId: string,
  callback: (players: Array<Record<string, unknown>>) => void
): Unsubscribe {
  return onSnapshot(collection(db, "games", gameId, "players"), (snap) => {
    const players = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    callback(players);
  });
}

/** Listen to the current player's document. */
export function onPlayerSnapshot(
  gameId: string,
  playerId: string,
  callback: (data: Record<string, unknown>) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, "games", gameId, "players", playerId),
    (snap) => {
      if (snap.exists()) {
        callback({ id: snap.id, ...snap.data() });
      }
    }
  );
}

/** Listen to the leaderboard. */
export function onLeaderboardSnapshot(
  gameId: string,
  callback: (data: Record<string, unknown>) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, "games", gameId, "leaderboard", "current"),
    (snap) => {
      if (snap.exists()) {
        callback(snap.data());
      }
    }
  );
}

/** Listen to a specific round's aggregate results. */
export function onRoundSnapshot(
  gameId: string,
  roundId: string,
  callback: (data: Record<string, unknown>) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, "games", gameId, "rounds", roundId),
    (snap) => {
      if (snap.exists()) {
        callback({ id: snap.id, ...snap.data() });
      }
    }
  );
}

// ── Client-side Firestore writes (pendingDecision / pendingBids) ──

/** Update the player's pending decision fields (client writes these before submitting). */
export async function updatePendingDecision(
  gameId: string,
  playerId: string,
  decision: Record<string, unknown>
) {
  const playerRef = doc(db, "games", gameId, "players", playerId);
  await updateDoc(playerRef, {
    "pendingDecision.staffCount": decision.staffCount,
    "pendingDecision.adSpend": decision.adSpend,
    "pendingDecision.menu": decision.menu,
    "pendingDecision.productPrices": decision.productPrices,
    "pendingDecision.quantities": decision.quantities,
  });
}

/** Update the player's pending bids. */
export async function updatePendingBids(
  gameId: string,
  playerId: string,
  bids: { adBid: { adType: string | null; amount: number }; chefBid: { amount: number } }
) {
  const playerRef = doc(db, "games", gameId, "players", playerId);
  await updateDoc(playerRef, {
    "pendingBids.adBid": bids.adBid,
    "pendingBids.chefBid": bids.chefBid,
  });
}
