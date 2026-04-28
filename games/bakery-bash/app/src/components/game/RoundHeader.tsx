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
 * V9 (Apr 26): expanded the export to mirror everything the Results
 * screen surfaces — gross/net revenue, loan-shark accounting, ad and
 * chef auction outcomes, per-station maintenance bars, per-product
 * units sold, and the sellout flag. Players asked for the CSV to be a
 * full record of the round so they can analyze offline.
 */
const CSV_COLUMNS = [
  "round",
  "day", // P2 (2026-04-27): 0–29 within each monthly round
  "revenue_net",
  "revenue_gross",
  "amount_borrowed",
  "interest_charged",
  "customer_count",
  "customer_satisfaction",
  "cleanliness_pct",
  "oven_health_pct",
  "slicer_health_pct",
  "espresso_health_pct",
  "bakery_sous_chef_count",
  "deli_sous_chef_count",
  "barista_sous_chef_count",
  "maintenance_guy_count",
  "ad_won",
  "ad_paid",
  "chef_won",
  "chef_paid",
  "sellout",
  // -- Decision inputs (P1, 2026-04-27): student-side X for re-training. --
  // The CSV without these is outcome-only and a student can't fit y ~ X.
  "num_products",
  "price_croissant",
  "price_cookie",
  "price_bagel",
  "price_sandwich",
  "price_coffee",
  "price_matcha",
  "croissant_qty_stocked",
  "cookie_qty_stocked",
  "bagel_qty_stocked",
  "sandwich_qty_stocked",
  "coffee_qty_stocked",
  "matcha_qty_stocked",
  // -- Decision outcomes --
  "croissants_sold",
  "cookies_sold",
  "bagels_sold",
  "sandwiches_sold",
  "coffees_sold",
  "matchas_sold",
] as const;

function pct(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  return String(Math.round(n));
}

function num(n: number | undefined | null): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "";
}

/** CSV-safe string: wrap in quotes + escape internal quotes if needed. */
function csvCell(value: string | undefined | null): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function bar(bars: MaintenanceBars | undefined, key: keyof MaintenanceBars): string {
  return pct(bars?.[key]);
}

/**
 * P2 (2026-04-27): a per-day row uses `r` for the round-level / decision
 * inputs and `daily` (when present) for the outcome columns that vary
 * day to day. When `daily` is undefined, we emit a single row using
 * the round-level outcome fields (legacy / pre-P2 rounds).
 */
type DailyRow = NonNullable<RoundResult["dailyBreakdown"]>[number];

function serializeRow(r: RoundResult, daily?: DailyRow): string {
  const counts: Partial<StaffCounts> = r.staffCounts ?? {};
  const breakdown = r.productBreakdown ?? {};
  // P1 (2026-04-27): decision-input fields surfaced from the backend.
  const prices = r.productPrices ?? {};
  const stocked = r.quantitiesStocked ?? {};
  // Prefer revenueNet for the headline figure but emit gross alongside so
  // analysts can audit the loan-shark deduction. P2: when emitting a
  // per-day row, use the daily outcome values (which vary across the
  // round's 30 days because of the demand multiplier). Loan-shark figures
  // (amount_borrowed, interest_charged) are apportioned per day in the
  // backend wrapper so sum-of-daily === monthly. Falling back to monthly
  // r.amountBorrowed on every daily row would make column-sums = 30x
  // the actual loan.
  const revenueNet = daily
    ? daily.revenueNet
    : typeof r.revenueNet === "number"
      ? r.revenueNet
      : typeof r.revenue === "number"
        ? r.revenue
        : undefined;
  const revenueGross = daily ? daily.revenueGross : r.revenueGross;
  const amountBorrowed = daily ? daily.amountBorrowed ?? 0 : r.amountBorrowed;
  const interestCharged = daily ? daily.interestCharged ?? 0 : r.interestCharged;
  const customerCount = daily ? daily.customerCount : r.customerCount;
  const customerSatisfaction = daily
    ? daily.aggregateSatisfactionPct
    : r.customerSatisfaction;
  const dayValue = daily ? daily.day : 0;
  // Ad winner: backend emits a single `adWon` string (TV / Billboard / Radio
  // / Newspaper) plus an `adWins` array on multi-win rounds. Join the array
  // when present so players don't lose data; fall back to the singular.
  const adWon =
    Array.isArray(r.adWins) && r.adWins.length > 0
      ? r.adWins.join("; ")
      : r.adWon ?? r.auctionResults?.adWon ?? "";
  // Chef winner — names preferred, ids as fallback. The chef-name array
  // lives on `chefsWon`; pre-FE-4 results docs only carried a single id
  // on `auctionResults.chefWon`.
  const chefWon =
    Array.isArray(r.chefsWon) && r.chefsWon.length > 0
      ? r.chefsWon
          .map((c) => (c?.name && String(c.name).trim()) || c?.id || "")
          .filter((s) => s)
          .join("; ")
      : r.auctionResults?.chefWon ?? "";

  return [
    r.round,
    dayValue,
    num(revenueNet),
    num(revenueGross),
    num(amountBorrowed),
    num(interestCharged),
    customerCount,
    customerSatisfaction,
    bar(r.maintenanceBars, "cleanliness"),
    bar(r.maintenanceBars, "ovenHealth"),
    bar(r.maintenanceBars, "slicerHealth"),
    bar(r.maintenanceBars, "espressoHealth"),
    num(counts.bakerySousChefs),
    num(counts.deliSousChefs),
    num(counts.baristaSousChefs),
    num(counts.maintenanceGuys),
    csvCell(adWon),
    num(r.adPaid),
    csvCell(chefWon),
    num(r.chefBidPaid),
    r.selloutAnywhere ? "1" : "0",
    // -- Decision inputs (P1) --
    num(r.numProducts),
    num(prices.croissant),
    num(prices.cookie),
    num(prices.bagel),
    num(prices.sandwich),
    num(prices.coffee),
    num(prices.matcha),
    num(stocked.croissant),
    num(stocked.cookie),
    num(stocked.bagel),
    num(stocked.sandwich),
    num(stocked.coffee),
    num(stocked.matcha),
    // -- Decision outcomes --
    num(breakdown.croissant),
    num(breakdown.cookie),
    num(breakdown.bagel),
    num(breakdown.sandwich),
    num(breakdown.coffee),
    num(breakdown.matcha),
  ].join(",");
}

// eslint-disable-next-line react-refresh/only-export-components
export function downloadResultsCsv(results: RoundResult[]) {
  const header = CSV_COLUMNS.join(",");
  // P2 (2026-04-27): emit one row per day per round when dailyBreakdown
  // is present. Decision-input columns are constant across the 30 days
  // of a round (the player only made one set of decisions for the month);
  // outcome columns (revenue_net, customer_count, customer_satisfaction)
  // vary day to day because of the demand multiplier. Pre-P2 rounds
  // without dailyBreakdown fall back to one row per round.
  const rows: string[] = [];
  for (const r of results) {
    const daily = r.dailyBreakdown ?? [];
    if (daily.length > 0) {
      for (const d of daily) rows.push(serializeRow(r, d));
    } else {
      rows.push(serializeRow(r));
    }
  }
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
