import { useEffect, useState } from "react";
import { doc, onSnapshot, type DocumentData } from "firebase/firestore";
import { useGame } from "../contexts/GameContext";
import { db } from "../lib/firebase";
import { formatMoney } from "../lib/cost";
import { readNumber } from "../lib/utils";
import { PageShell } from "../components/ui/PageShell";

/**
 * Per-player ranking row as written by `simulateRound` to
 * `/games/{gameId}/leaderboard/latest`. Authoritative shape lives in
 * `backend/functions/index.js` (search for `gameRef.collection('leaderboard')`).
 *
 * Note on canonical path: PR #25 settled the long-standing `current` vs
 * `latest` ambiguity in favor of `latest`. The P1 task spec still references
 * `/leaderboard/current`; we follow the production code (and the updated
 * schema doc) here.
 *
 * Note on field names: the spec lists `cumulativeRevenue`. The production
 * simulation writes `revenueNet` per round. We render `revenueNet` as
 * "Revenue" and fall back to `cumulativeRevenue` if the backend realigns.
 *
 * Budget is intentionally NOT displayed on this player-facing page per
 * FRONTEND.md Hard UI Rule #1 ("Budget is hidden during play"). The
 * professor leaderboard is the only leaderboard allowed to show budget.
 */
interface LeaderboardRanking {
  rank: number;
  playerId: string;
  displayName: string;
  bakeryName?: string;
  revenueNet?: number;
  cumulativeRevenue?: number;
}

interface LeaderboardDocument {
  round: number;
  rankings: LeaderboardRanking[];
  updatedAt: { toDate?: () => Date } | null;
}

export function LeaderboardPage() {
  const { gameId, playerId } = useGame();
  const [board, setBoard] = useState<LeaderboardDocument | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [boardReady, setBoardReady] = useState(false);

  // ── Subscribe to /games/{gameId}/leaderboard/latest ──
  // Cloud Functions overwrite this document at the end of each round. We
  // distinguish "doc absent" (waiting for first round) from "listener not
  // initialized" via the `boardReady` flag so the empty state doesn't flash
  // on first paint.
  useEffect(() => {
    if (!gameId) return;
    const lbRef = doc(db, "games", gameId, "leaderboard", "latest");
    const unsubscribe = onSnapshot(
      lbRef,
      (snap) => {
        setBoardReady(true);
        if (!snap.exists()) {
          setBoard(null);
          return;
        }
        const data = snap.data() as DocumentData;
        const rankings = Array.isArray(data.rankings)
          ? (data.rankings as LeaderboardRanking[])
          : [];
        setBoard({
          round: typeof data.round === "number" ? data.round : 0,
          rankings,
          updatedAt: data.updatedAt ?? null,
        });
        setBoardError(null);
      },
      (err) => {
        console.error("leaderboard/latest listener error", { gameId, err });
        setBoardError("Could not load the leaderboard.");
        setBoardReady(true);
      },
    );
    return unsubscribe;
  }, [gameId]);

  const rankings = board?.rankings ?? [];
  // Suppress the "waiting for first round" empty-state when the listener
  // errored — the error banner already explains why the table is empty, and
  // showing both at once is contradictory.
  const waitingForFirstRound =
    boardReady && !boardError && rankings.length === 0;

  return (
    <PageShell className="leaderboard-page">
      <h1 className="leaderboard-page__title">
        Leaderboard
        {board?.round ? (
          <span className="leaderboard-page__round"> · Round {board.round}</span>
        ) : null}
      </h1>

      {boardError && (
        <p className="leaderboard-page__error" role="alert">
          {boardError}
        </p>
      )}

      <table className="leaderboard-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Bakery</th>
            <th>Revenue</th>
          </tr>
        </thead>
        <tbody>
          {!boardReady ? (
            <tr>
              <td colSpan={3} className="leaderboard-table__empty">
                Loading leaderboard…
              </td>
            </tr>
          ) : waitingForFirstRound ? (
            <tr>
              <td colSpan={3} className="leaderboard-table__empty">
                Waiting for first round results…
              </td>
            </tr>
          ) : (
            rankings.map((entry) => {
              const isYou = entry.playerId === playerId;
              const revenue = readNumber(
                entry.revenueNet,
                entry.cumulativeRevenue,
              );
              return (
                <tr
                  key={entry.playerId}
                  className={isYou ? "leaderboard-table__row--you" : ""}
                >
                  <td>{entry.rank}</td>
                  <td>
                    {entry.bakeryName || entry.displayName}
                    {isYou && (
                      <span className="leaderboard-table__you-tag"> (you)</span>
                    )}
                  </td>
                  <td>{formatMoney(revenue)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </PageShell>
  );
}
