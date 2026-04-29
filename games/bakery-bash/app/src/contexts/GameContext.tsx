import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
  type Dispatch,
} from "react";
import { httpsCallable } from "firebase/functions";
import {
  PRODUCT_KEYS,
  BASE_MENU,
  AD_TYPES,
  DEFAULT_STAFF_COUNTS,
  DEFAULT_UNLOCKED_PRODUCTS,
  parseGamePhase,
  totalSousChefs,
  type AcquiredCsv,
  type AdType,
  type AuctionTab,
  type EquipmentGrade,
  type GameConfigParams,
  type GamePhaseString,
  type GameState,
  type LeaderboardRanking,
  type PendingAdBidsDraft,
  type PendingChefBidsDraft,
  type PendingDecisionDraft,
  type Player,
  type PlayerRole,
  type ProductKey,
  type RoundResult,
  type StaffCounts,
} from "../types/game";
import { DEFAULT_PRICES } from "../lib/pricing";
import { functions } from "../lib/firebase";

function buildDefaultDecisionDraft(): PendingDecisionDraft {
  const menu = PRODUCT_KEYS.reduce((acc, p) => {
    acc[p] = BASE_MENU.includes(p);
    return acc;
  }, {} as Record<ProductKey, boolean>);
  const quantities = PRODUCT_KEYS.reduce((acc, p) => {
    acc[p] = 0;
    return acc;
  }, {} as Record<ProductKey, number>);
  const sousChefAssignments = PRODUCT_KEYS.reduce((acc, p) => {
    acc[p] = 0;
    return acc;
  }, {} as Record<ProductKey, number>);
  // POST-01: seed with catalog base prices so the PriceInput renders in the
  // Competitive zone and the nudge/minus button works out of the box for a
  // fresh session. SET_ROUND preserves whatever prices are currently in
  // state (backend carry-over semantics); the player-doc listener in
  // `GamePage.tsx` additionally hydrates from `pendingDecision.productPrices`
  // whenever Firestore reports a change.
  const productPrices = PRODUCT_KEYS.reduce((acc, p) => {
    acc[p] = DEFAULT_PRICES[p];
    return acc;
  }, {} as Record<ProductKey, number>);

  return {
    menu,
    quantities,
    sousChefCount: totalSousChefs(DEFAULT_STAFF_COUNTS),
    sousChefAssignments,
    staffCounts: { ...DEFAULT_STAFF_COUNTS },
    productPrices,
    miscSpent: 0,
  };
}

function buildDefaultAdBidsDraft(): PendingAdBidsDraft {
  return AD_TYPES.reduce((acc, ad) => {
    acc[ad] = 0;
    return acc;
  }, {} as PendingAdBidsDraft);
}

const DEFAULT_PENDING_DECISION = buildDefaultDecisionDraft();
const DEFAULT_PENDING_AD_BIDS = buildDefaultAdBidsDraft();
const DEFAULT_PENDING_CHEF_BIDS: PendingChefBidsDraft = {};

const initialState: GameState = {
  gameId: null,
  playerId: null,
  gameCode: null,
  phase: "lobby",
  currentRound: 0,
  totalRounds: 5,
  player: null,
  players: [],
  roundResults: [],
  auctionTab: "chefs",
  pendingDecision: DEFAULT_PENDING_DECISION,
  pendingAdBids: DEFAULT_PENDING_AD_BIDS,
  pendingChefBids: DEFAULT_PENDING_CHEF_BIDS,
  config: null,
  decisionSubmitted: false,
  pricesSubmitted: false,
  adBidsSubmitted: false,
  chefBidsSubmitted: false,
  equipmentGrade: 'C',
  cleanlinessGrade: 'B',
  cleanlinessScore: 75,
  budgetCurrent: null,
  // DEC-21 default: solo / all-roles. The real role + team assignment is
  // written by the backend onto the player doc and the team doc; the
  // player doc listener mirrors them into context. "solo" stays the
  // default so a single-browser playtest keeps every submit button
  // enabled before BE-20/BE-21 ship.
  role: "solo",
  teamId: null,
  teamName: null,
  teamRoleAssignments: {},
  // Apr 28 2026 — start every team at the starter set (one product per
  // station). The team-doc listener overwrites this once it reads the
  // canonical `unlockedProducts` from Firestore.
  unlockedProducts: [...DEFAULT_UNLOCKED_PRODUCTS],
  unlocksPurchased: 0,
  phaseEndsAtMs: null,
  leaderboard: [],
  leaderboardError: null,
  acquiredCsvs: [],
};

type GameAction =
  | {
      type: "JOIN_GAME";
      payload: {
        gameId: string;
        playerId: string;
        gameCode: string;
        player: Player;
      };
    }
  | { type: "SET_ROLE"; payload: PlayerRole }
  | { type: "SET_TEAM_ID"; payload: string | null }
  | { type: "SET_TEAM_NAME"; payload: string | null }
  | {
      type: "SET_TEAM_ROLE_ASSIGNMENTS";
      payload: Record<string, PlayerRole | null>;
    }
  | { type: "SET_PHASE_ENDS_AT"; payload: number | null }
  | { type: "SET_PHASE"; payload: GamePhaseString }
  | { type: "SET_ROUND"; payload: number }
  | { type: "SET_PLAYERS"; payload: Player[] }
  | { type: "ADD_RESULT"; payload: RoundResult }
  | { type: "UPDATE_PLAYER"; payload: Partial<Player> }
  | { type: "SET_AUCTION_TAB"; payload: AuctionTab }
  | { type: "SET_CONFIG"; payload: GameConfigParams | null }
  | {
      type: "UPDATE_PENDING_DECISION";
      payload: {
        menu?: Partial<Record<ProductKey, boolean>>;
        quantities?: Partial<Record<ProductKey, number>>;
        sousChefAssignments?: Partial<Record<ProductKey, number>>;
        staffCounts?: Partial<StaffCounts>;
        productPrices?: Partial<Record<ProductKey, number>>;
        equipmentUpgradePurchased?: boolean;
        // K-03 (2026-04-29): teammates' miscSpent is mirrored via the
        // team-pending listener. Setting an absolute value (not delta)
        // is correct here — the team doc holds the canonical running
        // total, and `ADD_MISC_SPEND` (incremental) is reserved for the
        // local tab that actually fired the purchase.
        miscSpent?: number;
      };
    }
  | {
      type: "UPDATE_PENDING_AD_BID";
      payload: { adType: AdType; amount: number };
    }
  | {
      type: "UPDATE_PENDING_CHEF_BID";
      payload: { chefId: string; amount: number };
    }
  | { type: "RESET_PENDING" }
  | { type: "SET_DECISION_SUBMITTED"; payload: boolean }
  | { type: "SET_PRICES_SUBMITTED"; payload: boolean }
  | { type: "SET_AD_BIDS_SUBMITTED"; payload: boolean }
  | { type: "SET_CHEF_BIDS_SUBMITTED"; payload: boolean }
  | { type: "SET_BUDGET"; payload: number | null }
  | {
      type: "UPDATE_PLAYER_GRADES";
      payload: {
        equipmentGrade: EquipmentGrade;
        cleanlinessGrade: EquipmentGrade;
        cleanlinessScore: number;
      };
    }
  | { type: "SET_LEADERBOARD"; payload: LeaderboardRanking[] }
  | { type: "SET_LEADERBOARD_ERROR"; payload: string | null }
  | { type: "ADD_ACQUIRED_CSV"; payload: AcquiredCsv }
  | { type: "ADD_MISC_SPEND"; payload: { amount: number } }
  | {
      type: "SET_TEAM_UNLOCKS";
      payload: { unlockedProducts: ProductKey[]; unlocksPurchased: number };
    }
  | { type: "RESET" };

function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "JOIN_GAME":
      // Start from initialState so all round/phase/draft state is clean.
      // Spreading state would carry over stale data from a previous game.
      return {
        ...initialState,
        gameId: action.payload.gameId,
        playerId: action.payload.playerId,
        gameCode: action.payload.gameCode,
        player: action.payload.player,
      };

    case "SET_ROLE":
      return state.role === action.payload
        ? state
        : { ...state, role: action.payload };

    case "SET_TEAM_ID":
      return state.teamId === action.payload
        ? state
        : { ...state, teamId: action.payload };

    case "SET_TEAM_NAME":
      return state.teamName === action.payload
        ? state
        : { ...state, teamName: action.payload };

    case "SET_TEAM_ROLE_ASSIGNMENTS": {
      // Skip the render if the map is structurally identical. Cheap
      // shallow compare — the listener writes a fresh object on every
      // snapshot, so reference equality alone isn't enough to avoid
      // re-rendering every role-gated component on every team update.
      const prev = state.teamRoleAssignments;
      const next = action.payload;
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length === nextKeys.length) {
        let identical = true;
        for (const k of nextKeys) {
          if (prev[k] !== next[k]) {
            identical = false;
            break;
          }
        }
        if (identical) return state;
      }
      return { ...state, teamRoleAssignments: next };
    }

    case "SET_PHASE_ENDS_AT":
      return state.phaseEndsAtMs === action.payload
        ? state
        : { ...state, phaseEndsAtMs: action.payload };

    case "SET_PHASE": {
      if (state.phase === action.payload) return state;
      return { ...state, phase: action.payload };
    }

    case "SET_ROUND": {
      if (state.currentRound === action.payload) return state;
      // New round → reset any local per-round drafts/submission flags.
      // POST-01: preserve `productPrices` across rounds to match the
      // backend's price carry-over (resolvePriceForSim). Without this,
      // Finance's nudged prices flash back to catalog defaults on round
      // transition before the player-doc listener re-hydrates them.
      const nextDecisionDraft = buildDefaultDecisionDraft();
      nextDecisionDraft.productPrices = { ...state.pendingDecision.productPrices };
      // K-05 (2026-04-29): carry the team's unlocked-product menu toggles
      // forward into the next round so a product unlocked in round N is
      // still ON at the start of round N+1. Without this the OPTIONAL_MENU
      // items snap back to `false` and the player has to re-toggle every
      // station they bought. `state.unlockedProducts` is the canonical set
      // (mirrored from the team doc by GamePage's listener); we OR it onto
      // the BASE_MENU defaults rather than replacing them so a freshly
      // joining teammate still gets the starter menu.
      for (const product of state.unlockedProducts) {
        nextDecisionDraft.menu[product] = true;
      }
      return {
        ...state,
        currentRound: action.payload,
        pendingDecision: nextDecisionDraft,
        pendingAdBids: buildDefaultAdBidsDraft(),
        pendingChefBids: {},
        decisionSubmitted: false,
        pricesSubmitted: false,
        adBidsSubmitted: false,
        chefBidsSubmitted: false,
      };
    }

    case "SET_PLAYERS":
      return { ...state, players: action.payload };

    case "ADD_RESULT": {
      const result = action.payload;
      // Dedupe by round — the player-doc snapshot fires multiple times per
      // round (e.g. maintenance-bar updates, budget writes) and we don't
      // want to append a duplicate `lastRoundResult` each time.
      const existing = state.roundResults.findIndex(
        (r) => r.round === result.round,
      );
      const nextResults =
        existing >= 0
          ? state.roundResults.map((r, i) => (i === existing ? result : r))
          : [...state.roundResults, result];
      return {
        ...state,
        roundResults: nextResults,
      };
    }

    case "UPDATE_PLAYER":
      return {
        ...state,
        player: state.player ? { ...state.player, ...action.payload } : null,
      };

    case "SET_AUCTION_TAB":
      return { ...state, auctionTab: action.payload };

    case "SET_CONFIG":
      return { ...state, config: action.payload };

    case "UPDATE_PENDING_DECISION": {
      const nextStaffCounts = action.payload.staffCounts
        ? {
            ...state.pendingDecision.staffCounts,
            ...action.payload.staffCounts,
          }
        : state.pendingDecision.staffCounts;
      const next: PendingDecisionDraft = {
        ...state.pendingDecision,
        // Keep the legacy flat field in sync until backend consumers stop
        // reading it directly.
        sousChefCount: totalSousChefs(nextStaffCounts),
        menu: action.payload.menu
          ? { ...state.pendingDecision.menu, ...action.payload.menu }
          : state.pendingDecision.menu,
        quantities: action.payload.quantities
          ? {
              ...state.pendingDecision.quantities,
              ...action.payload.quantities,
            }
          : state.pendingDecision.quantities,
        sousChefAssignments: action.payload.sousChefAssignments
          ? {
              ...state.pendingDecision.sousChefAssignments,
              ...action.payload.sousChefAssignments,
            }
          : state.pendingDecision.sousChefAssignments,
        staffCounts: nextStaffCounts,
        productPrices: action.payload.productPrices
          ? { ...state.pendingDecision.productPrices, ...action.payload.productPrices }
          : state.pendingDecision.productPrices,
        equipmentUpgradePurchased:
          action.payload.equipmentUpgradePurchased !== undefined
            ? action.payload.equipmentUpgradePurchased
            : state.pendingDecision.equipmentUpgradePurchased,
        // K-03: absolute set, not delta — see action type comment.
        miscSpent:
          typeof action.payload.miscSpent === "number" &&
          Number.isFinite(action.payload.miscSpent)
            ? Math.max(0, action.payload.miscSpent)
            : state.pendingDecision.miscSpent,
      };
      return { ...state, pendingDecision: next };
    }

    case "UPDATE_PENDING_AD_BID":
      return {
        ...state,
        pendingAdBids: {
          ...state.pendingAdBids,
          [action.payload.adType]: Math.max(0, action.payload.amount),
        },
      };

    case "UPDATE_PENDING_CHEF_BID":
      return {
        ...state,
        pendingChefBids: {
          ...state.pendingChefBids,
          [action.payload.chefId]: Math.max(0, action.payload.amount),
        },
      };

    case "RESET_PENDING":
      return {
        ...state,
        pendingDecision: buildDefaultDecisionDraft(),
        pendingAdBids: buildDefaultAdBidsDraft(),
        pendingChefBids: {},
        decisionSubmitted: false,
        pricesSubmitted: false,
        adBidsSubmitted: false,
        chefBidsSubmitted: false,
      };

    case "SET_DECISION_SUBMITTED":
      return { ...state, decisionSubmitted: action.payload };

    case "SET_PRICES_SUBMITTED":
      return { ...state, pricesSubmitted: action.payload };

    case "SET_AD_BIDS_SUBMITTED":
      return { ...state, adBidsSubmitted: action.payload };

    case "SET_CHEF_BIDS_SUBMITTED":
      return { ...state, chefBidsSubmitted: action.payload };

    case "SET_BUDGET": {
      if (state.budgetCurrent === action.payload) return state;
      return { ...state, budgetCurrent: action.payload };
    }

    case "UPDATE_PLAYER_GRADES": {
      const { equipmentGrade, cleanlinessGrade, cleanlinessScore } = action.payload;
      if (
        state.equipmentGrade === equipmentGrade &&
        state.cleanlinessGrade === cleanlinessGrade &&
        state.cleanlinessScore === cleanlinessScore
      ) {
        return state;
      }
      return { ...state, equipmentGrade, cleanlinessGrade, cleanlinessScore };
    }

    case "SET_LEADERBOARD":
      // A successful snapshot clears any previous listener error.
      return { ...state, leaderboard: action.payload, leaderboardError: null };

    case "SET_LEADERBOARD_ERROR":
      return state.leaderboardError === action.payload
        ? state
        : { ...state, leaderboardError: action.payload };

    case "ADD_ACQUIRED_CSV": {
      // Dedupe by id so repeated purchases of the same round's intel don't
      // stack up; the newer payload always wins so callers can overwrite a
      // placeholder entry with a finalized one.
      const existing = state.acquiredCsvs.findIndex(
        (c) => c.id === action.payload.id,
      );
      const next =
        existing >= 0
          ? state.acquiredCsvs.map((c, i) =>
              i === existing ? action.payload : c,
            )
          : [...state.acquiredCsvs, action.payload];
      return { ...state, acquiredCsvs: next };
    }

    case "ADD_MISC_SPEND": {
      const delta = Number.isFinite(action.payload.amount)
        ? Math.max(0, action.payload.amount)
        : 0;
      if (delta === 0) return state;
      return {
        ...state,
        pendingDecision: {
          ...state.pendingDecision,
          miscSpent: state.pendingDecision.miscSpent + delta,
        },
      };
    }

    case "SET_TEAM_UNLOCKS": {
      const { unlockedProducts, unlocksPurchased } = action.payload;
      // Skip the render if nothing actually changed — the team-doc listener
      // re-fires on any team-doc write (name change, role assignment, etc.)
      // so most snapshots leave the unlock fields untouched.
      const sameCount =
        state.unlockedProducts.length === unlockedProducts.length;
      const sameMembers =
        sameCount &&
        unlockedProducts.every((p) => state.unlockedProducts.includes(p));
      if (sameMembers && state.unlocksPurchased === unlocksPurchased) {
        return state;
      }
      // K-04 (2026-04-29) — auto-enable newly unlocked products on the
      // menu. Previously the BakeryView rendered a separate "+ Add" step
      // after unlock; user feedback flagged that as redundant friction.
      // Now: unlock IS the toggle-on. Quantity steppers handle "I don't
      // actually want to bake any" — set qty=0 instead of toggling off.
      // Conversely, if a product slips out of the unlocked set (shouldn't
      // happen post-purchase, but defensive against admin/reset paths),
      // remove it from the pending menu and zero its quantity.
      const newlyUnlocked = unlockedProducts.filter(
        (p) =>
          !BASE_MENU.includes(p) &&
          !state.unlockedProducts.includes(p) &&
          !state.pendingDecision.menu[p],
      );
      const newlyLocked = (Object.keys(state.pendingDecision.menu) as ProductKey[])
        .filter(
          (p) =>
            state.pendingDecision.menu[p] &&
            !BASE_MENU.includes(p) &&
            !unlockedProducts.includes(p),
        );
      const nextDecision = newlyUnlocked.length || newlyLocked.length
        ? {
            ...state.pendingDecision,
            menu: { ...state.pendingDecision.menu },
            quantities: { ...state.pendingDecision.quantities },
          }
        : state.pendingDecision;
      for (const p of newlyUnlocked) {
        nextDecision.menu[p] = true;
      }
      for (const p of newlyLocked) {
        nextDecision.menu[p] = false;
        nextDecision.quantities[p] = 0;
      }
      return {
        ...state,
        unlockedProducts: [...unlockedProducts],
        unlocksPurchased,
        pendingDecision: nextDecision,
      };
    }

    case "RESET":
      // Barlava follow-up: hard reset of per-game state used when the
      // professor reverts a game back to the lobby (fired from
      // `useGameListener` when `phase` flips to "lobby"). We preserve
      // the CONNECTION identity (gameId / playerId / gameCode / player)
      // so the existing Firestore listeners keep firing — without this,
      // RESET would null gameId, every dependent useEffect would tear
      // down its listener, and the player would silently lose live
      // updates until they refreshed. Per-round drafts, submission
      // flags, round results, etc. all clear.
      return {
        ...initialState,
        gameId: state.gameId,
        playerId: state.playerId,
        gameCode: state.gameCode,
        player: state.player,
      };

    default:
      return state;
  }
}

const GameContext = createContext<GameState>(initialState);
const GameDispatchContext = createContext<Dispatch<GameAction>>(() => {});

// K-02 / K-03 follow-up — coordination signal between the team-pending
// Firestore listener (in `GamePage`) and the debounced auto-save effect
// (below). When the listener applies a teammate's draft to local state,
// it calls `markDraftAppliedFromRemote()` so the auto-save effect skips
// the next firing instead of echoing the just-received state back to
// the team doc. Without this, two teammates can ping-pong stale values:
// A's older miscSpent gets mirrored to B, B's auto-save echoes it back
// as a fresh write, and A's listener applies it on top of A's local
// increment — clobbering A's in-progress edit. See PR #166 review.
type GameDraftSyncValue = { markDraftAppliedFromRemote: () => void };
const GameDraftSyncContext = createContext<GameDraftSyncValue>({
  markDraftAppliedFromRemote: () => {},
});

// Survives tab refresh during a live game. AuthProvider restores the Firebase
// UID via Firebase's own persistence layer (IndexedDB in prod, sessionStorage
// in dev — see `lib/firebase.ts`); the only thing we need to carry across
// reloads is the game/player linkage — once `gameId` is seeded,
// `useGameListener` reattaches and Firestore re-hydrates phase/round/etc.
//
// Storage choice mirrors the auth persistence:
//   • prod → localStorage so a closed-and-reopened tab still rejoins
//   • dev  → sessionStorage so multi-tab playtesting in one browser keeps
//     each tab's player linkage independent (otherwise tab 2 inherits
//     tab 1's playerId from localStorage and the player-doc Firestore
//     read fails owner-only auth).
const PERSISTED_SESSION_KEY = "bakery-bash:game-session";

function persistedSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return import.meta.env.DEV ? window.sessionStorage : window.localStorage;
}

type PersistedSession = {
  gameId: string;
  playerId: string;
  gameCode: string;
  role: PlayerRole;
  teamId: string | null;
  // M-08: track the round on the session so a refresh during decide
  // can scope the persisted draft to the correct round before the
  // Firestore listener catches up.
  currentRound: number;
};

function readPersistedSession(): PersistedSession | null {
  try {
    const storage = persistedSessionStorage();
    if (!storage) return null;
    const raw = storage.getItem(PERSISTED_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    if (
      typeof parsed.gameId !== "string" ||
      typeof parsed.playerId !== "string" ||
      typeof parsed.gameCode !== "string"
    ) {
      return null;
    }
    const role: PlayerRole =
      parsed.role === "operations" ||
      parsed.role === "advertising" ||
      parsed.role === "finance" ||
      parsed.role === "solo"
        ? parsed.role
        : "solo";
    return {
      gameId: parsed.gameId,
      playerId: parsed.playerId,
      gameCode: parsed.gameCode,
      role,
      teamId: typeof parsed.teamId === "string" ? parsed.teamId : null,
      currentRound:
        typeof parsed.currentRound === "number" && parsed.currentRound >= 0
          ? parsed.currentRound
          : 0,
    };
  } catch {
    return null;
  }
}

function writePersistedSession(payload: PersistedSession | null): void {
  try {
    const storage = persistedSessionStorage();
    if (!storage) return;
    if (!payload) {
      storage.removeItem(PERSISTED_SESSION_KEY);
      return;
    }
    storage.setItem(PERSISTED_SESSION_KEY, JSON.stringify(payload));
  } catch {
    // Private mode / quota: acceptable to no-op; a refresh will still sign in,
    // just without the game linkage shortcut.
  }
}

// ---------------------------------------------------------------------------
// M-08 (2026-04-28) — Decide-phase draft persistence
//
// Refresh during decide previously wiped the in-progress decision because
// `pendingDecision` / `pendingAdBids` / `pendingChefBids` lived only in the
// reducer (Firestore only sees them post-submit). Persist them under a
// sibling storage key, scoped by (gameId, playerId, currentRound) so:
//   • a stale draft from a previous round can't bleed into round N+1, and
//   • a different uid signing into the same browser can't see another
//     player's draft.
// Storage choice mirrors PERSISTED_SESSION_KEY (sessionStorage in dev so
// multi-tab playtesting stays independent; localStorage in prod).
// ---------------------------------------------------------------------------
const PERSISTED_DRAFT_KEY = "bakery-bash:pending-draft";

type PersistedDraft = {
  gameId: string;
  playerId: string;
  round: number;
  pendingDecision: PendingDecisionDraft;
  pendingAdBids: PendingAdBidsDraft;
  pendingChefBids: PendingChefBidsDraft;
};

function readPersistedDraft(scope: {
  gameId: string;
  playerId: string;
  round: number;
}): PersistedDraft | null {
  try {
    const storage = persistedSessionStorage();
    if (!storage) return null;
    const raw = storage.getItem(PERSISTED_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedDraft> | null;
    if (
      !parsed ||
      parsed.gameId !== scope.gameId ||
      parsed.playerId !== scope.playerId ||
      parsed.round !== scope.round
    ) {
      return null;
    }
    if (
      !parsed.pendingDecision ||
      !parsed.pendingAdBids ||
      !parsed.pendingChefBids
    ) {
      return null;
    }
    // PR #126 contract: `miscSpent` is a UI-only running tally that resets
    // on refresh — the server owns the budget, and the field is `Omit`'d
    // from SubmitPayload. Strip it from the rehydrated draft so refresh
    // restores menu/quantities/prices/bids without resurrecting the local
    // tally. Also defends `BakeryView`'s unguarded `miscSpent.toFixed(2)`
    // against a draft persisted before `miscSpent` (or any future field)
    // existed — the spread guarantees the field is always a number.
    return {
      ...parsed,
      pendingDecision: { ...parsed.pendingDecision, miscSpent: 0 },
    } as PersistedDraft;
  } catch {
    return null;
  }
}

function writePersistedDraft(payload: PersistedDraft | null): void {
  try {
    const storage = persistedSessionStorage();
    if (!storage) return;
    if (!payload) {
      storage.removeItem(PERSISTED_DRAFT_KEY);
      return;
    }
    storage.setItem(PERSISTED_DRAFT_KEY, JSON.stringify(payload));
  } catch {
    // Quota / private mode: acceptable to no-op; refresh just loses the draft.
  }
}

function buildInitialState(): GameState {
  const persisted = readPersistedSession();
  if (!persisted) return initialState;
  // M-08: rehydrate the in-progress draft if it matches the persisted
  // session's (gameId, playerId, currentRound). On round advance the
  // post-state-change effect detects the round mismatch and clears the
  // draft via writePersistedDraft(null), so a stale draft can't bleed
  // into round N+1.
  const draft = readPersistedDraft({
    gameId: persisted.gameId,
    playerId: persisted.playerId,
    round: persisted.currentRound,
  });
  return {
    ...initialState,
    gameId: persisted.gameId,
    playerId: persisted.playerId,
    gameCode: persisted.gameCode,
    role: persisted.role,
    teamId: persisted.teamId,
    currentRound: persisted.currentRound,
    ...(draft
      ? {
          pendingDecision: draft.pendingDecision,
          pendingAdBids: draft.pendingAdBids,
          pendingChefBids: draft.pendingChefBids,
        }
      : {}),
  };
}

export function GameProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(
    gameReducer,
    undefined,
    buildInitialState,
  );

  const {
    gameId,
    playerId,
    gameCode,
    role,
    teamId,
    phase,
    currentRound,
    pendingDecision,
    pendingAdBids,
    pendingChefBids,
  } = state;
  useEffect(() => {
    // Clear on game_over so a reopened tab lands on the landing page instead
    // of being re-routed into the finished game's conclusion screen.
    if (!gameId || !playerId || !gameCode || phase === "game_over") {
      writePersistedSession(null);
      return;
    }
    writePersistedSession({
      gameId,
      playerId,
      gameCode,
      role,
      teamId,
      currentRound,
    });
  }, [gameId, playerId, gameCode, role, teamId, phase, currentRound]);

  // K-02 / K-03 (2026-04-29) — debounced team-shared draft sync. Whenever
  // `pendingDecision` changes (Operations adjusting staffCounts, Finance
  // changing prices/quantities, Analyst running up miscSpent), we fire
  // `saveDecisionDraft` after a 500ms quiet period so other teammates'
  // tabs see the live mutation without us paying a write per keystroke.
  //
  // Skipped for: solo players (server returns `skipped: true` anyway,
  // but bail before the call to save the round-trip), non-decide phases
  // (the draft only makes sense during decide), and the very first mount
  // before `pendingDecision` differs from `DEFAULT_PENDING_DECISION` —
  // a fresh JOIN_GAME shouldn't write a default-shaped draft over a
  // teammate's already-saved progress.
  const lastSentDraftRef = useRef<string | null>(null);
  // Set true by `markDraftAppliedFromRemote` (called from the team-pending
  // listener) so the next auto-save firing recognizes the change came from
  // a teammate's write — and skips re-emitting the same data back to the
  // team doc. Without this skip, B's listener applies A's write, B's
  // pendingDecision changes, B's auto-save fires, and B re-writes the
  // same payload tagged with B's uid — which then arrives on A's listener
  // (different uid → not filtered) and can clobber A's in-flight local
  // edits. See PR #166 review.
  const skipNextDraftAutoSaveRef = useRef(false);
  const markDraftAppliedFromRemote = useCallback(() => {
    skipNextDraftAutoSaveRef.current = true;
  }, []);
  const draftSyncValue = useMemo(
    () => ({ markDraftAppliedFromRemote }),
    [markDraftAppliedFromRemote],
  );
  useEffect(() => {
    if (!gameId || !playerId || !teamId) return;
    const parsed = parseGamePhase(phase ?? "lobby", currentRound ?? 1);
    if (parsed.base !== "decide") return;
    const draftPatch = {
      menu: pendingDecision.menu,
      quantities: pendingDecision.quantities,
      sousChefAssignments: pendingDecision.sousChefAssignments,
      staffCounts: pendingDecision.staffCounts,
      productPrices: pendingDecision.productPrices,
      miscSpent: pendingDecision.miscSpent,
      equipmentUpgradePurchased: pendingDecision.equipmentUpgradePurchased,
    };
    const serialized = JSON.stringify(draftPatch);
    // Listener-driven update — local state now mirrors what the team doc
    // already holds, so re-writing would be both redundant and racy.
    // Park `serialized` on `lastSentDraftRef` too: a subsequent local edit
    // will produce a different fingerprint and fall through to the write.
    if (skipNextDraftAutoSaveRef.current) {
      skipNextDraftAutoSaveRef.current = false;
      lastSentDraftRef.current = serialized;
      return;
    }
    if (serialized === lastSentDraftRef.current) return;
    const timer = window.setTimeout(() => {
      lastSentDraftRef.current = serialized;
      const save = httpsCallable<
        { gameId: string; draft: typeof draftPatch },
        { ok?: boolean; skipped?: boolean }
      >(functions, "saveDecisionDraft");
      save({ gameId, draft: draftPatch }).catch((err) => {
        // Swallow — auto-save is best-effort. Surface to console.debug
        // so a flaky network doesn't paint a red error bar mid-decide.
        console.debug("saveDecisionDraft failed", err);
        // Reset the dedup ref so the next change retries the write
        // rather than skipping it as "already sent".
        lastSentDraftRef.current = null;
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [gameId, playerId, teamId, phase, currentRound, pendingDecision]);

  // M-08: persist the in-progress draft on every mutation. Scoped by
  // (gameId, playerId, round) so a refresh restores only when all three
  // match — and SET_ROUND resets all three drafts on round advance, so
  // cross-round bleed is impossible. Cleared on game_over only.
  //
  // Why no `decisionSubmitted` guard: in team mode the team-pending
  // listener flips `decisionSubmitted=true` for every team member the
  // moment Operations submits (GamePage.tsx). If we cleared storage on
  // that flag, Advertising/Finance's `pendingAdBids`/`pendingChefBids`
  // would never get persisted during the auction phases — a refresh
  // mid-bid would lose the typed amounts (no Firestore hydration path
  // exists for `pendingBids`; see GamePage.tsx ~L377 comment). On a
  // post-submit refresh BakeryView re-renders with the persisted draft,
  // becomes read-only as soon as the listener re-fires
  // SET_DECISION_SUBMITTED:true (~100ms), and the draft is cleared on
  // the next round advance.
  useEffect(() => {
    if (!gameId || !playerId || phase === "game_over") {
      writePersistedDraft(null);
      return;
    }
    writePersistedDraft({
      gameId,
      playerId,
      round: currentRound,
      pendingDecision,
      pendingAdBids,
      pendingChefBids,
    });
  }, [
    gameId,
    playerId,
    currentRound,
    phase,
    pendingDecision,
    pendingAdBids,
    pendingChefBids,
  ]);

  return (
    <GameContext.Provider value={state}>
      <GameDispatchContext.Provider value={dispatch}>
        <GameDraftSyncContext.Provider value={draftSyncValue}>
          {children}
        </GameDraftSyncContext.Provider>
      </GameDispatchContext.Provider>
    </GameContext.Provider>
  );
}

// Hooks colocated with the provider: splitting these across files would churn
// ~13 callsites for no runtime benefit, so we silence react-refresh/
// only-export-components here. HMR still works; only fast-refresh of this
// single file degrades to full reload, which is fine for a context module.
// eslint-disable-next-line react-refresh/only-export-components
export function useGame() {
  return useContext(GameContext);
}

// eslint-disable-next-line react-refresh/only-export-components
export function useGameDispatch() {
  return useContext(GameDispatchContext);
}

// eslint-disable-next-line react-refresh/only-export-components
export function useGameDraftSync() {
  return useContext(GameDraftSyncContext);
}
