import { useGame, useGameDispatch } from "../../contexts/GameContext";
import {
  totalSousChefs,
  type ProductKey,
  type StaffCounts,
  type StationId,
} from "../../types/game";
import { getHireCost, resolveBaseCosts, totalRoleCost } from "../../lib/cost";

/**
 * FE-05 — Sous-chef hiring + station/product assignment.
 *
 * Three per-station sections. Each section owns a station count
 * (`staffCounts`) and splits that count across its two products via a
 * "focus" select (`sousChefAssignments`).
 *
 * Hard UI Rule #7 (FRONTEND.md) + FE-21:
 *   The numeric overcrowding threshold is NEVER shown. Copy is vague:
 *   "too many cooks in the kitchen" when over the soft limit.
 */

interface StationConfig {
  id: StationId;
  title: string;
  subtitle: string;
  products: [ProductKey, ProductKey];
  productLabels: [string, string];
}

const STATIONS: StationConfig[] = [
  {
    id: "bakery",
    title: "Bakery Station",
    subtitle: "Croissant · Cookie",
    products: ["croissant", "cookie"],
    productLabels: ["Croissant", "Cookie"],
  },
  {
    id: "deli",
    title: "Deli",
    subtitle: "Bagel · Sandwich",
    products: ["bagel", "sandwich"],
    productLabels: ["Bagel", "Sandwich"],
  },
  {
    id: "barista",
    title: "Barista Station",
    subtitle: "Coffee · Matcha",
    products: ["coffee", "matcha"],
    productLabels: ["Coffee", "Matcha"],
  },
];

const MAX_PER_ROLE = 20;

const STATION_COUNT_KEY: Record<StationId, keyof StaffCounts> = {
  bakery: "bakerySousChefs",
  deli: "deliSousChefs",
  barista: "baristaSousChefs",
};

/** Each station's two products, for splitting station counts. */
const PRODUCTS_FOR_STATION: Record<StationId, [ProductKey, ProductKey]> = {
  bakery: ["croissant", "cookie"],
  deli: ["bagel", "sandwich"],
  barista: ["coffee", "matcha"],
};

/**
 * Read the *effective* overcrowding threshold from config. We intentionally
 * do NOT render this number — only the vague warning copy.
 */
function overcrowdingLimit(config: unknown): number {
  const cfg = config as { sousChefOvercrowdingThreshold?: number } | null;
  const fromConfig = cfg?.sousChefOvercrowdingThreshold;
  return typeof fromConfig === "number" && fromConfig > 0 ? fromConfig : 4;
}

export function SousChefPanel() {
  const { config, pendingDecision } = useGame();
  const dispatch = useGameDispatch();

  const { sousBase } = resolveBaseCosts(config);
  const staffCounts = pendingDecision.staffCounts;
  const sousChefAssignments = pendingDecision.sousChefAssignments;

  const setStationCount = (station: StationId, next: number) => {
    const countKey = STATION_COUNT_KEY[station];
    const clamped = Math.max(0, Math.min(MAX_PER_ROLE, Math.floor(next) || 0));
    const prev = staffCounts[countKey];
    if (clamped === prev) return;

    // Re-split the new total across the two products, keeping the existing
    // "focus" ratio as close as we can (defaults to even split for new count).
    const [p1, p2] = PRODUCTS_FOR_STATION[station];
    const prevP1 = sousChefAssignments[p1] ?? 0;
    let nextP1 =
      prev === 0 ? Math.ceil(clamped / 2) : Math.round((prevP1 / prev) * clamped);
    if (nextP1 > clamped) nextP1 = clamped;
    if (nextP1 < 0) nextP1 = 0;
    const nextP2 = clamped - nextP1;

    dispatch({
      type: "UPDATE_PENDING_DECISION",
      payload: {
        // GameContext's reducer recomputes `sousChefCount` from staffCounts
        // automatically — don't pass it here.
        staffCounts: { [countKey]: clamped } as Partial<StaffCounts>,
        sousChefAssignments: {
          ...sousChefAssignments,
          [p1]: nextP1,
          [p2]: nextP2,
        },
      },
    });
  };

  const setFocus = (station: StationId, onP1: number) => {
    const [p1, p2] = PRODUCTS_FOR_STATION[station];
    const total = staffCounts[STATION_COUNT_KEY[station]];
    const clamped = Math.max(0, Math.min(total, Math.floor(onP1) || 0));
    dispatch({
      type: "UPDATE_PENDING_DECISION",
      payload: {
        sousChefAssignments: {
          ...sousChefAssignments,
          [p1]: clamped,
          [p2]: total - clamped,
        },
      },
    });
  };

  const sousChefTotal = totalSousChefs(staffCounts);
  const overcrowded = sousChefTotal > overcrowdingLimit(config);

  return (
    <section className="sous-chef-panel" aria-labelledby="sous-chef-title">
      <header className="sous-chef-panel__header">
        <h3 id="sous-chef-title" className="sous-chef-panel__title">
          Sous Chefs
        </h3>
        <p className="sous-chef-panel__hint">
          Hire sous chefs per station and assign each one to a product.
        </p>
      </header>

      <div className="sous-chef-panel__stations">
        {STATIONS.map((s) => {
          const count = staffCounts[STATION_COUNT_KEY[s.id]];
          const onP1 = sousChefAssignments[s.products[0]] ?? 0;
          const nextCost = getHireCost(sousBase, count);
          const totalCost = totalRoleCost(sousBase, count);

          return (
            <div key={s.id} className="sous-chef-panel__station">
              <div className="sous-chef-panel__station-head">
                <div>
                  <div className="sous-chef-panel__station-title">{s.title}</div>
                  <div className="sous-chef-panel__station-sub">{s.subtitle}</div>
                </div>
                <div className="sous-chef-panel__stepper">
                  <button
                    type="button"
                    className="sous-chef-panel__step-btn"
                    onClick={() => setStationCount(s.id, count - 1)}
                    disabled={count <= 0}
                    aria-label={`Remove one from ${s.title}`}
                  >
                    −
                  </button>
                  <span className="sous-chef-panel__count">{count}</span>
                  <button
                    type="button"
                    className="sous-chef-panel__step-btn"
                    onClick={() => setStationCount(s.id, count + 1)}
                    aria-label={`Add one to ${s.title}`}
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="sous-chef-panel__cost">
                Next hire: <strong>${nextCost.toFixed(0)}</strong>
                <span> · </span>
                Station total: <strong>${totalCost.toFixed(0)}</strong>
              </div>

              {count > 0 && (
                <label className="sous-chef-panel__assign">
                  <span className="sous-chef-panel__assign-label">
                    Assignment
                  </span>
                  <select
                    className="sous-chef-panel__assign-select"
                    value={onP1}
                    onChange={(e) => setFocus(s.id, Number(e.target.value))}
                  >
                    {Array.from({ length: count + 1 }, (_, i) => (
                      <option key={i} value={i}>
                        {i} on {s.productLabels[0]} · {count - i} on{" "}
                        {s.productLabels[1]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          );
        })}
      </div>

      {overcrowded && (
        <p className="sous-chef-panel__warning" role="alert">
          ⚠ Looks like too many cooks in the kitchen — your head chef looks
          stressed.
        </p>
      )}
    </section>
  );
}

