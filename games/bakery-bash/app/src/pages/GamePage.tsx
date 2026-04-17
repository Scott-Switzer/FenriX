import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { doc, onSnapshot, type DocumentData } from "firebase/firestore";
import { httpsCallable, type FunctionsError } from "firebase/functions";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import { RoundHeader } from "../components/game/RoundHeader";
import { BakeryView } from "../components/game/BakeryView";
import { GameSidebar } from "../components/game/GameSidebar";
import { PageShell } from "../components/ui/PageShell";
import { SimulatePhase } from "./phases/SimulatePhase";
import { ResultsPhase } from "./phases/ResultsPhase";
import { db, functions } from "../lib/firebase";
import {
  parseGamePhase,
  type GameConfigParams,
  type PendingDecisionDraft,
} from "../types/game";

interface SubmitDecisionResponse {
  gameId: string;
  playerId: string;
  roundId: string;
  submitted: boolean;
}

function humanizeFunctionError(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "code" in err) {
    const fnErr = err as FunctionsError;
    if (fnErr.message) return fnErr.message;
  }
  return fallback;
}

export function GamePage() {
  const {
    gameId,
    phase,
    currentRound,
    pendingDecision,
    decisionSubmitted,
  } = useGame();
  const dispatch = useGameDispatch();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // --- Listener: /games/{gameId} — drives phase + round from backend. ---
  useEffect(() => {
    if (!gameId) return;
    const gameRef = doc(db, "games", gameId);
    const unsubscribe = onSnapshot(
      gameRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as DocumentData;
        const nextPhase = data.phase;
        if (typeof nextPhase === "string") {
          dispatch({ type: "SET_PHASE", payload: nextPhase });
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
      },
      (err) => {
        console.error("games/{gameId} listener error:", err);
      }
    );
    return unsubscribe;
  }, [gameId, dispatch]);

  // --- Listener: /games/{gameId}/config/params — drives dynamic config. ---
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
        console.error("games/{gameId}/config/params listener error:", err);
      }
    );
    return unsubscribe;
  }, [gameId, dispatch]);

  const parsed = parseGamePhase(phase, currentRound);
  const basePhase = parsed.base;

  // Redirect into the dedicated auction page when backend says so. This is
  // phase-driven (not a manual navigation after submit).
  useEffect(() => {
    if (basePhase === "bid_ad" || basePhase === "bid_chef") {
      navigate("/auction");
    }
  }, [basePhase, navigate]);

  const handleSubmit = useCallback(async () => {
    if (!gameId) {
      setSubmitError("Not connected to a game yet.");
      return;
    }
    if (basePhase !== "decide") {
      setSubmitError("Decisions can only be submitted during the decide phase.");
      return;
    }

    setSubmitError(null);
    setSubmitting(true);
    try {
      const submitDecision = httpsCallable<
        { gameId: string } & PendingDecisionDraft,
        SubmitDecisionResponse
      >(functions, "submitDecision");

      // Build a server-valid `sousChefAssignments` map.
      //  * Keys must be on the active menu (server rejects entries for
      //    products not on the menu, even when value is 0).
      //  * Sum of values must equal `sousChefCount`.
      // The dedicated `<SousChefPanel>` with per-product assignments is a P1
      // follow-up (see FRONTEND.md §4). For P0 we collapse all hires onto
      // croissant, which is always on the base menu.
      const sanitizedAssignments: Record<string, number> = {};
      for (const key of Object.keys(pendingDecision.sousChefAssignments)) {
        const value = pendingDecision.sousChefAssignments[
          key as keyof typeof pendingDecision.sousChefAssignments
        ];
        if (!value || value <= 0) continue;
        if (!pendingDecision.menu[key as keyof typeof pendingDecision.menu]) {
          continue;
        }
        sanitizedAssignments[key] = value;
      }
      const assignedSum = Object.values(sanitizedAssignments).reduce(
        (s, n) => s + n,
        0
      );
      if (pendingDecision.sousChefCount > 0 && assignedSum === 0) {
        sanitizedAssignments.croissant = pendingDecision.sousChefCount;
      }

      await submitDecision({
        gameId,
        menu: pendingDecision.menu,
        quantities: pendingDecision.quantities,
        sousChefCount: pendingDecision.sousChefCount,
        sousChefAssignments: sanitizedAssignments as PendingDecisionDraft["sousChefAssignments"],
      });
      dispatch({ type: "SET_DECISION_SUBMITTED", payload: true });
      // Do NOT dispatch SET_PHASE — the backend phase listener owns transitions.
    } catch (err) {
      setSubmitError(
        humanizeFunctionError(
          err,
          "Could not submit decisions. Please try again."
        )
      );
    } finally {
      setSubmitting(false);
    }
  }, [gameId, basePhase, pendingDecision, dispatch]);

  const isDecisionPhase = basePhase === "decide";
  const isSimulating = basePhase === "simulating";
  const isResultsReady = basePhase === "results_ready";

  if (!isDecisionPhase) {
    return (
      <PageShell className="game-page">
        <RoundHeader />
        <div className="game-page__content">
          {isSimulating ? (
            <SimulatePhase />
          ) : isResultsReady ? (
            <ResultsPhase />
          ) : (
            <ResultsPhase />
          )}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell className="game-page game-page--wide">
      <RoundHeader />
      <div className="game-page__dashboard">
        <BakeryView />
        <GameSidebar />
      </div>
      {submitError && (
        <p className="game-page__submit-error" role="alert">
          {submitError}
        </p>
      )}
      <button
        className="btn btn--primary game-page__submit"
        onClick={handleSubmit}
        disabled={submitting || decisionSubmitted || !gameId}
      >
        {submitting
          ? "Submitting…"
          : decisionSubmitted
          ? "Submitted — waiting for other players…"
          : "Submit Decisions"}
      </button>
    </PageShell>
  );
}
