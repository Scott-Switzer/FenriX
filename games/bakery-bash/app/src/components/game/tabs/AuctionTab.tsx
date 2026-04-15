import { useState } from "react";

const AD_TYPES = ["TV", "Radio", "Newspaper", "Billboard"] as const;
const CHEFS = [
  { id: "chef-1", name: "Chef #1", specialty: "Pastry" },
  { id: "chef-2", name: "Chef #2", specialty: "Bread" },
  { id: "chef-3", name: "Chef #3", specialty: "Drinks" },
];

export function AuctionTab() {
  const [adBids, setAdBids] = useState<Record<string, number>>({});
  const [chefBids, setChefBids] = useState<Record<string, number>>({});

  const setAdBid = (ad: string, value: number) => {
    setAdBids((prev) => ({ ...prev, [ad]: Math.max(0, value) }));
  };

  const setChefBid = (id: string, value: number) => {
    setChefBids((prev) => ({ ...prev, [id]: Math.max(0, value) }));
  };

  return (
    <div className="auction-tab">
      <h3 className="sidebar-tab__title">Auction</h3>

      <div className="auction-tab__section">
        <h4 className="auction-tab__section-title">Ad Slots</h4>
        <div className="auction-tab__grid">
          {AD_TYPES.map((ad) => (
            <div key={ad} className="auction-tab__card">
              <span className="auction-tab__card-name">{ad}</span>
              <input
                type="number"
                className="auction-tab__bid-input"
                placeholder="$0"
                min={0}
                value={adBids[ad] ?? ""}
                onChange={(e) =>
                  setAdBid(ad, parseInt(e.target.value) || 0)
                }
              />
            </div>
          ))}
        </div>
      </div>

      <div className="auction-tab__section">
        <h4 className="auction-tab__section-title">Chef Hiring</h4>
        <div className="auction-tab__grid">
          {CHEFS.map((chef) => (
            <div key={chef.id} className="auction-tab__card">
              <span className="auction-tab__card-name">{chef.name}</span>
              <span className="auction-tab__card-detail">
                {chef.specialty}
              </span>
              <input
                type="number"
                className="auction-tab__bid-input"
                placeholder="$0"
                min={0}
                value={chefBids[chef.id] ?? ""}
                onChange={(e) =>
                  setChefBid(chef.id, parseInt(e.target.value) || 0)
                }
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
