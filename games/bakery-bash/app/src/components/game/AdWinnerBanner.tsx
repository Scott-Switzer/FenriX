import type { AdType } from "../../types/game";
import { AD_TYPES } from "../../types/game";

/**
 * FE-11 — Shows who won each ad surface last round. Rendered at the top
 * of the Decide screen for round N (N > 1) using the winners from
 * `rounds/round_{N-1}.adWinners`.
 *
 * Graceful empty state: when `winners` is empty or missing (e.g. round 1,
 * or the backend hasn't landed `adAuctionResults` writes yet), we render
 * a neutral "last round's ad winners will appear here" message instead of
 * hiding the banner, so the surface is obvious when winners do arrive.
 */
export interface AdWinnerEntry {
  adType: AdType;
  /** Winning bakery name (preferred); displayed in the banner. */
  bakeryName?: string;
  /** Winning player display name — fallback if bakery name is missing. */
  displayName?: string;
  /** Amount paid for the winning bid. */
  amount?: number;
}

export interface AdWinnerBannerProps {
  /** Round these winners were produced by — rendered as "Round N winners". */
  round: number | null;
  /** Winners keyed by AdType. Missing entries render a "no winner" cell. */
  winners: Partial<Record<AdType, AdWinnerEntry>> | null;
  /** Hide when there's truly nothing to show (e.g. round 1 decide screen). */
  hideWhenEmpty?: boolean;
}

const AD_ICON: Record<AdType, string> = {
  TV: "/assets/ads/tv.svg",
  Billboard: "/assets/ads/billboard.svg",
  Radio: "/assets/ads/radio.svg",
  Newspaper: "/assets/ads/newspaper.svg",
};

const AD_LABEL: Record<AdType, string> = {
  TV: "TV",
  Billboard: "Billboard",
  Radio: "Radio",
  Newspaper: "Newspaper",
};

function formatMoney(n: number | null | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function AdWinnerBanner({
  round,
  winners,
  hideWhenEmpty,
}: AdWinnerBannerProps) {
  const hasAny = !!winners && AD_TYPES.some((t) => winners[t]);
  if (hideWhenEmpty && !hasAny) return null;

  return (
    <section
      className="ad-winner-banner"
      aria-label={
        round
          ? `Round ${round} ad winners`
          : "Previous round ad winners"
      }
    >
      <header className="ad-winner-banner__header">
        <span className="ad-winner-banner__eyebrow">Ad Winners</span>
        <h3 className="ad-winner-banner__title">
          {round ? `From round ${round}` : "From last round"}
        </h3>
      </header>

      <ul className="ad-winner-banner__grid">
        {AD_TYPES.map((t) => {
          const w = winners?.[t];
          const name = w?.bakeryName || w?.displayName;
          return (
            <li key={t} className="ad-winner-banner__cell" data-ad-type={t}>
              <div className="ad-winner-banner__icon">
                <img src={AD_ICON[t]} alt={`${AD_LABEL[t]} icon`} />
              </div>
              <div className="ad-winner-banner__content">
                <div className="ad-winner-banner__surface">{AD_LABEL[t]}</div>
                {name ? (
                  <>
                    <div className="ad-winner-banner__winner" title={name}>
                      {name}
                    </div>
                    {typeof w?.amount === "number" && (
                      <div className="ad-winner-banner__amount">
                        {formatMoney(w.amount)}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="ad-winner-banner__empty">
                    {round ? "No bid" : "Awaiting results"}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
