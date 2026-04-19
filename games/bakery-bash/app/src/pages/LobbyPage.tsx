import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  type DocumentData,
  type Timestamp,
} from "firebase/firestore";
import { useGame } from "../contexts/GameContext";
import { db } from "../lib/firebase";
import { PageShell } from "../components/ui/PageShell";

/**
 * Roster entry as published to `/games/{gameId}/roster/{playerId}` by the
 * `joinGame` callable. Schema canonical source: `firestore-schema.js`
 * `RosterMemberDocument` (added in PR #25). Financial state is intentionally
 * absent — that lives on `/players/{uid}` under owner-only rules.
 */
interface RosterEntry {
  uid: string;
  displayName: string;
  bakeryName?: string;
  joinedAt?: Timestamp | null;
}

export function LobbyPage() {
  const { player, playerId, gameId, gameCode } = useGame();
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  // Distinct from `roster.length === 0`: tells us whether the snapshot
  // listener has produced *any* result yet (success or failure). Without
  // this, the fallback row paints over a successful-but-empty roster the
  // same way it paints over a still-loading one.
  const [rosterReady, setRosterReady] = useState(false);

  // ── Subscribe to /games/{gameId}/roster ──
  // Why /roster (not /players): the players collection has owner-only read
  // rules, which means a `list` query can never authorize. The roster
  // subcollection (PR #25) carries only public-safe fields and is readable
  // by any signed-in player so the lobby can render the live join order.
  useEffect(() => {
    if (!gameId) return;
    const rosterRef = collection(db, "games", gameId, "roster");
    const unsubscribe = onSnapshot(
      rosterRef,
      (snap) => {
        const entries: RosterEntry[] = snap.docs.map((d) => {
          const data = d.data() as DocumentData;
          return {
            uid: typeof data.uid === "string" ? data.uid : d.id,
            displayName:
              typeof data.displayName === "string" ? data.displayName : "Player",
            bakeryName:
              typeof data.bakeryName === "string" ? data.bakeryName : undefined,
            joinedAt: (data.joinedAt as Timestamp | null) ?? null,
          };
        });
        // Stable join-order: `joinedAt` ascending, with players whose stamp
        // hasn't materialized yet (rejoin race) appended in document order.
        entries.sort((a, b) => {
          const ta = a.joinedAt?.toMillis?.() ?? Number.POSITIVE_INFINITY;
          const tb = b.joinedAt?.toMillis?.() ?? Number.POSITIVE_INFINITY;
          if (ta !== tb) return ta - tb;
          return a.uid.localeCompare(b.uid);
        });
        setRoster(entries);
        setRosterError(null);
        setRosterReady(true);
      },
      (err) => {
        console.error("games/{gameId}/roster listener error:", err);
        setRosterError(
          "Could not load the player list. Refresh if this persists.",
        );
        setRosterReady(true);
      },
    );
    return unsubscribe;
  }, [gameId]);

  // Fallback to the local context-only "you" row only while the listener is
  // genuinely still warming up. Once we've heard from Firestore (success or
  // error) we trust its answer — even if that answer is an empty roster or
  // an error banner — so we don't double-render alongside the real list.
  const showFallback =
    !rosterReady && !rosterError && player !== null;

  return (
    <PageShell className="lobby-page">
      <div className="lobby-page__card">
        <h1 className="lobby-page__title">Waiting Room</h1>

        {gameCode && (
          <div className="lobby-page__code">
            Game Code: <strong>{gameCode}</strong>
          </div>
        )}

        {player && (
          <div className="lobby-page__bakery">
            Your bakery: <strong>{player.bakeryName}</strong>
          </div>
        )}

        <div className="lobby-page__players">
          <h2>
            Players ({rosterReady ? roster.length : "—"})
          </h2>

          {rosterError && (
            <p className="lobby-page__error" role="alert">
              {rosterError}
            </p>
          )}

          <ul className="lobby-page__player-list">
            {showFallback ? (
              <li className="lobby-page__player lobby-page__player--you">
                <span className="lobby-page__player-name">
                  {player!.name} (you)
                </span>
                {player!.bakeryName && (
                  <span className="lobby-page__player-bakery">
                    {player!.bakeryName}
                  </span>
                )}
              </li>
            ) : (
              roster.map((entry, i) => {
                const isYou = entry.uid === playerId;
                return (
                  <li
                    key={entry.uid}
                    className={`lobby-page__player${
                      isYou ? " lobby-page__player--you" : ""
                    }`}
                  >
                    <span
                      className="lobby-page__player-rank"
                      aria-hidden="true"
                    >
                      {i + 1}.
                    </span>
                    <span className="lobby-page__player-name">
                      {entry.displayName}
                      {isYou && " (you)"}
                    </span>
                    {entry.bakeryName && (
                      <span className="lobby-page__player-bakery">
                        {entry.bakeryName}
                      </span>
                    )}
                  </li>
                );
              })
            )}
          </ul>
        </div>

        <p className="lobby-page__status">
          Waiting for the professor to start the game…
        </p>
      </div>
    </PageShell>
  );
}
