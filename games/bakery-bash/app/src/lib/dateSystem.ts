/**
 * In-game calendar helpers.
 *
 * The game starts on January 1st and each round corresponds to one
 * calendar month (Round 1 = January, Round 2 = February, ...). These
 * helpers let UI surfaces like the round-briefing screen, event
 * reports (inspection dates), and the results CSV talk
 * about rounds in terms of real month names and day-of-month numbers.
 *
 * The "year" never matters — we only expose month names and day counts.
 */

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Return the month name corresponding to `round` (1-indexed). Returns
 * null when the round is out of range (e.g. pre-game or past month 12).
 */
export function monthNameForRound(round: number | null | undefined): string | null {
  if (typeof round !== "number" || !Number.isFinite(round)) return null;
  const idx = Math.floor(round) - 1;
  if (idx < 0 || idx >= MONTH_NAMES.length) return null;
  return MONTH_NAMES[idx];
}

/**
 * Format an array of day-of-month numbers into a compact "Feb 4, 17, 28"
 * style string. Empty input returns an empty string.
 */
export function formatDaysInRound(
  round: number | null | undefined,
  days: number[] | null | undefined,
): string {
  if (!Array.isArray(days) || days.length === 0) return "";
  const monthShort = monthNameForRound(round)?.slice(0, 3) ?? null;
  const nums = days
    .map((d) => (Number.isFinite(d) ? Math.max(1, Math.floor(d)) : null))
    .filter((n): n is number => n !== null);
  if (nums.length === 0) return "";
  if (!monthShort) return nums.map((n) => `Day ${n}`).join(", ");
  return `${monthShort} ${nums.join(", ")}`;
}
