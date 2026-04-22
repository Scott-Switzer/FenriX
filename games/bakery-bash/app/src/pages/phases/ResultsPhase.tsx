import { useGame } from "../../contexts/GameContext";
import { LoanSharkCallout } from "../../components/game/LoanSharkCallout";
import { downloadResultsCsv } from "../../components/game/RoundHeader";
import type { MaintenanceBars, ProductKey } from "../../types/game";

/**
 * FE-12 — Results phase rework.
 *
 * Sources: `GameState.roundResults` (populated from
 * `players/{uid}.lastRoundResult` by GamePage). We render:
 *   - LoanSharkCallout  (red when amountBorrowed > 0)
 *   - KPI row           (revenue, customers, satisfaction, chef sat)
 *   - Product breakdown (units sold per product)
 *   - Chef satisfaction warnings + departure notices
 *   - Download CSV      (all rounds so far; uses shared helper)
 *
 * Budget is intentionally NOT shown (Hard UI Rule #1).
 */
const LOW_SATISFACTION_THRESHOLD = 40;

const PRODUCT_LABELS: Record<ProductKey, string> = {
  croissant: "Croissants",
  cookie: "Cookies",
  bagel: "Bagels",
  sandwich: "Sandwiches",
  coffee: "Coffees",
  matcha: "Matchas",
};

/**
 * FE-4 — end-of-round maintenance bar labels. Matches the labels used in
 * `StatusTab`, minus the warning icon/tier lines since we're rendering a
 * retrospective snapshot rather than a live health indicator.
 */
const MAINTENANCE_BAR_LABELS: Array<{
  key: keyof MaintenanceBars;
  label: string;
}> = [
  { key: "cleanliness", label: "Cleanliness" },
  { key: "ovenHealth", label: "Oven" },
  { key: "slicerHealth", label: "Meat Slicer" },
  { key: "espressoHealth", label: "Espresso Machine" },
];

function formatMoney(n: number | null | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function barColor(pct: number): string {
  if (pct >= 85) return "var(--sage)";
  if (pct >= 60) return "var(--lime)";
  if (pct > 30) return "var(--honey)";
  return "var(--berry)";
}

export function ResultsPhase() {
  const { roundResults, currentRound, chefSatisfactionScores, leaderboard } = useGame();
  const latest = roundResults[roundResults.length - 1];

  const scores: Record<string, number> =
    latest?.chefSatisfactionScores ?? chefSatisfactionScores;
  const lowChefs = Object.entries(scores).filter(
    ([, score]) =>
      typeof score === "number" && score <= LOW_SATISFACTION_THRESHOLD,
  );

  const departures = latest?.chefDepartures ?? [];
  const departureNames = latest?.chefDepartureNames ?? [];
  const chefLabel = (id: string, index: number) => departureNames[index] || id;

  const productEntries = latest?.productBreakdown
    ? (Object.entries(latest.productBreakdown) as Array<[ProductKey, number]>).filter(
        ([, n]) => typeof n === "number" && n > 0,
      )
    : [];

  const revenueDisplay =
    typeof latest?.revenueNet === "number"
      ? latest.revenueNet
      : typeof latest?.revenue === "number"
        ? latest.revenue
        : null;

  // FE-4 — auction outcomes. Backend writes `adWon` as a string or `null`
  // on the player's lastRoundResult; `chefWon` mirrors the chef id they
  // took home this round. We also accept the nested `auctionResults.*`
  // shape written by some legacy simulation paths.
  const adWon = latest?.adWon ?? latest?.auctionResults?.adWon ?? null;
  const chefWon = latest?.auctionResults?.chefWon ?? null;
  const adPaid = typeof latest?.adPaid === "number" ? latest.adPaid : null;

  // FE-4 — end-of-round maintenance snapshot. Prefer the per-round
  // snapshot on the result; fall back to live context state for the
  // pre-BE-1..BE-10 rollout where results docs may not include it.
  const endBars: MaintenanceBars | null =
    latest?.maintenanceBars ?? null;

  return (
    <section className="results-phase">
      <header className="results-phase__header">
        <h2 className="results-phase__title">
          Round {currentRound} Results
        </h2>
        {roundResults.length > 0 && (
          <button
            type="button"
            className="btn btn--ghost results-phase__download"
            onClick={() => downloadResultsCsv(roundResults)}
            aria-label="Download round history as CSV"
          >
            ⬇ Download CSV
          </button>
        )}
      </header>

      {latest ? (
        <>
          <LoanSharkCallout
            amountBorrowed={latest.amountBorrowed}
            interestCharged={latest.interestCharged}
          />

          <div className="results-phase__metric-cards">
            <div className="results-phase__metric-card results-phase__metric-card--revenue">
              <span className="results-phase__metric-value">{formatMoney(revenueDisplay)}</span>
              <span className="results-phase__metric-label">Revenue</span>
            </div>
            <div className="results-phase__metric-card results-phase__metric-card--customer">
              <span className="results-phase__metric-value">{latest?.customerCount ?? "—"}</span>
              <span className="results-phase__metric-label">Customers</span>
            </div>
            <div className="results-phase__metric-card results-phase__metric-card--satisfaction">
              <span className="results-phase__metric-value">{latest?.customerSatisfaction ?? "—"}</span>
              <span className="results-phase__metric-label">Satisfaction</span>
            </div>
          </div>

          {(latest as any)?.burglary && (
            <div className="results-phase__burglar-banner">
              🔓 Your bakery was broken into! A maintenance deficit left you vulnerable.
              {(latest as any).burglaryAmount ? ` –$${(latest as any).burglaryAmount.toLocaleString()}` : ""}
            </div>
          )}

          <div className="results-phase__kpis">
            <Kpi
              label="Net revenue"
              value={formatMoney(revenueDisplay)}
              // Simple "rising" animation — CSS handles the reveal.
              animated
            />
            <Kpi
              label="Customers"
              value={latest.customerCount.toLocaleString()}
            />
            <Kpi
              label="Customer satisfaction"
              value={`${latest.customerSatisfaction}/100`}
            />
            {typeof latest.chefSatisfactionScore === "number" && (
              <Kpi
                label="Chef satisfaction"
                value={`${Math.round(latest.chefSatisfactionScore)}/100`}
              />
            )}
            {typeof latest.amountBorrowed === "number" &&
              latest.amountBorrowed > 0 && (
                <Kpi
                  label="Gross revenue"
                  value={formatMoney(latest.revenueGross)}
                />
              )}
          </div>

          {/* FE-4 — auction outcomes row. Rendered between the KPI cards
              and the product breakdown so players get the "what did I win
              this round?" answer near the top. */}
          <section
            className="results-phase__auctions"
            aria-label="Auction results"
          >
            <h3 className="results-phase__section-title">Auction Results</h3>
            <ul className="results-phase__auction-list">
              <li className="results-phase__auction-row">
                <span className="results-phase__auction-label">Ad slot</span>
                {adWon ? (
                  <span className="results-phase__auction-value results-phase__auction-value--won">
                    Won: {adWon}
                    {typeof adPaid === "number" && adPaid > 0 && (
                      <>
                        {" "}
                        <span className="results-phase__auction-sub">
                          ({formatMoney(adPaid)})
                        </span>
                      </>
                    )}
                  </span>
                ) : (
                  <span className="results-phase__auction-value results-phase__auction-value--lost">
                    No ad won this round
                  </span>
                )}
              </li>
              <li className="results-phase__auction-row">
                <span className="results-phase__auction-label">Chef</span>
                {chefWon ? (
                  <span className="results-phase__auction-value results-phase__auction-value--won">
                    Hired: {chefWon}
                  </span>
                ) : (
                  <span className="results-phase__auction-value results-phase__auction-value--lost">
                    Chef auction lost
                  </span>
                )}
              </li>
            </ul>
          </section>

          {/* FE-4 — maintenance bar snapshot at the end of this round.
              Helps the player diagnose which bar drained them before they
              plan next round's maintenance guys. Hidden for legacy
              results docs that didn't include the snapshot. */}
          {endBars && (
            <section
              className="results-phase__maintenance"
              aria-label="Maintenance at end of round"
            >
              <h3 className="results-phase__section-title">
                Kitchen Status — End of Round
              </h3>
              <ul className="results-phase__maintenance-list">
                {MAINTENANCE_BAR_LABELS.map(({ key, label }) => {
                  const rawValue = endBars[key];
                  const value =
                    typeof rawValue === "number" ? rawValue : 100;
                  const clamped = Math.max(0, Math.min(100, value));
                  const color = barColor(clamped);
                  return (
                    <li
                      key={key}
                      className="results-phase__maintenance-row"
                    >
                      <div className="results-phase__maintenance-header">
                        <span className="results-phase__maintenance-label">
                          {label}
                        </span>
                        <span
                          className="results-phase__maintenance-pct"
                          style={{ color }}
                        >
                          {Math.round(clamped)}%
                        </span>
                      </div>
                      <div
                        className="results-phase__maintenance-track"
                        aria-hidden
                      >
                        <div
                          className="results-phase__maintenance-fill"
                          style={{ width: `${clamped}%`, background: color }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {productEntries.length > 0 && (
            <section className="results-phase__breakdown">
              <h3 className="results-phase__breakdown-title">
                Units sold
              </h3>
              <ul className="results-phase__breakdown-list">
                {productEntries.map(([id, units]) => (
                  <li
                    key={id}
                    className="results-phase__breakdown-row"
                    data-product={id}
                  >
                    <span className="results-phase__breakdown-name">
                      {PRODUCT_LABELS[id]}
                    </span>
                    <span className="results-phase__breakdown-units">
                      {units.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
              {latest.selloutAnywhere && (
                <p className="results-phase__sellout">
                  🔥 You sold out at least one station — consider hiring more
                  sous chefs next round.
                </p>
              )}
            </section>
          )}
        </>
      ) : (
        <p className="results-phase__placeholder">
          Results will appear here once the round is simulated.
        </p>
      )}

      {lowChefs.length > 0 && (
        <div
          className="results-phase__satisfaction-warnings"
          role="alert"
          aria-label="Chef satisfaction warnings"
        >
          {lowChefs.map(([chefId, score]) => (
            <div key={chefId} className="results-phase__warning-card">
              <span className="results-phase__warning-icon" aria-hidden>
                ⚠
              </span>
              <p className="results-phase__warning-text">
                <strong>{chefId}</strong>'s satisfaction is low (
                {Math.round(score)}%). Keep your kitchen clean and machines
                maintained to retain them.
              </p>
            </div>
          ))}
        </div>
      )}

      {departures.length > 0 && (
        <div
          className="results-phase__departures"
          role="status"
          aria-label="Chef departures"
        >
          {departures.map((chefId, i) => (
            <p key={chefId} className="results-phase__departure">
              <strong>{chefLabel(chefId, i)}</strong> has left the kitchen and
              re-entered the auction pool.
            </p>
          ))}
        </div>
      )}

      <p className="results-phase__waiting">
        Waiting for professor to advance to the next round…
      </p>

      {leaderboard && leaderboard.length > 0 && (
        <div className="results-phase__leaderboard">
          <h3 className="results-phase__section-title">Standings</h3>
          {leaderboard.map((entry: any, i: number) => (
            <div key={entry.uid ?? i} className="results-phase__rank-row">
              <span className="results-phase__rank">#{i + 1}</span>
              <span className="results-phase__team-name">{entry.displayName ?? "Team"}</span>
              <span className="results-phase__team-revenue">
                ${(entry.cumulativeRevenue ?? 0).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Kpi({
  label,
  value,
  animated,
}: {
  label: string;
  value: string;
  animated?: boolean;
}) {
  return (
    <div
      className={
        "results-phase__kpi" + (animated ? " results-phase__kpi--animated" : "")
      }
    >
      <span className="results-phase__kpi-label">{label}</span>
      <span className="results-phase__kpi-value">{value}</span>
    </div>
  );
}
