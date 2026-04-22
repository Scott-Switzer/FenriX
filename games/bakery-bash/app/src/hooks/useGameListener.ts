import { useEffect } from "react";
import {
  collection,
  doc,
  onSnapshot,
  type DocumentData,
} from "firebase/firestore";
import { useGameDispatch } from "../contexts/GameContext";
import { db } from "../lib/firebase";
import {
  type GameConfigParams,
  type LeaderboardRanking,
  type MaintenanceBars,
  type Player,
  type RoundResult,
} from "../types/game";

/**
 * FE-5 — Central Firestore subscription hook.
 *
 * Keeps `GameContext` in sync with Firestore by wiring all the real-time
 * listeners the UI needs. Call this once, as high in the tree as possible,
 * from any page that mounts while `gameId` is known (typically `GamePage`
 * via the `App` shell).
 *
 * Scope of listeners:
 *   1. Game doc            — `/games/{gameId}`
 *      -> SET_PHASE, SET_ROUND, SET_PHASE_ENDS_AT, SET_CONFIG (via sub-doc)
 *   2. Player doc          — `/games/{gameId}/players/{playerId}`
 *      -> UPDATE_PLAYER (budget + cumulativeRevenue), SET_MAINTENANCE_BARS,
 *         SET_CHEF_SATISFACTION, SET_BUDGET, SET_ROLE, SET_TEAM_ID,
 *         ADD_RESULT (from `lastRoundResult`)
 *   3. Roster collection   — `/games/{gameId}/roster`
 *      -> SET_PLAYERS (normalized for downstream leaderboard / professor use)
 *   4. Leaderboard doc     — `/games/{gameId}/leaderboard/latest`
 *      -> SET_LEADERBOARD
 *
 * The hook intentionally re-uses the existing reducer action types so other
 * components continue to subscribe via `useGame()` without any API change.
 *
 * Note: `GamePage.tsx` historically inlined listeners 1 + 2 (and the config
 * sub-doc listener + a roster listener scoped to the ad-winner banner). We
 * leave `GamePage` largely intact — this hook is additive and covers the
 * remaining listeners (players for the leaderboard + professor pages, and
 * the leaderboard doc itself). The design note in the backend docs expects
 * listener wiring to live in this hook going forward; new listeners added
 * to the frontend should land here instead of inside page components.
 */
export function useGameListener(gameId: string | null, playerId?: string | null): void {
  const dispatch = useGameDispatch();

  // Listener 1 — game doc (phase / round / phaseEndsAt).
  useEffect(() => {
    if (!gameId) return;
    const gameRef = doc(db, "games", gameId);
    const unsubscribe = onSnapshot(
      gameRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as DocumentData;
        if (typeof data.phase === "string") {
          dispatch({ type: "SET_PHASE", payload: data.phase });
        }
        const nextRound =
          typeof data.currentRound === "number"
            ? data.currentRound
            : typeof data.round === "number"
              ? data.round
              : null;
        if (nextRound !== null) {
          dispatch({ type: "SET_ROUND", payload: nextRound });
        }
        const ends = data.phaseEndsAt;
        if (ends && typeof ends.toMillis === "function") {
          dispatch({ type: "SET_PHASE_ENDS_AT", payload: ends.toMillis() });
        } else if (ends === null || ends === undefined) {
          dispatch({ type: "SET_PHASE_ENDS_AT", payload: null });
        }
      },
      (err) => {
        console.error("useGameListener/game snapshot error", { gameId, err });
      },
    );
    return unsubscribe;
  }, [gameId, dispatch]);

  // Listener 1b — config sub-doc (`/games/{gameId}/config/params`).
  useEffect(() => {
    if (!gameId) return;
    const configRef = doc(db, "games", gameId, "config", "params");
    const unsubscribe = onSnapshot(
      configRef,
      (snap) => {
        if (!snap.exists()) {
          dispatch({ type: "SET_CONFIG", payload: null });
          return;
        }
        dispatch({
          type: "SET_CONFIG",
          payload: snap.data() as GameConfigParams,
        });
      },
      (err) => {
        console.error("useGameListener/config snapshot error", { gameId, err });
      },
    );
    return unsubscribe;
  }, [gameId, dispatch]);

  // Listener 2 — own player doc (budget, maintenance, chef satisfaction,
  // role/team, lastRoundResult). `GamePage` already wires a richer version
  // of this; we re-attach here so pages outside `GamePage` (e.g. the
  // auction page, roster page) still get live budget + bar updates.
  useEffect(() => {
    if (!gameId || !playerId) return;
    const playerRef = doc(db, "games", gameId, "players", playerId);
    const unsubscribe = onSnapshot(
      playerRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as DocumentData;

        const bars = data.maintenanceBars as Partial<MaintenanceBars> | undefined;
        if (
          bars &&
          typeof bars.cleanliness === "number" &&
          typeof bars.ovenHealth === "number" &&
          typeof bars.slicerHealth === "number" &&
          typeof bars.espressoHealth === "number"
        ) {
          dispatch({
            type: "SET_MAINTENANCE_BARS",
            payload: bars as MaintenanceBars,
          });
        }
        const scores = data.chefSatisfactionScores;
        if (scores && typeof scores === "object") {
          dispatch({
            type: "SET_CHEF_SATISFACTION",
            payload: scores as Record<string, number>,
          });
        }
        if (typeof data.budgetCurrent === "number") {
          dispatch({ type: "SET_BUDGET", payload: data.budgetCurrent });
        } else {
          dispatch({ type: "SET_BUDGET", payload: null });
        }

        // cumulativeRevenue lives on the player doc; keep it fresh for the
        // results screen / leaderboard so players see their own running
        // total without waiting for a leaderboard write.
        if (typeof data.cumulativeRevenue === "number") {
          dispatch({
            type: "UPDATE_PLAYER",
            payload: { cumulativeRevenue: data.cumulativeRevenue },
          });
        }

        if (
          data.role === "operations" ||
          data.role === "advertising" ||
          data.role === "finance" ||
          data.role === "solo"
        ) {
          dispatch({ type: "SET_ROLE", payload: data.role });
        }
        if (typeof data.teamId === "string" && data.teamId.length > 0) {
          dispatch({ type: "SET_TEAM_ID", payload: data.teamId });
        } else if (data.teamId === null) {
          dispatch({ type: "SET_TEAM_ID", payload: null });
        }

        const lrr = data.lastRoundResult;
        if (lrr && typeof lrr === "object" && typeof lrr.round === "number") {
          const revenue =
            typeof lrr.revenueNet === "number"
              ? lrr.revenueNet
              : typeof lrr.revenueGross === "number"
                ? lrr.revenueGross
                : typeof lrr.revenue === "number"
                  ? lrr.revenue
                  : 0;
          dispatch({
            type: "ADD_RESULT",
            payload: {
              round: lrr.round,
              revenue,
              revenueNet: lrr.revenueNet,
              revenueGross: lrr.revenueGross,
              amountBorrowed: lrr.amountBorrowed,
              interestCharged: lrr.interestCharged,
              selloutAnywhere: lrr.selloutAnywhere === true,
              customerCount:
                typeof lrr.customerCount === "number" ? lrr.customerCount : 0,
              customerSatisfaction:
                typeof lrr.aggregateSatisfactionPct === "number"
                  ? Math.round(lrr.aggregateSatisfactionPct)
                  : typeof lrr.customerSatisfaction === "number"
                    ? lrr.customerSatisfaction
                    : 0,
              chefSatisfactionScore:
                typeof lrr.chefSatisfactionScore === "number"
                  ? lrr.chefSatisfactionScore
                  : undefined,
              chefSatisfactionScores:
                lrr.chefSatisfactionScores &&
                typeof lrr.chefSatisfactionScores === "object"
                  ? (lrr.chefSatisfactionScores as Record<string, number>)
                  : undefined,
              chefDepartures: Array.isArray(lrr.chefDepartures)
                ? (lrr.chefDepartures as string[])
                : undefined,
              chefDepartureNames: Array.isArray(lrr.chefDepartureNames)
                ? (lrr.chefDepartureNames as string[])
                : undefined,
              productBreakdown:
                lrr.productBreakdown && typeof lrr.productBreakdown === "object"
                  ? lrr.productBreakdown
                  : undefined,
              adWon: lrr.adWon ?? null,
              adPaid: typeof lrr.adPaid === "number" ? lrr.adPaid : undefined,
              auctionResults: {
                adWon: lrr.adWon ?? null,
                chefWon:
                  typeof lrr.chefWon === "string"
                    ? lrr.chefWon
                    : (lrr.chefWon ?? null),
              },
              maintenanceBars:
                lrr.maintenanceBars && typeof lrr.maintenanceBars === "object"
                  ? lrr.maintenanceBars
                  : undefined,
              staffCounts:
                lrr.staffCounts && typeof lrr.staffCounts === "object"
                  ? lrr.staffCounts
                  : undefined,
            } as RoundResult,
          });
        }
      },
      (err) => {
        console.error("useGameListener/player snapshot error", {
          gameId,
          playerId,
          err,
        });
      },
    );
    return unsubscribe;
  }, [gameId, playerId, dispatch]);

  // Listener 3 — roster. Normalized into the `Player[]` shape the rest of
  // the UI consumes. The roster subcollection is publicly readable per
  // firestore rules so this works for every signed-in participant.
  useEffect(() => {
    if (!gameId) return;
    const rosterRef = collection(db, "games", gameId, "roster");
    const unsubscribe = onSnapshot(
      rosterRef,
      (snap) => {
        const players: Player[] = snap.docs.map((d) => {
          const data = d.data() as DocumentData;
          return {
            id: typeof data.uid === "string" ? data.uid : d.id,
            name: typeof data.displayName === "string" ? data.displayName : "Player",
            bakeryName:
              typeof data.bakeryName === "string" && data.bakeryName.length > 0
                ? data.bakeryName
                : typeof data.displayName === "string"
                  ? data.displayName
                  : "Player",
            budget: 0,
            cumulativeRevenue:
              typeof data.cumulativeRevenue === "number"
                ? data.cumulativeRevenue
                : 0,
            teamName: typeof data.teamName === "string" ? data.teamName : undefined,
            role:
              data.role === "operations" ||
              data.role === "advertising" ||
              data.role === "finance" ||
              data.role === "solo"
                ? data.role
                : undefined,
          };
        });
        dispatch({ type: "SET_PLAYERS", payload: players });
      },
      (err) => {
        console.error("useGameListener/roster snapshot error", { gameId, err });
      },
    );
    return unsubscribe;
  }, [gameId, dispatch]);

  // Listener 4 — leaderboard (`/games/{gameId}/leaderboard/latest`).
  // Backend writes the sorted `rankings` array; we mirror it into context
  // so `LeaderboardPage` can read without owning its own listener.
  useEffect(() => {
    if (!gameId) return;
    const lbRef = doc(db, "games", gameId, "leaderboard", "latest");
    const unsubscribe = onSnapshot(
      lbRef,
      (snap) => {
        if (!snap.exists()) {
          dispatch({ type: "SET_LEADERBOARD", payload: [] });
          return;
        }
        const data = snap.data() as DocumentData;
        const rankings = Array.isArray(data.rankings)
          ? (data.rankings as LeaderboardRanking[])
          : [];
        dispatch({ type: "SET_LEADERBOARD", payload: rankings });
      },
      (err) => {
        console.error("useGameListener/leaderboard snapshot error", {
          gameId,
          err,
        });
        // Surface the failure so `LeaderboardPage` can render a visible
        // banner instead of the indefinite "Waiting for first round
        // results…" row (PR #42 review).
        dispatch({
          type: "SET_LEADERBOARD_ERROR",
          payload:
            err.message ?? "Could not load the leaderboard. Please refresh.",
        });
      },
    );
    return unsubscribe;
  }, [gameId, dispatch]);
}
