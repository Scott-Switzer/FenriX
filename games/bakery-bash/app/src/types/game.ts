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
// Stations + maintenance (game-design-proposal integration)
// ---------------------------------------------------------------------------

/**
 * Kitchen station identifiers. Each station owns a subset of products and one
 * piece of equipment whose health contributes to the per-station modifier.
 *
 *   bakery  → croissant + cookie, Oven
 *   deli    → bagel + sandwich,   Meat Slicer
 *   barista → coffee + matcha,    Espresso Machine
 */
export type StationId = "bakery" | "deli" | "barista";

/** Product → station mapping (mirrors backend `config.PRODUCT_CATALOG`). */
export const PRODUCT_STATION: Record<ProductKey, StationId> = {
  croissant: "bakery",
  cookie: "bakery",
  bagel: "deli",
  sandwich: "deli",
  coffee: "barista",
  matcha: "barista",
};

/**
 * Assignable tasks for a Maintenance Guy. `clean` restores cleanliness; the
 * three `repair_*` options restore the machine attached to the named station.
 * Array length in `PendingDecisionDraft.maintenanceTasks` must equal
 * `staffCounts.maintenanceGuys`.
 */
export type MaintenanceTask =
  | "clean"
  | "repair_oven"
  | "repair_slicer"
  | "repair_espresso";

export const MAINTENANCE_TASKS: MaintenanceTask[] = [
  "clean",
  "repair_oven",
  "repair_slicer",
  "repair_espresso",
];

/**
 * All four maintenance bars, each 0–100. Cloud Functions own these writes;
 * the client only reads / renders them.
 */
export interface MaintenanceBars {
  cleanliness: number;
  ovenHealth: number;
  slicerHealth: number;
  espressoHealth: number;
}

/**
 * Per-station sous chef counts + one maintenance guy bucket. This replaces
 * the single flat `sousChefCount` once the backend migrates to station-based
 * staffing. Both shapes are shipped in the decision payload during the
 * transition (see `PendingDecisionDraft`).
 */
export interface StaffCounts {
  bakerySousChefs: number;
  deliSousChefs: number;
  baristaSousChefs: number;
  maintenanceGuys: number;
}

/** Sum of sous chef fields only (excludes maintenance guys). */
export function totalSousChefs(counts: StaffCounts): number {
  return (
    counts.bakerySousChefs + counts.deliSousChefs + counts.baristaSousChefs
  );
}

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

/** Real skill tier written by the backend in `rounds/{N}.chefPool`. */
export type ChefSkillTier = "novel" | "intermediate" | "advanced";

/**
 * Backend shape of a chef in `rounds/round_{N}.chefPool`. Mirrors
 * `generateChefPool` in `backend/functions/modules/chef-system.js`.
 *
 * IMPORTANT — `specialties` is part of the backend payload but is
 * **forbidden** from reaching the rendered DOM (FRONTEND.md Hard UI Rule
 * #3). Consumers MUST convert to {@link ChefCardInput} before passing to
 * `<ChefCard>`; the cardʼs prop type deliberately omits specialties so a
 * compile-time error catches accidental leakage.
 */
export interface ChefPoolEntry {
  id: string;
  name: string;
  nationality: ChefNationality;
  gender: ChefGender;
  skillTier: ChefSkillTier;
  /** Hidden — do not render. Kept on the type so we can read the backend doc. */
  specialties: string[];
  minBidFloor: number;
}

/**
 * Strict subset of {@link ChefPoolEntry} that `<ChefCard>` accepts. Drop
 * `specialties` + `minBidFloor` at the type boundary so the component
 * physically cannot render them.
 */
export type ChefCardInput = Pick<
  ChefPoolEntry,
  "id" | "name" | "nationality" | "gender" | "skillTier"
>;

/**
 * Helper: strip forbidden fields from a `ChefPoolEntry` before handing it
 * to `<ChefCard>`. Use this in every call site so `specialties` never
 * survives into the rendered tree.
 */
export function toChefCardInput(chef: ChefPoolEntry): ChefCardInput {
  return {
    id: chef.id,
    name: chef.name,
    nationality: chef.nationality,
    gender: chef.gender,
    skillTier: chef.skillTier,
  };
}

export type AuctionTab = "chefs" | "ads";

// POST-01: per-product dynamic pricing
export type PriceZone = 'floor' | 'competitive' | 'premium';
export type ElasticityTier = 'high' | 'medium' | 'low';

export interface ProductPriceConfig {
  floor: number;
  competitiveRangeLow: number;
  competitiveRangeHigh: number;
  premiumRangeLow: number;
  premiumRangeHigh: number;
  ceiling: number;
  elasticityTier: ElasticityTier;
}

export interface MenuItem {
  id: MenuItemId;
  name: string;
  unlocked: boolean;
  basePrice: number;
  quantity: number;
  priceFloor: number;
  priceCeiling: number;
  elasticityTier: ElasticityTier;
}

// ---------------------------------------------------------------------------
// Pending decision / bids drafts
// ---------------------------------------------------------------------------

/**
 * Shape passed to the `submitDecision` Cloud Function. Mirrors
 * backend `decision-validation.js::validateDecision` input, plus the new
 * station-based staffing fields from the game-design-proposal.
 *
 * Dual-write note: the backend validator (pre BE-1..BE-10) only reads
 * `sousChefCount` + `sousChefAssignments` and silently drops unknown keys.
 * We also send `staffCounts` + `maintenanceTasks` so the backend can start
 * consuming them the moment the maintenance overhaul lands, with no
 * coordinated frontend release required.
 */
export interface PendingDecisionDraft {
  menu: Record<ProductKey, boolean>;
  quantities: Record<ProductKey, number>;
  /** Legacy flat count — derived from the sous-chef fields of `staffCounts`. */
  sousChefCount: number;
  /** Legacy per-product assignments — derived by spreading station counts. */
  sousChefAssignments: Record<ProductKey, number>;
  /** Station-based sous chef counts + maintenance guys. */
  staffCounts: StaffCounts;
  /** One task per maintenance guy; length must equal `staffCounts.maintenanceGuys`. */
  maintenanceTasks: MaintenanceTask[];
  /** POST-01: Finance-owned per-product prices. */
  productPrices: Record<ProductKey, number>;
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
  /** Per-hire base cost for Maintenance Guys. Defaults to the sous chef cost. */
  maintenanceBaseCost?: number;
  startingBudget?: number;
  unitCostPerProduct?: number;
  phaseDurations?: Record<string, number>;
  adBonuses?: Partial<Record<AdType, number>>;
  // Legacy (pre-rewrite seed doc). Kept so UI can fall back if the canonical
  // field is not yet present in Firestore.
  costPerStaffPerRound?: number;
}

/**
 * Round-result shape. The maintenance / chef-satisfaction fields are marked
 * optional because they are only emitted by the backend once BE-1..BE-10
 * (maintenance system + chef satisfaction overhaul) ship. Consumers must
 * render gracefully when they are missing.
 */
export interface RoundResult {
  round: number;
  revenue: number;
  customerCount: number;
  customerSatisfaction: number;
  auctionResults: {
    adWon: AdType | null;
    chefWon: string | null;
  };
  /** Aggregate chef-satisfaction 0–100 (average across specialty chefs). */
  chefSatisfactionScore?: number;
  /** Per-chef satisfaction map `{ chefId: 0-100 }`. */
  chefSatisfactionScores?: Record<string, number>;
  /** Maintenance bar snapshot at the end of this round. */
  maintenanceBars?: MaintenanceBars;
  /** Chef ids that voluntarily left this round (satisfaction ≤ 30%). */
  chefDepartures?: string[];
  /** Optional display names matched to `chefDepartures` ids, in order. */
  chefDepartureNames?: string[];
  /** Station-based staff counts the player submitted for this round. */
  staffCounts?: StaffCounts;
  /** Gross revenue (pre loan-shark repayment). */
  revenueGross?: number;
  /** Net revenue after loan-shark interest deducted. */
  revenueNet?: number;
  /** Principal borrowed this round; 0 means the loan shark stayed away. */
  amountBorrowed?: number;
  /** Interest paid on this round's borrow. */
  interestCharged?: number;
  /** Any station that hit sellout this round (`true` = ran out at least once). */
  selloutAnywhere?: boolean;
  /** Per-product unit-sold breakdown, used for the Results breakdown table. */
  productBreakdown?: Partial<Record<ProductKey, number>>;
  /** Ad surface the player won this round, with paid amount. */
  adWon?: AdType | null;
  adPaid?: number;
}

/**
 * Player team role (DEC-21, April 19 design proposal).
 *
 * - `operations` owns the Decide-phase submit (quantities, sous chefs,
 *   maintenance guys).
 * - `advertising` owns the ad-auction submit.
 * - `finance` owns the chef-auction submit + roster (layoff / continue).
 * - `solo` is the fallback when a player joins without teammates: all three
 *   buttons are enabled on their device. Also the default during the
 *   transition window before BE-20 / BE-21 ship per-team schema + role
 *   enforcement on the backend.
 *
 * Backend enforcement is BE-21 (open). Until that lands, the role here is
 * UI-only — the Cloud Functions accept submissions from any team member.
 */
export type PlayerRole = "operations" | "advertising" | "finance" | "solo";

export const PLAYER_ROLES: PlayerRole[] = [
  "operations",
  "advertising",
  "finance",
  "solo",
];

export const PLAYER_ROLE_LABELS: Record<PlayerRole, string> = {
  operations: "Operations",
  advertising: "Advertising",
  finance: "Finance",
  solo: "Solo (all roles)",
};

/** Phase-owning role mapping per DEC-21. `solo` always passes. */
export function roleOwnsDecide(role: PlayerRole): boolean {
  return role === "operations" || role === "solo";
}
export function roleOwnsAdBids(role: PlayerRole): boolean {
  return role === "advertising" || role === "solo";
}
export function roleOwnsChefBids(role: PlayerRole): boolean {
  return role === "finance" || role === "solo";
}
/**
 * Roster (lay-off + continue) is owned by Operations per the backend
 * contract. `backend/functions/index.js::layoffChef` and `continueFromRoster`
 * both call `assertRoleAllowed(role, ['operations'])`. The April 19 design
 * blurb read as "Finance owns … roster"; the shipped backend disagrees. If
 * the backend realigns to Finance later, flip this helper to match.
 */
export function roleOwnsRoster(role: PlayerRole): boolean {
  return role === "operations" || role === "solo";
}

/** Human-readable owner copy used in the disabled-button tooltip. */
export function ownerOfDecide(): string {
  return "Operations";
}
export function ownerOfAdBids(): string {
  return "Advertising";
}
export function ownerOfChefBids(): string {
  return "Finance";
}
export function ownerOfRoster(): string {
  return "Operations";
}

export interface Player {
  id: string;
  name: string;
  bakeryName: string;
  budget: number;
  cumulativeRevenue: number;
  /** Optional team name (DEC-23). Falls back to displayName if absent. */
  teamName?: string;
  /** Player team role (DEC-21). Defaults to "solo" until role picker is set. */
  role?: PlayerRole;
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
  /**
   * Live maintenance bars — owned by Cloud Functions, mirrored here via a
   * Firestore listener. Defaults to 100% for all bars before the first round.
   */
  maintenanceBars: MaintenanceBars;
  /**
   * Per-specialty-chef satisfaction 0–100. Written by Cloud Functions during
   * simulation; renders the low-satisfaction warnings on the results screen.
   */
  chefSatisfactionScores: Record<string, number>;
  /**
   * Live remaining budget for the player, mirrored from
   * `/games/{gameId}/players/{uid}.budgetCurrent`. `null` until the listener
   * has read at least once. Cloud Functions own writes; the client reads only.
   */
  budgetCurrent: number | null;
  /**
   * The local player's team role (DEC-21). Assigned by the backend on team
   * formation and mirrored from `/games/{gameId}/players/{uid}.role`.
   * Defaults to "solo" so a single-browser playtest keeps every submit
   * button enabled until backend role assignment ships (BE-20/BE-21).
   */
  role: PlayerRole;
  /**
   * The local player's team identifier (DEC-21). Mirrored from
   * `/games/{gameId}/players/{uid}.teamId`. `null` while the backend has
   * not yet assigned the player to a team — the /team page renders a
   * "waiting for assignment" state in that case.
   */
  teamId: string | null;
  /**
   * Shared team name (DEC-23). Read from
   * `/games/{gameId}/teams/{teamId}.name`. Editable by any teammate via
   * the `updateTeamName` callable. `null` while the team has not been
   * named yet — the leaderboard / lobby label falls back to the player's
   * `displayName` in that case.
   */
  teamName: string | null;
  /**
   * Server-driven phase end Timestamp (epoch ms) mirrored from
   * `/games/{gameId}.phaseEndsAt`. `null` while the game is paused or
   * before the field has been written. `RoundHeader` derives the live
   * countdown from `phaseEndsAt - Date.now()`.
   */
  phaseEndsAtMs: number | null;
}

/** Default maintenance bars (all 100%) used on game start / context reset. */
export const DEFAULT_MAINTENANCE_BARS: MaintenanceBars = {
  cleanliness: 100,
  ovenHealth: 100,
  slicerHealth: 100,
  espressoHealth: 100,
};

/** Default per-station staff counts (all zero). */
export const DEFAULT_STAFF_COUNTS: StaffCounts = {
  bakerySousChefs: 0,
  deliSousChefs: 0,
  baristaSousChefs: 0,
  maintenanceGuys: 0,
};
