import { useMemo } from "react";
import { useGame, useGameDispatch } from "../../../contexts/GameContext";
import {
  totalSousChefs,
  type StaffCounts,
} from "../../../types/game";
import {
  getHireCost,
  resolveBaseCosts,
  totalRoleCost,
  totalStaffCost,
} from "../../../lib/cost";
import { nextEquipmentGrade, tierUpgradeCost } from "../../../lib/equipment";

const OVERCROWDING_THRESHOLD = 4;
const MAX_PER_ROLE = 20;

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
  const { config, pendingDecision, equipmentGrade } = useGame();
  const dispatch = useGameDispatch();

  const { sousBase, maintBase } = resolveBaseCosts(config);

  const staffCounts = pendingDecision.staffCounts;

  const setCount = (role: keyof StaffCounts, next: number) => {
    if (readOnly) return;
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

  const grandTotal = useMemo(
    () => totalStaffCost(staffCounts, config),
    [staffCounts, config],
  );

  const sousChefTotal = totalSousChefs(staffCounts);
  const overcrowded = sousChefTotal > OVERCROWDING_THRESHOLD;

  return (
    <div className={`staff-tab${readOnly ? " staff-tab--readonly" : ""}`}>
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
      {readOnly && (
        <p className="sidebar-tab__hint">
          Locked in for this round.
        </p>
      )}

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
          readOnly={readOnly}
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
          readOnly={readOnly}
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
          readOnly={readOnly}
        />
      </div>

      {overcrowded && !readOnly && (
        <p className="staff-tab__warning" role="alert">
          ⚠ Too many cooks — head chef stressed.
        </p>
      )}

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
          readOnly={readOnly}
        />
      </div>

      {/* Equipment upgrade toggle */}
      <hr className="staff-tab__maintenance-divider" />
      <h3 className="staff-tab__section-heading">Equipment</h3>
      <div className="staff-tab__equipment">
        {(() => {
          const grade = equipmentGrade ?? 'C';
          const next = nextEquipmentGrade(grade);
          const cost = tierUpgradeCost(grade);
          const purchased = !!pendingDecision.equipmentUpgradePurchased;
          if (!next || cost === null) {
            return (
              <p className="staff-tab__equipment-maxed">
                Equipment at A — max grade.
              </p>
            );
          }
          return (
            <div className="staff-tab__equipment-row">
              <div className="staff-tab__station-header">
                <span className="staff-tab__station-label">Upgrade Equipment</span>
                <span className="staff-tab__station-sublabel">
                  {grade} → {next}
                </span>
              </div>
              {readOnly ? (
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
                  className={`staff-tab__equipment-btn${purchased ? ' staff-tab__equipment-btn--active' : ''}`}
                  onClick={() =>
                    dispatch({
                      type: "UPDATE_PENDING_DECISION",
                      payload: { equipmentUpgradePurchased: !purchased },
                    })
                  }
                  aria-pressed={purchased}
                >
                  {purchased ? '✓ Upgrade booked' : `Upgrade to ${next} ($${cost})`}
                </button>
              )}
              <div className="staff-tab__station-cost">
                Cost: <strong>${cost.toLocaleString()}</strong>
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
