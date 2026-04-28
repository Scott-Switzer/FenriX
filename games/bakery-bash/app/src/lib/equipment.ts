/**
 * Equipment tier helpers — mirrors `EQUIPMENT_TIER_COSTS` from backend
 * config.js. Values must stay in sync with the backend; a future task
 * can unify them (G3 note: duplicated here for the Friday timeline).
 */
const TIER_COSTS: Record<string, number> = {
  F: 400, E: 600, D: 800, C: 1000, B: 1200, A: 0,
};
const GRADES = ['F', 'E', 'D', 'C', 'B', 'A'];

/**
 * Returns the next equipment grade after `grade`, or `null` if already at
 * the maximum ('A') or if `grade` is unrecognized.
 */
export function nextEquipmentGrade(grade: string): string | null {
  const idx = GRADES.indexOf(grade);
  if (idx < 0 || idx === GRADES.length - 1) return null;
  return GRADES[idx + 1];
}

/**
 * Returns the USD cost to upgrade from `grade` to the next tier, or `null`
 * if the grade is already at 'A' or the cost is zero / non-finite.
 */
export function tierUpgradeCost(grade: string): number | null {
  if (grade === 'A') return null;
  const c = TIER_COSTS[grade];
  return Number.isFinite(c) && c > 0 ? c : null;
}
