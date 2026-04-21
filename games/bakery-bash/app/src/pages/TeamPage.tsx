import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  collection,
  doc,
  onSnapshot,
  type DocumentData,
  type Timestamp,
} from "firebase/firestore";
import { httpsCallable, type FunctionsError } from "firebase/functions";
import { db, functions } from "../lib/firebase";
import { humanizeFunctionError } from "../lib/errors";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import { PageShell } from "../components/ui/PageShell";
import {
  PLAYER_ROLE_LABELS,
  type GamePhaseString,
  type PlayerRole,
} from "../types/game";

/**
 * /team — post-join team room. Members see who's on the team, claim a
 * role (DEC-21), and collaboratively name the team (DEC-23). All state
 * lives on the shared `/games/{gameId}/teams/{teamId}` doc and syncs in
 * realtime via `onSnapshot`, so any teammate's edits are visible to the
 * other two without a refresh.
 */

interface RosterEntry {
  uid: string;
  displayName: string;
  joinedAt?: Timestamp | null;
}

interface TeamDoc {
  /** Shared team name (DEC-23). null when nobody has named it yet. */
  name: string | null;
  /**
   * uid → claimed role (DEC-21), or `null` if the player is on the team but
   * hasn't picked a role yet. The backend (`updateTeamName` / `setTeamRole`
   * in `backend/functions/index.js`) treats the keys of this map as the
   * canonical team roster — there is no separate `memberUids` field.
   */
  roleAssignments: Record<string, PlayerRole | null>;
}

const TEAM_NAME_MAX = 40;
const TEAM_NAME_MIN = 2;

/**
 * The 3 cooperative roles. "solo" is implicit — assigned automatically
 * when the team has only one member, never selectable from the picker.
 */
const PICKABLE_ROLES: PlayerRole[] = ["operations", "advertising", "finance"];

/**
 * What each role owns, per GAME_DESIGN_PROPOSAL.md (DEC-21) /
 * FRONTEND.md (Hard UI Rule #6). Everyone sees every screen; only the
 * role-owner can press the corresponding Submit button.
 */
const ROLE_DESCRIPTIONS: Record<PlayerRole, string> = {
  operations:
    "Submits the Decide screen — menu, quantities, sous chef hires, maintenance.",
  advertising:
    "Submits the Ad Bid screen — sealed bids on TV / Radio / Newspaper / Billboard.",
  finance:
    "Submits the Chef Bid screen + roster decisions — specialty chef hires & layoffs.",
  solo: "All three buttons enabled — used automatically when you're playing alone.",
};

export function TeamPage() {
  const { gameId, playerId, player, teamId, role, phase } = useGame();
  const dispatch = useGameDispatch();
  const navigate = useNavigate();

  const [roster, setRoster] = useState<Record<string, RosterEntry>>({});
  const [team, setTeam] = useState<TeamDoc | null>(null);
  const [teamReady, setTeamReady] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);

  const [draftName, setDraftName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);
  const lastSyncedNameRef = useRef<string | null>(null);

  const [savingRole, setSavingRole] = useState<PlayerRole | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);

  // Subscribe to the player's own doc so role + teamId arrive on /team
  // (GamePage's listener isn't mounted on this route).
  useEffect(() => {
    if (!gameId || !playerId) return;
    const playerRef = doc(db, "games", gameId, "players", playerId);
    const unsubscribe = onSnapshot(playerRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.data() as DocumentData;
      if (
        data.role === "operations" ||
        data.role === "advertising" ||
        data.role === "finance" ||
        data.role === "solo"
      ) {
        dispatch({ type: "SET_ROLE", payload: data.role as PlayerRole });
      }
      if (typeof data.teamId === "string" && data.teamId.length > 0) {
        dispatch({ type: "SET_TEAM_ID", payload: data.teamId });
      } else if (data.teamId === null) {
        dispatch({ type: "SET_TEAM_ID", payload: null });
      }
    });
    return unsubscribe;
  }, [gameId, playerId, dispatch]);

  // Roster (for memberUid → displayName lookups).
  useEffect(() => {
    if (!gameId) return;
    const rosterRef = collection(db, "games", gameId, "roster");
    const unsubscribe = onSnapshot(rosterRef, (snap) => {
      const next: Record<string, RosterEntry> = {};
      snap.docs.forEach((d) => {
        const data = d.data() as DocumentData;
        const uid = typeof data.uid === "string" ? data.uid : d.id;
        next[uid] = {
          uid,
          displayName:
            typeof data.displayName === "string" ? data.displayName : "Player",
          joinedAt: (data.joinedAt as Timestamp | null) ?? null,
        };
      });
      setRoster(next);
    });
    return unsubscribe;
  }, [gameId]);

  // The team doc is the canonical source for name + role assignments.
  useEffect(() => {
    if (!gameId || !teamId) {
      setTeam(null);
      setTeamReady(false);
      return;
    }
    const teamRef = doc(db, "games", gameId, "teams", teamId);
    const unsubscribe = onSnapshot(
      teamRef,
      (snap) => {
        setTeamReady(true);
        if (!snap.exists()) {
          setTeam(null);
          dispatch({ type: "SET_TEAM_NAME", payload: null });
          return;
        }
        const data = snap.data() as DocumentData;
        const next: TeamDoc = {
          name:
            typeof data.name === "string" && data.name.length > 0
              ? data.name
              : null,
          roleAssignments:
            data.roleAssignments && typeof data.roleAssignments === "object"
              ? sanitizeRoleAssignments(data.roleAssignments)
              : {},
        };
        setTeam(next);
        dispatch({ type: "SET_TEAM_NAME", payload: next.name });

        // Hydrate the editor only when the *server* value changes (e.g. a
        // teammate edited it). Don't clobber what the local user is typing.
        if (lastSyncedNameRef.current !== next.name) {
          lastSyncedNameRef.current = next.name;
          setDraftName(next.name ?? "");
        }
      },
      (err) => {
        console.error("teams/{teamId} listener error:", err);
        setTeamReady(true);
        setTeamError("Could not load your team. Refresh if this persists.");
      },
    );
    return unsubscribe;
  }, [gameId, teamId, dispatch]);

  const [gamePhase, setGamePhase] = useState<GamePhaseString | null>(null);
  useEffect(() => {
    if (!gameId) return;
    const gameRef = doc(db, "games", gameId);
    const unsubscribe = onSnapshot(
      gameRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as DocumentData;
        if (typeof data.phase === "string") setGamePhase(data.phase as GamePhaseString);
      },
      (err) => {
        console.error("team game-doc listener error:", { gameId, err });
      },
    );
    return unsubscribe;
  }, [gameId]);
  useEffect(() => {
    const livePhase = gamePhase ?? phase;
    if (livePhase && livePhase !== "lobby") navigate("/game");
  }, [gamePhase, phase, navigate]);

  const memberRoster = useMemo(() => {
    if (!team) return [];
    return Object.keys(team.roleAssignments).map((uid) => ({
      uid,
      displayName: roster[uid]?.displayName ?? "Teammate",
      isYou: uid === playerId,
      role: team.roleAssignments[uid] ?? null,
    }));
  }, [team, roster, playerId]);

  const claimedByOther: Partial<Record<PlayerRole, string>> = useMemo(() => {
    if (!team || !playerId) return {};
    const out: Partial<Record<PlayerRole, string>> = {};
    for (const [uid, r] of Object.entries(team.roleAssignments)) {
      if (uid !== playerId && r) {
        out[r] = roster[uid]?.displayName ?? "A teammate";
      }
    }
    return out;
  }, [team, roster, playerId]);

  const myClaimedRole: PlayerRole | null = useMemo(() => {
    if (!team || !playerId) return null;
    return team.roleAssignments[playerId] ?? null;
  }, [team, playerId]);

  const handleSaveName = async () => {
    if (!gameId || !teamId) return;
    const trimmed = draftName.trim();
    if (trimmed === (team?.name ?? "")) return;

    if (trimmed.length > 0 && trimmed.length < TEAM_NAME_MIN) {
      setNameError(`Team name must be at least ${TEAM_NAME_MIN} characters.`);
      return;
    }
    if (trimmed.length > TEAM_NAME_MAX) {
      setNameError(`Team name must be ${TEAM_NAME_MAX} characters or fewer.`);
      return;
    }

    setNameError(null);
    setNameSaved(false);
    setSavingName(true);
    try {
      const updateTeamName = httpsCallable<
        { gameId: string; teamId: string; name: string },
        { ok: true }
      >(functions, "updateTeamName");
      await updateTeamName({ gameId, teamId, name: trimmed });
      setNameSaved(true);
    } catch (err) {
      setNameError(humanizeBackendError(err, "name"));
    } finally {
      setSavingName(false);
    }
  };

  const handleClaimRole = async (next: PlayerRole) => {
    if (!gameId || !teamId) return;
    if (claimedByOther[next]) return; // hard-blocked: someone else has it.
    if (myClaimedRole === next) return; // no-op: already mine.

    setRoleError(null);
    setSavingRole(next);
    try {
      const setTeamRole = httpsCallable<
        { gameId: string; teamId: string; role: PlayerRole },
        { ok: true }
      >(functions, "setTeamRole");
      await setTeamRole({ gameId, teamId, role: next });
    } catch (err) {
      setRoleError(humanizeBackendError(err, "role"));
    } finally {
      setSavingRole(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSaveName();
    }
  };

  // Not joined → friendly "go home" landing.
  if (!gameId || !playerId) {
    return (
      <PageShell className="team-page">
        <div className="team-page__card team-page__card--empty">
          <h1 className="team-page__title">Join a game first</h1>
          <p className="team-page__hello">
            You haven't joined a game yet. Head back to the start screen,
            enter your name and the join code your professor gave you,
            and we'll bring you back here once you're in.
          </p>
          <div className="team-page__actions">
            <button
              className="btn btn--primary"
              onClick={() => navigate("/")}
            >
              Go to start screen
            </button>
          </div>
        </div>
      </PageShell>
    );
  }

  const waitingForAssignment = !teamId || !teamReady || !team;
  const isSolo = !!team && Object.keys(team.roleAssignments).length <= 1;

  return (
    <PageShell className="team-page">
      <div className="team-page__card">
        <h1 className="team-page__title">Your Team</h1>

        {player && (
          <p className="team-page__hello">
            Hi, <strong>{player.name}</strong>.
          </p>
        )}

        {waitingForAssignment ? (
          <div className="team-page__waiting" role="status">
            <p>Waiting for the professor to assign you to a team…</p>
            <p className="team-page__waiting-hint">
              You'll see your teammates here as soon as teams are formed.
              You don't need to do anything.
            </p>
          </div>
        ) : (
          <>
            <section className="team-page__naming">
              <label className="form-field">
                <span className="form-field__label">
                  Team Name{" "}
                  <span className="form-field__hint">
                    (any teammate can edit · syncs live)
                  </span>
                </span>
                <input
                  type="text"
                  className="form-field__input"
                  placeholder="e.g. Crumb Lords"
                  value={draftName}
                  onChange={(e) => {
                    setDraftName(e.target.value);
                    setNameSaved(false);
                  }}
                  onBlur={() => void handleSaveName()}
                  onKeyDown={handleKeyDown}
                  maxLength={TEAM_NAME_MAX}
                  disabled={savingName}
                />
              </label>
              <div className="team-page__naming-status" aria-live="polite">
                {savingName && (
                  <span className="team-page__naming-saving">Saving…</span>
                )}
                {!savingName && nameSaved && !nameError && (
                  <span className="team-page__naming-saved">
                    Saved · synced to teammates
                  </span>
                )}
                {nameError && (
                  <span className="team-page__naming-error" role="alert">
                    {nameError}
                  </span>
                )}
              </div>
            </section>

            <section className="team-page__members">
              <h2 className="team-page__members-title">
                Teammates ({memberRoster.length})
              </h2>
              <ul className="team-page__members-list">
                {memberRoster.map((m) => (
                  <li
                    key={m.uid}
                    className={`team-page__member${
                      m.isYou ? " team-page__member--you" : ""
                    }`}
                  >
                    <span className="team-page__member-name">
                      {m.displayName}
                      {m.isYou && " (you)"}
                    </span>
                    {m.role && (
                      <span className={`role-badge role-badge--${m.role}`}>
                        {PLAYER_ROLE_LABELS[m.role]}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section className="team-page__roles">
              <h2 className="team-page__roles-title">Pick Your Role</h2>
              <p className="team-page__roles-intro">
                Everyone sees every screen, but only the role owner can
                press <em>Submit</em>. Choose together — each role can
                only be held by one teammate.
              </p>

              {isSolo && (
                <p className="team-page__roles-solo">
                  You're flying solo right now — once teammates join you'll
                  be able to pick a role. Until then, all three submit
                  buttons are enabled for you.
                </p>
              )}

              <ul className="team-page__role-list">
                {PICKABLE_ROLES.map((r) => {
                  const otherClaimer = claimedByOther[r];
                  const taken = !!otherClaimer;
                  const mine = myClaimedRole === r;
                  const saving = savingRole === r;
                  const disabled = taken || saving || isSolo;
                  return (
                    <li
                      key={r}
                      className={`team-page__role${
                        mine ? " team-page__role--mine" : ""
                      }${taken ? " team-page__role--taken" : ""}`}
                    >
                      <div className="team-page__role-header">
                        <span
                          className={`role-badge role-badge--${r}`}
                        >
                          {PLAYER_ROLE_LABELS[r]}
                        </span>
                        {taken && (
                          <span className="team-page__role-claimed">
                            Claimed by {otherClaimer}
                          </span>
                        )}
                        {mine && (
                          <span className="team-page__role-claimed team-page__role-claimed--you">
                            ✓ You
                          </span>
                        )}
                      </div>
                      <p className="team-page__role-desc">
                        {ROLE_DESCRIPTIONS[r]}
                      </p>
                      <button
                        type="button"
                        className="btn btn--ghost team-page__role-btn"
                        onClick={() => void handleClaimRole(r)}
                        disabled={disabled || mine}
                        title={
                          taken
                            ? `${otherClaimer} already picked this role.`
                            : isSolo
                            ? "Roles unlock once a teammate joins."
                            : undefined
                        }
                      >
                        {saving
                          ? "Saving…"
                          : mine
                          ? "Selected"
                          : taken
                          ? "Taken"
                          : "Choose"}
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="team-page__roles-status" aria-live="polite">
                {!isSolo && !myClaimedRole && (
                  <span className="team-page__roles-warn">
                    No role selected yet — your Submit buttons stay
                    disabled until you pick one.
                  </span>
                )}
                {!isSolo && myClaimedRole && (
                  <span className="team-page__roles-ok">
                    You're set as <strong>{PLAYER_ROLE_LABELS[role]}</strong>.
                  </span>
                )}
                {roleError && (
                  <span className="team-page__roles-error" role="alert">
                    {roleError}
                  </span>
                )}
              </div>
            </section>

            {teamError && (
              <p className="team-page__error" role="alert">
                {teamError}
              </p>
            )}
          </>
        )}

        <div className="team-page__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => navigate("/lobby")}
          >
            See all players in lobby
          </button>
        </div>

        <p className="team-page__status">
          Waiting for the professor to start the game…
        </p>
      </div>
    </PageShell>
  );
}

// ─── helpers ──────────────────────────────────────────────────

function sanitizeRoleAssignments(
  raw: Record<string, unknown>,
): Record<string, PlayerRole | null> {
  const out: Record<string, PlayerRole | null> = {};
  for (const [uid, value] of Object.entries(raw)) {
    if (
      value === "operations" ||
      value === "advertising" ||
      value === "finance" ||
      value === "solo"
    ) {
      out[uid] = value;
    } else if (value === null || value === undefined) {
      // Backend seeds members with `null` until they pick — keep the row so
      // membership (Object.keys) stays accurate.
      out[uid] = null;
    }
  }
  return out;
}

/**
 * Map Firebase Functions errors onto user-friendly copy. We special-case
 * `not-found` / `internal` because those are what we'll see today (the
 * `updateTeamName` and `setTeamRole` callables are part of BE-23, not
 * shipped yet); everything else falls through to the message Firebase
 * gave us.
 */
function humanizeBackendError(err: unknown, kind: "name" | "role"): string {
  // Codes thrown by `updateTeamName` / `setTeamRole` in
  // backend/functions/index.js — keep these in sync with the callable.
  const fnErr = err as FunctionsError | undefined;
  const code = (fnErr?.code || "").split("/").pop();

  if (code === "already-exists") {
    // setTeamRole only — another teammate beat you to it.
    return "A teammate just claimed that role. Pick another.";
  }
  if (code === "permission-denied") {
    return "You're not on this team — refresh and try again.";
  }
  if (code === "not-found") {
    return kind === "name"
      ? "Team not found. The professor may not have finalized teams yet."
      : "Team not found. The professor may not have finalized teams yet.";
  }
  if (code === "invalid-argument") {
    // Backend rejects names > 64 chars / empty strings.
    return fnErr?.message ?? "That value isn't allowed.";
  }
  return humanizeFunctionError(
    err,
    kind === "name"
      ? "Could not save team name. Try again."
      : "Could not save role. Try again.",
  );
}
