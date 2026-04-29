import { useState, useEffect, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { httpsCallable, type FunctionsError } from "firebase/functions";
import {
  collection,
  onSnapshot,
  type DocumentData,
} from "firebase/firestore";
import { useGameDispatch } from "../contexts/GameContext";
import { useAuth } from "../contexts/AuthContext";
import { PageShell } from "../components/ui/PageShell";
import { db, functions } from "../lib/firebase";

/**
 * S-04 (2026-04-29): max members per team. Mirrors the backend `TEAM_CAP`
 * in `backend/functions/index.js` (M-05). Even if a student bypasses the
 * disabled card, `joinGame` re-checks this inside its transaction and
 * throws `resource-exhausted` — the FE gate is for affordance only, not
 * enforcement.
 */
const TEAM_MEMBER_CAP = 3;

interface JoinGameResponse {
  gameId: string;
  playerId: string;
}

interface CreateTeamResponse {
  gameId: string;
  playerId: string;
  teamId: string;
  teamName: string;
}

interface LobbyTeam {
  teamId: string;
  name: string;
  memberCount: number;
  /**
   * V4 (Apr 25): per-team bakery emoji written on createTeam / joinGame's
   * team-creation path. May be null on teams created before this field
   * was introduced; the FE falls back to 🥐 in that case.
   */
  emoji: string | null;
}

interface GetTeamsInLobbyResponse {
  gameId: string;
  teams: LobbyTeam[];
}

const JOIN_CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

const JOIN_FAILURE_MESSAGES: Record<string, string> = {
  unauthenticated: "Couldn't sign you in. Please reload and try again.",
  "invalid-argument":
    "Check the game code (6 letters/digits) and name (2–40 characters).",
  "not-found": "No game matches that game code. Double-check with your professor.",
  "failed-precondition": "This game has already started and isn't accepting new players.",
  "already-exists": "A team with that name already exists. Try a different name.",
  "resource-exhausted": "This game is full.",
};

function humanizeJoinError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const fnErr = err as FunctionsError;
    const rawCode = fnErr.code || "";
    const suffix = rawCode.split("/").pop() || rawCode;
    if (suffix && JOIN_FAILURE_MESSAGES[suffix]) {
      return JOIN_FAILURE_MESSAGES[suffix];
    }
    if (fnErr.message) return fnErr.message;
  }
  return "Something went wrong. Please try again.";
}

type Path = "create" | "join" | null;

export function LandingPage() {
  const [path, setPath] = useState<Path>(null);

  // Shared fields
  const [playerName, setPlayerName] = useState("");
  const [gameCode, setGameCode] = useState("");

  // Create-path fields
  const [teamName, setTeamName] = useState("");

  // Join-path fields
  const [lobbyTeams, setLobbyTeams] = useState<LobbyTeam[] | null>(null);
  const [lobbyLoading, setLobbyLoading] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  // Resolved gameId for the current joinCode. Cached so the onSnapshot
  // subscription attaches without re-invoking the callable on every keystroke.
  const [resolvedGameId, setResolvedGameId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const navigate = useNavigate();
  const dispatch = useGameDispatch();
  const { user, loading: authLoading } = useAuth();

  // A24-I03b — resolve joinCode → gameId once per valid code, then let
  // the Firestore subscription below handle live updates. The callable
  // also enforces "game not already started" before subscribing.
  useEffect(() => {
    if (path !== "join") {
      setLobbyTeams(null);
      setResolvedGameId(null);
      return;
    }
    const normalized = gameCode.trim().toUpperCase();
    if (!JOIN_CODE_REGEX.test(normalized)) {
      setLobbyTeams(null);
      setResolvedGameId(null);
      return;
    }
    if (authLoading || !user) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLobbyLoading(true);
      setError(null);
      try {
        const getTeamsInLobby = httpsCallable<
          { joinCode: string },
          GetTeamsInLobbyResponse
        >(functions, "getTeamsInLobby");
        const result = await getTeamsInLobby({ joinCode: normalized });
        if (!cancelled) {
          setLobbyTeams(result.data.teams ?? []);
          setResolvedGameId(result.data.gameId ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setLobbyTeams([]);
          setResolvedGameId(null);
          setError(humanizeJoinError(err));
        }
      } finally {
        if (!cancelled) setLobbyLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [path, gameCode, authLoading, user]);

  // A24-I03b — live subscription to the teams subcollection so member
  // counts update within ~1s of any teammate's join. Attaches once the
  // callable above has resolved `resolvedGameId`; the initial callable
  // result seeds the list so there's no "Loading teams…" flash during
  // the subscription handshake.
  useEffect(() => {
    if (path !== "join" || !resolvedGameId) return;
    const teamsRef = collection(db, "games", resolvedGameId, "teams");
    const unsubscribe = onSnapshot(
      teamsRef,
      (snap) => {
        const teams: LobbyTeam[] = snap.docs.map((d) => {
          const data = d.data() as DocumentData;
          const roleAssignments =
            data.roleAssignments &&
            typeof data.roleAssignments === "object"
              ? (data.roleAssignments as Record<string, unknown>)
              : {};
          const memberCount =
            typeof data.memberCount === "number"
              ? data.memberCount
              : Object.keys(roleAssignments).length;
          return {
            teamId: d.id,
            name:
              typeof data.name === "string" && data.name.length > 0
                ? data.name
                : d.id,
            memberCount,
            emoji:
              typeof data.emoji === "string" && data.emoji.length > 0
                ? data.emoji
                : null,
          };
        });
        setLobbyTeams(teams);
      },
      (err) => {
        console.error("lobby teams listener error:", { resolvedGameId, err });
      },
    );
    return unsubscribe;
  }, [path, resolvedGameId]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedPlayer = playerName.trim();
    const trimmedTeam = teamName.trim();
    const normalizedCode = gameCode.trim().toUpperCase();

    if (trimmedTeam.length < 2 || trimmedTeam.length > 30) {
      setError("Team name must be 2–30 characters.");
      return;
    }
    if (trimmedPlayer.length < 2 || trimmedPlayer.length > 40) {
      setError("Please enter your name (2–40 characters).");
      return;
    }
    if (!JOIN_CODE_REGEX.test(normalizedCode)) {
      setError(
        "Game code must be 6 characters using letters A–Z (excluding I/O) and digits 2–9.",
      );
      return;
    }
    if (authLoading || !user) {
      setError("Still signing you in… please try again in a moment.");
      return;
    }

    setSubmitting(true);
    try {
      const createTeam = httpsCallable<
        { joinCode: string; teamName: string; displayName: string },
        CreateTeamResponse
      >(functions, "createTeam");
      const result = await createTeam({
        joinCode: normalizedCode,
        teamName: trimmedTeam,
        displayName: trimmedPlayer,
      });
      const { gameId, playerId, teamId } = result.data;

      dispatch({
        type: "JOIN_GAME",
        payload: {
          gameId,
          playerId,
          gameCode: normalizedCode,
          player: {
            id: playerId,
            name: trimmedPlayer,
            bakeryName: trimmedTeam,
            cumulativeRevenue: 0,
          },
        },
      });
      navigate("/team", { state: { teamId } });
    } catch (err) {
      setError(humanizeJoinError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedPlayer = playerName.trim();
    const normalizedCode = gameCode.trim().toUpperCase();

    if (!JOIN_CODE_REGEX.test(normalizedCode)) {
      setError("Enter a valid 6-character game code.");
      return;
    }
    if (!selectedTeamId) {
      setError("Pick a team to join.");
      return;
    }
    if (trimmedPlayer.length < 2 || trimmedPlayer.length > 40) {
      setError("Please enter your name (2–40 characters).");
      return;
    }
    if (authLoading || !user) {
      setError("Still signing you in… please try again in a moment.");
      return;
    }

    // The polling useEffect keeps refetching lobbyTeams, so the team the user
    // picked could be gone by submit time (creator left, backend refreshed).
    // Fail loudly here instead of sending an empty bakeryName through.
    const selectedTeam = lobbyTeams?.find((t) => t.teamId === selectedTeamId);
    if (!selectedTeam) {
      setSelectedTeamId(null);
      setError("That team is no longer available. Please pick another.");
      return;
    }

    setSubmitting(true);
    try {
      const joinGame = httpsCallable<
        { joinCode: string; displayName: string; teamId: string; bakeryName?: string },
        JoinGameResponse
      >(functions, "joinGame");
      const result = await joinGame({
        joinCode: normalizedCode,
        displayName: trimmedPlayer,
        teamId: selectedTeam.teamId,
        bakeryName: selectedTeam.name,
      });
      const { gameId, playerId } = result.data;

      dispatch({
        type: "JOIN_GAME",
        payload: {
          gameId,
          playerId,
          gameCode: normalizedCode,
          player: {
            id: playerId,
            name: trimmedPlayer,
            bakeryName: selectedTeam.name,
            cumulativeRevenue: 0,
          },
        },
      });
      navigate("/team", { state: { teamId: selectedTeam.teamId } });
    } catch (err) {
      setError(humanizeJoinError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = submitting || authLoading;

  return (
    <PageShell className="landing-page">
      <div className="landing-page__card">
        <h1 className="landing-page__title">🥐 Bakery Bash</h1>
        <p className="landing-page__subtitle">
          Run your bakery. Outprice the competition. Win.
        </p>

        <div className="landing-page__path-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={path === "create"}
            className={`landing-page__path-btn${
              path === "create" ? " landing-page__path-btn--active" : ""
            }`}
            onClick={() => {
              setPath("create");
              setError(null);
              setSelectedTeamId(null);
            }}
          >
            Create a Team
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={path === "join"}
            className={`landing-page__path-btn${
              path === "join" ? " landing-page__path-btn--active" : ""
            }`}
            onClick={() => {
              setPath("join");
              setError(null);
            }}
          >
            Join a Team
          </button>
        </div>

        {path === "create" && (
          <form className="landing-page__form" onSubmit={handleCreate}>
            <label className="form-field">
              <span className="form-field__label">Team Name</span>
              <input
                type="text"
                className="form-field__input"
                placeholder="e.g. Sourdough Squad"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                maxLength={30}
                disabled={disabled}
              />
            </label>

            <label className="form-field">
              <span className="form-field__label">Your Name</span>
              <input
                type="text"
                className="form-field__input"
                placeholder="e.g. John"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                maxLength={40}
                disabled={disabled}
              />
            </label>

            <label className="form-field">
              <span className="form-field__label">Game Code</span>
              <input
                type="text"
                className="form-field__input"
                placeholder="e.g. ABC234"
                value={gameCode}
                onChange={(e) => setGameCode(e.target.value.toUpperCase())}
                maxLength={6}
                disabled={disabled}
              />
            </label>

            {error && <p className="landing-page__error">{error}</p>}

            <button type="submit" className="btn btn--primary" disabled={disabled}>
              {submitting
                ? "Creating team…"
                : authLoading
                ? "Signing you in…"
                : "Create Team"}
            </button>
          </form>
        )}

        {path === "join" && (
          <form className="landing-page__form" onSubmit={handleJoin}>
            <label className="form-field">
              <span className="form-field__label">Game Code</span>
              <input
                type="text"
                className="form-field__input"
                placeholder="e.g. ABC234"
                value={gameCode}
                onChange={(e) => {
                  setGameCode(e.target.value.toUpperCase());
                  setSelectedTeamId(null);
                }}
                maxLength={6}
                disabled={disabled}
              />
            </label>

            {JOIN_CODE_REGEX.test(gameCode.trim().toUpperCase()) && (
              <div className="form-field">
                <span className="form-field__label">Pick a Team</span>
                {lobbyLoading && (
                  <p className="landing-page__hint">Loading teams…</p>
                )}
                {!lobbyLoading && lobbyTeams && lobbyTeams.length === 0 && (
                  <div className="landing-page__empty-teams">
                    <p>No teams yet. Be the first to create one.</p>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setPath("create")}
                    >
                      Create a Team
                    </button>
                  </div>
                )}
                {!lobbyLoading && lobbyTeams && lobbyTeams.length > 0 && (
                  <div className="team-select__grid" role="listbox">
                    {lobbyTeams.map((t) => {
                      // S-04: greys out the card and swaps the count line
                      // for "Full" once a team hits TEAM_MEMBER_CAP. The
                      // backend `joinGame` callable enforces the cap inside
                      // its transaction (M-05) — this is just the affordance
                      // so students don't waste a click.
                      const isFull = t.memberCount >= TEAM_MEMBER_CAP;
                      return (
                        <button
                          key={t.teamId}
                          type="button"
                          role="option"
                          aria-selected={selectedTeamId === t.teamId}
                          className={`team-select__card${
                            selectedTeamId === t.teamId ? " team-select__card--selected" : ""
                          }${isFull ? " team-select__card--full" : ""}`}
                          onClick={() => setSelectedTeamId(t.teamId)}
                          disabled={disabled || isFull}
                          title={isFull ? `That team is full (${TEAM_MEMBER_CAP} max).` : undefined}
                          aria-label={isFull ? `${t.name} — full` : t.name}
                        >
                          <div className="team-select__logo team-select__logo--placeholder" aria-hidden>
                            {t.emoji ?? "🥐"}
                          </div>
                          <span className="team-select__name">{t.name}</span>
                          <span className="team-select__count">
                            {isFull
                              ? "Full"
                              : `${t.memberCount} ${t.memberCount === 1 ? "member" : "members"}`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <label className="form-field">
              <span className="form-field__label">Your Name</span>
              <input
                type="text"
                className="form-field__input"
                placeholder="e.g. John"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                maxLength={40}
                disabled={disabled}
              />
            </label>

            {error && <p className="landing-page__error">{error}</p>}

            <button
              type="submit"
              className="btn btn--primary"
              disabled={disabled || !selectedTeamId}
            >
              {submitting
                ? "Joining…"
                : authLoading
                ? "Signing you in…"
                : "Join Team"}
            </button>
          </form>
        )}

        {path === null && (
          <p className="landing-page__hint">
            Pick an option above to get started.
          </p>
        )}

        <a href="/how-to-play" className="landing-page__how-to-play-link">
          How to Play
        </a>
      </div>
    </PageShell>
  );
}
