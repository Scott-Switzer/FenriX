export type GamePhase = "lobby" | "decide" | "bid" | "simulate" | "results";

export type MenuItemId =
  | "croissant"
  | "cookie"
  | "bagel"
  | "sandwich"
  | "latte"
  | "matchaLatte";

export type AdType = "TV" | "Radio" | "Newspaper" | "Billboard";

export interface MenuItem {
  id: MenuItemId;
  name: string;
  unlocked: boolean;
  price: number;
  quantity: number;
}

export interface PlayerDecisions {
  staffCount: number;
  adSpend: number;
  menu: Record<MenuItemId, boolean>;
  productPrices: Record<MenuItemId, number>;
  quantities: Record<MenuItemId, number>;
}

export interface PlayerBids {
  adBid: { adType: AdType | null; amount: number };
  chefBid: { amount: number };
}

export interface RoundResult {
  round: number;
  revenue: number;
  customerCount: number;
  customerSatisfaction: number;
  auctionResults: {
    adWon: string | null;
    chefWon: string | null;
  };
}

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  displayName: string;
  cumulativeRevenue: number;
  lastRoundRevenue: number;
  rankChange: number;
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
  gameCode: string | null;
  phase: GamePhase;
  currentRound: number;
  totalRounds: number;
  player: Player | null;
  players: Player[];
  roundResults: RoundResult[];
  timeRemaining: number | null;
  leaderboard: LeaderboardEntry[];
  submittedCount: number;
  totalPlayers: number;
  isProfessor: boolean;
}
