import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  collection,
  doc,
  onSnapshot,
  type DocumentData,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { useGame } from "../contexts/GameContext";
import { PageShell } from "../components/ui/PageShell";
import { downloadResultsCsv } from "../components/game/RoundHeader";
import type { RoundResult } from "../types/game";

/**
 * FE-13 — `/game/conclusion` page, rendered when `phase === "game_over"`.
 *
 * Per FRONTEND.md Hard UI Rule #1 this is the ONLY player-facing page
 * allowed to show `budgetCurrent` / remaining cash. The audit script
 * (`scripts/audit-ui-rules.sh`) allowlists this file, so direct reads of
 * `useGame().budgetCurrent` are intentional and auditable.
 *
 * The page renders:
 *   - Winner banner (from final `leaderboard/latest`)
 *   - Your final budget + net revenue
 *   - Per-round expansion (click to expand each round's KPIs)
 *   - Download CSV button (full history)
 */

interface LeaderboardRanking {
  rank: number;
  playerId: string;
  displayName: string;
  bakeryName?: string;
  revenueNet?: number;
  cumulativeRevenue?: number;
  budgetAfter?: number;
}

interface LeaderboardDocument {
  round: number;
  rankings: LeaderboardRanking[];
}

function formatMoney(n: number | null | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function ConclusionPage() {
  const { gameId, playerId, roundResults, budgetCurrent } = useGame();

  const [board, setBoard] = useState<LeaderboardDocument | null>(null);
  const [perRoundBreakdowns, setPerRoundBreakdowns] = useState<
    Record<number, RoundResult>
  >({});
  const [expanded, setExpanded] = useState<number | null>(null);

  // Subscribe to leaderboard/latest.
  useEffect(() => {
    if (!gameId) return;
    const boardRef = doc(db, "games", gameId, "leaderboard", "latest");
    const unsubscribe = onSnapshot(
      boardRef,
      (snap) => {
        if (!snap.exists()) {
          setBoard(null);
          return;
        }
        const data = snap.data() as DocumentData;
        setBoard({
          round: typeof data.round === "number" ? data.round : 0,
          rankings: Array.isArray(data.rankings)
            ? (data.rankings as LeaderboardRanking[])
            : [],
        });
      },
      (err) => {
        console.error("conclusion leaderboard listener error:", { gameId, err });
      },
    );
    return unsubscribe;
  }, [gameId]);

  // Subscribe to this player's per-round results subcollection for fuller
  // expansion data (RoundResultDocument from firestore-schema.js).
  useEffect(() => {
    if (!gameId || !playerId) return;
    const roundsCol = collection(
      db,
      "games",
      gameId,
      "players",
      playerId,
      "rounds",
    );
    const unsubscribe = onSnapshot(
      roundsCol,
      (snap) => {
        const next: Record<number, RoundResult> = {};
        snap.forEach((docSnap) => {
          const data = docSnap.data() as DocumentData;
          const round =
            typeof data.round === "number" ? data.round : parseRoundId(docSnap.id);
          if (typeof round !== "number") return;
          next[round] = {
            round,
            revenue:
              typeof data.revenueNet === "number"
                ? data.revenueNet
                : typeof data.revenueGross === "number"
                  ? data.revenueGross
                  : 0,
            revenueNet: data.revenueNet,
            revenueGross: data.revenueGross,
            amountBorrowed: data.amountBorrowed,
            interestCharged: data.interestCharged,
            customerCount:
              typeof data.customerCount === "number" ? data.customerCount : 0,
            customerSatisfaction:
              typeof data.aggregateSatisfactionPct === "number"
                ? Math.round(data.aggregateSatisfactionPct)
                : 0,
            chefSatisfactionScore: data.chefSatisfactionScore,
            productBreakdown: data.productBreakdown,
            auctionResults: {
              adWon: data.adWon ?? null,
              chefWon: data.chefWon ?? null,
            },
          };
        });
        setPerRoundBreakdowns(next);
      },
      (err) => {
        console.error("conclusion per-round listener error:", { gameId, playerId, err });
      },
    );
    return unsubscribe;
  }, [gameId, playerId]);

  const rankings = board?.rankings ?? [];
  const winner = rankings.find((r) => r.rank === 1) ?? null;
  const you = rankings.find((r) => r.playerId === playerId) ?? null;

  // Fall back to the last round's running revenue if leaderboard hasn't
  // hydrated yet.
  const fallbackRevenue =
    roundResults.length > 0
      ? roundResults[roundResults.length - 1].revenueNet ??
        roundResults[roundResults.length - 1].revenue
      : null;

  const finalRevenue =
    you?.cumulativeRevenue ?? you?.revenueNet ?? fallbackRevenue;

  const finalBudget = you?.budgetAfter ?? budgetCurrent ?? null;

  // Merge per-round results: prefer the richer subcollection, fall back to
  // the lightweight `roundResults` state.
  const roundsSorted = Array.from(
    new Set([
      ...roundResults.map((r) => r.round),
      ...Object.keys(perRoundBreakdowns).map((k) => Number(k)),
    ]),
  )
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const mergedByRound: Record<number, RoundResult> = {};
  for (const r of roundResults) mergedByRound[r.round] = r;
  for (const [k, v] of Object.entries(perRoundBreakdowns)) {
    const round = Number(k);
    mergedByRound[round] = { ...mergedByRound[round], ...v };
  }

  return (
    <PageShell className="conclusion-page">
      <header className="conclusion-page__header">
        <div className="conclusion-page__eyebrow">Game over</div>
        <h1 className="conclusion-page__title">The doors are closed.</h1>
      </header>

      {winner && (
        <section className="conclusion-page__winner" aria-label="Winner">
          <div className="conclusion-page__winner-crown" aria-hidden="true">
            👑
          </div>
          <div className="conclusion-page__winner-meta">
            <div className="conclusion-page__winner-label">Winning bakery</div>
            <div className="conclusion-page__winner-name">
              {winner.bakeryName || winner.displayName}
              {winner.playerId === playerId && (
                <span className="conclusion-page__winner-you"> (you!)</span>
              )}
            </div>
            <div className="conclusion-page__winner-revenue">
              {formatMoney(winner.cumulativeRevenue ?? winner.revenueNet)} net
              revenue
            </div>
          </div>
        </section>
      )}

      {/* Your final numbers — the ONLY place budget is allowed. */}
      <section className="conclusion-page__yours">
        <h2 className="conclusion-page__section-title">Your bakery</h2>
        <div className="conclusion-page__yours-grid">
          <StatCard
            label="Final net revenue"
            value={formatMoney(finalRevenue)}
          />
          <StatCard
            label="Budget remaining"
            value={formatMoney(finalBudget)}
          />
          {you && (
            <StatCard
              label="Final rank"
              value={`#${you.rank}`}
            />
          )}
        </div>
      </section>

      {/* Full leaderboard. */}
      {rankings.length > 0 && (
        <section className="conclusion-page__leaderboard">
          <h2 className="conclusion-page__section-title">Final standings</h2>
          <table className="conclusion-page__board-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Bakery</th>
                <th>Net revenue</th>
                <th>Budget remaining</th>
              </tr>
            </thead>
            <tbody>
              {rankings.map((r) => (
                <tr
                  key={r.playerId}
                  className={
                    r.playerId === playerId
                      ? "conclusion-page__board-row--you"
                      : ""
                  }
                >
                  <td>{r.rank}</td>
                  <td>
                    {r.bakeryName || r.displayName}
                    {r.playerId === playerId && " (you)"}
                  </td>
                  <td>
                    {formatMoney(r.cumulativeRevenue ?? r.revenueNet)}
                  </td>
                  <td>{formatMoney(r.budgetAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Per-round expansion. */}
      {roundsSorted.length > 0 && (
        <section className="conclusion-page__rounds">
          <h2 className="conclusion-page__section-title">Round by round</h2>
          <ul className="conclusion-page__round-list">
            {roundsSorted.map((round) => {
              const r = mergedByRound[round];
              if (!r) return null;
              const isOpen = expanded === round;
              return (
                <li
                  key={round}
                  className="conclusion-page__round"
                  data-open={isOpen}
                >
                  <button
                    type="button"
                    className="conclusion-page__round-header"
                    onClick={() => setExpanded(isOpen ? null : round)}
                    aria-expanded={isOpen}
                  >
                    <span className="conclusion-page__round-num">
                      Round {round}
                    </span>
                    <span className="conclusion-page__round-rev">
                      {formatMoney(r.revenueNet ?? r.revenue)}
                    </span>
                    <span className="conclusion-page__round-caret" aria-hidden>
                      {isOpen ? "▾" : "▸"}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="conclusion-page__round-body">
                      <div className="conclusion-page__round-kpis">
                        <MiniKpi
                          label="Customers"
                          value={r.customerCount.toLocaleString()}
                        />
                        <MiniKpi
                          label="Satisfaction"
                          value={`${r.customerSatisfaction}/100`}
                        />
                        {typeof r.chefSatisfactionScore === "number" && (
                          <MiniKpi
                            label="Chef sat."
                            value={`${Math.round(r.chefSatisfactionScore)}/100`}
                          />
                        )}
                        {typeof r.amountBorrowed === "number" &&
                          r.amountBorrowed > 0 && (
                            <MiniKpi
                              label="Borrowed"
                              value={formatMoney(r.amountBorrowed)}
                              variant="warn"
                            />
                          )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <footer className="conclusion-page__footer">
        {roundResults.length > 0 && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => downloadResultsCsv(roundResults)}
          >
            ⬇ Download full CSV
          </button>
        )}
        <Link to="/" className="btn btn--ghost">
          Back to start
        </Link>
      </footer>
    </PageShell>
  );
}

function parseRoundId(id: string): number | null {
  const m = /^round_(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="conclusion-page__stat">
      <div className="conclusion-page__stat-label">{label}</div>
      <div className="conclusion-page__stat-value">{value}</div>
    </div>
  );
}

function MiniKpi({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant?: "warn";
}) {
  return (
    <div
      className={
        "conclusion-page__mini-kpi" +
        (variant === "warn" ? " conclusion-page__mini-kpi--warn" : "")
      }
    >
      <span className="conclusion-page__mini-kpi-label">{label}</span>
      <span className="conclusion-page__mini-kpi-value">{value}</span>
    </div>
  );
}
