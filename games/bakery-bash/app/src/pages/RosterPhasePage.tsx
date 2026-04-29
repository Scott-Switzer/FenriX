import { useEffect, useState } from "react";
import {
  collection,
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
import {
  ChefWinnerBanner,
  type ChefWinnerEntry,
} from "../components/game/ChefWinnerBanner";
import { SubmissionLock } from "../components/game/SubmissionLock";
import {
  toChefCardInput,
  roleOwnsRoster,
  ownerOfRoster,
  type ChefGender,
  type ChefNationality,
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

/**
 * S-05 — laid-off chef as it appears in the round's `chefReturnPool`
 * subcollection. Same shape as a roster chef plus return-tracking
 * metadata. We render these in the "Lay offs" panel and offer Re-hire.
 */
interface LaidOffChef extends RosterChef {
  returnedByPlayerId?: string | null;
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
    tier === "base" || tier === "novel" || tier === "intermediate" || tier === "advanced";
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

export function RosterPhasePage() {
  useGamePhaseNav();
  const { gameId, playerId, teamId, currentRound, role, teamRoleAssignments, config } =
    useGame();
  const specialtyChefCap = config?.specialtyChefCap ?? 3;

  const [specialtyChefs, setSpecialtyChefs] = useState<RosterChef[]>([]);
  const [pendingRosterAction, setPendingRosterAction] = useState(false);
  const [rosterCompleted, setRosterCompleted] = useState(false);
  // S-05 (2026-04-29) — laid-off chefs for the current round. Subscribed
  // below from `games/{gameId}/rounds/round_{N}/chefReturnPool`. Renders
  // in the "Lay offs" panel with a Re-hire button per chef.
  const [laidOffChefs, setLaidOffChefs] = useState<LaidOffChef[]>([]);
  // Track which chef-id is currently flying through layoff/rehire so we
  // can disable the relevant button without locking the whole panel.
  const [pendingChefId, setPendingChefId] = useState<string | null>(null);
  // A24-I05 — chef wins just resolved for this round. Subscribed from
  // `games/{gameId}/rounds/round_{N}.chefAuctionResults[{teamKey}]`.
  const [chefWins, setChefWins] = useState<ChefWinnerEntry[]>([]);
  // V4 fix (Apr 25): the chef auction is resolved as a *post-transaction*
  // side-effect inside `advanceGamePhase(roster)`, so when the FE first
  // lands on `/game/roster` the round doc may not yet have
  // `chefAuctionResults` written. Track whether the resolver has run
  // (`chefAuctionResolvedAt` timestamp on the round doc) to distinguish
  // "still resolving" from "you didn't win anything" — the latter was
  // showing for a few seconds at the top of every roster phase and read
  // as "we won but it says we didn't".
  const [chefAuctionResolved, setChefAuctionResolved] = useState(false);
  const auctionResultKey = teamId || playerId || null;

  useEffect(() => {
    if (!gameId || !currentRound || !auctionResultKey) {
      setChefWins([]);
      setChefAuctionResolved(false);
      return;
    }
    const roundRef = doc(
      db,
      "games",
      gameId,
      "rounds",
      `round_${currentRound}`,
    );
    const unsubscribe = onSnapshot(
      roundRef,
      (snap) => {
        if (!snap.exists()) {
          setChefWins([]);
          setChefAuctionResolved(false);
          return;
        }
        const data = snap.data() as DocumentData;
        // The backend writes `chefAuctionResolvedAt` (a server timestamp)
        // alongside `chefAuctionResults` in the same `roundRef.set()`,
        // so its presence is the canonical "auction is done" signal.
        setChefAuctionResolved(Boolean(data.chefAuctionResolvedAt));
        const results =
          (data.chefAuctionResults ?? null) as DocumentData | null;
        const entry = results?.[auctionResultKey] as DocumentData | undefined;
        if (!entry || !Array.isArray(entry.chefs)) {
          setChefWins([]);
          return;
        }
        const totalPaid = Number(entry.totalPaid) || 0;
        // Per-chef price breakdown isn't stored on the round doc, so we
        // attribute `totalPaid` across the chefs proportionally to each
        // chef's min-bid-floor. Close enough for "you paid ~$X for this
        // chef" visibility; players can cross-reference their finance
        // teammate's records for the exact split.
        const floors = entry.chefs.map((c: DocumentData) =>
          typeof c.minBidFloor === "number" && c.minBidFloor > 0
            ? c.minBidFloor
            : 1,
        );
        const floorSum = floors.reduce((s: number, f: number) => s + f, 0) || 1;
        const wins: ChefWinnerEntry[] = entry.chefs
          .map((c: DocumentData, i: number): ChefWinnerEntry | null => {
            const nat = c.nationality;
            const validNat: ChefNationality | null =
              nat === "american" ||
              nat === "french" ||
              nat === "italian" ||
              nat === "japanese"
                ? nat
                : null;
            const rawGen = c.gender;
            const gender: ChefGender | null =
              rawGen === "male" || rawGen === "m"
                ? "m"
                : rawGen === "female" || rawGen === "f"
                ? "f"
                : null;
            const id = typeof c.id === "string" ? c.id : null;
            const name = typeof c.name === "string" ? c.name : null;
            if (!id || !name || !validNat || !gender) return null;
            const share = floors[i] / floorSum;
            const skillTier =
              c.skillTier === "novel" ||
              c.skillTier === "intermediate" ||
              c.skillTier === "advanced" ||
              c.skillTier === "base"
                ? (c.skillTier as ChefWinnerEntry["skillTier"])
                : undefined;
            return {
              chefId: id,
              name,
              nationality: validNat,
              gender,
              amount: Math.round(totalPaid * share),
              skillTier,
            };
          })
          .filter((c: ChefWinnerEntry | null): c is ChefWinnerEntry => c !== null);
        setChefWins(wins);
      },
      (err) => {
        console.error("roster chef-winner listener error:", {
          gameId,
          currentRound,
          err,
        });
      },
    );
    return unsubscribe;
  }, [gameId, currentRound, auctionResultKey]);

  const [submitting, setSubmitting] = useState<"continue" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to this player's doc for their specialty roster.
  useEffect(() => {
    if (!gameId || !playerId) return;
    const playerRef = doc(db, "games", gameId, "players", playerId);
    const unsubscribe = onSnapshot(
      playerRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as DocumentData;
        const raw = Array.isArray(data.specialtyChefs) ? data.specialtyChefs : [];
        setSpecialtyChefs(raw.map(coerceChef).filter((c): c is RosterChef => c !== null));
        setPendingRosterAction(data.pendingRosterAction === true);
        setRosterCompleted(data.rosterCompleted === true);
      },
      (err) => {
        console.error("roster player-doc listener error:", { gameId, playerId, err });
      },
    );
    return unsubscribe;
  }, [gameId, playerId]);

  // S-05 — subscribe to the chefReturnPool for the CURRENT round so we
  // can render the Lay-offs panel + Re-hire buttons. Backend writes
  // `returnedByPlayerId` on every layoff (see `layoffChef` /
  // `layoffChefs` in index.js), but we don't filter by it: any teammate
  // can rehire (Operations / Solo authorize the call), and showing the
  // full panel keeps the team aware of every drop, not just yours.
  useEffect(() => {
    if (!gameId || !currentRound) {
      setLaidOffChefs([]);
      return;
    }
    const poolRef = collection(
      db,
      "games",
      gameId,
      "rounds",
      `round_${currentRound}`,
      "chefReturnPool",
    );
    const unsubscribe = onSnapshot(
      poolRef,
      (snap) => {
        const next: LaidOffChef[] = [];
        snap.docs.forEach((d) => {
          const c = coerceChef(d.data());
          if (!c) return;
          // Carry returnedByPlayerId through for tooltip display.
          const data = d.data() as DocumentData;
          next.push({
            ...c,
            returnedByPlayerId:
              typeof data.returnedByPlayerId === "string"
                ? data.returnedByPlayerId
                : null,
          });
        });
        setLaidOffChefs(next);
      },
      (err) => {
        console.debug("chefReturnPool listener error:", err);
        setLaidOffChefs([]);
      },
    );
    return unsubscribe;
  }, [gameId, currentRound]);

  // V4 fix (Apr 25): the local nav effect that lived here used to race
  // against `useGamePhaseNav` and `GamePhaseListener` — and pointed
  // `decide` at `/game/decide` while the others used `/game`, which
  // caused a quick double-navigate on every roster→decide transition.
  // The shared `useGamePhaseNav` hook above already covers every base
  // phase, so the local copy is gone.

  // FE-I15: any teammate can act when no one on the team holds
  // operations (2-player team, cleared role, etc.).
  const canAct = roleOwnsRoster(role, teamRoleAssignments);
  const ownerLabel = ownerOfRoster();
  const overCap = specialtyChefs.length > specialtyChefCap;
  const rosterFull = specialtyChefs.length >= specialtyChefCap;
  const continueDisabled =
    overCap || submitting !== null || !canAct || rosterCompleted;

  // S-05 — instant lay-off (no confirm modal). Click chef → fires
  // `layoffChef` immediately. Failure surfaces via the `error` chip.
  const handleLayoffClick = async (chefId: string) => {
    if (!gameId || !canAct || pendingChefId) return;
    setError(null);
    setPendingChefId(chefId);
    try {
      const layoff = httpsCallable<
        { gameId: string; chefId: string },
        { success?: boolean }
      >(functions, "layoffChef");
      await layoff({ gameId, chefId });
    } catch (err) {
      setError(humanizeLayoffError(err));
    } finally {
      setPendingChefId(null);
    }
  };

  // S-05 — re-hire calls the new `rehireChef` callable. Backend rejects
  // when the roster is at cap, so we ALSO gate the button up-front to
  // avoid an unnecessary round-trip.
  const handleRehireClick = async (chefId: string) => {
    if (!gameId || !canAct || pendingChefId || rosterFull) return;
    setError(null);
    setPendingChefId(chefId);
    try {
      const rehire = httpsCallable<
        { gameId: string; chefId: string },
        { ok?: boolean; rehired?: boolean }
      >(functions, "rehireChef");
      await rehire({ gameId, chefId });
    } catch (err) {
      setError(humanizeRehireError(err));
    } finally {
      setPendingChefId(null);
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

      {/* A24-I05 — show who got hired in the chef auction that just resolved
          so the team can orient themselves before the Lay-off decision. */}
      <ChefWinnerBanner
        round={currentRound}
        winners={chefWins}
        resolved={chefAuctionResolved}
      />

      <header className="roster-phase-page__header">
        <h1 className="roster-phase-page__title">Your Kitchen Roster</h1>
        <p className="roster-phase-page__hint">
          Review who's in your kitchen for the rest of this round. Keep up to{" "}
          <strong>{specialtyChefCap}</strong> specialty chefs — lay one off if you
          ended up with more.
        </p>
      </header>

      {/* V5 (Apr 25): big "locked in" confirmation banner so players see they
          submitted before they click Continue a second time. The smaller pill
          inside SubmissionLock is still rendered below as the per-phase
          consistency, but this top banner is what students notice. */}
      {rosterCompleted && (
        <div
          className="roster-phase-page__submitted-banner"
          role="status"
          aria-live="polite"
        >
          <span className="roster-phase-page__submitted-banner-icon" aria-hidden="true">✓</span>
          <span className="roster-phase-page__submitted-banner-text">
            Roster locked in! Waiting for the rest of the class — your team is
            ready for round {currentRound}'s decisions.
          </span>
        </div>
      )}

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
          <div className="roster-phase-page__slot-label">Basic Chef</div>
          <div className="roster-phase-page__base-card">
            <div className="roster-phase-page__base-portrait">👨‍🍳</div>
            <div className="roster-phase-page__base-name">You</div>
            <div className="roster-phase-page__base-hint">
              Your free chef. Produces 30 units per round.
            </div>
          </div>
        </div>

        {Array.from({ length: specialtyChefCap }, (_, i) => {
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
          specialtyChefs.slice(specialtyChefCap).map((chef) => (
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

      {/* S-05 — "Lay offs" panel. Shows chefs the team has dropped THIS
          round; each has a Re-hire button (gated to canAct + roster has
          space). Once Continue fires, the chefs commit to the return
          pool and can't be rehired in future rounds. */}
      {laidOffChefs.length > 0 && (
        <section
          className="roster-phase-page__layoffs"
          aria-label="Laid-off chefs this round"
        >
          <h3 className="roster-phase-page__layoffs-title">
            Lay-offs this round
          </h3>
          <p className="roster-phase-page__layoffs-hint">
            {canAct
              ? rosterFull
                ? "Roster is full — lay off another chef first to re-hire."
                : "Click Re-hire to bring a chef back. Stays in the lay-off pool until you click Continue."
              : "Your Operations teammate can re-hire any of these chefs before clicking Continue."}
          </p>
          <ul className="roster-phase-page__layoff-list">
            {laidOffChefs.map((chef) => {
              const pendingThis = pendingChefId === chef.id;
              const rehireDisabled =
                !canAct || pendingChefId !== null || rosterFull;
              return (
                <li
                  key={chef.id}
                  className="roster-phase-page__layoff-row"
                >
                  <div className="roster-phase-page__layoff-card">
                    <ChefCard
                      chef={toChefCardInput(chef)}
                      mode="roster"
                      canLayoff={false}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn--success btn--small roster-phase-page__rehire-btn"
                    onClick={() => handleRehireClick(chef.id)}
                    disabled={rehireDisabled}
                    title={
                      !canAct
                        ? "Only the Operations teammate can re-hire."
                        : rosterFull
                          ? "Lay off another chef first."
                          : `Bring ${chef.name} back to your kitchen.`
                    }
                  >
                    {pendingThis ? "Re-hiring…" : "Re-hire"}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

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
                ? "✓ Ready — locked in for next round"
                : "Continue"}
          </button>
        }
      />

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

function humanizeRehireError(err: unknown): string {
  const fnErr = err as FunctionsError | undefined;
  const code = (fnErr?.code || "").split("/").pop();
  const message = fnErr?.message || "";
  if (code === "failed-precondition" && message.toLowerCase().includes("full")) {
    return "Your roster is full — lay off another chef before re-hiring.";
  }
  if (code === "failed-precondition") {
    return "Re-hire is only available during the roster phase, and only for chefs you laid off this round.";
  }
  return humanizeFunctionError(err, "Could not re-hire chef. Try again.");
}
