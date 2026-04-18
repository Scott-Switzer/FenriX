/**
 * loan-shark.js
 *
 * Loan-shark mechanic. If a player's spending exceeds their current budget,
 * the difference is "borrowed" from the loan shark and accrues interest at a
 * flat rate (default 10% per spec). Both principal and interest are deducted
 * from gross revenue at the end of the round.
 *
 * All functions are pure.
 */

const config = require('./config');

/**
 * Calculate how much a player had to borrow this round and the resulting
 * interest charge.
 *
 * Non-finite values for totalSpent or currentBudget are treated as 0 to
 * prevent Infinity from propagating into the borrowed/interest totals.
 *
 * @param {number} totalSpent - total round expenditure (stock + hires + bids).
 * @param {number} budgetCurrent - player's budget at the START of the round.
 * @param {Object} cfg - expects cfg.loanSharkInterestRate (default 0.10).
 * @returns {{
 *   borrowed: number,
 *   interest: number,
 *   loanSharkDeduction: number,
 *   didBorrow: boolean
 * }}
 */
function calculateLoanShark(totalSpent, budgetCurrent, cfg = config) {
  const spent = Number.isFinite(totalSpent) ? totalSpent : 0;
  const budget = Number.isFinite(budgetCurrent) ? budgetCurrent : 0;
  const rate = (cfg && cfg.loanSharkInterestRate != null)
    ? cfg.loanSharkInterestRate
    : 0.10;
  const borrowed = Math.max(0, spent - budget);
  const interest = borrowed * rate;
  const loanSharkDeduction = borrowed + interest;
  return {
    borrowed,
    interest,
    loanSharkDeduction,
    didBorrow: borrowed > 0,
  };
}

/**
 * Subtract the loan-shark deduction (principal + interest) from gross revenue.
 *
 * @param {number} grossRevenue - gross revenue before loan deductions.
 * @param {number} loanSharkDeduction - borrowed principal + interest.
 * @returns {number} net revenue (can be negative in pathological cases).
 */
function calculateNetRevenue(grossRevenue, loanSharkDeduction) {
  return (grossRevenue || 0) - (loanSharkDeduction || 0);
}

/**
 * Update a player's budget after a round resolves.
 *
 * budgetNext = budgetCurrent + revenueNet - totalSpent
 *
 * NOTE: totalSpent is intentionally subtracted here (even though borrowing
 * may have covered a portion of it) because revenueNet already accounts for
 * the borrow repayment. This keeps bookkeeping consistent whether or not the
 * player borrowed: every dollar spent leaves the wallet exactly once.
 *
 * The result may be negative — callers decide how to present that (e.g.
 * "in the red") but no clamping is applied here.
 *
 * @param {number} budgetCurrent - player's budget before this round.
 * @param {number} revenueNet - net revenue after loan-shark deductions.
 * @param {number} totalSpent - total round expenditure.
 * @returns {number} updated budget.
 */
function updateBudget(budgetCurrent, revenueNet, totalSpent) {
  return (budgetCurrent || 0) + (revenueNet || 0) - (totalSpent || 0);
}

module.exports = {
  calculateLoanShark,
  calculateNetRevenue,
  updateBudget,
};
