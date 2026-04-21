import { useGame } from "../../contexts/GameContext";
import { LoanSharkCallout } from "../../components/game/LoanSharkCallout";
import { downloadResultsCsv } from "../../components/game/RoundHeader";
import type { ProductKey } from "../../types/game";

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

function formatMoney(n: number | null | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function ResultsPhase() {
  const { roundResults, currentRound, chefSatisfactionScores } = useGame();
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
