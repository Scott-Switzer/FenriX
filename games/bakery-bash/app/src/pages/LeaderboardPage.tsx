import { useGame } from "../contexts/GameContext";
import { PageShell } from "../components/ui/PageShell";

export function LeaderboardPage() {
  const { leaderboard, players, player } = useGame();

  // Use real-time leaderboard if available, otherwise fall back to players list
  const hasLeaderboard = leaderboard.length > 0;

  return (
    <PageShell className="leaderboard-page">
      <h1 className="leaderboard-page__title">Leaderboard</h1>

      <table className="leaderboard-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Bakery</th>
            <th>Revenue (Round)</th>
            <th>Cumulative Revenue</th>
          </tr>
        </thead>
        <tbody>
          {hasLeaderboard ? (
            leaderboard.map((entry) => (
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
                <td>{entry.displayName}'s Bakery</td>
                <td>${entry.lastRoundRevenue.toLocaleString()}</td>
                <td>${entry.cumulativeRevenue.toLocaleString()}</td>
              </tr>
            ))
          ) : players.length > 0 ? (
            [...players]
              .sort((a, b) => b.cumulativeRevenue - a.cumulativeRevenue)
              .map((p, i) => (
                <tr
                  key={p.id}
                  className={
                    p.id === player?.id ? "leaderboard-table__row--you" : ""
                  }
                >
                  <td>{i + 1}</td>
                  <td>{p.bakeryName}</td>
                  <td>—</td>
                  <td>${p.cumulativeRevenue.toLocaleString()}</td>
                </tr>
              ))
          ) : (
            <tr>
              <td colSpan={4} className="leaderboard-table__empty">
                No players yet. Join a game to see the leaderboard.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </PageShell>
  );
}
