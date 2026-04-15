import { useState } from "react";

const COST_PER_STAFF = 150;

export function StaffTab() {
  const [staffCount, setStaffCount] = useState(1);

  return (
    <div className="staff-tab">
      <h3 className="sidebar-tab__title">Staff</h3>
      <p className="sidebar-tab__hint">
        Hire staff to serve customers faster.
      </p>

      <div className="staff-tab__control">
        <label className="staff-tab__label">
          Number of Staff
        </label>
        <div className="staff-tab__stepper">
          <button
            className="staff-tab__stepper-btn"
            onClick={() => setStaffCount((c) => Math.max(1, c - 1))}
            disabled={staffCount <= 1}
          >
            −
          </button>
          <span className="staff-tab__stepper-value">{staffCount}</span>
          <button
            className="staff-tab__stepper-btn"
            onClick={() => setStaffCount((c) => Math.min(20, c + 1))}
            disabled={staffCount >= 20}
          >
            +
          </button>
        </div>
      </div>

      <div className="staff-tab__cost">
        Cost: <strong>${(staffCount * COST_PER_STAFF).toLocaleString()}</strong>
      </div>
    </div>
  );
}
