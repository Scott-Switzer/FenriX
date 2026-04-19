import { useCallback, useEffect, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  type DocumentData,
  type Timestamp,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useGame } from "../contexts/GameContext";
import { db, functions } from "../lib/firebase";
import { PageShell } from "../components/ui/PageShell";
import { humanizeFunctionError } from "../lib/errors";
import { parseGamePhase } from "../types/game";

/**
 * Roster entry mirrored from `/games/{gameId}/roster/{uid}`. The roster
 * subcollection is the only client-readable view of joined players (PR #25).
 */
interface ProfessorRosterEntry {
  uid: string;
  displayName: string;
  bakeryName?: string;
  joinedAt?: Timestamp | null;
}

/**
 * Professor control panel.
 *
 * All four buttons call deployed Cloud Functions (`startGame`,
 * `advanceGamePhase`, `pauseGame`/`resumeGame`, `endGame`). Each callable
 * verifies the caller's `auth.uid` matches `professorUid`/`professorId` on
 * the game doc — no custom claims required, but the panel must be opened
 * by the same Firebase user that created/owns the game.
 *
 * Why callables (not direct Firestore writes): security rules deny client
 * writes to `/games/{gameId}` (`allow write: if false`). Going through the
 * callable is the only sanctioned path, and the backend wraps each
 * transition in a transaction with a precondition check (e.g. only `lobby`
 * games can be started, only the actively-playing game can be ended) that
 * a raw frontend write would bypass.
 */

interface CallableResult {
  gameId: string;
  phase?: string;
  round?: number;
  paused?: boolean;
}

export function ProfessorPage() {
  const { gameId, currentRound } = useGame();
  const [phase, setPhase] = useState<string | null>(null);
  const [paused, setPaused] = useState<boolean>(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [roster, setRoster] = useState<ProfessorRosterEntry[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [rosterReady, setRosterReady] = useState(false);

  // Mirror the game doc's phase + paused flag so button labels and
  // disabled-states reflect live backend state.
  useEffect(() => {
    if (!gameId) return;
    const gameRef = doc(db, "games", gameId);
    const unsubscribe = onSnapshot(
      gameRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as DocumentData;
        if (typeof data.phase === "string") setPhase(data.phase);
        setPaused(data.paused === true);
      },
      (err) => {
        console.error("professor: games listener error", { gameId, err });
      },
    );
    return unsubscribe;
  }, [gameId]);

  // Per-team monitoring (April 19 meeting): subscribe to the roster
  // subcollection and render one row per joined player. The richer
  // per-phase submission grid + drill-down (FE-15/FE-16) requires either
  // BE-22 (mirror submission status to a public doc) or relaxed read
  // rules on /players for professor UIDs — neither has shipped yet, so
  // for MVP we render the roster + a footnote pointing at the gap.
  useEffect(() => {
    if (!gameId) return;
    const rosterRef = collection(db, "games", gameId, "roster");
    const unsubscribe = onSnapshot(
      rosterRef,
      (snap) => {
        const entries: ProfessorRosterEntry[] = snap.docs.map((d) => {
          const data = d.data() as DocumentData;
          return {
            uid: typeof data.uid === "string" ? data.uid : d.id,
            displayName:
              typeof data.displayName === "string"
                ? data.displayName
                : "Player",
            bakeryName:
              typeof data.bakeryName === "string"
                ? data.bakeryName
                : undefined,
            joinedAt: (data.joinedAt as Timestamp | null) ?? null,
          };
        });
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
        console.error("professor: roster listener error:", err);
        setRosterError(
          "Could not load the roster. Confirm rules allow professor reads.",
        );
        setRosterReady(true);
      },
    );
    return unsubscribe;
  }, [gameId]);

  const callCallable = useCallback(
    async (
      fnName: string,
      label: string,
      onSuccessMessage: string,
    ): Promise<void> => {
      if (!gameId) {
        setError("No active game to control.");
        return;
      }
      setError(null);
      setInfo(null);
      setPendingAction(label);
      try {
        const callable = httpsCallable<{ gameId: string }, CallableResult>(
          functions,
          fnName,
        );
        await callable({ gameId });
        setInfo(onSuccessMessage);
      } catch (err) {
        setError(
          humanizeFunctionError(
            err,
            "Action failed. Confirm you are signed in as the professor for this game.",
          ),
        );
      } finally {
        setPendingAction(null);
      }
    },
    [gameId],
  );

  const onStart = () => callCallable("startGame", "start", "Game started.");
  const onAdvance = () =>
    callCallable("advanceGamePhase", "advance", "Phase advanced.");
  const onPauseResume = () =>
    paused
      ? callCallable("resumeGame", "resume", "Game resumed.")
      : callCallable("pauseGame", "pause", "Game paused.");
  const onEnd = () => {
    if (
      !window.confirm(
        "End the game now? This is permanent — no further rounds will run.",
      )
    ) {
      return;
    }
    void callCallable("endGame", "end", "Game ended.");
  };

  // Phase-aware enable rules: startGame is only valid in `lobby`; advance and
  // pause/resume are only valid once the game is running; endGame is valid
  // anywhere except `game_over`. The backend re-checks all of these, but
  // disabling the button in the obvious-no cases avoids confusing toasts.
  const inLobby = phase === "lobby";
  const inGameOver = phase === "game_over";
  const isRunning = phase !== null && !inLobby && !inGameOver;
  const busy = pendingAction !== null;

  return (
    <PageShell className="professor-page">
      <h1 className="professor-page__title">Professor Control Panel</h1>

      {gameId ? (
        <p className="professor-page__phase">
          Game phase: <strong>{phase ?? "loading…"}</strong>
          {paused && <span className="professor-page__paused"> · paused</span>}
        </p>
      ) : (
        <p className="professor-page__note">
          Join or create a game first to use these controls.
        </p>
      )}

      <div className="professor-page__controls">
        <button
          className="btn btn--primary"
          onClick={onStart}
          disabled={!gameId || busy || !inLobby}
          title={
            inLobby
              ? "Start the game and move all players to round 1."
              : "Start is only available while the game is in lobby."
          }
        >
          {pendingAction === "start" ? "Starting…" : "Start Game"}
        </button>

        <button
          className="btn btn--secondary"
          onClick={onAdvance}
          disabled={!gameId || busy || !isRunning}
          title="Advance the current round to the next phase."
        >
          {pendingAction === "advance" ? "Advancing…" : "Advance Round"}
        </button>

        <button
          className="btn btn--secondary"
          onClick={onPauseResume}
          disabled={!gameId || busy || !isRunning}
          title={paused ? "Resume the game timer." : "Pause the game timer."}
        >
          {pendingAction === "pause"
            ? "Pausing…"
            : pendingAction === "resume"
            ? "Resuming…"
            : paused
            ? "Resume Game"
            : "Pause Game"}
        </button>

        <button
          className="btn btn--danger"
          onClick={onEnd}
          disabled={!gameId || busy || inGameOver || phase === null}
          title={
            phase === null
              ? "Loading game state…"
              : "Terminate the game immediately."
          }
        >
          {pendingAction === "end" ? "Ending…" : "End Game"}
        </button>
      </div>

      {error && (
        <p className="professor-page__error" role="alert">
          {error}
        </p>
      )}
      {info && !error && (
        <p className="professor-page__info" role="status">
          {info}
        </p>
      )}

      {gameId && (
        <section className="professor-page__monitor">
          <h2 className="professor-page__monitor-title">
            Players {rosterReady ? `(${roster.length})` : "(—)"}
            {currentRound > 0 && (
              <span className="professor-page__monitor-round">
                · Round {currentRound}
                {phase ? ` · ${parseGamePhase(phase, currentRound).base}` : ""}
              </span>
            )}
          </h2>

          {rosterError && (
            <p className="professor-page__error" role="alert">
              {rosterError}
            </p>
          )}

          {rosterReady && roster.length === 0 && !rosterError && (
            <p className="professor-page__note">
              No players have joined yet.
            </p>
          )}

          {roster.length > 0 && (
            <table className="professor-monitor-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Bakery</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((entry, i) => (
                  <tr key={entry.uid}>
                    <td>{i + 1}</td>
                    <td>{entry.displayName}</td>
                    <td>{entry.bakeryName ?? "—"}</td>
                    <td title={entry.uid}>🟢 connected</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="professor-page__monitor-footnote">
            Per-phase submission status (✓ submitted / ⏳ pending) requires
            backend BE-22 to mirror player submission state to a
            professor-readable doc. Connection status is the most we can
            surface today; the per-team progress grid will appear here once
            BE-22 ships.
          </p>
        </section>
      )}
    </PageShell>
  );
}
