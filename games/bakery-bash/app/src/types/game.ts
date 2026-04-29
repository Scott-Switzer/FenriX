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

// Apr 28 2026 — station-unlock economy. BASE_MENU = the three "starter"
// products (one per station, free at game start, can't be removed).
// OPTIONAL_MENU = the three locked products that must be unlocked via
// `purchaseProduct` before they can be added to the menu.
//   bakery  → croissant (starter), cookie   (locked)
//   deli    → bagel    (starter), sandwich (locked)
//   barista → coffee   (starter), matcha   (locked)
export const BASE_MENU: ProductKey[] = ["croissant", "bagel", "coffee"];
export const OPTIONAL_MENU: ProductKey[] = ["cookie", "sandwich", "matcha"];

/** Default starter set every team begins with — mirrors backend config. */
export const DEFAULT_UNLOCKED_PRODUCTS: ProductKey[] = [
  "croissant",
  "bagel",
  "coffee",
];

/**
 * Default flat cost (USD) per OPTIONAL_MENU unlock. Mirrors
 * `productUnlockCost` in backend `config.js`. Used as a fallback only —
 * the canonical value comes through the `/games/{gameId}/config/params`
 * listener.
 */
export const DEFAULT_PRODUCT_UNLOCK_COST = 500;

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
  /**
   * Per-chef minimum bid set by the backend (see BE chef-system module).
   * Rendered next to `Top Bid` on the auction card and enforced client-side
   * as a "bid must be ≥ minBidFloor" check before submit. Optional because
   * the cosmetic placeholder pool (pre-backend snapshot) has no floor.
   */
  minBidFloor?: number;
}

/** Real skill tier written by the backend in `rounds/{N}.chefPool`. */
export type ChefSkillTier = "novel" | "intermediate" | "advanced";

export type EquipmentGrade = 'F' | 'E' | 'D' | 'C' | 'B' | 'A';

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
  /** When true, simulation will deduct tierUpgradeCost(currentGrade) and bump grade. */
  equipmentUpgradePurchased?: boolean;
  /** POST-01: Finance-owned per-product prices. */
  productPrices: Record<ProductKey, number>;
  /**
   * Apr 28 2026 — running tally of immediate-charge purchases made during
   * this round's decide phase (product unlocks, competitor intel, chef-data
   * tiers). Surfaces these on the "Total Committed This Round" receipt as a
   * "Miscellaneous" line so players see the spend line up with the budget
   * deduction. Reset to 0 on round transition (see SET_ROUND in
   * GameContext); never sent to the backend (server-authoritative budget
   * deductions own the actual ledger).
   */
  miscSpent: number;
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
  /** Flat per-round cost per maintenance staffer. Defaults to 20. */
  maintenanceStaffCost?: number;
  startingBudget?: number;
  unitCostPerProduct?: number;
  phaseDurations?: Record<string, number>;
  adBonuses?: Partial<Record<AdType, number>>;
  adBidMinimums?: Partial<Record<AdType, number>>;
  /** Cost to purchase last round's competitor decisions CSV. */
  competitorInsightCost?: number;
  /** Cost to purchase the static nationality → specialty CSV. */
  chefDataTier1Cost?: number;
  /** Cost to purchase the full per-chef profile dump for the current round. */
  chefDataTier2Cost?: number;
  /**
   * Apr 28 2026 — flat cost (USD) per product unlock. Falls back to
   * DEFAULT_PRODUCT_UNLOCK_COST when missing.
   */
  productUnlockCost?: number;
  /**
   * Roster cap for specialty chefs (PR #108 added the consumer in
   * RosterPhasePage but missed declaring the field — restoring it here
   * unblocks `tsc -b`). Defaults to 3 when missing.
   */
  specialtyChefCap?: number;
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
  /** Optional display names matched to departed chef ids, in order. */
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
  /**
   * P1 (2026-04-27): decision inputs surfaced from the backend so the CSV
   * export can include them. Required for in-game model re-training —
   * without these the CSV is outcome-only.
   */
  /** Resolved per-product prices the team submitted this round (POST-01). */
  productPrices?: Partial<Record<ProductKey, number | null>>;
  /** Per-product quantities the team stocked this round (decision input). */
  quantitiesStocked?: Partial<Record<ProductKey, number>>;
  /** Number of products the team offered (3–6, base menu always on). */
  numProducts?: number;
  /**
   * P2 (2026-04-27): per-day outcome breakdown. A round = 1 month = 30
   * simulated days; each entry here is a single day's outcome with the
   * decision inputs constant across the round (read from the round-level
   * fields above). Empty array on legacy round docs that pre-date P2.
   */
  dailyBreakdown?: Array<{
    day: number;
    revenueGross: number;
    revenueNet: number;
    /** Apportioned share of the monthly loan-shark borrow (sum across days = monthly). */
    amountBorrowed?: number;
    /** Apportioned share of the monthly loan-shark interest (sum across days = monthly). */
    interestCharged?: number;
    customerCount: number;
    aggregateSatisfactionPct: number;
  }>;
  /** Ad surface the player won this round, with paid amount. */
  adWon?: AdType | null;
  adWins?: AdType[];
  adPaid?: number;
  chefsWon?: Array<{ id?: string; name?: string }>;
  chefBidPaid?: number;
  /**
   * Curveball events that landed on this team during the round. Optional
   * because not every round will have one, and older round docs might
   * predate the event system entirely. The frontend renders these as
   * cards in the Events section of the Results screen.
   */
  events?: RoundEvent[];
  /**
   * M-21 (2026-04-28): "What hurt this round?" signals grouped onto one
   * object so the FE (B-07) can render the Results-screen panel without
   * cherry-picking five separate fields. Satisfaction is fill-rate-driven
   * here; price affects demand not satisfaction; cleanliness affects foot
   * traffic not satisfaction — see M-21 investigation in tasks-april-28.md
   * for the full rationale on why these are sibling signals rather than
   * "components of satisfaction".
   */
  roundSignals?: {
    /** Aggregate fill-rate satisfaction, 0–100. */
    satisfactionPct: number;
    /** Per-product fill-rate satisfaction (subset of products on the menu). */
    perProductSatisfaction: Partial<Record<ProductKey, number>>;
    /** Equipment cleanliness letter grade (A–F). */
    cleanlinessGrade: string;
    /** Numeric cleanliness score, 0–100. */
    cleanlinessScore: number;
    /**
     * Average of `min(priceDemandMultiplier, 1.0) × 100` across products on
     * the menu. 100 = demand-optimal pricing. < 100 means premium prices
     * cost the team some demand share.
     */
    priceCompetitivenessPct: number;
  };
}

/** One row of the curveball-events feed shown on the Results screen. */
export type RoundEventKind = "food-safety-inspection";

export interface RoundEvent {
  kind: RoundEventKind;
  /** Day-of-month numbers (1–31) when the event occurred this round. */
  days?: number[];
  amount?: number;
  /** Inspection cleanliness reading 0–100 (inspection only). */
  cleanlinessPct?: number;
  /** Inspection rating label (Poor / Sufficient / Good / Excellent). */
  rating?: "Poor" | "Sufficient" | "Good" | "Excellent";
}

/**
 * Player team role (DEC-21, April 19 design proposal).
 *
 * - `operations` owns the Decide-phase submit (quantities, sous chefs,
 *   maintenance guys).
 * - `advertising` owns the ad-auction submit AND the chef-auction submit
 *   (M-18, 2026-04-28: chef bids moved here under the Q6 role split; the
 *   FE label is "Analyst" — see S-03).
 * - `finance` owns the roster (layoff / continue).
 * - `solo` is the fallback when a player joins without teammates: all three
 *   buttons are enabled on their device. Also the default during the
 *   transition window before BE-20 / BE-21 ship per-team schema + role
 *   enforcement on the backend.
 *
 * Backend enforcement is BE-21 (open). Until that lands, the role here is
 * UI-only — the Cloud Functions accept submissions from any team member.
 */
export type PlayerRole = "operations" | "advertising" | "finance" | "solo";

/**
 * S-03 (2026-04-29): the role formerly called "Bidder" / "Advertising"
 * is now "Analyst" — owns ad bids, chef bids (M-18), data purchases (B-05),
 * and the monthly CSV download (S-07). The backend role string stays
 * `advertising` for compatibility (changing it would invalidate every
 * in-flight game doc). Only the player-facing label moves.
 */
export const PLAYER_ROLE_LABELS: Record<PlayerRole, string> = {
  operations: "Operations",
  advertising: "Analyst",
  finance: "Finance",
  solo: "Solo (all roles)",
};

/**
 * FE-I15 team-fallback — returns true when *nobody on the team* currently
 * holds any of the required specialist roles. Lets us relax the role-gate
 * helpers below (and mirrors the backend's `assertRoleAllowed` fallback
 * in `backend/functions/index.js`).
 *
 * Pass the team's `roleAssignments` map (uid → role | null) and the list
 * of specialist roles the caller is checking against. Returns `true` if
 * no assignment equals any of those roles. An empty / missing assignments
 * map is treated as "no one holds the role" so a team that hasn't
 * hydrated yet still unlocks the submit button.
 */
function teamRoleIsVacant(
  teamRoleAssignments: Record<string, PlayerRole | null> | undefined | null,
  requiredRoles: PlayerRole[],
): boolean {
  if (!teamRoleAssignments) return true;
  const held = Object.values(teamRoleAssignments).filter(
    (r): r is PlayerRole => !!r,
  );
  return !held.some((r) => requiredRoles.includes(r));
}

/**
 * Phase-owning role mapping per DEC-21. `solo` always passes. The
 * optional `teamRoleAssignments` argument (FE-I15) additionally lets
 * any teammate submit when no one on the team holds the specialist
 * role — covers 2-player teams, cleared roles, and mid-game
 * disconnects. Call sites that don't yet plumb team state through fall
 * back to the strict role-only check.
 */
export function roleOwnsDecide(
  role: PlayerRole,
  teamRoleAssignments?: Record<string, PlayerRole | null> | null,
): boolean {
  if (role === "operations" || role === "solo") return true;
  return teamRoleIsVacant(teamRoleAssignments ?? null, ["operations"]);
}
export function roleOwnsAdBids(
  role: PlayerRole,
  teamRoleAssignments?: Record<string, PlayerRole | null> | null,
): boolean {
  if (role === "advertising" || role === "solo") return true;
  return teamRoleIsVacant(teamRoleAssignments ?? null, ["advertising"]);
}
export function roleOwnsChefBids(
  role: PlayerRole,
  teamRoleAssignments?: Record<string, PlayerRole | null> | null,
): boolean {
  // M-18 (2026-04-28): chef bid ownership moved from Finance to the renamed
  // Analyst role (backend role string stays "advertising" for compatibility;
  // only the FE label changes — see S-03). Analyst now owns BOTH ad bids
  // and chef bids per the Q6 role split.
  if (role === "advertising" || role === "solo") return true;
  return teamRoleIsVacant(teamRoleAssignments ?? null, ["advertising"]);
}
export function roleOwnsPricing(
  role: PlayerRole,
  teamRoleAssignments?: Record<string, PlayerRole | null> | null,
): boolean {
  if (role === "finance" || role === "solo") return true;
  return teamRoleIsVacant(teamRoleAssignments ?? null, ["finance"]);
}
/**
 * M-17 (2026-04-28): quantities ownership moved from Operations to Finance.
 * Mirror semantics to `roleOwnsPricing` since the same role submits both
 * fields via the unified `submitPrices` callable. K-10/K-01 use this helper
 * to gate the quantity steppers in BakeryView per the new role split.
 */
export function roleOwnsQuantities(
  role: PlayerRole,
  teamRoleAssignments?: Record<string, PlayerRole | null> | null,
): boolean {
  if (role === "finance" || role === "solo") return true;
  return teamRoleIsVacant(teamRoleAssignments ?? null, ["finance"]);
}
/**
 * Roster (lay-off + continue) is owned by Operations per the backend
 * contract. `backend/functions/index.js::layoffChef` and `continueFromRoster`
 * both call `assertRoleAllowed(role, ['operations'])`. The April 19 design
 * blurb read as "Finance owns … roster"; the shipped backend disagrees. If
 * the backend realigns to Finance later, flip this helper to match.
 */
export function roleOwnsRoster(
  role: PlayerRole,
  teamRoleAssignments?: Record<string, PlayerRole | null> | null,
): boolean {
  if (role === "operations" || role === "solo") return true;
  return teamRoleIsVacant(teamRoleAssignments ?? null, ["operations"]);
}

/**
 * Human-readable owner copy used in the disabled-button tooltip.
 * Always delegates to `PLAYER_ROLE_LABELS` so the copy here stays in lockstep
 * with the role-picker and the How-to-Play page (post S-03: `advertising → "Analyst"`).
 */
export function ownerOfDecide(): string {
  return PLAYER_ROLE_LABELS.operations;
}
export function ownerOfAdBids(): string {
  return PLAYER_ROLE_LABELS.advertising;
}
export function ownerOfChefBids(): string {
  return PLAYER_ROLE_LABELS.advertising;
}
export function ownerOfRoster(): string {
  return PLAYER_ROLE_LABELS.operations;
}

export interface Player {
  id: string;
  name: string;
  bakeryName: string;
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
  auctionTab: AuctionTab;
  pendingDecision: PendingDecisionDraft;
  pendingAdBids: PendingAdBidsDraft;
  pendingChefBids: PendingChefBidsDraft;
  config: GameConfigParams | null;
  /** Local flag — true after a successful `submitDecision` this round. */
  decisionSubmitted: boolean;
  /** Local flag — true after a successful `submitPrices` this round (POST-01). */
  pricesSubmitted: boolean;
  /** Local flag — true after a successful `submitBids` (ad) this round. */
  adBidsSubmitted: boolean;
  /** Local flag — true after a successful `submitBids` (chef) this round. */
  chefBidsSubmitted: boolean;
  /** Equipment grade A-F. Default C; bumps one tier per round when upgraded. */
  equipmentGrade: EquipmentGrade;
  /** Cleanliness internal score 0-100. Drifts each round. */
  cleanlinessScore: number;
  /** Cleanliness grade derived from cleanlinessScore — cached for UI. */
  cleanlinessGrade: EquipmentGrade;
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
   * Live uid → role map for the local player's team (FE-I15). Mirrored
   * from `/games/{gameId}/teams/{teamId}.roleAssignments`. Used by the
   * role-gate helpers (`roleOwnsDecide`, etc.) to relax the gate when
   * nobody on the team holds the required specialist role — for 2-
   * player teams, cleared roles, or mid-game disconnects. Empty map
   * before the listener has read the doc (strict gate until then).
   */
  teamRoleAssignments: Record<string, PlayerRole | null>;
  /**
   * Apr 28 2026 — products the team has unlocked (always includes the
   * three BASE_MENU starters). Mirrored from
   * `/games/{gameId}/teams/{teamId}.unlockedProducts`. The Bakery view
   * disables the "Add" affordance for any OPTIONAL_MENU product not in
   * this list and shows an "Unlock for $X" button instead.
   */
  unlockedProducts: ProductKey[];
  /**
   * Apr 28 2026 — total number of locked products the team has paid to
   * unlock this game. Drives the cost ladder lookup for the *next*
   * unlock. Mirrored from `/games/{gameId}/teams/{teamId}.unlocksPurchased`.
   */
  unlocksPurchased: number;
  /**
   * Server-driven phase end Timestamp (epoch ms) mirrored from
   * `/games/{gameId}.phaseEndsAt`. `null` while the game is paused or
   * before the field has been written. `RoundHeader` derives the live
   * countdown from `phaseEndsAt - Date.now()`.
   */
  phaseEndsAtMs: number | null;
  /**
   * Leaderboard rankings mirrored from
   * `/games/{gameId}/leaderboard/latest.rankings` by `useGameListener`.
   * Ordered by `cumulativeRevenue` descending (backend sorts).
   */
  leaderboard: LeaderboardRanking[];
  /**
   * User-facing error from the `useGameListener` leaderboard onSnapshot.
   * `null` on a healthy listener. Set when the snapshot errors (permission
   * denied, network failure, etc.) so `LeaderboardPage` can surface a
   * banner instead of silently showing "Waiting for first round results…"
   * forever.
   */
  leaderboardError: string | null;
  /**
   * CSVs the team has acquired this game and can re-download from the
   * CSV Inbox header button. Includes competitor-intel purchases, Tier 1
   * specialty-chef tables, Tier 2 chef-profile dumps, and anything else
   * the player would otherwise lose the moment the sidebar popup closes.
   *
   * The round-history results CSV is *not* stored here — it is derived
   * on demand from `roundResults` so it always reflects the latest data
   * (see `downloadResultsCsv`).
   */
  acquiredCsvs: AcquiredCsv[];
}

/**
 * One entry in the CSV Inbox. `kind` drives the icon + grouping; `label`
 * is the human-readable title shown in the list; `round` (when present)
 * pins the CSV to the round it was generated / purchased for.
 */
export type AcquiredCsvKind =
  | "competitor-intel"
  | "chef-tier1"
  | "chef-tier2";

export interface AcquiredCsv {
  id: string;
  kind: AcquiredCsvKind;
  label: string;
  round?: number;
  acquiredAtMs: number;
  csv: string;
  filename: string;
}

/**
 * One row of the live leaderboard. Source: `simulateRound` in
 * `backend/functions/index.js` writes this to the `rankings` field of
 * `/games/{gameId}/leaderboard/latest`.
 *
 * `lastRoundRevenue` and `rankChange` are written only after BE-7 lands;
 * the UI must render gracefully when they are absent.
 */
export interface LeaderboardRanking {
  rank: number;
  playerId: string;
  displayName: string;
  bakeryName?: string;
  revenueNet?: number;
  cumulativeRevenue?: number;
  /** Revenue earned this round only (post–loan-shark). */
  lastRoundRevenue?: number;
  /** Positive = moved up; negative = moved down; 0 = no change. */
  rankChange?: number;
  /** Budget after this round (used for tie-break in conclusion). */
  budgetAfter?: number;
}

/**
 * Default per-station staff counts (all zero).
 *
 * Barlava follow-up: maintenanceGuys flipped from 2 → 0. The two free
 * maintenance hires were a leftover starter-budget assumption from an
 * earlier balance pass; players reported the "ghost spend" was confusing
 * since the receipt didn't otherwise account for them. Backend
 * `decision-validation.js` was bumped to match.
 */
export const DEFAULT_STAFF_COUNTS: StaffCounts = {
  bakerySousChefs: 0,
  deliSousChefs: 0,
  baristaSousChefs: 0,
  maintenanceGuys: 0,
};
