import { useMemo } from "react";
import { useGame, useGameDispatch } from "../../../contexts/GameContext";
import {
  MAINTENANCE_TASKS,
  totalSousChefs,
  type MaintenanceTask,
  type StaffCounts,
} from "../../../types/game";
import {
  getHireCost,
  resolveBaseCosts,
  totalRoleCost,
  totalStaffCost,
} from "../../../lib/cost";

const OVERCROWDING_THRESHOLD = 4;
const MAX_PER_ROLE = 20;

const MAINTENANCE_TASK_LABELS: Record<MaintenanceTask, string> = {
  clean: "Clean Store",
  repair_oven: "Repair Oven (Bakery)",
  repair_slicer: "Repair Meat Slicer (Deli)",
  repair_espresso: "Repair Espresso Machine (Barista)",
};

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
  const { config, pendingDecision } = useGame();
  const dispatch = useGameDispatch();

  const { sousBase, maintBase } = resolveBaseCosts(config);

  const staffCounts = pendingDecision.staffCounts;
  const maintenanceTasks = pendingDecision.maintenanceTasks;

  const setCount = (role: keyof StaffCounts, next: number) => {
    if (readOnly) return;
    const clamped = Math.max(0, Math.min(MAX_PER_ROLE, Math.floor(next) || 0));
    const prev = staffCounts[role];
    if (clamped === prev) return;

    // If maintenance guy count changed, keep `maintenanceTasks` length in sync.
    let tasks = maintenanceTasks;
    if (role === "maintenanceGuys") {
      if (clamped > prev) {
        tasks = [
          ...maintenanceTasks,
          ...Array<MaintenanceTask>(clamped - prev).fill("clean"),
        ];
      } else {
        tasks = maintenanceTasks.slice(0, clamped);
      }
    }

    dispatch({
      type: "UPDATE_PENDING_DECISION",
      payload: {
        staffCounts: { [role]: clamped } as Partial<StaffCounts>,
        maintenanceTasks: tasks,
      },
    });
  };

  const setTask = (index: number, task: MaintenanceTask) => {
    if (readOnly) return;
    const next = maintenanceTasks.slice();
    next[index] = task;
    dispatch({
      type: "UPDATE_PENDING_DECISION",
      payload: { maintenanceTasks: next },
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
      <p className="sidebar-tab__hint">
        {readOnly
          ? "Your decisions are locked in for this round. Waiting on the rest of the class…"
          : "Hire sous chefs per station and maintenance guys to keep the kitchen running. Crowded kitchens slow production — watch your head chef for signs of strain. Check the Status tab for machine health."}
      </p>

      {/* Three sous chef station steppers */}
      <div className="staff-tab__stations">
        <RoleStepper
          title="Bakery Station"
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
          title="Barista Station"
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
          ⚠ Too many cooks in the kitchen — your head chef looks stressed.
        </p>
      )}

      {/* Maintenance Guy stepper + per-guy task assignment */}
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

        {staffCounts.maintenanceGuys > 0 && (
          <ul className="staff-tab__tasks">
            {maintenanceTasks.map((task, i) => (
              <li key={i} className="staff-tab__task-row">
                {readOnly ? (
                  <span className="staff-tab__task-label staff-tab__task-label--readonly">
                    Guy #{i + 1}
                    <strong className="staff-tab__task-static">
                      {MAINTENANCE_TASK_LABELS[task]}
                    </strong>
                  </span>
                ) : (
                  <label className="staff-tab__task-label">
                    Guy #{i + 1}
                    <select
                      className="staff-tab__task-select"
                      value={task}
                      onChange={(e) =>
                        setTask(i, e.target.value as MaintenanceTask)
                      }
                    >
                      {MAINTENANCE_TASKS.map((t) => (
                        <option key={t} value={t}>
                          {MAINTENANCE_TASK_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Grand total */}
      <div className="staff-tab__grand-total">
        Total staffing cost this round:{" "}
        <strong>${grandTotal.toLocaleString()}</strong>
      </div>
    </div>
  );
}
