import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  type DocumentData,
  type Timestamp,
} from "firebase/firestore";
import { db } from "../lib/firebase";

/**
 * Live presence map for a game — `{ [uid]: lastSeenMs }`.
 *
 * S-06 (2026-04-29): RoundHeader needs to detect stale teammates so it
 * can render "Take over <role>" buttons next to their pills (calls the
 * `reclaimTeammateRole` callable shipped with M-10). Mirrors the
 * subscription `ProfessorPage` already does on the same collection;
 * keeping the listener inline in a hook means future surfaces (e.g.
 * GamePage banners under M-22) can reuse it without re-implementing.
 *
 * The hook also tracks a `now` clock that ticks once a second so the
 * "stale" derivation can be reactive without re-subscribing on every
 * presence write.
 */
export interface PresenceState {
  /** Map of uid → last-seen wall-clock millis (Firestore server timestamp). */
  presenceByUid: Record<string, number>;
  /** Wall-clock millis sampled once per second so stale checks re-evaluate. */
  nowMs: number;
}

export function useGamePresence(gameId: string | null): PresenceState {
  const [presenceByUid, setPresenceByUid] = useState<Record<string, number>>(
    {},
  );
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!gameId) {
      setPresenceByUid({});
      return;
    }
    const presenceRef = collection(db, "games", gameId, "presence");
    const unsubscribe = onSnapshot(
      presenceRef,
      (snap) => {
        const next: Record<string, number> = {};
        snap.docs.forEach((d) => {
          const data = d.data() as DocumentData;
          const ts = data.lastSeenAt as Timestamp | null | undefined;
          if (ts && typeof ts.toMillis === "function") {
            next[d.id] = ts.toMillis();
          }
        });
        setPresenceByUid(next);
      },
      // Match the existing per-page listeners — `console.debug` so a
      // permission-denied during anon-auth handshake doesn't spam the
      // console while the claim propagates.
      (err) => {
        console.debug("useGamePresence listener error:", { gameId, err });
        setPresenceByUid({});
      },
    );
    return unsubscribe;
  }, [gameId]);

  return { presenceByUid, nowMs };
}

/**
 * Backend matches: 60s window for stale presence (`PRESENCE_STALE_MS` in
 * `backend/functions/index.js`). Keep this in lockstep — a button that
 * fires `reclaimTeammateRole` while the backend still considers the
 * teammate connected gets a `failed-precondition`.
 */
export const PRESENCE_STALE_MS = 60_000;

export function isStale(
  uid: string,
  state: PresenceState,
  staleMs: number = PRESENCE_STALE_MS,
): boolean {
  const lastSeen = state.presenceByUid[uid];
  if (lastSeen === undefined) return false;
  return state.nowMs - lastSeen > staleMs;
}
