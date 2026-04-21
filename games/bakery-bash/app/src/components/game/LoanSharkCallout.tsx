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

function formatMoney(n: number | null | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "$0";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
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
          You overspent by <strong>{formatMoney(amountBorrowed)}</strong> this
          round.
          {typeof interestCharged === "number" && (
            <>
              {" "}
              Interest charged:{" "}
              <strong>{formatMoney(interestCharged)}</strong>.
            </>
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
