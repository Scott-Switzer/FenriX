import { useGame } from "../../contexts/GameContext";

export function ResultsPhase() {
  const { roundResults, currentRound } = useGame();
  const latest = roundResults[roundResults.length - 1];

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
        </div>
      ) : (
        <p className="results-phase__placeholder">
          Results will appear here once the round is simulated.
        </p>
      )}

      <button className="btn btn--secondary">Download CSV</button>
      <p className="results-phase__waiting">
        Waiting for professor to advance to the next round…
      </p>
    </section>
  );
}
