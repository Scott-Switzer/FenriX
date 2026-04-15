import { useGame } from "../../contexts/GameContext";

export function RoundHeader() {
  const { currentRound, totalRounds, timeRemaining } = useGame();

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <header className="round-header">
      <div className="round-header__round">
        Round {currentRound} of {totalRounds}
      </div>

      {timeRemaining !== null && (
        <div
          className={`round-header__timer ${
            timeRemaining < 60 ? "round-header__timer--urgent" : ""
          }`}
        >
          {formatTime(timeRemaining)}
        </div>
      )}
    </header>
  );
}
