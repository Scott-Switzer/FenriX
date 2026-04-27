/**
 * Round-cost calculations shared across all cost-aware UI. Centralized so
 * every caller (StaffTab grand total, decision cost panel, etc.) gets the
 * same numbers.
 *
 * All formulas mirror the game-design-proposal staffing economics:
 * an escalating per-hire curve for both sous chefs and Maintenance Guys
 * (1.0× / 1.5× / 2.25× / 3.0× then +0.75× per additional hire), plus a
 * flat per-unit production cost from `config.unitCostPerProduct`.
 *
 * Ad spend is just the sum of the player's submitted ad bids — the ad
 * auction is winner-take-all, but we counter-bill the entire bid in the
 * running cost so the player sees worst-case spend before submission.
 */
import type {
  GameConfigParams,
  PendingAdBidsDraft,
  PendingDecisionDraft,
  ProductKey,
  StaffCounts,
} from "../types/game";

/** Default per-hire base when Firestore `config/params` hasn't resolved.
 * Matches `sousChefBaseCost` in backend/functions/modules/config.js (post
 * balance pass 16 / Apr 2026 rebalance to a $10k starting budget). */
export const DEFAULT_HIRE_BASE_COST = 10;

/** Default per-unit production cost when `config.unitCostPerProduct` absent. */
const DEFAULT_UNIT_COST = 1;

/**
 * Multipliers applied to `base` for the 1st, 2nd, 3rd, and 4th hire of a
 * given role. Beyond the 4th, the curve continues linearly: +0.75× per
 * additional hire on top of the 4th-hire multiplier.
 */
const ESCALATION_MULTIPLIERS = [1.0, 1.5, 2.25, 3.0];
const ESCALATION_DELTA_AFTER = 0.75;

/** Cost to add one more hire when there are already `currentCount` of that role. */
export function getHireCost(base: number, currentCount: number): number {
  if (currentCount < ESCALATION_MULTIPLIERS.length) {
    return base * ESCALATION_MULTIPLIERS[currentCount];
  }
  const last = ESCALATION_MULTIPLIERS[ESCALATION_MULTIPLIERS.length - 1];
  const extra = currentCount - (ESCALATION_MULTIPLIERS.length - 1);
  return base * (last + ESCALATION_DELTA_AFTER * extra);
}

/** Sum of hire costs for all `count` hires of a single role at the given base. */
export function totalRoleCost(base: number, count: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += getHireCost(base, i);
  return total;
}

/**
 * Resolve the per-role base costs from the live `config` doc, with sensible
 * fallbacks. `maintenanceBaseCost` falls back to the sous chef base, which in
 * turn falls back to the legacy `costPerStaffPerRound` field, then to the
 * hard default. All staff-cost callers rely on getting identical numbers,
 * so the fallback chain lives here.
 */
export function resolveBaseCosts(config: GameConfigParams | null): {
  sousBase: number;
  maintBase: number;
} {
  const sousBase =
    config?.sousChefBaseCost ??
    config?.costPerStaffPerRound ??
    DEFAULT_HIRE_BASE_COST;
  const maintBase =
    config?.maintenanceBaseCost ?? sousBase ?? DEFAULT_HIRE_BASE_COST;
  return { sousBase, maintBase };
}

/** Total staffing cost for the round (all four roles, escalation applied). */
export function totalStaffCost(
  staffCounts: StaffCounts,
  config: GameConfigParams | null,
): number {
  const { sousBase, maintBase } = resolveBaseCosts(config);
  return (
    totalRoleCost(sousBase, staffCounts.bakerySousChefs) +
    totalRoleCost(sousBase, staffCounts.deliSousChefs) +
    totalRoleCost(sousBase, staffCounts.baristaSousChefs) +
    totalRoleCost(maintBase, staffCounts.maintenanceGuys)
  );
}

/**
 * Total production cost for the round: sum of menu-item quantities × the
 * unit cost. Off-menu items contribute nothing even if their qty is non-zero
 * (the player can't sell them, so the backend doesn't bill them either).
 */
export function totalProductCost(
  menu: Record<ProductKey, boolean>,
  quantities: Record<ProductKey, number>,
  config: GameConfigParams | null,
): number {
  const unitCost = config?.unitCostPerProduct ?? DEFAULT_UNIT_COST;
  let units = 0;
  for (const p of Object.keys(quantities) as ProductKey[]) {
    if (!menu[p]) continue;
    const qty = quantities[p] ?? 0;
    if (qty > 0) units += qty;
  }
  return units * unitCost;
}

/**
 * Total ad spend committed across all four ad types this round. The ad
 * auction is winner-take-all so a player will usually have a single non-zero
 * bid, but if they distribute across multiple types we sum them as
 * worst-case exposure for the budget warning.
 */
export function totalAdSpend(adBids: PendingAdBidsDraft): number {
  let sum = 0;
  for (const v of Object.values(adBids)) {
    if (typeof v === "number" && v > 0) sum += v;
  }
  return sum;
}

/** Detailed per-bucket breakdown — handy for tooltips / debugging. */
export interface RoundCostBreakdown {
  staff: number;
  product: number;
  ad: number;
  total: number;
}

export interface DecisionCostBreakdown {
  staff: number;
  product: number;
  ad: number;
  chef: number;
  total: number;
}

export function computeDecisionCost(
  pendingDecision: PendingDecisionDraft,
  config: GameConfigParams | null,
  auctionCosts?: { ad?: number; chef?: number },
): DecisionCostBreakdown {
  const staff = totalStaffCost(pendingDecision.staffCounts, config);
  const product = totalProductCost(
    pendingDecision.menu,
    pendingDecision.quantities,
    config,
  );
  const ad = auctionCosts?.ad ?? 0;
  const chef = auctionCosts?.chef ?? 0;
  return { staff, product, ad, chef, total: staff + product + ad + chef };
}

/** Convenience: full round cost from the current pending draft + config. */
export function computeRoundCost(
  pendingDecision: PendingDecisionDraft,
  pendingAdBids: PendingAdBidsDraft,
  config: GameConfigParams | null,
): RoundCostBreakdown {
  const staff = totalStaffCost(pendingDecision.staffCounts, config);
  const product = totalProductCost(
    pendingDecision.menu,
    pendingDecision.quantities,
    config,
  );
  const ad = totalAdSpend(pendingAdBids);
  return { staff, product, ad, total: staff + product + ad };
}

/**
 * Format a dollar value as `$1,234` (no cents) for compact UI. Accepts
 * `undefined` / non-finite inputs (e.g. a leaderboard row that hasn't been
 * populated yet) and renders an em-dash placeholder so callers don't have
 * to repeat the same null-check at every call site.
 */
export function formatMoney(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const rounded = Math.round(n);
  return `$${rounded.toLocaleString()}`;
}
