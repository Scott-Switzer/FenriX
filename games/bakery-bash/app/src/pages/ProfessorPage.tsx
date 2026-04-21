import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  collection,
  doc,
  onSnapshot,
  type DocumentData,
  type Timestamp,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import { useAuth } from "../contexts/AuthContext";
import { db, functions } from "../lib/firebase";
import { PageShell } from "../components/ui/PageShell";
import { humanizeFunctionError } from "../lib/errors";
import { parseGamePhase, type BasePhase } from "../types/game";

/**
 * FE-15 — Professor control panel.
 *
 * Additions beyond the previous draft (April 19 update):
 *   - **Create Game** flow that calls the `createGame` callable (BE-18)
 *     and surfaces the returned `{gameId, joinCode}` with a
 *     copy-to-clipboard link to the landing page.
 *   - **Per-phase submission grid** from `/games/{gameId}/submissions/
 *     round_{N}_{phase}` (BE-22). Requires the signed-in user to have
 *     the `professor: true` custom claim; without it the read gets
 *     permission-denied and the grid falls back to a plain roster.
 *   - **Professor-ownership gating** — the landing-page ownership check
 *     compares the signed-in uid to the game doc's `professorUid`. If
 *     they don't match, we disable the action buttons.
 *
 * All four existing controls (`startGame`, `advanceGamePhase`,
 * `pauseGame` / `resumeGame`, `endGame`) still go through callables;
 * the backend re-verifies professor ownership on every call.
 */

interface ProfessorRosterEntry {
  uid: string;
  displayName: string;
  bakeryName?: string;
  joinedAt?: Timestamp | null;
}

interface CallableResult {
  gameId: string;
  phase?: string;
  round?: number;
  paused?: boolean;
}

interface CreateGameResult {
  gameId: string;
  joinCode: string;
}

interface SubmissionEntry {
  status: string;
  submittedAt?: Timestamp | null;
  displayName?: string;
  role?: string | null;
}

/** Which phases of a round have a corresponding submissions doc. */
const SUBMISSION_PHASES: Array<{ key: BasePhase; label: string }> = [
  { key: "decide", label: "Decide" },
  { key: "bid_ad", label: "Ad Bids" },
  { key: "bid_chef", label: "Chef Bids" },
  { key: "roster", label: "Roster" },
];

export function ProfessorPage() {
  const { gameId: contextGameId, currentRound, gameCode } = useGame();
  const dispatch = useGameDispatch();
  const { user } = useAuth();

  const [phase, setPhase] = useState<string | null>(null);
  const [paused, setPaused] = useState<boolean>(false);
  const [professorUid, setProfessorUid] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Create-game form.
  const [totalRounds, setTotalRounds] = useState<number>(5);
  const [createdGame, setCreatedGame] = useState<CreateGameResult | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  const gameId = contextGameId ?? createdGame?.gameId ?? null;

  // Roster + submissions monitor.
  const [roster, setRoster] = useState<ProfessorRosterEntry[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [rosterReady, setRosterReady] = useState(false);
  const [submissions, setSubmissions] = useState<
    Record<string, Record<string, SubmissionEntry>>
  >({});
  const [submissionsError, setSubmissionsError] = useState<string | null>(null);

  // Mirror the game doc's phase + paused flag + owner uid.
  useEffect(() => {
    if (!gameId) {
      setPhase(null);
      setPaused(false);
      setProfessorUid(null);
      return;
    }
    const gameRef = doc(db, "games", gameId);
    const unsubscribe = onSnapshot(
      gameRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as DocumentData;
        if (typeof data.phase === "string") setPhase(data.phase);
        setPaused(data.paused === true);
        if (typeof data.professorUid === "string") {
          setProfessorUid(data.professorUid);
        } else if (typeof data.professorId === "string") {
          setProfessorUid(data.professorId);
        } else {
          setProfessorUid(null);
        }
      },
      (err) => {
        console.error("professor: games listener error", { gameId, err });
      },
    );
    return unsubscribe;
  }, [gameId]);

  // Roster subcollection (public-read per rules).
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
              typeof data.bakeryName === "string" ? data.bakeryName : undefined,
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

  // BE-22 submissions mirror: subscribe to `round_{N}_{phase}` for every
  // tracked phase in the current round. We attach listeners *all four*
  // per round because a professor may want to see e.g. decide status
  // while the phase is already bid_ad.
  useEffect(() => {
    if (!gameId || !currentRound) {
      setSubmissions({});
      return;
    }
    const unsubs: Array<() => void> = [];
    SUBMISSION_PHASES.forEach(({ key }) => {
      const docId = `round_${currentRound}_${key}`;
      const submissionsRef = doc(
        db,
        "games",
        gameId,
        "submissions",
        docId,
      );
      const unsubscribe = onSnapshot(
        submissionsRef,
        (snap) => {
          setSubmissionsError(null);
          if (!snap.exists()) {
            setSubmissions((prev) => ({ ...prev, [key]: {} }));
            return;
          }
          const data = snap.data() as DocumentData;
          const byUid: Record<string, SubmissionEntry> = {};
          for (const [uid, value] of Object.entries(data)) {
            if (value && typeof value === "object") {
              const entry = value as DocumentData;
              byUid[uid] = {
                status: String(entry.status ?? ""),
                submittedAt: (entry.submittedAt as Timestamp) ?? null,
                displayName:
                  typeof entry.displayName === "string"
                    ? entry.displayName
                    : undefined,
                role:
                  typeof entry.role === "string"
                    ? entry.role
                    : entry.role ?? null,
              };
            }
          }
          setSubmissions((prev) => ({ ...prev, [key]: byUid }));
        },
        (err) => {
          // BE-22 rules restrict this to users with `professor: true`
          // custom claim. Missing the claim surfaces a permission-denied
          // error; we show a one-liner telling the professor how to unlock.
          if ((err as { code?: string })?.code === "permission-denied") {
            setSubmissionsError(
              "To see per-phase submission status, your account needs the " +
                "professor custom claim (run `scripts/set-professor-claim.js`).",
            );
          }
          setSubmissions((prev) => ({ ...prev, [key]: {} }));
        },
      );
      unsubs.push(unsubscribe);
    });
    return () => {
      unsubs.forEach((u) => u());
    };
  }, [gameId, currentRound]);

  // ----- Callables -----
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

  const onCreateGame = async () => {
    setError(null);
    setInfo(null);
    setPendingAction("create");
    try {
      const createGame = httpsCallable<
        { totalRounds?: number },
        CreateGameResult
      >(functions, "createGame");
      const res = await createGame({ totalRounds });
      setCreatedGame(res.data);
      dispatch({
        type: "JOIN_GAME",
        payload: {
          gameId: res.data.gameId,
          playerId: user!.uid,
          gameCode: res.data.joinCode,
          player: { id: user!.uid, name: "Professor", bakeryName: "", budget: 0, cumulativeRevenue: 0 },
        },
      });
      setInfo(`Game created — join code ${res.data.joinCode}`);
    } catch (err) {
      setError(humanizeFunctionError(err, "Could not create a new game."));
    } finally {
      setPendingAction(null);
    }
  };

  const joinUrl = useMemo(() => {
    const code = createdGame?.joinCode ?? gameCode;
    if (!code) return null;
    try {
      const base = window.location.origin;
      return `${base}/?code=${encodeURIComponent(code)}`;
    } catch {
      return null;
    }
  }, [createdGame, gameCode]);

  const onCopyJoinLink = async () => {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setError("Could not copy to clipboard. Copy manually from the input.");
    }
  };

  // ----- Derived state -----
  const inLobby = phase === "lobby";
  const inGameOver = phase === "game_over";
  const isRunning = phase !== null && !inLobby && !inGameOver;
  const busy = pendingAction !== null;
  const isOwner = user !== null && professorUid !== null && user.uid === professorUid;
  const ownerGate = gameId !== null && user !== null && !isOwner;
  const controlsDisabled = ownerGate || busy;

  return (
    <PageShell className="professor-page">
      <h1 className="professor-page__title">Professor Control Panel</h1>

      {/* Create a new game (BE-18). */}
      <section className="professor-page__create">
        <h2 className="professor-page__section-title">Create a new game</h2>
        <div className="professor-page__create-form">
          <label className="professor-page__field">
            <span>Total rounds</span>
            <input
              type="number"
              min={1}
              max={10}
              value={totalRounds}
              onChange={(e) =>
                setTotalRounds(Math.max(1, Math.min(10, Number(e.target.value) || 1)))
              }
            />
          </label>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !user}
            onClick={onCreateGame}
            title={!user ? "Sign in first." : "Create a new game."}
          >
            {pendingAction === "create" ? "Creating…" : "Create Game"}
          </button>
        </div>

        {createdGame && (
          <div className="professor-page__join-card">
            <div>
              <span className="professor-page__join-label">Join code</span>
              <span className="professor-page__join-code">
                {createdGame.joinCode}
              </span>
            </div>
            {joinUrl && (
              <div className="professor-page__join-link-row">
                <input
                  className="professor-page__join-link"
                  value={joinUrl}
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={onCopyJoinLink}
                >
                  {copyState === "copied" ? "✓ Copied" : "Copy link"}
                </button>
              </div>
            )}
            <Link
              to={`/?code=${encodeURIComponent(createdGame.joinCode)}`}
              className="professor-page__join-open"
            >
              Open landing page →
            </Link>
          </div>
        )}
      </section>

      {/* Live game controls. */}
      {gameId ? (
        <p className="professor-page__phase">
          Game phase: <strong>{phase ?? "loading…"}</strong>
          {paused && <span className="professor-page__paused"> · paused</span>}
          {ownerGate && (
            <span className="professor-page__not-owner">
              {" "}
              · You are not the professor for this game
            </span>
          )}
        </p>
      ) : (
        <p className="professor-page__note">
          Create a game above, or join one to use these controls.
        </p>
      )}

      <div className="professor-page__controls">
        <button
          className="btn btn--primary"
          onClick={onStart}
          disabled={!gameId || controlsDisabled || !inLobby}
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
          disabled={!gameId || controlsDisabled || !isRunning}
          title="Advance the current round to the next phase."
        >
          {pendingAction === "advance" ? "Advancing…" : "Advance Round"}
        </button>

        <button
          className="btn btn--secondary"
          onClick={onPauseResume}
          disabled={!gameId || controlsDisabled || !isRunning}
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
          disabled={!gameId || controlsDisabled || inGameOver || phase === null}
          title={
            phase === null
              ? "Loading game state…"
              : "Terminate the game immediately."
          }
        >
          {pendingAction === "end" ? "Ending…" : "End Game"}
        </button>

        <Link
          to="/professor/leaderboard"
          className="btn btn--ghost professor-page__leaderboard-link"
        >
          Leaderboard →
        </Link>
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

      {/* Per-phase submission grid. */}
      {gameId && roster.length > 0 && (
        <section className="professor-page__monitor">
          <h2 className="professor-page__monitor-title">
            Players ({roster.length})
            {currentRound > 0 && (
              <span className="professor-page__monitor-round">
                · Round {currentRound}
                {phase
                  ? ` · ${parseGamePhase(phase, currentRound).base}`
                  : ""}
              </span>
            )}
          </h2>

          {rosterError && (
            <p className="professor-page__error" role="alert">
              {rosterError}
            </p>
          )}
          {submissionsError && (
            <p className="professor-page__monitor-footnote">
              {submissionsError}
            </p>
          )}

          <table className="professor-monitor-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Bakery</th>
                {SUBMISSION_PHASES.map((p) => (
                  <th key={p.key}>{p.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {roster.map((entry, i) => (
                <tr key={entry.uid}>
                  <td>{i + 1}</td>
                  <td>{entry.displayName}</td>
                  <td>{entry.bakeryName ?? "—"}</td>
                  {SUBMISSION_PHASES.map((p) => {
                    const sub = submissions[p.key]?.[entry.uid];
                    const submitted = sub?.status === "submitted";
                    return (
                      <td
                        key={p.key}
                        className={
                          "professor-monitor-table__cell" +
                          (submitted
                            ? " professor-monitor-table__cell--ok"
                            : " professor-monitor-table__cell--pending")
                        }
                        title={
                          submitted
                            ? `Submitted${sub?.role ? ` as ${sub.role}` : ""}`
                            : "Not yet submitted"
                        }
                      >
                        {submitted ? "✓" : "⏳"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {gameId && rosterReady && roster.length === 0 && !rosterError && (
        <p className="professor-page__note">No players have joined yet.</p>
      )}
    </PageShell>
  );
}
