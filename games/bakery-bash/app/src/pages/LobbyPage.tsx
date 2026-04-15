import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useGame } from "../contexts/GameContext";
import { PageShell } from "../components/ui/PageShell";

export function LobbyPage() {
  const { player, players, gameCode, phase } = useGame();
  const navigate = useNavigate();

  // Auto-redirect when professor starts the game (phase changes from lobby)
  useEffect(() => {
    if (phase === "decide" || phase === "bid") {
      navigate("/game");
    }
  }, [phase, navigate]);

  return (
    <PageShell className="lobby-page">
      <div className="lobby-page__card">
        <h1 className="lobby-page__title">Waiting Room</h1>

        {gameCode && (
          <div className="lobby-page__code">
            Game Code: <strong>{gameCode}</strong>
          </div>
        )}

        {player && (
          <div className="lobby-page__bakery">
            Your bakery: <strong>{player.bakeryName}</strong>
          </div>
        )}

        <div className="lobby-page__players">
          <h2>Players ({players.length})</h2>
          <ul className="lobby-page__player-list">
            {players.map((p) => (
              <li
                key={p.id}
                className={`lobby-page__player${
                  p.id === player?.id ? " lobby-page__player--you" : ""
                }`}
              >
                {p.name}
                {p.id === player?.id ? " (you)" : ""}
              </li>
            ))}
          </ul>
        </div>

        <p className="lobby-page__status">
          Waiting for the professor to start the game…
        </p>
      </div>
    </PageShell>
  );
}
