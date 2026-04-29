import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { useGame, useGameDispatch } from "../../contexts/GameContext";
import { functions } from "../../lib/firebase";
import { StaffTab } from "./tabs/StaffTab";
import { StatusTab } from "./tabs/StatusTab";
import type { AcquiredCsv } from "../../types/game";

/**
 * Right-hand control panel for the decide phase. Two tabs:
 *
 *  - **Hire** (default): per-station sous-chef steppers, maintenance guys +
 *    task assignments, escalating hire cost display.
 *  - **Status**: read-only health/cleanliness bars. Product quantities live
 *    on the main BakeryView (station grid), not here.
 *
 * Data purchases (competitor intel + Tier 1/Tier 2 chef CSVs) live below
 * the tabs and are role-gated to Finance. Each purchase drops an entry
 * into `acquiredCsvs` on the game context so the CSV Inbox popup can
 * redownload it later without re-charging the team.
 */
const TABS = ["Hire", "Status"] as const;
type Tab = (typeof TABS)[number];
const tabId = (tab: Tab) => `game-sidebar-tab-${tab.toLowerCase()}`;
const panelId = (tab: Tab) => `game-sidebar-panel-${tab.toLowerCase()}`;

// Fallback display costs used when the Firestore game-config doc hasn't
// synced yet. The backend reads these from `cfg.competitorInsightCost`,
// `cfg.chefDataTier1Cost`, `cfg.chefDataTier2Cost` (with the same defaults
// in DEFAULT_GAME_CONFIG), so professor overrides flow through naturally
// — see the `costs` derivation inside the component.
const DEFAULT_TIER1_COST = 50;
const DEFAULT_TIER2_COST = 150;
const DEFAULT_COMPETITOR_INTEL_COST = 100;

/**
 * FE-9 — `readOnly` is threaded into `StaffTab` so the steppers and
 * maintenance dropdowns lock once the player submits. The Status tab is
 * always read-only by nature (health bars, no inputs) so it ignores the
 * prop.
 */
export interface GameSidebarProps {
  readOnly?: boolean;
}

export function GameSidebar({ readOnly = false }: GameSidebarProps) {
  const [activeTab, setActiveTab] = useState<Tab>("Hire");
  const [showIntelConfirm, setShowIntelConfirm] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [purchasedThisSession, setPurchasedThisSession] = useState<
    Record<string, boolean>
  >({});

  const { gameId, role, currentRound, acquiredCsvs, config } = useGame();
  const dispatch = useGameDispatch();

  const TIER1_COST = config?.chefDataTier1Cost ?? DEFAULT_TIER1_COST;
  const TIER2_COST = config?.chefDataTier2Cost ?? DEFAULT_TIER2_COST;
  const COMPETITOR_INTEL_COST =
    config?.competitorInsightCost ?? DEFAULT_COMPETITOR_INTEL_COST;

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
      const prevRound = (currentRound ?? 1) - 1;
      const purchaseFn = httpsCallable(functions, "purchaseCompetitorInsight");
      const result = await purchaseFn({ gameId, round: prevRound });
      const data = result.data as { csv: string };
      // Stable, round-scoped id so ADD_ACQUIRED_CSV's dedupe-by-id actually
      // collapses repeat purchases into a single inbox entry (no Date.now).
      addCsv({
        id: `competitor-intel-round-${prevRound}`,
        kind: "competitor-intel",
        label: `Round ${prevRound} competitor intel`,
        round: prevRound,
        acquiredAtMs: Date.now(),
        csv: data.csv,
        filename: `competitor-intel-round-${prevRound}.csv`,
      });
      // Tally the spend on the BakeryView "Miscellaneous" receipt row so the
      // player sees the deduction line up with the budget. Server is the
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
      // Stable id — one inbox entry per tier, no Date.now sprinkle that would
      // bypass ADD_ACQUIRED_CSV dedupe on accidental double-submits.
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
      // Tally the spend on the BakeryView "Miscellaneous" receipt row.
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

  // S-03 (2026-04-29): data purchases (competitor intel + chef data) move
  // from Finance to the renamed Analyst role (backend role string is still
  // `advertising` for compatibility — only the label changed). The Solo
  // role keeps everything as the catch-all for ≤2-member teams.
  // NB: B-05 will lift this whole section into ResultsPhase; the gate
  // moves with it.
  const isAnalyst = role === "advertising" || role === "solo";
  const canPurchase = isAnalyst && !readOnly && !!gameId;
  const prevRound = (currentRound ?? 1) - 1;
  // Intel is round-scoped; "already bought" means specifically for the round
  // the button would purchase, so navigating to a new round re-enables it.
  const hasIntelForPrevRound = acquiredCsvs.some(
    (c) => c.kind === "competitor-intel" && c.round === prevRound,
  );
  const hasTier1 =
    purchasedThisSession.tier1 ||
    acquiredCsvs.some((c) => c.kind === "chef-tier1");
  const hasTier2 =
    purchasedThisSession.tier2 ||
    acquiredCsvs.some((c) => c.kind === "chef-tier2");

  return (
    <aside className="game-sidebar">
      <nav className="game-sidebar__tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab}
            id={tabId(tab)}
            role="tab"
            type="button"
            aria-selected={activeTab === tab}
            aria-controls={panelId(tab)}
            className={`game-sidebar__tab ${
              activeTab === tab ? "game-sidebar__tab--active" : ""
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>

      <div
        id={panelId(activeTab)}
        className="game-sidebar__panel"
        role="tabpanel"
        aria-labelledby={tabId(activeTab)}
      >
        {activeTab === "Hire" && <StaffTab readOnly={readOnly} />}
        {activeTab === "Status" && <StatusTab />}
      </div>

      {canPurchase && (
        <div className="sidebar__data-section">
          <h3 className="sidebar__data-title">Purchasable Data</h3>

          {(currentRound ?? 0) > 1 && (
            <div className="sidebar__intel-section">
              <button
                className="btn btn--secondary btn--small sidebar__intel-btn"
                onClick={() => setShowIntelConfirm(true)}
                disabled={pending !== null || hasIntelForPrevRound}
                title={
                  hasIntelForPrevRound
                    ? `Round ${prevRound} intel is already in your CSV Inbox.`
                    : undefined
                }
              >
                {hasIntelForPrevRound
                  ? `Competitor Intel (R${prevRound}) \u2713 Purchased`
                  : `Buy Competitor Intel \u2014 $${COMPETITOR_INTEL_COST.toLocaleString()}`}
              </button>
              {showIntelConfirm && !hasIntelForPrevRound && (
                <div className="sidebar__intel-confirm">
                  <p>
                    Spend ${COMPETITOR_INTEL_COST.toLocaleString()} to see all
                    teams' submitted quantities and prices from last round?
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
          )}

          <div className="sidebar__chef-data">
            <button
              type="button"
              className="btn btn--secondary btn--small sidebar__chef-data-btn"
              onClick={() => void handlePurchaseChefData(1)}
              disabled={pending !== null || hasTier1}
              title={
                hasTier1
                  ? "Tier 1 chef data is already in your CSV Inbox."
                  : "Table of chef nationalities \u2192 product specialties."
              }
            >
              {hasTier1
                ? "Chef Specialties (T1) \u2713 Purchased"
                : `Buy Chef Specialties (T1) \u2014 $${TIER1_COST.toLocaleString()}`}
            </button>
            <p className="sidebar__chef-data-hint">
              Tier 1 — See which nationality bakes which products best.
            </p>

            <button
              type="button"
              className="btn btn--secondary btn--small sidebar__chef-data-btn"
              onClick={() => void handlePurchaseChefData(2)}
              disabled={pending !== null || hasTier2}
              title={
                hasTier2
                  ? "Tier 2 chef data is already in your CSV Inbox."
                  : "Full profile dump: skill, satisfaction, avg production + revenue, 30+ chefs per nationality."
              }
            >
              {hasTier2
                ? "Chef Profiles (T2) \u2713 Purchased"
                : `Buy Chef Profiles (T2) \u2014 $${TIER2_COST.toLocaleString()}`}
            </button>
            <p className="sidebar__chef-data-hint">
              Tier 2 — Full chef-by-chef profile CSV (30+ per nationality).
            </p>
          </div>

          {info && <p className="sidebar__data-info">{info}</p>}
          {error && (
            <p className="sidebar__data-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
