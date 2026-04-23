import { useState, useEffect, useCallback } from "react";
import { doc, onSnapshot, type DocumentData } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { PageShell } from "../components/ui/PageShell";
import { RoundHeader } from "../components/game/RoundHeader";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import { useGamePhaseNav } from "../hooks/useGamePhaseNav";
import { db, functions } from "../lib/firebase";
import { humanizeFunctionError } from "../lib/errors";
import {
  AD_TYPES,
  ownerOfAdBids,
  ownerOfChefBids,
  parseGamePhase,
  roleOwnsAdBids,
  roleOwnsChefBids,
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
  { id: "TV",        label: "Television",  icon: "/assets/ads/tv.svg",        desc: "Make your advertisements come to life with motion pictures!" },
  { id: "Radio",     label: "Radio",       icon: "/assets/ads/radio.svg",     desc: "A few rhymes and a good chime will be sure to reel in loyal customers." },
  { id: "Newspaper", label: "Newspaper",   icon: "/assets/ads/newspaper.svg", desc: "Extra! Extra! Read all about it \u2014 at least let\u2019s hope they do." },
  { id: "Billboard", label: "Billboard",   icon: "/assets/ads/billboard.svg", desc: "Plant your brand right in their path. Hard to miss, impossible to forget." },
];

const TAB_DURATION_SECONDS = 60;
const POOL_SIZE = 6;

// Skill-tier roll probabilities for the cosmetic placeholder pool. The roll
// is a `Math.random()` value in [0, 1); cutoffs determine which tier the
// chef lands in. Thresholds scale with round so later rounds surface more
// advanced chefs. The real pool is generated server-side (see
// `generateChefPool` in backend/functions/modules/chef-system.js) using
// different parameters; these constants only govern the local placeholder.
const EARLY_ROUND_CUTOFF = 2;
const MID_ROUND_CUTOFF = 4;
const EARLY_LOW_MAX = 0.9;     // rounds 1–2: 90% low, 10% medium
const MID_LOW_MAX = 0.5;       // rounds 3–4: 50% low,
const MID_MEDIUM_MAX = 0.85;   //              35% medium, 15% high
const LATE_LOW_MAX = 0.2;      // rounds 5+:  20% low,
const LATE_MEDIUM_MAX = 0.6;   //              40% medium, 40% high

// NOTE: This local pool is a cosmetic placeholder. The backend writes the
// authoritative pool to `games/{gameId}/rounds/{round}.chefPool` (a field
// on the round doc, not a subcollection). The AuctionPage effect below
// subscribes to that doc and prefers the real pool when present; this
// local generator is the fallback for when the doc hasn't materialized.
// Schema difference: backend tiers are `novel`/`intermediate`/`advanced`
// (mapped to `low`/`medium`/`high` client-side via `mapBackendSkill`).
function rollSkill(round: number): SkillLevel {
  const roll = Math.random();
  if (round <= EARLY_ROUND_CUTOFF) {
    return roll < EARLY_LOW_MAX ? "low" : "medium";
  } else if (round <= MID_ROUND_CUTOFF) {
    return roll < MID_LOW_MAX
      ? "low"
      : roll < MID_MEDIUM_MAX
      ? "medium"
      : "high";
  }
  return roll < LATE_LOW_MAX
    ? "low"
    : roll < LATE_MEDIUM_MAX
    ? "medium"
    : "high";
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

/**
 * Shape of a chef as written to `games/{gameId}/rounds/{round}.chefPool`
 * by the backend. Only the fields the UI renders or submits are declared
 * here; the backend also attaches `specialties`, `minBidFloor`, etc.
 * `gender` is written as the full string `"male"` / `"female"` server-side
 * (see `backend/functions/modules/chef-system.js`) and mapped to the UI's
 * `"m"` / `"f"` in `mapBackendChef`.
 */
interface BackendChef {
  id: string;
  nationality: unknown;
  gender: unknown;
  name?: string;
  skillTier?: string;
  minBidFloor?: number;
}

const BACKEND_SKILL_MAP: Record<string, SkillLevel> = {
  novel: "low",
  intermediate: "medium",
  advanced: "high",
  base: "low",
};

function mapBackendSkill(tier: string | undefined): SkillLevel {
  return (tier && BACKEND_SKILL_MAP[tier]) || "low";
}

function mapBackendGender(gen: unknown): ChefGender | null {
  if (gen === "male" || gen === "m") return "m";
  if (gen === "female" || gen === "f") return "f";
  return null;
}

function mapBackendChef(chef: BackendChef): ChefListing | null {
  const nat = chef.nationality;
  const isValidNat =
    nat === "american" || nat === "french" || nat === "italian" || nat === "japanese";
  const gender = mapBackendGender(chef.gender);
  if (!chef.id || !isValidNat || !gender) return null;
  const skill = mapBackendSkill(chef.skillTier);
  return {
    id: chef.id,
    nationality: nat,
    gender,
    name: chef.name || `${NATIONALITY_LABELS[nat]} Chef`,
    skill,
    multiplier: SKILL_CONFIG[skill].multiplier,
    minBidFloor:
      typeof chef.minBidFloor === "number" && chef.minBidFloor > 0
        ? chef.minBidFloor
        : undefined,
  };
}

export function AuctionPage() {
  useGamePhaseNav();
  const {
    gameId,
    playerId,
    teamId,
    currentRound,
    phase,
    pendingAdBids,
    pendingChefBids,
    adBidsSubmitted,
    chefBidsSubmitted,
    role,
    teamRoleAssignments,
  } = useGame();
  const dispatch = useGameDispatch();
  // Backend writes leader keys as `teamId || playerId` — match that here so
  // the per-slot lock can identify "I'm the unique top bidder" vs. "tied
  // with another team" (in which case neither should be locked).
  const myTeamKey = teamId || playerId || null;

  const [activeTab, setActiveTabLocal] = useState<AuctionTab>("ads");
  // FE-R09: regenerate the cosmetic placeholder each round so the pre-
  // backend-snapshot flash doesn't show last round's placeholder chefs.
  const [placeholderPool, setPlaceholderPool] = useState<ChefListing[]>(() =>
    generateChefPool(currentRound)
  );
  useEffect(() => {
    setPlaceholderPool(generateChefPool(currentRound));
  }, [currentRound]);
  // Backend pool (when present) takes priority over the cosmetic placeholder.
  // `null` means "not yet loaded"; `[]` means "loaded, but empty."
  const [backendPool, setBackendPool] = useState<ChefListing[] | null>(null);
  // FE-20 follow-up — live top bids from `rounds/{round}.topBids` (BE-25).
  // Shape: `{ad: {TV,Billboard,Radio,Newspaper: number}, chef: {[chefId]: number}}`.
  const [topBidsAd, setTopBidsAd] = useState<Partial<Record<AdType, number>>>({});
  const [topBidsChef, setTopBidsChef] = useState<Record<string, number>>({});
  // Leader teamKey per slot from `rounds/{round}.topBidsLeader`. Used to
  // distinguish "I am the unique top bidder" (lock) from "tied with another
  // team" (don't lock — let the player raise to break the tie).
  const [topBidsLeaderAd, setTopBidsLeaderAd] = useState<Partial<Record<AdType, string>>>({});
  const [topBidsLeaderChef, setTopBidsLeaderChef] = useState<Record<string, string>>({});
  const [remaining, setRemaining] = useState<number>(TAB_DURATION_SECONDS);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [chefBidInputs, setChefBidInputs] = useState<Record<string, string>>({});
  const [showExpiredPopup, setShowExpiredPopup] = useState(false);

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

  // Subscribe to the authoritative chef pool for the current round. The
  // backend writes `chefPool` as a field on `games/{gameId}/rounds/{round}`
  // when it enters an auction phase. Until that doc materializes we render
  // the local placeholder; once it does, we render real chef IDs so the
  // `submitBids` callable accepts the bids.
  //
  // FE-R09: when `currentRound` changes, proactively clear all
  // round-scoped local state (backend pool, live top-bids, per-chef input
  // strings) so Round N's auction screen never flashes Round N-1's data
  // before the new round's snapshot arrives.
  useEffect(() => {
    setBackendPool(null);
    setTopBidsAd({});
    setTopBidsChef({});
    setTopBidsLeaderAd({});
    setTopBidsLeaderChef({});
    setChefBidInputs({});
    if (!gameId || !currentRound) {
      return;
    }
    const roundRef = doc(db, "games", gameId, "rounds", `round_${currentRound}`);
    const unsubscribe = onSnapshot(
      roundRef,
      (snap) => {
        if (!snap.exists()) {
          setBackendPool(null);
          return;
        }
        const data = snap.data() as DocumentData;

        // Top bids (BE-25). Defensively parse — backend writes ints but
        // we tolerate missing keys during rollout.
        const tb = (data.topBids ?? null) as DocumentData | null;
        const tbAd = (tb?.ad ?? null) as DocumentData | null;
        const nextAd: Partial<Record<AdType, number>> = {};
        if (tbAd) {
          (["TV", "Billboard", "Radio", "Newspaper"] as AdType[]).forEach(
            (k) => {
              const v = tbAd[k];
              if (typeof v === "number" && v > 0) nextAd[k] = v;
            },
          );
        }
        setTopBidsAd(nextAd);
        const tbChef = (tb?.chef ?? null) as DocumentData | null;
        const nextChef: Record<string, number> = {};
        if (tbChef && typeof tbChef === "object") {
          for (const [id, v] of Object.entries(tbChef)) {
            if (typeof v === "number" && v > 0) nextChef[id] = v;
          }
        }
        setTopBidsChef(nextChef);

        // Leader keys (teamId or playerId) per slot. May be missing on round
        // docs written before this field rolled out — treated as "unknown
        // leader" which leaves slots editable instead of incorrectly locked.
        const tbLeader = (data.topBidsLeader ?? null) as DocumentData | null;
        const tbLeaderAd = (tbLeader?.ad ?? null) as DocumentData | null;
        const nextLeaderAd: Partial<Record<AdType, string>> = {};
        if (tbLeaderAd) {
          (["TV", "Billboard", "Radio", "Newspaper"] as AdType[]).forEach((k) => {
            const v = tbLeaderAd[k];
            if (typeof v === "string" && v) nextLeaderAd[k] = v;
          });
        }
        setTopBidsLeaderAd(nextLeaderAd);
        const tbLeaderChef = (tbLeader?.chef ?? null) as DocumentData | null;
        const nextLeaderChef: Record<string, string> = {};
        if (tbLeaderChef && typeof tbLeaderChef === "object") {
          for (const [id, v] of Object.entries(tbLeaderChef)) {
            if (typeof v === "string" && v) nextLeaderChef[id] = v;
          }
        }
        setTopBidsLeaderChef(nextLeaderChef);

        const raw = Array.isArray(data.chefPool) ? data.chefPool : null;
        if (!raw) {
          setBackendPool(null);
          return;
        }
        const mapped = raw
          .map((c) => mapBackendChef(c as BackendChef))
          .filter((c): c is ChefListing => c !== null);
        setBackendPool(mapped);
      },
      (err) => {
        console.error("games/rounds listener error", {
          gameId,
          round: currentRound,
          err,
        });
        setBackendPool(null);
      },
    );
    return unsubscribe;
  }, [gameId, currentRound]);

  const chefPool = backendPool ?? placeholderPool;
  const chefPoolIsReal = backendPool !== null;

  // Derived before callbacks so they can reference it.
  const timerExpired = typeof remaining === "number" && remaining <= 0;

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

  const handleSubmitSingleBid = useCallback(async (chefId: string) => {
    if (timerExpired || !gameId) return;
    try {
      const submitBids = httpsCallable(functions, "submitBids");
      await submitBids({
        gameId,
        bidType: "chef",
        chefBids: [{ chefId, amount: pendingChefBids[chefId] ?? 0 }],
      });
    } catch (err) {
      setSubmitError(humanizeFunctionError(err, "Could not submit chef bid. Please try again."));
    }
  }, [timerExpired, gameId, pendingChefBids]);

  const handleSubmitBids = useCallback(async () => {
    if (timerExpired) { setShowExpiredPopup(true); return; }
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
      } else {
        // If the real chef pool from `rounds/{round}.chefPool` has loaded,
        // send bids keyed by those real IDs. Until then, chef IDs in
        // `pendingChefBids` are the cosmetic placeholders from
        // `generateChefPool` and would fail backend validation, so we
        // submit an empty array to advance the lifecycle without bidding.
        const chefBids: Array<{ chefId: string; amount: number }> = [];
        if (chefPoolIsReal) {
          const poolById = new Map(chefPool.map((c) => [c.id, c]));
          for (const [chefId, amount] of Object.entries(pendingChefBids)) {
            const chef = poolById.get(chefId);
            if (!chef) continue;
            if (typeof amount !== "number" || amount <= 0) continue;
            // Client-side minimum-bid guard (matches the backend enforcement
            // in the chef-system module). The per-card submit button is also
            // disabled when `belowMinimum` is true, but guard here too in
            // case a player submits via the bulk "Submit Bids" path.
            const floor = chef.minBidFloor ?? 0;
            if (floor > 0 && amount < floor) {
              setSubmitError("Bid above the minimum bid.");
              setSubmitting(false);
              return;
            }
            chefBids.push({ chefId, amount });
          }
        }
        const submitBids = httpsCallable<
          {
            gameId: string;
            bidType: "chef";
            chefBids: Array<{ chefId: string; amount: number }>;
          },
          { gameId: string; playerId: string; bidType: string; submitted: boolean }
        >(functions, "submitBids");
        await submitBids({ gameId, bidType: "chef", chefBids });
      }
    } catch (err) {
      setSubmitError(
        humanizeFunctionError(err, "Could not submit bids. Please try again.")
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    timerExpired,
    gameId,
    isAdPhase,
    isChefPhase,
    pendingAdBids,
    pendingChefBids,
    chefPool,
    chefPoolIsReal,
    dispatch,
  ]);

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
    if (timerExpired) {
      setShowExpiredPopup(true);
      const t = setTimeout(() => setShowExpiredPopup(false), 4000);
      return () => clearTimeout(t);
    }
  }, [timerExpired]);

  // Phase timer display lives exclusively in <RoundHeader /> (it reads
  // `phaseEndsAt` from the backend and shows a unified clock across every
  // phase). The AuctionPage used to render a second local timer at
  // `.auction-page__timer`, which showed a duplicate clock on both bid
  // tabs — removed. The `remaining` counter + `timerExpired` flag are
  // kept internal because they still gate the bid inputs + the
  // timer-expired popup.

  const alreadySubmitted =
    (isAdPhase && adBidsSubmitted) || (isChefPhase && chefBidsSubmitted);

  // FE-9 — the bid inputs become read-only once the player's team has
  // locked in bids for the current phase, or the game has moved past the
  // auction phase entirely. Unlike Decide, "locked" here is phase-scoped:
  // the Ads tab stays editable during the ad phase even after chefs lock
  // (and vice-versa). Out-of-phase is always read-only.
  //
  // Leader-aware lock: a slot only locks when *we* are the unique top
  // bidder. If the leader key is missing (legacy round doc) or doesn't
  // match us, the slot stays editable so a tied team can raise to break
  // the tie instead of being silently frozen out.
  const isLockedAdBid = useCallback(
    (adType: AdType) => {
      if (!isAdPhase) return true;
      const myBid = pendingAdBids[adType] ?? 0;
      const topBid = topBidsAd[adType] ?? 0;
      const leader = topBidsLeaderAd[adType];
      return (
        myBid > 0 &&
        topBid > 0 &&
        myBid === topBid &&
        !!myTeamKey &&
        leader === myTeamKey
      );
    },
    [isAdPhase, pendingAdBids, topBidsAd, topBidsLeaderAd, myTeamKey],
  );

  const isLockedChefBid = useCallback(
    (chefId: string) => {
      if (!isChefPhase) return true;
      const myBid = pendingChefBids[chefId] ?? 0;
      const topBid = topBidsChef[chefId] ?? 0;
      const leader = topBidsLeaderChef[chefId];
      return (
        myBid > 0 &&
        topBid > 0 &&
        myBid === topBid &&
        !!myTeamKey &&
        leader === myTeamKey
      );
    },
    [isChefPhase, pendingChefBids, topBidsChef, topBidsLeaderChef, myTeamKey],
  );

  const hasEditableAdBid = isAdPhase
    ? AD_TYPES.some((adType) => !isLockedAdBid(adType))
    : false;
  const hasEditableChefBid = isChefPhase
    ? chefPool.some((chef) => !isLockedChefBid(chef.id))
    : false;
  const hasEditableBid = isAdPhase ? hasEditableAdBid : hasEditableChefBid;
  const hasAnyAdBid = AD_TYPES.some((adType) => (pendingAdBids[adType] ?? 0) > 0);
  const hasAnyChefBid = chefPool.some((chef) => (pendingChefBids[chef.id] ?? 0) > 0);
  const hasAnyBidForPhase = isAdPhase ? hasAnyAdBid : hasAnyChefBid;

  // DEC-21 role gating: Advertising owns ad bids, Finance owns chef bids,
  // Solo owns both. Other teammates still see + can edit the inputs (so
  // they can advise the role-owner) but the submit button is disabled with
  // an explicit owner tooltip.
  const ownerLabel = isAdPhase
    ? ownerOfAdBids()
    : isChefPhase
    ? ownerOfChefBids()
    : null;
  // FE-I15: relax the role gate when nobody on the team holds the
  // specialist role — otherwise a 2-player team can't bid.
  const canSubmitForPhase = isAdPhase
    ? roleOwnsAdBids(role, teamRoleAssignments)
    : isChefPhase
    ? roleOwnsChefBids(role, teamRoleAssignments)
    : true;
  const submitTooltip =
    !canSubmitForPhase && ownerLabel
      ? `Your ${ownerLabel} teammate submits this decision.`
      : undefined;
  const submitLabel = !canSubmitForPhase && ownerLabel
    ? `Your ${ownerLabel} teammate submits this decision`
    : submitting
    ? "Submitting…"
    : !hasEditableBid
    ? "You currently lead every submitted bid"
    : "Submit All Bids";

  return (
    <PageShell className="game-page auction-page">
      {showExpiredPopup && (
        <div className="auction-page__timer-expired" role="alert">
          Auction timer is up! Results will be displayed shortly.
        </div>
      )}
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
        {/* Phase countdown is owned by <RoundHeader />. The AuctionPage
            used to render a second local timer here which duplicated the
            header clock on bid pages; removed so players see exactly one. */}
        {alreadySubmitted && !hasEditableBid && (
          <span
            className="tab__badge tab__badge--submitted auction-page__locked-badge"
            role="status"
          >
            Bids Locked
          </span>
        )}
      </div>

      <div className="auction-page__content">
        {activeTab === "ads" && (
          <div className="auction-ads">
            <p className="auction-page__hint">
              Bid on advertisement slots to attract more customers to your
              bakery.
            </p>
            <p className="auction-page__ad-description">
              The highest bidder for each ad holds it for the entire round &#8212; one full month of exclusive
              reach. Ownership resets every auction, so no team can hold a slot forever. May the best bid win!
            </p>
            <div className="auction-ads__grid">
              {isAdPhase && hasEditableBid && (
                <p className="auction-page__hint">
                  You can rebid any ad slot where another team has outbid you.
                  Slots where you already lead are locked.
                </p>
              )}
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
                    <span className="auction-ad__top-bid-value">
                      {typeof topBidsAd[ad.id] === "number"
                        ? `$${topBidsAd[ad.id]!.toLocaleString()}`
                        : "--"}
                    </span>
                  </div>
                  <div className="auction-ad__bid">
                    <label className="auction-ad__bid-label">Your Bid</label>
                    <div className="auction-page__bid-wrapper">
                      <span className="auction-page__bid-prefix">$</span>
                      <input
                        type="number"
                        className="auction-ad__bid-input auction-page__bid-input"
                        placeholder="0"
                        min={0}
                        value={pendingAdBids[ad.id] ?? 0}
                        disabled={timerExpired || !isAdPhase || isLockedAdBid(ad.id)}
                        readOnly={!isAdPhase || isLockedAdBid(ad.id)}
                        onChange={(e) =>
                          setAdBid(ad.id, parseInt(e.target.value, 10) || 0)
                        }
                      />
                    </div>
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
            {isChefPhase && hasEditableBid && (
              <p className="auction-page__hint">
                You can rebid chefs where you have been outbid. Chefs you
                currently lead are locked.
              </p>
            )}
            <div className="auction-chefs__grid">
              {chefPool.map((chef, chefIndex) => {
                const skillCfg = SKILL_CONFIG[chef.skill];
                const minBid =
                  typeof chef.minBidFloor === "number"
                    ? chef.minBidFloor
                    : null;
                const currentBidAmount = pendingChefBids[chef.id] ?? 0;
                const belowMinimum =
                  minBid !== null &&
                  currentBidAmount > 0 &&
                  currentBidAmount < minBid;
                return (
                  <div
                    key={chef.id}
                    className={`auction-chef ${skillCfg.cssClass}`}
                  >
                    <span className="auction-chef__number chef-card__number">
                      #{chefIndex + 1}
                    </span>
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
                      <span className="auction-chef__top-bid-value">
                        {typeof topBidsChef[chef.id] === "number"
                          ? `$${topBidsChef[chef.id]!.toLocaleString()}`
                          : "--"}
                      </span>
                    </div>
                    {minBid !== null && (
                      <div className="auction-chef__min-bid">
                        <span className="auction-chef__min-bid-label">
                          Minimum Bid
                        </span>
                        <span className="auction-chef__min-bid-value">
                          ${minBid.toLocaleString()}
                        </span>
                      </div>
                    )}
                    <div className="auction-chef__bid">
                      <label className="auction-chef__bid-label">
                        Your Bid
                      </label>
                      <div className="auction-page__bid-wrapper">
                        <span className="auction-page__bid-prefix">$</span>
                        <input
                          type="number"
                          className={`auction-chef__bid-input auction-page__bid-input${
                            belowMinimum ? " auction-chef__bid-input--error" : ""
                          }`}
                          placeholder="0"
                          min={0}
                          value={chefBidInputs[chef.id] ?? ""}
                          disabled={timerExpired || !isChefPhase || isLockedChefBid(chef.id)}
                          readOnly={!isChefPhase || isLockedChefBid(chef.id)}
                          aria-invalid={belowMinimum ? "true" : undefined}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setChefBidInputs(prev => ({ ...prev, [chef.id]: raw }));
                            const parsed = parseInt(raw, 10);
                            if (!isNaN(parsed) && parsed >= 0) {
                              setChefBid(chef.id, parsed);
                            } else if (raw === "") {
                              setChefBid(chef.id, 0);
                            }
                          }}
                        />
                      </div>
                      {belowMinimum && (
                        <p className="auction-chef__bid-error" role="alert">
                          Bid above the minimum bid.
                        </p>
                      )}
                      <button
                        className="btn btn--small chef-card__submit"
                        disabled={timerExpired || !pendingChefBids[chef.id] || isLockedChefBid(chef.id) || belowMinimum}
                        onClick={(e) => { e.preventDefault(); handleSubmitSingleBid(chef.id); }}
                      >
                        Submit Bid
                      </button>
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
        disabled={
          timerExpired ||
          submitting ||
          (!isAdPhase && !isChefPhase) ||
          !hasAnyBidForPhase ||
          !hasEditableBid ||
          !canSubmitForPhase
        }
        title={submitTooltip}
      >
        {submitLabel}
      </button>
    </PageShell>
  );
}
