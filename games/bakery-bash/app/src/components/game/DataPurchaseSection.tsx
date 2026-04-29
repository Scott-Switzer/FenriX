import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { useGame, useGameDispatch } from "../../contexts/GameContext";
import { functions } from "../../lib/firebase";
import type { AcquiredCsv } from "../../types/game";

/**
 * Data purchases (competitor intel + Tier 1/2 chef CSVs).
 *
 * B-05 (2026-04-29): lifted out of `GameSidebar` and into the
 * `ResultsPhase`. Two design changes from the prior version:
 *
 *  1. **Current-round only.** The intel button buys data for
 *     `currentRound` (the round whose results you're looking at) — no
 *     historical backfill. The previous behavior in GameSidebar bought
 *     `currentRound - 1` because it ran during DECIDE; on Results, the
 *     "just-played" round IS `currentRound`.
 *  2. **Analyst-only.** Gated to `role === 'advertising' || role === 'solo'`
 *     to match the Q6 role split (S-03 renamed `advertising` → "Analyst").
 *
 * Each purchase drops an entry into `acquiredCsvs` so the CSV Inbox
 * popup (in RoundHeader) can re-download it later without re-charging
 * the team. Purchase IDs are stable + round-scoped so dedupe via
 * `ADD_ACQUIRED_CSV` collapses repeat clicks into one inbox entry.
 */

const DEFAULT_TIER1_COST = 50;
const DEFAULT_TIER2_COST = 150;
const DEFAULT_COMPETITOR_INTEL_COST = 100;

export function DataPurchaseSection() {
  const { gameId, role, currentRound, acquiredCsvs, config } = useGame();
  const dispatch = useGameDispatch();

  const [showIntelConfirm, setShowIntelConfirm] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [purchasedThisSession, setPurchasedThisSession] = useState<
    Record<string, boolean>
  >({});

  const TIER1_COST = config?.chefDataTier1Cost ?? DEFAULT_TIER1_COST;
  const TIER2_COST = config?.chefDataTier2Cost ?? DEFAULT_TIER2_COST;
  const COMPETITOR_INTEL_COST =
    config?.competitorInsightCost ?? DEFAULT_COMPETITOR_INTEL_COST;

  const isAnalyst = role === "advertising" || role === "solo";
  // Gate the entire section to Analyst / Solo. Hidden for Operations and
  // Finance — they see the regular Results page without this block.
  if (!isAnalyst || !gameId || currentRound == null || currentRound < 1) {
    return null;
  }

  const addCsv = (entry: AcquiredCsv) => {
    dispatch({ type: "ADD_ACQUIRED_CSV", payload: entry });
  };

  const handlePurchaseIntel = async () => {
    if (!gameId) return;
    setShowIntelConfirm(false);
    setPending("intel");
    setError(null);
    setInfo(null);
    try {
      // B-05 round-arg change: buy for the round we just played
      // (currentRound in Results context), NOT currentRound-1.
      const round = currentRound;
      const purchaseFn = httpsCallable(functions, "purchaseCompetitorInsight");
      const result = await purchaseFn({ gameId, round });
      const data = result.data as { csv: string };
      addCsv({
        id: `competitor-intel-round-${round}`,
        kind: "competitor-intel",
        label: `Round ${round} competitor intel`,
        round,
        acquiredAtMs: Date.now(),
        csv: data.csv,
        filename: `competitor-intel-round-${round}.csv`,
      });
      // Tally on the BakeryView "Miscellaneous" receipt row so the player
      // sees the deduction line up with their budget. Server is the
      // source of truth for the actual ledger; this is UI-only.
      dispatch({
        type: "ADD_MISC_SPEND",
        payload: { amount: COMPETITOR_INTEL_COST },
      });
      setInfo("Intel added to your CSV Inbox.");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not purchase insight.";
      setError(message);
    } finally {
      setPending(null);
    }
  };

  const handlePurchaseChefData = async (tier: 1 | 2) => {
    if (!gameId) return;
    setPending(`chef-tier${tier}`);
    setError(null);
    setInfo(null);
    try {
      const purchaseFn = httpsCallable(functions, "purchaseChefData");
      const result = await purchaseFn({ gameId, tier });
      const data = result.data as { csv: string };
      addCsv({
        id: `chef-tier${tier}`,
        kind: tier === 1 ? "chef-tier1" : "chef-tier2",
        label:
          tier === 1
            ? "Specialty chef nationality → product map"
            : "Full chef profile dump",
        round: currentRound ?? undefined,
        acquiredAtMs: Date.now(),
        csv: data.csv,
        filename:
          tier === 1
            ? "chef-specialties.csv"
            : "chef-profiles.csv",
      });
      dispatch({
        type: "ADD_MISC_SPEND",
        payload: { amount: tier === 1 ? TIER1_COST : TIER2_COST },
      });
      setPurchasedThisSession((prev) => ({ ...prev, [`tier${tier}`]: true }));
      setInfo(`Tier ${tier} chef data added to your CSV Inbox.`);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not purchase chef data.";
      setError(message);
    } finally {
      setPending(null);
    }
  };

  // "Already bought" check — round-scoped for intel, session-scoped for
  // chef tiers (the chef data table doesn't change between rounds).
  const hasIntelForCurrentRound = acquiredCsvs.some(
    (c) => c.kind === "competitor-intel" && c.round === currentRound,
  );
  const hasTier1 =
    purchasedThisSession.tier1 ||
    acquiredCsvs.some((c) => c.kind === "chef-tier1");
  const hasTier2 =
    purchasedThisSession.tier2 ||
    acquiredCsvs.some((c) => c.kind === "chef-tier2");

  return (
    <section className="results-phase__data-purchases">
      <h3 className="results-phase__section-title">Buy Round Data</h3>
      <p className="results-phase__data-purchases-hint">
        Spend cash now to peek at the round you just played — competitor
        decisions, chef tables, etc. Purchases land in your CSV Inbox.
      </p>

      <div className="results-phase__data-purchase-row">
        <button
          className="btn btn--secondary btn--small"
          onClick={() => setShowIntelConfirm(true)}
          disabled={pending !== null || hasIntelForCurrentRound}
          title={
            hasIntelForCurrentRound
              ? `Round ${currentRound} intel is already in your CSV Inbox.`
              : undefined
          }
        >
          {hasIntelForCurrentRound
            ? `Competitor Intel (R${currentRound}) ✓ Purchased`
            : `Buy Competitor Intel — $${COMPETITOR_INTEL_COST.toLocaleString()}`}
        </button>
        {showIntelConfirm && !hasIntelForCurrentRound && (
          <div className="results-phase__intel-confirm">
            <p>
              Spend ${COMPETITOR_INTEL_COST.toLocaleString()} to see all
              teams' submitted quantities and prices from round {currentRound}?
            </p>
            <button
              className="btn btn--primary btn--small"
              onClick={handlePurchaseIntel}
              disabled={pending !== null}
            >
              Confirm
            </button>
            <button
              className="btn btn--ghost btn--small"
              onClick={() => setShowIntelConfirm(false)}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="results-phase__data-purchase-row">
        <button
          type="button"
          className="btn btn--secondary btn--small"
          onClick={() => void handlePurchaseChefData(1)}
          disabled={pending !== null || hasTier1}
          title={
            hasTier1
              ? "Tier 1 chef data is already in your CSV Inbox."
              : "Table of chef nationalities → product specialties."
          }
        >
          {hasTier1
            ? "Chef Specialties (T1) ✓ Purchased"
            : `Buy Chef Specialties (T1) — $${TIER1_COST.toLocaleString()}`}
        </button>
        <p className="results-phase__data-purchase-hint">
          Tier 1 — See which nationality bakes which products best.
        </p>
      </div>

      <div className="results-phase__data-purchase-row">
        <button
          type="button"
          className="btn btn--secondary btn--small"
          onClick={() => void handlePurchaseChefData(2)}
          disabled={pending !== null || hasTier2}
          title={
            hasTier2
              ? "Tier 2 chef data is already in your CSV Inbox."
              : "Full profile dump: skill, satisfaction, avg production + revenue, 30+ chefs per nationality."
          }
        >
          {hasTier2
            ? "Chef Profiles (T2) ✓ Purchased"
            : `Buy Chef Profiles (T2) — $${TIER2_COST.toLocaleString()}`}
        </button>
        <p className="results-phase__data-purchase-hint">
          Tier 2 — Full chef-by-chef profile CSV (30+ per nationality).
        </p>
      </div>

      {info && <p className="results-phase__data-info">{info}</p>}
      {error && (
        <p className="results-phase__data-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
