import { useState } from "react";
import { MenuTab } from "./tabs/MenuTab";
import { StaffTab } from "./tabs/StaffTab";
import { AuctionTab } from "./tabs/AuctionTab";

const TABS = ["Menu", "Staff", "Auction"] as const;
type Tab = (typeof TABS)[number];

export function GameSidebar() {
  const [activeTab, setActiveTab] = useState<Tab>("Menu");

  return (
    <aside className="game-sidebar">
      <nav className="game-sidebar__tabs">
        {TABS.map((tab) => (
          <button
            key={tab}
            className={`game-sidebar__tab ${
              activeTab === tab ? "game-sidebar__tab--active" : ""
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>

      <div className="game-sidebar__panel">
        {activeTab === "Menu" && <MenuTab />}
        {activeTab === "Staff" && <StaffTab />}
        {activeTab === "Auction" && <AuctionTab />}
      </div>
    </aside>
  );
}
