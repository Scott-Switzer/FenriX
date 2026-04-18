import { useState, useEffect, useCallback } from "react";
import { httpsCallable, type FunctionsError } from "firebase/functions";
import { PageShell } from "../components/ui/PageShell";
import { RoundHeader } from "../components/game/RoundHeader";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import { functions } from "../lib/firebase";
import {
  AD_TYPES,
  parseGamePhase,
  type AdType,
  type AuctionTab,
  type ChefGender,
  type ChefListing,
  type ChefNationality,
  type SkillLevel,
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

interface AdCard {
  id: AdType;
  label: string;
  icon: string;
  desc: string;
}

// Display-order list for ads; backend expects the canonical keys.
const AD_CARDS: readonly AdCard[] = [
  { id: "TV",        label: "TV",        icon: "/assets/ads/tv.svg",        desc: "Reaches the most customers" },
  { id: "Radio",     label: "Radio",     icon: "/assets/ads/radio.svg",     desc: "Good local reach" },
  { id: "Newspaper", label: "Newspaper", icon: "/assets/ads/newspaper.svg", desc: "Steady, reliable audience" },
  { id: "Billboard", label: "Billboard", icon: "/assets/ads/billboard.svg", desc: "Constant neighborhood presence" },
];

const TAB_DURATION_SECONDS = 60;
const POOL_SIZE = 6;

// NOTE: This local pool is a cosmetic placeholder. The backend generates the
// authoritative chef pool per round at `games/{gameId}/rounds/{round}/chefs`.
// A follow-up (P1) is required to render that real pool so chef bids can be
// submitted to `submitBids({ bidType: "chef" })` with matching chefIds.
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
  const safeRound = round > 0 ? round : 1;

  for (const nat of NATIONALITIES) {
    const gender = GENDERS[Math.floor(Math.random() * 2)];
    const skill = rollSkill(safeRound);
    pool.push({
      id: `${nat}-${gender}-${safeRound}-${Math.random().toString(36).slice(2, 6)}`,
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
    const skill = rollSkill(safeRound);
    pool.push({
      id: `${nat}-${gender}-${safeRound}-extra${i}-${Math.random().toString(36).slice(2, 6)}`,
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

function humanizeFunctionError(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "code" in err) {
    const fnErr = err as FunctionsError;
    if (fnErr.message) return fnErr.message;
  }
  return fallback;
}

export function AuctionPage() {
  const {
    gameId,
    currentRound,
    phase,
    pendingAdBids,
    pendingChefBids,
    adBidsSubmitted,
    chefBidsSubmitted,
  } = useGame();
  const dispatch = useGameDispatch();

  const [activeTab, setActiveTabLocal] = useState<AuctionTab>("ads");
  const [chefPool] = useState<ChefListing[]>(() =>
    generateChefPool(currentRound)
  );
  const [remaining, setRemaining] = useState<number>(TAB_DURATION_SECONDS);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const parsed = parseGamePhase(phase, currentRound);
  const basePhase = parsed.base;
  const isAdPhase = basePhase === "bid_ad";
  const isChefPhase = basePhase === "bid_chef";

  const setActiveTab = useCallback(
    (tab: AuctionTab) => {
      setActiveTabLocal(tab);
      dispatch({ type: "SET_AUCTION_TAB", payload: tab });
    },
    [dispatch]
  );

  // Keep the visible tab in sync with the backend-driven phase.
  useEffect(() => {
    if (isAdPhase) setActiveTab("ads");
    else if (isChefPhase) setActiveTab("chefs");
  }, [isAdPhase, isChefPhase, setActiveTab]);

  const setChefBid = useCallback(
    (id: string, value: number) => {
      dispatch({
        type: "UPDATE_PENDING_CHEF_BID",
        payload: { chefId: id, amount: value },
      });
    },
    [dispatch]
  );

  const setAdBid = useCallback(
    (ad: AdType, value: number) => {
      dispatch({
        type: "UPDATE_PENDING_AD_BID",
        payload: { adType: ad, amount: value },
      });
    },
    [dispatch]
  );

  const handleSubmitBids = useCallback(async () => {
    if (!gameId) {
      setSubmitError("Not connected to a game yet.");
      return;
    }
    if (!isAdPhase && !isChefPhase) {
      setSubmitError("Bids can only be submitted during the auction phases.");
      return;
    }

    setSubmitError(null);
    setSubmitting(true);
    try {
      if (isAdPhase) {
        const submitBids = httpsCallable<
          { gameId: string; bidType: "ad"; adBids: Record<AdType, number> },
          { gameId: string; playerId: string; bidType: string; submitted: boolean }
        >(functions, "submitBids");
        const adBids = AD_TYPES.reduce((acc, ad) => {
          acc[ad] = Math.max(0, pendingAdBids[ad] ?? 0);
          return acc;
        }, {} as Record<AdType, number>);
        await submitBids({ gameId, bidType: "ad", adBids });
        dispatch({ type: "SET_AD_BIDS_SUBMITTED", payload: true });
      } else {
        // P0 gap: client chef IDs are locally generated and do not match the
        // backend's per-round chef pool. Submitting an empty array registers
        // "no chef bids" so the submission still advances the lifecycle.
        // Follow-up P1: wire this page to `games/{gameId}/rounds/{round}/chefs`
        // and send real `{ chefId, amount }` entries.
        const submitBids = httpsCallable<
          {
            gameId: string;
            bidType: "chef";
            chefBids: Array<{ chefId: string; amount: number }>;
          },
          { gameId: string; playerId: string; bidType: string; submitted: boolean }
        >(functions, "submitBids");
        await submitBids({ gameId, bidType: "chef", chefBids: [] });
        dispatch({ type: "SET_CHEF_BIDS_SUBMITTED", payload: true });
      }
    } catch (err) {
      setSubmitError(
        humanizeFunctionError(err, "Could not submit bids. Please try again.")
      );
    } finally {
      setSubmitting(false);
    }
  }, [gameId, isAdPhase, isChefPhase, pendingAdBids, dispatch]);

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

  const timerMinutes = Math.floor(remaining / 60);
  const timerSeconds = remaining % 60;
  const timerDisplay = `${timerMinutes}:${timerSeconds
    .toString()
    .padStart(2, "0")}`;
  const timerUrgent = remaining <= 10;

  const alreadySubmitted =
    (isAdPhase && adBidsSubmitted) || (isChefPhase && chefBidsSubmitted);

  return (
    <PageShell className="game-page auction-page">
      <RoundHeader />

      <div className="auction-page__header">
        <div className="auction-page__tabs">
          <button
            className={`auction-page__tab ${
              activeTab === "ads" ? "auction-page__tab--active" : ""
            } ${activeTab !== "ads" ? "auction-page__tab--locked" : ""}`}
            onClick={isDev ? () => setActiveTab("ads") : undefined}
          >
            Advertisements
          </button>
          <button
            className={`auction-page__tab ${
              activeTab === "chefs" ? "auction-page__tab--active" : ""
            } ${activeTab !== "chefs" ? "auction-page__tab--locked" : ""}`}
            onClick={isDev ? () => setActiveTab("chefs") : undefined}
          >
            Chef Hiring
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
        {activeTab === "ads" && (
          <div className="auction-ads">
            <p className="auction-page__hint">
              Bid on advertisement slots to attract more customers to your
              bakery.
            </p>
            <div className="auction-ads__grid">
              {AD_CARDS.map((ad) => (
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
                      value={pendingAdBids[ad.id] ?? 0}
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
                        value={pendingChefBids[chef.id] ?? ""}
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
      </div>

      {submitError && (
        <p className="auction-page__error" role="alert">
          {submitError}
        </p>
      )}

      <button
        className="btn btn--primary auction-page__submit"
        onClick={handleSubmitBids}
        disabled={submitting || alreadySubmitted || (!isAdPhase && !isChefPhase)}
      >
        {submitting
          ? "Submitting…"
          : alreadySubmitted
          ? "Submitted — waiting for other players…"
          : "Submit Bids"}
      </button>
    </PageShell>
  );
}
