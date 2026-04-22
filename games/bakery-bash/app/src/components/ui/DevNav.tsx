import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useGame, useGameDispatch } from "../../contexts/GameContext";
import { parseGamePhase, type GamePhaseString } from "../../types/game";
import { isDevModeEnabled, syncDevModeFromUrl } from "../../lib/devMode";

/**
 * Dev-only shortcuts for jumping between phases. Phase strings use the
 * backend's `round_N_<phase>` convention for in-round phases.
 */
const PHASE_JUMPS: { label: string; value: GamePhaseString }[] = [
  { label: "decide",        value: "round_1_decide"  },
  { label: "bid_ad",        value: "round_1_bid_ad"  },
  { label: "bid_chef",      value: "round_1_bid_chef" },
  { label: "roster",        value: "round_1_roster"  },
  { label: "simulating",    value: "simulating"      },
  { label: "results_ready", value: "results_ready"   },
];

export function DevNav() {
  const { phase, auctionTab } = useGame();
  const dispatch = useGameDispatch();

  // Mirror the `?dev=1` / `?dev=0` URL param to localStorage on mount, then
  // track the flag in state so toggling it elsewhere (e.g. the Professor
  // page button) re-renders the nav without a page reload.
  const [visible, setVisible] = useState<boolean>(() => syncDevModeFromUrl());

  useEffect(() => {
    const onChange = () => setVisible(isDevModeEnabled());
    window.addEventListener("bakery-bash:dev-mode-change", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("bakery-bash:dev-mode-change", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  if (!visible) return null;

  const setPhase = (p: GamePhaseString) => {
    dispatch({ type: "SET_PHASE", payload: p });
    const parsed = parseGamePhase(p);
    if (parsed.round && parsed.round > 0) {
      dispatch({ type: "SET_ROUND", payload: parsed.round });
    }
  };

  const base = parseGamePhase(phase).base;
  const isAuctionPhase = base === "bid_ad" || base === "bid_chef";

  return (
    <nav className="dev-nav">
      <span className="dev-nav__label">DEV</span>
      <Link to="/">Landing</Link>
      <Link to="/lobby">Lobby</Link>
      {PHASE_JUMPS.map((p) => (
        <Link
          key={p.value}
          to={p.value.includes("bid_") ? "/auction" : "/game"}
          onClick={() => setPhase(p.value)}
        >
          {p.label}
        </Link>
      ))}
      <Link to="/leaderboard">Board</Link>
      <Link to="/professor">Prof</Link>
      {isAuctionPhase && (
        <span className="dev-nav__phase-indicator">
          auction tab: {auctionTab === "chefs" ? "Chef Hiring" : "Advertisements"}
        </span>
      )}
    </nav>
  );
}
