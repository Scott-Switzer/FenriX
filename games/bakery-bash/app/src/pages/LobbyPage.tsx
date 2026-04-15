import { useGame } from "../contexts/GameContext";
import { PageShell } from "../components/ui/PageShell";

export function LobbyPage() {
  const { player, players, gameCode } = useGame();

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
          <h2>Players ({players.length || 1})</h2>
          <ul className="lobby-page__player-list">
            {player && (
              <li className="lobby-page__player lobby-page__player--you">
                {player.name} (you)
              </li>
            )}
            {players
              .filter((p) => p.id !== player?.id)
              .map((p) => (
                <li key={p.id} className="lobby-page__player">
                  {p.name}
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
