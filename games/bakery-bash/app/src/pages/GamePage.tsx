import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  collection,
  doc,
  onSnapshot,
  type DocumentData,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import {
  useGame,
  useGameDispatch,
  useGameDraftSync,
} from "../contexts/GameContext";
import { PixelBakeryScene } from "../components/bakery-scene/PixelBakeryScene";
import { SceneErrorBoundary } from "../components/bakery-scene/SceneErrorBoundary";
import "../styles/pixel-scene.css";
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
import {
  PRODUCT_KEYS,
  PRODUCT_STATION,
  parseGamePhase,
  ownerOfDecide,
  roleOwnsDecide,
  roleOwnsPricing,
  totalSousChefs,
  type GameConfigParams,
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
    teamName,
    phase,
    currentRound,
    pendingDecision,
    decisionSubmitted,
    pricesSubmitted,
    role,
    teamRoleAssignments,
  } = useGame();
  const dispatch = useGameDispatch();
  const { markDraftAppliedFromRemote } = useGameDraftSync();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  // --- Listener: /games/{gameId}/players/{playerId} — budget + player state. ---
  // Cloud Functions write `budgetCurrent` and other player state onto the player
  // doc as they evolve. We mirror them into GameContext so the budget summary stays live.
  useEffect(() => {
    if (!gameId || !playerId) return;
    const playerRef = doc(db, "games", gameId, "players", playerId);
    const unsubscribe = onSnapshot(
      playerRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as DocumentData;
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
          dispatch({
            type: "SET_PRICES_SUBMITTED",
            payload: incomingPending.pricesSubmitted === true,
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
              chefDepartureNames: Array.isArray(lrr.chefDepartureNames)
                ? (lrr.chefDepartureNames as string[])
                : undefined,
              productBreakdown:
                lrr.productBreakdown && typeof lrr.productBreakdown === "object"
                  ? lrr.productBreakdown
                  : undefined,
              adWon: lrr.adWon ?? null,
              adPaid: typeof lrr.adPaid === "number" ? lrr.adPaid : undefined,
              // Barlava follow-up: chefBidPaid is written by the backend
              // simulation onto `lastRoundResult` but the FE was dropping
              // it on the floor here, so Results couldn't render the chef-
              // bid spend line.
              chefBidPaid:
                typeof lrr.chefBidPaid === "number" ? lrr.chefBidPaid : undefined,
              auctionResults: {
                adWon: lrr.adWon ?? null,
                chefWon:
                  typeof lrr.chefWon === "string"
                    ? lrr.chefWon
                    : lrr.chefWon ?? null,
              },
              staffCounts:
                lrr.staffCounts && typeof lrr.staffCounts === "object"
                  ? lrr.staffCounts
                  : undefined,
              dailyBreakdown: Array.isArray(lrr.dailyBreakdown)
                ? lrr.dailyBreakdown
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

  // --- Listener: /games/{gameId}/teams/{teamId}/state/pending — T2.2. ---
  // Per-team transient round state. `submitBids` / `submitDecision` write
  // here once instead of cascading the same content into every teammate's
  // player doc, so 3+ player teams no longer contend on each other's docs.
  // The submitter's own player doc still gets the same writes (handled by
  // the listener above) — this listener catches what OTHER teammates
  // submitted, gated by `updatedByUid !== playerId` to avoid double-
  // dispatching the submitter's own write through both listeners. Solo
  // players (no teamId) skip this entirely; their player doc is the only
  // source of truth.
  //
  // Only `decisionDraft` needs to flow into context — `pendingBids` is
  // never read by the FE (the AuctionPage tracks bids in local React
  // state and reads the public top-bids aggregate from `rounds/{roundId}`).
  useEffect(() => {
    if (!gameId || !teamId || !playerId) return;
    const teamPendingRef = doc(
      db,
      "games",
      gameId,
      "teams",
      teamId,
      "state",
      "pending",
    );
    const unsubscribe = onSnapshot(
      teamPendingRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as DocumentData;
        if (data.updatedByUid === playerId) return;
        const draft = data.decisionDraft;
        if (!draft || typeof draft !== "object") return;
        const incoming = draft as Record<string, unknown>;
        const update: {
          menu?: Partial<Record<ProductKey, boolean>>;
          quantities?: Partial<Record<ProductKey, number>>;
          sousChefAssignments?: Partial<Record<ProductKey, number>>;
          staffCounts?: Partial<StaffCounts>;
          productPrices?: Partial<Record<ProductKey, number>>;
          miscSpent?: number;
        } = {};
        if (incoming.menu && typeof incoming.menu === "object") {
          update.menu = incoming.menu as Partial<Record<ProductKey, boolean>>;
        }
        if (incoming.quantities && typeof incoming.quantities === "object") {
          update.quantities = incoming.quantities as Partial<Record<ProductKey, number>>;
        }
        if (
          incoming.sousChefAssignments
          && typeof incoming.sousChefAssignments === "object"
        ) {
          update.sousChefAssignments =
            incoming.sousChefAssignments as Partial<Record<ProductKey, number>>;
        }
        if (incoming.staffCounts && typeof incoming.staffCounts === "object") {
          update.staffCounts = incoming.staffCounts as Partial<StaffCounts>;
        }
        // T2.2 follow-up: `submitPrices` writes the team-shared price + menu
        // signals here too (productPrices, pricesSubmitted, optional menu
        // picks) so non-Finance teammates see Finance's submission without
        // us needing to cascade those writes onto every teammate's player
        // doc. Same hydration pattern as the player-doc listener above —
        // skip non-finite numbers defensively so a partial write can't
        // crater the form.
        if (
          incoming.productPrices
          && typeof incoming.productPrices === "object"
          && !Array.isArray(incoming.productPrices)
        ) {
          const rawPrices = incoming.productPrices as Record<string, unknown>;
          const hydratedPrices: Partial<Record<ProductKey, number>> = {};
          for (const key of PRODUCT_KEYS) {
            const v = rawPrices[key];
            if (typeof v === "number" && Number.isFinite(v)) {
              hydratedPrices[key] = v;
            }
          }
          if (Object.keys(hydratedPrices).length > 0) {
            update.productPrices = hydratedPrices;
          }
        }
        // K-03 (2026-04-29): mirror miscSpent from the team-shared draft
        // so a teammate's purchase tally appears on every other tab.
        // The reducer treats `miscSpent` as an absolute set (not delta) —
        // see UPDATE_PENDING_DECISION action type comment.
        if (
          typeof incoming.miscSpent === "number" &&
          Number.isFinite(incoming.miscSpent)
        ) {
          update.miscSpent = Math.max(0, incoming.miscSpent);
        }
        if (Object.keys(update).length > 0) {
          // Tell the auto-save effect (in GameContext) to skip its next
          // firing — local state is about to mirror the team doc, so a
          // re-emission would be a redundant write that can also clobber
          // a teammate's in-flight edits when their listener applies it.
          // See PR #166 review.
          markDraftAppliedFromRemote();
          dispatch({ type: "UPDATE_PENDING_DECISION", payload: update });
        }
        if (typeof incoming.submitted === "boolean") {
          dispatch({
            type: "SET_DECISION_SUBMITTED",
            payload: incoming.submitted === true,
          });
        }
        if (typeof incoming.pricesSubmitted === "boolean") {
          dispatch({
            type: "SET_PRICES_SUBMITTED",
            payload: incoming.pricesSubmitted === true,
          });
        }
      },
      (err) => {
        console.error("games/teams/state/pending listener error", {
          gameId,
          teamId,
          err,
        });
      },
    );
    return unsubscribe;
  }, [gameId, teamId, playerId, dispatch, markDraftAppliedFromRemote]);

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

  // FE-11 — read this round's ad winners for the banner on the decide screen.
  // Ad bidding now happens BEFORE decisions in the same round, so we read
  // `rounds/round_{N}.auctionResults.ads` (not the previous round's doc).
  // `hideWhenEmpty` on the banner hides it gracefully on round 1 before
  // any bids have been placed.
  useEffect(() => {
    if (!gameId || !currentRound) {
      setAdWinners(null);
      return;
    }
    const prevRoundRef = doc(db, "games", gameId, "rounds", `round_${currentRound}`);
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
        console.error("game current-round ad-winner listener error:", { gameId, currentRound, err });
      },
    );
    return unsubscribe;
  }, [gameId, currentRound, rosterByUid]);

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

  // K-10 / K-11 (2026-04-29) — single role-aware Decide submit. Replaces
  // the previous two-button "Submit Prices" + "Submit Decisions" pattern:
  //   • Finance / Solo: `submitPrices` carries prices + menu + quantities
  //     (M-17 widened the backend callable to accept quantities).
  //   • Operations / Solo / vacant-ops fallback: `submitDecision` carries
  //     staff + sous-chef + equipment.
  //   • Solo runs both, sequentially, so a single click finalizes the
  //     round end-to-end.
  // The "Update Prices" friction button is gone — once a role's responsi-
  // bility is committed it stays committed, matching every other submit
  // in the game (chef bids, ad bids).
  const handleSubmitDecide = useCallback(async () => {
    if (!gameId) {
      setSubmitError("Not connected to a game yet.");
      return;
    }
    if (basePhase !== "decide") {
      setSubmitError("Decisions can only be submitted during the decide phase.");
      return;
    }
    const ownsPricing = roleOwnsPricing(role, teamRoleAssignments);
    const ownsDecide = roleOwnsDecide(role, teamRoleAssignments);
    if (!ownsPricing && !ownsDecide) return;

    setSubmitError(null);
    setSubmitting(true);
    try {
      // Finance side first — Operations gates on `pricesSubmitted`, so for
      // a solo player running both sides, do prices before decision so the
      // server's wait-for-finance check passes by the time submitDecision
      // hits the validator.
      if (ownsPricing && !pricesSubmitted) {
        const submitPrices = httpsCallable<
          {
            gameId: string;
            productPrices: Record<ProductKey, number>;
            menu: Record<ProductKey, boolean>;
            quantities: Record<ProductKey, number>;
          },
          { submitted: boolean }
        >(functions, "submitPrices");
        await submitPrices({
          gameId,
          productPrices: pendingDecision.productPrices,
          menu: pendingDecision.menu,
          quantities: pendingDecision.quantities,
        });
        dispatch({ type: "SET_PRICES_SUBMITTED", payload: true });
      }

      if (ownsDecide && !decisionSubmitted) {
        // `miscSpent` is a UI-only running tally for the receipt — never
        // sent to the backend (server-authoritative budget owns the
        // ledger). `quantities` rides on submitPrices now (K-10).
        type SubmitPayload = { gameId: string } & Omit<
          PendingDecisionDraft,
          "miscSpent" | "quantities"
        >;
        const submitDecision = httpsCallable<
          SubmitPayload,
          SubmitDecisionResponse
        >(functions, "submitDecision");

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
          console.warn(
            "Derived sousChefAssignments sum (%d) ≠ sousChefCount (%d); falling back to croissant.",
            assignedSum,
            sousChefCount,
          );
          sanitizedAssignments.croissant =
            (sanitizedAssignments.croissant ?? 0) +
            (sousChefCount - assignedSum);
        }

        await submitDecision({
          gameId,
          menu: pendingDecision.menu,
          sousChefCount,
          sousChefAssignments:
            sanitizedAssignments as PendingDecisionDraft["sousChefAssignments"],
          staffCounts: pendingDecision.staffCounts,
          productPrices: pendingDecision.productPrices,
        });
        dispatch({ type: "SET_DECISION_SUBMITTED", payload: true });
      }
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
  }, [
    gameId,
    basePhase,
    role,
    teamRoleAssignments,
    pricesSubmitted,
    decisionSubmitted,
    pendingDecision,
    dispatch,
  ]);

  const isDecisionPhase = basePhase === "decide";
  const isSimulating = basePhase === "simulating";

  // FE-I12: the backend can sail through `simulating → results_ready` in
  // ~2 seconds when conditions are favourable, which means players never
  // see the (nicely animated) Simulate screen. Hold the SimulatePhase view
  // for a minimum wall-clock window after we first observe `simulating`,
  // even if the Firestore phase has already moved on. Acts as a one-way
  // latch — once we commit to showing the screen, we wait out the timer.
  //
  // Apr 25 V4: tightened from 20_000 → 4_000ms.
  // V9 (Apr 26): bumped to 10_000ms — playtesters reported the simulate
  // screen flashing by too quickly to read the bakery animation; 10s
  // gives the chefs/customers a few clear cycles before we cut to the
  // results screen.
  // K-09 (2026-04-29): bumped 10_000 → 20_000ms to align with Massaro's
  // M-15 backend bump on `phaseDurations.simulating` (default 25s in
  // `backend/functions/modules/config.js`). The latch stays comfortably
  // under the backend duration so the screen still cedes to results
  // rather than being yanked mid-animation.
  const SIMULATE_MIN_DISPLAY_MS = 20_000;
  const [simHoldUntilMs, setSimHoldUntilMs] = useState<number | null>(null);
  const [simHoldExpired, setSimHoldExpired] = useState(false);

  useEffect(() => {
    if (isSimulating && simHoldUntilMs === null) {
      const until = Date.now() + SIMULATE_MIN_DISPLAY_MS;
      setSimHoldUntilMs(until);
      setSimHoldExpired(false);
    }
  }, [isSimulating, simHoldUntilMs]);

  useEffect(() => {
    if (simHoldUntilMs === null) return;
    const remaining = simHoldUntilMs - Date.now();
    if (remaining <= 0) {
      setSimHoldExpired(true);
      return;
    }
    const t = setTimeout(() => setSimHoldExpired(true), remaining);
    return () => clearTimeout(t);
  }, [simHoldUntilMs]);

  // Reset the hold whenever we leave the simulate window so the next
  // round can latch fresh.
  useEffect(() => {
    if (!isSimulating && simHoldExpired) {
      setSimHoldUntilMs(null);
      setSimHoldExpired(false);
    }
  }, [isSimulating, simHoldExpired]);

  const showSimulate =
    isSimulating || (simHoldUntilMs !== null && !simHoldExpired);

  if (!isDecisionPhase) {
    return (
      <PageShell className="game-page">
        <RoundHeader />
        <div className="game-page__content">
          {showSimulate ? <SimulatePhase /> : <ResultsPhase />}
        </div>
      </PageShell>
    );
  }

  // K-10 / K-11 (2026-04-29) — single submit per role. Finance owns the
  // pricing+quantity submission, Operations owns staff+sous-chef, Solo
  // runs both. The submit button gates / labels reflect whichever side(s)
  // the current player still owes.
  const ownsPricing = roleOwnsPricing(role, teamRoleAssignments);
  const ownsDecide = roleOwnsDecide(role, teamRoleAssignments);
  const canSubmit = ownsPricing || ownsDecide;
  const ownerLabel = ownerOfDecide();
  // Operations-only (NOT solo, NOT finance-also) waits for Finance to
  // commit prices first — keeps the server's submit-order invariant
  // (`submitDecision` checks `pricesSubmitted` before accepting).
  const teamHasFinance = Object.values(teamRoleAssignments).includes("finance");
  const operationsWaitingForFinance =
    ownsDecide && !ownsPricing && teamHasFinance && !pricesSubmitted;
  const allSubmitted =
    (ownsPricing ? pricesSubmitted : true) &&
    (ownsDecide ? decisionSubmitted : true);
  const submitDisabled =
    submitting ||
    allSubmitted ||
    !gameId ||
    !canSubmit ||
    operationsWaitingForFinance;
  const submitLabel = !canSubmit
    ? `Your ${ownerLabel} teammate submits`
    : operationsWaitingForFinance
      ? "Waiting for Finance prices…"
      : submitting
        ? "Submitting…"
        : allSubmitted
          ? "✓ Submitted"
          : "Submit Decisions";

  return (
    <PageShell className="game-page game-page--wide">
      <RoundHeader />

      {/* FE-11 — this round's ad winners banner (from bid_ad which now runs
          before decide). Hidden automatically when no bids landed yet. */}
      {currentRound && (
        <AdWinnerBanner
          round={currentRound}
          winners={adWinners}
          hideWhenEmpty={true}
        />
      )}

      {/* V8 (Apr 25): pixel bakery preview moved ABOVE the choices so
          desktop players see their kitchen first, larger scale (1.5x)
          since this is desktop-only. Updates live as staffing changes. */}
      <section
        className="decide-phase__bakery-preview"
        aria-label="Live bakery preview"
      >
        <header className="decide-phase__bakery-preview-header">
          <span className="decide-phase__bakery-preview-eyebrow">Live Preview</span>
          <h3 className="decide-phase__bakery-preview-title">Your Bakery</h3>
        </header>
        <div className="decide-phase__bakery-preview-stage">
          <SceneErrorBoundary teamName={teamName ?? ""}>
            <PixelBakeryScene
              mode="decide"
              teamName={teamName ?? ""}
              staffCounts={{
                bakery: pendingDecision.staffCounts.bakerySousChefs,
                deli: pendingDecision.staffCounts.deliSousChefs,
                barista: pendingDecision.staffCounts.baristaSousChefs,
              }}
              customerCount={0}
              menu={Object.keys(pendingDecision.menu).filter(
                (k) => pendingDecision.menu[k as ProductKey],
              )}
            />
          </SceneErrorBoundary>
        </div>
      </section>

      {/* FE-9 — lock the menu + Hire tab once the player has submitted.
          V9 (Apr 26): the standalone "Total Cost This Round" row was
          duplicating the per-bucket totals already shown in the BakeryView
          and StaffTab. Players asked us to drop it; the new "Total
          Committed This Round" row inside BakeryView shows the bakery /
          staff split below. */}
      <div className="game-page__dashboard">
        <BakeryView readOnly={decisionSubmitted} />
        <GameSidebar readOnly={decisionSubmitted} />
      </div>
      {submitError && (
        <p className="game-page__submit-error" role="alert">
          {submitError}
        </p>
      )}

      {/* FE-17 — timer + live submission counter + role-gated submit. */}
      {/* K-11 (2026-04-29): collapsed to a single button. Finance / Operations
          / Solo all click the same control; `handleSubmitDecide` runs the
          right callable(s). The "Update Prices" friction button is gone. */}
      <SubmissionLock
        phase="decide"
        submitted={allSubmitted}
        hint={
          !canSubmit
            ? `Your ${ownerLabel} teammate submits this decision.`
            : operationsWaitingForFinance
              ? "Waiting for your Finance teammate to submit prices first."
              : undefined
        }
        action={
          <button
            className="btn btn--primary game-page__submit"
            onClick={handleSubmitDecide}
            disabled={submitDisabled}
            title={
              !canSubmit
                ? `Your ${ownerLabel} teammate submits this decision.`
                : undefined
            }
          >
            {submitLabel}
          </button>
        }
      />
    </PageShell>
  );
}
