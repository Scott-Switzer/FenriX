import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { doc, onSnapshot, type DocumentData } from "firebase/firestore";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import { db } from "../lib/firebase";
import { parseGamePhase } from "../types/game";

/**
 * Subscribes to the active game doc and navigates to the correct phase route
 * whenever the professor advances the game. Works on any page — mirrors the
 * exact pattern used in TeamPage which is confirmed working.
 *
 * Call this once at the top of any phase page that doesn't already have its
 * own game-doc listener (EmailPhasePage, AuctionPage, RosterPhasePage, etc.).
 */
export function useGamePhaseNav() {
  const { gameId, phase } = useGame();
  const dispatch = useGameDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const [livePhase, setLivePhase] = useState<string | null>(null);

  useEffect(() => {
    if (!gameId) return;
    const gameRef = doc(db, "games", gameId);
    return onSnapshot(
      gameRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as DocumentData;
        if (typeof data.phase === "string") {
          dispatch({ type: "SET_PHASE", payload: data.phase });
          setLivePhase(data.phase);
        }
        const round =
          typeof data.currentRound === "number"
            ? data.currentRound
            : typeof data.round === "number"
            ? data.round
            : null;
        if (round !== null) dispatch({ type: "SET_ROUND", payload: round });
        const ends = data.phaseEndsAt;
        if (ends && typeof ends.toMillis === "function") {
          dispatch({ type: "SET_PHASE_ENDS_AT", payload: ends.toMillis() });
        } else if (ends === null || ends === undefined) {
          dispatch({ type: "SET_PHASE_ENDS_AT", payload: null });
        }
      },
      (err) => {
        console.error("useGamePhaseNav game-doc listener error:", { gameId, err });
      },
    );
  }, [gameId, dispatch]);

  useEffect(() => {
    const active = livePhase ?? phase;
    if (!active || active === "lobby") return;
    if (location.pathname.startsWith("/professor")) return;

    const base = parseGamePhase(active).base;
    let target: string;
    if (base === "bid_ad" || base === "bid_chef") target = "/auction";
    else if (base === "email") target = "/game/email";
    else if (base === "roster") target = "/game/roster";
    else if (base === "game_over") target = "/game/conclusion";
    else target = "/game";

    if (location.pathname !== target) navigate(target);
  }, [livePhase, phase, navigate, location.pathname]);
}
