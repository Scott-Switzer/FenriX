import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useGame } from "../contexts/GameContext";
import { useGamePhaseNav } from "../hooks/useGamePhaseNav";
import { PageShell } from "../components/ui/PageShell";
import { parseGamePhase } from "../types/game";

/**
 * FE-06 — `/game/email` phase page (round briefing).
 *
 * Shows a big "Round N" hero while the game is in a `round_N_email` phase;
 * when the professor advances to `round_N_decide`, this page auto-navigates.
 */

const FLOATS = [
  "croissant",
  "coffee",
  "bagel",
  "cookie",
  "matcha",
  "sandwich",
] as const;

export function EmailPhasePage() {
  useGamePhaseNav();
  const { gameId, currentRound, phase } = useGame();
  const navigate = useNavigate();

  useEffect(() => {
    if (!gameId || !phase) return;
    const parsed = parseGamePhase(phase, currentRound);
    if (parsed.base === "decide") navigate("/game/decide");
    else if (parsed.base === "bid_ad" || parsed.base === "bid_chef")
      navigate("/auction");
    else if (parsed.base === "roster") navigate("/game/roster");
    else if (parsed.base === "simulating" || parsed.base === "results_ready")
      navigate("/game");
    else if (parsed.base === "game_over") navigate("/game/conclusion");
  }, [phase, currentRound, gameId, navigate]);

  const roundLabel = currentRound && currentRound > 0 ? currentRound : "—";

  return (
    <PageShell className="round-briefing">
      <div className="round-briefing__stage" aria-live="polite">
        {FLOATS.map((name) => (
          <img
            key={name}
            src={`/assets/products/${name}.svg`}
            alt=""
            aria-hidden="true"
            className={`round-briefing__float round-briefing__float--${name}`}
          />
        ))}

        <div className="round-briefing__panel">
          <div className="round-briefing__eyebrow">Get Ready To Bake</div>
          <div className="round-briefing__round">
            <span className="round-briefing__round-word">Round</span>
            <span className="round-briefing__round-number">{roundLabel}</span>
          </div>
          <div className="round-briefing__tagline">
            Ovens hot. Beans ground. Let's go.
          </div>
        </div>
      </div>
    </PageShell>
  );
}
