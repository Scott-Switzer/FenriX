import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type ReactNode,
  type Dispatch,
} from "react";
import {
  PRODUCT_KEYS,
  BASE_MENU,
  AD_TYPES,
  DEFAULT_MAINTENANCE_BARS,
  DEFAULT_STAFF_COUNTS,
  totalSousChefs,
  type AdType,
  type AuctionTab,
  type GameConfigParams,
  type GamePhaseString,
  type GameState,
  type LeaderboardRanking,
  type MaintenanceBars,
  type MaintenanceTask,
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
    maintenanceTasks: [],
    productPrices,
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
  timeRemaining: null,
  auctionTab: "chefs",
  pendingDecision: DEFAULT_PENDING_DECISION,
  pendingAdBids: DEFAULT_PENDING_AD_BIDS,
  pendingChefBids: DEFAULT_PENDING_CHEF_BIDS,
  config: null,
  decisionSubmitted: false,
  pricesSubmitted: false,
  adBidsSubmitted: false,
  chefBidsSubmitted: false,
  maintenanceBars: { ...DEFAULT_MAINTENANCE_BARS },
  chefSatisfactionScores: {},
  budgetCurrent: null,
  // DEC-21 default: solo / all-roles. The real role + team assignment is
  // written by the backend onto the player doc and the team doc; the
  // player doc listener mirrors them into context. "solo" stays the
  // default so a single-browser playtest keeps every submit button
  // enabled before BE-20/BE-21 ship.
  role: "solo",
  teamId: null,
  teamName: null,
  phaseEndsAtMs: null,
  leaderboard: [],
  leaderboardError: null,
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
  | { type: "SET_PHASE_ENDS_AT"; payload: number | null }
  | { type: "SET_PHASE"; payload: GamePhaseString }
  | { type: "SET_ROUND"; payload: number }
  | { type: "SET_PLAYERS"; payload: Player[] }
  | { type: "ADVANCE_ROUND" }
  | { type: "ADD_RESULT"; payload: RoundResult }
  | { type: "SET_TIMER"; payload: number | null }
  | { type: "UPDATE_PLAYER"; payload: Partial<Player> }
  | { type: "SET_AUCTION_TAB"; payload: AuctionTab }
  | { type: "SET_CONFIG"; payload: GameConfigParams | null }
  | {
      type: "UPDATE_PENDING_DECISION";
      payload: {
        sousChefCount?: number;
        menu?: Partial<Record<ProductKey, boolean>>;
        quantities?: Partial<Record<ProductKey, number>>;
        sousChefAssignments?: Partial<Record<ProductKey, number>>;
        staffCounts?: Partial<StaffCounts>;
        maintenanceTasks?: MaintenanceTask[];
        productPrices?: Partial<Record<ProductKey, number>>;
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
  | { type: "SET_MAINTENANCE_BARS"; payload: MaintenanceBars }
  | { type: "SET_CHEF_SATISFACTION"; payload: Record<string, number> }
  | { type: "SET_BUDGET"; payload: number | null }
  | { type: "SET_LEADERBOARD"; payload: LeaderboardRanking[] }
  | { type: "SET_LEADERBOARD_ERROR"; payload: string | null }
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

    case "ADVANCE_ROUND":
      return {
        ...state,
        currentRound: state.currentRound + 1,
        roundResults: [],   // clear stale results from previous round
        phase: "decide",
      };

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
        // Mirror maintenance bars / chef satisfaction from the result payload
        // when the backend includes them. Leave existing state in place if the
        // fields are absent (pre-BE-1..BE-10 rollout).
        maintenanceBars: result.maintenanceBars
          ? { ...result.maintenanceBars }
          : state.maintenanceBars,
        chefSatisfactionScores: result.chefSatisfactionScores
          ? { ...result.chefSatisfactionScores }
          : state.chefSatisfactionScores,
      };
    }

    case "SET_TIMER":
      return { ...state, timeRemaining: action.payload };

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
        maintenanceTasks:
          action.payload.maintenanceTasks !== undefined
            ? action.payload.maintenanceTasks
            : state.pendingDecision.maintenanceTasks,
        productPrices: action.payload.productPrices
          ? { ...state.pendingDecision.productPrices, ...action.payload.productPrices }
          : state.pendingDecision.productPrices,
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

    case "SET_MAINTENANCE_BARS":
      return { ...state, maintenanceBars: { ...action.payload } };

    case "SET_CHEF_SATISFACTION":
      return { ...state, chefSatisfactionScores: { ...action.payload } };

    case "SET_BUDGET": {
      if (state.budgetCurrent === action.payload) return state;
      return { ...state, budgetCurrent: action.payload };
    }

    case "SET_LEADERBOARD":
      // A successful snapshot clears any previous listener error.
      return { ...state, leaderboard: action.payload, leaderboardError: null };

    case "SET_LEADERBOARD_ERROR":
      return state.leaderboardError === action.payload
        ? state
        : { ...state, leaderboardError: action.payload };

    case "RESET":
      return initialState;

    default:
      return state;
  }
}

const GameContext = createContext<GameState>(initialState);
const GameDispatchContext = createContext<Dispatch<GameAction>>(() => {});

// Survives tab refresh during a live game. AuthProvider restores the Firebase
// UID via Firebase's own IndexedDB persistence, so the only thing we need to
// carry across reloads is the game/player linkage — once `gameId` is seeded,
// `useGameListener` reattaches and Firestore re-hydrates phase/round/etc.
// localStorage (not sessionStorage) so a closed-and-reopened tab still rejoins.
const PERSISTED_SESSION_KEY = "bakery-bash:game-session";

type PersistedSession = {
  gameId: string;
  playerId: string;
  gameCode: string;
  role: PlayerRole;
  teamId: string | null;
};

function readPersistedSession(): PersistedSession | null {
  try {
    const raw = window.localStorage.getItem(PERSISTED_SESSION_KEY);
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
    };
  } catch {
    return null;
  }
}

function writePersistedSession(payload: PersistedSession | null): void {
  try {
    if (!payload) {
      window.localStorage.removeItem(PERSISTED_SESSION_KEY);
      return;
    }
    window.localStorage.setItem(PERSISTED_SESSION_KEY, JSON.stringify(payload));
  } catch {
    // Private mode / quota: acceptable to no-op; a refresh will still sign in,
    // just without the game linkage shortcut.
  }
}

function buildInitialState(): GameState {
  const persisted = readPersistedSession();
  if (!persisted) return initialState;
  return {
    ...initialState,
    gameId: persisted.gameId,
    playerId: persisted.playerId,
    gameCode: persisted.gameCode,
    role: persisted.role,
    teamId: persisted.teamId,
  };
}

export function GameProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(
    gameReducer,
    undefined,
    buildInitialState,
  );

  const { gameId, playerId, gameCode, role, teamId, phase } = state;
  useEffect(() => {
    // Clear on game_over so a reopened tab lands on the landing page instead
    // of being re-routed into the finished game's conclusion screen.
    if (!gameId || !playerId || !gameCode || phase === "game_over") {
      writePersistedSession(null);
      return;
    }
    writePersistedSession({ gameId, playerId, gameCode, role, teamId });
  }, [gameId, playerId, gameCode, role, teamId, phase]);

  return (
    <GameContext.Provider value={state}>
      <GameDispatchContext.Provider value={dispatch}>
        {children}
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
