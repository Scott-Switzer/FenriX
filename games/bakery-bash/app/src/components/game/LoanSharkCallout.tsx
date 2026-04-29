import { formatMoney } from "../../lib/cost";

/**
 * FE-12 — Red banner shown on the results screen when the player had to
 * borrow from the loan shark this round.
 *
 * Backend data: `players/{uid}.lastRoundResult.amountBorrowed` +
 * `interestCharged` (written by simulation). Per
 * GAME_DESIGN_PROPOSAL.md the interest rate is 10% — we display the
 * actual `interestCharged` amount rather than recomputing, so any rate
 * change on the backend flows through without an FE release.
 *
 * Empty state: component returns `null` when `amountBorrowed` is 0 or
 * missing, so results pages can safely always render it.
 */
export interface LoanSharkCalloutProps {
  amountBorrowed: number | null | undefined;
  interestCharged?: number | null;
}

export function LoanSharkCallout({
  amountBorrowed,
  interestCharged,
}: LoanSharkCalloutProps) {
  if (typeof amountBorrowed !== "number" || amountBorrowed <= 0) return null;

  const total =
    typeof interestCharged === "number"
      ? amountBorrowed + interestCharged
      : null;

  return (
    <aside className="loan-shark-callout" role="alert">
      <div className="loan-shark-callout__icon" aria-hidden="true">
        💰
      </div>
      <div className="loan-shark-callout__body">
        <div className="loan-shark-callout__title">
          The loan shark paid you a visit.
        </div>
        <div className="loan-shark-callout__detail">
          {/* B-06 (2026-04-29): name the rate explicitly so players
              understand the cost of overspending without needing the
              How-to-Play page. The rate stays in lockstep with the
              backend ledger via the `interestCharged` value, but the
              "10% interest" label gives them the rule of thumb. */}
          Borrowed <strong>{formatMoney(amountBorrowed)}</strong> at{" "}
          <strong>10% interest</strong>
          {typeof interestCharged === "number" ? (
            <>
              {" "}— paid <strong>{formatMoney(interestCharged)}</strong>{" "}
              this round.
            </>
          ) : (
            <> this round.</>
          )}
          {total !== null && (
            <>
              {" "}
              Deducted from your revenue:{" "}
              <strong>{formatMoney(total)}</strong>.
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
