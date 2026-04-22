import { useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { doc, onSnapshot, type DocumentData } from "firebase/firestore";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import { useGameListener } from "../hooks/useGameListener";
import { db } from "../lib/firebase";
import { parseGamePhase } from "../types/game";

/**
 * App-level listener that stays mounted regardless of route. Subscribes to
 * the active game doc and navigates the player to the correct phase page the
 * moment the professor advances the game — no matter which page they're on.
 *
 * Uses refs for navigate + location so the snapshot callback always has fresh
 * values without needing to re-register the Firestore listener on every render.
 */
export function GamePhaseListener() {
  const { gameId, playerId } = useGame();
  const dispatch = useGameDispatch();
  const navigate = useNavigate();
  const location = useLocation();

  // FE-5 — centralize the app-wide Firestore listeners. Mounting this hook
  // inside `GamePhaseListener` (which itself renders at the root of the
  // router in `App.tsx`) means the listeners follow the lifecycle of the
  // session — they attach when the game id is known and tear down on
  // lobby/conclusion unmounts. `GamePage` still wires a few page-scoped
  // listeners (roster → ad-winner banner, etc.) because those are only
  // relevant during the decide phase.
  useGameListener(gameId, playerId);

  const navigateRef = useRef(navigate);
  const pathnameRef = useRef(location.pathname);

  // Keep refs in sync on every render (no deps = runs after every render).
  useEffect(() => {
    navigateRef.current = navigate;
    pathnameRef.current = location.pathname;
  });

  useEffect(() => {
    if (!gameId) return;
    const gameRef = doc(db, "games", gameId);
    return onSnapshot(gameRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.data() as DocumentData;
      const phase = data.phase;
      const round =
        typeof data.currentRound === "number"
          ? data.currentRound
          : typeof data.round === "number"
          ? data.round
          : null;
      const ends = data.phaseEndsAt;

      if (typeof phase === "string") {
        dispatch({ type: "SET_PHASE", payload: phase });
      }
      if (round !== null) dispatch({ type: "SET_ROUND", payload: round });
      if (ends && typeof ends.toMillis === "function") {
        dispatch({ type: "SET_PHASE_ENDS_AT", payload: ends.toMillis() });
      } else if (ends === null || ends === undefined) {
        dispatch({ type: "SET_PHASE_ENDS_AT", payload: null });
      }

      if (typeof phase !== "string" || phase === "lobby") return;
      if (pathnameRef.current.startsWith("/professor")) return;

      const base = parseGamePhase(phase).base;
      let target: string;
      if (base === "bid_ad" || base === "bid_chef") target = "/auction";
      else if (base === "email") target = "/game/email";
      else if (base === "roster") target = "/game/roster";
      else if (base === "game_over") target = "/game/conclusion";
      else target = "/game";

      if (pathnameRef.current !== target) {
        navigateRef.current(target);
      }
    }, (err) => {
      console.error("games/{gameId} phase listener error:", { gameId, err });
    });
  }, [gameId, dispatch]);

  return null;
}
