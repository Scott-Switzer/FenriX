// ---------------------------------------------------------------------------
// Phase model
// ---------------------------------------------------------------------------
//
// The canonical phase enum mirrors the backend module
// `backend/functions/modules/phases.js`. In Firestore the `phase` field is
// stored as a *string*, but most in-round phases carry a `round_N_` prefix:
//
//   lobby
//   round_1_email, round_1_decide, round_1_bid_ad, round_1_bid_chef, round_1_roster
//   simulating, results_ready
//   round_2_email ... round_5_results_ready
//   game_over
//
// Components should use `parseGamePhase` to derive the base-phase name (e.g.
// "decide") and the round number rather than string-comparing raw phase values.
// ---------------------------------------------------------------------------

/**
 * Base-phase names — the "canonical" phase identifier independent of round.
 * These match `PHASE_ORDER` + terminal phases in the backend phases module.
 */
export type BasePhase =
  | "lobby"
  | "email"
  | "decide"
  | "bid_ad"
  | "bid_chef"
  | "roster"
  | "simulating"
  | "results_ready"
  | "game_over";

/**
 * Raw phase string as stored in Firestore `games/{gameId}.phase`.
 * We keep this as `string` to allow any `round_${N}_${BasePhase}` template.
 */
export type GamePhaseString = string;

const BASE_PHASES: ReadonlySet<BasePhase> = new Set<BasePhase>([
  "lobby",
  "email",
  "decide",
  "bid_ad",
  "bid_chef",
  "roster",
  "simulating",
  "results_ready",
  "game_over",
]);

const LEGACY_PHASE_ALIASES: Record<string, BasePhase> = {
  closing_hours: "decide",
  auction: "bid_ad",
  open_for_business: "simulating",
  results: "results_ready",
};

export interface ParsedPhase {
  round: number | null;
  base: BasePhase;
}

/**
 * Parse a Firestore phase string into `{ round, base }`. Accepts:
 *   "lobby"          → { round: 0,       base: "lobby" }
 *   "game_over"      → { round: null,    base: "game_over" }
 *   "simulating"     → { round: fallback, base: "simulating" }
 *   "results_ready"  → { round: fallback, base: "results_ready" }
 *   "round_2_decide" → { round: 2,       base: "decide" }
 * Falls back to `{ round: fallbackRound, base: "lobby" }` for malformed input.
 */
export function parseGamePhase(
  phase: GamePhaseString | null | undefined,
  fallbackRound = 0
): ParsedPhase {
  if (!phase || typeof phase !== "string") {
    return { round: fallbackRound, base: "lobby" };
  }
  if (phase === "lobby") return { round: 0, base: "lobby" };
  if (phase === "game_over") return { round: null, base: "game_over" };
  if (phase === "simulating" || phase === "results_ready") {
    return { round: fallbackRound, base: phase };
  }
  if (LEGACY_PHASE_ALIASES[phase]) {
    return { round: fallbackRound, base: LEGACY_PHASE_ALIASES[phase] };
  }
  const match = /^round_(\d+)_(.+)$/.exec(phase);
  if (match) {
    const round = Number(match[1]);
    const raw = match[2];
    const base = (LEGACY_PHASE_ALIASES[raw] || raw) as BasePhase;
    if (BASE_PHASES.has(base)) return { round, base };
  }
  return { round: fallbackRound, base: "lobby" };
}

/** True if the current phase allows decision submission. */
export function isDecidePhase(phase: GamePhaseString | null | undefined) {
  return parseGamePhase(phase).base === "decide";
}

/** True if the current phase is an auction phase (ads or chefs). */
export function isBidPhase(phase: GamePhaseString | null | undefined) {
  const base = parseGamePhase(phase).base;
  return base === "bid_ad" || base === "bid_chef";
}

// ---------------------------------------------------------------------------
// Product keys / menu
// ---------------------------------------------------------------------------

/**
 * Canonical product keys mirroring backend `config.js` `PRODUCT_KEYS`.
 * Do not use legacy names (`latte`, `matcha-latte`) anywhere.
 */
export type ProductKey =
  | "croissant"
  | "cookie"
  | "bagel"
  | "sandwich"
  | "coffee"
  | "matcha";

export const PRODUCT_KEYS: ProductKey[] = [
  "croissant",
  "cookie",
  "bagel",
  "sandwich",
  "coffee",
  "matcha",
];

export const BASE_MENU: ProductKey[] = ["croissant", "cookie", "bagel"];
export const OPTIONAL_MENU: ProductKey[] = ["sandwich", "coffee", "matcha"];

// Legacy alias — existing UI code refers to `MenuItemId`. Keep it pointing at
// the canonical product key so older files compile while we migrate.
export type MenuItemId = ProductKey;

// ---------------------------------------------------------------------------
// Ad + chef types
// ---------------------------------------------------------------------------

/** Canonical backend ad type identifiers (mixed-case). */
export type AdType = "TV" | "Billboard" | "Radio" | "Newspaper";

export const AD_TYPES: AdType[] = ["TV", "Billboard", "Radio", "Newspaper"];

export type ChefNationality = "american" | "french" | "italian" | "japanese";
export type ChefGender = "m" | "f";
/**
 * Client-facing skill tier. Backend uses `novel`/`intermediate`/`advanced`; the
 * legacy `low`/`medium`/`high` labels remain here until the auction UI is
 * migrated to the real chef pool.
 */
export type SkillLevel = "low" | "medium" | "high";

export interface ChefListing {
  id: string;
  nationality: ChefNationality;
  gender: ChefGender;
  name: string;
  skill: SkillLevel;
  multiplier: number;
}

export type AuctionTab = "chefs" | "ads";

export interface MenuItem {
  id: MenuItemId;
  name: string;
  unlocked: boolean;
  basePrice: number;
  quantity: number;
}

// ---------------------------------------------------------------------------
// Pending decision / bids drafts
// ---------------------------------------------------------------------------

/**
 * Shape passed to the `submitDecision` Cloud Function. Mirrors
 * backend `decision-validation.js::validateDecision` input.
 */
export interface PendingDecisionDraft {
  menu: Record<ProductKey, boolean>;
  quantities: Record<ProductKey, number>;
  sousChefCount: number;
  sousChefAssignments: Record<ProductKey, number>;
}

/** Shape passed as `adBids` to `submitBids({ bidType: "ad" })`. */
export type PendingAdBidsDraft = Record<AdType, number>;

/**
 * Local map of `chefId → bid amount` for the auction UI. When submitting, we
 * convert this to the `[{chefId, amount}]` array the backend expects.
 */
export type PendingChefBidsDraft = Record<string, number>;

/**
 * Subset of `games/{gameId}/config/params` the frontend actually reads. Kept
 * permissive (partial, optional) because the backend is the sole writer and
 * may expand the document over time.
 */
export interface GameConfigParams {
  // Canonical (backend config.js)
  sousChefBaseCost?: number;
  startingBudget?: number;
  unitCostPerProduct?: number;
  phaseDurations?: Record<string, number>;
  adBonuses?: Partial<Record<AdType, number>>;
  // Legacy (pre-rewrite seed doc). Kept so UI can fall back if the canonical
  // field is not yet present in Firestore.
  costPerStaffPerRound?: number;
}

export interface RoundResult {
  round: number;
  revenue: number;
  customerCount: number;
  customerSatisfaction: number;
  auctionResults: {
    adWon: AdType | null;
    chefWon: string | null;
  };
}

export interface Player {
  id: string;
  name: string;
  bakeryName: string;
  budget: number;
  cumulativeRevenue: number;
}

export interface GameState {
  gameId: string | null;
  playerId: string | null;
  gameCode: string | null;
  /** Raw phase string from Firestore. Use `parseGamePhase` to derive logic. */
  phase: GamePhaseString;
  currentRound: number;
  totalRounds: number;
  player: Player | null;
  players: Player[];
  roundResults: RoundResult[];
  timeRemaining: number | null;
  auctionTab: AuctionTab;
  pendingDecision: PendingDecisionDraft;
  pendingAdBids: PendingAdBidsDraft;
  pendingChefBids: PendingChefBidsDraft;
  config: GameConfigParams | null;
  /** Local flag — true after a successful `submitDecision` this round. */
  decisionSubmitted: boolean;
  /** Local flag — true after a successful `submitBids` (ad) this round. */
  adBidsSubmitted: boolean;
  /** Local flag — true after a successful `submitBids` (chef) this round. */
  chefBidsSubmitted: boolean;
}
