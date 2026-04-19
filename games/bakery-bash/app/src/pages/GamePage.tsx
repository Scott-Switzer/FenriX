import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { doc, onSnapshot, type DocumentData } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import { RoundHeader } from "../components/game/RoundHeader";
import { BakeryView } from "../components/game/BakeryView";
import { GameSidebar } from "../components/game/GameSidebar";
import { PageShell } from "../components/ui/PageShell";
import { SimulatePhase } from "./phases/SimulatePhase";
import { ResultsPhase } from "./phases/ResultsPhase";
import { db, functions } from "../lib/firebase";
import { humanizeFunctionError } from "../lib/errors";
import {
  PRODUCT_STATION,
  parseGamePhase,
  ownerOfDecide,
  roleOwnsDecide,
  totalSousChefs,
  type GameConfigParams,
  type MaintenanceBars,
  type MaintenanceTask,
  type PendingDecisionDraft,
  type ProductKey,
  type StaffCounts,
  type StationId,
} from "../types/game";

interface SubmitDecisionResponse {
  gameId: string;
  playerId: string;
  roundId: string;
  submitted: boolean;
}

/**
 * Map `staffCounts` → per-product `sousChefAssignments`.
 *
 * Rationale: the current backend validator reads `sousChefAssignments` keyed
 * by product and rejects entries for products not on the menu. We translate
 * each station's sous-chef count onto the products that station owns and
 * that the player has on the menu. If no products from a given station are
 * offered, we push those chefs onto any offered fallback (croissant is
 * always on the base menu) so the sum reconciles with `sousChefCount`.
 *
 * This shim is transitional: once BE-1..BE-10 land and the backend consumes
 * the new `staffCounts` field directly, the per-product legacy assignment
 * will be ignored server-side.
 */
function deriveSousChefAssignments(
  staffCounts: StaffCounts,
  menu: Record<ProductKey, boolean>,
): Record<string, number> {
  const productsByStation: Record<StationId, ProductKey[]> = {
    bakery: [],
    deli: [],
    barista: [],
  };
  (Object.keys(PRODUCT_STATION) as ProductKey[]).forEach((p) => {
    if (menu[p]) productsByStation[PRODUCT_STATION[p]].push(p);
  });

  const assignments: Record<string, number> = {};
  const addToProduct = (p: ProductKey, n: number) => {
    if (n <= 0) return;
    assignments[p] = (assignments[p] ?? 0) + n;
  };

  const assignStation = (station: StationId, count: number) => {
    if (count <= 0) return;
    const available = productsByStation[station];
    if (available.length === 0) {
      // No products offered from this station's menu — fall back to
      // croissant (always on the base menu) so the sum reconciles.
      addToProduct("croissant", count);
      return;
    }
    // Spread evenly; any remainder goes on the first slot.
    const per = Math.floor(count / available.length);
    let leftover = count - per * available.length;
    for (const prod of available) {
      const extra = leftover > 0 ? 1 : 0;
      addToProduct(prod, per + extra);
      if (leftover > 0) leftover -= 1;
    }
  };

  assignStation("bakery", staffCounts.bakerySousChefs);
  assignStation("deli", staffCounts.deliSousChefs);
  assignStation("barista", staffCounts.baristaSousChefs);

  return assignments;
}

export function GamePage() {
  const {
    gameId,
    playerId,
    phase,
    currentRound,
    pendingDecision,
    decisionSubmitted,
    role,
  } = useGame();
  const dispatch = useGameDispatch();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // --- Listener: /games/{gameId} — drives phase + round + phaseEndsAt. ---
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
        // `phaseEndsAt` is a Firestore Timestamp written by `advanceGamePhase`
        // (see backend/functions/index.js::phaseEndsAtFromNow). The
        // RoundHeader uses it to render the live decide / auction
        // countdown. Pause sets it to null (DEC-21 — backend pauseGame).
        const ends = data.phaseEndsAt;
        if (ends && typeof ends.toMillis === "function") {
          dispatch({ type: "SET_PHASE_ENDS_AT", payload: ends.toMillis() });
        } else if (ends === null || ends === undefined) {
          dispatch({ type: "SET_PHASE_ENDS_AT", payload: null });
        }
      },
      (err) => {
        console.error("games listener error", { gameId, err });
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
        console.error("games/config/params listener error", { gameId, err });
      }
    );
    return unsubscribe;
  }, [gameId, dispatch]);

  // --- Listener: /games/{gameId}/players/{playerId} — maintenance/chef stats + budget. ---
  // Cloud Functions write `maintenanceBars`, `chefSatisfactionScores`, and
  // `budgetCurrent` onto the player doc as they evolve. We mirror them into
  // GameContext so the sidebar status bars, results-phase warnings, and
  // budget summary stay live. The maintenance/satisfaction fields are absent
  // until BE-1..BE-10 ship; `budgetCurrent` is initialized at join time.
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
          // Field absent (legacy doc, mid-write, or backend dropped it):
          // clear so the BudgetSummary doesn't display a stale value from a
          // previous round / previous game session.
          dispatch({ type: "SET_BUDGET", payload: null });
        }
        // DEC-21: backend assigns role + teamId on the player doc once
        // teams are formed. Mirror them so the team page + role-gated
        // submits can react. The team doc's `name` is read separately
        // by `TeamPage` (subscribes to /teams/{teamId} for live sync).
        if (
          data.role === "operations" ||
          data.role === "advertising" ||
          data.role === "finance" ||
          data.role === "solo"
        ) {
          dispatch({ type: "SET_ROLE", payload: data.role });
        }
        if (typeof data.teamId === "string" && data.teamId.length > 0) {
          // teamName itself comes from the team-doc listener (TeamPage).
          dispatch({ type: "SET_TEAM_ID", payload: data.teamId });
        } else if (data.teamId === null) {
          dispatch({ type: "SET_TEAM_ID", payload: null });
        }
      },
      (err) => {
        console.error("games/players listener error", {
          gameId,
          playerId,
          err,
        });
      },
    );
    return unsubscribe;
  }, [gameId, playerId, dispatch]);

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
      // The callable accepts both the legacy `sousChef*` fields (read today)
      // and the new `staffCounts`/`maintenanceTasks` fields (which the
      // validator ignores until BE-1..BE-10 ship). Shipping both means the
      // backend can cut over with no coordinated frontend release.
      type SubmitPayload = { gameId: string } & PendingDecisionDraft;
      const submitDecision = httpsCallable<SubmitPayload, SubmitDecisionResponse>(
        functions,
        "submitDecision",
      );

      // Derive the legacy shape from the station-based counts so the current
      // backend validator accepts our submission. Sous-chef totals sum across
      // the 3 stations (maintenance guys are their own role, not sous chefs).
      const sousChefCount = totalSousChefs(pendingDecision.staffCounts);
      const sanitizedAssignments = deriveSousChefAssignments(
        pendingDecision.staffCounts,
        pendingDecision.menu,
      );
      const assignedSum = Object.values(sanitizedAssignments).reduce(
        (s, n) => s + n,
        0,
      );
      if (sousChefCount > 0 && assignedSum !== sousChefCount) {
        // Safety net — shouldn't happen, but `deriveSousChefAssignments`
        // preserves the total so the validator's equality check passes.
        console.warn(
          "Derived sousChefAssignments sum (%d) ≠ sousChefCount (%d); falling back to croissant.",
          assignedSum,
          sousChefCount,
        );
        sanitizedAssignments.croissant =
          (sanitizedAssignments.croissant ?? 0) + (sousChefCount - assignedSum);
      }

      // Trim maintenance tasks to the current maintenance-guy count; the
      // StaffTab keeps them in sync, but a mid-edit state could produce a
      // mismatch, so clamp defensively.
      const maintenanceTasks: MaintenanceTask[] =
        pendingDecision.maintenanceTasks.slice(
          0,
          pendingDecision.staffCounts.maintenanceGuys,
        );

      await submitDecision({
        gameId,
        menu: pendingDecision.menu,
        quantities: pendingDecision.quantities,
        sousChefCount,
        sousChefAssignments:
          sanitizedAssignments as PendingDecisionDraft["sousChefAssignments"],
        staffCounts: pendingDecision.staffCounts,
        maintenanceTasks,
      });
      dispatch({ type: "SET_DECISION_SUBMITTED", payload: true });
      // Do NOT dispatch SET_PHASE — the backend phase listener owns transitions.
    } catch (err) {
      setSubmitError(
        humanizeFunctionError(
          err,
          "Could not submit decisions. Please try again.",
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }, [gameId, basePhase, pendingDecision, dispatch]);

  const isDecisionPhase = basePhase === "decide";
  const isSimulating = basePhase === "simulating";

  if (!isDecisionPhase) {
    return (
      <PageShell className="game-page">
        <RoundHeader />
        <div className="game-page__content">
          {isSimulating ? <SimulatePhase /> : <ResultsPhase />}
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
      {(() => {
        // DEC-21: only the Operations role (or solo) may submit Decide.
        // Other teammates still see and edit the form so they can advise,
        // but the button is disabled with an explicit owner tooltip.
        const canSubmit = roleOwnsDecide(role);
        const ownerLabel = ownerOfDecide();
        const disabled =
          submitting || decisionSubmitted || !gameId || !canSubmit;
        const label = !canSubmit
          ? `Your ${ownerLabel} teammate submits this decision`
          : submitting
          ? "Submitting…"
          : decisionSubmitted
          ? "Submitted — waiting for other players…"
          : "Submit Decisions";
        return (
          <button
            className="btn btn--primary game-page__submit"
            onClick={handleSubmit}
            disabled={disabled}
            title={
              !canSubmit
                ? `Your ${ownerLabel} teammate submits this decision.`
                : undefined
            }
          >
            {label}
          </button>
        );
      })()}
    </PageShell>
  );
}
