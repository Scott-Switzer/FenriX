import {
  createContext,
  useContext,
  useReducer,
  type ReactNode,
  type Dispatch,
} from "react";
import {
  PRODUCT_KEYS,
  BASE_MENU,
  AD_TYPES,
  type AdType,
  type AuctionTab,
  type GameConfigParams,
  type GamePhaseString,
  type GameState,
  type PendingAdBidsDraft,
  type PendingChefBidsDraft,
  type PendingDecisionDraft,
  type Player,
  type ProductKey,
  type RoundResult,
} from "../types/game";

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
  return {
    menu,
    quantities,
    sousChefCount: 0,
    sousChefAssignments,
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
  adBidsSubmitted: false,
  chefBidsSubmitted: false,
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
  | { type: "SET_AD_BIDS_SUBMITTED"; payload: boolean }
  | { type: "SET_CHEF_BIDS_SUBMITTED"; payload: boolean }
  | { type: "RESET" };

function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "JOIN_GAME":
      return {
        ...state,
        gameId: action.payload.gameId,
        playerId: action.payload.playerId,
        gameCode: action.payload.gameCode,
        player: action.payload.player,
        phase: "lobby",
      };

    case "SET_PHASE": {
      if (state.phase === action.payload) return state;
      return { ...state, phase: action.payload };
    }

    case "SET_ROUND": {
      if (state.currentRound === action.payload) return state;
      // New round → reset any local per-round drafts/submission flags.
      return {
        ...state,
        currentRound: action.payload,
        pendingDecision: buildDefaultDecisionDraft(),
        pendingAdBids: buildDefaultAdBidsDraft(),
        pendingChefBids: {},
        decisionSubmitted: false,
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
        phase: "decide",
      };

    case "ADD_RESULT":
      return {
        ...state,
        roundResults: [...state.roundResults, action.payload],
      };

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
      const next: PendingDecisionDraft = {
        ...state.pendingDecision,
        sousChefCount:
          action.payload.sousChefCount ?? state.pendingDecision.sousChefCount,
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
        adBidsSubmitted: false,
        chefBidsSubmitted: false,
      };

    case "SET_DECISION_SUBMITTED":
      return { ...state, decisionSubmitted: action.payload };

    case "SET_AD_BIDS_SUBMITTED":
      return { ...state, adBidsSubmitted: action.payload };

    case "SET_CHEF_BIDS_SUBMITTED":
      return { ...state, chefBidsSubmitted: action.payload };

    case "RESET":
      return initialState;

    default:
      return state;
  }
}

const GameContext = createContext<GameState>(initialState);
const GameDispatchContext = createContext<Dispatch<GameAction>>(() => {});

export function GameProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(gameReducer, initialState);

  return (
    <GameContext.Provider value={state}>
      <GameDispatchContext.Provider value={dispatch}>
        {children}
      </GameDispatchContext.Provider>
    </GameContext.Provider>
  );
}

export function useGame() {
  return useContext(GameContext);
}

export function useGameDispatch() {
  return useContext(GameDispatchContext);
}
