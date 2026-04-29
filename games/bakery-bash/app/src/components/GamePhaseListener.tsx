import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { doc, onSnapshot, type DocumentData } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import { useGameListener } from "../hooks/useGameListener";
import { usePresenceHeartbeat } from "../hooks/usePresenceHeartbeat";
import { useStalePresenceTicker } from "../hooks/useStalePresenceTicker";
import { auth, db, functions } from "../lib/firebase";
import { parseGamePhase } from "../types/game";

// V6 (Apr 26): cut grace + freeze from 5+10=15s down to 1+2=3s. After
// bidding closes, players were sitting through "Times up — waiting for
// professor" for ~15 seconds before the next phase started, which felt
// dead and broke the rhythm. The freeze still exists so a slow submitter
// has a couple of seconds to land their bid; it just doesn't pad every
// transition with a noticeable wait.
const GRACE_SECONDS = 1;
const FREEZE_SECONDS = 2;

// A24-I08: only show the "last chance to submit" banner + freeze overlay
// during phases where students actually have something to submit. Email,
// simulating, results_ready, lobby, and game_over don't need the overlay.
const SUBMISSION_PHASE_BASES = new Set(["bid_ad", "bid_chef", "roster", "decide"]);

/**
 * App-level listener that stays mounted regardless of route.
 *
 * Phase-change navigation: navigates immediately when the Firestore phase
 * changes (V4 fix — the previous deferred-nav scheme stranded players on
 * the old phase when a professor advanced manually mid-freeze). The
 * grace/freeze overlay locks *inputs* during the gap, but no longer holds
 * navigation back. A 3-second REST poll (V7) runs in parallel as a
 * fallback against the Firebase 12.12.x watch-stream stall.
 *
 * Timer-expiry sequence (student view, V6 timings):
 *   0–1 s → grace window: inputs still live, no extra UI (the orange
 *           "Last chance" banner was removed in V4 — the RoundHeader
 *           clock is the only countdown visible).
 *   1–3 s → freeze: full-screen blocking overlay ("Locked — advancing in N").
 *   3 s   → overlay clears; professor's auto-advance fires via ProfessorPage.
 */
export function GamePhaseListener() {
  const { gameId, playerId, phase, phaseEndsAtMs, player } = useGame();
  const dispatch = useGameDispatch();
  const navigate = useNavigate();
  const location = useLocation();

  // Refs so the freeze-end callback always reads the latest values without
  // being listed as effect dependencies (avoids re-arming the timer on every
  // phase or playerId change).
  const playerIdRef = useRef(playerId);
  const professorUidRef = useRef<string | null>(null);
  const gameIdRef = useRef(gameId);
  const phaseNameRef = useRef<string | null>(null);
  useEffect(() => { playerIdRef.current = playerId; });
  useEffect(() => { gameIdRef.current = gameId; });

  // FE-5 — centralize the app-wide Firestore listeners. Mounting this hook
  // inside `GamePhaseListener` (which itself renders at the root of the
  // router in `App.tsx`) means the listeners follow the lifecycle of the
  // session — they attach when the game id is known and tear down on
  // lobby/conclusion unmounts. `GamePage` still wires a few page-scoped
  // listeners (roster → ad-winner banner, etc.) because those are only
  // relevant during the decide phase.
  useGameListener(gameId, playerId);

  // T3.2 — heartbeat the player's presence doc so the prof page can flag
  // disconnected players. Hook handles tab visibility internally.
  usePresenceHeartbeat(gameId, playerId, player?.name);

  // M-22 (2026-04-28): every active tab fans out a 60s tick that scans
  // presence docs and clears stale teammates' role claims, so a team
  // doesn't get stuck waiting on someone who closed their tab. The
  // backend `markStalePlayersDisconnected` callable is idempotent; the
  // hook only ticks while the tab is foreground.
  useStalePresenceTicker(gameId);

  const navigateRef = useRef(navigate);
  const pathnameRef = useRef(location.pathname);
  /**
   * Mirrors phaseEndsAtMs from context. Updated after every render so that
   * the onSnapshot callback always reads the value that was current BEFORE
   * the snapshot (i.e. the previous phase's timer), not the new one being
   * dispatched in the same callback tick.
   */
  const phaseEndsAtMsRef = useRef<number | null>(phaseEndsAtMs);

  type Stage = "grace" | "freeze" | null;
  const [stage, setStage] = useState<Stage>(null);
  const [countdown, setCountdown] = useState(0);

  const t1Ref = useRef<ReturnType<typeof setTimeout> | null>(null);
  const t2Ref = useRef<ReturnType<typeof setTimeout> | null>(null);
  const t3Ref = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Deferred phase-change navigation; cleared on unmount or when superseded
  // by a fresh snapshot so we don't navigate the user after they've left.
  const deferredNavRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep refs in sync after every render.
  useEffect(() => {
    navigateRef.current = navigate;
    pathnameRef.current = location.pathname;
    phaseEndsAtMsRef.current = phaseEndsAtMs;
  });

  // V5 fix (Apr 25): if a tab is sitting on a phase-scoped route (e.g.
  // `/game/roster`, `/auction`, `/game`) but has no `gameId` in context,
  // the page silently renders empty: useGameListener returns early on
  // `!gameId`, so no listener attaches, no navigation fires, and the
  // tab stays on a stale (but cached-looking) UI forever. This happens
  // when a dev-mode tab is closed and reopened — sessionStorage is wiped
  // so the persisted game session is gone — but the URL still says we
  // were mid-game. Detect that orphan state and bounce to the landing
  // page so the player can rejoin.
  useEffect(() => {
    if (gameId) return;
    const path = location.pathname;
    const phaseScopedRoutes = [
      "/team",
      "/lobby",
      "/game",
      "/auction",
      "/leaderboard",
    ];
    const isOnPhaseRoute = phaseScopedRoutes.some(
      (r) => path === r || path.startsWith(`${r}/`),
    );
    if (isOnPhaseRoute) {
      navigate("/", { replace: true });
    }
  }, [gameId, location.pathname, navigate]);

  // ── Phase-change navigation ────────────────────────────────────────────────
  useEffect(() => {
    if (!gameId) return;
    const gameRef = doc(db, "games", gameId);
    const unsubscribe = onSnapshot(gameRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.data() as DocumentData;
      const phase = data.phase;
      const round =
        typeof data.currentRound === "number"
          ? data.currentRound
          : typeof data.round === "number"
          ? data.round
          : null;
      const ends = data.phaseEndsAt;

      if (typeof phase === "string") {
        dispatch({ type: "SET_PHASE", payload: phase });
        phaseNameRef.current = phase;
      }
      // Track professor uid so the freeze-end handler can fire the auto-advance
      // when this browser belongs to the professor (mirrors ProfessorPage logic
      // but runs globally so the professor doesn't have to stay on /professor).
      const profUid = typeof data.professorUid === "string"
        ? data.professorUid
        : typeof data.professorId === "string"
          ? data.professorId
          : null;
      professorUidRef.current = profUid;
      if (round !== null) dispatch({ type: "SET_ROUND", payload: round });
      if (ends && typeof ends.toMillis === "function") {
        dispatch({ type: "SET_PHASE_ENDS_AT", payload: ends.toMillis() });
      } else if (ends === null || ends === undefined) {
        dispatch({ type: "SET_PHASE_ENDS_AT", payload: null });
      }

      if (typeof phase !== "string" || phase === "lobby") return;
      if (pathnameRef.current.startsWith("/professor")) return;

      const base = parseGamePhase(phase).base;
      let target: string;
      if (base === "bid_ad" || base === "bid_chef") target = "/auction";
      else if (base === "email") target = "/game/email";
      else if (base === "roster") target = "/game/roster";
      else if (base === "game_over") target = "/game/conclusion";
      else target = "/game";

      if (pathnameRef.current === target) return;

      // V4 fix (Apr 25): always navigate immediately on phase change.
      // The previous deferred-nav code held the navigation back if the
      // *old* phase's grace+freeze window was still open, but
      // `phaseEndsAtMsRef` lagged behind by one render and was tracking
      // the old phase's expiry — so when the professor manually advanced
      // out of `roster` mid-freeze, players sat on the (now-expired)
      // roster screen for up to 15 seconds before navigating. The freeze
      // overlay's job is to lock *inputs* during the gap; navigation
      // should track Firestore directly.
      if (deferredNavRef.current) {
        clearTimeout(deferredNavRef.current);
        deferredNavRef.current = null;
      }
      navigateRef.current(target);
    }, (err) => {
      console.error("games/{gameId} phase listener error:", { gameId, err });
    });
    return () => {
      unsubscribe();
      if (deferredNavRef.current) {
        clearTimeout(deferredNavRef.current);
        deferredNavRef.current = null;
      }
    };
  }, [gameId, dispatch]);

  // V7 fix (Apr 26): REST-based phase poll that bypasses the Firestore
  // SDK entirely. The user reported V6's snapshot-based navigation
  // *still* doesn't move players from /game/roster to /game when the
  // professor advances. Root cause: the Firebase 12.12.x JS SDK
  // intermittently silently stalls its watch stream after a sequence
  // of writes (especially noticeable in dev against the emulator with
  // multi-tab sessions). When that happens onSnapshot stops delivering
  // updates AND getDoc through the same client also fails, so the
  // memory-cache + watchdog-reload combo from V6 only papers over the
  // worst cases. Polling Firestore's REST endpoint with native fetch()
  // sidesteps the SDK completely — even if every other listener in
  // the app is dead, this loop keeps the player on the correct page.
  // Production keeps the same poll (cheap: one GET per 3s, no auth
  // needed because the game doc is publicly readable per firestore.rules
  // line 44 `allow read: if signedIn()` — wait, signedIn requires auth.
  // For prod we attach the auth token. For dev/emulator the rules are
  // also enforced but the emulator accepts the same token format.
  useEffect(() => {
    if (!gameId) return;

    const projectId =
      import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "bakery-bash-54d12";
    const restBase = import.meta.env.DEV
      ? `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents/games/${gameId}`
      : `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/games/${gameId}`;

    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        // Get fresh auth token. In prod this proves we're signed in;
        // emulator ignores the value but the request shape is the same.
        const token = await auth.currentUser?.getIdToken().catch(() => null);
        if (cancelled) return;
        const res = await fetch(restBase, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (cancelled || !res.ok) return;
        // V8 (Apr 26): also fetch phaseEndsAt + paused so pause/resume reflects
        // even when the Firestore watch stream is stalled. Previously the poll
        // only mirrored `phase`, which meant a paused game still ticked the
        // student's timer down to zero (and auto-advance fired) because
        // phaseEndsAtMs in context was never re-set to null.
        const json = (await res.json()) as {
          fields?: {
            phase?: { stringValue?: string };
            phaseEndsAt?: { timestampValue?: string; nullValue?: null };
            paused?: { booleanValue?: boolean; nullValue?: null };
          };
        };
        if (cancelled) return;
        const livePhase = json.fields?.phase?.stringValue;
        if (typeof livePhase !== "string") return;

        // Mirror phaseEndsAt: timestampValue → ms, anything else (nullValue
        // or absent) → null. This is what makes pause stop the visible
        // countdown when the SDK has stalled.
        const endsRaw = json.fields?.phaseEndsAt;
        const endsMs =
          endsRaw && typeof endsRaw.timestampValue === "string"
            ? Date.parse(endsRaw.timestampValue)
            : null;
        dispatch({
          type: "SET_PHASE_ENDS_AT",
          payload: Number.isFinite(endsMs) ? (endsMs as number) : null,
        });

        if (livePhase === "lobby") return;
        if (pathnameRef.current.startsWith("/professor")) {
          // Professor stays on /professor; just keep phase + ends in sync.
          if (phaseNameRef.current !== livePhase) {
            dispatch({ type: "SET_PHASE", payload: livePhase });
            phaseNameRef.current = livePhase;
          }
          return;
        }

        const base = parseGamePhase(livePhase).base;
        let target: string;
        if (base === "bid_ad" || base === "bid_chef") target = "/auction";
        else if (base === "email") target = "/game/email";
        else if (base === "roster") target = "/game/roster";
        else if (base === "game_over") target = "/game/conclusion";
        else target = "/game";

        // V8: in-place transition (pathname already matches target) —
        // refresh context.phase without navigating. This handles the
        // decide → simulating → results_ready case where every phase
        // shares /game; previously we returned early here and left
        // context.phase stale, stranding the student on the decide UI.
        // Same-URL refresh is safe even if the poll is briefly stale —
        // a subsequent poll or snapshot fire will correct it, and no
        // navigation can yank the user away.
        if (pathnameRef.current === target) {
          if (phaseNameRef.current !== livePhase) {
            dispatch({ type: "SET_PHASE", payload: livePhase });
            phaseNameRef.current = livePhase;
          }
          return;
        }

        // Race guard: a poll request started under phase P1 can resolve
        // *after* the snapshot listener has already received and navigated
        // for phase P2. In that window pathname is /P2 (correct) but the
        // poll's `livePhase` is still P1 (stale REST read), and the naive
        // "force-nav to livePhase target" would yank the user back to /P1.
        // Read phaseNameRef *before* any write so the guard reflects the
        // snapshot's last-known phase, not the poll's.
        const knownPhase = phaseNameRef.current;
        if (knownPhase && knownPhase !== livePhase) {
          const knownBase = parseGamePhase(knownPhase).base;
          let knownTarget: string;
          if (knownBase === "bid_ad" || knownBase === "bid_chef") knownTarget = "/auction";
          else if (knownBase === "email") knownTarget = "/game/email";
          else if (knownBase === "roster") knownTarget = "/game/roster";
          else if (knownBase === "game_over") knownTarget = "/game/conclusion";
          else knownTarget = "/game";
          if (pathnameRef.current === knownTarget) return;
        }

        // Mismatch the snapshot couldn't explain — the SDK watch stream
        // is most likely stalled (the V7 scenario this poll exists for).
        // Force-navigate and dispatch so other components recover too.
        if (phaseNameRef.current !== livePhase) {
          dispatch({ type: "SET_PHASE", payload: livePhase });
          phaseNameRef.current = livePhase;
        }
        console.warn("REST poll: phase/path mismatch — forcing nav", {
          livePhase,
          target,
          pathname: pathnameRef.current,
          knownPhase,
        });
        navigateRef.current(target);
      } catch {
        // Network blips are fine — the next tick retries. Do not
        // dispatch anything that could clobber the snapshot listener's
        // last-known state.
      }
    };

    // V8 (Apr 26): tightened from 3s → 1.5s so pause/resume + phase
    // transitions reflect more quickly when the SDK is stalled. Cost is
    // a single extra GET per second per active player; the game doc is
    // small and this only runs while a session is active.
    const interval = setInterval(poll, 1500);
    // Run once immediately so a fresh mount catches up without waiting
    // for the first tick.
    void poll();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gameId, dispatch]);

  // ── Timer-expiry sequence ──────────────────────────────────────────────────
  //
  // Stage transitions (grace → freeze → cleared) are driven by setTimeouts,
  // but the *displayed* countdown is derived each tick from the absolute
  // `phaseEndsAtMs` timestamp (A24-I06) so a backgrounded tab never drifts
  // out of sync with the RoundHeader clock. Both widgets now read the same
  // absolute time and converge on 0 at the same instant.
  const clearAll = () => {
    [t1Ref, t2Ref, t3Ref].forEach(r => {
      if (r.current) { clearTimeout(r.current); r.current = null; }
    });
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    setStage(null);
    setCountdown(0);
  };

  const startTick = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    const compute = () => {
      const ends = phaseEndsAtMsRef.current;
      if (ends === null) return 0;
      const msPastEnd = Date.now() - ends;
      // During grace (first GRACE_SECONDS after phaseEndsAtMs), count down
      // GRACE_SECONDS → 0. During freeze (next FREEZE_SECONDS), count down
      // FREEZE_SECONDS → 0. Clamped to [0, window].
      if (msPastEnd < GRACE_SECONDS * 1000) {
        return Math.max(
          0,
          Math.ceil((GRACE_SECONDS * 1000 - msPastEnd) / 1000),
        );
      }
      const freezeMs = msPastEnd - GRACE_SECONDS * 1000;
      return Math.max(
        0,
        Math.ceil((FREEZE_SECONDS * 1000 - freezeMs) / 1000),
      );
    };
    setCountdown(compute());
    tickRef.current = setInterval(() => {
      setCountdown(compute());
    }, 250);
  };

  useEffect(() => {
    clearAll();
    if (!phaseEndsAtMs || !gameId) return;

    // A24-I08 — only arm the overlay on phases where students can submit.
    // Use the current `phase` from context (not the ref) so a phase flip
    // re-runs this effect and tears down any in-flight overlay immediately.
    const base = parseGamePhase(phase).base;
    if (!SUBMISSION_PHASE_BASES.has(base)) return;

    const msUntilExpiry = phaseEndsAtMs - Date.now();
    if (msUntilExpiry < -30_000) return;

    t1Ref.current = setTimeout(() => {
      setStage("grace");
      startTick();

      t2Ref.current = setTimeout(() => {
        setStage("freeze");
        startTick();

        t3Ref.current = setTimeout(() => {
          if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
          setStage(null);
          setCountdown(0);
          // If this browser is the professor's, fire the auto-advance here so
          // the phase advances even when the professor isn't on /professor.
          // The backend CRIT-02 guard (expectedFromPhase) prevents doubles when
          // ProfessorPage's own timer also fires.
          const gid = gameIdRef.current;
          const pid = playerIdRef.current;
          const profUid = professorUidRef.current;
          const expectedFromPhase = phaseNameRef.current ?? undefined;
          if (gid && pid && profUid && pid === profUid) {
            void httpsCallable(functions, "advanceGamePhase")({
              gameId: gid,
              expectedFromPhase,
            }).catch(() => { /* CRIT-02 rejection is expected and safe */ });
          }
        }, FREEZE_SECONDS * 1000);
      }, GRACE_SECONDS * 1000);
    }, Math.max(0, msUntilExpiry));

    return clearAll;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseEndsAtMs, gameId, phase]);

  // A24-I04 / A24-I08 — non-submission phases (email, simulating,
  // results_ready) still need the professor's browser to auto-advance
  // when the phase timer expires. The submission-phase effect above owns
  // the grace+freeze overlay; this one fires at phaseEndsAtMs + 0 (no
  // overlay, no grace window) so phases like the round-1 email don't
  // stall waiting for a manual click when the professor has navigated
  // away from /professor.
  useEffect(() => {
    if (!phaseEndsAtMs || !gameId) return;
    const base = parseGamePhase(phase).base;
    if (SUBMISSION_PHASE_BASES.has(base)) return;
    if (base === "lobby" || base === "game_over") return;
    const msUntilExpiry = phaseEndsAtMs - Date.now();
    if (msUntilExpiry < -30_000) return;
    const t = setTimeout(() => {
      const gid = gameIdRef.current;
      const pid = playerIdRef.current;
      const profUid = professorUidRef.current;
      const expectedFromPhase = phaseNameRef.current ?? undefined;
      if (gid && pid && profUid && pid === profUid) {
        void httpsCallable(functions, "advanceGamePhase")({
          gameId: gid,
          expectedFromPhase,
        }).catch(() => { /* CRIT-02 rejection is expected and safe */ });
      }
    }, Math.max(0, msUntilExpiry));
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseEndsAtMs, gameId, phase]);

  // V4 fix (Apr 25): the "Last chance to submit — Xs" banner during the
  // grace window was redundant with the RoundHeader timer that's already
  // visible, *and* it appeared as a separate countdown that didn't visibly
  // line up with the header clock. Render nothing during grace; only the
  // hard freeze overlay still appears (it's the actual input lock).
  if (stage === null || stage === "grace") return null;
  // A24-I08 — final render gate, belt-and-suspenders with the useEffect
  // gate above. Covers the window where a phase flips from submission to
  // non-submission while `stage` is still set.
  if (!SUBMISSION_PHASE_BASES.has(parseGamePhase(phase).base)) return null;

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      zIndex: 9999,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0,0,0,0.6)",
      backdropFilter: "blur(4px)",
    }}>
      <div style={{
        background: "#fff",
        borderRadius: "1.25rem",
        padding: "2.5rem 3.5rem",
        textAlign: "center",
        boxShadow: "0 8px 40px rgba(0,0,0,0.25)",
      }}>
        <p style={{ margin: 0, fontSize: "1.1rem", color: "#555", fontWeight: 500 }}>
          Locked — advancing in
        </p>
        <p style={{ margin: "0.5rem 0 0", fontSize: "4rem", fontWeight: 800, color: "#1a1a1a", lineHeight: 1 }}>
          {countdown}
        </p>
      </div>
    </div>
  );
}
