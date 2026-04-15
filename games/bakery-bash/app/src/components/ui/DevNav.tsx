import { Link } from "react-router-dom";
import { useGame, useGameDispatch } from "../../contexts/GameContext";
import type { GamePhase } from "../../types/game";

const PHASES: GamePhase[] = ["decide", "simulate", "results"];

export function DevNav() {
  const { phase, auctionTab } = useGame();
  const dispatch = useGameDispatch();

  if (import.meta.env.PROD) return null;

  const setPhase = (p: GamePhase) => {
    if (p === "decide") {
      dispatch({ type: "ADVANCE_ROUND" });
    } else {
      dispatch({ type: "SET_PHASE", payload: p });
    }
  };

  const auctionTabLabel =
    phase === "auction" ? "auction (active)" : "auction";

  return (
    <nav className="dev-nav">
      <span className="dev-nav__label">DEV</span>
      <Link to="/">Landing</Link>
      <Link to="/lobby">Lobby</Link>
      {PHASES.map((p) => (
        <Link key={p} to="/game" onClick={() => setPhase(p)}>
          {p}
        </Link>
      ))}
      <Link
        to="/auction"
        className={phase === "auction" ? "dev-nav__link--active" : ""}
        onClick={() => dispatch({ type: "SET_PHASE", payload: "auction" })}
      >
        {auctionTabLabel}
      </Link>
      <Link to="/leaderboard">Board</Link>
      <Link to="/professor">Prof</Link>
      {phase === "auction" && (
        <span className="dev-nav__phase-indicator">
          auction tab: {auctionTab === "chefs" ? "Chef Hiring" : "Advertisements"}
        </span>
      )}
    </nav>
  );
}
