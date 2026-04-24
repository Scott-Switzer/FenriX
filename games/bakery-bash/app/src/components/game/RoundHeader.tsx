import { useState } from "react";
import { useGame } from "../../contexts/GameContext";
import { usePhaseCountdownSeconds } from "../../hooks/usePhaseCountdownSeconds";
import { CsvInboxModal } from "./CsvInboxModal";
import { GameProgressBar } from "./GameProgressBar";
import {
  PLAYER_ROLE_LABELS,
  parseGamePhase,
  roleOwnsDecide,
  roleOwnsAdBids,
  roleOwnsChefBids,
  roleOwnsRoster,
  type MaintenanceBars,
  type RoundResult,
  type StaffCounts,
} from "../../types/game";

const PHASE_LABELS: Record<string, string> = {
  lobby:         "Lobby",
  email:         "Briefing",
  decide:        "Decisions Round",
  bid_ad:        "Ad Auction",
  bid_chef:      "Chef Auction",
  roster:        "Kitchen Roster",
  simulating:    "Round in Progress\u2026",
  results_ready: "Results",
  game_over:     "Game Over",
};

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

// eslint-disable-next-line react-refresh/only-export-components
export function downloadResultsCsv(results: RoundResult[]) {
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

export function RoundHeader() {
  const {
    currentRound,
    totalRounds,
    teamName,
    player,
    role,
    teamId,
    teamRoleAssignments,
    phase,
  } = useGame();

  const [inboxOpen, setInboxOpen] = useState(false);
  const displaySeconds = usePhaseCountdownSeconds();

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Team label preference: explicit team name → bakery name → display name.
  const teamLabel =
    teamName ?? player?.bakeryName ?? player?.name ?? null;

  const parsed = parseGamePhase(phase ?? "lobby", currentRound ?? 1);
  const phaseBannerLabel = PHASE_LABELS[parsed.base] ?? phase ?? "";

  const roleLabel = PLAYER_ROLE_LABELS[role];
  // FE-I15: pass team roleAssignments so the "active role" pip also
  // lights up for teammates filling a vacant specialist role.
  const isActiveRole =
    (parsed.base === "decide" && roleOwnsDecide(role, teamRoleAssignments)) ||
    (parsed.base === "bid_ad" && roleOwnsAdBids(role, teamRoleAssignments)) ||
    (parsed.base === "bid_chef" && roleOwnsChefBids(role, teamRoleAssignments)) ||
    (parsed.base === "roster" && roleOwnsRoster(role, teamRoleAssignments));

  return (
    <header className="round-header">
      <div className="round-header__phase-banner">
        {phaseBannerLabel}
      </div>

      <button
        type="button"
        className="round-header__email round-header__csv-inbox"
        onClick={() => setInboxOpen(true)}
        title="Open CSV inbox"
        aria-label="Open CSV inbox"
      >
        <img
          src="/assets/ui/email.svg"
          alt=""
          aria-hidden="true"
          className="round-header__csv-inbox-icon"
        />
        <span className="round-header__csv-inbox-label">CSV Inbox</span>
      </button>

      <CsvInboxModal open={inboxOpen} onClose={() => setInboxOpen(false)} />

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
            <div className={`round-header__role-badge${isActiveRole ? " round-header__role-badge--active" : ""}`}>
              {isActiveRole ? `Your turn: ${roleLabel}` : `Active: ${roleLabel}`}
            </div>
          )}
        </div>
      )}

      {displaySeconds !== null && (
        <div
          className={`round-header__timer ${
            displaySeconds < 30 ? "round-header__timer--urgent" : ""
          }`}
        >
          {displaySeconds <= 0
            ? <span className="round-header__timer-expired">Time's up — waiting for professor</span>
            : formatTime(displaySeconds)
          }
        </div>
      )}

      <div className="round-header__progress">
        <GameProgressBar />
      </div>
    </header>
  );
}
