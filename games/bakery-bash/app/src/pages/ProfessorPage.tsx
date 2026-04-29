import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
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
import { usePhaseCountdownSeconds } from "../hooks/usePhaseCountdownSeconds";

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
  isBot?: boolean;
  difficulty?: string | null;
  personality?: string | null;
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

/**
 * T2.4 — index doc for one snapshot under `games/{gameId}/snapshots/{id}`.
 * The chunked payload lives one level down at `…/snapshots/{id}/chunks/{N}`
 * and is server-only; the FE only ever reads metadata here.
 */
interface SnapshotIndexEntry {
  id: string;
  phase: string;
  round: number;
  capturedAt?: Timestamp | null;
  capturedBy?: "auto" | "manual";
  totalDocs?: number;
}

function formatSnapshotTime(t: Timestamp | null | undefined): string {
  if (!t) return "—";
  try {
    return t.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

/** Which phases of a round have a corresponding submissions doc. */
const SUBMISSION_PHASES: Array<{ key: BasePhase; label: string }> = [
  { key: "bid_ad", label: "Ad Bids" },
  { key: "bid_chef", label: "Chef Bids" },
  { key: "roster", label: "Roster" },
  { key: "decide", label: "Decide" },
];

/**
 * M-19 (2026-04-28): canonical within-round phase order. Used to determine
 * whether the round has advanced PAST a given submission phase — if so the
 * grid flips to ✓ regardless of whether the team actually submitted (the
 * phase has moved on, the window to submit is closed, visually it's "done").
 * Mirrors the backend `PHASE_ORDER` in modules/phases.js.
 */
const ROUND_PHASE_ORDER: BasePhase[] = [
  "email",
  "bid_ad",
  "bid_chef",
  "roster",
  "decide",
  "simulating",
  "results_ready",
];

/**
 * T2.1 — hot callables warmed by the "Warm up servers" button. Each is its
 * own Cloud Run service in Gen 2, so we have to invoke each one to pre-spin
 * its instance pool. Keep in sync with `isWarmupRequest` short-circuits in
 * `backend/functions/index.js`.
 */
const WARMUP_CALLABLES = [
  "submitBids",
  "submitDecision",
  "submitPrices",
  "advanceGamePhase",
  "joinGame",
  "createTeam",
  "createBotPlayer",
] as const;

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

  // T2.4 — most-recent snapshot for the "Last saved …" indicator and the
  // "Restart from last save" button. Subscription is below; null until the
  // first snapshot lands or if the prof can't read the snapshots subcollection.
  const [latestSnapshot, setLatestSnapshot] = useState<SnapshotIndexEntry | null>(null);
  const [showRestoreDialog, setShowRestoreDialog] = useState(false);
  const [restoreConfirm, setRestoreConfirm] = useState("");

  // T3.2 — presence map keyed by uid → lastSeenMs. Players write to
  // games/{gameId}/presence/{uid} every 30s while their tab is visible
  // (see usePresenceHeartbeat). The prof page reads them all and flags any
  // player whose ping is older than 60s as "appears disconnected".
  const [presenceByUid, setPresenceByUid] = useState<Record<string, number>>({});
  // Tick once a second so the staleness check re-evaluates against the
  // wall clock — without this, the banner would only update on each
  // presence-doc snapshot.
  const [presenceNow, setPresenceNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setPresenceNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Warmup pill state. Persists past `pendingAction` reset so the professor
  // gets a clear "done" confirmation next to the button, then auto-fades.
  type WarmupStatus =
    | { state: "warming" }
    | { state: "done"; elapsedSec: string }
    | { state: "partial"; elapsedSec: string; warmed: number; total: number };
  const [warmupStatus, setWarmupStatus] = useState<WarmupStatus | null>(null);
  const warmupClearTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (warmupClearTimer.current !== null) {
        window.clearTimeout(warmupClearTimer.current);
      }
    };
  }, []);

  // Bot-management form.
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [manualDifficulty, setManualDifficulty] = useState<string>("medium");
  const [manualPersonality, setManualPersonality] = useState<string>("balanced");
  const botsInGame = useMemo(
    () =>
      roster
        .filter((r) => r.isBot)
        .map((r) => ({
          uid: r.uid,
          name: r.displayName,
          difficulty: r.difficulty ?? "unknown",
          personality: r.personality ?? "unknown",
        })),
    [roster],
  );

  // Create-game form.
  const [totalRounds, setTotalRounds] = useState<number>(5);
  const [createdGame, setCreatedGame] = useState<CreateGameResult | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  const gameId = contextGameId ?? createdGame?.gameId ?? null;

  // S-02 — live phase countdown for the professor. Single source of truth
  // is `usePhaseCountdownSeconds` (same hook RoundHeader uses) so the prof's
  // timer can never disagree with the students'. Returns null between phases
  // (lobby / paused) so we can hide the chip entirely instead of rendering
  // "0:00".
  const phaseCountdownSeconds = usePhaseCountdownSeconds();
  const formatCountdown = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

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
            isBot: data.isBot === true,
            difficulty: typeof data.difficulty === "string" ? data.difficulty : null,
            personality: typeof data.personality === "string" ? data.personality : null,
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

  // T2.4 — subscribe to the most recent snapshot index doc for the
  // "Last saved …" indicator. Listing this collection requires the
  // professor custom claim or being the game's professorUid (see rules
  // for `match /snapshots/{snapshotId}`); a permission-denied just hides
  // the indicator gracefully.
  useEffect(() => {
    if (!gameId) {
      setLatestSnapshot(null);
      return;
    }
    const snapshotsRef = collection(db, "games", gameId, "snapshots");
    const q = query(snapshotsRef, orderBy("capturedAt", "desc"), limit(1));
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        if (snap.empty) {
          setLatestSnapshot(null);
          return;
        }
        const d = snap.docs[0];
        const data = d.data() as DocumentData;
        setLatestSnapshot({
          id: d.id,
          phase: typeof data.phase === "string" ? data.phase : "unknown",
          round: typeof data.round === "number" ? data.round : 0,
          capturedAt: (data.capturedAt as Timestamp | undefined) ?? null,
          capturedBy:
            data.capturedBy === "manual" || data.capturedBy === "auto"
              ? data.capturedBy
              : undefined,
          totalDocs: typeof data.totalDocs === "number" ? data.totalDocs : undefined,
        });
      },
      (err) => {
        // Permission-denied is the expected fallback for a non-professor
        // signed-in user — just hide the indicator.
        console.debug("snapshots listener error:", err);
        setLatestSnapshot(null);
      },
    );
    return unsubscribe;
  }, [gameId]);

  // T3.2 — subscribe to per-player presence pings. Each player writes
  // games/{gameId}/presence/{uid} every 30s while their tab is visible
  // (see usePresenceHeartbeat). We collect lastSeenMs into a map and
  // join against the roster below to flag stragglers.
  useEffect(() => {
    if (!gameId) {
      setPresenceByUid({});
      return;
    }
    const presenceRef = collection(db, "games", gameId, "presence");
    const unsubscribe = onSnapshot(
      presenceRef,
      (snap) => {
        const next: Record<string, number> = {};
        snap.docs.forEach((d) => {
          const data = d.data() as DocumentData;
          const ts = data.lastSeenAt as Timestamp | null | undefined;
          if (ts && typeof ts.toMillis === "function") {
            next[d.id] = ts.toMillis();
          }
        });
        setPresenceByUid(next);
      },
      (err) => {
        console.debug("presence listener error:", err);
        setPresenceByUid({});
      },
    );
    return unsubscribe;
  }, [gameId]);

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

  // Auto-advance. Two modes:
  //   * Submission phases (bid_ad, bid_chef, roster, decide): wait the full
  //     15s (5s grace + 10s freeze) after phaseEndsAtMs, matching the
  //     GamePhaseListener's overlay. Gives stragglers a last-chance window.
  //   * Non-submission phases (email, simulating, results_ready, etc.):
  //     fire at phaseEndsAtMs + 0 — A24-I04 wanted "within 1s of 0" on the
  //     email briefing; there's nothing to submit, so the grace+freeze is
  //     not useful here.
  // Passes `expectedFromPhase` so the backend's CRIT-02 guard rejects
  // double-advances when multiple professor tabs each fire their own timer.
  //
  // M-07 (2026-04-28): replaced setTimeout with a 1s setInterval polling
  // Date.now() against an absolute target. setTimeout in a backgrounded
  // tab is throttled by Chrome (≥ 1s, can stretch to 1+ min), so a prof
  // who tabbed away during the email phase saw round 2 never advance.
  // setInterval gets the same throttling but the absolute-time check
  // means the very next tick after the tab returns to foreground will
  // fire — bounded by the throttled cadence rather than the original
  // delay value. The expectedFromPhase guard still de-dupes duplicate
  // fires across multiple prof tabs.
  useEffect(() => {
    if (!phaseEndsAtMs || !gameId || !phase) return;
    const msUntilExpiry = phaseEndsAtMs - Date.now();
    if (msUntilExpiry < -30_000) return;
    const base = parseGamePhase(phase, currentRound).base;
    const submissionPhase =
      base === "bid_ad" ||
      base === "bid_chef" ||
      base === "roster" ||
      base === "decide";
    // V6 (Apr 26): keep this in sync with GRACE+FREEZE in
    // GamePhaseListener — see the matching comment there. 3s feels much
    // tighter than the old 15s "waiting for professor" pause.
    const extraDelay = submissionPhase ? 3_000 : 0;
    const targetMs = phaseEndsAtMs + extraDelay;
    const expectedFromPhase = phase;
    let fired = false;
    const interval = setInterval(() => {
      if (fired) return;
      if (Date.now() >= targetMs) {
        fired = true;
        clearInterval(interval);
        void callCallableRef.current(
          "advanceGamePhase",
          "auto-advance",
          "Phase auto-advanced.",
          { expectedFromPhase },
        );
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [phaseEndsAtMs, gameId, phase, currentRound]);

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

  // FE-I18: with the FE-I15 / BE-I04 solo-fallback in place, *any* teammate
  // can submit on behalf of a vacant specialist role. Track which members
  // submitted (rather than the single "expected" owner uid) so the grid
  // flips to ✓ as soon as any teammate marks the phase done.
  const teamPhaseStatus = useCallback(
    (
      row: {
        memberUids: string[];
        roleAssignments: Record<string, string | null>;
      },
      phaseKey: BasePhase,
    ): {
      submitted: boolean;
      submittedBy: SubmissionEntry | null;
      submittedByUid: string | null;
      preferredRole: string;
    } => {
      const preferredRole =
        phaseKey === "bid_ad"
          ? "advertising"
          : phaseKey === "bid_chef"
            ? "finance"
            : "operations";

      // M-19 (2026-04-28): if the round has advanced past `phaseKey`, flip
      // to ✓ regardless of submission state. Once a phase is gone the team's
      // window to submit is closed; showing ⏳ next to a moved-on phase
      // confused profs at the playtest ("did they submit or not?"). The
      // submitter info (name + timestamp) intentionally returns null here
      // because no canonical "they submitted" record exists for a missed
      // phase — the tooltip just reads the phase as done.
      const currentBasePhase = phase
        ? parseGamePhase(phase, currentRound).base
        : null;
      const currentIdx = currentBasePhase
        ? ROUND_PHASE_ORDER.indexOf(currentBasePhase)
        : -1;
      const phaseIdx = ROUND_PHASE_ORDER.indexOf(phaseKey);
      const phaseAlreadyPassed =
        currentIdx >= 0 && phaseIdx >= 0 && currentIdx > phaseIdx;
      if (phaseAlreadyPassed) {
        return {
          submitted: true,
          submittedBy: null,
          submittedByUid: null,
          preferredRole,
        };
      }

      const phaseSubs = submissions[phaseKey] ?? {};
      // Walk every member uid that exists either on the team's role
      // assignments or its memberUids, and surface the first that has
      // a submitted status. Prefer the canonical role-owner if they did
      // submit so the tooltip names them; otherwise use whoever did.
      const candidateUids = Array.from(
        new Set([...Object.keys(row.roleAssignments), ...row.memberUids]),
      );
      const ownerUid =
        Object.entries(row.roleAssignments).find(
          ([, roleValue]) => roleValue === "solo",
        )?.[0] ??
        Object.entries(row.roleAssignments).find(
          ([, roleValue]) => roleValue === preferredRole,
        )?.[0] ??
        null;
      if (ownerUid && phaseSubs[ownerUid]?.status === "submitted") {
        return {
          submitted: true,
          submittedBy: phaseSubs[ownerUid] ?? null,
          submittedByUid: ownerUid,
          preferredRole,
        };
      }
      for (const uid of candidateUids) {
        if (phaseSubs[uid]?.status === "submitted") {
          return {
            submitted: true,
            submittedBy: phaseSubs[uid] ?? null,
            submittedByUid: uid,
            preferredRole,
          };
        }
      }
      return {
        submitted: false,
        submittedBy: null,
        submittedByUid: null,
        preferredRole,
      };
    },
    // M-19: phase + currentRound are read for the "phase already passed"
    // check at the top, so they belong in the deps array.
    [submissions, phase, currentRound],
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

  // T2.4 — manual checkpoint. Auto-saves run at the start of every round
  // (server-side hook in advanceGamePhase + startGame), so this is just
  // for the rare case where the prof wants to checkpoint mid-round.
  const onSaveNow = async () => {
    if (!gameId) {
      setError("No active game to save.");
      return;
    }
    setError(null);
    setInfo(null);
    setPendingAction("save-snapshot");
    try {
      const callable = httpsCallable<
        { gameId: string },
        { snapshotId: string; round: number; phase: string; totalBytes: number; elapsedMs: number }
      >(functions, "createSnapshot");
      const res = await callable({ gameId });
      const kb = (res.data.totalBytes / 1024).toFixed(1);
      setInfo(
        `Saved checkpoint at round ${res.data.round} (${kb} KB, ${res.data.elapsedMs} ms).`,
      );
    } catch (err) {
      setError(humanizeFunctionError(err, "Could not save a checkpoint."));
    } finally {
      setPendingAction(null);
    }
  };

  // T2.4 — restore from the most recent snapshot. Backend always pauses
  // the game and runs the destructive "clean" pass; this just kicks it off.
  const onRestoreLastSave = async () => {
    if (!gameId || !latestSnapshot) return;
    setError(null);
    setInfo(null);
    setPendingAction("restore-snapshot");
    try {
      const callable = httpsCallable<
        { gameId: string; snapshotId: string },
        { snapshotId: string; round: number; phase: string; written: number; deleted: number; elapsedMs: number }
      >(functions, "restoreSnapshot");
      const res = await callable({ gameId, snapshotId: latestSnapshot.id });
      setInfo(
        `Restored to round ${res.data.round} (${res.data.written} docs written, ${res.data.deleted} drift docs removed). Game is paused — tell players to refresh, then click Resume.`,
      );
      setShowRestoreDialog(false);
      setRestoreConfirm("");
    } catch (err) {
      setError(humanizeFunctionError(err, "Could not restore from snapshot."));
    } finally {
      setPendingAction(null);
    }
  };

  const onWarmup = async () => {
    setError(null);
    setInfo(null);
    setPendingAction("warmup");
    if (warmupClearTimer.current !== null) {
      window.clearTimeout(warmupClearTimer.current);
      warmupClearTimer.current = null;
    }
    setWarmupStatus({ state: "warming" });
    const startedAt = Date.now();
    try {
      const results = await Promise.allSettled(
        WARMUP_CALLABLES.map((name) => {
          const callable = httpsCallable<
            { _warmup: true },
            { ok?: boolean; warm?: boolean }
          >(functions, name);
          return callable({ _warmup: true });
        }),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const total = WARMUP_CALLABLES.length;
      const warmed = total - failed;
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (failed === 0) {
        setWarmupStatus({ state: "done", elapsedSec });
        setInfo(
          `Servers warm in ${elapsedSec}s. Ready for class — start the game whenever students are in.`,
        );
      } else {
        setWarmupStatus({ state: "partial", elapsedSec, warmed, total });
        setError(
          `Warmed ${warmed}/${total} servers in ${elapsedSec}s; ${failed} failed. Students may see a brief delay on the failed ones.`,
        );
      }
      warmupClearTimer.current = window.setTimeout(() => {
        setWarmupStatus(null);
        warmupClearTimer.current = null;
      }, 6000);
    } catch (err) {
      setWarmupStatus(null);
      setError(humanizeFunctionError(err, "Could not warm up servers."));
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
          player: { id: user!.uid, name: "Professor", bakeryName: "", cumulativeRevenue: 0 },
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
  // Only gate when we positively know the user is NOT the professor.
  // While professorUid is still loading (null), let them try — the backend
  // will reject with permission-denied if they aren't actually the professor.
  const ownerGate = gameId !== null && user !== null && professorUid !== null && !isOwner;
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
          <button
            type="button"
            className="btn btn--secondary"
            disabled={busy || !user}
            onClick={onWarmup}
            title={
              !user
                ? "Sign in first."
                : "Wake up the cloud servers ~30 seconds before class so the first round of student clicks isn't slow."
            }
          >
            {pendingAction === "warmup" ? "Warming up…" : "Warm up servers"}
          </button>
          {warmupStatus && (
            <div
              className={`professor-page__warmup-pill professor-page__warmup-pill--${warmupStatus.state}`}
              role="status"
              aria-live="polite"
            >
              {warmupStatus.state === "warming" && (
                <>
                  <span className="professor-page__warmup-spinner" aria-hidden="true" />
                  <span>Warming up…</span>
                </>
              )}
              {warmupStatus.state === "done" && (
                <>
                  <span className="professor-page__warmup-icon" aria-hidden="true">
                    ✓
                  </span>
                  <span>Servers warm ({warmupStatus.elapsedSec}s)</span>
                </>
              )}
              {warmupStatus.state === "partial" && (
                <>
                  <span className="professor-page__warmup-icon" aria-hidden="true">
                    !
                  </span>
                  <span>
                    {warmupStatus.warmed}/{warmupStatus.total} warm ({warmupStatus.elapsedSec}s)
                  </span>
                </>
              )}
            </div>
          )}
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

      {/* Add Bots (lobby only). */}
      {gameId && inLobby && isOwner && (
        <section className="professor-page__bots">
          <h2 className="professor-page__section-title">Add AI Opponents</h2>
          <div className="professor-page__bots-form">
            <label className="professor-page__field">
              <span>Character Preset</span>
              <select
                value={selectedPreset}
                onChange={(e) => setSelectedPreset(e.target.value)}
              >
                <option value="">— Choose a character —</option>
                <option value="chaotic_charlie">Chaotic Charlie (Novice, Random)</option>
                <option value="unlucky_larry">Unlucky Larry (Novice, Balanced)</option>
                <option value="balanced_bob">Balanced Bob (Medium, Balanced)</option>
                <option value="cautious_carla">Cautious Carla (Medium, Conservative)</option>
                <option value="risky_ricky">Risky Ricky (Hard, Aggressive)</option>
                <option value="chef_pierre">Chef Pierre (Hard, Chef-Focused)</option>
                <option value="marketing_molly">Marketing Molly (Hard, Ad-Focused)</option>
                <option value="perfect_patricia">Perfect Patricia (Perfect, Balanced)</option>
              </select>
            </label>
            <span className="professor-page__bots-or">or</span>
            <label className="professor-page__field">
              <span>Difficulty</span>
              <select
                value={manualDifficulty}
                onChange={(e) => setManualDifficulty(e.target.value)}
              >
                <option value="novice">Novice</option>
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
                <option value="perfect">Perfect</option>
              </select>
            </label>
            <label className="professor-page__field">
              <span>Personality</span>
              <select
                value={manualPersonality}
                onChange={(e) => setManualPersonality(e.target.value)}
              >
                <option value="balanced">Balanced</option>
                <option value="aggressive">Aggressive</option>
                <option value="conservative">Conservative</option>
                <option value="random">Random</option>
                <option value="chef_focused">Chef-Focused</option>
                <option value="ad_focused">Ad-Focused</option>
                <option value="volume">Volume</option>
                <option value="margin">Margin</option>
              </select>
            </label>
            <button
              type="button"
              className="btn btn--secondary"
              disabled={busy || !user}
              onClick={async () => {
                if (!gameId) return;
                setPendingAction("add-bot");
                setError(null);
                try {
                  const payload = selectedPreset
                    ? { gameId, preset: selectedPreset }
                    : { gameId, difficulty: manualDifficulty, personality: manualPersonality };
                  const res = await httpsCallable(functions, "createBotPlayer")(payload);
                  const bot = res.data as { botUid: string; displayName: string; difficulty: string; personality: string };
                  setInfo(`Added ${bot.displayName}`);
                  setSelectedPreset("");
                } catch (err) {
                  setError(humanizeFunctionError(err));
                } finally {
                  setPendingAction(null);
                }
              }}
            >
              {pendingAction === "add-bot" ? "Adding…" : "Add Bot"}
            </button>
          </div>
          {botsInGame.length > 0 && (
            <ul className="professor-page__bot-list">
              {botsInGame.map((bot) => (
                <li key={bot.uid} className="professor-page__bot-item">
                  {bot.name} — {bot.difficulty} / {bot.personality}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

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
        // Only "submission" phases produce a submissions doc; on other
        // phases (email, simulating, results_ready) the readiness badge
        // is meaningless, so suppress it.
        if (
          !currentBasePhase ||
          !SUBMISSION_PHASES.some((p) => p.key === currentBasePhase)
        ) {
          return null;
        }
        const submittedCount = monitorRows.filter(
          (row) => teamPhaseStatus(row, currentBasePhase).submitted,
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

      {/* T3.2 — disconnect banner. Surfaces players whose presence ping is
          stale by >60s OR who have no presence doc at all (their tab is
          backgrounded or they closed it). Only renders when there's
          something actionable so it stays out of the way otherwise.
          Gated on `isRunning` so the lobby (where heartbeats haven't started
          for late joiners and presence docs haven't landed yet) and the
          game-over screen don't flash a false "everyone disconnected" alert. */}
      {gameId && monitorRows.length > 0 && isRunning && (() => {
        const STALE_MS = 60_000;
        const disconnected: { uid: string; name: string }[] = [];
        for (const row of monitorRows) {
          for (const uid of row.memberUids) {
            const lastSeenMs = presenceByUid[uid];
            const isStale = !lastSeenMs || presenceNow - lastSeenMs > STALE_MS;
            if (isStale) {
              const name = rosterByUid[uid]?.displayName ?? row.teamName;
              disconnected.push({ uid, name });
            }
          }
        }
        if (disconnected.length === 0) return null;
        const names = disconnected.slice(0, 5).map((d) => d.name).join(", ");
        const extra = disconnected.length > 5 ? ` (+${disconnected.length - 5} more)` : "";
        return (
          <div className="professor-page__disconnect-banner" role="status">
            🟠 {disconnected.length} player{disconnected.length === 1 ? "" : "s"} appear{disconnected.length === 1 ? "s" : ""} disconnected — tell them to refresh: {names}{extra}
          </div>
        );
      })()}

      {/* T2.4: "Last saved" indicator. Hidden until the prof has at least
          one snapshot — auto-save fires when the game enters round 1. */}
      {gameId && latestSnapshot && (
        <p className="professor-page__last-saved">
          Last saved: round {latestSnapshot.round} ·{" "}
          {formatSnapshotTime(latestSnapshot.capturedAt)}
          {latestSnapshot.capturedBy === "manual" && " (manual)"}
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
          className="btn btn--small btn--secondary"
          onClick={handleExtendPhase}
          disabled={!!pendingAction || phase === "simulating" || phase === "game_over" || phase === "lobby"}
        >
          {pendingAction === "extend" ? "Extending…" : "+ 1 Min"}
        </button>

        {/* S-02 — visible phase countdown. Hidden when between phases
            (lobby / paused / no end time set) so we don't render 0:00. */}
        {phaseCountdownSeconds !== null && (
          <span
            className={`professor-page__timer${
              phaseCountdownSeconds < 30 ? " professor-page__timer--urgent" : ""
            }`}
            role="timer"
            aria-live="polite"
            aria-label="Phase countdown"
            title="Time remaining in the current phase."
          >
            {phaseCountdownSeconds <= 0
              ? "0:00"
              : formatCountdown(phaseCountdownSeconds)}
          </span>
        )}

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

        {/* T2.4: save / restart-this-round panic buttons. */}
        <button
          type="button"
          className="btn btn--small btn--secondary"
          disabled={!gameId || controlsDisabled || !user || pendingAction === "save-snapshot"}
          onClick={onSaveNow}
          title="Save a manual checkpoint right now. Auto-saves run at the start of every round; this is for ad-hoc saves."
        >
          {pendingAction === "save-snapshot" ? "Saving…" : "Save Now"}
        </button>

        <button
          type="button"
          className="btn btn--small btn--danger"
          disabled={!gameId || !latestSnapshot || controlsDisabled}
          onClick={() => setShowRestoreDialog(true)}
          title={
            latestSnapshot
              ? `Restore the game to round ${latestSnapshot.round} (saved at ${formatSnapshotTime(latestSnapshot.capturedAt)}). The game will be paused after restore.`
              : "No checkpoints to restore from yet — auto-save kicks in at the start of round 1."
          }
        >
          Restart from last save
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
            <div
              className="professor-page__monitor-claim-banner"
              role="alert"
            >
              <strong>⚠ Submission tracking unavailable.</strong>{" "}
              {submissionsError} Until then, this grid will stay on ⏳ even
              after teams submit — confirm with players directly before
              advancing.
            </div>
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
                    const status = teamPhaseStatus(row, p.key);
                    const sub = status.submittedBy;
                    return (
                      <td
                        key={p.key}
                        className={
                          "professor-monitor-table__cell" +
                          (status.submitted
                            ? " professor-monitor-table__cell--ok"
                            : " professor-monitor-table__cell--pending")
                        }
                        title={
                          status.submitted
                            ? `Submitted by ${
                                sub?.displayName ??
                                status.submittedByUid ??
                                "teammate"
                              }${sub?.role ? ` as ${sub.role}` : ""}`
                            : `Waiting on ${row.members.join(", ")}`
                        }
                      >
                        {status.submitted ? "✓" : "⏳"}
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

      {/* T2.4: typed-confirmation dialog for restore. Mirrors the
          `RESTORE <gameId>` safety pattern from `scripts/restore-game.js`
          — destructive, must not be one-click. */}
      {showRestoreDialog && latestSnapshot && (
        <div
          className="professor-page__restore-overlay"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="restore-dialog-title"
        >
          <div className="professor-page__restore-dialog">
            <h2
              id="restore-dialog-title"
              className="professor-page__restore-title"
            >
              Restart from last save?
            </h2>
            <p>
              This will roll the game back to <strong>round {latestSnapshot.round}</strong>{" "}
              (saved at {formatSnapshotTime(latestSnapshot.capturedAt)}). All progress since that
              checkpoint will be lost. The game will be paused on restore — tell players to
              refresh, then click Resume.
            </p>
            <p>
              To confirm, type <code>RESTORE round_{latestSnapshot.round}</code> below:
            </p>
            <input
              className="professor-page__restore-input"
              value={restoreConfirm}
              onChange={(e) => setRestoreConfirm(e.target.value)}
              placeholder={`RESTORE round_${latestSnapshot.round}`}
              autoFocus
              disabled={pendingAction === "restore-snapshot"}
            />
            <div className="professor-page__restore-actions">
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  setShowRestoreDialog(false);
                  setRestoreConfirm("");
                }}
                disabled={pendingAction === "restore-snapshot"}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--small btn--danger"
                onClick={onRestoreLastSave}
                disabled={
                  restoreConfirm !== `RESTORE round_${latestSnapshot.round}` ||
                  pendingAction === "restore-snapshot"
                }
              >
                {pendingAction === "restore-snapshot" ? "Restoring…" : "Confirm restore"}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
