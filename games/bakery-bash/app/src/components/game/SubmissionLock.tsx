import { useEffect, useMemo, useState } from "react";
import {
  doc,
  onSnapshot,
  type DocumentData,
} from "firebase/firestore";
import { db } from "../../lib/firebase";
import { useGame } from "../../contexts/GameContext";

/**
 * FE-17 — Shared phase-submission footer for Decide / BidAd / BidChef /
 * Roster screens. Shows:
 *   - Countdown to `phaseEndsAt` (seconds precision).
 *   - Live "N / M submitted" pulled from `submissions/round_{N}_{phase}`
 *     (BE-22 mirror: `{[uid]: {status: "submitted", ...}}`).
 *   - A role-gated submit button supplied by the parent via `action`.
 *
 * The component is intentionally dumb about *what* a submit does — each
 * phase passes its own `action` node (usually a `<button onClick={...}>`).
 * This keeps the role-gating / callable wiring inside the phase page while
 * the visual chrome + timer + submission-count stays consistent.
 */

export type SubmissionPhaseKey = "decide" | "bid_ad" | "bid_chef" | "roster";

export interface SubmissionLockProps {
  /** Which submission doc to watch: `round_{N}_{phase}`. */
  phase: SubmissionPhaseKey;
  /** Right-aligned action (usually the phase's submit button). */
  action?: React.ReactNode;
  /**
   * Optional override for expected total players. If omitted we fall back
   * to `GameState.totalPlayers` (set by the game-doc listener).
   */
  expectedPlayerCount?: number;
  /** When `true`, render a "Locked in" pill + disable-looking state. */
  submitted?: boolean;
  /** Extra hint text shown under the timer. */
  hint?: React.ReactNode;
}


export function SubmissionLock({
  phase,
  action,
  expectedPlayerCount,
  submitted,
  hint,
}: SubmissionLockProps) {
  const { gameId, currentRound, phaseEndsAtMs, players } = useGame();

  const [submittedUids, setSubmittedUids] = useState<string[]>([]);
  const [canReadCount, setCanReadCount] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  // Tick once a second for the countdown.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Subscribe to the per-phase submission mirror.
  useEffect(() => {
    if (!gameId || !currentRound) {
      // Clearing happens in the cleanup; don't call setState in the body.
      return;
    }
    const docId = `round_${currentRound}_${phase}`;
    const submissionRef = doc(db, "games", gameId, "submissions", docId);
    const unsubscribe = onSnapshot(
      submissionRef,
      (snap) => {
        if (!snap.exists()) {
          setSubmittedUids([]);
          return;
        }
        const data = snap.data() as DocumentData;
        // The doc shape is `{[uid]: {status: "submitted", ...}}`. Treat any
        // key whose value is an object with `status === "submitted"` as
        // submitted.
        const uids = Object.entries(data)
          .filter(
            ([, v]) =>
              v && typeof v === "object" && (v as DocumentData).status === "submitted",
          )
          .map(([uid]) => uid);
        setSubmittedUids(uids);
      },
      (err) => {
        // Most players can't read /submissions (BE-22 scoped to professors);
        // hide the count rather than showing a misleading 0.
        console.debug("SubmissionLock snapshot error:", err);
        setSubmittedUids([]);
        setCanReadCount(false);
      },
    );
    return () => {
      unsubscribe();
      setSubmittedUids([]);
      setCanReadCount(true);
    };
  }, [gameId, currentRound, phase]);

  const expected = useMemo(() => {
    if (typeof expectedPlayerCount === "number") return expectedPlayerCount;
    if (players && players.length > 0) return players.length;
    return null;
  }, [expectedPlayerCount, players]);

  const remainingMs =
    typeof phaseEndsAtMs === "number" ? Math.max(0, phaseEndsAtMs - now) : null;

  const countdownTier =
    remainingMs === null
      ? "idle"
      : remainingMs <= 10_000
        ? "critical"
        : remainingMs <= 30_000
          ? "warning"
          : "normal";

  return (
    <div
      className={`submission-lock submission-lock--${phase} submission-lock--${countdownTier}`}
      data-submitted={submitted ? "true" : "false"}
    >
      <div className="submission-lock__counts">
        <span className="submission-lock__counts-label">Submitted:</span>{" "}
        <span className="submission-lock__counts-value">
          {canReadCount ? submittedUids.length : "—"}
          {expected !== null && ` / ${expected}`}
        </span>
      </div>

      <div className="submission-lock__main">
        {submitted ? (
          <span className="submission-lock__locked">
            ✓ Locked in — waiting on the others
          </span>
        ) : (
          hint && <span className="submission-lock__hint">{hint}</span>
        )}
      </div>

      {action && <div className="submission-lock__action">{action}</div>}
    </div>
  );
}
