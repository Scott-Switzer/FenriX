import { useGame } from "../contexts/GameContext";
import { RoundHeader } from "../components/game/RoundHeader";
import { PageShell } from "../components/ui/PageShell";
import { DecidePhase } from "./phases/DecidePhase";
import { BidPhase } from "./phases/BidPhase";
import { SimulatePhase } from "./phases/SimulatePhase";
import { ResultsPhase } from "./phases/ResultsPhase";

export function GamePage() {
  const { phase } = useGame();

  const renderPhase = () => {
    switch (phase) {
      case "decide":
        return <DecidePhase />;
      case "bid":
        return <BidPhase />;
      case "simulate":
        return <SimulatePhase />;
      case "results":
        return <ResultsPhase />;
      default:
        return <DecidePhase />;
    }
  };

  return (
    <PageShell className="game-page">
      <RoundHeader />
      <div className="game-page__content">{renderPhase()}</div>
    </PageShell>
  );
}
