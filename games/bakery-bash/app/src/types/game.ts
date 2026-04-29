export type GamePhase = "lobby" | "decide" | "bid" | "auction" | "simulate" | "results";

export type ChefNationality = "american" | "french" | "italian" | "japanese";
export type ChefGender = "m" | "f";
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
  basePrice: number;
  quantity: number;
}

export interface PlayerDecisions {
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
  auctionTab: AuctionTab;
}
