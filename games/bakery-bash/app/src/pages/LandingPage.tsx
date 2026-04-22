import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { httpsCallable, type FunctionsError } from "firebase/functions";
import { useGameDispatch } from "../contexts/GameContext";
import { useAuth } from "../contexts/AuthContext";
import { PageShell } from "../components/ui/PageShell";
import { functions } from "../lib/firebase";

interface JoinGameResponse {
  gameId: string;
  playerId: string;
}

const JOIN_CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

const JOIN_FAILURE_MESSAGES: Record<string, string> = {
  unauthenticated: "Couldn't sign you in. Please reload and try again.",
  "invalid-argument":
    "Check the join code (6 letters/digits) and name (2–40 characters).",
  "not-found": "No game matches that join code. Double-check with your professor.",
  "failed-precondition": "This game has already started and isn't accepting new players.",
};

function humanizeJoinError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const fnErr = err as FunctionsError;
    const rawCode = fnErr.code || "";
    const suffix = rawCode.split("/").pop() || rawCode;
    if (suffix && JOIN_FAILURE_MESSAGES[suffix]) {
      return JOIN_FAILURE_MESSAGES[suffix];
    }
    if (fnErr.message) return fnErr.message;
  }
  return "Could not join game. Please try again.";
}

const TEAM_COUNT = 8;

export function LandingPage() {
  const [playerName, setPlayerName] = useState("");
  const [gameCode, setGameCode] = useState("");
  const [teamNumber, setTeamNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const navigate = useNavigate();
  const dispatch = useGameDispatch();
  const { user, loading: authLoading } = useAuth();

  const handleJoin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedName = playerName.trim();
    const normalizedCode = gameCode.trim().toUpperCase();

    if (trimmedName.length < 2 || trimmedName.length > 40) {
      setError("Please enter a display name between 2 and 40 characters.");
      return;
    }
    if (!JOIN_CODE_REGEX.test(normalizedCode)) {
      setError(
        "Join code must be 6 characters using letters A-Z (excluding I/O) and digits 2-9.",
      );
      return;
    }
    if (!teamNumber) {
      setError("Please select your team number.");
      return;
    }
    if (authLoading || !user) {
      setError("Still signing you in… please try again in a moment.");
      return;
    }

    setJoining(true);

    try {
      const joinGame = httpsCallable<
        { joinCode: string; displayName: string; teamNumber: number },
        JoinGameResponse
      >(functions, "joinGame");

      const result = await joinGame({
        joinCode: normalizedCode,
        displayName: trimmedName,
        teamNumber,
      });
      const { gameId, playerId } = result.data;

      dispatch({
        type: "JOIN_GAME",
        payload: {
          gameId,
          playerId,
          gameCode: normalizedCode,
          player: {
            id: playerId,
            name: trimmedName,
            bakeryName: `Team ${teamNumber}`,
            budget: 0,
            cumulativeRevenue: 0,
          },
        },
      });

      navigate("/team", { state: { teamNumber } });
    } catch (err) {
      setError(humanizeJoinError(err));
    } finally {
      setJoining(false);
    }
  };

  const disabled = joining || authLoading;

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
              placeholder="e.g. John"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              maxLength={40}
            />
          </label>

          <label className="form-field">
            <span className="form-field__label">Game Code</span>
            <input
              type="text"
              className="form-field__input"
              placeholder="e.g. ABC234"
              value={gameCode}
              onChange={(e) => setGameCode(e.target.value.toUpperCase())}
              maxLength={6}
            />
          </label>

          <div className="form-field">
            <span className="form-field__label">Team Number</span>
            <div className="landing-page__team-grid">
              {Array.from({ length: TEAM_COUNT }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`btn ${teamNumber === n ? "btn--primary" : "btn--ghost"}`}
                  onClick={() => setTeamNumber(n)}
                  disabled={disabled}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="landing-page__error">{error}</p>}

          <button
            type="submit"
            className="btn btn--primary"
            disabled={disabled}
          >
            {joining
              ? "Joining…"
              : authLoading
              ? "Signing you in…"
              : "Join Game"}
          </button>
        </form>
      </div>
    </PageShell>
  );
}
