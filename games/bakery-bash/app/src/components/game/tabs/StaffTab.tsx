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
}: StepperProps) {
  return (
    <div className="staff-tab__station">
      <div className="staff-tab__station-header">
        <span className="staff-tab__station-label">{title}</span>
        <span className="staff-tab__station-sublabel">{subtitle}</span>
      </div>
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
      <div className="staff-tab__station-cost">
        Next hire: <strong>${nextCost.toFixed(0)}</strong>
        <span className="staff-tab__station-cost-sep"> · </span>
        Total: <strong>${roleTotal.toFixed(0)}</strong>
      </div>
    </div>
  );
}

export function StaffTab() {
  const { config, pendingDecision } = useGame();
  const dispatch = useGameDispatch();

  const { sousBase, maintBase } = resolveBaseCosts(config);

  const staffCounts = pendingDecision.staffCounts;
  const maintenanceTasks = pendingDecision.maintenanceTasks;

  const setCount = (role: keyof StaffCounts, next: number) => {
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
    <div className="staff-tab">
      <h3 className="sidebar-tab__title">Hire Staff</h3>
      <p className="sidebar-tab__hint">
        Hire sous chefs per station and maintenance guys to keep the kitchen
        running. Crowded kitchens slow production — watch your head chef for
        signs of strain. Check the <strong>Status</strong> tab for machine
        health.
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
        />
      </div>

      {overcrowded && (
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
        />

        {staffCounts.maintenanceGuys > 0 && (
          <ul className="staff-tab__tasks">
            {maintenanceTasks.map((task, i) => (
              <li key={i} className="staff-tab__task-row">
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
