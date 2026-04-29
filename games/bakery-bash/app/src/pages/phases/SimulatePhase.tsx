import { useEffect, useRef, useState } from "react";
import {
  doc,
  onSnapshot,
  type DocumentData,
} from "firebase/firestore";
import { useGame } from "../../contexts/GameContext";
import { db } from "../../lib/firebase";
import { PixelBakeryScene } from '../../components/bakery-scene/PixelBakeryScene';
import { SceneErrorBoundary } from '../../components/bakery-scene/SceneErrorBoundary';
import type { SpecialtyChefBadge } from '../../components/bakery-scene/SpecialtyChefBadges';
import '../../styles/pixel-scene.css';

const TOTAL_DAYS = 30;
const DAY_DURATION_MS = 4000; // 4 seconds per day
const PRODUCTS = ["croissant", "cookie", "bagel", "sandwich", "coffee", "matcha"] as const;
type Product = typeof PRODUCTS[number];

// Simulate which day each product sells out (days 20–28)
function getSelloutDays(): Record<Product, number> {
  const days = {} as Record<Product, number>;
  for (const p of PRODUCTS) {
    days[p] = 20 + Math.floor(Math.random() * 9);
  }
  return days;
}

export function SimulatePhase() {
  const { roundResults, teamName, pendingDecision, currentRound, gameId, playerId } = useGame();
  // K-07 — subscribe to the player doc's specialtyChefs so the kitchen
  // scene can render portrait cameos for each one. Self-contained
  // listener (only mounted while we're on the simulating phase) so it
  // doesn't add load to other surfaces.
  const [specialtyChefs, setSpecialtyChefs] = useState<SpecialtyChefBadge[]>([]);
  useEffect(() => {
    if (!gameId || !playerId) {
      setSpecialtyChefs([]);
      return;
    }
    const playerRef = doc(db, "games", gameId, "players", playerId);
    const unsubscribe = onSnapshot(
      playerRef,
      (snap) => {
        if (!snap.exists()) {
          setSpecialtyChefs([]);
          return;
        }
        const data = snap.data() as DocumentData;
        const raw = Array.isArray(data.specialtyChefs) ? data.specialtyChefs : [];
        const next: SpecialtyChefBadge[] = [];
        for (const c of raw) {
          if (!c || typeof c !== "object") continue;
          const id = typeof c.id === "string" ? c.id : null;
          const nat = c.nationality;
          const validNat =
            nat === "american" ||
            nat === "french" ||
            nat === "italian" ||
            nat === "japanese";
          // Backend stores `gender` as `"male"`/`"female"` or sometimes
          // `"m"`/`"f"`; normalize to the badge's `"m"|"f"` shape so the
          // portrait URL resolves correctly.
          const rawGen = c.gender;
          const gender =
            rawGen === "male" || rawGen === "m"
              ? ("m" as const)
              : rawGen === "female" || rawGen === "f"
              ? ("f" as const)
              : null;
          const name = typeof c.name === "string" ? c.name : null;
          if (!id || !validNat || !gender || !name) continue;
          next.push({ id, nationality: nat, gender, name });
        }
        setSpecialtyChefs(next);
      },
      (err) => {
        // Don't crash the simulation if the listener errors — just hide
        // the cameos. Same pattern as other per-phase player listeners.
        console.debug("SimulatePhase specialtyChefs listener error:", err);
        setSpecialtyChefs([]);
      },
    );
    return unsubscribe;
  }, [gameId, playerId]);
  const latest = roundResults[roundResults.length - 1];
  const latestRound = latest ?? null;
  const targetRevenue =
    typeof latest?.revenueNet === "number"
      ? latest.revenueNet
      : typeof latest?.revenueGross === "number"
      ? latest.revenueGross
      : typeof latest?.revenue === "number"
      ? latest.revenue
      : 0;

  const [, setDay] = useState(1);
  const [isNight, setIsNight] = useState(false);
  const [displayRevenue, setDisplayRevenue] = useState(0);
  const [soldOut, setSoldOut] = useState<Set<Product>>(new Set());
  const [, setCleanlinessDisplay] = useState(100);
  const [, setOvenDisplay] = useState(100);

  const selloutDays = useRef(getSelloutDays());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reducedMotion = typeof window !== "undefined"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

  useEffect(() => {
    if (reducedMotion) return;

    let currentDay = 1;
    let nightPhase = false;

    intervalRef.current = setInterval(() => {
      if (!nightPhase) {
        // Day phase: show customers, check sellouts
        const newSoldOut = new Set(soldOut);
        for (const p of PRODUCTS) {
          if (currentDay >= selloutDays.current[p]) newSoldOut.add(p);
        }
        setSoldOut(newSoldOut);

        // Animate maintenance decay
        setCleanlinessDisplay(prev => Math.max(0, prev - 100 / (TOTAL_DAYS * 3)));
        setOvenDisplay(prev => Math.max(0, prev - 100 / (TOTAL_DAYS * 4)));

        // Animate revenue
        if (targetRevenue > 0) {
          setDisplayRevenue(Math.round((currentDay / TOTAL_DAYS) * targetRevenue));
        }

        nightPhase = true;
        setIsNight(true);
      } else {
        // Night phase: advance day
        currentDay++;
        nightPhase = false;
        setIsNight(false);
        if (currentDay > TOTAL_DAYS) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setDisplayRevenue(targetRevenue);
          return;
        }
        setDay(currentDay);
      }
    }, DAY_DURATION_MS / 2);

    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className={`simulate-phase simulate-phase--pixel ${isNight ? "simulate-phase--night" : "simulate-phase--day"}`}>
      {/* Top bar — V9 (Apr 26): replaced "Day N / 30" with the round
          label since the daily progression is conveyed by the visual
          alone; the number of in-game "days" was confusing players. The
          underlying `day` state still drives sellouts and revenue
          animation, it's just no longer surfaced in the UI. */}
      <div className="simulate-phase__topbar">
        <div className="simulate-phase__day-counter">
          {reducedMotion ? "Simulating round…" : `Round ${currentRound ?? "—"}`}
        </div>
        <div className="simulate-phase__revenue-counter">
          Profit: <strong>{targetRevenue > 0 ? `$${displayRevenue.toLocaleString()}` : "Calculating…"}</strong>
        </div>
      </div>

      <div className="simulate-phase__main">
        <div className="simulate-phase__bakery-visual">
          <SceneErrorBoundary teamName={teamName ?? ""}>
            <PixelBakeryScene
              mode="simulate"
              teamName={teamName ?? ""}
              staffCounts={{
                bakery: pendingDecision.staffCounts.bakerySousChefs,
                deli: pendingDecision.staffCounts.deliSousChefs,
                barista: pendingDecision.staffCounts.baristaSousChefs,
              }}
              customerCount={latestRound?.customerCount ?? 0}
              menu={[...PRODUCTS]}
              soldOut={soldOut as Set<string>}
              specialtyChefs={specialtyChefs}
            />
          </SceneErrorBoundary>
          <p className="simulate-phase__waiting">Results loading shortly…</p>
          <p className="simulate-phase__credits">Art: Designed by Freepik</p>
        </div>
      </div>
    </section>
  );
}
