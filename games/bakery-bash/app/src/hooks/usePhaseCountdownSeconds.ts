import { useEffect, useState } from "react";
import { useGame } from "../contexts/GameContext";

/**
 * Live phase countdown derived from `games/{gameId}.phaseEndsAt`.
 *
 * Re-ticks every 500ms (sub-second granularity for smooth final-10s feel)
 * and clamps at zero. Returns `null` whenever the backend hasn't set an
 * end time (lobby / paused / between phases) so callers can hide the
 * timer entirely instead of rendering `0:00`.
 *
 * Single source of truth for the phase timer — both RoundHeader and the
 * email briefing read from this hook so they can never disagree.
 */
export function usePhaseCountdownSeconds(): number | null {
  const { phaseEndsAtMs } = useGame();
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (phaseEndsAtMs === null) return;
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(tick);
  }, [phaseEndsAtMs]);

  if (phaseEndsAtMs === null) return null;
  return Math.max(0, Math.ceil((phaseEndsAtMs - now) / 1000));
}
