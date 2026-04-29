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
 *   - Live "N / M submitted" pulled from
 *     `submissionCounts/round_{N}_{phase}` (count-only mirror written by
 *     Cloud Functions alongside the professor-only `/submissions` doc — see
 *     `firestore.rules` and `recordSubmission` in `functions/index.js`).
 *   - A role-gated submit button supplied by the parent via `action`.
 *
 * The component is intentionally dumb about *what* a submit does — each
 * phase passes its own `action` node (usually a `<button onClick={...}>`).
 * This keeps the role-gating / callable wiring inside the phase page while
 * the visual chrome + timer + submission-count stays consistent.
 *
 * Privacy: this component intentionally reads the count-only mirror, not
 * `/submissions` itself, so opposing teams' submission identities and
 * timestamps stay hidden during live phases (FRONTEND.md Hard UI Rule #4).
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

  const [submittedCount, setSubmittedCount] = useState<number>(0);
  const [canReadCount, setCanReadCount] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  // Tick once a second for the countdown.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Subscribe to the per-phase submission count mirror. We read the
  // count-only doc (not /submissions itself) so this works for player
  // accounts without the professor claim and without leaking opposing-team
  // submission identities.
  useEffect(() => {
    if (!gameId || !currentRound) {
      // Clearing happens in the cleanup; don't call setState in the body.
      return;
    }
    const docId = `round_${currentRound}_${phase}`;
    const countRef = doc(db, "games", gameId, "submissionCounts", docId);
    const unsubscribe = onSnapshot(
      countRef,
      (snap) => {
        if (!snap.exists()) {
          setSubmittedCount(0);
          return;
        }
        const data = snap.data() as DocumentData;
        const raw = data.count;
        setSubmittedCount(typeof raw === "number" && raw > 0 ? raw : 0);
      },
      (err) => {
        // Should not happen — /submissionCounts is signedIn-readable. Log
        // and hide the count rather than showing a misleading 0.
        console.debug("SubmissionLock snapshot error:", err);
        setSubmittedCount(0);
        setCanReadCount(false);
      },
    );
    return () => {
      unsubscribe();
      setSubmittedCount(0);
      setCanReadCount(true);
    };
  }, [gameId, currentRound, phase]);

  // The backend counts one submission per team (the Operations submitter's
  // UID), so the denominator must be the number of teams, not individual
  // players. Team members share a bakeryName, so counting unique names
  // gives the correct team-level count for both team and solo games.
  const expected = useMemo(() => {
    if (typeof expectedPlayerCount === "number") return expectedPlayerCount;
    if (players && players.length > 0) {
      return new Set(players.map((p) => p.bakeryName)).size;
    }
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
          {canReadCount ? submittedCount : "—"}
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
