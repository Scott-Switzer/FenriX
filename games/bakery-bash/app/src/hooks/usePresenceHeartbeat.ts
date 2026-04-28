import { useEffect } from "react";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../lib/firebase";

/**
 * T3.2 — heartbeat the player's presence doc every 30s while their tab
 * is visible. The professor page subscribes to this collection and flags
 * any player whose `lastSeenAt` is older than ~60s as "appears
 * disconnected", so they can be told to refresh.
 *
 * Path: `games/{gameId}/presence/{playerId}` — see the matching Firestore
 * rule which only lets the player themselves write their own doc.
 *
 * Cost
 * ────
 * 1 write / 30s / player while the tab is visible. Even at 70 players
 * that's ~140 writes/min, well below Firestore's per-collection cap.
 *
 * Design notes
 * ────────────
 * - First ping fires immediately on mount so the prof sees the player
 *   appear without a 30s delay.
 * - When the tab is backgrounded (`document.visibilityState === 'hidden'`)
 *   we stop pinging. Returning to the tab triggers an immediate ping +
 *   resumes the interval. Background tabs aren't really "playing", and
 *   killing the ping when they background means the prof's
 *   "disconnected" banner correctly catches them as gone.
 * - Failures are swallowed (debug-logged). A presence write failure must
 *   never break the player's actual gameplay.
 */
export function usePresenceHeartbeat(
  gameId: string | null,
  playerId: string | null,
  displayName?: string,
) {
  useEffect(() => {
    if (!gameId || !playerId) return;

    const presenceRef = doc(db, "games", gameId, "presence", playerId);

    const ping = () => {
      const payload: Record<string, unknown> = {
        uid: playerId,
        lastSeenAt: serverTimestamp(),
      };
      if (displayName) payload.displayName = displayName;
      setDoc(presenceRef, payload, { merge: true }).catch((err) => {
        console.debug("presence ping failed (non-fatal):", err);
      });
    };

    let intervalId: number | null = null;

    const start = () => {
      if (intervalId !== null) return;
      ping();
      intervalId = window.setInterval(ping, 30_000);
    };

    const stop = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [gameId, playerId, displayName]);
}
