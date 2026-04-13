export type GamePhase = "lobby" | "decide" | "bid" | "simulate" | "results";

export type MenuItemId =
  | "croissant"
  | "cookie"
  | "bagel"
  | "sandwich"
  | "latte"
  | "matcha-latte";

export type AdType = "tv" | "radio" | "newspaper" | "billboard";

export interface MenuItem {
  id: MenuItemId;
  name: string;
  unlocked: boolean;
  price: number;
  quantity: number;
}

export interface PlayerDecisions {
  prices: Record<MenuItemId, number>;
  quantities: Record<MenuItemId, number>;
  staffCount: number;
  adBids: Record<AdType, number>;
  chefBids: Record<string, number>;
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
  gameCode: string | null;
  phase: GamePhase;
  currentRound: number;
  totalRounds: number;
  player: Player | null;
  players: Player[];
  roundResults: RoundResult[];
  timeRemaining: number | null;
}
