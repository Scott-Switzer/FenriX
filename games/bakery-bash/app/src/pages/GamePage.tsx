import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import { RoundHeader } from "../components/game/RoundHeader";
import { BakeryView } from "../components/game/BakeryView";
import { GameSidebar } from "../components/game/GameSidebar";
import { PageShell } from "../components/ui/PageShell";
import { SimulatePhase } from "./phases/SimulatePhase";
import { ResultsPhase } from "./phases/ResultsPhase";

export function GamePage() {
  const { phase } = useGame();
  const dispatch = useGameDispatch();
  const navigate = useNavigate();

  useEffect(() => {
    if (phase === "auction") {
      navigate("/auction");
    }
  }, [phase, navigate]);

  const isDecisionPhase = phase === "decide" || phase === "bid";

  const handleSubmit = () => {
    if (phase === "decide") {
      dispatch({ type: "SET_PHASE", payload: "bid" });
    } else if (phase === "bid") {
      dispatch({ type: "SET_PHASE", payload: "simulate" });
    }
  };

  if (!isDecisionPhase) {
    return (
      <PageShell className="game-page">
        <RoundHeader />
        <div className="game-page__content">
          {phase === "simulate" ? <SimulatePhase /> : <ResultsPhase />}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell className="game-page game-page--wide">
      <RoundHeader />
      <div className="game-page__dashboard">
        <BakeryView />
        <GameSidebar />
      </div>
      <button
        className="btn btn--primary game-page__submit"
        onClick={handleSubmit}
      >
        Submit Decisions
      </button>
    </PageShell>
  );
}
