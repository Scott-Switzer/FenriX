import { useGame } from "../../contexts/GameContext";
import { useAuth } from "../../contexts/AuthContext";
import { callExportCsv } from "../../hooks/useFirebase";

export function ResultsPhase() {
  const { roundResults, currentRound, gameId, leaderboard, player } = useGame();
  const { user } = useAuth();

  // Get the latest round result (deduplicated by round number)
  const seen = new Set<number>();
  const uniqueResults = roundResults.filter((r) => {
    if (seen.has(r.round)) return false;
    seen.add(r.round);
    return true;
  });
  const latest = uniqueResults[uniqueResults.length - 1];

  const handleDownload = async () => {
    if (!gameId || !user) return;
    try {
      const result = await callExportCsv(gameId);
      const blob = new Blob([result.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bakery-bash-round-${currentRound}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("CSV export failed:", err);
    }
  };

  return (
    <section className="results-phase">
      <h2>Round {currentRound} Results</h2>

      {latest ? (
        <div className="results-phase__stats">
          <div className="results-phase__stat">
            <span className="results-phase__stat-label">Revenue</span>
            <span className="results-phase__stat-value">
              ${latest.revenue.toLocaleString()}
            </span>
          </div>
          <div className="results-phase__stat">
            <span className="results-phase__stat-label">Customers</span>
            <span className="results-phase__stat-value">
              {latest.customerCount}
            </span>
          </div>
          <div className="results-phase__stat">
            <span className="results-phase__stat-label">Satisfaction</span>
            <span className="results-phase__stat-value">
              {latest.customerSatisfaction}/100
            </span>
          </div>
          {latest.auctionResults.adWon && (
            <div className="results-phase__stat">
              <span className="results-phase__stat-label">Ad Won</span>
              <span className="results-phase__stat-value">
                {latest.auctionResults.adWon}
              </span>
            </div>
          )}
        </div>
      ) : (
        <p className="results-phase__placeholder">
          Results will appear here once the round is simulated.
        </p>
      )}

      {leaderboard.length > 0 && (
        <div className="results-phase__leaderboard">
          <h3>Leaderboard</h3>
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Bakery</th>
                <th>This Round</th>
                <th>Cumulative</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((entry) => (
                <tr
                  key={entry.playerId}
                  className={
                    entry.playerId === player?.id
                      ? "leaderboard-table__row--you"
                      : ""
                  }
                >
                  <td>
                    #{entry.rank}
                    {entry.rankChange > 0 && ` ↑${entry.rankChange}`}
                    {entry.rankChange < 0 && ` ↓${Math.abs(entry.rankChange)}`}
                  </td>
                  <td>{entry.displayName}</td>
                  <td>${entry.lastRoundRevenue.toLocaleString()}</td>
                  <td>${entry.cumulativeRevenue.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <button className="btn btn--secondary" onClick={handleDownload}>
        Download CSV
      </button>
      <p className="results-phase__waiting">
        Waiting for professor to advance to the next round…
      </p>
    </section>
  );
}
