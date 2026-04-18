import { useGame } from "../../../contexts/GameContext";

/**
 * Map a 0–100 health/cleanliness value to a palette color.
 *
 * Break-points chosen to match the game-design-proposal spec, which mandates
 * that any bar ≤30% render in berry red. That pins the bottom tier; the
 * upper band is split into three steps so the user sees an early shift from
 * green → yellow-green → yellow as the bar drains, rather than a cliff at
 * 30%. Tune in one place; both the fill and the numeric percentage read
 * from this helper so they stay in sync.
 */
function healthColor(pct: number): string {
  if (pct >= 85) return "var(--sage)";
  if (pct >= 60) return "var(--lime)";
  if (pct > 30) return "var(--honey)";
  return "var(--berry)";
}

/**
 * Render a health tier label alongside the bar for accessibility / at-a-glance
 * scanning. Keeps the same break-points as `healthColor`.
 */
function healthTier(pct: number): string {
  if (pct >= 85) return "Pristine";
  if (pct >= 60) return "Good";
  if (pct > 30) return "Worn";
  return "Critical";
}

/**
 * Warning-icon threshold. Matches `healthColor`'s red band exactly so the
 * ⚠ icon and the berry fill always appear together (per proposal spec).
 */
const WARN_THRESHOLD = 30;

interface BarProps {
  label: string;
  value: number;
}
function HealthBar({ label, value }: BarProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const color = healthColor(clamped);
  const tier = healthTier(clamped);
  const warn = clamped <= WARN_THRESHOLD;

  return (
    <div
      className={`status-tab__bar-row ${
        warn ? "status-tab__bar-row--warn" : ""
      }`}
    >
      <div className="status-tab__bar-header">
        <span className="status-tab__bar-label">
          {warn && (
            <span className="status-tab__bar-warn" aria-hidden>
              ⚠
            </span>
          )}{" "}
          {label}
        </span>
        <span
          className="status-tab__bar-pct"
          style={{ color }}
          aria-label={`${Math.round(clamped)} percent, ${tier}`}
        >
          {Math.round(clamped)}%
        </span>
      </div>
      <div className="status-tab__bar-track" aria-hidden>
        <div
          className="status-tab__bar-fill"
          style={{ width: `${clamped}%`, background: color }}
        />
      </div>
      <span className="status-tab__bar-tier" style={{ color }}>
        {tier}
      </span>
    </div>
  );
}

export function StatusTab() {
  const { maintenanceBars } = useGame();

  return (
    <div className="status-tab">
      <h3 className="sidebar-tab__title">Kitchen Status</h3>
      <p className="sidebar-tab__hint">
        Cleanliness drops as customers visit; each machine wears with use.
        Assign Maintenance Guys on the <strong>Hire</strong> tab to keep bars
        from sliding into the red.
      </p>

      <div className="status-tab__bars" aria-label="Maintenance status">
        <HealthBar label="Cleanliness" value={maintenanceBars.cleanliness} />
        <HealthBar label="Oven Health" value={maintenanceBars.ovenHealth} />
        <HealthBar
          label="Meat Slicer Health"
          value={maintenanceBars.slicerHealth}
        />
        <HealthBar
          label="Espresso Machine"
          value={maintenanceBars.espressoHealth}
        />
      </div>
    </div>
  );
}
