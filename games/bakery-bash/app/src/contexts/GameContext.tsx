import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  type ReactNode,
  type Dispatch,
} from "react";
import type { GameState, GamePhase, Player, RoundResult } from "../types/game";
import { useAuth } from "./AuthContext";
import {
  onGameSnapshot,
  onPlayersSnapshot,
  onPlayerSnapshot,
  onLeaderboardSnapshot,
} from "../hooks/useFirebase";

const initialState: GameState = {
  gameId: null,
  gameCode: null,
  phase: "lobby",
  currentRound: 0,
  totalRounds: 5,
  player: null,
  players: [],
  roundResults: [],
  timeRemaining: null,
  leaderboard: [],
  submittedCount: 0,
  totalPlayers: 0,
  isProfessor: false,
};

type GameAction =
  | {
      type: "JOIN_GAME";
      payload: { gameId: string; gameCode: string; player: Player };
    }
  | { type: "SET_PHASE"; payload: GamePhase }
  | { type: "SET_PLAYERS"; payload: Player[] }
  | { type: "ADVANCE_ROUND" }
  | { type: "ADD_RESULT"; payload: RoundResult }
  | { type: "SET_TIMER"; payload: number | null }
  | { type: "UPDATE_PLAYER"; payload: Partial<Player> }
  | {
      type: "SYNC_GAME";
      payload: {
        phase: GamePhase;
        currentRound: number;
        totalRounds: number;
        submittedCount: number;
        totalPlayers: number;
        phaseEndTime: unknown;
        isProfessor: boolean;
      };
    }
  | {
      type: "SYNC_LEADERBOARD";
      payload: Array<{
        rank: number;
        playerId: string;
        displayName: string;
        cumulativeRevenue: number;
        lastRoundRevenue: number;
        rankChange: number;
      }>;
    }
  | { type: "RESET" };

function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "JOIN_GAME":
      return {
        ...state,
        gameId: action.payload.gameId,
        gameCode: action.payload.gameCode,
        player: action.payload.player,
        phase: "lobby",
      };

    case "SET_PHASE":
      return { ...state, phase: action.payload };

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

    case "SYNC_GAME": {
      // Map backend phase names to frontend phase names
      let phase = action.payload.phase as GamePhase;
      if (phase === ("results_ready" as string)) phase = "results";
      if (phase === ("simulating" as string)) phase = "simulate";
      if (phase === ("game_over" as string)) phase = "results";

      return {
        ...state,
        phase,
        currentRound: action.payload.currentRound,
        totalRounds: action.payload.totalRounds,
        submittedCount: action.payload.submittedCount,
        totalPlayers: action.payload.totalPlayers,
        isProfessor: action.payload.isProfessor,
      };
    }

    case "SYNC_LEADERBOARD":
      return { ...state, leaderboard: action.payload };

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
  const { user } = useAuth();

  // Real-time sync: game document
  useEffect(() => {
    if (!state.gameId) return;
    const unsub = onGameSnapshot(state.gameId, (data) => {
      dispatch({
        type: "SYNC_GAME",
        payload: {
          phase: data.phase as GamePhase,
          currentRound: data.currentRound as number,
          totalRounds: data.totalRounds as number,
          submittedCount: data.submittedCount as number,
          totalPlayers: data.totalPlayers as number,
          phaseEndTime: data.phaseEndTime,
          isProfessor: user?.uid === data.professorId,
        },
      });
    });
    return unsub;
  }, [state.gameId, user?.uid]);

  // Real-time sync: players subcollection
  useEffect(() => {
    if (!state.gameId) return;
    const unsub = onPlayersSnapshot(state.gameId, (players) => {
      dispatch({
        type: "SET_PLAYERS",
        payload: players.map((p) => ({
          id: p.id as string,
          name: p.displayName as string,
          bakeryName: `${p.displayName}'s Bakery`,
          budget: p.budgetCurrent as number,
          cumulativeRevenue: (p.cumulativeRevenue as number) || 0,
        })),
      });
    });
    return unsub;
  }, [state.gameId]);

  // Real-time sync: current player
  useEffect(() => {
    if (!state.gameId || !user?.uid) return;
    const unsub = onPlayerSnapshot(state.gameId, user.uid, (data) => {
      dispatch({
        type: "UPDATE_PLAYER",
        payload: {
          budget: data.budgetCurrent as number,
          cumulativeRevenue: (data.cumulativeRevenue as number) || 0,
        },
      });

      // If player has a lastRoundResult, add it
      const lastResult = data.lastRoundResult as Record<string, unknown>;
      if (lastResult && (lastResult.round as number) > 0) {
        dispatch({
          type: "ADD_RESULT",
          payload: {
            round: lastResult.round as number,
            revenue: lastResult.revenue as number,
            customerCount: lastResult.customerCount as number,
            customerSatisfaction: lastResult.customerSatisfaction as number,
            auctionResults: {
              adWon: (lastResult.adTypeWon as string) || null,
              chefWon: null,
            },
          },
        });
      }
    });
    return unsub;
  }, [state.gameId, user?.uid]);

  // Real-time sync: leaderboard
  useEffect(() => {
    if (!state.gameId) return;
    const unsub = onLeaderboardSnapshot(state.gameId, (data) => {
      const rankings = (data.rankings as Array<Record<string, unknown>>) || [];
      dispatch({
        type: "SYNC_LEADERBOARD",
        payload: rankings.map((r) => ({
          rank: r.rank as number,
          playerId: r.playerId as string,
          displayName: r.displayName as string,
          cumulativeRevenue: r.cumulativeRevenue as number,
          lastRoundRevenue: r.lastRoundRevenue as number,
          rankChange: r.rankChange as number,
        })),
      });
    });
    return unsub;
  }, [state.gameId]);

  // Phase end timer countdown
  useEffect(() => {
    // We'd need the phaseEndTime from SYNC_GAME to run the countdown.
    // For now, this is handled by the RoundHeader component checking
    // Firestore phaseEndTime directly.
  }, []);

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
