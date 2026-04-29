import { useMemo } from "react";
import { useGame, useGameDispatch } from "../../../contexts/GameContext";
import {
  PLAYER_ROLE_LABELS,
  roleOwnsDecide,
  type StaffCounts,
} from "../../../types/game";
import {
  getHireCost,
  resolveBaseCosts,
  totalRoleCost,
  totalStaffCost,
} from "../../../lib/cost";
import { nextEquipmentGrade, tierUpgradeCost } from "../../../lib/equipment";

// B-02 (2026-04-29): bumped from 20 → 99 per Q17. The button-disable
// gate at MAX_PER_ROLE doubles as the cap; we don't render a separate
// red error chip on the steppers because the +button just stops working.
const MAX_PER_ROLE = 99;

interface StepperProps {
  title: string;
  subtitle: string;
  count: number;
  nextCost: number;
  roleTotal: number;
  onDecrement: () => void;
  onIncrement: () => void;
  incrementDisabled?: boolean;
  /** When true, render the count as a static label instead of a stepper. */
  readOnly?: boolean;
}
function RoleStepper({
  title,
  subtitle,
  count,
  nextCost,
  roleTotal,
  onDecrement,
  onIncrement,
  incrementDisabled,
  readOnly,
}: StepperProps) {
  return (
    <div className="staff-tab__station">
      <div className="staff-tab__station-header">
        <span className="staff-tab__station-label">{title}</span>
        <span className="staff-tab__station-sublabel">{subtitle}</span>
      </div>
      {readOnly ? (
        <div className="staff-tab__stepper staff-tab__stepper--readonly">
          <span
            className="staff-tab__stepper-value staff-tab__stepper-value--static"
            aria-label={`${title} final count`}
          >
            {count}
          </span>
        </div>
      ) : (
        <div className="staff-tab__stepper">
          <button
            type="button"
            className="staff-tab__stepper-btn"
            onClick={onDecrement}
            disabled={count <= 0}
            aria-label={`Remove one from ${title}`}
          >
            −
          </button>
          <span className="staff-tab__stepper-value">{count}</span>
          <button
            type="button"
            className="staff-tab__stepper-btn"
            onClick={onIncrement}
            disabled={incrementDisabled}
            aria-label={`Add one to ${title}`}
          >
            +
          </button>
        </div>
      )}
      <div className="staff-tab__station-cost">
        {readOnly ? (
          <>
            Total: <strong>${roleTotal.toFixed(0)}</strong>
          </>
        ) : (
          <>
            Next hire: <strong>${nextCost.toFixed(0)}</strong>
            <span className="staff-tab__station-cost-sep"> · </span>
            Total: <strong>${roleTotal.toFixed(0)}</strong>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * FE-9 — once the player submits decisions (`decisionSubmitted === true`)
 * or the phase moves past `decide`, the Hire tab must stop accepting input.
 * Parents can force this via the `readOnly` prop; when omitted we default
 * to `false` (interactive) so the tab can still be mounted inside pages
 * that manage their own submission lifecycle.
 */
export interface StaffTabProps {
  readOnly?: boolean;
}

export function StaffTab({ readOnly = false }: StaffTabProps) {
  const {
    config,
    pendingDecision,
    equipmentGrade,
    budgetCurrent,
    role,
    teamRoleAssignments,
  } = useGame();
  const dispatch = useGameDispatch();
  // K-01 (2026-04-29): only Operations / Solo (or any teammate when no
  // one holds operations) can edit staff + equipment. The visual lock
  // mirrors `readOnly` — the role-owner tooltip names the gate, since
  // the existing `readOnly` lock copy ("Locked in for this round.")
  // describes a different state.
  const canEditStaff = roleOwnsDecide(role, teamRoleAssignments);
  const staffOwnerLabel = PLAYER_ROLE_LABELS.operations;
  const staffLocked = readOnly || !canEditStaff;
  const staffOwnerHint = canEditStaff
    ? undefined
    : `Your ${staffOwnerLabel} teammate submits staff.`;

  const { sousBase, maintBase } = resolveBaseCosts(config);

  const staffCounts = pendingDecision.staffCounts;

  const setCount = (role: keyof StaffCounts, next: number) => {
    if (staffLocked) return;
    const clamped = Math.max(0, Math.min(MAX_PER_ROLE, Math.floor(next) || 0));
    const prev = staffCounts[role];
    if (clamped === prev) return;

    dispatch({
      type: "UPDATE_PENDING_DECISION",
      payload: {
        staffCounts: { [role]: clamped } as Partial<StaffCounts>,
      },
    });
  };

  // Grand total = staff cost + equipment upgrade cost (if toggled).
  const grandTotal = useMemo(() => {
    const staffOnly = totalStaffCost(staffCounts, config);
    const grade = equipmentGrade ?? 'C';
    const upgradeCost = pendingDecision.equipmentUpgradePurchased
      ? (tierUpgradeCost(grade) ?? 0)
      : 0;
    return staffOnly + upgradeCost;
  }, [staffCounts, config, equipmentGrade, pendingDecision.equipmentUpgradePurchased]);

  return (
    <div className={`staff-tab${staffLocked ? " staff-tab--readonly" : ""}`}>
      <div className="staff-tab__header">
        <h3 className="sidebar-tab__title">Hire Staff</h3>
        {readOnly && (
          <span
            className="tab__badge tab__badge--submitted"
            aria-label="Decisions submitted"
          >
            Submitted
          </span>
        )}
      </div>
      {readOnly ? (
        <p className="sidebar-tab__hint">
          Locked in for this round.
        </p>
      ) : staffOwnerHint ? (
        <p className="sidebar-tab__hint">
          {staffOwnerHint}
        </p>
      ) : null}

      {/* V9 (Apr 26): trimmed the section intros and the redundant
          "Sous Chef — Bakery (Croissant · Cookie)" / "Croissant · Cookie"
          subtitle pair. Each row now reads as just "Bakery / Croissant ·
          Cookie" so the panel breathes on a desktop sidebar. */}
      <h3 className="staff-tab__section-heading">Sous Chefs</h3>
      <div className="staff-tab__stations">
        <RoleStepper
          title="Bakery"
          subtitle="Croissant · Cookie"
          count={staffCounts.bakerySousChefs}
          nextCost={getHireCost(sousBase, staffCounts.bakerySousChefs)}
          roleTotal={totalRoleCost(sousBase, staffCounts.bakerySousChefs)}
          onDecrement={() =>
            setCount("bakerySousChefs", staffCounts.bakerySousChefs - 1)
          }
          onIncrement={() =>
            setCount("bakerySousChefs", staffCounts.bakerySousChefs + 1)
          }
          readOnly={staffLocked}
        />
        <RoleStepper
          title="Deli"
          subtitle="Bagel · Sandwich"
          count={staffCounts.deliSousChefs}
          nextCost={getHireCost(sousBase, staffCounts.deliSousChefs)}
          roleTotal={totalRoleCost(sousBase, staffCounts.deliSousChefs)}
          onDecrement={() =>
            setCount("deliSousChefs", staffCounts.deliSousChefs - 1)
          }
          onIncrement={() =>
            setCount("deliSousChefs", staffCounts.deliSousChefs + 1)
          }
          readOnly={staffLocked}
        />
        <RoleStepper
          title="Barista"
          subtitle="Coffee · Matcha"
          count={staffCounts.baristaSousChefs}
          nextCost={getHireCost(sousBase, staffCounts.baristaSousChefs)}
          roleTotal={totalRoleCost(sousBase, staffCounts.baristaSousChefs)}
          onDecrement={() =>
            setCount("baristaSousChefs", staffCounts.baristaSousChefs - 1)
          }
          onIncrement={() =>
            setCount("baristaSousChefs", staffCounts.baristaSousChefs + 1)
          }
          readOnly={staffLocked}
        />
      </div>

      <hr className="staff-tab__maintenance-divider" />
      <h3 className="staff-tab__section-heading">Maintenance</h3>
      <div className="staff-tab__maintenance">
        <RoleStepper
          title="Maintenance Guy"
          subtitle="Cleans & repairs"
          count={staffCounts.maintenanceGuys}
          nextCost={getHireCost(maintBase, staffCounts.maintenanceGuys)}
          roleTotal={totalRoleCost(maintBase, staffCounts.maintenanceGuys)}
          onDecrement={() =>
            setCount("maintenanceGuys", staffCounts.maintenanceGuys - 1)
          }
          onIncrement={() =>
            setCount("maintenanceGuys", staffCounts.maintenanceGuys + 1)
          }
          readOnly={staffLocked}
        />
      </div>

      {/* Equipment upgrade toggle */}
      <hr className="staff-tab__maintenance-divider" />
      <h3 className="staff-tab__section-heading">Equipment</h3>
      <div className="staff-tab__equipment">
        {(() => {
          const grade = equipmentGrade ?? 'C';
          const next = nextEquipmentGrade(grade);
          const upgradeCost = tierUpgradeCost(grade);
          const purchased = !!pendingDecision.equipmentUpgradePurchased;
          if (!next || upgradeCost === null) {
            return (
              <p className="staff-tab__equipment-maxed">
                Equipment at A — max grade.
              </p>
            );
          }

          // Affordability check: use grandTotal (which includes upgrade cost when
          // toggled) to determine how much budget remains for the upgrade.
          // If the upgrade is already toggled, grandTotal already includes its cost.
          // Back it out to get the base cost without the upgrade for the check.
          const baseCostWithoutUpgrade = purchased
            ? grandTotal - upgradeCost
            : grandTotal;
          const available = budgetCurrent !== null
            ? budgetCurrent - baseCostWithoutUpgrade
            : null;
          const canAffordUpgrade = available !== null && available >= upgradeCost;

          // Button is disabled when: player can't afford it (and it's not already toggled on)
          const upgradeButtonDisabled = !canAffordUpgrade && !purchased;

          return (
            <div className="staff-tab__equipment-row">
              <div className="staff-tab__station-header">
                <span className="staff-tab__station-label">Upgrade Equipment</span>
                <span className="staff-tab__station-sublabel">
                  {grade} → {next}
                </span>
              </div>
              {staffLocked ? (
                <div className="staff-tab__stepper staff-tab__stepper--readonly">
                  <span
                    className="staff-tab__stepper-value staff-tab__stepper-value--static"
                    aria-label="Equipment upgrade"
                  >
                    {purchased ? 'Purchased' : 'Not purchased'}
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  className={`staff-tab__equipment-btn${purchased ? ' staff-tab__equipment-btn--active' : ''}${upgradeButtonDisabled ? ' staff-tab__equipment-btn--disabled' : ''}`}
                  onClick={() => {
                    if (upgradeButtonDisabled) return;
                    dispatch({
                      type: "UPDATE_PENDING_DECISION",
                      payload: { equipmentUpgradePurchased: !purchased },
                    });
                  }}
                  disabled={upgradeButtonDisabled}
                  aria-pressed={purchased}
                  title={
                    upgradeButtonDisabled && available !== null
                      ? "Not enough budget for this upgrade after your other costs."
                      : undefined
                  }
                >
                  {purchased ? '✓ Upgrade booked' : `Upgrade to ${next} ($${upgradeCost.toLocaleString()})`}
                </button>
              )}
              <div className="staff-tab__station-cost">
                Cost: <strong>${upgradeCost.toLocaleString()}</strong>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Grand total */}
      <div className="staff-tab__grand-total">
        Total staffing cost this round:{" "}
        <strong>${grandTotal.toLocaleString()}</strong>
      </div>
    </div>
  );
}
