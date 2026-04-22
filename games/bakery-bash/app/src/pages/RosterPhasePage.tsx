import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  doc,
  onSnapshot,
  type DocumentData,
} from "firebase/firestore";
import { httpsCallable, type FunctionsError } from "firebase/functions";
import { db, functions } from "../lib/firebase";
import { useGame } from "../contexts/GameContext";
import { useGamePhaseNav } from "../hooks/useGamePhaseNav";
import { PageShell } from "../components/ui/PageShell";
import { RoundHeader } from "../components/game/RoundHeader";
import { ChefCard } from "../components/game/ChefCard";
import { SubmissionLock } from "../components/game/SubmissionLock";
import {
  parseGamePhase,
  toChefCardInput,
  roleOwnsRoster,
  ownerOfRoster,
  type ChefPoolEntry,
} from "../types/game";
import { humanizeFunctionError } from "../lib/errors";

/**
 * FE-09 — `/game/roster` phase page.
 *
 * After the chef auction resolves, each player sees the chefs they won
 * (and already had) as a roster. If they ended up with more than the
 * `specialtyChefCap` (default 3), they must lay one off before they can
 * click Continue — the backend enforces the cap in
 * `continueFromRoster`, but we also gate the button client-side for
 * immediate feedback.
 *
 * Role-gated: only `operations` or `solo` can click Lay off / Continue
 * (matches backend `assertRoleAllowed` in `layoffChef` + `continueFromRoster`).
 * The design proposal says Finance owns this, but the shipped backend
 * enforces Operations; we follow the backend.
 */

/** Chef doc as stored on `players/{uid}.specialtyChefs`. Same shape as pool. */
type RosterChef = ChefPoolEntry;

interface LayoffTarget {
  id: string;
  name: string;
}

function coerceChef(raw: DocumentData): RosterChef | null {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id : null;
  const name = typeof raw.name === "string" ? raw.name : null;
  const nat = raw.nationality;
  const validNat =
    nat === "american" ||
    nat === "french" ||
    nat === "italian" ||
    nat === "japanese";
  const rawGen = raw.gender;
  const gen = rawGen === "male" || rawGen === "m" ? "m" : rawGen === "female" || rawGen === "f" ? "f" : null;
  const tier = raw.skillTier;
  const validTier =
    tier === "novel" || tier === "intermediate" || tier === "advanced";
  if (!id || !name || !validNat || !gen || !validTier) return null;
  return {
    id,
    name,
    nationality: nat,
    gender: gen,
    skillTier: tier,
    specialties: Array.isArray(raw.specialties) ? raw.specialties : [],
    minBidFloor: typeof raw.minBidFloor === "number" ? raw.minBidFloor : 0,
  };
}

const SPECIALTY_CAP = 3;

export function RosterPhasePage() {
  useGamePhaseNav();
  const { gameId, playerId, currentRound, phase, role } = useGame();
  const navigate = useNavigate();

  const [specialtyChefs, setSpecialtyChefs] = useState<RosterChef[]>([]);
  const [pendingRosterAction, setPendingRosterAction] = useState(false);
  const [rosterCompleted, setRosterCompleted] = useState(false);

  const [layoffTarget, setLayoffTarget] = useState<LayoffTarget | null>(null);
  const [submitting, setSubmitting] = useState<"layoff" | "continue" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  // Subscribe to this player's doc for their specialty roster.
  useEffect(() => {
    if (!gameId || !playerId) return;
    const playerRef = doc(db, "games", gameId, "players", playerId);
    const unsubscribe = onSnapshot(playerRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.data() as DocumentData;
      const raw = Array.isArray(data.specialtyChefs) ? data.specialtyChefs : [];
      setSpecialtyChefs(raw.map(coerceChef).filter((c): c is RosterChef => c !== null));
      setPendingRosterAction(data.pendingRosterAction === true);
      setRosterCompleted(data.rosterCompleted === true);
    });
    return unsubscribe;
  }, [gameId, playerId]);

  // Auto-route as phase changes. Roster → simulating/results_ready → /game.
  useEffect(() => {
    if (!phase) return;
    const parsed = parseGamePhase(phase, currentRound);
    if (parsed.base === "decide") navigate("/game/decide");
    else if (parsed.base === "email") navigate("/game/email");
    else if (parsed.base === "bid_ad" || parsed.base === "bid_chef")
      navigate("/auction");
    else if (parsed.base === "simulating" || parsed.base === "results_ready")
      navigate("/game");
    else if (parsed.base === "game_over") navigate("/game/conclusion");
  }, [phase, currentRound, navigate]);

  const canAct = roleOwnsRoster(role);
  const ownerLabel = ownerOfRoster();
  const overCap = specialtyChefs.length > SPECIALTY_CAP;
  const continueDisabled =
    overCap || submitting !== null || !canAct || rosterCompleted;

  const handleLayoffClick = (chefId: string) => {
    const target = specialtyChefs.find((c) => c.id === chefId);
    if (!target) return;
    setLayoffTarget({ id: target.id, name: target.name });
  };

  const handleLayoffConfirm = async () => {
    if (!layoffTarget || !gameId) return;
    setError(null);
    setSubmitting("layoff");
    try {
      const layoff = httpsCallable<
        { gameId: string; chefId: string },
        { success?: boolean }
      >(functions, "layoffChef");
      await layoff({ gameId, chefId: layoffTarget.id });
      setLayoffTarget(null);
    } catch (err) {
      setError(humanizeLayoffError(err));
    } finally {
      setSubmitting(null);
    }
  };

  const handleContinue = async () => {
    if (!gameId) return;
    setError(null);
    setSubmitting("continue");
    try {
      const cont = httpsCallable<
        { gameId: string },
        { rosterCompleted?: boolean }
      >(functions, "continueFromRoster");
      await cont({ gameId });
      // Phase transition takes care of navigation.
    } catch (err) {
      setError(humanizeFunctionError(err, "Could not continue. Try again."));
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <PageShell className="roster-phase-page">
      <RoundHeader />

      <header className="roster-phase-page__header">
        <h1 className="roster-phase-page__title">Your Kitchen Roster</h1>
        <p className="roster-phase-page__hint">
          Review who's in your kitchen for the rest of this round. Keep up to{" "}
          <strong>{SPECIALTY_CAP}</strong> specialty chefs — lay one off if you
          ended up with more.
        </p>
      </header>

      {!canAct && (
        <p className="roster-phase-page__role-gate">
          Only your {ownerLabel} teammate can lay off chefs or continue.
        </p>
      )}

      {overCap && (
        <p className="roster-phase-page__overflow-warning" role="alert">
          ⚠ You picked up an extra chef — lay one off to continue.
        </p>
      )}

      <div className="roster-phase-page__slots">
        <div className="roster-phase-page__slot roster-phase-page__slot--base">
          <div className="roster-phase-page__slot-label">Head Chef</div>
          <div className="roster-phase-page__base-card">
            <div className="roster-phase-page__base-portrait">👨‍🍳</div>
            <div className="roster-phase-page__base-name">You</div>
            <div className="roster-phase-page__base-hint">
              Always in your kitchen.
            </div>
          </div>
        </div>

        {Array.from({ length: SPECIALTY_CAP }, (_, i) => {
          const chef = specialtyChefs[i];
          return (
            <div
              key={`slot-${i}`}
              className="roster-phase-page__slot roster-phase-page__slot--specialty"
            >
              <div className="roster-phase-page__slot-label">
                Specialty Chef {i + 1}
              </div>
              {chef ? (
                <ChefCard
                  chef={toChefCardInput(chef)}
                  mode="roster"
                  canLayoff={canAct}
                  onLayoff={handleLayoffClick}
                />
              ) : (
                <div className="roster-phase-page__empty">Empty slot</div>
              )}
            </div>
          );
        })}

        {overCap &&
          specialtyChefs.slice(SPECIALTY_CAP).map((chef) => (
            <div
              key={`overflow-${chef.id}`}
              className="roster-phase-page__slot roster-phase-page__slot--overflow"
            >
              <div className="roster-phase-page__slot-label">
                Extra Chef (must lay off)
              </div>
              <ChefCard
                chef={toChefCardInput(chef)}
                mode="roster"
                canLayoff={canAct}
                onLayoff={handleLayoffClick}
              />
            </div>
          ))}
      </div>

      {error && (
        <p className="roster-phase-page__error" role="alert">
          {error}
        </p>
      )}

      {pendingRosterAction && !overCap && (
        <p className="roster-phase-page__info">
          Backend flagged a pending roster action — review your chefs above.
        </p>
      )}

      <SubmissionLock
        phase="roster"
        submitted={rosterCompleted}
        hint={
          canAct
            ? overCap
              ? "Lay off a chef to unlock Continue."
              : undefined
            : "Waiting on your Operations teammate."
        }
        action={
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleContinue}
            disabled={continueDisabled}
          >
            {submitting === "continue"
              ? "Continuing…"
              : rosterCompleted
                ? "✓ Submitted"
                : "Continue"}
          </button>
        }
      />

      {layoffTarget && (
        <div
          className="roster-phase-page__modal"
          role="dialog"
          aria-modal="true"
        >
          <div
            className="roster-phase-page__modal-backdrop"
            aria-hidden="true"
          />
          <div className="roster-phase-page__modal-card">
            <h3 className="roster-phase-page__modal-title">Lay off a chef?</h3>
            <p className="roster-phase-page__modal-body">
              <strong>{layoffTarget.name}</strong> will leave your kitchen and
              rejoin the auction pool for the next round. This can't be undone.
            </p>
            <div className="roster-phase-page__modal-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setLayoffTarget(null)}
                disabled={submitting === "layoff"}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={handleLayoffConfirm}
                disabled={submitting === "layoff"}
              >
                {submitting === "layoff" ? "Laying off…" : "Lay off"}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}

function humanizeLayoffError(err: unknown): string {
  const fnErr = err as FunctionsError | undefined;
  const code = (fnErr?.code || "").split("/").pop();
  if (code === "failed-precondition") {
    return "You can only lay off chefs during the roster phase.";
  }
  if (code === "not-found") {
    return "That chef isn't on your roster anymore. Refresh.";
  }
  return humanizeFunctionError(err, "Could not lay off chef. Try again.");
}
