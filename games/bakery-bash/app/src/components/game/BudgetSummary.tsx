import { useMemo } from "react";
import { useGame } from "../../contexts/GameContext";
import { computeRoundCost, formatMoney } from "../../lib/cost";

/**
 * Decision-phase budget panel pinned above the sidebar tabs. Surfaces:
 *   - the player's live `budgetCurrent` from Firestore
 *   - the running round cost (staff + production + ad spend) computed
 *     locally from the pending decision draft + ad bids
 *   - the projected post-submit balance, with a visual warning when
 *     the round cost exceeds the available budget
 *
 * Note: the spec calls out that submit must NOT be blocked on overspend —
 * the backend handles overdraft. This panel only flags the warning.
 *
 * Why a separate component (not folded into RoundHeader): RoundHeader is
 * shared across all phases including results, and showing a "remaining
 * budget" line during results would conflict with the post-round
 * accounting flow. The budget summary is decision-phase-specific.
 */
export function BudgetSummary() {
  const { budgetCurrent, pendingDecision, pendingAdBids, config } = useGame();

  const cost = useMemo(
    () => computeRoundCost(pendingDecision, pendingAdBids, config),
    [pendingDecision, pendingAdBids, config],
  );

  // While we're waiting for the player-doc listener to deliver the first
  // budget value, render a skeleton row rather than a misleading $0.
  const budgetReady = typeof budgetCurrent === "number";
  const projected = budgetReady ? (budgetCurrent as number) - cost.total : null;
  const overBudget = projected !== null && projected < 0;

  return (
    <section
      className={`budget-summary${overBudget ? " budget-summary--over" : ""}`}
      aria-label="Round budget summary"
    >
      <div className="budget-summary__row budget-summary__row--primary">
        <span className="budget-summary__label">Budget</span>
        <span className="budget-summary__value">
          {budgetReady ? formatMoney(budgetCurrent) : "—"}
        </span>
      </div>

      <div className="budget-summary__row">
        <span className="budget-summary__label">Round cost</span>
        <span className="budget-summary__value">{formatMoney(cost.total)}</span>
      </div>

      <ul className="budget-summary__breakdown" aria-hidden="true">
        <li>
          <span>Staff</span>
          <span>{formatMoney(cost.staff)}</span>
        </li>
        <li>
          <span>Production</span>
          <span>{formatMoney(cost.product)}</span>
        </li>
        <li>
          <span>Ad bids</span>
          <span>{formatMoney(cost.ad)}</span>
        </li>
      </ul>

      <div
        className={`budget-summary__row budget-summary__row--projected${
          overBudget ? " budget-summary__row--warn" : ""
        }`}
      >
        <span className="budget-summary__label">After submit</span>
        <span className="budget-summary__value">
          {projected !== null ? formatMoney(projected) : "—"}
        </span>
      </div>

      {overBudget && (
        <p className="budget-summary__warn-text" role="alert">
          ⚠ Over budget — submit allowed, but the backend will apply overdraft
          rules.
        </p>
      )}
    </section>
  );
}
