import { useEffect, useRef } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase";

/**
 * M-22 (2026-04-28) — fan-out staleness ticker.
 *
 * Every active tab fires `markStalePlayersDisconnected({ gameId })` on a
 * coarse interval (default 60s). The backend callable scans presence docs,
 * flips `players/{uid}.disconnected = true` on stale uids (last seen > 90s
 * ago), and clears their team `roleAssignments` claim if they hold one
 * during a submission phase. After that, FE-I15's vacant-role fallback lets
 * remaining teammates submit on the disconnected player's behalf without
 * the prof manually intervening.
 *
 * Why every tab pings instead of a Cloud Scheduler cron:
 *   • Cloud Scheduler infra wasn't deployed pre-Friday and adding it
 *     mid-week is risky.
 *   • Every active player tab + the prof tab can naturally fan out the
 *     work — at least one of them will hit the staleness window inside
 *     the 60s cadence.
 *   • The callable is idempotent — concurrent ticks across tabs converge
 *     on the same write set.
 *
 * The hook is a no-op when:
 *   • gameId is null (player hasn't joined yet)
 *   • the document is hidden (window is backgrounded, throttled anyway)
 *
 * Failures are swallowed (debug-logged). A staleness tick failure must
 * never break the player's actual gameplay.
 */
const TICK_INTERVAL_MS = 60_000;

export function useStalePresenceTicker(gameId: string | null) {
  const lastFireRef = useRef<number>(0);

  useEffect(() => {
    if (!gameId) return;

    const callable = httpsCallable<
      { gameId: string },
      {
        gameId: string;
        staleCount: number;
        rolesCleared: number;
        scannedAt: number;
        phase: string;
      }
    >(functions, "markStalePlayersDisconnected");

    const tick = () => {
      // De-dupe across multiple effect runs in the same window — the
      // callback can fire when the tab returns to visible AND when the
      // interval rolls over within a few ms of each other.
      const now = Date.now();
      if (now - lastFireRef.current < 30_000) return;
      lastFireRef.current = now;
      callable({ gameId }).catch((err) => {
        console.debug("markStalePlayersDisconnected failed (non-fatal):", err);
      });
    };

    let intervalId: number | null = null;

    const start = () => {
      if (intervalId !== null) return;
      // Stagger the first fire by 5s so a fresh page load doesn't immediately
      // hammer the callable while everyone else is still booting.
      const initialDelay = window.setTimeout(tick, 5_000);
      intervalId = window.setInterval(tick, TICK_INTERVAL_MS);
      // Track the timeout so cleanup can clear it; using interval handle for
      // the named slot.
      return () => window.clearTimeout(initialDelay);
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

    let cleanupInitial: (() => void) | undefined;
    if (document.visibilityState === "visible") {
      cleanupInitial = start();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      cleanupInitial?.();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [gameId]);
}
