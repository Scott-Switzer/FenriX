import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { isDevModeEnabled, setDevMode } from "../lib/devMode";

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

interface ProfessorTeamEntry {
  id: string;
  name: string;
  roleAssignments: Record<string, string | null>;
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
  const { gameId: contextGameId, currentRound, gameCode, phaseEndsAtMs } = useGame();
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

  // Dev-tools visibility — the DevNav is hidden from students by default.
  // Professors can toggle it from this page so they (and our dev team) can
  // jump between phases while debugging without exposing the controls to
  // the classroom.
  const [devModeOn, setDevModeOn] = useState<boolean>(() => isDevModeEnabled());
  const toggleDevMode = () => {
    const next = !devModeOn;
    setDevMode(next);
    setDevModeOn(next);
  };

  // Keep the button label in sync when dev mode is flipped elsewhere — another
  // tab (`storage` event) or the same tab via `?dev=1` / `?dev=0` / the DevNav
  // (`bakery-bash:dev-mode-change`). Mirrors the pattern in `DevNav.tsx`.
  useEffect(() => {
    const onChange = () => setDevModeOn(isDevModeEnabled());
    window.addEventListener("bakery-bash:dev-mode-change", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("bakery-bash:dev-mode-change", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  // Roster + submissions monitor.
  const [roster, setRoster] = useState<ProfessorRosterEntry[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [rosterReady, setRosterReady] = useState(false);
  const [teams, setTeams] = useState<ProfessorTeamEntry[]>([]);
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

  useEffect(() => {
    if (!gameId) {
      setTeams([]);
      return;
    }
    const teamsRef = collection(db, "games", gameId, "teams");
    const unsubscribe = onSnapshot(
      teamsRef,
      (snap) => {
        const entries: ProfessorTeamEntry[] = snap.docs.map((d) => {
          const data = d.data() as DocumentData;
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : d.id,
            roleAssignments:
              data.roleAssignments && typeof data.roleAssignments === "object"
                ? (data.roleAssignments as Record<string, string | null>)
                : {},
          };
        });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        setTeams(entries);
      },
      (err) => {
        console.error("professor: teams listener error:", { gameId, err });
        setTeams([]);
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
      extraData?: Record<string, unknown>,
    ): Promise<void> => {
      if (!gameId) {
        setError("No active game to control.");
        return;
      }
      setError(null);
      setInfo(null);
      setPendingAction(label);
      try {
        const callable = httpsCallable<
          { gameId: string } & Record<string, unknown>,
          CallableResult
        >(functions, fnName);
        await callable({ gameId, ...(extraData ?? {}) });
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

  // Keep a stable ref to callCallable so the auto-advance effect doesn't
  // re-trigger just because the function reference changed.
  const callCallableRef = useRef(callCallable);
  useEffect(() => { callCallableRef.current = callCallable; });

  // Auto-advance 15 s after phase timer expires (5 s grace + 10 s freeze).
  // Re-runs when phase, phaseEndsAtMs, or gameId changes. Passes
  // expectedFromPhase so the backend's CRIT-02 guard rejects double-advances
  // when multiple professor tabs (or remounts) each fire their own timer.
  useEffect(() => {
    if (!phaseEndsAtMs || !gameId || !phase) return;
    const msUntilExpiry = phaseEndsAtMs - Date.now();
    if (msUntilExpiry < -30_000) return;
    const delay = Math.max(0, msUntilExpiry) + 15_000;
    const expectedFromPhase = phase;
    const t = setTimeout(() => {
      void callCallableRef.current(
        "advanceGamePhase",
        "auto-advance",
        "Phase auto-advanced.",
        { expectedFromPhase },
      );
    }, delay);
    return () => clearTimeout(t);
  }, [phaseEndsAtMs, gameId, phase]);

  const rosterByUid = useMemo(
    () =>
      Object.fromEntries(
        roster.map((entry) => [
          entry.uid,
          { displayName: entry.displayName, bakeryName: entry.bakeryName },
        ]),
      ),
    [roster],
  );

  const monitorRows = useMemo(() => {
    if (teams.length > 0) {
      return teams.map((team) => {
        const memberUids = Object.keys(team.roleAssignments);
        return {
          id: team.id,
          teamName: team.name,
          memberUids,
          members: memberUids.map((uid) => rosterByUid[uid]?.displayName ?? uid),
          roleAssignments: team.roleAssignments,
        };
      });
    }
    return roster.map((entry) => ({
      id: entry.uid,
      teamName: entry.bakeryName ?? entry.displayName,
      memberUids: [entry.uid],
      members: [entry.displayName],
      roleAssignments: { [entry.uid]: "solo" },
    }));
  }, [teams, roster, rosterByUid]);

  const submissionOwnerUid = useCallback(
    (
      row: {
        memberUids: string[];
        roleAssignments: Record<string, string | null>;
      },
      phaseKey: BasePhase,
    ) => {
      const preferredRole =
        phaseKey === "bid_ad"
          ? "advertising"
          : phaseKey === "bid_chef"
            ? "finance"
            : "operations";
      const entries = Object.entries(row.roleAssignments);
      const soloUid = entries.find(([, roleValue]) => roleValue === "solo")?.[0];
      if (soloUid) return soloUid;
      return (
        entries.find(([, roleValue]) => roleValue === preferredRole)?.[0] ??
        row.memberUids[0] ??
        null
      );
    },
    [],
  );

  const onStart = () => callCallable("startGame", "start", "Game started.");
  const onAdvance = () =>
    callCallable("advanceGamePhase", "advance", "Phase advanced.", {
      // Pair with the auto-advance effect: the backend's CRIT-02 guard rejects
      // the call if the phase has already moved on us.
      expectedFromPhase: phase ?? undefined,
    });
  const onRetryStuckSimulation = () =>
    callCallable(
      "retryStuckSimulation",
      "retry-stuck-sim",
      "Simulation recovery complete — advancing to Results.",
    );
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

  /**
   * FE-6 — Reset the active game so it can be replayed from the lobby.
   * Calls the `resetGame` Firebase callable (BE-6). If the callable has
   * not been deployed yet (pre-BE-6 rollout), the error path surfaces a
   * friendly note instead of a generic Firebase error code. We retain
   * the `createdGame` banner and the local `gameId` so the professor
   * can confirm the reset succeeded before creating a fresh session.
   */
  const onReset = () => {
    if (
      !window.confirm(
        "This will delete all round data and reset all players. Are you sure?",
      )
    ) {
      return;
    }
    void callCallable(
      "resetGame",
      "reset",
      "Game reset — all round data cleared and players returned to lobby.",
    );
  };

  const handleExtendPhase = async () => {
    if (!gameId) return;
    setPendingAction("extend");
    try {
      const extendPhase = httpsCallable(functions, "extendPhase");
      await extendPhase({ gameId, extraSeconds: 60 });
      setInfo("Phase extended by 1 minute.");
    } catch (err) {
      setError(humanizeFunctionError(err, "Could not extend phase. Please try again."));
    } finally {
      setPendingAction(null);
    }
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

      {gameId && monitorRows.length > 0 && isRunning && (() => {
        const currentBasePhase = phase ? parseGamePhase(phase, currentRound).base : null;
        const currentSubmissions: Record<string, SubmissionEntry> =
          currentBasePhase ? (submissions[currentBasePhase] ?? {}) : {};
        const submittedCount = monitorRows.filter(
          (row) => {
            const ownerUid = submissionOwnerUid(row, currentBasePhase ?? "decide");
            return ownerUid ? currentSubmissions[ownerUid]?.status === "submitted" : false;
          },
        ).length;
        const allReady = monitorRows.length > 0 && submittedCount === monitorRows.length;
        const waitingCount = monitorRows.length - submittedCount;
        return (
          <div
            className={`prof-phase-readiness prof-phase-readiness--${allReady ? "go" : "wait"}`}
          >
            {allReady
              ? "🟢 All teams ready — safe to advance"
              : `🔴 Waiting for ${waitingCount} team${waitingCount !== 1 ? "s" : ""}`}
          </div>
        );
      })()}

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
          className="btn btn--small btn--secondary"
          onClick={handleExtendPhase}
          disabled={!!pendingAction || phase === "simulating" || phase === "game_over" || phase === "lobby"}
        >
          {pendingAction === "extend" ? "Extending…" : "+ 1 Min"}
        </button>

        {phase === "simulating" && (
          <button
            className="btn btn--small btn--secondary"
            onClick={onRetryStuckSimulation}
            disabled={!gameId || controlsDisabled}
            title="If the Simulate screen hasn't moved to Results after ~60s, click to re-run the simulation and advance."
          >
            {pendingAction === "retry-stuck-sim"
              ? "Recovering…"
              : "Retry Stuck Simulation"}
          </button>
        )}

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

        <button
          className="btn btn--danger"
          onClick={onReset}
          disabled={!gameId || controlsDisabled}
          title="Clear all round data and send players back to the lobby (BE-6)."
        >
          {pendingAction === "reset" ? "Resetting…" : "Reset Game"}
        </button>

        <Link
          to="/professor/leaderboard"
          className="btn btn--ghost professor-page__leaderboard-link"
        >
          Leaderboard →
        </Link>

        <button
          type="button"
          className="btn btn--ghost"
          onClick={toggleDevMode}
          title={
            devModeOn
              ? "Hide the phase-jump nav bar. Students should never see this."
              : "Show a phase-jump nav bar at the bottom of the screen (for debugging). Students don't see this."
          }
        >
          {devModeOn ? "Hide dev tools" : "Show dev tools"}
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

      {/* Per-phase submission grid. */}
      {gameId && monitorRows.length > 0 && (
        <section className="professor-page__monitor">
          <h2 className="professor-page__monitor-title">
            Teams ({monitorRows.length})
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
                <th>Team</th>
                <th>Members</th>
                {SUBMISSION_PHASES.map((p) => (
                  <th key={p.key}>{p.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monitorRows.map((row, i) => (
                <tr key={row.id}>
                  <td>{i + 1}</td>
                  <td>{row.teamName}</td>
                  <td>{row.members.join(", ") || "—"}</td>
                  {SUBMISSION_PHASES.map((p) => {
                    const ownerUid = submissionOwnerUid(row, p.key);
                    const sub = ownerUid ? submissions[p.key]?.[ownerUid] : undefined;
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
                            ? `Submitted by ${sub?.displayName ?? ownerUid ?? "assigned owner"}${
                                sub?.role ? ` as ${sub.role}` : ""
                              }`
                            : ownerUid
                              ? `Waiting on ${row.members.join(", ")}`
                              : "No owner assigned"
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

      {gameId && rosterReady && monitorRows.length === 0 && !rosterError && (
        <p className="professor-page__note">No players have joined yet.</p>
      )}
    </PageShell>
  );
}
