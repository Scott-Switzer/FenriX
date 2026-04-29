import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  type DocumentData,
} from "firebase/firestore";
import { db } from "../lib/firebase";

/**
 * Lightweight roster-by-uid listener for `/games/{gameId}/roster`.
 *
 * S-01 (2026-04-29): RoundHeader needs teammate display names to render
 * the per-teammate role roster pills, but until now the only `rosterByUid`
 * subscriptions lived inside specific pages (`AuctionPage`, `GamePage`,
 * `ProfessorPage`). Hoisting the same shape into a single hook lets the
 * header subscribe without re-implementing the listener — and gives those
 * pages a path to consolidate later.
 *
 * The hook returns an empty map until the snapshot lands; callers should
 * fall back to the uid (or another label) when a row is missing so a
 * just-joined player still renders a pill.
 */
export interface RosterEntry {
  displayName: string;
  bakeryName: string;
}

export function useGameRoster(
  gameId: string | null,
): Record<string, RosterEntry> {
  const [rosterByUid, setRosterByUid] = useState<Record<string, RosterEntry>>(
    {},
  );

  useEffect(() => {
    if (!gameId) {
      setRosterByUid({});
      return;
    }
    const rosterRef = collection(db, "games", gameId, "roster");
    const unsubscribe = onSnapshot(
      rosterRef,
      (snap) => {
        const map: Record<string, RosterEntry> = {};
        snap.docs.forEach((d) => {
          const data = d.data() as DocumentData;
          const uid = typeof data.uid === "string" ? data.uid : d.id;
          map[uid] = {
            displayName:
              typeof data.displayName === "string"
                ? data.displayName
                : "Player",
            bakeryName:
              typeof data.bakeryName === "string" &&
              data.bakeryName.length > 0
                ? data.bakeryName
                : typeof data.displayName === "string"
                ? data.displayName
                : "Player",
          };
        });
        setRosterByUid(map);
      },
      (err) => {
        // Match the existing per-page listeners' error handling so a
        // permission-denied (e.g. fresh anon auth before claim propagation)
        // doesn't crash the header — we just keep the empty map.
        console.error("useGameRoster listener error:", { gameId, err });
      },
    );
    return unsubscribe;
  }, [gameId]);

  return rosterByUid;
}
