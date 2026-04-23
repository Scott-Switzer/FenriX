import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  collection,
  doc,
  onSnapshot,
  type DocumentData,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import { RoundHeader } from "../components/game/RoundHeader";
import { BakeryView } from "../components/game/BakeryView";
import { GameSidebar } from "../components/game/GameSidebar";
import {
  AdWinnerBanner,
  type AdWinnerEntry,
} from "../components/game/AdWinnerBanner";
import { SubmissionLock } from "../components/game/SubmissionLock";
import { PageShell } from "../components/ui/PageShell";
import { SimulatePhase } from "./phases/SimulatePhase";
import { ResultsPhase } from "./phases/ResultsPhase";
import { db, functions } from "../lib/firebase";
import { humanizeFunctionError } from "../lib/errors";
import { computeDecisionCost, formatMoney } from "../lib/cost";
import {
  PRODUCT_KEYS,
  PRODUCT_STATION,
  parseGamePhase,
  ownerOfDecide,
  roleOwnsDecide,
  roleOwnsPricing,
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
    teamId,
    phase,
    currentRound,
    pendingDecision,
    decisionSubmitted,
    pricesSubmitted,
    role,
    config,
  } = useGame();
  // BE-I03: auction result docs are keyed by team slug; fall back to the
  // player uid for solo teams, whose `team.key` on the backend is the uid.
  const auctionResultKey = teamId || playerId;
  const dispatch = useGameDispatch();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittingPrices, setSubmittingPrices] = useState(false);
  const [wonAuctionCosts, setWonAuctionCosts] = useState({ ad: 0, chef: 0 });

  // FE-11 — previous round's ad winners, rendered at the top of Decide.
  // The aggregate `rounds/round_{N}` doc writes
  // `auctionResults.ads.{TV|Billboard|Radio|Newspaper}.{winnerId, winningBid}`
  // (see firestore-schema.js). We resolve each `winnerId` to a bakery name
  // via the public roster subcollection so the banner shows "Bakery — $X"
  // rather than a raw uid. Rendering falls back to the empty state when
  // any part of the chain is missing.
  const [adWinners, setAdWinners] = useState<
    Partial<Record<AdWinnerEntry["adType"], AdWinnerEntry>> | null
  >(null);
  const [rosterByUid, setRosterByUid] = useState<
    Record<string, { displayName?: string; bakeryName?: string }>
  >({});

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

        // POST-01: hydrate `pendingDecision.productPrices` so Finance sees
        // their last submitted prices (backend carry-over) on round 2+ instead
        // of the catalog defaults. `submitPrices` writes via dot-path, so the
        // field is present on the player doc across rounds.
        const pending = data.pendingDecision;
        if (pending && typeof pending === "object") {
          const incomingPending = pending as Record<string, unknown>;
          const update: {
            menu?: Partial<Record<ProductKey, boolean>>;
            quantities?: Partial<Record<ProductKey, number>>;
            staffCounts?: Partial<StaffCounts>;
            maintenanceTasks?: MaintenanceTask[];
            productPrices?: Partial<Record<ProductKey, number>>;
          } = {};

          if (incomingPending.menu && typeof incomingPending.menu === "object") {
            update.menu = incomingPending.menu as Partial<Record<ProductKey, boolean>>;
          }
          if (incomingPending.quantities && typeof incomingPending.quantities === "object") {
            update.quantities = incomingPending.quantities as Partial<Record<ProductKey, number>>;
          }
          if (incomingPending.staffCounts && typeof incomingPending.staffCounts === "object") {
            update.staffCounts = incomingPending.staffCounts as Partial<StaffCounts>;
          }
          if (Array.isArray(incomingPending.maintenanceTasks)) {
            update.maintenanceTasks = incomingPending.maintenanceTasks as MaintenanceTask[];
          }

          if (incomingPending.productPrices && typeof incomingPending.productPrices === "object") {
            const incoming = incomingPending.productPrices as Record<string, unknown>;
            const hydratedPrices: Partial<Record<ProductKey, number>> = {};
            for (const key of PRODUCT_KEYS) {
              const v = incoming[key];
              if (typeof v === "number" && Number.isFinite(v)) {
                hydratedPrices[key] = v;
              }
            }
            if (Object.keys(hydratedPrices).length > 0) {
              update.productPrices = hydratedPrices;
            }
          }

          if (Object.keys(update).length > 0) {
            dispatch({
              type: "UPDATE_PENDING_DECISION",
              payload: update,
            });
          }

          dispatch({
            type: "SET_DECISION_SUBMITTED",
            payload: incomingPending.submitted === true,
          });
        }

        // lastRoundResult → dispatch ADD_RESULT so ResultsPhase + the CSV
        // download pick it up. Backend writes this on the player doc after
        // each round's simulation (`games/{gameId}/players/{uid}.lastRoundResult`).
        const lrr = data.lastRoundResult;
        if (lrr && typeof lrr === "object" && typeof lrr.round === "number") {
          // Revenue: prefer revenueNet, fall back to revenueGross, then legacy
          // `revenue`. Backend writes the first two; old docs used the third.
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
                    : lrr.chefWon ?? null,
              },
              maintenanceBars:
                lrr.maintenanceBars && typeof lrr.maintenanceBars === "object"
                  ? lrr.maintenanceBars
                  : undefined,
              staffCounts:
                lrr.staffCounts && typeof lrr.staffCounts === "object"
                  ? lrr.staffCounts
                  : undefined,
            },
          });
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

  // Subscribe to the roster so we can map `winnerId` → bakeryName/display.
  // Rules allow everyone to read the roster subcollection, so this works
  // without professor custom claims.
  useEffect(() => {
    if (!gameId) return;
    const rosterRef = collection(db, "games", gameId, "roster");
    const unsubscribe = onSnapshot(
      rosterRef,
      (snap) => {
        const map: Record<
          string,
          { displayName?: string; bakeryName?: string }
        > = {};
        snap.docs.forEach((d) => {
          const data = d.data() as DocumentData;
          map[d.id] = {
            displayName:
              typeof data.displayName === "string" ? data.displayName : undefined,
            bakeryName:
              typeof data.bakeryName === "string" ? data.bakeryName : undefined,
          };
        });
        setRosterByUid(map);
      },
      (err) => {
        console.error("game roster listener error:", { gameId, err });
      },
    );
    return unsubscribe;
  }, [gameId]);

  // FE-11 — read last round's ad winners for the banner (only shown on
  // decide after round 1). Parses `auctionResults.ads.{adType}` out of
  // the aggregate `rounds/round_{N-1}` doc (firestore-schema.js). The
  // `winnerId` is resolved against the roster-derived name map above.
  useEffect(() => {
    if (!gameId || !currentRound || currentRound <= 1) {
      setAdWinners(null);
      return;
    }
    const prevRound = currentRound - 1;
    const prevRoundRef = doc(db, "games", gameId, "rounds", `round_${prevRound}`);
    const unsubscribe = onSnapshot(
      prevRoundRef,
      (snap) => {
        if (!snap.exists()) {
          setAdWinners(null);
          return;
        }
        const data = snap.data() as DocumentData;
        const auction = data.auctionResults as DocumentData | undefined;
        const adsRaw = (auction?.ads ?? null) as DocumentData | null;
        if (!adsRaw || typeof adsRaw !== "object") {
          setAdWinners(null);
          return;
        }
        const out: Partial<Record<AdWinnerEntry["adType"], AdWinnerEntry>> = {};
        (["TV", "Billboard", "Radio", "Newspaper"] as const).forEach((t) => {
          const entry = adsRaw[t];
          if (!entry || typeof entry !== "object") return;
          const winnerId =
            typeof entry.winnerId === "string" ? entry.winnerId : null;
          const winningBid =
            typeof entry.winningBid === "number" ? entry.winningBid : undefined;
          if (!winnerId || !winningBid) return; // no bids landed for this surface
          out[t] = {
            adType: t,
            amount: winningBid,
            bakeryName: rosterByUid[winnerId]?.bakeryName,
            displayName: rosterByUid[winnerId]?.displayName,
          };
        });
        setAdWinners(Object.keys(out).length > 0 ? out : null);
      },
      (err) => {
        console.error("game prev-round listener error:", { gameId, prevRound, err });
      },
    );
    return unsubscribe;
  }, [gameId, currentRound, rosterByUid]);

  useEffect(() => {
    if (!gameId || !auctionResultKey || !currentRound) {
      setWonAuctionCosts({ ad: 0, chef: 0 });
      return;
    }
    const roundRef = doc(db, "games", gameId, "rounds", `round_${currentRound}`);
    const unsubscribe = onSnapshot(
      roundRef,
      (snap) => {
        if (!snap.exists()) {
          setWonAuctionCosts({ ad: 0, chef: 0 });
          return;
        }
        const data = snap.data() as DocumentData;
        const adEntry = (data.adAuctionResults?.[auctionResultKey] ?? null) as DocumentData | null;
        const ad =
          adEntry && typeof adEntry.totalPaid === "number"
            ? adEntry.totalPaid
            : 0;
        const chefEntry = (data.chefAuctionResults?.[auctionResultKey] ?? null) as DocumentData | null;
        const chef =
          chefEntry && typeof chefEntry.totalPaid === "number"
            ? chefEntry.totalPaid
            : 0;
        setWonAuctionCosts({ ad, chef });
      },
      () => {
        setWonAuctionCosts({ ad: 0, chef: 0 });
      },
    );
    return unsubscribe;
  }, [gameId, auctionResultKey, currentRound]);

  // Redirect into the dedicated phase page when backend says so. This is
  // phase-driven (not a manual navigation after submit).
  useEffect(() => {
    if (!gameId) return;
    if (basePhase === "bid_ad" || basePhase === "bid_chef") {
      navigate("/auction");
    } else if (basePhase === "email") {
      navigate("/game/email");
    } else if (basePhase === "roster") {
      navigate("/game/roster");
    } else if (basePhase === "game_over") {
      navigate("/game/conclusion");
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
        productPrices: pendingDecision.productPrices,
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

  const handleSubmitPrices = useCallback(async () => {
    if (!gameId) {
      setSubmitError("Not connected to a game yet.");
      return;
    }
    if (basePhase !== "decide") {
      setSubmitError("Prices can only be submitted during the decide phase.");
      return;
    }
    setSubmitError(null);
    setSubmittingPrices(true);
    try {
      const callable = httpsCallable<
        { gameId: string; productPrices: Record<ProductKey, number> },
        { submitted: boolean }
      >(functions, "submitPrices");
      await callable({ gameId, productPrices: pendingDecision.productPrices });
      dispatch({ type: "SET_PRICES_SUBMITTED", payload: true });
    } catch (err) {
      setSubmitError(
        humanizeFunctionError(err, "Could not submit prices. Please try again."),
      );
    } finally {
      setSubmittingPrices(false);
    }
  }, [gameId, basePhase, pendingDecision.productPrices, dispatch]);

  const isDecisionPhase = basePhase === "decide";
  const isSimulating = basePhase === "simulating";
  const decisionCost = useMemo(
    () => computeDecisionCost(pendingDecision, config, wonAuctionCosts),
    [pendingDecision, config, wonAuctionCosts],
  );

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

  // DEC-21: only the Operations role (or solo) may submit Decide.
  const canSubmit = roleOwnsDecide(role);
  const ownerLabel = ownerOfDecide();
  const submitDisabled =
    submitting || decisionSubmitted || !gameId || !canSubmit;
  const submitLabel = !canSubmit
    ? `Your ${ownerLabel} teammate submits`
    : submitting
      ? "Submitting…"
      : decisionSubmitted
        ? "✓ Submitted"
        : "Submit Decisions";

  return (
    <PageShell className="game-page game-page--wide">
      <RoundHeader />

      {/* FE-11 — previous-round ad winners banner (round 2+). */}
      {currentRound && currentRound > 1 && (
        <AdWinnerBanner
          round={currentRound - 1}
          winners={adWinners}
          hideWhenEmpty={false}
        />
      )}

      {/* FE-9 — lock the menu + Hire tab once the player has submitted.
          We intentionally *don't* tie this to `!isDecisionPhase` alone
          because GamePage itself swaps to the results view as soon as
          `basePhase` leaves "decide"; within this branch only the
          `decisionSubmitted` flag can flip inputs to read-only. */}
      <div className="game-page__dashboard">
        <BakeryView readOnly={decisionSubmitted} />
        <GameSidebar readOnly={decisionSubmitted} />
      </div>
      <section className="game-page__round-cost" aria-label="Total cost this round">
        <div className="game-page__round-cost-label">Total Cost This Round</div>
        <div className="game-page__round-cost-total">
          {formatMoney(decisionCost.total)}
        </div>
        <div className="game-page__round-cost-breakdown">
          <span>Staff {formatMoney(decisionCost.staff)}</span>
          <span>Products {formatMoney(decisionCost.product)}</span>
          <span>Ads {formatMoney(decisionCost.ad)}</span>
          <span>Chef {formatMoney(decisionCost.chef)}</span>
        </div>
      </section>
      {submitError && (
        <p className="game-page__submit-error" role="alert">
          {submitError}
        </p>
      )}

      {/* FE-17 — timer + live submission counter + role-gated submit. */}
      <SubmissionLock
        phase="decide"
        submitted={decisionSubmitted}
        hint={
          !canSubmit
            ? `Your ${ownerLabel} teammate submits this decision.`
            : undefined
        }
        action={
          <>
            {roleOwnsPricing(role) && (
              <button
                className="btn btn--secondary game-page__submit"
                type="button"
                onClick={handleSubmitPrices}
                disabled={submittingPrices || !gameId}
              >
                {submittingPrices
                  ? "Submitting…"
                  : pricesSubmitted
                    ? "✓ Update Prices"
                    : "Submit Prices"}
              </button>
            )}
            <button
              className="btn btn--primary game-page__submit"
              onClick={handleSubmit}
              disabled={submitDisabled}
              title={
                !canSubmit
                  ? `Your ${ownerLabel} teammate submits this decision.`
                  : undefined
              }
            >
              {submitLabel}
            </button>
          </>
        }
      />
    </PageShell>
  );
}
