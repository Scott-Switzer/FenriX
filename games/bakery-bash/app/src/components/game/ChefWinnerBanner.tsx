import type { ChefNationality, ChefGender } from "../../types/game";
import { formatMoney } from "../../lib/cost";

/**
 * A24-I05 — Shows the chef-auction winners for the current round. Mounted
 * at the top of the Kitchen Roster page so students can see who their team
 * hired (and what the going rate turned out to be) before they decide
 * whether to lay anyone off.
 *
 * The banner renders one cell per chef the student's team won, with a
 * nationality/gender portrait, the chef's name, and the winning bid. If
 * nothing was won, render a short "No chefs hired this round" line so the
 * surface stays consistent rather than empty.
 */
export interface ChefWinnerEntry {
  chefId: string;
  name: string;
  nationality: ChefNationality;
  gender: ChefGender;
  amount: number;
  skillTier?: "novel" | "intermediate" | "advanced" | "base";
}

export interface ChefWinnerBannerProps {
  /** Round these winners were produced by — rendered as "Round N winners". */
  round: number | null;
  /** The chefs your team won this round. Empty = nothing hired. */
  winners: ChefWinnerEntry[];
  /** Hide completely when empty (e.g. on a round with no bids). */
  hideWhenEmpty?: boolean;
}

function chefIcon(nationality: ChefNationality, gender: ChefGender): string {
  return `/assets/chefs/${nationality}-${gender}.svg`;
}

const SKILL_LABEL: Record<NonNullable<ChefWinnerEntry["skillTier"]>, string> = {
  novel: "Novel",
  intermediate: "Intermediate",
  advanced: "Advanced",
  base: "Base",
};

export function ChefWinnerBanner({
  round,
  winners,
  hideWhenEmpty,
}: ChefWinnerBannerProps) {
  const hasAny = winners.length > 0;
  if (hideWhenEmpty && !hasAny) return null;

  return (
    <section
      className="chef-winner-banner"
      aria-label={
        round ? `Round ${round} chef winners` : "Chef winners"
      }
    >
      <header className="chef-winner-banner__header">
        <span className="chef-winner-banner__eyebrow">Chefs Hired</span>
        <h3 className="chef-winner-banner__title">
          {round ? `From round ${round}` : "This round"}
        </h3>
      </header>

      {hasAny ? (
        <ul className="chef-winner-banner__grid">
          {winners.map((w) => (
            <li key={w.chefId} className="chef-winner-banner__cell">
              <div className="chef-winner-banner__icon">
                <img
                  src={chefIcon(w.nationality, w.gender)}
                  alt={w.name}
                />
              </div>
              <div className="chef-winner-banner__content">
                <div className="chef-winner-banner__name" title={w.name}>
                  {w.name}
                </div>
                {w.skillTier && (
                  <div className="chef-winner-banner__tier">
                    {SKILL_LABEL[w.skillTier]}
                  </div>
                )}
                <div className="chef-winner-banner__amount">
                  {formatMoney(w.amount)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="chef-winner-banner__empty">
          No chefs hired this round — your team passed on the auction or was outbid.
        </p>
      )}
    </section>
  );
}
