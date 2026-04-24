import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useGame } from "../contexts/GameContext";
import { useGamePhaseNav } from "../hooks/useGamePhaseNav";
import { usePhaseCountdownSeconds } from "../hooks/usePhaseCountdownSeconds";
import { PageShell } from "../components/ui/PageShell";
import { formatMoney } from "../lib/cost";
import { parseGamePhase } from "../types/game";

/**
 * FE-06 — `/game/email` phase page (round briefing).
 *
 * Shows a big "Round N" hero while the game is in a `round_N_email` phase;
 * when the professor advances to `round_N_decide`, this page auto-navigates.
 *
 * A24-I04 — surfaces a visible countdown driven by the shared
 * `usePhaseCountdownSeconds` hook so students can see how long they have
 * before the phase flips. Auto-advance is handled by ProfessorPage +
 * GamePhaseListener so no advance callable is fired from here.
 *
 * A24-I07 — on Round 1, displays a "your team starts with $X" chip so
 * players know their starting budget before the first auction begins.
 */

const FLOATS = [
  "croissant",
  "coffee",
  "bagel",
  "cookie",
  "matcha",
  "sandwich",
] as const;

// Backend default; mirrored here so the chip renders something useful even
// before the game's config sub-doc has synced. See
// backend/functions/modules/config.js DEFAULT_GAME_CONFIG.startingBudget.
const DEFAULT_STARTING_BUDGET = 500000;

export function EmailPhasePage() {
  useGamePhaseNav();
  const { gameId, currentRound, phase, config } = useGame();
  const navigate = useNavigate();
  const secondsLeft = usePhaseCountdownSeconds();

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
  const isRound1 = currentRound === 1;
  const startingBudget =
    typeof config?.startingBudget === "number" && config.startingBudget > 0
      ? config.startingBudget
      : DEFAULT_STARTING_BUDGET;

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

          {isRound1 && (
            <div
              className="round-briefing__starter-chip"
              aria-label="Starting budget"
            >
              Your team starts with{" "}
              <strong>{formatMoney(startingBudget)}</strong> — spend wisely.
            </div>
          )}

          {secondsLeft !== null && (
            <div
              className={`round-briefing__timer${
                secondsLeft <= 5 ? " round-briefing__timer--urgent" : ""
              }`}
              aria-live="polite"
            >
              {secondsLeft > 0
                ? `${secondsLeft}s until briefing closes`
                : "Briefing closing…"}
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}
