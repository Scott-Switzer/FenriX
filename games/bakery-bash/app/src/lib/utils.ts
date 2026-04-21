/**
 * Return the first argument that is a finite number, or `undefined` if none
 * qualify. Useful when a Firestore doc field might arrive under one of
 * several schema names (e.g. `revenueNet` vs legacy `cumulativeRevenue`).
 */
export function readNumber(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return undefined;
}
