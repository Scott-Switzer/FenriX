import { useGame, useGameDispatch } from "../../../contexts/GameContext";

/**
 * Default cost per sous chef per round when the backend config has not yet
 * been resolved. Mirrors `DEFAULT_GAME_CONFIG.sousChefBaseCost` in
 * `backend/functions/modules/config.js`.
 */
const DEFAULT_SOUS_CHEF_BASE_COST = 50;
const MAX_SOUS_CHEF_COUNT = 20;

export function StaffTab() {
  const { config, pendingDecision } = useGame();
  const dispatch = useGameDispatch();

  // Canonical backend field is `sousChefBaseCost`. Fall back to the legacy
  // `costPerStaffPerRound` (present in the old seed doc) before defaulting to
  // 50 so we stay correct through the seed/config rename.
  const costPerStaff =
    config?.sousChefBaseCost ??
    config?.costPerStaffPerRound ??
    DEFAULT_SOUS_CHEF_BASE_COST;

  const staffCount = pendingDecision.sousChefCount;

  const setStaffCount = (next: number) => {
    const clamped = Math.max(0, Math.min(MAX_SOUS_CHEF_COUNT, next));
    dispatch({
      type: "UPDATE_PENDING_DECISION",
      payload: { sousChefCount: clamped },
    });
  };

  return (
    <div className="staff-tab">
      <h3 className="sidebar-tab__title">Sous Chefs</h3>
      <p className="sidebar-tab__hint">
        Hire sous chefs to boost output. More than 4 starts to hurt kitchen
        coordination.
      </p>

      <div className="staff-tab__control">
        <label className="staff-tab__label">Number of Sous Chefs</label>
        <div className="staff-tab__stepper">
          <button
            className="staff-tab__stepper-btn"
            onClick={() => setStaffCount(staffCount - 1)}
            disabled={staffCount <= 0}
          >
            −
          </button>
          <span className="staff-tab__stepper-value">{staffCount}</span>
          <button
            className="staff-tab__stepper-btn"
            onClick={() => setStaffCount(staffCount + 1)}
            disabled={staffCount >= MAX_SOUS_CHEF_COUNT}
          >
            +
          </button>
        </div>
      </div>

      <div className="staff-tab__cost">
        Cost: <strong>${(staffCount * costPerStaff).toLocaleString()}</strong>
        <span className="staff-tab__cost-rate">
          {" "}(${costPerStaff.toLocaleString()} each)
        </span>
      </div>
    </div>
  );
}
