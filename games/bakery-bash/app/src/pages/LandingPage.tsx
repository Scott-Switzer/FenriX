import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useGameDispatch } from "../contexts/GameContext";
import { useAuth } from "../contexts/AuthContext";
import { PageShell } from "../components/ui/PageShell";

export function LandingPage() {
  const [playerName, setPlayerName] = useState("");
  const [gameCode, setGameCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const navigate = useNavigate();
  const dispatch = useGameDispatch();
  const { user } = useAuth();

  const handleJoin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!playerName.trim()) {
      setError("Please enter your name.");
      return;
    }
    if (!gameCode.trim()) {
      setError("Please enter a game code.");
      return;
    }

    setJoining(true);

    try {
      // TODO: Validate game code against Firestore and join the game session.
      // For now, simulate joining with a local state update.
      dispatch({
        type: "JOIN_GAME",
        payload: {
          gameId: gameCode.toUpperCase(),
          gameCode: gameCode.toUpperCase(),
          player: {
            id: user?.uid ?? crypto.randomUUID(),
            name: playerName.trim(),
            bakeryName: `${playerName.trim()}'s Bakery`,
            budget: 5000,
            cumulativeRevenue: 0,
          },
        },
      });
      navigate("/lobby");
    } catch {
      setError("Could not join game. Check the code and try again.");
    } finally {
      setJoining(false);
    }
  };

  return (
    <PageShell className="landing-page">
      <div className="landing-page__card">
        <h1 className="landing-page__title">🥐 Bakery Bash</h1>
        <p className="landing-page__subtitle">
          Run your bakery. Outprice the competition. Win.
        </p>

        <form className="landing-page__form" onSubmit={handleJoin}>
          <label className="form-field">
            <span className="form-field__label">Your Name</span>
            <input
              type="text"
              className="form-field__input"
              placeholder="e.g. Kavin"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              maxLength={24}
            />
          </label>

          <label className="form-field">
            <span className="form-field__label">Game Code</span>
            <input
              type="text"
              className="form-field__input"
              placeholder="e.g. ABC123"
              value={gameCode}
              onChange={(e) => setGameCode(e.target.value.toUpperCase())}
              maxLength={8}
            />
          </label>

          {error && <p className="landing-page__error">{error}</p>}

          <button
            type="submit"
            className="btn btn--primary"
            disabled={joining}
          >
            {joining ? "Joining…" : "Join Game"}
          </button>
        </form>
      </div>
    </PageShell>
  );
}
