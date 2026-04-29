import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
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
  /**
   * V4 (Apr 25): per-team bakery emoji written on createTeam / joinGame.
   * `null` for legacy teams created before this field existed; FE falls
   * back to 🥐 in that case.
   */
  emoji: string | null;
}

const TEAM_NAME_MAX = 40;
const TEAM_NAME_MIN = 2;

/**
 * The 3 cooperative roles. "solo" is implicit — assigned automatically
 * when the team has only one member, never selectable from the picker.
 */
const PICKABLE_ROLES: PlayerRole[] = ["operations", "advertising", "finance"];

/**
 * What each role owns, per the post-playtest role split (Q6, 2026-04-28):
 * quantities → Finance (M-17), chef bids → Analyst (M-18), data
 * purchases + CSV download → Analyst (S-07/B-05). Backend role strings
 * stay (`advertising` is still the Analyst id) for game-doc compatibility.
 * Everyone sees every screen; only the role-owner can press the
 * corresponding Submit button.
 */
const ROLE_DESCRIPTIONS: Record<PlayerRole, string> = {
  operations:
    "Submits sous chefs, maintenance, and equipment upgrades in Decide. Manages the chef roster (lay-offs).",
  advertising:
    "Submits ad bids and chef bids in the auctions. Buys data sets in Results. Downloads the team's monthly data.",
  finance:
    "Submits prices and quantities in Decide. Owns the team's pricing strategy.",
  solo: "All three roles' buttons enabled — used automatically when you're playing alone.",
};

export function TeamPage() {
  const { gameId, playerId, player, teamId, phase } = useGame();
  const dispatch = useGameDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const selectedTeamNumber = (location.state as { teamNumber?: number } | null)?.teamNumber ?? null;

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
    const unsubscribe = onSnapshot(
      playerRef,
      (snap) => {
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
      },
      (err) => {
        console.error("team player-doc listener error:", { gameId, playerId, err });
      },
    );
    return unsubscribe;
  }, [gameId, playerId, dispatch]);

  // Roster (for memberUid → displayName lookups).
  useEffect(() => {
    if (!gameId) return;
    const rosterRef = collection(db, "games", gameId, "roster");
    const unsubscribe = onSnapshot(
      rosterRef,
      (snap) => {
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
      },
      (err) => {
        console.error("team roster listener error:", { gameId, err });
      },
    );
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
          emoji:
            typeof data.emoji === "string" && data.emoji.length > 0
              ? data.emoji
              : null,
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

  const [clearingRole, setClearingRole] = useState(false);

  const handleClearRole = async () => {
    if (!gameId || !teamId) return;
    setRoleError(null);
    setClearingRole(true);
    try {
      const setTeamRole = httpsCallable<
        { gameId: string; teamId: string; role: null },
        { ok: true }
      >(functions, "setTeamRole");
      await setTeamRole({ gameId, teamId, role: null });
    } catch (err) {
      setRoleError(humanizeBackendError(err, "role"));
    } finally {
      setClearingRole(false);
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
  const memberCount = team ? Object.keys(team.roleAssignments).length : 0;
  // Lock pickers only on a 1-person team (truly solo). With 2+ members
  // each player picks explicitly — there is no longer a 2→3 auto-cascade
  // (it stole the choice from the team), so the picker is the only way
  // to land specialist roles.
  const isSolo = !!team && memberCount <= 1;

  return (
    <PageShell className="team-page">
      <div className="team-page__card">
        <h1 className="team-page__title">
          {team?.emoji && (
            <span className="team-page__emoji" aria-hidden="true">
              {team.emoji}
            </span>
          )}
          Your Team
        </h1>

        {player && (
          <p className="team-page__hello">
            Hi, <strong>{player.name}</strong>.
          </p>
        )}

        {waitingForAssignment ? (
          <div className="team-page__waiting" role="status">
            {selectedTeamNumber && (
              <span className="team-page__selected-team">
                Team {selectedTeamNumber}
              </span>
            )}
            <p>Waiting for the professor to confirm your team assignment…</p>
            <p className="team-page__waiting-hint">
              Your teammates will appear here once the professor finalises
              teams. You don't need to do anything else.
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
                    {/* Hide the placeholder "Solo" badge — it lives on the
                        player doc only so role-gated submits stay open while
                        the team is still picking. Surfacing it on each row
                        misled players into thinking the latest joiner had a
                        special "solo" role. Specialist badges still render. */}
                    {m.role && m.role !== "solo" && (
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
                Every teammate sees every screen. See the{" "}
                <a href="/how-to-play">How to Play</a> page for what
                each role does.
              </p>

              {memberCount === 1 && (
                <p className="team-page__roles-status team-page__roles-status--solo">
                  You're the first on your team — you have all three
                  roles until teammates join.
                </p>
              )}
              {memberCount === 2 && (
                <p className="team-page__roles-status team-page__roles-status--pair">
                  You and your teammate both control everything right
                  now. Pick a role to split responsibilities, or share
                  control until you do.
                </p>
              )}
              {memberCount >= 3 && (
                <p className="team-page__roles-status team-page__roles-status--full">
                  Your team is full. Each of you should pick a role —
                  whoever claims a role is the only one who can press
                  Submit on that screen.
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
                        {mine && (
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={() => void handleClearRole()}
                            disabled={clearingRole}
                          >
                            {clearingRole ? "Clearing…" : "× Clear"}
                          </button>
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
                {/* `myClaimedRole === 'solo'` is the placeholder backend
                    role assigned on join — treat it as "not yet picked"
                    so the bottom hint nudges the player to claim a real
                    specialist instead of declaring them "set as Solo". */}
                {!isSolo && (!myClaimedRole || myClaimedRole === "solo") && (
                  <span className="team-page__roles-warn">
                    Pick a role to lock in your part of the team.
                  </span>
                )}
                {!isSolo && myClaimedRole && myClaimedRole !== "solo" && (
                  <span className="team-page__roles-ok">
                    You're set as <strong>{PLAYER_ROLE_LABELS[myClaimedRole]}</strong>.
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
