import { Link } from "react-router-dom";
import { useGameDispatch } from "../../contexts/GameContext";
import type { GamePhase } from "../../types/game";

const PHASES: GamePhase[] = ["decide", "simulate", "results"];

export function DevNav() {
  const dispatch = useGameDispatch();

  if (import.meta.env.PROD) return null;

  const setPhase = (phase: GamePhase) => {
    if (phase === "decide") {
      dispatch({ type: "ADVANCE_ROUND" });
    } else {
      dispatch({ type: "SET_PHASE", payload: phase });
    }
  };

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
      <Link to="/leaderboard">Board</Link>
      <Link to="/professor">Prof</Link>
    </nav>
  );
}
