import { useState } from "react";
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
 * B-05 (2026-04-29): the data-purchase section that previously lived
 * below the tabs has moved to the Results phase. See
 * `DataPurchaseSection.tsx` and `ResultsPhase.tsx`.
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
    </aside>
  );
}
