import { useGame } from "../contexts/GameContext";
import { PageShell } from "../components/ui/PageShell";

export function LeaderboardPage() {
  const { players, player } = useGame();

  const ranked = [...players].sort(
    (a, b) => b.cumulativeRevenue - a.cumulativeRevenue
  );

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
          {ranked.length === 0 ? (
            <tr>
              <td colSpan={4} className="leaderboard-table__empty">
                No players yet. Join a game to see the leaderboard.
              </td>
            </tr>
          ) : (
            ranked.map((p, i) => (
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
          )}
        </tbody>
      </table>
    </PageShell>
  );
}
