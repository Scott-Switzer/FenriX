import { useCallback, useEffect, useState } from "react";
import {
  doc,
  onSnapshot,
  type DocumentData,
} from "firebase/firestore";
import {
  httpsCallable,
  type FunctionsError,
} from "firebase/functions";
import { useGame } from "../contexts/GameContext";
import { db, functions } from "../lib/firebase";
import { PageShell } from "../components/ui/PageShell";

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

function humanizeError(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "message" in err) {
    const fnErr = err as FunctionsError;
    if (fnErr.message) return fnErr.message;
  }
  return fallback;
}

export function ProfessorPage() {
  const { gameId } = useGame();
  const [phase, setPhase] = useState<string | null>(null);
  const [paused, setPaused] = useState<boolean>(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

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
        console.error("professor: games/{gameId} listener error:", err);
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
          humanizeError(
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
    </PageShell>
  );
}
