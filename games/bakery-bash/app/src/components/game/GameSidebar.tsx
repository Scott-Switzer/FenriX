import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { useGame } from "../../contexts/GameContext";
import { functions } from "../../lib/firebase";
import { StaffTab } from "./tabs/StaffTab";
import { StatusTab } from "./tabs/StatusTab";

/**
 * Right-hand control panel for the decide phase. Two tabs:
 *
 *  - **Hire** (default): per-station sous-chef steppers, maintenance guys +
 *    task assignments, escalating hire cost display.
 *  - **Status**: read-only health/cleanliness bars. Product quantities live
 *    on the main BakeryView (station grid), not here.
 *
 * Note (FE-07, April 19): the prior `<BudgetSummary>` panel was removed
 * from the sidebar per the updated decide-phase spec ("no budget"). The
 * component file is retained in case the spec flips again, but it is no
 * longer mounted anywhere during play. Budget display is now restricted
 * to `/game/conclusion` and the professor leaderboard only (Hard UI
 * Rule #1, non-overridden).
 */
const TABS = ["Hire", "Status"] as const;
type Tab = (typeof TABS)[number];
const tabId = (tab: Tab) => `game-sidebar-tab-${tab.toLowerCase()}`;
const panelId = (tab: Tab) => `game-sidebar-panel-${tab.toLowerCase()}`;

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
  const [intelCsv, setIntelCsv] = useState<string | null>(null);

  const { gameId, role, currentRound } = useGame();

  const handlePurchaseIntel = async () => {
    if (!gameId) return;
    setShowIntelConfirm(false);
    try {
      const purchaseFn = httpsCallable(functions, "purchaseCompetitorInsight");
      const result = await purchaseFn({ gameId, round: (currentRound ?? 1) - 1 });
      const data = result.data as { csv: string };
      setIntelCsv(data.csv);
    } catch (err: any) {
      alert(err.message || "Could not purchase insight.");
    }
  };

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

      {role === "finance" && (currentRound ?? 0) > 1 && (
        <div className="sidebar__intel-section">
          <button
            className="btn btn--secondary btn--small sidebar__intel-btn"
            onClick={() => setShowIntelConfirm(true)}
          >
            Buy Competitor Intel — $5,000
          </button>
          {showIntelConfirm && (
            <div className="sidebar__intel-confirm">
              <p>Spend $5,000 to see all teams' submitted quantities and prices from last round?</p>
              <button className="btn btn--primary btn--small" onClick={handlePurchaseIntel}>Confirm</button>
              <button className="btn btn--ghost btn--small" onClick={() => setShowIntelConfirm(false)}>Cancel</button>
            </div>
          )}
          {intelCsv && (
            <div className="sidebar__intel-result">
              <p>Intel purchased! <a download="competitor-intel.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(intelCsv)}`}>Download CSV</a></p>
              <button className="btn btn--ghost btn--small" onClick={() => setIntelCsv(null)}>Close</button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
