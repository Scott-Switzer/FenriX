import { useGame } from "../contexts/GameContext";
import { formatMoney } from "../lib/cost";
import { readNumber } from "../lib/utils";
import { PageShell } from "../components/ui/PageShell";

/**
 * FE-7 — Leaderboard page.
 *
 * The leaderboard data is mirrored into `GameContext.leaderboard` by the
 * app-wide `useGameListener` hook (FE-5). Cloud Functions overwrite
 * `/games/{gameId}/leaderboard/latest` at the end of each round; we
 * render straight from the context-backed server-sorted ordering — no
 * local re-sort.
 *
 * Columns:
 *   - Rank            (from backend `rank`)
 *   - Bakery          (`bakeryName` || `displayName`)
 *   - Profit (Round)  (`lastRoundRevenue`) — label A24-I09; field unchanged.
 *   - Profit (Total)  (`revenueNet` → `cumulativeRevenue`)
 *   - Δ               (`rankChange` indicator)
 *
 * Both the per-round revenue and rank-change columns render `—` when the
 * backend hasn't shipped BE-7 yet, so the page degrades gracefully during
 * the rollout window.
 *
 * Budget is intentionally NOT displayed here per FRONTEND.md Hard UI Rule
 * #1 ("Budget is hidden during play").
 */

function rankChangeLabel(change: number): {
  text: string;
  className: string;
  ariaLabel: string;
} {
  if (change > 0) {
    return {
      text: `▲ +${change}`,
      className: "leaderboard-table__delta leaderboard-table__delta--up",
      ariaLabel: `Up ${change}`,
    };
  }
  if (change < 0) {
    return {
      text: `▼ ${change}`,
      className: "leaderboard-table__delta leaderboard-table__delta--down",
      ariaLabel: `Down ${Math.abs(change)}`,
    };
  }
  return {
    text: "—",
    className: "leaderboard-table__delta leaderboard-table__delta--flat",
    ariaLabel: "No change",
  };
}

export function LeaderboardPage() {
  const { gameId, playerId, leaderboard, leaderboardError, currentRound } =
    useGame();
  const rankings = leaderboard;

  // `useGameListener` dispatches an empty array when the leaderboard doc
  // is absent, so we can't distinguish "listener not mounted yet" from
  // "game has no results yet" without the gameId check. Before the game
  // is joined we render the empty state directly. Suppress the waiting
  // row when a listener error is visible, otherwise the page shows two
  // conflicting signals (error banner + "waiting" empty-state).
  const waitingForFirstRound =
    gameId !== null && rankings.length === 0 && !leaderboardError;

  return (
    <PageShell className="leaderboard-page">
      <h1 className="leaderboard-page__title">
        Leaderboard
        {currentRound > 0 && (
          <span className="leaderboard-page__round">
            {" "}
            · Round {currentRound}
          </span>
        )}
      </h1>

      {leaderboardError && (
        <p className="leaderboard-page__error" role="alert">
          {leaderboardError}
        </p>
      )}

      <table className="leaderboard-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Bakery</th>
            <th>Profit (Round)</th>
            <th>Profit (Total)</th>
            <th aria-label="Rank change">Δ</th>
          </tr>
        </thead>
        <tbody>
          {!gameId ? (
            <tr>
              <td colSpan={5} className="leaderboard-table__empty">
                Join a game to see the leaderboard.
              </td>
            </tr>
          ) : waitingForFirstRound ? (
            <tr>
              <td colSpan={5} className="leaderboard-table__empty">
                Waiting for first round results…
              </td>
            </tr>
          ) : (
            rankings.map((entry) => {
              const isYou = entry.playerId === playerId;
              const roundRevenue =
                typeof entry.lastRoundRevenue === "number"
                  ? entry.lastRoundRevenue
                  : null;
              const totalRevenue = readNumber(
                entry.revenueNet,
                entry.cumulativeRevenue,
              );
              const change =
                typeof entry.rankChange === "number" ? entry.rankChange : null;
              const delta =
                change === null ? null : rankChangeLabel(change);
              return (
                <tr
                  key={entry.playerId}
                  className={isYou ? "leaderboard-table__row--you" : ""}
                >
                  <td>{entry.rank}</td>
                  <td>
                    {entry.bakeryName || entry.displayName}
                    {isYou && (
                      <span className="leaderboard-table__you-tag"> (you)</span>
                    )}
                  </td>
                  <td>
                    {roundRevenue === null ? "—" : formatMoney(roundRevenue)}
                  </td>
                  <td>{formatMoney(totalRevenue)}</td>
                  <td>
                    {delta ? (
                      <span
                        className={delta.className}
                        aria-label={delta.ariaLabel}
                      >
                        {delta.text}
                      </span>
                    ) : (
                      <span className="leaderboard-table__delta leaderboard-table__delta--flat">
                        —
                      </span>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </PageShell>
  );
}
