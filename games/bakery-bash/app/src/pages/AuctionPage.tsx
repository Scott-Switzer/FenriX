import { useState, useEffect, useCallback } from "react";
import { PageShell } from "../components/ui/PageShell";
import { RoundHeader } from "../components/game/RoundHeader";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import type {
  ChefListing,
  ChefNationality,
  ChefGender,
  SkillLevel,
  AuctionTab,
  AdType,
} from "../types/game";

const NATIONALITIES: ChefNationality[] = [
  "american",
  "french",
  "italian",
  "japanese",
];
const GENDERS: ChefGender[] = ["m", "f"];

const NATIONALITY_LABELS: Record<ChefNationality, string> = {
  american: "American",
  french: "French",
  italian: "Italian",
  japanese: "Japanese",
};

function chefIcon(nationality: ChefNationality, gender: ChefGender): string {
  return `/assets/chefs/${nationality}-${gender}.svg`;
}

const SKILL_CONFIG: Record<
  SkillLevel,
  { label: string; multiplier: number; cssClass: string }
> = {
  low: { label: "Low", multiplier: 1.0, cssClass: "auction-chef--low" },
  medium: {
    label: "Medium",
    multiplier: 1.5,
    cssClass: "auction-chef--medium",
  },
  high: { label: "High", multiplier: 2.0, cssClass: "auction-chef--high" },
};

const AD_TYPES: ReadonlyArray<{
  id: AdType;
  label: string;
  icon: string;
  desc: string;
}> = [
  {
    id: "tv",
    label: "TV",
    icon: "/assets/ads/tv.svg",
    desc: "Reaches the most customers",
  },
  {
    id: "radio",
    label: "Radio",
    icon: "/assets/ads/radio.svg",
    desc: "Good local reach",
  },
  {
    id: "newspaper",
    label: "Newspaper",
    icon: "/assets/ads/newspaper.svg",
    desc: "Steady, reliable audience",
  },
  {
    id: "billboard",
    label: "Billboard",
    icon: "/assets/ads/billboard.svg",
    desc: "Constant neighborhood presence",
  },
];

const TAB_DURATION_SECONDS = 60;

const POOL_SIZE = 6;

function rollSkill(round: number): SkillLevel {
  const roll = Math.random();
  if (round <= 2) {
    return roll < 0.9 ? "low" : "medium";
  } else if (round <= 4) {
    return roll < 0.5 ? "low" : roll < 0.85 ? "medium" : "high";
  }
  return roll < 0.2 ? "low" : roll < 0.6 ? "medium" : "high";
}

function generateChefPool(round: number): ChefListing[] {
  const pool: ChefListing[] = [];

  for (const nat of NATIONALITIES) {
    const gender = GENDERS[Math.floor(Math.random() * 2)];
    const skill = rollSkill(round);
    pool.push({
      id: `${nat}-${gender}-${round}-${Math.random().toString(36).slice(2, 6)}`,
      nationality: nat,
      gender,
      name: `${NATIONALITY_LABELS[nat]} Chef`,
      skill,
      multiplier: SKILL_CONFIG[skill].multiplier,
    });
  }

  const extraCount = POOL_SIZE - NATIONALITIES.length;
  for (let i = 0; i < extraCount; i++) {
    const nat = NATIONALITIES[Math.floor(Math.random() * NATIONALITIES.length)];
    const gender = GENDERS[Math.floor(Math.random() * 2)];
    const skill = rollSkill(round);
    pool.push({
      id: `${nat}-${gender}-${round}-extra${i}-${Math.random().toString(36).slice(2, 6)}`,
      nationality: nat,
      gender,
      name: `${NATIONALITY_LABELS[nat]} Chef`,
      skill,
      multiplier: SKILL_CONFIG[skill].multiplier,
    });
  }

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool;
}

export function AuctionPage() {
  const { currentRound } = useGame();
  const dispatch = useGameDispatch();

  const [activeTab, setActiveTabLocal] = useState<AuctionTab>("chefs");
  const [chefPool] = useState<ChefListing[]>(() =>
    generateChefPool(currentRound)
  );
  const [chefBids, setChefBids] = useState<Record<string, number>>({});
  const [adBids, setAdBids] = useState<Partial<Record<AdType, number>>>({});
  const [remaining, setRemaining] = useState<number>(TAB_DURATION_SECONDS);

  const setActiveTab = useCallback(
    (tab: AuctionTab) => {
      setActiveTabLocal(tab);
      dispatch({ type: "SET_AUCTION_TAB", payload: tab });
    },
    [dispatch]
  );

  useEffect(() => {
    dispatch({ type: "SET_AUCTION_TAB", payload: "chefs" });
  }, [dispatch]);

  const setChefBid = useCallback((id: string, value: number) => {
    setChefBids((prev) => ({ ...prev, [id]: Math.max(0, value) }));
  }, []);

  const setAdBid = useCallback((ad: AdType, value: number) => {
    setAdBids((prev) => ({ ...prev, [ad]: Math.max(0, value) }));
  }, []);

  const handleSubmitBids = useCallback(() => {
    dispatch({ type: "SET_PHASE", payload: "simulate" });
  }, [dispatch]);

  const isDev = !import.meta.env.PROD;

  useEffect(() => {
    setRemaining(TAB_DURATION_SECONDS);
  }, [activeTab]);

  useEffect(() => {
    const tick = setInterval(() => {
      setRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(tick);
  }, [activeTab]);

  useEffect(() => {
    if (remaining > 0) return;
    if (activeTab === "chefs") {
      setActiveTab("ads");
    } else {
      handleSubmitBids();
    }
  }, [remaining, activeTab, setActiveTab, handleSubmitBids]);

  const timerMinutes = Math.floor(remaining / 60);
  const timerSeconds = remaining % 60;
  const timerDisplay = `${timerMinutes}:${timerSeconds
    .toString()
    .padStart(2, "0")}`;
  const timerUrgent = remaining <= 10;

  return (
    <PageShell className="game-page auction-page">
      <RoundHeader />

      <div className="auction-page__header">
        <div className="auction-page__tabs">
          <button
            className={`auction-page__tab ${
              activeTab === "chefs" ? "auction-page__tab--active" : ""
            } ${activeTab !== "chefs" ? "auction-page__tab--locked" : ""}`}
            onClick={isDev ? () => setActiveTab("chefs") : undefined}
          >
            Chef Hiring
          </button>
          <button
            className={`auction-page__tab ${
              activeTab === "ads" ? "auction-page__tab--active" : ""
            } ${activeTab !== "ads" ? "auction-page__tab--locked" : ""}`}
            onClick={isDev ? () => setActiveTab("ads") : undefined}
          >
            Advertisements
          </button>
        </div>
        <div
          className={`auction-page__timer${
            timerUrgent ? " auction-page__timer--urgent" : ""
          }`}
        >
          {timerDisplay}
        </div>
      </div>

      <div className="auction-page__content">
        {activeTab === "chefs" && (
          <div className="auction-chefs">
            <p className="auction-page__hint">
              Bid on chefs to boost your bakery's output.
            </p>
            <div className="auction-chefs__grid">
              {chefPool.map((chef) => {
                const skillCfg = SKILL_CONFIG[chef.skill];
                return (
                  <div
                    key={chef.id}
                    className={`auction-chef ${skillCfg.cssClass}`}
                  >
                    <div className="auction-chef__portrait">
                      <img
                        src={chefIcon(chef.nationality, chef.gender)}
                        alt={chef.name}
                        className="auction-chef__icon"
                      />
                    </div>
                    <span
                      className={`auction-chef__skill-tag auction-chef__skill-tag--${chef.skill}`}
                    >
                      {skillCfg.label}
                    </span>
                    <div className="auction-chef__info">
                      <span className="auction-chef__name">{chef.name}</span>
                    </div>
                    <div className="auction-chef__top-bid">
                      <span className="auction-chef__top-bid-label">Top Bid</span>
                      <span className="auction-chef__top-bid-value">--</span>
                    </div>
                    <div className="auction-chef__bid">
                      <label className="auction-chef__bid-label">
                        Your Bid
                      </label>
                      <input
                        type="number"
                        className="auction-chef__bid-input"
                        placeholder="$0"
                        min={0}
                        value={chefBids[chef.id] ?? ""}
                        onChange={(e) =>
                          setChefBid(chef.id, parseInt(e.target.value) || 0)
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === "ads" && (
          <div className="auction-ads">
            <p className="auction-page__hint">
              Bid on advertisement slots to attract more customers to your
              bakery.
            </p>
            <div className="auction-ads__grid">
              {AD_TYPES.map((ad) => (
                <div key={ad.id} className="auction-ad">
                  <img
                    src={ad.icon}
                    alt={ad.label}
                    className="auction-ad__icon"
                  />
                  <div className="auction-ad__info">
                    <span className="auction-ad__name">{ad.label}</span>
                    <span className="auction-ad__desc">{ad.desc}</span>
                  </div>
                  <div className="auction-ad__top-bid">
                    <span className="auction-ad__top-bid-label">Top Bid</span>
                    <span className="auction-ad__top-bid-value">--</span>
                  </div>
                  <div className="auction-ad__bid">
                    <label className="auction-ad__bid-label">Your Bid</label>
                    <input
                      type="number"
                      className="auction-ad__bid-input"
                      placeholder="$0"
                      min={0}
                      value={adBids[ad.id] ?? ""}
                      onChange={(e) =>
                        setAdBid(ad.id, parseInt(e.target.value, 10) || 0)
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <button
        className="btn btn--primary auction-page__submit"
        onClick={handleSubmitBids}
      >
        Submit Bids
      </button>
    </PageShell>
  );
}
