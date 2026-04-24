import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { doc, onSnapshot, type DocumentData } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useGame, useGameDispatch } from "../contexts/GameContext";
import { useGameListener } from "../hooks/useGameListener";
import { db, functions } from "../lib/firebase";
import { parseGamePhase } from "../types/game";

const GRACE_SECONDS = 5;
const FREEZE_SECONDS = 10;
const TOTAL_WINDOW_MS = (GRACE_SECONDS + FREEZE_SECONDS) * 1000; // 15 s

/**
 * App-level listener that stays mounted regardless of route.
 *
 * Phase-change navigation: navigates when Firestore phase changes. If a
 * change arrives while the grace/freeze window is active, navigation is
 * deferred until the window ends. The window is derived directly from
 * phaseEndsAtMs so there's no race between the timer callbacks and incoming
 * Firestore snapshots.
 *
 * Timer-expiry sequence (student view):
 *   0–5 s  → orange banner, inputs still live ("Last chance — 5s")
 *   5–15 s → full-screen blocking overlay ("Locked — advancing in 10…")
 *   15 s   → overlay clears; professor's auto-advance fires via ProfessorPage
 */
export function GamePhaseListener() {
  const { gameId, playerId, phaseEndsAtMs } = useGame();
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

      // Check if we're inside the grace+freeze window for the current phase.
      // phaseEndsAtMsRef still holds the OLD phaseEndsAtMs because the
      // SET_PHASE_ENDS_AT dispatch above hasn't re-rendered yet.
      const now = Date.now();
      const windowStart = phaseEndsAtMsRef.current ?? 0;
      const windowEnd = windowStart + TOTAL_WINDOW_MS;
      const inWindow = windowStart > 0 && now >= windowStart && now < windowEnd;

      // A new snapshot supersedes any previously deferred navigation.
      if (deferredNavRef.current) {
        clearTimeout(deferredNavRef.current);
        deferredNavRef.current = null;
      }

      if (inWindow) {
        // Defer navigation until the freeze period ends.
        const remainingMs = windowEnd - now;
        deferredNavRef.current = setTimeout(() => {
          deferredNavRef.current = null;
          if (pathnameRef.current !== target) navigateRef.current(target);
        }, remainingMs);
      } else {
        navigateRef.current(target);
      }
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

  // ── Timer-expiry sequence ──────────────────────────────────────────────────
  const clearAll = () => {
    [t1Ref, t2Ref, t3Ref].forEach(r => {
      if (r.current) { clearTimeout(r.current); r.current = null; }
    });
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    setStage(null);
    setCountdown(0);
  };

  const startTick = (from: number) => {
    if (tickRef.current) clearInterval(tickRef.current);
    setCountdown(from);
    tickRef.current = setInterval(() => {
      setCountdown(prev => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
  };

  useEffect(() => {
    clearAll();
    if (!phaseEndsAtMs || !gameId) return;

    const msUntilExpiry = phaseEndsAtMs - Date.now();
    if (msUntilExpiry < -30_000) return;

    t1Ref.current = setTimeout(() => {
      setStage("grace");
      startTick(GRACE_SECONDS);

      t2Ref.current = setTimeout(() => {
        if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
        setStage("freeze");
        startTick(FREEZE_SECONDS);

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
  }, [phaseEndsAtMs, gameId]);

  if (stage === null) return null;

  if (stage === "grace") {
    return (
      <div style={{
        position: "fixed",
        bottom: "1.5rem",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        pointerEvents: "none",
      }}>
        <div style={{
          background: "#e65c00",
          color: "#fff",
          borderRadius: "2rem",
          padding: "0.65rem 1.4rem",
          fontSize: "0.95rem",
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
          whiteSpace: "nowrap",
        }}>
          <span>Last chance to submit —</span>
          <span style={{ fontSize: "1.2rem", fontWeight: 800 }}>{countdown}s</span>
        </div>
      </div>
    );
  }

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
