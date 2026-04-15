import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useGame } from "../contexts/GameContext";
import { useGameDispatch } from "../contexts/GameContext";
import { PageShell } from "../components/ui/PageShell";
import {
  callCreateGame,
  callStartGame,
  callAdvancePhase,
  callProfessorExport,
} from "../hooks/useFirebase";

export function ProfessorPage() {
  const game = useGame();
  const dispatch = useGameDispatch();
  const navigate = useNavigate();

  const [totalRounds, setTotalRounds] = useState(5);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await callCreateGame(totalRounds);
      dispatch({
        type: "JOIN_GAME",
        payload: {
          gameId: result.gameId,
          gameCode: result.joinCode,
          player: {
            id: "professor",
            name: "Professor",
            bakeryName: "Professor",
            budget: 0,
            cumulativeRevenue: 0,
          },
        },
      });
      setStatus(`Game created. Join code: ${result.joinCode}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create game.");
    } finally {
      setLoading(false);
    }
  };

  const handleStart = async () => {
    if (!game.gameId) return;
    setError(null);
    setLoading(true);
    try {
      await callStartGame(game.gameId);
      setStatus("Game started — players are now in the Decide phase.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to start game.");
    } finally {
      setLoading(false);
    }
  };

  const handleAdvance = async () => {
    if (!game.gameId) return;
    setError(null);
    setLoading(true);
    try {
      const result = await callAdvancePhase(game.gameId);
      setStatus(`Advanced to: ${result.phase} (round ${result.currentRound})`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to advance phase.");
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    if (!game.gameId) return;
    setError(null);
    try {
      const result = await callProfessorExport(game.gameId);
      // Trigger CSV download
      const blob = new Blob([result.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bakery-bash-all-players.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(`Exported ${result.rowCount} rows for ${result.playerCount} players.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to export.");
    }
  };

  return (
    <PageShell className="professor-page">
      <h1 className="professor-page__title">Professor Control Panel</h1>

      {!game.gameId ? (
        <form onSubmit={handleCreate} className="professor-page__create">
          <label className="form-field">
            <span className="form-field__label">Number of Rounds</span>
            <input
              type="number"
              className="form-field__input"
              min={1}
              max={10}
              value={totalRounds}
              onChange={(e) => setTotalRounds(Number(e.target.value))}
            />
          </label>
          <button type="submit" className="btn btn--primary" disabled={loading}>
            {loading ? "Creating…" : "Create Game"}
          </button>
        </form>
      ) : (
        <>
          <div className="professor-page__info">
            <p>
              Game Code: <strong>{game.gameCode}</strong>
            </p>
            <p>
              Phase: <strong>{game.phase}</strong> — Round{" "}
              <strong>{game.currentRound}</strong> of{" "}
              <strong>{game.totalRounds}</strong>
            </p>
            <p>
              Players submitted: <strong>{game.submittedCount}</strong> /{" "}
              <strong>{game.totalPlayers}</strong>
            </p>
          </div>

          <div className="professor-page__controls">
            <button
              className="btn btn--primary"
              onClick={handleStart}
              disabled={loading || game.phase !== "lobby"}
            >
              Start Game
            </button>
            <button
              className="btn btn--secondary"
              onClick={handleAdvance}
              disabled={
                loading ||
                game.phase === "lobby" ||
                game.phase === "simulate"
              }
            >
              Advance Phase
            </button>
            <button
              className="btn btn--secondary"
              onClick={handleExport}
              disabled={loading}
            >
              Export All CSV
            </button>
            <button
              className="btn btn--secondary"
              onClick={() => navigate("/leaderboard")}
            >
              View Leaderboard
            </button>
          </div>

          <div className="professor-page__players">
            <h2>Players ({game.players.length})</h2>
            <ul className="lobby-page__player-list">
              {game.players.map((p) => (
                <li key={p.id} className="lobby-page__player">
                  {p.name} — Budget: ${p.budget.toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {status && <p className="professor-page__status">{status}</p>}
      {error && <p className="professor-page__error">{error}</p>}
    </PageShell>
  );
}
