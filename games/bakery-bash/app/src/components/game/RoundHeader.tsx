import { useEffect, useState } from "react";
import { useGame } from "../../contexts/GameContext";
import {
  PLAYER_ROLE_LABELS,
  type MaintenanceBars,
  type RoundResult,
  type StaffCounts,
} from "../../types/game";

/**
 * Column schema for the round-history CSV download. Kept in one place so
 * the header row and row serializer cannot drift apart.
 *
 * Replaces the legacy `staff_count` column with three per-station counts +
 * a dedicated maintenance count, and adds maintenance bar averages per the
 * game-design-proposal CSV spec.
 */
const CSV_COLUMNS = [
  "round",
  "revenue",
  "customer_count",
  "customer_satisfaction",
  "chef_satisfaction_score",
  "avg_cleanliness_pct",
  "avg_machine_health_pct",
  "bakery_sous_chef_count",
  "deli_sous_chef_count",
  "barista_sous_chef_count",
  "maintenance_guy_count",
] as const;

function pct(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  return String(Math.round(n));
}

function avgMachineHealth(bars: MaintenanceBars | undefined): string {
  if (!bars) return "";
  const { ovenHealth, slicerHealth, espressoHealth } = bars;
  const parts = [ovenHealth, slicerHealth, espressoHealth].filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n),
  );
  if (parts.length === 0) return "";
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return String(Math.round(avg));
}

function num(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "";
}

function serializeRow(r: RoundResult): string {
  const counts: Partial<StaffCounts> = r.staffCounts ?? {};
  return [
    r.round,
    r.revenue,
    r.customerCount,
    r.customerSatisfaction,
    pct(r.chefSatisfactionScore),
    pct(r.maintenanceBars?.cleanliness),
    avgMachineHealth(r.maintenanceBars),
    num(counts.bakerySousChefs),
    num(counts.deliSousChefs),
    num(counts.baristaSousChefs),
    num(counts.maintenanceGuys),
  ].join(",");
}

function downloadResultsCsv(results: RoundResult[]) {
  const header = CSV_COLUMNS.join(",");
  const rows = results.map(serializeRow);
  const blob = new Blob([header + "\n" + rows.join("\n")], {
    type: "text/csv",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "bakery-bash-results.csv";
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Live phase countdown derived from `games/{gameId}.phaseEndsAt`.
 *
 * Re-ticks every 500ms (sub-second granularity for smooth final-10s feel)
 * and clamps at zero. Returns `null` whenever the backend hasn't set an
 * end time (lobby / paused / between phases) so the header can hide the
 * timer entirely instead of rendering `0:00`.
 */
function usePhaseCountdownSeconds(): number | null {
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

export function RoundHeader() {
  const {
    currentRound,
    totalRounds,
    timeRemaining,
    roundResults,
    teamName,
    player,
    role,
    teamId,
  } = useGame();

  const phaseSeconds = usePhaseCountdownSeconds();
  // Prefer the backend-driven `phaseEndsAt` countdown; fall back to the
  // legacy local `timeRemaining` (only used by AuctionPage's tab timer
  // until `phaseEndsAt` is wired through there too).
  const displaySeconds = phaseSeconds ?? timeRemaining;

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Team label preference: explicit team name → bakery name → display name.
  const teamLabel =
    teamName ?? player?.bakeryName ?? player?.name ?? null;

  return (
    <header className="round-header">
      <button
        className="round-header__email"
        onClick={() => downloadResultsCsv(roundResults)}
        title="Download results CSV"
      >
        <img src="/assets/ui/email.svg" alt="Download CSV" />
      </button>

      <div className="round-header__round">
        Round {currentRound} of {totalRounds}
      </div>

      {teamLabel && (
        <div className="round-header__team" title="Team">
          <span className="round-header__team-label">{teamLabel}</span>
          {/* Hide the role badge until backend assignment writes a real
              teamId — otherwise every fresh client claims to be "solo"
              even when they're actually one of three teammates. */}
          {teamId && (
            <span className={`role-badge role-badge--${role}`}>
              {PLAYER_ROLE_LABELS[role]}
            </span>
          )}
        </div>
      )}

      {displaySeconds !== null && (
        <div
          className={`round-header__timer ${
            displaySeconds < 30 ? "round-header__timer--urgent" : ""
          }`}
        >
          {formatTime(displaySeconds)}
        </div>
      )}
    </header>
  );
}
