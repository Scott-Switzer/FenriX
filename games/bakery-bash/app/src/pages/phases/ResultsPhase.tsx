import { useEffect, useState } from "react";
import { doc, onSnapshot, type DocumentData } from "firebase/firestore";
import { useGame } from "../../contexts/GameContext";
import { LoanSharkCallout } from "../../components/game/LoanSharkCallout";
import { downloadResultsCsv } from "../../components/game/RoundHeader";
import type { ProductKey, RoundEvent } from "../../types/game";
import { formatDaysInRound } from "../../lib/dateSystem";
import { db } from "../../lib/firebase";

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

function looksLikeInternalChefId(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[a-z0-9-]{12,}$/i.test(value);
}

function presentChefName(
  value: string | null | undefined,
  fallbackIndex?: number,
): string {
  if (value && !looksLikeInternalChefId(value)) return value;
  return typeof fallbackIndex === "number" ? `Chef ${fallbackIndex + 1}` : "Chef";
}

const INSPECTOR_ASSET = "/assets/events/food-inspector.svg";

/**
 * Curveball event card. One card per event. Food-safety inspection cards
 * show the inspector asset + date(s) + cleanliness reading + rating tier
 * (Poor / Sufficient / Good / Excellent).
 */
function EventCard({
  event,
  round,
}: {
  event: RoundEvent;
  round: number | null;
}) {
  const daysLabel = formatDaysInRound(round, event.days ?? []);
  const rating = event.rating ?? null;
  const pct =
    typeof event.cleanlinessPct === "number"
      ? Math.round(event.cleanlinessPct)
      : null;

  return (
    <article
      className={`event-card event-card--inspection${
        rating ? ` event-card--inspection-${rating.toLowerCase()}` : ""
      }`}
      aria-label="Food safety inspection"
    >
      <img
        src={INSPECTOR_ASSET}
        alt=""
        aria-hidden
        className="event-card__asset"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
      <div className="event-card__body">
        <h4 className="event-card__title">🧼 Food Safety Inspection</h4>
        {daysLabel && (
          <p className="event-card__meta">
            <strong>When:</strong> {daysLabel}
          </p>
        )}
        {pct !== null && (
          <p className="event-card__meta">
            <strong>Cleanliness:</strong> {pct}%
          </p>
        )}
        {rating && (
          <p className="event-card__meta">
            <strong>Rating:</strong> {rating}
          </p>
        )}
      </div>
    </article>
  );
}

export function ResultsPhase() {
  const {
    roundResults,
    currentRound,
    leaderboard,
    gameId,
    playerId,
    teamId,
    role,
  } = useGame();
  // S-07 (2026-04-29): the monthly CSV is the Analyst's responsibility
  // post-Q6. Solo keeps it as the catch-all when teams have ≤2 members.
  // Backend role string is still `advertising` (label changed in S-03).
  const canDownloadCsv = role === "advertising" || role === "solo";
  // BE-I03: auction result docs are keyed by team slug (or the player uid for
  // solo players, which is also `team.key` on the backend).
  const auctionResultKey = teamId || playerId;
  const latest = roundResults[roundResults.length - 1];
  const [liveAuctionResult, setLiveAuctionResult] = useState<{
    adWins: string[];
    adPaid: number | null;
    chefsWon: Array<{ id?: string; name?: string }>;
    chefBidPaid: number | null;
  }>({
    adWins: [],
    adPaid: null,
    chefsWon: [],
    chefBidPaid: null,
  });

  useEffect(() => {
    if (!gameId || !auctionResultKey || !currentRound) return;
    const roundRef = doc(db, "games", gameId, "rounds", `round_${currentRound}`);
    const unsubscribe = onSnapshot(roundRef, (snap) => {
      if (!snap.exists()) {
        setLiveAuctionResult({
          adWins: [],
          adPaid: null,
          chefsWon: [],
          chefBidPaid: null,
        });
        return;
      }
      const data = snap.data() as DocumentData;
      const adEntry = (data.adAuctionResults?.[auctionResultKey] ?? null) as DocumentData | null;
      const chefEntry = (data.chefAuctionResults?.[auctionResultKey] ?? null) as DocumentData | null;
      setLiveAuctionResult({
        adWins:
          adEntry && Array.isArray(adEntry.adTypes)
            ? (adEntry.adTypes as string[])
            : [],
        adPaid:
          adEntry && typeof adEntry.totalPaid === "number"
            ? adEntry.totalPaid
            : null,
        chefsWon:
          chefEntry && Array.isArray(chefEntry.chefs)
            ? (chefEntry.chefs as Array<{ id?: string; name?: string }>)
            : [],
        chefBidPaid:
          chefEntry && typeof chefEntry.totalPaid === "number"
            ? chefEntry.totalPaid
            : null,
      });
    });
    return unsubscribe;
  }, [gameId, auctionResultKey, currentRound]);

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
  const adWins =
    (liveAuctionResult.adWins.length > 0 ? liveAuctionResult.adWins : undefined) ??
    (Array.isArray(latest?.adWins) ? latest.adWins : undefined) ??
    [];
  const adWon = latest?.adWon ?? latest?.auctionResults?.adWon ?? adWins[0] ?? null;
  const chefWonList =
    (liveAuctionResult.chefsWon.length > 0 ? liveAuctionResult.chefsWon : undefined) ??
    (Array.isArray(latest?.chefsWon) ? latest.chefsWon : undefined) ??
    [];
  const chefWon = latest?.auctionResults?.chefWon ?? null;
  const adPaid =
    typeof liveAuctionResult.adPaid === "number"
      ? liveAuctionResult.adPaid
      : typeof latest?.adPaid === "number"
        ? latest.adPaid
        : null;
  const chefBidPaid =
    typeof liveAuctionResult.chefBidPaid === "number"
      ? liveAuctionResult.chefBidPaid
      : typeof latest?.chefBidPaid === "number"
        ? latest.chefBidPaid
        : null;

  // Events derived from the result payload.
  const events: RoundEvent[] = Array.isArray(latest?.events) ? latest!.events! : [];

  return (
    <section className="results-phase">
      <header className="results-phase__header">
        <h2 className="results-phase__title">
          Round {currentRound} Results
        </h2>
        {roundResults.length > 0 && canDownloadCsv && (
          <button
            type="button"
            className="btn btn--ghost results-phase__download"
            onClick={() => downloadResultsCsv(roundResults)}
            aria-label="Download your monthly data as CSV"
            title="Download every round you've played as a CSV (one row per day)."
          >
            ⬇ Download your monthly data
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
              <span className="results-phase__metric-label">Profit</span>
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

          {events.length > 0 && (
            <section
              className="results-phase__events"
              aria-label="Curveball events"
            >
              <h3 className="results-phase__section-title">Events</h3>
              <div className="results-phase__event-cards">
                {events.map((event, idx) => (
                  <EventCard
                    key={`${event.kind}-${idx}`}
                    event={event}
                    round={currentRound}
                  />
                ))}
              </div>
            </section>
          )}

          {/* FE-I20: Net revenue / Customers / Customer satisfaction
              already render in the metric cards above; Gross revenue only
              shows when a loan was taken out. */}
          {typeof latest.amountBorrowed === "number" &&
            latest.amountBorrowed > 0 && (
            <div className="results-phase__kpis">
              <Kpi
                label="Gross revenue"
                value={formatMoney(latest.revenueGross)}
              />
            </div>
          )}

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
                {adWins.length > 0 || adWon ? (
                  <span className="results-phase__auction-value results-phase__auction-value--won">
                    Won: {adWins.length > 0 ? adWins.join(", ") : adWon}
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
                {chefWonList.length > 0 || chefWon ? (
                  <span className="results-phase__auction-value results-phase__auction-value--won">
                    Hired: {chefWonList.length > 0
                      ? chefWonList
                          .map((chef, index) => presentChefName(chef?.name || chef?.id, index))
                          .join(", ")
                      : presentChefName(chefWon)}
                    {typeof chefBidPaid === "number" && chefBidPaid > 0 && (
                      <>
                        {" "}
                        <span className="results-phase__auction-sub">
                          ({formatMoney(chefBidPaid)})
                        </span>
                      </>
                    )}
                  </span>
                ) : (
                  <span className="results-phase__auction-value results-phase__auction-value--lost">
                    Chef auction lost
                  </span>
                )}
              </li>
            </ul>
          </section>

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

      <p className="results-phase__waiting">
        Waiting for professor to advance to the next round…
      </p>

      {leaderboard && leaderboard.length > 0 && (
        <div className="results-phase__leaderboard">
          <h3 className="results-phase__section-title">Standings</h3>
          {leaderboard.map((entry, i) => {
            // Backend writes per-round `revenueNet` + `bakeryName` into
            // each ranking entry (index.js ~1558). `cumulativeRevenue`
            // lives on the player doc and isn't in the leaderboard
            // payload, so reading only that field produced $0 even when
            // players made money. Prefer bakery name + fall back to
            // revenueNet so the Standings row always reflects what's on
            // the wire (same pattern as ConclusionPage).
            const amount =
              typeof entry.cumulativeRevenue === "number"
                ? entry.cumulativeRevenue
                : typeof entry.revenueNet === "number"
                  ? entry.revenueNet
                  : 0;
            const name =
              entry.bakeryName ?? entry.displayName ?? "Team";
            return (
              <div
                key={entry.playerId ?? i}
                className="results-phase__rank-row"
              >
                <span className="results-phase__rank">#{i + 1}</span>
                <span className="results-phase__team-name">{name}</span>
                <span className="results-phase__team-revenue">
                  {formatMoney(amount)}
                </span>
              </div>
            );
          })}
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
