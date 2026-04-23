import { useEffect, useRef, useState } from "react";
import { useGame } from "../../contexts/GameContext";

const TOTAL_DAYS = 30;
const DAY_DURATION_MS = 4000; // 4 seconds per day
const PRODUCTS = ["croissant", "cookie", "bagel", "sandwich", "coffee", "matcha"] as const;
type Product = typeof PRODUCTS[number];

const PRODUCT_LABELS: Record<Product, string> = {
  croissant: "Croissant",
  cookie:    "Cookie",
  bagel:     "Bagel",
  sandwich:  "Sandwich",
  coffee:    "Coffee",
  matcha:    "Matcha",
};

const AD_ICONS: Record<string, string> = {
  TV:        "/assets/ads/tv.svg",
  Radio:     "/assets/ads/radio.svg",
  Newspaper: "/assets/ads/newspaper.svg",
  Billboard: "/assets/ads/billboard.svg",
};

// Simulate which day each product sells out (days 20–28)
function getSelloutDays(): Record<Product, number> {
  const days = {} as Record<Product, number>;
  for (const p of PRODUCTS) {
    days[p] = 20 + Math.floor(Math.random() * 9);
  }
  return days;
}

export function SimulatePhase() {
  const { roundResults, maintenanceBars } = useGame();
  const latest = roundResults[roundResults.length - 1];
  const targetRevenue = typeof latest?.revenue === "number" ? latest.revenue : 0;
  const adWon = latest?.auctionResults?.adWon as string | null | undefined;

  const [day, setDay] = useState(1);
  const [isNight, setIsNight] = useState(false);
  const [displayRevenue, setDisplayRevenue] = useState(0);
  const [soldOut, setSoldOut] = useState<Set<Product>>(new Set());
  const [cleanlinessDisplay, setCleanlinessDisplay] = useState(maintenanceBars?.cleanliness ?? 100);
  const [ovenDisplay, setOvenDisplay] = useState(maintenanceBars?.ovenHealth ?? 100);

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
        setCleanlinessDisplay(prev => Math.max(0, prev - (maintenanceBars?.cleanliness ?? 100) / (TOTAL_DAYS * 3)));
        setOvenDisplay(prev => Math.max(0, prev - (maintenanceBars?.ovenHealth ?? 100) / (TOTAL_DAYS * 4)));

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

  const burglary = Boolean(latest?.burglary);
  const burglaryAmount = Number(latest?.burglaryAmount ?? 0);

  return (
    <section className={`simulate-phase ${isNight ? "simulate-phase--night" : "simulate-phase--day"}`}>
      {/* Top bar */}
      <div className="simulate-phase__topbar">
        <div className="simulate-phase__day-counter">
          {reducedMotion ? "Simulating round…" : `Day ${day} / ${TOTAL_DAYS}`}
        </div>
        <div className="simulate-phase__revenue-counter">
          Revenue: <strong>${displayRevenue.toLocaleString()}</strong>
        </div>
      </div>

      {burglary && (
        <div className="simulate-phase__burglar-banner" role="alert">
          🔓 Your bakery was broken into! A maintenance deficit left you vulnerable.
          {burglaryAmount > 0 ? ` –$${burglaryAmount.toLocaleString()}` : ""}
        </div>
      )}

      <div className="simulate-phase__main">
        {/* Left: Menu */}
        <aside className="simulate-phase__menu-panel">
          <h3 className="simulate-phase__panel-title">Menu</h3>
          <ul className="simulate-phase__menu-list">
            {PRODUCTS.map(p => (
              <li key={p} className={`simulate-phase__menu-item ${soldOut.has(p) ? "simulate-phase__menu-item--soldout" : ""}`}>
                <img src={`/assets/products/${p}.svg`} alt={PRODUCT_LABELS[p]} className="simulate-phase__menu-icon" />
                <span>{PRODUCT_LABELS[p]}</span>
                {soldOut.has(p) && <span className="simulate-phase__sold-out-badge">SOLD OUT</span>}
              </li>
            ))}
          </ul>
        </aside>

        {/* Centre: Bakery visual */}
        <div className="simulate-phase__bakery-visual">
          {adWon && AD_ICONS[adWon] && (
            <div className="simulate-phase__ad-display">
              <img src={AD_ICONS[adWon]} alt={`${adWon} ad`} className="simulate-phase__ad-icon" />
            </div>
          )}
          <div className="simulate-phase__storefront">
            <div className="simulate-phase__store-label">🥐 Your Bakery</div>
            {!isNight && !reducedMotion && (
              <div className="simulate-phase__customers">
                <span className="simulate-phase__customer">🚶</span>
                <span className="simulate-phase__customer simulate-phase__customer--2">🚶‍♀️</span>
              </div>
            )}
            {isNight && <div className="simulate-phase__night-label">🌙 Closed</div>}
          </div>
        </div>

        {/* Right: Maintenance bars */}
        <aside className="simulate-phase__status-panel">
          <h3 className="simulate-phase__panel-title">Status</h3>
          {[
            { label: "Cleanliness", value: cleanlinessDisplay },
            { label: "Oven", value: ovenDisplay },
          ].map(({ label, value }) => (
            <div key={label} className="simulate-phase__bar-row">
              <span className="simulate-phase__bar-label">{label}</span>
              <div className="simulate-phase__bar-track">
                <div
                  className="simulate-phase__bar-fill"
                  style={{ width: `${Math.round(value)}%`, background: value > 50 ? "var(--sage, #84cc16)" : "var(--berry, #ef4444)" }}
                />
              </div>
              <span className="simulate-phase__bar-pct">{Math.round(value)}%</span>
            </div>
          ))}
          <p className="simulate-phase__waiting">
            Results loading shortly…
          </p>
        </aside>
      </div>
    </section>
  );
}
